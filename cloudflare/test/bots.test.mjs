// Settings → Bots & integrations: encryption, fresh password checks, masking, isolation between bots,
// per-bot automation, Cloudinary credentials, and backup/rollback of the configuration.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import { readBackup, runBackup } from "../src/backup.js";
import { decryptSecret, encryptSecret } from "../src/crypto.js";
import worker, { runScheduled } from "../src/index.js";
import { Ops } from "../src/ops.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const KEY = Buffer.alloc(32, 7).toString("base64");
const ORIGIN = "https://shakhira-admin.example.workers.dev";
const VIP_TOKEN = "1111111111:AAprimaryprimaryprimaryprimaryprim1";
const NEW_TOKEN = "2222222222:AAsecondsecondsecondsecondsecondse2";
const NEW_TOKEN_2 = "2222222222:AArotatedrotatedrotatedrotatedrota3";
const OTHER_TOKEN = "3333333333:AAthirdthirdthirdthirdthirdthirdth3";
const CLOUD_SECRET = "cloudinary-secret-value-xyz";
const BOTS = { "1111111111": { id: 1111111111, is_bot: true, username: "ShakhiraVIPBot", first_name: "Shakhira VIP" },
  "2222222222": { id: 2222222222, is_bot: true, username: "ShakhiraNewsBot", first_name: "News" },
  "3333333333": { id: 3333333333, is_bot: true, username: "OtherBot", first_name: "Other" } };

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.cloudinary.com/")) {
    const ok = (init.headers?.authorization || "") === "Basic " + btoa(`123456789:${CLOUD_SECRET}`);
    return new Response(JSON.stringify({ resources: [] }), { status: ok ? 200 : 401 });
  }
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!m) return realFetch(url, init);
  const [, token, method] = m, me = BOTS[token.split(":")[0]];
  const params = init.body ? JSON.parse(init.body) : {};
  sent.push({ token, method, params });
  const ok = (result) => new Response(JSON.stringify({ ok: true, result }));
  if (method === "getMe") return ok(me);
  if (method === "getWebhookInfo") return ok({ url: me.id === 1111111111 ? "https://live-bot.example/telegram" : "", pending_update_count: 0 });
  if (method === "getChat") return ok({ id: params.chat_id, title: `Chat ${params.chat_id}`, type: "channel" });
  if (method === "getChatMember") return ok(params.chat_id === "-1009999" ? { status: "member" } : params.chat_id === "-1009998"
    ? { status: "administrator", can_post_messages: false } : { status: "administrator", can_post_messages: true });
  return ok({ message_id: 77 });
};

const env = (o = {}) => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), CREDENTIALS_KEY: KEY,
  ENVIRONMENT: "production", REQUIRE_PREVIEW: "false", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-100777", BOT_USERNAME: "ShakhiraVIPBot", ...o });
async function login(e) {
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "9.9.9.9" } }), e);
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}
const call = async (e, s, path, method = "GET", body) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { cookie: s.cookie, "x-csrf-token": s.csrf, "cf-connecting-ip": "9.9.9.9" } }), e);
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null };
};
const SECRETS = [VIP_TOKEN, NEW_TOKEN, NEW_TOKEN_2, OTHER_TOKEN, CLOUD_SECRET, "AAprimary", "AAsecond", "AArotated", "AAthird"];
const leaks = (text) => SECRETS.filter((x) => String(text).includes(x));

test("encryption: AES-GCM bound to its record and key", async () => {
  const c = await encryptSecret(KEY, VIP_TOKEN, "bot:1111111111");
  assert.equal(await decryptSecret(KEY, c, "bot:1111111111"), VIP_TOKEN);
  await assert.rejects(decryptSecret(KEY, c, "bot:2222222222"), /cannot be decrypted/);
  await assert.rejects(decryptSecret(Buffer.alloc(32, 8).toString("base64"), c, "bot:1111111111"), /cannot be decrypted/);
  assert.notEqual(c, await encryptSecret(KEY, VIP_TOKEN, "bot:1111111111"), "random IV");
});

test("adding a bot needs a fresh password, identifies it with getMe and never returns the token", async () => {
  const e = env(), s = await login(e);
  assert.equal((await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN })).status, 400, "no password");
  assert.equal((await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN, password: "wrong-password-0" })).status, 400);
  const r = await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN, password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.username, "ShakhiraVIPBot");
  assert.equal(r.body.is_primary, true);
  assert.equal(r.body.automation_enabled, false);
  assert.equal(r.body.token, "1111111111:••••rim1");
  assert.equal(r.body.webhook.set, true, "webhook health is read, never changed");
  assert.ok(!sent.some((x) => /setWebhook|deleteWebhook|getUpdates/.test(x.method)));
  assert.equal((await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN, password: PASSWORD })).status, 400, "duplicate");
  assert.equal((await call(e, s, "/api/bots", "POST", { token: "not-a-token", password: PASSWORD })).status, 400);
  const list = await call(e, s, "/api/bots");
  assert.deepEqual(leaks(list.text), []);
  const stored = (await e.DB.prepare("SELECT * FROM bots").all()).results;
  assert.deepEqual(leaks(JSON.stringify(stored)), [], "database holds ciphertext only");
  assert.deepEqual(leaks((await call(e, s, "/api/backup")).text), [], "backups hold ciphertext only");
  assert.deepEqual(leaks((await call(e, s, "/api/audit")).text), []);
});

test("replace accepts only the same bot's new token; disconnect removes the stored copy", async () => {
  const e = env(), s = await login(e);
  const b = (await call(e, s, "/api/bots", "POST", { token: NEW_TOKEN, password: PASSWORD })).body;
  assert.equal((await call(e, s, `/api/bots/${b.id}/token`, "PUT", { token: OTHER_TOKEN, password: PASSWORD })).status, 400);
  assert.equal((await call(e, s, `/api/bots/${b.id}/token`, "PUT", { token: NEW_TOKEN_2 })).status, 400, "fresh password required");
  const r = await call(e, s, `/api/bots/${b.id}/token`, "PUT", { token: NEW_TOKEN_2, password: PASSWORD });
  assert.equal(r.body.token, "2222222222:••••ota3");
  assert.equal((await call(e, s, `/api/bots/${b.id}/test`, "POST")).body.last_check_ok, true);
  assert.equal((await call(e, s, `/api/bots/${b.id}/token`, "DELETE", {})).status, 400, "fresh password required");
  const d = await call(e, s, `/api/bots/${b.id}/token`, "DELETE", { password: PASSWORD });
  assert.equal(d.body.status, "disconnected");
  assert.equal(d.body.token, null);
  assert.equal((await e.DB.prepare("SELECT token_cipher FROM bots WHERE id = ?").bind(b.id).first()).token_cipher, "");
  assert.equal((await call(e, s, `/api/bots/${b.id}/automation`, "PUT", { enabled: true })).status, 400);
  const h = await call(e, s, `/api/bots/${b.id}/history`);
  assert.deepEqual(h.body.audit.map((a) => a.action).reverse(), ["bot_add", "bot_token_replace", "bot_test", "bot_disconnect"]);
});

test("isolation: a bot can only use its own channels, permissions and switch", async () => {
  const e = env(), s = await login(e);
  const vip = (await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN, password: PASSWORD })).body;
  const news = (await call(e, s, "/api/bots", "POST", { token: NEW_TOKEN, password: PASSWORD })).body;
  assert.equal((await call(e, s, `/api/bots/${news.id}/channels`, "POST", { chat_id: "-1009001" })).status, 200);
  assert.match((await call(e, s, `/api/bots/${news.id}/channels`, "POST", { chat_id: "-1009999" })).body.error, /not an admin/);
  assert.match((await call(e, s, `/api/bots/${news.id}/channels`, "POST", { chat_id: "-1009998" })).body.error, /can't post/);
  const steal = await call(e, s, `/api/bots/${vip.id}/channels`, "POST", { chat_id: "-1009001" });
  assert.equal(steal.body.error, "That channel belongs to another bot", steal.text);
  const post = (b) => call(e, s, "/api/content", "POST", { kind: "text", text: "hi", ...b });
  assert.equal((await post({ target: "public", bot_id: news.id })).status, 400, "public channel is the primary bot's");
  assert.equal((await post({ target: "chat:-1009002", bot_id: news.id })).status, 400, "not its channel");
  assert.equal((await post({ target: "chat:-1009001" })).status, 400, "chat targets need a bot");
  const now = Math.floor(Date.now() / 1000);
  const mine = (await post({ target: "chat:-1009001", bot_id: news.id, schedule: true, scheduled_at: now - 5 })).body;
  const primaryPost = (await post({ target: "public", schedule: true, scheduled_at: now - 5 })).body;
  await new Ops(e.DB).setSetting("feature:scheduled_posts", "1");
  sent.length = 0;
  await runScheduled(e, now);
  assert.equal(sent.filter((x) => x.method === "sendMessage").length, 0, "both bots' automation is off");
  await call(e, s, `/api/bots/${news.id}/automation`, "PUT", { enabled: true });
  await runScheduled(e, now + 60);
  const items = Object.fromEntries((await call(e, s, "/api/content")).body.map((i) => [i.id, i]));
  assert.equal(items[mine.id].status, "failed", "no 'posts' permission yet");
  assert.match(items[mine.id].last_error, /permission/);
  const unconfirmed = await call(e, s, `/api/content/${mine.id}/schedule`, "POST", { scheduled_at: now });
  assert.match(unconfirmed.body.error, /Confirm/, "live mode: every real publish needs explicit confirmation");
  assert.match((await call(e, s, `/api/content/${mine.id}/schedule`, "POST", { scheduled_at: now, confirm: true })).body.error, /not permitted/, "can't queue without the permission");
  await call(e, s, `/api/bots/${news.id}/permissions`, "PUT", { permissions: { posts: true, member_actions: true } });
  assert.equal((await call(e, s, `/api/content/${mine.id}/schedule`, "POST", { scheduled_at: now, confirm: true })).status, 200);
  assert.equal((await call(e, s, `/api/bots/${news.id}`.replace(/$/, "/history"))).body.bot.permissions.member_actions, false, "member actions only for the primary bot");
  sent.length = 0;
  await runScheduled(e, now + 120);
  const sends = sent.filter((x) => x.method === "sendMessage");
  assert.equal(sends.length, 1);
  assert.equal(sends[0].token, NEW_TOKEN);
  assert.equal(sends[0].params.chat_id, "-1009001");
  const after = Object.fromEntries((await call(e, s, "/api/content")).body.map((i) => [i.id, i]));
  assert.equal(after[mine.id].status, "posted");
  assert.equal(after[primaryPost.id].status, "scheduled", "the primary bot's post waits for the primary's own switch");
  assert.deepEqual((await call(e, s, `/api/bots/${vip.id}/history`)).body.content, [], "separate histories");
});

test("Cloudinary credentials: fresh password, tested before saving, masked, used by the media library", async () => {
  const e = env(), s = await login(e);
  const creds = { cloud_name: "shakhira", api_key: "123456789", api_secret: CLOUD_SECRET };
  assert.equal((await call(e, s, "/api/integrations/cloudinary", "PUT", creds)).status, 400, "no password");
  assert.equal((await call(e, s, "/api/integrations/cloudinary", "PUT", { ...creds, api_secret: "wrong-secret-123", password: PASSWORD })).status, 400, "refused by Cloudinary");
  const r = await call(e, s, "/api/integrations/cloudinary", "PUT", { ...creds, password: PASSWORD });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.cloud_name, r.body.api_key, r.body.api_secret], ["shakhira", "••••6789", "••••-xyz"]);
  assert.equal((await call(e, s, "/api/integrations/cloudinary/test", "POST")).body.last_check_ok, true);
  assert.equal((await call(e, s, "/api/poster")).body.configured, true, "media library now uses the saved credentials");
  assert.deepEqual(leaks((await call(e, s, "/api/integrations/cloudinary")).text), []);
  assert.deepEqual(leaks(JSON.stringify((await e.DB.prepare("SELECT * FROM integration_secrets").all()).results)), []);
  assert.equal((await call(e, s, "/api/integrations/cloudinary", "DELETE", { password: PASSWORD })).body.connected, false);
});

test("without CREDENTIALS_KEY nothing can be stored", async () => {
  const e = env({ CREDENTIALS_KEY: undefined }), s = await login(e);
  const r = await call(e, s, "/api/bots", "POST", { token: VIP_TOKEN, password: PASSWORD });
  assert.equal(r.status, 400, r.text);
  assert.match(String(r.body.error), /CREDENTIALS_KEY/, r.text);
});

test("configuration backup and rollback: a restored backup brings back the previous token", async () => {
  const e = env(), s = await login(e), backupDb = makeD1();
  const b = (await call(e, s, "/api/bots", "POST", { token: NEW_TOKEN, password: PASSWORD })).body;
  await call(e, s, `/api/bots/${b.id}/channels`, "POST", { chat_id: "-1009005" });
  await runBackup(new Ops(e.DB), backupDb, 1000);
  await call(e, s, `/api/bots/${b.id}/token`, "PUT", { token: NEW_TOKEN_2, password: PASSWORD });
  await call(e, s, `/api/bots/${b.id}/channels/-1009005`, "DELETE");
  // Roll back: put the backed-up rows of the configuration tables back (what restore-backup.mjs does for Supabase).
  const back = await readBackup(backupDb, 1000);
  for (const t of ["bots", "bot_channels", "integration_secrets"]) {
    await e.DB.prepare(`DELETE FROM ${t}`).run();
    for (const row of back.tables[t]) {
      const cols = Object.keys(row);
      await e.DB.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => row[c])).run();
    }
  }
  const after = (await call(e, s, `/api/bots/${b.id}/test`, "POST")).body;
  assert.equal(after.token, "2222222222:••••dse2");
  assert.equal(after.last_check_ok, true, "the restored ciphertext decrypts with the Worker key");
  assert.deepEqual(after.channels.map((c) => c.chat_id), ["-1009005"]);
});

test("no credential appears in logs", async () => {
  const lines = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.map(String).join(" "));
  try {
    const e = env(), s = await login(e);
    const b = (await call(e, s, "/api/bots", "POST", { token: NEW_TOKEN, password: PASSWORD })).body;
    await call(e, s, `/api/bots/${b.id}/token`, "PUT", { token: "2222222222:AAbad", password: PASSWORD });
    await call(e, s, "/api/integrations/cloudinary", "PUT", { cloud_name: "x1", api_key: "123456789", api_secret: CLOUD_SECRET, password: PASSWORD });
    await runScheduled(e, Math.floor(Date.now() / 1000));
  } finally { Object.assign(console, orig); }
  assert.deepEqual(leaks(lines.join("\n")), []);
});

test("fetch is never called as a method (Cloudflare Workers throws 'Illegal invocation')", async () => {
  // Like the Workers runtime: fetch must be called with no receiver (or the global object).
  function strictFetch(url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return globalThis.fetch(url, init);
  }
  const { SendOnlyTelegram } = await import("../src/telegram.js");
  const { SupabaseDB } = await import("../src/pg.js");
  const { BotStore } = await import("../src/bots.js");
  const tg = new SendOnlyTelegram({ token: VIP_TOKEN, fetchImpl: strictFetch });
  assert.equal((await tg.call("getMe", {})).username, "ShakhiraVIPBot");
  const store = new BotStore(new Ops(makeD1()), { CREDENTIALS_KEY: KEY }, { fetchImpl: strictFetch });
  assert.equal(await store.cloudinaryTest({ cloud: "shakhira", key: "123456789", secret: CLOUD_SECRET }), true);
  const db = new SupabaseDB({ url: "https://p.supabase.co", key: "sb_secret_x", fetchImpl: function (u, i) { if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation"); return Promise.resolve(new Response("[]")); } });
  assert.deepEqual((await db.prepare("SELECT 1").all()).results, []);
});
