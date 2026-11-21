// A small Cloudflare D1 stand-in on Node's built-in SQLite, for tests. Same call shapes:
// db.prepare(sql).bind(...).first() / .all() -> {results} / .run() -> {meta:{changes,last_row_id}}
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SupabaseDB } from "../src/pg.js";

// TEST_DB=supabase runs the same tests against a real (staging) Supabase project through src/pg.js.
// Each new database clears every shakhira table first, so never point this at production.
const TABLES = ["settings", "content_items", "captions", "profiles", "join_requests", "admin_actions", "moderation_rules",
  "moderation_log", "reaction_counts", "reminders_sent", "audit_log", "payments", "trials", "member_events", "pending_unbans",
  "revoked_sessions", "login_failures", "auto_paid_runs", "auto_paid_posted"];
const seen = new Set();
function makeSupabase(path) {
  if (!/staging/.test(process.env.SUPABASE_ENVIRONMENT || "")) throw new Error("Set SUPABASE_ENVIRONMENT=staging to confirm the target");
  const db = new SupabaseDB({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SECRET_KEY });
  const fresh = path === ":memory:" || !seen.has(path);
  seen.add(path);
  // Cleared on first use (not at creation), so a database object that is never used clears nothing.
  let cleared = null;
  const ready = () => (cleared ||= fresh ? Promise.all(TABLES.map((t) => db.exec(`DELETE FROM ${t} WHERE true RETURNING 1`, "run"))) : Promise.resolve());
  const wrap = (stmt) => {
    const w = {
      bind: (...a) => { stmt.bind(...a); return w; },
      first: async (c) => { await ready(); return stmt.first(c); },
      all: async () => { await ready(); return stmt.all(); },
      run: async () => { await ready(); return stmt.run(); },
    };
    return w;
  };
  return { prepare: (sql) => wrap(db.prepare(sql)), close: () => {} };
}

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === "boolean" ? Number(a) : a))); }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}

export function makeD1(path = ":memory:") {
  if (process.env.TEST_DB === "supabase") return makeSupabase(path);
  const db = new DatabaseSync(path);
  // Like `wrangler d1 migrations apply`: each migration runs once per database.
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY)");
  for (const m of readdirSync(new URL("../migrations/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    if (db.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(m)) continue;
    db.exec(readFileSync(new URL(`../migrations/${m}`, import.meta.url), "utf8"));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(m);
  }
  return { prepare: (sql) => new Stmt(db, sql), exec: (sql) => db.exec(sql), close: () => db.close(), raw: db };
}
