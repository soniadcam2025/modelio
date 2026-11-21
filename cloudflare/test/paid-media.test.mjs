import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import worker, { runScheduled } from "../src/index.js";
import { Ops, validateContent } from "../src/ops.js";
import { dueSlots, queueAutoPaidMedia } from "../src/scheduler.js";
import { posterInventory } from "../src/cloudinary.js";
import { SendOnlyTelegram } from "../src/telegram.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin-staging.example.workers.dev";
const env = (o = {}) => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "staging",
  REQUIRE_PREVIEW: "true", PREVIEW_CHAT_ID: "", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-1001234567890", POST_SLOTS_UTC: "16:30,23:30", ...o });
const req = (path, { method = "GET", body, cookie, csrf } = {}) => new Request(ORIGIN + path, { method,
  body: body === undefined ? undefined : JSON.stringify(body),
  headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-csrf-token": csrf } : {}) } });
async function login(e) {
  const r = await worker.fetch(req("/api/login", { method: "POST", body: { password: PASSWORD } }), e);
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}
const call = (e, s, path, o = {}) => worker.fetch(req(path, { ...o, cookie: s.cookie, csrf: s.csrf }), e);
const at = (iso) => Math.floor(Date.parse(iso) / 1000);

function asset(id, { fmt = "jpg", type = "image", bytes = 200000, created = "2026-11-01T00:00:00Z", tags = [], stars = null, caption = "" } = {}) {
  return { public_id: `vip_drops/${id}`, resource_type: type, type: "upload", format: fmt, bytes, created_at: created, tags,
    secure_url: `https://res.cloudinary.com/demo/${type}/upload/vip_drops/${id}.${fmt}`, stars, caption, asset_folder: "vip_drops" };
}

// --- expiry ---

test("expiry must be 5 minutes to 48 hours (Telegram's delete window)", () => {
  assert.throws(() => validateContent({ kind: "text", target: "public", text: "x", expire_after_minutes: 2881 }), /48 hours/);
  assert.throws(() => validateContent({ kind: "text", target: "public", text: "x", expire_after_minutes: 1 }), /5 minutes/);
  assert.equal(validateContent({ kind: "text", target: "public", text: "x", expire_after_minutes: 2880 }).expire_after_minutes, 2880);
});

test("preview: an expiring paid-media post is deleted on time, only in the preview chat", async () => {
  const e = env({ BOT_TOKEN: "1:T", PREVIEW_CHAT_ID: "777" });
  const s = await login(e);
  const post = await (await call(e, s, "/api/content", { method: "POST", body: { kind: "paid_media", target: "vip",
    media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", star_count: 75, expire_after_minutes: 60, schedule: true, scheduled_at: 1000 } })).json();
  for (const f of ["scheduled_posts", "post_expiry"]) await call(e, s, `/api/settings/features/${f}`, { method: "PUT", body: { enabled: true } });
  const sent = [];
  const fake = async (url, init) => { sent.push({ method: url.split("/").pop(), params: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } })); };
  await runScheduled(e, 1000, fake);
  assert.deepEqual(sent.map((x) => [x.method, x.params.chat_id, x.params.star_count]), [["sendPaidMedia", "777", 75]]);
  await runScheduled(e, 1000 + 59 * 60, fake);
  assert.equal(sent.length, 1, "not deleted early");
  await runScheduled(e, 1000 + 60 * 60, fake);
  assert.deepEqual(sent[1], { method: "deleteMessage", params: { chat_id: "777", message_id: 555 } });
  const item = (await (await call(e, s, "/api/content")).json()).find((i) => i.id === post.id);
  assert.equal(item.expired_at, 1000 + 3600);
  await runScheduled(e, 1000 + 2 * 3600, fake);
  assert.equal(sent.length, 2, "deleted once only");
});

test("expiry is skipped while its feature is off, and simulated posts expire without any Telegram call", async () => {
  const e = env();
  const s = await login(e);
  await call(e, s, "/api/content", { method: "POST", body: { kind: "text", target: "public", text: "bye", expire_after_minutes: 5, schedule: true, scheduled_at: 1 } });
  await call(e, s, "/api/settings/features/scheduled_posts", { method: "PUT", body: { enabled: true } });
  await runScheduled(e, 10, async () => { throw new Error("no network"); });
  await runScheduled(e, 10 + 600, async () => { throw new Error("no network"); });
  assert.equal((await (await call(e, s, "/api/content")).json())[0].expired_at, null);
  await call(e, s, "/api/settings/features/post_expiry", { method: "PUT", body: { enabled: true } });
  await runScheduled(e, 10 + 660, async () => { throw new Error("no network"); });
  assert.equal((await (await call(e, s, "/api/content")).json())[0].expired_at, 670);
});

test("staging lock: deleteMessage outside the preview chat is refused", async () => {
  const tg = new SendOnlyTelegram({ token: "1:T", previewChatId: "777", requirePreview: true, fetchImpl: async () => { throw new Error("x"); } });
  await assert.rejects(tg.call("deleteMessage", { chat_id: "@yourshakhira", message_id: 1 }), /preview chat/);
});

// --- paid media automation ---

test("paid-media settings validate price, folder, times and expiry", async () => {
  const e = env();
  const s = await login(e);
  const put = (b) => call(e, s, "/api/settings/paid-media", { method: "PUT", body: { default_stars: 50, target: "vip", times_utc: [], ...b } });
  assert.match((await (await put({ default_stars: 0 })).json()).error, /1 to 10,000/);
  assert.match((await (await put({ folder: "tgpub" })).json()).error, /separate folder/);
  assert.match((await (await put({ times_utc: "25:00" })).json()).error, /14:30/);
  assert.match((await (await put({ expire_after_minutes: 5000 })).json()).error, /48 hours/);
  const ok = await (await put({ default_stars: 99, folder: "vip_drops/", times_utc: "18:30, 08:00", expire_after_minutes: 1440 })).json();
  assert.deepEqual(ok, { default_stars: 99, folder: "vip_drops", times_utc: ["08:00", "18:30"], target: "vip", expire_after_minutes: 1440, caption: "" });
  assert.deepEqual(await (await call(e, s, "/api/settings/paid-media")).json(), ok);
  const settings = await (await call(e, s, "/api/settings")).json();
  assert.equal(settings.features.auto_paid_media.enabled, false, "automation stays off until switched on");
});

test("due slots are found only within 30 minutes after their time", () => {
  assert.deepEqual(dueSlots(["08:00"], at("2026-11-21T08:10:00Z")).map((x) => x.slot), ["20261121T0800Z"]);
  assert.deepEqual(dueSlots(["08:00"], at("2026-11-21T08:31:00Z")), []);
  assert.deepEqual(dueSlots(["23:50"], at("2026-11-22T00:05:00Z")).map((x) => x.slot), ["20261121T2350Z"]);
});

test("automation queues one paid post per slot, oldest unused asset first, with per-asset price override", async () => {
  const e = env();
  const ops = new Ops(e.DB, () => at("2026-11-21T08:05:00Z"));
  await ops.setPaidMediaConfig({ default_stars: 50, folder: "vip_drops", times_utc: ["08:00"], target: "vip", expire_after_minutes: 120, caption: "VIP drop" }, "admin");
  const assets = [
    asset("newest", { created: "2026-11-10T00:00:00Z" }),
    asset("oldest", { created: "2026-11-01T00:00:00Z", stars: 120, caption: "Exclusive set" }),
    asset("huge", { created: "2026-10-01T00:00:00Z", bytes: 9 * 1024 * 1024 }),     // photo over 5 MB: skipped
    asset("doc", { created: "2026-09-01T00:00:00Z", fmt: "pdf" }),                    // unsupported: skipped
  ];
  let listed = 0;
  const lister = async (folder) => { listed++; assert.equal(folder, "vip_drops"); return assets; };
  const first = await queueAutoPaidMedia(ops, at("2026-11-21T08:05:00Z"), lister);
  assert.equal(first.length, 1);
  const item = await ops.content(first[0]);
  assert.deepEqual([item.kind, item.target, item.star_count, item.text, item.expire_after_minutes, item.status, item.source],
    ["paid_media", "vip", 120, "Exclusive set", 120, "scheduled", "auto:vip_drops/oldest"]);
  // Same slot again (next cron minute): nothing new, the listing is not even fetched.
  assert.deepEqual(await queueAutoPaidMedia(ops, at("2026-11-21T08:06:00Z"), lister), []);
  assert.equal(listed, 1);
  // Next day's slot: the next unused asset, at the default price and caption.
  const next = await queueAutoPaidMedia(ops, at("2026-11-22T08:01:00Z"), lister);
  const item2 = await ops.content(next[0]);
  assert.deepEqual([item2.star_count, item2.text, item2.source], [50, "VIP drop", "auto:vip_drops/newest"]);
  // Nothing left: the slot is recorded with a note, no post is created.
  assert.deepEqual(await queueAutoPaidMedia(ops, at("2026-11-23T08:01:00Z"), lister), []);
  const run = await ops.one("SELECT note FROM auto_paid_runs WHERE slot = '20261123T0800Z'");
  assert.match(run.note, /no unused media/);
});

test("end to end in simulation: automation off by default, then queued and simulated, never touching Cloudinary tags", async () => {
  const e = env({ CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" });
  const s = await login(e);
  await call(e, s, "/api/settings/paid-media", { method: "PUT", body: { default_stars: 30, folder: "vip_drops", times_utc: ["08:00"], target: "vip" } });
  const calls = [];
  const fake = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).includes("api.cloudinary.com")) return new Response(JSON.stringify({ resources: [asset("a1")] }));
    throw new Error("Telegram must not be called in simulation");
  };
  const t = at("2026-11-21T08:02:00Z");
  await runScheduled(e, t, fake);
  assert.equal(calls.length, 0, "nothing happens while auto_paid_media is off");
  for (const f of ["auto_paid_media", "scheduled_posts"]) await call(e, s, `/api/settings/features/${f}`, { method: "PUT", body: { enabled: true } });
  const r = await runScheduled(e, t + 60, fake);
  assert.equal(r.summary.auto_paid_queued, 1);
  assert.equal(r.summary.posts.simulated, 1);
  assert.ok(calls.every((c) => c.method === "GET" && c.url.includes("api.cloudinary.com/v1_1/demo/resources")), "Cloudinary is only read");
  const item = (await (await call(e, s, "/api/content")).json())[0];
  assert.deepEqual([item.kind, item.status, item.star_count], ["paid_media", "simulated", 30]);
});

// --- media library ---

test("media library reads the GitHub poster folder read-only and reports smart-rotation state", async () => {
  const now = at("2026-11-21T12:00:00Z");
  const inv = posterInventory([
    { resource_type: "image", type: "upload", format: "jpg", bytes: 1000, tags: [] },
    { resource_type: "image", type: "upload", format: "jpg", bytes: 1000, tags: ["tgbot_posted", `tgbot_at_${now - 40 * 86400}`] },
    { resource_type: "image", type: "upload", format: "jpg", bytes: 1000, tags: ["tgbot_posted", `tgbot_at_${now - 5 * 86400}`] },
    { resource_type: "image", type: "upload", format: "jpg", bytes: 1000, tags: ["tgbot_posted"] },
    { resource_type: "image", type: "upload", format: "jpg", bytes: 1000, tags: ["tgbot_uncertain"] },
    { resource_type: "image", type: "upload", format: "pdf", bytes: 1000, tags: [] },
  ], now);
  assert.deepEqual([inv.remaining, inv.posted, inv.reusable_now, inv.unknown_time, inv.uncertain, inv.unsupported], [1, 3, 1, 1, 1, 1]);
  assert.equal(inv.next_reuse_at, now - 5 * 86400 + 30 * 86400);

  const e = env({ CLOUDINARY_CLOUD_NAME: "demo", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" });
  const s = await login(e);
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init = {}) => { seen.push([init.method || "GET", String(url)]);
    return new Response(JSON.stringify({ resources: [{ public_id: "a", resource_type: "image", type: "upload", format: "jpg", bytes: 10, asset_folder: "tgpub", tags: ["tgbot_posted"], secure_url: "https://x/a.jpg" }] })); };
  try {
    const lib = await (await call(e, s, "/api/poster")).json();
    assert.equal(lib.configured, true);
    assert.equal(lib.inventory.posted, 1);
    assert.equal(lib.library[0].state, "posted");
    assert.ok(seen.every(([m, u]) => m === "GET" && u.includes("asset_folder=tgpub")));
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(await (await call(env(), await login(env()), "/api/poster")).json(), { configured: false });
});

test("/api/me advertises the new capabilities to the shared frontend", async () => {
  const e = env();
  const s = await login(e);
  const me = await (await call(e, s, "/api/me")).json();
  assert.deepEqual(me.capabilities, ["post_expiry", "paid_media_automation", "hashtags", "backup", "member_sync", "telegram_status", "bots", "content_v2"]);
  assert.equal(me.automation, "simulated");
});
