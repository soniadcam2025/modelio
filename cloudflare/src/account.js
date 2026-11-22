// Admin Account (single admin). Uses the deployment's own sign-in provider, never a different one:
// - Supabase Auth (production): the one user with app_metadata.shakhira_admin. Password changes go through the
//   admin API (app_metadata untouched); email changes go through Supabase's own verified email-change flow, so the
//   old email keeps working until the new address is confirmed (no lock-out).
// - Password mode: a new PBKDF2 hash is stored in settings ("auth:password_hash") and takes precedence over the
//   DASHBOARD_PASSWORD_HASH secret. There is no email login in this mode.
// Every change needs the current password, is rate-limited (shared with sign-in), audited without secrets, and
// signs out all other sessions ("auth:sessions_after").
import { hashPassword, verifyPassword } from "./auth.js";
import { OpsError } from "./ops.js";

export const PASSWORD_HASH_KEY = "auth:password_hash";
export const SESSIONS_AFTER_KEY = "auth:sessions_after";

export function passwordProblem(pw, { email = "", current = "" } = {}) {
  const p = String(pw || "");
  if (p.length < 12) return "Use at least 12 characters";
  if (p.length > 200) return "Use at most 200 characters";
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
  if (p.length < 16 && classes < 3) return "Mix at least three of: lowercase, uppercase, numbers, symbols (or use 16+ characters)";
  if (/^(.)\1+$/.test(p) || /^(password|qwerty|123456)/i.test(p)) return "This password is too easy to guess";
  const local = String(email).split("@")[0].toLowerCase();
  if (local.length >= 4 && p.toLowerCase().includes(local)) return "Don't include your email name in the password";
  if (current && p === current) return "Choose a password different from the current one";
  return null;
}

const base = (env) => String(env.SUPABASE_URL || "").replace(/\/+$/, "");
async function sb(env, path, { method = "GET", body, token } = {}, fetchImpl = fetch) {
  const res = await fetchImpl(base(env) + path, { method, headers: { apikey: env.SUPABASE_SECRET_KEY, authorization: `Bearer ${token || env.SUPABASE_SECRET_KEY}`,
    "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export class AdminAccount {
  constructor(env, ops, mode, fetchImpl = fetch) { this.env = env; this.ops = ops; this.mode = mode; this.fetch = fetchImpl; }

  async #adminUser() {
    const r = await sb(this.env, "/auth/v1/admin/users?per_page=1000", {}, this.fetch);
    if (!r.ok) throw new OpsError("Couldn't read the admin account from Supabase");
    const admins = (r.data.users || []).filter((u) => u.app_metadata?.shakhira_admin === true);
    if (admins.length !== 1) throw new OpsError(admins.length ? "More than one admin account exists; change it in Supabase instead" : "No admin account found");
    return admins[0];
  }

  // Signs in with the current password (proves it's you); returns the session for Supabase's own endpoints.
  async #verify(email, password) {
    const r = await sb(this.env, "/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }, this.fetch);
    if (!r.ok || r.data?.user?.app_metadata?.shakhira_admin !== true) return null;
    return r.data;
  }

  async view() {
    const sessionsAfter = Number(await this.ops.getSetting(SESSIONS_AFTER_KEY, "0")) || null;
    const last = await this.ops.one("SELECT created_at FROM audit_log WHERE action IN ('account_password','account_email_request') ORDER BY id DESC LIMIT 1");
    if (this.mode !== "supabase") {
      return { mode: "password", email: null, email_supported: false, password_changed_at: last?.created_at ?? null, sessions_reset_at: sessionsAfter,
        note: "This deployment signs in with a password only (no email). Changing that would need a move to Supabase Auth." };
    }
    const u = await this.#adminUser();
    return { mode: "supabase", email: u.email, email_supported: true, pending_email: u.new_email || null, email_confirmed: !!u.email_confirmed_at,
      last_sign_in_at: u.last_sign_in_at || null, password_changed_at: last?.created_at ?? null, sessions_reset_at: sessionsAfter };
  }

  async changePassword({ current_password, new_password, confirm_password }, actor) {
    const cur = String(current_password || ""), next = String(new_password || "");
    if (next !== String(confirm_password || "")) throw new OpsError("The new passwords don't match");
    if (this.mode === "supabase") {
      const u = await this.#adminUser();
      const problem = passwordProblem(next, { email: u.email, current: cur });
      if (problem) throw new OpsError(problem);
      if (!(await this.#verify(u.email, cur))) throw new AuthCheckError();
      const r = await sb(this.env, `/auth/v1/admin/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: { password: next } }, this.fetch);
      if (!r.ok) throw new OpsError(`Supabase refused the new password${r.data?.msg ? `: ${String(r.data.msg).slice(0, 120)}` : ""}`);
    } else {
      const stored = (await this.ops.getSetting(PASSWORD_HASH_KEY)) || this.env.DASHBOARD_PASSWORD_HASH || "";
      if (!(await verifyPassword(cur, stored))) throw new AuthCheckError();
      const problem = passwordProblem(next, { current: cur });
      if (problem) throw new OpsError(problem);
      await this.ops.setSetting(PASSWORD_HASH_KEY, await hashPassword(next));
    }
    await this.ops.audit(actor, "account_password", "password changed; other sessions signed out");
  }

  async changeEmail({ current_password, new_email }, actor) {
    if (this.mode !== "supabase") throw new OpsError("This deployment has no email sign-in");
    const email = String(new_email || "").trim().toLowerCase();
    if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(email)) throw new OpsError("Enter a valid email address");
    const u = await this.#adminUser();
    if (email === String(u.email).toLowerCase()) throw new OpsError("That is already your email");
    const session = await this.#verify(u.email, String(current_password || ""));
    if (!session) throw new AuthCheckError();
    // Supabase's own email-change flow: confirmation links are emailed; the old email works until confirmed.
    const r = await sb(this.env, "/auth/v1/user", { method: "PUT", body: { email }, token: session.access_token }, this.fetch);
    if (!r.ok) throw new OpsError(r.status === 422 ? "That email can't be used" : "Supabase couldn't start the email change");
    await this.ops.audit(actor, "account_email_request", `change requested to ${email.replace(/^(.).*(@.*)$/, "$1***$2")}; awaiting confirmation`);
    return { pending_email: email };
  }

  async verifyOnly(current_password) {
    if (this.mode === "supabase") { const u = await this.#adminUser(); if (!(await this.#verify(u.email, String(current_password || "")))) throw new AuthCheckError(); }
    else {
      const stored = (await this.ops.getSetting(PASSWORD_HASH_KEY)) || this.env.DASHBOARD_PASSWORD_HASH || "";
      if (!(await verifyPassword(String(current_password || ""), stored))) throw new AuthCheckError();
    }
  }
}

export class AuthCheckError extends OpsError { constructor() { super("Current password is incorrect"); } }
