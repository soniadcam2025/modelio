// Hashtags, backups, the Supabase adapter's quoting, Supabase Auth login and the signed cron hand-off.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import worker, { signCycle } from "../src/index.js";
import { OpsError, validateContent } from "../src/ops.js";
import { inline, literal, SupabaseDB } from "../src/pg.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin-staging.vercel.app";
const env = (o = {}) => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "staging",
  REQUIRE_PREVIEW: "true", PREVIEW_CHAT_ID: "", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-1001234567890", POST_SLOTS_UTC: "16:30,23:30", ...o });
const req = (path, { method = "GET", body, cookie, csrf, headers = {} } = {}) => new Request(ORIGIN + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { "content-type": "application/json", "x-real-ip": "198.51.100.7", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}), ...headers },
});
async function login(e, body = { password: PASSWORD }) {
  const r = await worker.fetch(req("/api/login", { method: "POST", body }), e);
  assert.equal(r.status, 200, await r.clone().text());
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}

test("hashtags are cleaned, de-duplicated and appended when the post is published", async () => {
  const v = validateContent({ kind: "text", target: "public", text: "Hello", hashtags: "#vip, vip #new_drop" });
  assert.equal(v.hashtags, "#vip #new_drop");
  assert.throws(() => validateContent({ kind: "text", target: "public", text: "x", hashtags: "bad-tag" }), OpsError);
  assert.throws(() => validateContent({ kind: "photo", target: "public", media_url: "https://res.cloudinary.com/x.jpg", text: "a".repeat(1020), hashtags: "#long" }), OpsError);
  const e = env(); const s = await login(e);
  const now = Math.floor(Date.now() / 1000);
  await worker.fetch(req("/api/settings/features/scheduled_posts", { method: "PUT", ...s, body: { enabled: true } }), e);
  const r = await worker.fetch(req("/api/content", { method: "POST", ...s, body: { kind: "text", target: "public", text: "Tonight", hashtags: "#vip", schedule: true, scheduled_at: now - 5 } }), e);
  assert.equal(r.status, 200);
  const { runScheduled } = await import("../src/index.js");
  const out = await runScheduled(e, now);
  assert.equal(out.mode, "simulated");
  const item = await (await worker.fetch(req("/api/content", s), e)).json();
  assert.equal(item[0].status, "simulated");
  assert.equal(item[0].text, "Tonight\n\n#vip");
});

test("backup export needs sign-in, includes the data and is audited", async () => {
  const e = env();
  assert.equal((await worker.fetch(req("/api/backup"), e)).status, 401);
  const s = await login(e);
  await worker.fetch(req("/api/captions", { method: "POST", ...s, body: { text: "A caption" } }), e);
  const r = await worker.fetch(req("/api/backup", s), e);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition"), /shakhira-backup-\d{4}-\d{2}-\d{2}\.json/);
  const data = await r.json();
  assert.equal(data.format, "shakhira-backup-v1");
  assert.equal(data.tables.captions[0].text, "A caption");
  assert.equal("revoked_sessions" in data.tables || "login_failures" in data.tables, false);
  assert.ok((await e.DB.prepare("SELECT * FROM audit_log WHERE action='backup_export'").all()).results.length === 1);
});

test("Postgres adapter quotes every value and refuses unsafe ones", () => {
  assert.equal(literal("it's; drop table x --"), "'it''s; drop table x --'");
  assert.equal(literal(null), "NULL");
  assert.equal(literal(42), "'42'");
  assert.throws(() => literal("a\u0000b"));
  assert.throws(() => literal(Infinity));
  assert.equal(inline("SELECT * FROM t WHERE a = ? AND b = '?' AND c = ?", ["x", 2]), "SELECT * FROM t WHERE a = 'x' AND b = '?' AND c = '2'");
  assert.throws(() => inline("SELECT ?", []));
  assert.throws(() => inline("SELECT 1", [1]));
});

test("Postgres adapter maps D1 calls onto the gateway RPC", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const { mode } = JSON.parse(init.body);
    return new Response(JSON.stringify(mode === "run" ? { rows: [{ id: 7 }], changes: 1 } : [{ n: 3 }]), { status: 200 });
  };
  const db = new SupabaseDB({ url: "https://p.supabase.co/", key: "sb_secret_test", fetchImpl });
  const r = await db.prepare("INSERT INTO captions (text) VALUES (?)").bind("hi").run();
  assert.deepEqual(r.meta, { changes: 1, last_row_id: 7 });
  assert.equal(calls[0].url, "https://p.supabase.co/rest/v1/rpc/shakhira_exec");
  assert.equal(calls[0].body.q, "INSERT INTO captions (text) VALUES ('hi') RETURNING *");
  assert.equal(calls[0].init.headers.apikey, "sb_secret_test");
  assert.equal(calls[0].init.headers.authorization, undefined);
  assert.deepEqual(await db.prepare("SELECT COUNT(*) AS n FROM captions").first(), { n: 3 });
  const failing = new SupabaseDB({ url: "https://p.supabase.co", key: "k", fetchImpl: async () => new Response(JSON.stringify({ message: "boom" }), { status: 400 }) });
  await assert.rejects(failing.prepare("SELECT 1").all(), /boom/);
});

test("Supabase Auth login requires an admin flag set by the service key", async () => {
  const realFetch = globalThis.fetch;
  const users = { "owner@example.com": { pw: "right-password-1", admin: true }, "member@example.com": { pw: "member-password-1", admin: false } };
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/auth\/v1\/token\?grant_type=password$/);
    const { email, password } = JSON.parse(init.body);
    const u = users[email];
    if (!u || u.pw !== password) return new Response("{}", { status: 400 });
    return new Response(JSON.stringify({ user: { email, app_metadata: u.admin ? { shakhira_admin: true } : {} } }), { status: 200 });
  };
  try {
    const e = env({ AUTH_MODE: "supabase", SUPABASE_URL: "https://p.supabase.co" });
    const h = await (await worker.fetch(req("/api/health"), e)).json();
    assert.equal(h.auth, "supabase");
    assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD } }), e)).status, 401);
    assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { email: "member@example.com", password: "member-password-1" } }), e)).status, 401);
    assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { email: "owner@example.com", password: "nope" } }), e)).status, 401);
    const s = await login(e, { email: "Owner@Example.com", password: "right-password-1" });
    assert.equal((await worker.fetch(req("/api/me", s), e)).status, 200);
    const audit = (await e.DB.prepare("SELECT actor FROM audit_log WHERE action='login'").all()).results;
    assert.deepEqual(audit.map((a) => a.actor), ["owner@example.com"]);
  } finally { globalThis.fetch = realFetch; }
});

test("cron hand-off accepts only a fresh, correctly signed request", async () => {
  const secret = "c".repeat(48);
  const e = env({ CYCLE_SECRET: secret });
  const now = Math.floor(Date.now() / 1000);
  const post = (headers) => worker.fetch(req("/api/internal/cycle", { method: "POST", headers }), e);
  assert.equal((await post({})).status, 403);
  assert.equal((await post(await signCycle("x".repeat(48), now))).status, 403);
  assert.equal((await post(await signCycle(secret, now - 600))).status, 403);
  assert.equal((await post(await signCycle(secret, now))).status, 200);
  assert.equal((await worker.fetch(req("/api/internal/cycle", { method: "POST", headers: await signCycle(secret, now) }), env())).status, 403);
});
