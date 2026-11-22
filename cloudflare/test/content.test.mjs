// Content management: one-click publish now / schedule, recurring series without duplicates,
// protected content, private previews, automation pause switches and the Cloudinary media library.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import { signParams, uploadSignature } from "../src/cloudinary.js";
import worker, { runScheduled, SECURITY_HEADERS } from "../src/index.js";
import { Ops } from "../src/ops.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const KEY = Buffer.alloc(32, 3).toString("base64");
const ORIGIN = "https://shakhira-admin.example.workers.dev";
const TOKEN = "1111111111:AAprimaryprimaryprimaryprimaryprim1";
const sent = [], cloud = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith("https://api.cloudinary.com/")) {
    cloud.push({ url, method: init.method || "GET" });
    if ((init.method || "GET") === "DELETE") { const id = decodeURIComponent(url.split("public_ids[]=")[1]); return new Response(JSON.stringify({ deleted: { [id]: "deleted" } })); }
    if (url.includes("/resources/image?max_results=1")) return new Response("{}");
    return new Response(JSON.stringify({ resources: [{ public_id: "shakhira_admin/a1", asset_folder: "shakhira_admin", resource_type: "image", format: "jpg", bytes: 10,
      secure_url: "https://res.cloudinary.com/x/image/upload/v1/shakhira_admin/a1.jpg", created_at: "2026-11-21T00:00:00Z" }] }));
  }
  const m = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
  if (!m) return realFetch(url, init);
  const params = JSON.parse(init.body || "{}");
  sent.push({ method: m[2], params });
  if (m[2] === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1111111111, is_bot: true, username: "ShakhiraVIPBot", first_name: "VIP" } }));
  if (m[2] === "getWebhookInfo") return new Response(JSON.stringify({ ok: true, result: { url: "" } }));
  return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + sent.length } }));
};

const env = (o = {}) => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), CREDENTIALS_KEY: KEY, ENVIRONMENT: "production",
  REQUIRE_PREVIEW: "true", PREVIEW_CHAT_ID: "", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-100777", BOT_USERNAME: "ShakhiraVIPBot",
  CLOUDINARY_CLOUD_NAME: "shakhira", CLOUDINARY_API_KEY: "123456789", CLOUDINARY_API_SECRET: "cloud-secret-123", ...o });
async function login(e) {
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "5.5.5.5" } }), e);
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}
const call = async (e, s, path, method = "GET", body) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), "cf-connecting-ip": "5.5.5.5" } }), e);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
};
const on = async (e, ...names) => { for (const n of names) await new Ops(e.DB).setSetting("feature:" + n, "1"); };

test("Cloudinary signatures match Cloudinary's documented example; the secret never leaves the server", async () => {
  // https://cloudinary.com/documentation/authentication_signatures example.
  assert.equal(await signParams({ eager: "w_400,h_300,c_pad|w_260,h_200,c_crop", public_id: "sample_image", timestamp: 1315060510 }, "abcd"),
    "bfd09f95f331f558cbd1320e67aa8d488770583e");
  const u = await uploadSignature({ cloud: "shakhira", key: "123", secret: "cloud-secret-123" }, "shakhira_admin", 1000);
  assert.equal(u.upload_url, "https://api.cloudinary.com/v1_1/shakhira/auto/upload");
  assert.equal(JSON.stringify(u).includes("cloud-secret-123"), false);
  // The browser talks only to the dashboard itself (media lives in private R2).
  assert.match(SECURITY_HEADERS["Content-Security-Policy"], /connect-src 'self';/);
  assert.doesNotMatch(SECURITY_HEADERS["Content-Security-Policy"], /cloudinary/);
});

// The Cloudinary media-library test was replaced by test/r2media.test.mjs (private R2 library).

test("protected content is passed to every kind of send", async () => {
  const e = env({ BOT_TOKEN: TOKEN, REQUIRE_PREVIEW: "false" }), s = await login(e);
  await on(e, "scheduled_posts");
  const now = Math.floor(Date.now() / 1000);
  for (const p of [{ kind: "text", text: "t" }, { kind: "photo", media_url: "https://res.cloudinary.com/x/p.jpg" }, { kind: "video", media_url: "https://res.cloudinary.com/x/v.mp4" },
    { kind: "animation", media_url: "https://res.cloudinary.com/x/g.gif" }, { kind: "poll", text: "q?", options: ["a", "b"] }, { kind: "paid_media", media_url: "https://res.cloudinary.com/x/p.jpg", star_count: 50 }]) {
    const c = (await call(e, s, "/api/content", "POST", { target: "vip", protect_content: true, ...p })).body;
    assert.equal((await call(e, s, `/api/content/${c.id}/publish`, "POST", {})).status, 200);
  }
  sent.length = 0;
  await runScheduled(e, now + 5);
  const sends = sent.filter((x) => x.method.startsWith("send"));
  assert.deepEqual(sends.map((x) => x.method).sort(), ["sendAnimation", "sendMessage", "sendPaidMedia", "sendPhoto", "sendPoll", "sendVideo"]);
  assert.ok(sends.every((x) => x.params.protect_content === true));
  assert.equal(sends.find((x) => x.method === "sendPaidMedia").params.star_count, 50);
});

test("publish now and schedule work with one click for signed-in admins, and are audited", async () => {
  const live = env({ BOT_TOKEN: TOKEN, REQUIRE_PREVIEW: "false" }), s = await login(live);
  const c = (await call(live, s, "/api/content", "POST", { kind: "text", target: "public", text: "hello" })).body;
  assert.equal((await call(live, null, `/api/content/${c.id}/publish`, "POST", {})).status, 401, "still needs sign-in");
  assert.equal((await call(live, s, `/api/content/${c.id}/publish`, "POST", {})).body.status, "scheduled");
  assert.ok((await new Ops(live.DB).all("SELECT * FROM audit_log WHERE action='publish_now'")).length === 1);
  // Pressing Publish now twice still sends once (the scheduler claims each post before sending).
  await call(live, s, `/api/content/${c.id}/publish`, "POST", {});
  await on(live, "scheduled_posts");
  sent.length = 0;
  await runScheduled(live, Math.floor(Date.now() / 1000) + 5);
  await runScheduled(live, Math.floor(Date.now() / 1000) + 65);
  assert.equal(sent.filter((x) => x.method === "sendMessage").length, 1);
  assert.equal((await call(live, s, `/api/content/${c.id}/publish`, "POST", {})).status, 400, "a posted post can't be published again");
  const sim = env(), s2 = await login(sim);
  const c2 = (await call(sim, s2, "/api/content", "POST", { kind: "text", target: "public", text: "hello" })).body;
  assert.equal((await call(sim, s2, `/api/content/${c2.id}/publish`, "POST", {})).status, 200, "simulated: nothing real is sent");
});

test("recurring posts: one next occurrence per send, never duplicated, stop at the count, stop series", async () => {
  const e = env(), s = await login(e);
  await on(e, "scheduled_posts");
  const t0 = 1_900_000_000;
  const c = (await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "daily", hashtags: "#d", repeat: { every: "daily", count: 3 }, schedule: true, scheduled_at: t0 })).body;
  assert.equal(JSON.parse(c.repeat_json).every, "daily");
  await runScheduled(e, t0 + 10);
  await runScheduled(e, t0 + 70); // a second run must not create another copy
  const ops = new Ops(e.DB);
  let rows = await ops.all("SELECT id, status, scheduled_at, text FROM content_items ORDER BY id");
  assert.deepEqual(rows.map((r) => [r.status, r.scheduled_at - t0]), [["simulated", 0], ["scheduled", 86400]]);
  assert.equal(rows[1].text, "daily", "hashtags are not repeated into the next occurrence's text");
  // Re-running the creation for the same occurrence is refused by the unique key.
  assert.equal(await ops.scheduleNextOccurrence(await ops.content(c.id), t0 + 10), null);
  await runScheduled(e, t0 + 86400 + 5);
  await runScheduled(e, t0 + 2 * 86400 + 5);
  rows = await ops.all("SELECT status FROM content_items ORDER BY id");
  assert.deepEqual(rows.map((r) => r.status), ["simulated", "simulated", "simulated"], "count: 3 posts, then the series ends");
  const w = (await call(e, s, "/api/content", "POST", { kind: "text", target: "vip", text: "weekly", repeat: { every: "weekly" }, schedule: true, scheduled_at: t0 })).body;
  await runScheduled(e, t0 + 30);
  const stop = await call(e, s, `/api/content/${w.id}/stop-series`, "POST");
  assert.equal(stop.body.cancelled, 1);
  assert.equal((await ops.one("SELECT COUNT(*) AS n FROM content_items WHERE status='scheduled'")).n, 0);
  assert.equal((await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "x", repeat: { every: "hourly" } })).status, 400);
});

test("private preview: needs a preview chat set with a fresh password, goes only there, nothing marked posted", async () => {
  const e = env({ BOT_TOKEN: TOKEN }), s = await login(e);
  const c = (await call(e, s, "/api/content", "POST", { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/x/p.jpg", star_count: 1, protect_content: true })).body;
  assert.match((await call(e, s, `/api/content/${c.id}/preview`, "POST")).body.error, /preview chat/);
  assert.equal((await call(e, s, "/api/automation/preview-chat", "PUT", { preview_chat_id: "555000111" })).status, 400, "fresh password needed");
  assert.equal((await call(e, s, "/api/automation/preview-chat", "PUT", { preview_chat_id: "@me", password: PASSWORD })).status, 400);
  assert.equal((await call(e, s, "/api/automation/preview-chat", "PUT", { preview_chat_id: "555000111", password: PASSWORD })).status, 200);
  sent.length = 0;
  const p = await call(e, s, `/api/content/${c.id}/preview`, "POST");
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.deepEqual(sent.map((x) => [x.method, x.params.chat_id, x.params.protect_content]), [["sendPaidMedia", "555000111", true]]);
  assert.equal((await call(e, s, `/api/content/${c.id}/preview`, "POST")).status, 400, "rate limited");
  assert.equal((await new Ops(e.DB).content(c.id)).status, "draft");
  // With the lock on, the saved preview chat turns locked mode into preview mode: scheduled posts go only to it.
  assert.equal((await call(e, s, "/api/automation")).body.mode, "preview");
  await on(e, "scheduled_posts");
  await call(e, s, `/api/content/${c.id}/publish`, "POST");
  sent.length = 0;
  await runScheduled(e, Math.floor(Date.now() / 1000) + 5);
  assert.deepEqual(sent.filter((x) => x.method.startsWith("send")).map((x) => x.params.chat_id), ["555000111"]);
});

test("pause switches: master pause stops all sends; the poster flag is public and read-only", async () => {
  const e = env(), s = await login(e);
  await on(e, "scheduled_posts");
  const c = (await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "p", schedule: true, scheduled_at: 100 })).body;
  await call(e, s, "/api/automation", "PUT", { automation_paused: true, poster_paused: true });
  assert.equal((await runScheduled(e, 200)).summary.paused, true);
  assert.equal((await new Ops(e.DB).content(c.id)).status, "scheduled");
  assert.deepEqual((await call(e, null, "/api/public/automation")).body, { poster_paused: true });
  assert.equal((await call(e, null, "/api/public/automation", "PUT", { poster_paused: false })).status, 404);
  await call(e, s, "/api/automation", "PUT", { automation_paused: false, poster_paused: false });
  await runScheduled(e, 300);
  assert.equal((await new Ops(e.DB).content(c.id)).status, "simulated");
  assert.deepEqual((await call(e, null, "/api/public/automation")).body, { poster_paused: false });
  const actions = (await new Ops(e.DB).all("SELECT action FROM audit_log WHERE action LIKE '%pause' OR action LIKE '%resume'")).map((a) => a.action);
  assert.deepEqual(actions, ["automation_pause", "poster_pause", "automation_resume", "poster_resume"]);
});

test("formatting and buttons: only Telegram-supported HTML, up to 6 link buttons, passed to Telegram", async () => {
  const e = env({ BOT_TOKEN: TOKEN, REQUIRE_PREVIEW: "false" }), s = await login(e);
  const bad = await call(e, s, "/api/content", "POST", { kind: "text", target: "public", parse_mode: "HTML", text: "<script>x</script>" });
  assert.match(bad.body.error, /not supported/);
  assert.match((await call(e, s, "/api/content", "POST", { kind: "text", target: "public", parse_mode: "HTML", text: '<a href="javascript:x">x</a>' })).body.error, /not supported/);
  assert.match((await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "x", buttons: [{ text: "A", url: "http://insecure" }] })).body.error, /https/);
  assert.equal((await call(e, s, "/api/content", "POST", { kind: "poll", target: "public", text: "q?", options: ["a", "b"], buttons: [{ text: "A", url: "https://a.b" }] })).status, 400);
  assert.equal((await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "x", buttons: Array.from({ length: 7 }, () => ({ text: "A", url: "https://a.b" })) })).status, 400);
  const text = '<b>New</b> drop 🔥 <a href="https://t.me/ShakhiraVIPBot">Join VIP</a>';
  const c = (await call(e, s, "/api/content", "POST", { kind: "photo", target: "public", media_url: "https://res.cloudinary.com/x/p.jpg", parse_mode: "HTML", text,
    hashtags: "#vip", buttons: [{ text: "💎 Join VIP", url: "https://t.me/ShakhiraVIPBot?start=x" }, { text: "Instagram", url: "https://instagram.com/x" }] })).body;
  await on(e, "scheduled_posts");
  await call(e, s, `/api/content/${c.id}/publish`, "POST", {});
  sent.length = 0;
  await runScheduled(e, Math.floor(Date.now() / 1000) + 5);
  const p = sent.find((x) => x.method === "sendPhoto").params;
  assert.equal(p.parse_mode, "HTML");
  assert.equal(p.caption, `${text}\n\n#vip`);
  assert.deepEqual(p.reply_markup.inline_keyboard.map((r) => r[0].text), ["💎 Join VIP", "Instagram"]);
});

test("Bot & channels shows each channel's reaction settings from Telegram (read-only, no counts invented)", async () => {
  const e = env({ BOT_TOKEN: TOKEN }), s = await login(e);
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const m = String(url).split("/").pop();
    if (m === "getChat") return new Response(JSON.stringify({ ok: true, result: JSON.parse(init.body).chat_id === "-100777"
      ? { title: "VIP", type: "channel", available_reactions: [{ type: "emoji", emoji: "🔥" }, { type: "emoji", emoji: "❤" }] } : { title: "Public", type: "channel" } }));
    if (m === "getChatMemberCount") return new Response(JSON.stringify({ ok: true, result: 10 }));
    return orig(url, init);
  };
  try {
    const t = (await call(e, s, "/api/telegram")).body;
    assert.deepEqual(t.channels.vip.reactions, ["🔥", "❤"]);
    assert.equal(t.channels.public.reactions, "all");
  } finally { globalThis.fetch = orig; }
});

test("live mode: a post type the bot isn't permitted to send can't be queued (paid media stays off)", async () => {
  const e = env({ REQUIRE_PREVIEW: "false" }), s = await login(e);
  const bot = (await call(e, s, "/api/bots", "POST", { token: TOKEN, password: PASSWORD })).body;
  await call(e, s, `/api/bots/${bot.id}/permissions`, "PUT", { permissions: { posts: true, polls: true, promos: true, paid_media: false } });
  const paid = (await call(e, s, "/api/content", "POST", { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/x/p.jpg", star_count: 5 })).body;
  const r = await call(e, s, `/api/content/${paid.id}/publish`, "POST", {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not permitted to publish paid media/);
  assert.equal((await call(e, s, `/api/content/${paid.id}/schedule`, "POST", { scheduled_at: 2_000_000_000 })).status, 400);
  const txt = (await call(e, s, "/api/content", "POST", { kind: "text", target: "public", text: "ok" })).body;
  assert.equal((await call(e, s, `/api/content/${txt.id}/publish`, "POST", {})).status, 200);
});
