// Copies the STAGING dashboard's D1 data (shakhira-staging) into the staging Supabase project.
// Refuses any other D1 database: the live bot's `shakhira-vip` is never read or written here.
// Idempotent: rows that already exist (same primary key) are skipped. Short-lived security tables are not copied.
//
//   CLOUDFLARE_API_TOKEN=… SUPABASE_PROJECT_REF=… node supabase/tools/migrate-d1-staging.mjs [--dry-run]
// Needs a Supabase personal access token for the Management API (SUPABASE_ACCESS_TOKEN, or injected by a proxy).
import { execFileSync } from "node:child_process";

const D1 = "shakhira-staging";
const REF = process.env.SUPABASE_PROJECT_REF;
const DRY = process.argv.includes("--dry-run");
if (!REF) throw new Error("Set SUPABASE_PROJECT_REF");
const TABLES = {
  settings: "key", content_items: "id", captions: "id", profiles: "user_id", join_requests: "id", admin_actions: "id",
  moderation_rules: "id", moderation_log: "id", reaction_counts: null, reminders_sent: "key", audit_log: "id", payments: "id",
  trials: "id", member_events: "id", pending_unbans: "user_id", auto_paid_runs: "slot", auto_paid_posted: "public_id",
};

const q = (v) => (v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replaceAll("'", "''")}'`);
function d1(sql) {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", D1, "--remote", "--json", "--command", sql],
    { cwd: new URL("../../cloudflare/", import.meta.url).pathname, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  return JSON.parse(out)[0].results;
}
async function pg(sql) {
  const headers = { "content-type": "application/json" };
  if (process.env.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`;
  const r = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, { method: "POST", headers, body: JSON.stringify({ query: sql }) });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body).slice(0, 300));
  return body;
}

const statements = [];
const report = {};
for (const [table, pk] of Object.entries(TABLES)) {
  const rows = d1(`SELECT * FROM ${table}`);
  report[table] = rows.length;
  for (const row of rows) {
    const cols = Object.keys(row);
    statements.push(`insert into shakhira.${table} (${cols.join(", ")}) values (${cols.map((c) => q(row[c])).join(", ")}) on conflict do nothing`);
  }
  if (pk === "id") statements.push(`select setval(pg_get_serial_sequence('shakhira.${table}', 'id'), greatest(coalesce((select max(id) from shakhira.${table}), 0), 1))`);
}
console.log("rows in D1", D1, report);
if (DRY) { console.log(`dry run: ${statements.length} statements not sent`); process.exit(0); }
// One transaction, so a failure leaves Supabase unchanged.
await pg(`begin; ${statements.join(";\n")}; commit;`);
const after = await pg(Object.keys(TABLES).map((t) => `select '${t}' as t, count(*)::int as n from shakhira.${t}`).join(" union all "));
console.log("rows in Supabase", Object.fromEntries(after.map((r) => [r.t, r.n])));
