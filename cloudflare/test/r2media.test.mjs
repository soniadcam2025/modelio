// Private R2 media library: folders, upload checks, file delivery, move/rename/copy, safe delete,
// public/VIP/paid separation, Telegram uploads from R2, automatic posts, and the Cloudinary copy.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import worker, { runScheduled } from "../src/index.js";
import { Ops } from "../src/ops.js";
import { cleanFolder, cleanKey, DEFAULT_FOLDERS } from "../src/r2media.js";
import { queueR2AutoPosts, sendItem } from "../src/scheduler.js";
import { SendOnlyTelegram } from "../src/telegram.js";
import { makeD1 } from "./d1shim.mjs";
import { HEIC, JPEG, makeR2, MP4 } from "./r2shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin.example.workers.dev";
const env = (o = {}) => ({ DB: makeD1(), MEDIA: makeR2(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "production",
  REQUIRE_PREVIEW: "true", PUBLIC_CHANNEL: "@yourshakhira", VIP_CHANNEL_ID: "-100777", BOT_USERNAME: "ShakhiraVIPBot", ...o });
async function login(e) {
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "7.7.7.7" } }), e);
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}
const call = async (e, s, path, method = "GET", body, raw = false) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), "cf-connecting-ip": "7.7.7.7" } }), e);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, headers: r.headers, body: ct.includes("json") ? await r.json() : new Uint8Array(await r.arrayBuffer()) };
};
const up = (e, s, folder, name, bytes) => call(e, s, `/api/media/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`, "POST", bytes, true);

test("keys and folders: traversal and odd names are refused", () => {
  for (const bad of ["../x", "a/../b", "/abs", "a//b", "a/.folder", "x".repeat(101), "a/b\\c"]) assert.throws(() => cleanFolder(bad), bad);
  assert.throws(() => cleanKey("noFolder.jpg"));
  assert.throws(() => cleanKey("public/../vip/x.jpg"));
  assert.equal(cleanKey("public/photos/a b (1).jpg"), "public/photos/a b (1).jpg");
});

test("media library end to end (signed-in only)", async () => {
  const e = env(); const s = await login(e);
  assert.equal((await call(e, null, "/api/media/folders")).status, 401);
  assert.equal((await call(e, null, "/api/media/file?key=public/photos/a.jpg")).status, 401);
  const folders = (await call(e, s, "/api/media/folders")).body.map((f) => f.path);
  for (const f of DEFAULT_FOLDERS) assert.ok(folders.includes(f), f);

  // Uploads: checked by content, renamed to the real type, unique names
  assert.equal((await up(e, s, "public/photos", "x.jpg", HEIC())).status, 400);
  assert.equal((await up(e, s, "public/photos", "x.jpg", new Uint8Array(11 * 1024 * 1024).fill(0).map((_, i) => (i < 3 ? [0xff, 0xd8, 0xff][i] : 0)))).status, 400);
  const a = (await up(e, s, "public/photos", "Holiday pic.jpeg", JPEG())).body;
  assert.equal(a.key, "public/photos/Holiday pic.jpg");
  assert.equal((await up(e, s, "public/photos", "Holiday pic.jpg", JPEG())).body.key, "public/photos/Holiday pic-2.jpg");
  const v = (await up(e, s, "vip/videos", "clip.mp4", MP4())).body;
  assert.equal(v.kind, "video");

  // Delivery: inline, download, range; private caching
  const f = await call(e, s, "/api/media/file?key=" + encodeURIComponent(a.key));
  assert.equal(f.status, 200); assert.equal(f.headers.get("cache-control").includes("no-store"), true); assert.equal(f.body.byteLength, 2000);
  assert.match((await call(e, s, `/api/media/file?download=1&key=${encodeURIComponent(a.key)}`)).headers.get("content-disposition"), /^attachment/);
  const part = await worker.fetch(new Request(ORIGIN + "/api/media/file?key=" + encodeURIComponent(v.key), { headers: { cookie: s.cookie, range: "bytes=0-99", "cf-connecting-ip": "7.7.7.7" } }), e);
  assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 100);

  // List, search, filter
  assert.equal((await call(e, s, "/api/media/files?folder=public/photos")).body.length, 2);
  assert.equal((await call(e, s, "/api/media/files?recursive=1&kind=video")).body.length, 1);
  assert.equal((await call(e, s, "/api/media/files?recursive=1&q=holiday")).body.length, 2);

  // Folders: create, rename (custom only), delete only when empty; defaults protected
  assert.equal((await call(e, s, "/api/media/folders", "POST", { path: "campaigns/dec" })).status, 200);
  assert.equal((await call(e, s, "/api/media/folders/rename", "POST", { from: "vip", to: "vip2" })).status, 400);
  assert.equal((await call(e, s, "/api/media/folders/delete", "POST", { path: "public/photos" })).status, 400);
  await up(e, s, "campaigns/dec", "c.jpg", JPEG());
  assert.equal((await call(e, s, "/api/media/folders/delete", "POST", { path: "campaigns/dec" })).status, 400);
  assert.equal((await call(e, s, "/api/media/folders/rename", "POST", { from: "campaigns", to: "campaigns-2026" })).status, 200);
  assert.ok(e.MEDIA.store.has("campaigns-2026/dec/c.jpg") && !e.MEDIA.store.has("campaigns/dec/c.jpg"));

  // Move/rename and copy; a scheduled post follows a move
  const post = (await call(e, s, "/api/content", "POST", { kind: "photo", target: "public", media_url: "r2:" + a.key, text: "hi", schedule: true, scheduled_at: Math.floor(Date.now() / 1000) + 3600 })).body;
  assert.equal((await call(e, s, "/api/media/move", "POST", { from: a.key, to: "public/photos/renamed.jpg" })).status, 200);
  assert.equal((await new Ops(e.DB).content(post.id)).media_url, "r2:public/photos/renamed.jpg");
  assert.equal((await call(e, s, "/api/media/copy", "POST", { from: "public/photos/renamed.jpg", to: "archive/renamed.jpg" })).status, 200);

  // Delete: blocked while a scheduled post needs the file; multi-select; audit kept
  const del1 = (await call(e, s, "/api/media/delete", "POST", { keys: ["public/photos/renamed.jpg"] })).body.results[0];
  assert.equal(del1.ok, false); assert.match(del1.error, new RegExp(`#${post.id}`));
  await call(e, s, `/api/content/${post.id}/cancel`, "POST");
  const del = (await call(e, s, "/api/media/delete", "POST", { keys: ["public/photos/renamed.jpg", "archive/renamed.jpg", "../etc"] })).body.results;
  assert.deepEqual(del.map((r) => r.ok), [true, true, false]);
  assert.ok(!e.MEDIA.store.has("public/photos/renamed.jpg") && e.MEDIA.store.has("public/photos/Holiday pic-2.jpg"));
  const audit = await new Ops(e.DB).auditEntries();
  assert.ok(audit.some((x) => x.action === "media_delete" && x.detail.startsWith("archive/renamed.jpg")));

  // Usage
  const st = (await call(e, s, "/api/media/status")).body;
  assert.equal(st.connected, true); assert.equal(st.usage.files, 3); assert.equal(st.usage.warning, null);
});

test("public / VIP / paid separation is enforced", async () => {
  const e = env(); const s = await login(e);
  await up(e, s, "vip/photos", "v.jpg", JPEG()); await up(e, s, "paid-media/photos", "p.jpg", JPEG()); await up(e, s, "public/photos", "p.jpg", JPEG());
  const mk = (b) => call(e, s, "/api/content", "POST", { text: "x", ...b });
  assert.equal((await mk({ kind: "photo", target: "public", media_url: "r2:vip/photos/v.jpg" })).status, 400);
  assert.equal((await mk({ kind: "photo", target: "public", media_url: "r2:paid-media/photos/p.jpg" })).status, 400);
  assert.equal((await mk({ kind: "photo", target: "vip", media_url: "r2:paid-media/photos/p.jpg" })).status, 400);
  assert.equal((await mk({ kind: "paid_media", target: "vip", star_count: 5, media_url: "r2:vip/photos/v.jpg" })).status, 400);
  assert.equal((await mk({ kind: "paid_media", target: "vip", star_count: 5, media_url: "r2:paid-media/photos/p.jpg" })).status, 200);
  assert.equal((await mk({ kind: "photo", target: "vip", media_url: "r2:public/photos/p.jpg" })).status, 200);
  assert.equal((await mk({ kind: "photo", target: "public", media_url: "r2:public/../vip/photos/v.jpg" })).status, 400);
  // Folder assignments obey the same rules
  assert.equal((await call(e, s, "/api/media/sources", "PUT", { sources: { public_auto: "vip/auto-post" } })).status, 400);
  assert.equal((await call(e, s, "/api/media/sources", "PUT", { sources: { paid_media: "public/photos" } })).status, 400);
  assert.equal((await call(e, s, "/api/media/sources", "PUT", { sources: { vip_photos: "paid-media" } })).status, 400);
  assert.equal((await call(e, s, "/api/media/sources", "PUT", { sources: { public_auto: "public/auto-post", bot2_photos: "bot2/photos" } })).status, 200);
});

test("Telegram receives R2 files as uploads (photo, video, GIF, paid), with captions and buttons", async () => {
  const bucket = makeR2();
  await bucket.put("public/photos/a.jpg", JPEG(), { httpMetadata: { contentType: "image/jpeg" } });
  await bucket.put("public/videos/b.mp4", MP4(), { httpMetadata: { contentType: "video/mp4" } });
  await bucket.put("paid-media/photos/c.jpg", JPEG(), { httpMetadata: { contentType: "image/jpeg" } });
  const calls = [];
  const tg = new SendOnlyTelegram({ token: "1:abc", fetchImpl: async (url, init) => {
    const f = init.body; const m = String(url).split("/").pop();
    calls.push({ m, fields: Object.fromEntries([...f.keys()].map((k) => [k, typeof f.get(k) === "string" ? f.get(k) : f.get(k).size])) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }));
  } });
  const config = { publicChannel: "@yourshakhira", vipChannelId: "-100777", botUsername: "ShakhiraVIPBot" };
  Object.defineProperty(config, "media", { value: bucket, enumerable: false });
  await sendItem(tg, config, { kind: "photo", target: "public", media_url: "r2:public/photos/a.jpg", parse_mode: "HTML", buttons_json: JSON.stringify([{ text: "Go", url: "https://t.me/x" }]) }, "<b>Hi</b> #tag");
  await sendItem(tg, config, { kind: "video", target: "public", media_url: "r2:public/videos/b.mp4" }, "v");
  await sendItem(tg, config, { kind: "paid_media", target: "vip", media_url: "r2:paid-media/photos/c.jpg", star_count: 10, protect_content: 1 }, "unlock");
  assert.deepEqual(calls[0], { m: "sendPhoto", fields: { chat_id: "@yourshakhira", caption: "<b>Hi</b> #tag", parse_mode: "HTML",
    reply_markup: JSON.stringify({ inline_keyboard: [[{ text: "Go", url: "https://t.me/x" }]] }), photo: 2000 } });
  assert.equal(calls[1].m, "sendVideo"); assert.equal(calls[1].fields.video, 4000); assert.equal(calls[1].fields.supports_streaming, "true");
  assert.equal(calls[2].m, "sendPaidMedia"); assert.equal(calls[2].fields.star_count, "10"); assert.equal(calls[2].fields.file, 2000);
  assert.deepEqual(JSON.parse(calls[2].fields.media), [{ type: "photo", media: "attach://file" }]);
  // Wrong type or missing file: a clear error, nothing sent
  await assert.rejects(sendItem(tg, config, { kind: "photo", target: "public", media_url: "r2:public/videos/b.mp4" }, "x"), /doesn't match a photo post/);
  await assert.rejects(sendItem(tg, config, { kind: "photo", target: "public", media_url: "r2:public/photos/gone.jpg" }, "x"), /no longer exists/);
  assert.equal(calls.length, 3);
});

test("automatic R2 posts: rotation, cooldown, one post per slot, public waits for the GitHub poster to retire", async () => {
  const e = env(); const ops = new Ops(e.DB, () => now);
  let now = Date.UTC(2026, 10, 23, 16, 31) / 1000;
  for (const n of ["old", "new"]) await e.MEDIA.put(`public/auto-post/${n}.jpg`, JPEG(), { httpMetadata: { contentType: "image/jpeg" } });
  await e.MEDIA.put("vip/photos/secret.jpg", JPEG(), { httpMetadata: { contentType: "image/jpeg" } });
  await ops.setSetting("autopost:public", JSON.stringify({ enabled: true }));
  await ops.setSetting("autopost_history:public", JSON.stringify({ "public/auto-post/old.jpg": now - 40 * 86400 }));
  const slots = [[16, 30], [23, 30]];
  assert.deepEqual(await queueR2AutoPosts(ops, now, e.MEDIA, slots), []); // GitHub poster not retired yet
  await ops.setSetting("github_poster_retired", "1");
  const first = await queueR2AutoPosts(ops, now, e.MEDIA, slots);
  assert.equal(first.length, 1);
  assert.equal((await ops.content(first[0])).media_url, "r2:public/auto-post/new.jpg"); // never-posted first
  assert.deepEqual(await queueR2AutoPosts(ops, now + 60, e.MEDIA, slots), []); // same slot: no second post
  now = Date.UTC(2026, 10, 23, 23, 31) / 1000;
  const second = await queueR2AutoPosts(ops, now, e.MEDIA, slots);
  assert.equal((await ops.content(second[0])).media_url, "r2:public/auto-post/old.jpg"); // cooldown passed
  now = Date.UTC(2026, 10, 24, 16, 31) / 1000;
  const alerts = [];
  assert.deepEqual(await queueR2AutoPosts(ops, now, e.MEDIA, slots, async (m) => alerts.push(m)), []); // both in cooldown
  assert.match(alerts[0], /skipped/);
});

test("Cloudinary → R2 copy: verified copies, posts repointed, failures listed, nothing deleted", async () => {
  const e = env({ CLOUDINARY_CLOUD_NAME: "m4upuaai", CLOUDINARY_API_KEY: "123", CLOUDINARY_API_SECRET: "sec" });
  const ops = new Ops(e.DB);
  const now = Math.floor(Date.now() / 1000);
  const p1 = await ops.createContent({ kind: "photo", target: "public", media_url: "https://res.cloudinary.com/m4upuaai/image/upload/v1/shakhira_admin/a1.jpg", text: "x" }, "t");
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url); requests.push(`${init.method || "GET"} ${url.split("?")[0]}`);
    if (url.includes("/resources/")) {
      const folder = decodeURIComponent((/asset_folder=([^&]+)/.exec(url) || [])[1] || "");
      if (folder === "shakhira_admin") return new Response(JSON.stringify({ resources: [
        { public_id: "shakhira_admin/a1", asset_folder: "shakhira_admin", resource_type: "image", format: "jpg", bytes: 2000, created_at: "2026-11-20" },
        { public_id: "shakhira_admin/broken", asset_folder: "shakhira_admin", resource_type: "image", format: "jpg", bytes: 50, created_at: "2026-11-20" }] }));
      if (folder === "tgpub") return new Response(JSON.stringify({ resources: [
        { public_id: "tgpub/t1", asset_folder: "tgpub", resource_type: "video", format: "mp4", bytes: 4000, created_at: "2026-10-01", tags: ["tgbot_at_1790000000"] }] }));
      return new Response(JSON.stringify({ resources: [] }));
    }
    if (url.includes("/download?")) {
      const id = new URL(url).searchParams.get("public_id");
      if (id === "shakhira_admin/a1") return new Response(JPEG(2000));
      if (id === "tgpub/t1") return new Response(MP4(4000));
      return new Response("{}", { status: 404 });
    }
    throw new Error("unexpected " + url);
  };
  const { migrateStep, migrationStatus } = await import("../src/migrate.js");
  assert.deepEqual(await migrateStep(e, ops, now, fetchImpl), { inventory: 3 });
  for (let i = 0; i < 3; i++) await migrateStep(e, ops, now, fetchImpl);
  const st = await migrationStatus(ops);
  assert.equal(st.status, "done"); assert.equal(st.copied, 2); assert.equal(st.failed.length, 1);
  assert.match(st.failed[0].error, /re-upload/);
  assert.ok(e.MEDIA.store.has("public/photos/a1.jpg") && e.MEDIA.store.has("public/auto-post/t1.mp4"));
  assert.equal(e.MEDIA.store.get("public/photos/a1.jpg").customMetadata.source, "cloudinary");
  assert.equal((await ops.content(p1.id)).media_url, "r2:public/photos/a1.jpg");
  assert.equal(JSON.parse(await ops.getSetting("autopost_history:public"))["public/auto-post/t1.mp4"], 1790000000);
  assert.ok(!requests.some((r) => r.startsWith("DELETE")), "nothing deleted in Cloudinary");
  assert.equal(await migrateStep(e, ops, now, fetchImpl), null);
});
