// Admin Account: password changes (both sign-in modes), verified email change (Supabase), session sign-out,
// rate limiting, and no secrets in responses or the audit log.
import assert from "node:assert/strict";
import { test } from "node:test";

import { hashPassword } from "../src/auth.js";
import { passwordProblem } from "../src/account.js";
import worker from "../src/index.js";
import { Ops } from "../src/ops.js";
import { makeD1 } from "./d1shim.mjs";

const ORIGIN = "https://shakhira-admin.example.workers.dev";
const OLD = "Old-password-123", NEW = "Brand-New-pass-456";
const req = async (e, path, method = "GET", s, body) => {
  const r = await worker.fetch(new Request(ORIGIN + path, { method, body: body && JSON.stringify(body),
    headers: { ...(s ? { cookie: s.cookie, "x-csrf-token": s.csrf } : {}), "cf-connecting-ip": "8.8.8.8" } }), e);
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, cookie: r.headers.get("set-cookie")?.split(";")[0] };
};
const login = async (e, body) => { const r = await req(e, "/api/login", "POST", null, body); return r.status === 200 ? { cookie: r.cookie, csrf: r.body.csrf } : null; };

test("password strength rules", () => {
  assert.ok(passwordProblem("short1A!"));
  assert.equal(passwordProblem("alllowercaseonlyx"), null);
  assert.ok(passwordProblem("Abcdefgh1234", { current: "Abcdefgh1234" }));
  assert.ok(passwordProblem("Shakhira-2026!x", { email: "shakhira@example.com" }));
  assert.equal(passwordProblem(NEW), null);
});

test("password mode: change, old password rejected, other sessions signed out, rate-limited", async () => {
  const e = { DB: makeD1(), DASHBOARD_PASSWORD_HASH: await hashPassword(OLD, 1000), DASHBOARD_SECRET: "s".repeat(40), ENVIRONMENT: "staging", REQUIRE_PREVIEW: "true" };
  const a = await login(e, { password: OLD }), other = await login(e, { password: OLD });
  const view = (await req(e, "/api/account", "GET", a)).body;
  assert.equal(view.mode, "password"); assert.equal(view.email_supported, false);
  assert.equal((await req(e, "/api/account/email", "PUT", a, { current_password: OLD, new_email: "x@y.com" })).status, 400);
  assert.equal((await req(e, "/api/account/password", "PUT", null, { current_password: OLD, new_password: NEW, confirm_password: NEW })).status, 401, "needs sign-in");
  assert.equal((await req(e, "/api/account/password", "PUT", { cookie: a.cookie, csrf: "bad" }, { current_password: OLD, new_password: NEW, confirm_password: NEW })).status, 403, "needs CSRF");
  assert.equal((await req(e, "/api/account/password", "PUT", a, { current_password: "wrong-one", new_password: NEW, confirm_password: NEW })).status, 400);
  assert.equal((await req(e, "/api/account/password", "PUT", a, { current_password: OLD, new_password: NEW, confirm_password: "nope" })).status, 400);
  assert.equal((await req(e, "/api/account/password", "PUT", a, { current_password: OLD, new_password: "weak", confirm_password: "weak" })).status, 400);
  const ok = await req(e, "/api/account/password", "PUT", a, { current_password: OLD, new_password: NEW, confirm_password: NEW });
  assert.equal(ok.status, 200);
  const fresh = { cookie: ok.cookie, csrf: ok.body.csrf };
  assert.equal((await req(e, "/api/me", "GET", fresh)).status, 200, "this browser stays signed in");
  assert.equal((await req(e, "/api/me", "GET", other)).status, 401, "other sessions are signed out");
  assert.equal((await req(e, "/api/me", "GET", a)).status, 401, "the old cookie is revoked");
  assert.equal(await login(e, { password: OLD }), null, "old password rejected");
  assert.ok(await login(e, { password: NEW }), "new password works");
  const ops = new Ops(e.DB);
  assert.match(await ops.getSetting("auth:password_hash"), /^pbkdf2_sha256:/);
  const audit = JSON.stringify(await ops.auditEntries());
  assert.ok(!audit.includes(NEW) && !audit.includes(OLD), "no passwords in the audit log");
  assert.ok(audit.includes("account_password"));
  // repeated wrong current passwords lock the endpoint like sign-in does
  await new Promise((r) => setTimeout(r, 1100)); // sessions from the same second as the change count as older ones
  const s2 = await login(e, { password: NEW });
  for (let i = 0; i < 6; i++) await req(e, "/api/account/password", "PUT", s2, { current_password: "bad-" + i, new_password: "Another-pass-789", confirm_password: "Another-pass-789" });
  assert.match((await req(e, "/api/account/password", "PUT", s2, { current_password: NEW, new_password: "Another-pass-789", confirm_password: "Another-pass-789" })).body.error, /Too many attempts/);
});

test("Supabase mode: password via admin API (app_metadata kept), email via verified change, secrets never returned", async () => {
  const { AdminAccount } = await import("../src/account.js");
  const calls = [];
  let password = OLD;
  const admin = { id: "u-1", email: "admin@example.com", email_confirmed_at: "2026-11-01", app_metadata: { shakhira_admin: true, provider: "email" }, last_sign_in_at: "2026-11-22" };
  const fake = async (url, init = {}) => {
    url = String(url); const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: url.replace("https://p.supabase.co", ""), method: init.method || "GET", body, auth: init.headers?.authorization });
    if (url.includes("/token?grant_type=password")) return body.password === password && body.email === admin.email
      ? new Response(JSON.stringify({ access_token: "user-access-token", user: admin })) : new Response("{}", { status: 400 });
    if (url.includes("/admin/users?")) return new Response(JSON.stringify({ users: [admin, { id: "u-2", email: "member@example.com", app_metadata: {} }] }));
    if (url.endsWith("/admin/users/u-1") && init.method === "PUT") { password = body.password; return new Response(JSON.stringify(admin)); }
    if (url.endsWith("/auth/v1/user") && init.method === "PUT") { admin.new_email = body.email; return new Response(JSON.stringify(admin)); }
    throw new Error("unexpected " + url);
  };
  const ops = new Ops(makeD1());
  const acc = new AdminAccount({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_x" }, ops, "supabase", fake);
  const v = await acc.view();
  assert.deepEqual([v.mode, v.email, v.email_supported, v.pending_email], ["supabase", "admin@example.com", true, null]);
  await assert.rejects(acc.changePassword({ current_password: "wrong-pass", new_password: NEW, confirm_password: NEW }, "admin"), /incorrect/);
  await acc.changePassword({ current_password: OLD, new_password: NEW, confirm_password: NEW }, "admin");
  const put = calls.find((c) => c.url === "/auth/v1/admin/users/u-1");
  assert.deepEqual(Object.keys(put.body), ["password"], "only the password is sent; app_metadata is untouched");
  await assert.rejects(acc.changeEmail({ current_password: OLD, new_email: "new@example.com" }, "admin"), /incorrect/, "old password no longer valid");
  await assert.rejects(acc.changeEmail({ current_password: NEW, new_email: "not-an-email" }, "admin"), /valid email/);
  assert.deepEqual(await acc.changeEmail({ current_password: NEW, new_email: "new@example.com" }, "admin"), { pending_email: "new@example.com" });
  const emailCall = calls.find((c) => c.url === "/auth/v1/user");
  assert.equal(emailCall.body.email, "new@example.com");
  assert.equal(emailCall.auth, "Bearer user-access-token", "Supabase's own (verified) email-change flow, as the signed-in user");
  const after = await acc.view();
  assert.deepEqual([after.email, after.pending_email], ["admin@example.com", "new@example.com"], "current email keeps working until confirmed");
  const everything = JSON.stringify([v, after, await ops.auditEntries()]);
  for (const secret of [OLD, NEW, "user-access-token", "sb_secret_x"]) assert.ok(!everything.includes(secret), secret);
  assert.ok(!JSON.stringify(await ops.auditEntries()).includes("new@example.com"), "the audit log masks the new email");
});
