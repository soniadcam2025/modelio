// Supabase (Postgres) adapter with the same interface the code uses from Cloudflare D1:
//   db.prepare(sql).bind(...args).first() / .all() / .run()
// Every statement goes to one RPC, public.shakhira_exec, which only the secret (service-role) key can call
// and which runs as a role limited to the private `shakhira` schema (supabase/migrations/0002).
// Values are inlined as standard SQL string literals (quotes doubled, NUL refused); Postgres converts an
// untyped literal to the column's type, so '42' works for bigint columns as it does for text.

export function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "'1'" : "'0'";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("Refusing a non-finite number");
    return `'${String(v)}'`;
  }
  const s = String(v);
  if (s.includes("\u0000")) throw new Error("Refusing text containing a NUL byte");
  return `'${s.replaceAll("'", "''")}'`;
}

// Replace each ? placeholder that is outside a quoted literal.
export function inline(sql, args) {
  let out = "", i = 0, quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    if (ch === "?" && !quoted) {
      if (i >= args.length) throw new Error("Too few values for the statement");
      out += literal(args[i++]);
    } else out += ch;
  }
  if (i !== args.length) throw new Error("Too many values for the statement");
  return out;
}

// Captured once, so a test that stubs global fetch (Telegram, Cloudinary) never intercepts database calls.
const platformFetch = globalThis.fetch.bind(globalThis);
const DML = /^\s*(insert|update|delete)\s/i;

export class SupabaseDB {
  constructor({ url, key, fetchImpl = platformFetch }) {
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
    this.endpoint = url.replace(/\/+$/, "") + "/rest/v1/rpc/shakhira_exec";
    this.key = key;
    this.fetch = (...args) => fetchImpl(...args); // never call fetch as a method: Workers throws "Illegal invocation"
  }

  async exec(q, mode) {
    const headers = { "content-type": "application/json", apikey: this.key };
    // Legacy JWT service-role keys also need the Authorization header; new sb_secret_ keys must not send it.
    if (!this.key.startsWith("sb_")) headers.authorization = `Bearer ${this.key}`;
    const res = await this.fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify({ q, mode }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`Database error: ${(body && (body.message || body.hint)) || res.status}`);
    return body;
  }

  prepare(sql) {
    const db = this;
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async all() {
        const q = inline(sql, args);
        if (DML.test(q)) {
          const r = await db.exec(/\breturning\b/i.test(q) ? q : `${q} RETURNING *`, "run");
          return { results: r.rows, meta: { changes: r.changes } };
        }
        return { results: await db.exec(q, "all"), meta: {} };
      },
      async first(column) {
        const row = (await stmt.all()).results[0] ?? null;
        return column && row ? row[column] : row;
      },
      async run() {
        const q = inline(sql, args);
        if (!DML.test(q)) { const results = await db.exec(q, "all"); return { results, meta: { changes: 0 } }; }
        const r = await db.exec(/\breturning\b/i.test(q) ? q : `${q} RETURNING *`, "run");
        const last = r.rows.length ? r.rows[r.rows.length - 1] : null;
        return { success: true, results: r.rows, meta: { changes: r.changes, last_row_id: last && last.id !== undefined ? last.id : null } };
      },
    };
    return stmt;
  }

  async health() {
    const t0 = Date.now();
    await this.exec("SELECT 1 AS ok", "all");
    return { ok: true, ms: Date.now() - t0 };
  }
}
