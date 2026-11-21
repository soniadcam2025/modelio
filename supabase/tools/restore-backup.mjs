// Restore the dashboard database (Supabase) from a backup, in ONE transaction: either everything is restored or
// nothing changes. Sources:
//   --file backup.json                 a download from Features & settings → Download backup (or GET /api/backup)
//   --d1 <database> [--id <backup_id>] a daily backup stored by the Worker in D1 (latest when --id is omitted)
// Target: --project <supabase project ref>. Without --confirm it only prints what it would do.
//
//   node supabase/tools/restore-backup.mjs --project ttdvmdunxhftcbrpmxqu --d1 shakhira-backups            # dry run
//   node supabase/tools/restore-backup.mjs --project ttdvmdunxhftcbrpmxqu --d1 shakhira-backups --confirm
//
// Needs a Supabase access token for the Management API (SUPABASE_ACCESS_TOKEN) and, for --d1, wrangler access.
// The live bot's database (shakhira-vip) is refused as a source and is never written by this tool.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const REF = arg("--project"), FILE = arg("--file"), D1 = arg("--d1"), ID = arg("--id"), CONFIRM = process.argv.includes("--confirm");
if (!REF || (!FILE && !D1)) { console.error("Usage: --project <ref> (--file backup.json | --d1 <database> [--id <backup_id>]) [--confirm]"); process.exit(2); }
if (D1 === "shakhira-vip") { console.error("Refusing: shakhira-vip is the live bot's database, not a backup."); process.exit(2); }

// Columns with identity ids, whose sequences must move past the restored rows.
const ID_TABLES = ["content_items", "captions", "join_requests", "admin_actions", "moderation_rules", "moderation_log", "audit_log",
  "payments", "trials", "member_events"];

function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", D1, "--remote", "--json", "--command", sql],
    { cwd: new URL("../../cloudflare/", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}
async function pg(query) {
  const headers = { "content-type": "application/json" };
  if (process.env.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: "POST", headers, body: JSON.stringify({ query }) });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body).slice(0, 400));
  return body;
}
const lit = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);

let backup;
if (FILE) backup = JSON.parse(readFileSync(FILE, "utf8"));
else {
  const id = ID || d1("SELECT MAX(backup_id) AS id FROM backup_parts")[0].id;
  if (!id) throw new Error("No backups stored in " + D1);
  const tables = {};
  for (const r of d1(`SELECT table_name, part, json FROM backup_parts WHERE backup_id = ${Number(id)} ORDER BY table_name, part`))
    (tables[r.table_name] ||= []).push(...JSON.parse(r.json));
  backup = { format: "shakhira-backup-v1", exported_at: Number(id), tables };
}
if (backup.format !== "shakhira-backup-v1") throw new Error("Not a Shakhira backup");

const tables = Object.keys(backup.tables);
const summary = Object.fromEntries(tables.map((t) => [t, backup.tables[t].length]));
console.log(`backup from ${new Date(backup.exported_at * 1000).toISOString()}:`, summary);
if (!CONFIRM) { console.log("Dry run. Add --confirm to replace these tables in project", REF); process.exit(0); }

const sql = ["begin", `truncate ${tables.map((t) => `shakhira.${t}`).join(", ")}`];
for (const t of tables) for (const row of backup.tables[t]) {
  const cols = Object.keys(row);
  sql.push(`insert into shakhira.${t} (${cols.join(", ")}) values (${cols.map((c) => lit(row[c])).join(", ")})`);
}
for (const t of ID_TABLES.filter((x) => tables.includes(x)))
  sql.push(`select setval(pg_get_serial_sequence('shakhira.${t}', 'id'), greatest(coalesce((select max(id) from shakhira.${t}), 0), 1))`);
sql.push("commit");
await pg(sql.join(";\n"));
const after = await pg(tables.map((t) => `select '${t}' as t, count(*)::int as n from shakhira.${t}`).join(" union all "));
const got = Object.fromEntries(after.map((r) => [r.t, r.n]));
const ok = tables.every((t) => got[t] === summary[t]);
console.log(ok ? "restored and verified:" : "MISMATCH after restore:", got);
process.exit(ok ? 0 : 1);
