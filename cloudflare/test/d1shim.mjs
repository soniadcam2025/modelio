// A small Cloudflare D1 stand-in on Node's built-in SQLite, for tests. Same call shapes:
// db.prepare(sql).bind(...).first() / .all() -> {results} / .run() -> {meta:{changes,last_row_id}}
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === "boolean" ? Number(a) : a))); }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r ? { ...r } : null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
}

export function makeD1(path = ":memory:") {
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
