// Dashboard sign-in for the Worker: PBKDF2 password hash, HMAC-signed session, CSRF token, login rate limit.
// Same formats as dashboard/auth.py, so a hash made by either works in both.

export const SESSION_SECONDS = 12 * 3600;
export const MAX_FAILURES = 5;
export const MAX_GLOBAL_FAILURES = 20; // across all addresses: stops guessing spread over many IPs
export const FAILURE_WINDOW = 15 * 60;
export const MAX_PBKDF2_ITERATIONS = 100_000; // the Workers runtime refuses more

const enc = new TextEncoder();

export function b64(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}
export function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password, iterations = MAX_PBKDF2_ITERATIONS) {
  if (password.length < 12) throw new Error("Use a password of at least 12 characters");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2_sha256:${iterations}:${b64(salt)}:${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, iterations, salt, digest] = String(stored).trim().replaceAll("$", ":").split(":");
    const n = Number(iterations);
    if (scheme !== "pbkdf2_sha256" || !Number.isInteger(n) || n < 1 || n > MAX_PBKDF2_ITERATIONS) return false;
    const actual = b64(await pbkdf2(String(password), unb64(salt), n));
    return constantTimeEqual(actual, digest);
  } catch {
    return false;
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export class Sessions {
  constructor(secret, db, now = () => Math.floor(Date.now() / 1000)) {
    if (!secret || secret.length < 32) throw new Error("DASHBOARD_SECRET must be at least 32 characters");
    this.secret = secret;
    this.db = db;
    this.now = now;
  }

  async issue() {
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16))).replace(/[^A-Za-z0-9]/g, "");
    const message = `${this.now() + SESSION_SECONDS}.${nonce}`;
    return `${message}.${await hmacHex(this.secret, message)}`;
  }

  async valid(token) {
    if (!token || token.split(".").length !== 3) return false;
    const [expiry, nonce, signature] = token.split(".");
    if (!constantTimeEqual(signature, await hmacHex(this.secret, `${expiry}.${nonce}`))) return false;
    if (!(Number(expiry) > this.now())) return false;
    const revoked = await this.db.prepare("SELECT 1 FROM revoked_sessions WHERE nonce = ?").bind(nonce).first();
    return !revoked;
  }

  async revoke(token) {
    if (!token || token.split(".").length !== 3) return;
    const [expiry, nonce] = token.split(".");
    await this.db.prepare("INSERT INTO revoked_sessions (nonce, expires_at) VALUES (?, ?) ON CONFLICT DO NOTHING")
      .bind(nonce, Number(expiry) || this.now()).run();
  }

  async csrfFor(token) {
    return (await hmacHex(this.secret, "csrf:" + token)).slice(0, 40);
  }
}

export class LoginLimiter {
  constructor(db, now = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }
  async blocked(client) {
    const since = this.now() - FAILURE_WINDOW;
    const row = await this.db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN client = ? THEN 1 ELSE 0 END) AS mine FROM login_failures WHERE at > ?")
      .bind(client, since).first();
    return (row?.mine || 0) >= MAX_FAILURES || (row?.n || 0) >= MAX_GLOBAL_FAILURES;
  }
  async failed(client) {
    await this.db.prepare("INSERT INTO login_failures (client, at) VALUES (?, ?)").bind(client, this.now()).run();
  }
  async succeeded(client) {
    await this.db.prepare("DELETE FROM login_failures WHERE client = ?").bind(client).run();
  }
}

export function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
