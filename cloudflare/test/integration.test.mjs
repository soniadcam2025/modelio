// Live-bot mirror (read-only), forwarded updates, reminders, daily backups and the per-request query budget.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import { readBackup, runBackup, splitRows } from "../src/backup.js";
import worker, { runScheduled } from "../src/index.js";
import { readOnly, syncLiveBot } from "../src/live.js";
import { Ops } from "../src/ops.js";
import { MAX_POSTS_PER_CYCLE, sendReminders } from "../src/scheduler.js";
import { SendOnlyTelegram } from "../src/telegram.js";
import { handleUpdate, matchRule, signUpdate } from "../src/updates.js";
import { makeD1 } from "./d1shim.mjs";

const NOW = 1_800_000_000;
const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin.example.workers.dev";

// The live bot's real schema (read from shakhira-vip with sqlite_master; no records were read), with made-up rows.
function liveDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE members (chat_id TEXT, user_id INTEGER, status TEXT, until_date INTEGER, checked_at INTEGER, PRIMARY KEY(chat_id,user_id));
    CREATE TABLE events (update_id INTEGER PRIMARY KEY, chat_id TEXT, user_id INTEGER, status TEXT, until_date INTEGER, event_date INTEGER);
    CREATE TABLE processed (update_id INTEGER PRIMARY KEY, processed_at INTEGER);
    CREATE TABLE trial_access (user_id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL, active INTEGER NOT NULL, payment_charge_id TEXT UNIQUE NOT NULL, updated_at INTEGER NOT NULL);`);
  const shim = {
    prepare(sql) {
      let args = [];
      const st = { bind: (...a) => { args = a; return st; }, all: async () => ({ results: db.prepare(sql).all(...args).map((r) => ({ ...r })) }),
        first: async () => db.prepare(sql).get(...args) ?? null, run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; } };
      return st;
    },
  };
  return { db, shim };
}

test("live-bot mirror is read-only and maps members, events and trials", async () => {
  const { db, shim } = liveDb();
  db.exec(`INSERT INTO members VALUES ('-100', 11, 'member', ${NOW + 20 * 86400}, ${NOW - 100}), ('-100', 12, 'left', NULL, ${NOW - 50});
    INSERT INTO events VALUES (900, '-100', 11, 'member', ${NOW + 20 * 86400}, ${NOW - 5000}), (901, '-100', 12, 'left', NULL, ${NOW - 60});
    INSERT INTO trial_access VALUES (13, ${NOW + 2 * 86400}, 1, 'ch_trial_13', ${NOW - 86400});`);
  assert.throws(() => readOnly(shim).prepare("DELETE FROM members"), /read-only/);
  assert.throws(() => readOnly(shim).prepare("SELECT 1; DELETE FROM members"), /read-only/);
  const ops = new Ops(makeD1(), () => NOW);
  assert.deepEqual(await syncLiveBot(shim, ops, NOW), { members: 2, events: 2, trials: 1 });
  assert.deepEqual(await syncLiveBot(shim, ops, NOW), { members: 0, events: 0, trials: 0 }, "incremental: nothing new");
  const people = Object.fromEntries((await ops.subscribers("", NOW)).map((p) => [p.user_id, p]));
  assert.equal(people[11].membership, "monthly");
  assert.equal(people[11].subscription_until, NOW + 20 * 86400);
  assert.equal(people[12].membership, "left");
  assert.equal(people[13].membership, "trial");
  assert.equal(people[13].stars_paid, 49);
  // A later status check updates the snapshot in place rather than adding rows.
  db.exec(`UPDATE members SET status='kicked', checked_at=${NOW + 10} WHERE user_id=11`);
  await syncLiveBot(shim, ops, NOW + 20);
  assert.equal((await ops.subscriber(11, NOW + 20)).membership, "left");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members").get().n, 2, "live data unchanged");
});

test("member sync runs from the cron only when the feature is on", async () => {
  const { db, shim } = liveDb();
  db.exec(`INSERT INTO members VALUES ('-100', 21, 'member', ${NOW + 86400 * 30}, ${NOW - 10});`);
  const env = { DB: makeD1(), LIVE_DB: shim, ENVIRONMENT: "staging", REQUIRE_PREVIEW: "true" };
  assert.equal((await runScheduled(env, NOW)).summary.member_sync, undefined);
  await new Ops(env.DB).setSetting("feature:member_sync", "1");
  assert.deepEqual((await runScheduled(env, NOW)).summary.member_sync, { members: 1, events: 0, trials: 0 });
});

function fakeTg() {
  const calls = [];
  return { calls, simulating: false, simulated: [], call: async (method, params) => { calls.push([method, params]); return method === "getChatMember" ? { status: "member" } : { message_id: 1 }; } };
}
const CONFIG = { vipChannelId: "-100777", publicChannel: "@yourshakhira", discussionGroupId: "-100888", monthlyPrice: 499 };

test("forwarded join requests follow the channel's policy and are de-duplicated", async () => {
  const ops = new Ops(makeD1(), () => NOW), tg = fakeTg();
  const upd = (id, chat) => ({ update_id: id, chat_join_request: { chat, from: { id: 31, username: "fan", first_name: "F" }, date: NOW } });
  assert.equal(await handleUpdate(upd(1, { id: -100777 }), { ops, tg, config: CONFIG, now: NOW }), "ignored", "feature off");
  await ops.setSetting("feature:join_requests", "1");
  assert.equal(await handleUpdate(upd(2, { id: -100777 }), { ops, tg, config: CONFIG, now: NOW }), "join: pending");
  assert.equal(await handleUpdate(upd(2, { id: -100777 }), { ops, tg, config: CONFIG, now: NOW }), "duplicate");
  await ops.setJoinPolicy("public", "approve_all", "t");
  assert.equal(await handleUpdate(upd(3, { id: -1001, username: "YourShakhira" }), { ops, tg, config: CONFIG, now: NOW }), "join: approved");
  assert.deepEqual(tg.calls.map((c) => c[0]), ["approveChatJoinRequest"]);
  await ops.setJoinPolicy("vip", "approve_paid", "t");
  assert.equal(await handleUpdate(upd(4, { id: -100777 }), { ops, tg, config: CONFIG, now: NOW }), "join: pending", "no paid trial");
  await ops.run("INSERT INTO trials (user_id, charge_id, starts_at, expires_at, status) VALUES (31, 'c1', ?, ?, 'active')", NOW - 10, NOW + 86400);
  assert.equal(await handleUpdate(upd(5, { id: -100777 }), { ops, tg, config: CONFIG, now: NOW }), "join: approved");
  assert.equal((await ops.joinRequests("pending")).length, 2);
});

test("reactions and moderation from forwarded updates", async () => {
  const ops = new Ops(makeD1(), () => NOW), tg = fakeTg();
  await ops.setSetting("feature:reaction_tracking", "1");
  await ops.setSetting("feature:moderation", "1");
  const rc = { update_id: 10, message_reaction_count: { chat: { id: -100777 }, message_id: 5, reactions: [{ type: { type: "emoji", emoji: "🔥" }, total_count: 3 }, { type: { type: "emoji", emoji: "❤" }, total_count: 2 }] } };
  assert.equal(await handleUpdate(rc, { ops, tg, config: CONFIG, now: NOW }), "reactions: saved");
  assert.equal((await ops.one("SELECT total FROM reaction_counts WHERE message_id=5")).total, 5);
  await ops.addModerationRule("link", "spam.example", "delete_warn", "t");
  const m = (id, text) => ({ update_id: id, message: { message_id: id, chat: { id: -100888, type: "supergroup" }, from: { id: 41, first_name: "S" }, text } });
  assert.equal(await handleUpdate(m(11, "hello there"), { ops, tg, config: CONFIG, now: NOW }), "moderation: clean");
  assert.equal(await handleUpdate(m(12, "buy at https://spam.example/x"), { ops, tg, config: CONFIG, now: NOW }), "moderation: warned");
  await handleUpdate(m(13, "https://spam.example/y"), { ops, tg, config: CONFIG, now: NOW });
  assert.equal(await handleUpdate(m(14, "spam.example again www.spam.example"), { ops, tg, config: CONFIG, now: NOW }), "moderation: muted");
  assert.ok(tg.calls.some(([meth]) => meth === "restrictChatMember"));
  assert.equal(matchRule("Drop it", [{ kind: "word", pattern: "drop" }])?.pattern, "drop");
  assert.equal(matchRule("dropping", [{ kind: "word", pattern: "drop" }]), null);
});

test("forwarded updates need a valid fresh signature; staging cannot act on members", async () => {
  const secret = "u".repeat(48);
  const env = { DB: makeD1(), UPDATE_SECRET: secret, ENVIRONMENT: "staging", REQUIRE_PREVIEW: "true", VIP_CHANNEL_ID: "-100777" };
  await new Ops(env.DB).setSetting("feature:join_requests", "1");
  await new Ops(env.DB).setJoinPolicy("public", "approve_all", "t");
  const body = JSON.stringify({ update_id: 77, chat_join_request: { chat: { id: -1, username: "yourshakhira" }, from: { id: 5 }, date: NOW } });
  const post = (headers, b = body) => worker.fetch(new Request(ORIGIN + "/internal/update", { method: "POST", body: b, headers }), env);
  assert.equal((await post({})).status, 403);
  assert.equal((await post(await signUpdate("x".repeat(48), body))).status, 403);
  assert.equal((await post(await signUpdate(secret, body, Math.floor(Date.now() / 1000) - 900))).status, 403);
  assert.equal((await post(await signUpdate(secret, body), body.replace("77", "78"))).status, 403, "body tampered");
  const ok = await post(await signUpdate(secret, body));
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result, "join: approved", "simulated in staging (no token): nothing reaches Telegram");
});

test("reminders: trial 24 h before, renewal 3 days before, each once", async () => {
  const ops = new Ops(makeD1(), () => NOW), tg = fakeTg();
  await ops.run("INSERT INTO trials (user_id, charge_id, starts_at, expires_at, status) VALUES (51, 'c51', ?, ?, 'active')", NOW - 86400, NOW + 3600);
  await ops.run("INSERT INTO trials (user_id, charge_id, starts_at, expires_at, status) VALUES (52, 'c52', ?, ?, 'active')", NOW, NOW + 2 * 86400);
  await ops.run("INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at, ext_id) VALUES (53, 'joined', 'live:status', ?, ?, 'live:member:53')", NOW + 2 * 86400, NOW);
  assert.deepEqual(await sendReminders(tg, ops, CONFIG, NOW), { trial: 1, renewal: 1, failed: 0 });
  assert.deepEqual(await sendReminders(tg, ops, CONFIG, NOW + 60), { trial: 0, renewal: 0, failed: 0 });
  assert.deepEqual(tg.calls.map((c) => c[1].chat_id).sort(), [51, 53]);
  assert.match(tg.calls.find((c) => c[1].chat_id === 53)[1].text, /499 ⭐/);
});

test("daily backup to a separate D1: stored in one transaction, readable, rotated after 14 days", async () => {
  const ops = new Ops(makeD1(), () => NOW), backupDb = makeD1();
  await ops.addCaption("keep me", "t");
  const r = await runBackup(ops, backupDb, NOW);
  assert.ok(r.rows >= 1);
  const back = await readBackup(backupDb, NOW);
  assert.equal(back.tables.captions[0].text, "keep me");
  await runBackup(ops, backupDb, NOW + 15 * 86400);
  assert.equal((await backupDb.prepare("SELECT COUNT(*) AS n FROM backup_parts WHERE backup_id = ?").bind(NOW).first()).n, 0);
  assert.equal(splitRows(Array.from({ length: 300 }, (_, i) => ({ i, pad: "x".repeat(1000) }))).length, 4);
  const env = { DB: ops.db, BACKUP_DB: backupDb, ENVIRONMENT: "staging", REQUIRE_PREVIEW: "true" };
  const at = Date.UTC(2026, 10, 21, 21, 40) / 1000;
  assert.ok((await runScheduled(env, at)).backup, "runs at 21:40 UTC");
  assert.equal((await runScheduled(env, at + 60)).backup, undefined);
});

// Workers Free allows 50 outbound requests per invocation; on Supabase every query is one.
function counting(db) {
  const counter = { n: 0 };
  return { counter, db: { batch: db.batch, prepare: (sql) => { counter.n++; return db.prepare(sql); } } };
}
test("query budget: busy pages and a full cron run stay under 40 database calls", async () => {
  const base = makeD1(), { counter, db } = counting(base);
  const ops = new Ops(base, () => NOW);
  for (let i = 0; i < 120; i++) await ops.touchProfile(1000 + i, `u${i}`, "N", "", NOW);
  for (let i = 0; i < 30; i++) await ops.run("INSERT INTO payments (telegram_payment_charge_id, user_id, plan, amount, currency, payload, created_at, status) VALUES (?, ?, 'trial', 49, 'XTR', 'p', ?, 'accepted')", `c${i}`, 1000 + i, NOW - i * 3600);
  for (let i = 0; i < 25; i++) await ops.createContent({ kind: "text", target: "public", text: `post ${i}`, scheduled_at: NOW - 5 }, "t");
  await ops.run("UPDATE content_items SET status='scheduled'");
  for (const f of ["scheduled_posts", "poll_auto_close", "post_expiry", "trial_reminders", "renewal_reminders", "admin_actions"]) await ops.setSetting("feature:" + f, "1");
  const env = { DB: db, DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "production", REQUIRE_PREVIEW: "false", VIP_CHANNEL_ID: "-100777" };
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "1.1.1.1" } }), env);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  for (const path of ["/api/overview", "/api/subscribers", "/api/analytics", "/api/content", "/api/settings", "/api/backup"]) {
    counter.n = 0;
    const res = await worker.fetch(new Request(ORIGIN + path, { headers: { cookie } }), env);
    assert.equal(res.status, 200, path);
    console.log(`budget ${path}: ${counter.n} database calls`);
    assert.ok(counter.n <= 40, `${path} made ${counter.n} database calls`);
  }
  counter.n = 0;
  const tgCalls = [];
  const out = await runScheduled({ ...env, BOT_TOKEN: "123:abc" }, NOW, async (url) => { tgCalls.push(url); return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })); });
  assert.equal(out.summary.posts.posted, MAX_POSTS_PER_CYCLE);
  console.log(`budget cron: ${counter.n} database + ${tgCalls.length} Telegram calls`);
  assert.ok(counter.n + tgCalls.length <= 45, `cron run used ${counter.n} database + ${tgCalls.length} Telegram calls`);
});

test("Back up now: signed-in only, needs a linked backup database, audited", async () => {
  const env = { DB: makeD1(), BACKUP_DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "staging", REQUIRE_PREVIEW: "true" };
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "1.1.1.2" } }), env);
  const cookie = r.headers.get("set-cookie").split(";")[0], { csrf } = await r.json();
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/backup/now", { method: "POST" }), env)).status, 401);
  const ok = await worker.fetch(new Request(ORIGIN + "/api/backup/now", { method: "POST", headers: { cookie, "x-csrf-token": csrf } }), env);
  assert.equal(ok.status, 200);
  const log = await (await worker.fetch(new Request(ORIGIN + "/api/backup/log", { headers: { cookie } }), env)).json();
  assert.equal(log.length, 1);
  const noDb = { ...env, BACKUP_DB: undefined };
  assert.equal((await worker.fetch(new Request(ORIGIN + "/api/backup/now", { method: "POST", headers: { cookie, "x-csrf-token": csrf } }), noDb)).status, 400);
});

test("Bot & channels view is read-only and hides the webhook URL", async () => {
  const env = { DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "production", REQUIRE_PREVIEW: "true",
    VIP_CHANNEL_ID: "-100777", PUBLIC_CHANNEL: "@yourshakhira" };
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "1.1.1.3" } }), env);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  const get = (e) => worker.fetch(new Request(ORIGIN + "/api/telegram", { headers: { cookie } }), e);
  assert.deepEqual(await (await get(env)).json(), { configured: false });
  const realFetch = globalThis.fetch, methods = [];
  globalThis.fetch = async (url, init) => {
    const m = String(url).split("/").pop(); methods.push(m);
    const result = { getMe: { username: "ShakhiraVIPBot", first_name: "Shakhira" }, getWebhookInfo: { url: "https://secret-host.example/telegram", pending_update_count: 0, allowed_updates: ["message"] },
      getChat: { title: JSON.parse(init.body).chat_id === "-100777" ? "VIP" : "Public", type: "channel" }, getChatMemberCount: 42 }[m];
    return new Response(JSON.stringify({ ok: true, result }));
  };
  try {
    const d = await (await get({ ...env, BOT_TOKEN: "1:T" })).json();
    assert.equal(d.bot.username, "ShakhiraVIPBot");
    assert.equal(d.webhook.set, true);
    assert.equal(JSON.stringify(d).includes("secret-host"), false);
    assert.equal(d.channels.vip.title, "VIP");
    assert.equal(d.channels.public.members, 42);
    assert.ok(methods.every((m) => m.startsWith("get")), methods.join(","));
  } finally { globalThis.fetch = realFetch; }
});

test("locked mode (token, no preview chat) sends nothing but still syncs members", async () => {
  const { db, shim } = liveDb();
  db.exec(`INSERT INTO members VALUES ('-100', 61, 'member', ${NOW + 86400 * 30}, ${NOW - 10});`);
  const env = { DB: makeD1(), LIVE_DB: shim, BOT_TOKEN: "1:T", ENVIRONMENT: "production", REQUIRE_PREVIEW: "true" };
  await new Ops(env.DB).setSetting("feature:member_sync", "1");
  await new Ops(env.DB).setSetting("feature:scheduled_posts", "1");
  const calls = [];
  const out = await runScheduled(env, NOW, async (u) => { calls.push(u); return new Response("{}"); });
  assert.equal(out.mode, "locked");
  assert.deepEqual(out.member_sync, { members: 1, events: 0, trials: 0 });
  assert.equal(calls.length, 0);
});

test("synced profiles carry the live bot's own timestamps", async () => {
  const { db, shim } = liveDb();
  db.exec(`INSERT INTO members VALUES ('-100', 71, 'member', ${NOW + 86400}, ${NOW - 7200}); INSERT INTO events VALUES (5, '-100', 71, 'member', NULL, ${NOW - 90000});`);
  const ops = new Ops(makeD1(), () => NOW);
  await syncLiveBot(shim, ops, NOW);
  const p = await ops.one("SELECT first_seen, last_seen FROM profiles WHERE user_id = 71");
  assert.deepEqual([p.first_seen, p.last_seen], [NOW - 90000, NOW - 7200]);
});
