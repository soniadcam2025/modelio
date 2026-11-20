// A small Cloudflare D1 stand-in on Node's built-in SQLite, for tests. Same call shapes:
// db.prepare(sql).bind(...).first() / .all() -> {results} / .run() -> {meta:{changes,last_row_id}}
import { readFileSync } from "node:fs";
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
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  return { prepare: (sql) => new Stmt(db, sql), exec: (sql) => db.exec(sql), close: () => db.close(), raw: db };
}
