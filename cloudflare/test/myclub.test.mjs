// My.Club was removed from the dashboard: no routes, no capability, and its saved data is left untouched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import worker from "../src/index.js";
import { Ops } from "../src/ops.js";
import { makeD1 } from "./d1shim.mjs";

const PASSWORD = "staging-password-123";
const HASH = await hashPassword(PASSWORD, 1000);
const ORIGIN = "https://shakhira-admin.example.workers.dev";
const env = () => ({ DB: makeD1(), DASHBOARD_PASSWORD_HASH: HASH, DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "production",
  REQUIRE_PREVIEW: "true", PUBLIC_CHANNEL: "@yourshakhira", BOT_USERNAME: "ShakhiraVIPBot" });
const req = (e, path, method = "GET", s, body) => worker.fetch(new Request(ORIGIN + path, { method, body: body && JSON.stringify(body),
  headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), "cf-connecting-ip": "6.6.6.6" } }), e);

test("My.Club is gone from the dashboard and its stored data is preserved", async () => {
  const e = env();
  const saved = JSON.stringify({ connection: { handle: "x" }, items: [{ id: 1, title: "kept" }], metrics: [], next_id: 2 });
  await new Ops(e.DB).setSetting("myclub:workspace", saved);
  const r = await req(e, "/api/login", "POST", null, { password: PASSWORD });
  const s = { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
  const me = await (await req(e, "/api/me", "GET", s)).json();
  assert.ok(!me.capabilities.includes("myclub"));
  for (const [m, p] of [["GET", "/api/myclub"], ["POST", "/api/myclub/items"], ["GET", "/api/myclub/calendar?start=0&end=10"]])
    assert.equal((await req(e, p, m, s, m === "POST" ? {} : undefined)).status, 404, p);
  assert.equal(await new Ops(e.DB).getSetting("myclub:workspace"), saved);
  const backup = await (await req(e, "/api/backup", "GET", s)).json();
  assert.ok(backup.tables.settings.some((row) => row.key === "myclub:workspace"));
});
