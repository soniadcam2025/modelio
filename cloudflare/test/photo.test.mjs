// Photo publishing: Telegram-compatible Cloudinary links, and a multipart upload fallback when Telegram
// can't fetch the link ("failed to get HTTP URL content"). One post, at most one delivered message.
import assert from "node:assert/strict";
import { test } from "node:test";

import { sendItem, telegramPhotoUrl } from "../src/scheduler.js";
import { SendOnlyTelegram, TelegramError } from "../src/telegram.js";

const ORIG = "https://res.cloudinary.com/m4upuaai/image/upload/v1795289626/shakhira_admin/abc.heic";
const LINK = "https://res.cloudinary.com/m4upuaai/image/upload/f_jpg,q_auto:good,c_limit,w_2560,h_2560/v1795289626/shakhira_admin/abc.heic";
const config = { previewChatId: null, publicChannel: "@yourshakhira", vipChannelId: "-100777", botUsername: "ShakhiraVIPBot" };
const item = { id: 6, kind: "photo", target: "public", media_url: ORIG, parse_mode: "HTML", buttons_json: JSON.stringify([{ text: "Join", url: "https://t.me/x" }]), protect_content: 1 };

function fakeTelegram({ refuseLink = true, cloud = { status: 200, type: "image/jpeg", bytes: 1000 } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith("https://res.cloudinary.com/") || url.startsWith("https://api.cloudinary.com/")) {
      if (cloud.aclDeny && url.startsWith("https://res.")) { calls.push({ download: url, denied: true }); return new Response('{"error":{"message":"ACL deny"}}', { status: 401, headers: { "x-cld-error": "ACL deny" } }); }
      calls.push({ download: url });
      const body = new Uint8Array(cloud.bytes); if (cloud.jpeg !== false) body.set([0xff, 0xd8, 0xff], 0);
      return new Response(body, { status: cloud.status, headers: { "content-type": cloud.type } });
    }
    const method = url.split("/").pop();
    if (init.body instanceof FormData) {
      const f = init.body;
      if (method === "sendPaidMedia") { calls.push({ method, multipart: true, media: f.get("media"), stars: f.get("star_count"), size: f.get("file").size }); return new Response(JSON.stringify({ ok: true, result: { message_id: 78 } })); }
      calls.push({ method, multipart: true, chat_id: f.get("chat_id"), caption: f.get("caption"), parse_mode: f.get("parse_mode"),
        reply_markup: JSON.parse(f.get("reply_markup")), protect: f.get("protect_content"), size: f.get("photo").size });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 77 } }));
    }
    const params = JSON.parse(init.body);
    calls.push({ method, photo: params.photo });
    if (refuseLink) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: failed to get HTTP URL content" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 76 } }));
  };
  return { calls, tg: new SendOnlyTelegram({ token: "1:abc", fetchImpl }), fetchImpl };
}

test("Cloudinary photo links are delivered as Telegram-compatible JPEGs; other links untouched", () => {
  assert.equal(telegramPhotoUrl(ORIG), LINK);
  assert.equal(telegramPhotoUrl(LINK), LINK);
  assert.equal(telegramPhotoUrl("https://example.com/a.jpg"), "https://example.com/a.jpg");
  assert.equal(telegramPhotoUrl("https://res.cloudinary.com/x/video/upload/v1/a.mp4"), "https://res.cloudinary.com/x/video/upload/v1/a.mp4");
});

test("link accepted: one sendPhoto with the compatible link", async () => {
  const { calls, tg } = fakeTelegram({ refuseLink: false });
  const r = await sendItem(tg, config, item, "<b>Hi</b> #tag");
  assert.equal(r.message_id, 76);
  assert.deepEqual(calls, [{ method: "sendPhoto", photo: LINK }]);
});

test("link refused: uploads the file once, keeping caption, formatting, buttons and protection", async () => {
  const { calls, tg, fetchImpl } = fakeTelegram();
  globalThis.__realFetch = globalThis.fetch; globalThis.fetch = fetchImpl;
  try {
    const r = await sendItem(tg, config, item, "<b>Hi</b> #tag");
    assert.equal(r.message_id, 77);
  } finally { globalThis.fetch = globalThis.__realFetch; }
  const sends = calls.filter((c) => c.method);
  assert.equal(sends.length, 2);
  assert.deepEqual(sends[1], { method: "sendPhoto", multipart: true, chat_id: "@yourshakhira", caption: "<b>Hi</b> #tag", parse_mode: "HTML",
    reply_markup: { inline_keyboard: [[{ text: "Join", url: "https://t.me/x" }]] }, protect: "true", size: 1000 });
});

test("fallback refuses broken files with a clear error and sends nothing", async () => {
  for (const cloud of [{ status: 404, type: "text/html", bytes: 10 }, { status: 200, type: "text/html", bytes: 10, jpeg: false }, { status: 200, type: "image/jpeg", bytes: 11 * 1024 * 1024 }]) {
    const { calls, tg, fetchImpl } = fakeTelegram({ cloud });
    globalThis.__realFetch = globalThis.fetch; globalThis.fetch = fetchImpl;
    try { await assert.rejects(sendItem(tg, config, item, "x"), (e) => e instanceof TelegramError && e.code === 400 && /upload fallback failed/.test(e.message)); }
    finally { globalThis.fetch = globalThis.__realFetch; }
    assert.equal(calls.filter((c) => c.multipart).length, 0);
  }
});

test("other Telegram errors don't trigger the fallback", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: "Forbidden: bot is not a member" }), { status: 403 });
  const tg = new SendOnlyTelegram({ token: "1:abc", fetchImpl });
  await assert.rejects(sendItem(tg, config, item, "x"), /bot is not a member/);
});

test("staging lock also applies to uploads", async () => {
  const tg = new SendOnlyTelegram({ token: "1:abc", previewChatId: "42", requirePreview: true, fetchImpl: async () => { throw new Error("must not send"); } });
  await assert.rejects(tg.upload("sendPhoto", { chat_id: "@yourshakhira" }, "photo", new Blob(["x"]), "a.jpg"), /Staging lock/);
});

const withFetch = async (fetchImpl, fn) => { const real = globalThis.fetch; globalThis.fetch = fetchImpl; try { return await fn(); } finally { globalThis.fetch = real; } };
const cfgWithCloud = (() => { const c = { ...config }; Object.defineProperty(c, "cloudinary", { value: { cloud: "m4upuaai", key: "123", secret: "s" }, enumerable: false }); return c; })();

test("Cloudinary delivery restricted (401 ACL deny): signed Admin-API download is uploaded instead", async () => {
  const { calls, tg, fetchImpl } = fakeTelegram({ cloud: { status: 200, type: "application/octet-stream", bytes: 2000, aclDeny: true } });
  const r = await withFetch(fetchImpl, () => sendItem(tg, cfgWithCloud, item, "cap"));
  assert.equal(r.message_id, 77);
  const dl = calls.filter((c) => c.download);
  assert.ok(dl.at(-1).download.startsWith("https://api.cloudinary.com/v1_1/m4upuaai/image/download?"));
  const q = new URL(dl.at(-1).download).searchParams;
  assert.equal(q.get("public_id"), "shakhira_admin/abc"); assert.equal(q.get("format"), "jpg"); assert.ok(q.get("signature"));
  assert.equal(calls.filter((c) => c.multipart).length, 1);
});

test("without the keys the error explains the 401", async () => {
  const { tg, fetchImpl } = fakeTelegram({ cloud: { status: 200, type: "image/jpeg", bytes: 10, aclDeny: true } });
  await assert.rejects(withFetch(fetchImpl, () => sendItem(tg, config, item, "x")), /HTTP 401 \(ACL deny\)/);
});

test("paid-media photo: same fallback, uploaded as attach://file with the Stars price", async () => {
  const { calls, tg, fetchImpl } = fakeTelegram({ cloud: { status: 200, type: "image/jpeg", bytes: 500, aclDeny: true } });
  const paid = { id: 9, kind: "paid_media", target: "vip", media_url: ORIG.replace(".heic", ".jpg"), star_count: 25 };
  const r = await withFetch(fetchImpl, () => sendItem(tg, cfgWithCloud, paid, "unlock"));
  assert.equal(r.message_id, 78);
  const up = calls.find((c) => c.multipart);
  assert.deepEqual(JSON.parse(up.media), [{ type: "photo", media: "attach://file" }]);
  assert.equal(up.stars, "25");
});
