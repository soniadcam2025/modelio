import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { hashPassword, verifyPassword } from "../src/auth.js";
import worker, { csvSafe, handleApi, runScheduled } from "../src/index.js";
import { Ops, validateContent } from "../src/ops.js";
import { SendOnlyTelegram } from "../src/telegram.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin-staging.example.workers.dev";

function env(overrides = {}) {
  return { DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "staging",
    REQUIRE_PREVIEW: "true", PREVIEW_CHAT_ID: "", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-1001234567890",
    POST_SLOTS_UTC: "16:30,23:30", ASSETS: { fetch: async () => new Response("<!doctype html><title>Shakhira Admin</title>", { headers: { "content-type": "text/html" } }) },
    ...overrides };
}
const req = (path, { method = "GET", body, cookie, csrf, ip = "203.0.113.9" } = {}) => new Request(ORIGIN + path, {
  method, body: body === undefined ? undefined : JSON.stringify(body),
  headers: { "content-type": "application/json", "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) },
});
async function login(e) {
  const r = await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD } }), e);
  assert.equal(r.status, 200);
  const cookie = r.headers.get("set-cookie").split(";")[0];
  return { cookie, csrf: (await r.json()).csrf };
}
const call = async (e, s, path, opts = {}) => worker.fetch(req(path, { ...opts, cookie: s.cookie, csrf: s.csrf }), e);

// --- security ---

test("password hashes interoperate with the Python dashboard format", async () => {
  assert.ok(await verifyPassword(PASSWORD, HASH));
  assert.ok(!(await verifyPassword("wrong password!!", HASH)));
  assert.ok(await verifyPassword(PASSWORD, HASH.replaceAll(":", "$")));  // legacy separator
  assert.ok(!(await verifyPassword(PASSWORD, "pbkdf2_sha256:600000:x:y")));  // over the Workers limit: refused, not crashed
});

test("every API route needs a session, and changes need the CSRF token", async () => {
  const e = env();
  for (const p of ["/api/overview", "/api/content", "/api/subscribers", "/api/settings", "/api/audit", "/api/export/subscribers.csv"])
    assert.equal((await worker.fetch(req(p), e)).status, 401, p);
  const s = await login(e);
  const post = { kind: "text", target: "public", text: "hi" };
  assert.equal((await worker.fetch(req("/api/content", { method: "POST", body: post, cookie: s.cookie }), e)).status, 403);
  assert.equal((await worker.fetch(req("/api/content", { method: "POST", body: post, cookie: s.cookie, csrf: "forged" }), e)).status, 403);
  assert.equal((await call(e, s, "/api/content", { method: "POST", body: post })).status, 200);
});

test("session cookie flags, logout revocation and tampering", async () => {
  const e = env();
  const r = await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD } }), e);
  const cookie = r.headers.get("set-cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict"]) assert.ok(cookie.includes(flag), flag);
  const s = { cookie: cookie.split(";")[0], csrf: (await r.json()).csrf };
  assert.equal((await call(e, s, "/api/me")).status, 200);
  const tampered = { ...s, cookie: s.cookie.slice(0, -1) + (s.cookie.endsWith("0") ? "1" : "0") };
  assert.equal((await call(e, tampered, "/api/me")).status, 401);
  assert.equal((await call(e, s, "/api/logout", { method: "POST" })).status, 200);
  assert.equal((await call(e, s, "/api/me")).status, 401);
});

test("login is rate limited per client", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { password: "nope" } }), e)).status, 401);
  assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD } }), e)).status, 429);
  assert.equal((await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD }, ip: "198.51.100.1" }), e)).status, 200);
});

test("security headers on pages and API; API not cached", async () => {
  const e = env();
  const page = await worker.fetch(req("/"), e);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-robots-tag"), "noindex, nofollow");
  const api = await worker.fetch(req("/api/health"), e);
  assert.equal(api.headers.get("cache-control"), "no-store");
  assert.deepEqual(await api.json(), { ok: true, environment: "staging", automation: "simulated" });
});

test("missing secret gives a clear 503, not a crash", async () => {
  assert.equal((await worker.fetch(req("/api/me"), env({ DASHBOARD_SECRET: "" }))).status, 503);
});

test("CSV export is formula-safe", async () => {
  const e = env();
  await new Ops(e.DB).touchProfile(7, "=cmd|'/c calc'!A1", "+evil", "");
  const s = await login(e);
  const text = await (await call(e, s, "/api/export/subscribers.csv")).text();
  assert.ok(text.includes("'=cmd") && text.includes("'+evil"));
  assert.equal(csvSafe("-1"), "'-1");
});

// --- dashboard API parity ---

test("content lifecycle, calendar, captions, settings and audit", async () => {
  const e = env();
  const s = await login(e);
  const quiz = await (await call(e, s, "/api/content", { method: "POST", body: { kind: "quiz", target: "public", text: "Guess?", options: ["a", "b"], correct_option: 1 } })).json();
  assert.equal(quiz.status, "draft");
  assert.deepEqual(quiz.options, ["a", "b"]);
  const bad = await call(e, s, "/api/content", { method: "POST", body: { kind: "poll", target: "public", text: "Q", options: ["x"] } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /2 to 10/);
  assert.equal((await (await call(e, s, `/api/content/${quiz.id}`, { method: "PUT", body: { text: "Again?" } })).json()).text, "Again?");
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await (await call(e, s, `/api/content/${quiz.id}/schedule`, { method: "POST", body: { scheduled_at: now + 3600 } })).json()).status, "scheduled");
  const copy = await (await call(e, s, `/api/content/${quiz.id}/duplicate`, { method: "POST" })).json();
  assert.equal(copy.status, "draft");
  assert.equal((await (await call(e, s, `/api/content/${quiz.id}/cancel`, { method: "POST" })).json()).status, "cancelled");
  assert.equal((await call(e, s, `/api/content/${quiz.id}`, { method: "DELETE" })).status, 200);
  const cal = await (await call(e, s, `/api/calendar?start=${now - 86400}&end=${now + 6 * 86400}`)).json();
  assert.equal(cal.poster_slots.length, 14);
  assert.equal((await call(e, s, `/api/calendar?start=${now}&end=${now + 100 * 86400}`)).status, 400);
  const cap = await (await call(e, s, "/api/captions", { method: "POST", body: { text: "Good night ✨" } })).json();
  await call(e, s, `/api/captions/${cap.id}`, { method: "PUT", body: { active: false } });
  assert.equal((await (await call(e, s, "/api/captions")).json())[0].active, 0);
  const st = await (await call(e, s, "/api/settings")).json();
  assert.ok(Object.values(st.features).every((f) => !f.enabled), "all features start OFF");
  assert.equal((await call(e, s, "/api/settings/join-policy/vip", { method: "PUT", body: { policy: "approve_all" } })).status, 400);
  assert.ok((await (await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } })).json()).enabled);
  const audit = (await (await call(e, s, "/api/audit")).json()).map((a) => a.action);
  assert.ok(audit.includes("feature") && audit.includes("content_create"));
  const o = await (await call(e, s, "/api/overview")).json();
  assert.deepEqual(o.poster_slots_ist, ["10:00 PM IST", "5:00 AM IST"]);
  assert.equal(o.automation, "simulated");
});

test("subscribers, join requests, actions and moderation", async () => {
  const e = env();
  const ops = new Ops(e.DB);
  await ops.touchProfile(7, "fan", "Fan", "promo_1");
  const jr = await e.DB.prepare("INSERT INTO join_requests (chat_id, user_id, username, first_name, requested_at) VALUES (?, ?, ?, ?, ?)").bind(-100, 9, "newbie", "New", 1).run();
  const s = await login(e);
  assert.equal((await (await call(e, s, "/api/subscribers?q=fan")).json())[0].user_id, 7);
  assert.equal((await (await call(e, s, "/api/subscribers/7", { method: "PUT", body: { tags: "vip, loyal ,vip", notes: "top" } })).json()).tags, "loyal,vip");
  assert.equal((await (await call(e, s, "/api/join-requests")).json())[0].user_id, 9);
  assert.equal((await (await call(e, s, "/api/actions", { method: "POST", body: { kind: "approve_join", payload: { request_id: jr.meta.last_row_id } } })).json()).status, "queued");
  assert.equal((await call(e, s, "/api/actions", { method: "POST", body: { kind: "send_dm", payload: { user_id: 7 } } })).status, 400);
  assert.equal((await call(e, s, "/api/moderation/rules", { method: "POST", body: { kind: "regex", pattern: ".*", action: "delete" } })).status, 400);
  assert.equal((await (await call(e, s, "/api/moderation/rules", { method: "POST", body: { kind: "word", pattern: "Spam", action: "delete" } })).json()).pattern, "spam");
});

test("validation matches the Python rules", () => {
  for (const [data, msg] of [
    [{ kind: "text", target: "public" }, /Write the message/],
    [{ kind: "photo", target: "public", media_url: "http://insecure" }, /https:\/\//],
    [{ kind: "quiz", target: "public", text: "Q?", options: ["a", "b"], correct_option: 5 }, /correct answer/],
    [{ kind: "paid_media", target: "vip", media_url: "https://x/a.jpg", star_count: 0 }, /1 to 10,000/],
    [{ kind: "text", target: "public", text: "hi", button_text: "Go", button_url: "javascript:alert(1)" }, /https:\/\/ or t.me/],
  ]) assert.throws(() => validateContent(data), msg);
});

// --- automation ---

async function scheduleAll(e, s, posts, at) {
  const ids = [];
  for (const p of posts) {
    const r = await call(e, s, "/api/content", { method: "POST", body: { ...p, schedule: true, scheduled_at: at } });
    assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
    ids.push((await r.json()).id);
  }
  return ids;
}
const POSTS = [
  { kind: "text", target: "public", text: "Good morning ☀️" },
  { kind: "photo", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", text: "cap" },
  { kind: "video", target: "vip", media_url: "https://res.cloudinary.com/demo/video/upload/dog.mp4" },
  { kind: "animation", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/kitten.gif" },
  { kind: "poll", target: "public", text: "Which look?", options: ["Red", "Black"], close_after_minutes: 60 },
  { kind: "quiz", target: "public", text: "City?", options: ["Mumbai", "Goa"], correct_option: 1, explanation: "Goa!" },
  { kind: "promo", target: "public", text: "💎 VIP trial: 3 days for 49 ⭐" },
  { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/demo/video/upload/dog.mp4", star_count: 25 },
];

test("staging without a bot token simulates everything and calls Telegram never", async () => {
  const e = env();
  const s = await login(e);
  const now = Math.floor(Date.now() / 1000);
  await scheduleAll(e, s, POSTS, now - 5);
  await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } });
  await call(e, s, "/api/settings/features/poll_auto_close", { method: "PUT", body: { enabled: true } });
  let fetches = 0;
  const r = await runScheduled(e, now, async () => { fetches++; throw new Error("must not be called"); });
  assert.equal(r.mode, "simulated");
  assert.equal(r.summary.posts.simulated, POSTS.length);
  assert.equal(fetches, 0);
  const statuses = (await (await call(e, s, "/api/content")).json()).map((i) => i.status);
  assert.ok(statuses.every((x) => x === "simulated"));
  await runScheduled(e, now + 3600, async () => { throw new Error("no"); });
  const polls = (await (await call(e, s, "/api/analytics?days=30")).json()).polls;
  assert.equal(polls.length, 1);
  assert.equal(polls[0].simulated, true);
});

test("preview mode sends every post type only to the preview chat, with the right methods", async () => {
  const e = env({ BOT_TOKEN: "123:TEST", PREVIEW_CHAT_ID: "424242" });
  const s = await login(e);
  const now = Math.floor(Date.now() / 1000);
  await scheduleAll(e, s, POSTS, now - 5);
  await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } });
  await call(e, s, "/api/actions", { method: "POST", body: { kind: "send_dm", payload: { user_id: 7, text: "hi" } } });
  await call(e, s, "/api/settings/features/admin_actions", { method: "PUT", body: { enabled: true } });
  const sent = [];
  const fake = async (url, init) => {
    const method = url.split("/").pop();
    const params = JSON.parse(init.body);
    sent.push({ method, params });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1000 + sent.length } }));
  };
  const r = await runScheduled(e, now, fake);
  assert.equal(r.mode, "preview");
  assert.equal(r.summary.posts.posted, POSTS.length);
  assert.deepEqual(new Set(sent.map((x) => String(x.params.chat_id))), new Set(["424242"]));
  assert.deepEqual(sent.map((x) => x.method), ["sendMessage", "sendPhoto", "sendVideo", "sendAnimation", "sendPoll", "sendPoll", "sendMessage", "sendPaidMedia"]);
  assert.equal(sent[5].params.type, "quiz");
  assert.equal(sent[7].params.media[0].type, "video");
  assert.equal(sent[7].params.star_count, 25);
  assert.match(sent[6].params.reply_markup.inline_keyboard[0][0].url, /^https:\/\/t\.me\/ShakhiraVIPBot\?start=promo_/);
  // No member contacted: the queued DM stays queued in staging.
  assert.equal((await (await call(e, s, "/api/actions")).json())[0].status, "queued");
  // Never sent twice.
  await runScheduled(e, now + 60, fake);
  assert.equal(sent.length, POSTS.length);
});

test("a token without PREVIEW_CHAT_ID is locked: nothing is sent", async () => {
  const e = env({ BOT_TOKEN: "123:TEST" });
  const s = await login(e);
  await scheduleAll(e, s, [POSTS[0]], 1);
  await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } });
  const r = await runScheduled(e, 100, async () => { throw new Error("must not send"); });
  assert.equal(r.mode, "locked");
  assert.equal((await (await call(e, s, "/api/content")).json())[0].status, "scheduled");
});

test("the client can never call update-taking methods, and staging refuses other chats", async () => {
  const tg = new SendOnlyTelegram({ token: "1:T", previewChatId: "5", requirePreview: true, fetchImpl: async () => { throw new Error("x"); } });
  // The allowlist holds even with the staging lock off (production-style client).
  const prod = new SendOnlyTelegram({ token: "1:T", requirePreview: false, fetchImpl: async () => { throw new Error("must not be reached"); } });
  for (const m of ["getUpdates", "setWebhook", "deleteWebhook", "logOut", "close", "getWebhookInfo"])
    await assert.rejects(prod.call(m, {}), /is not allowed for this Worker/);
  await assert.rejects(tg.call("sendMessage", { chat_id: "@yourshakhira", text: "x" }), /preview chat/);
  await assert.rejects(tg.call("banChatMember", { chat_id: -100, user_id: 1 }), /not allowed in staging/);
});

test("refused and uncertain sends are recorded, rate limits retried", async () => {
  const e = env({ BOT_TOKEN: "123:TEST", PREVIEW_CHAT_ID: "1" });
  const s = await login(e);
  const [a, b, c] = await scheduleAll(e, s, [POSTS[0], POSTS[1], POSTS[2]], 1);
  await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } });
  const replies = [
    () => new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: wrong file" }), { status: 400 }),
    () => { throw new TypeError("network down"); },
    () => new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 30 } }), { status: 429 }),
  ];
  let n = 0;
  await runScheduled(e, 100, async () => replies[n++]());
  const items = Object.fromEntries((await (await call(e, s, "/api/content")).json()).map((i) => [i.id, i]));
  assert.equal(items[a].status, "failed");
  assert.equal(items[b].status, "uncertain");
  assert.equal(items[c].status, "scheduled");
  assert.equal(items[c].scheduled_at, 130);
});

test("data persists across Worker instances (separate connections to the same database file)", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "d1-")), "staging.sqlite");
  const first = env({ DB: makeD1(file) });
  const s = await login(first);
  await call(first, s, "/api/content", { method: "POST", body: { kind: "text", target: "public", text: "persist me" } });
  first.DB.close();
  const second = env({ DB: makeD1(file) });
  const s2 = await login(second);
  assert.equal((await (await call(second, s2, "/api/content")).json())[0].text, "persist me");
});

test("unknown API paths are 404 and handleApi works directly", async () => {
  const e = env();
  assert.equal((await handleApi(req("/api/nope"), e)).status, 404);
});
