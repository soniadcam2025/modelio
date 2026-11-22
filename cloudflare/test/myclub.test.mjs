// My.Club workspace: stored apart from Telegram, never calls My.Club or Telegram, validated, exported, in the calendar.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import worker from "../src/index.js";
import { Ops } from "../src/ops.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin.example.workers.dev";
const outbound = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => { outbound.push(String(url)); return realFetch(url, init); };

const env = () => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "production",
  REQUIRE_PREVIEW: "true", PUBLIC_CHANNEL: "@yourshakhira", BOT_USERNAME: "ShakhiraVIPBot" });
async function login(e) {
  const r = await worker.fetch(new Request(ORIGIN + "/api/login", { method: "POST", body: JSON.stringify({ password: PASSWORD }), headers: { "cf-connecting-ip": "6.6.6.6" } }), e);
  return { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
}
const call = async (e, s, path, method = "GET", body) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), "cf-connecting-ip": "6.6.6.6" } }), e);
  const t = await r.text(); return { status: r.status, body: t ? JSON.parse(t) : null };
};

test("My.Club workspace end to end, isolated from Telegram", async () => {
  const e = env(); const s = await login(e);
  assert.equal((await call(e, null, "/api/myclub")).status, 401);
  const me = await call(e, s, "/api/me");
  assert.ok(me.body.capabilities.includes("myclub"));
  const v = await call(e, s, "/api/myclub");
  assert.equal(v.body.api.publishing, false);

  assert.equal((await call(e, s, "/api/myclub/connection", "PUT", { handle: "@shakhira", profile_url: "http://x" })).status, 400);
  const conn = await call(e, s, "/api/myclub/connection", "PUT", { handle: "@shakhira", profile_url: "https://my.club/shakhira" });
  assert.equal(conn.body.handle, "shakhira");

  assert.equal((await call(e, s, "/api/myclub/items", "POST", { kind: "paid", caption: "x" })).status, 400);
  const at = Math.floor(Date.now() / 1000) + 3600;
  const it = await call(e, s, "/api/myclub/items", "POST", { kind: "paid", price: 9.99, caption: "Hello", tags: ["#vip"], media: ["https://res.cloudinary.com/x/a.jpg"], planned_at: at, status: "ready" });
  assert.equal(it.status, 200); assert.equal(it.body.price, 9.99);
  const ex = await call(e, s, `/api/myclub/items/${it.body.id}/export`, "POST");
  assert.match(ex.body.caption, /#vip/);
  assert.equal((await call(e, s, "/api/myclub")).body.items[0].status, "exported");
  const cal = await call(e, s, `/api/myclub/calendar?start=${at - 10}&end=${at + 10}`);
  assert.equal(cal.body.length, 1); assert.equal(cal.body[0].platform, "myclub");
  await call(e, s, "/api/myclub/metrics", "POST", { subscribers: 120, revenue: 50 });
  assert.equal((await call(e, s, "/api/myclub")).body.metrics[0].subscribers, 120);

  // Telegram content untouched; nothing sent anywhere outside the Worker.
  assert.deepEqual((await call(e, s, "/api/content")).body, []);
  assert.ok(!outbound.some((u) => /telegram|my\.club/.test(u)), outbound.join(" "));
  assert.ok((await new Ops(e.DB).getSetting("myclub:workspace")).includes("Hello"));
  assert.equal((await call(e, s, `/api/myclub/items/${it.body.id}`, "DELETE")).status, 200);
  assert.equal((await call(e, s, "/api/myclub")).body.items.length, 0);
});
