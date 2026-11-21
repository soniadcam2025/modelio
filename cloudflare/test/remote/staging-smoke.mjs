// Smoke test against the DEPLOYED staging Worker. Never run against production.
//   STAGING_URL=https://... STAGING_PASSWORD=... node test/remote/staging-smoke.mjs
// Creates clearly labelled test posts, enables simulated automation, waits for the cron run,
// and checks security. The rate-limit check runs last (it locks this IP out of login for 15 min).
const BASE = process.env.STAGING_URL, PW = process.env.STAGING_PASSWORD;
if (!BASE || !BASE.includes("staging")) { console.error("Refusing: STAGING_URL must be the staging Worker"); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function login() {
  const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.STAGING_EMAIL, password: PW }) });
  const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  return { status: r.status, cookie, setCookie: r.headers.get("set-cookie") || "", csrf: r.ok ? (await r.json()).csrf : null };
}
const api = (s, path, { method = "GET", body, csrf = s.csrf } = {}) => fetch(BASE + path, {
  method, headers: { "content-type": "application/json", cookie: s.cookie, ...(csrf ? { "x-csrf-token": csrf } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const health = await (await fetch(BASE + "/api/health")).json();
check("health: staging, simulated automation", health.environment === "staging" && health.automation === "simulated", JSON.stringify(health));

const page = await fetch(BASE + "/");
check("dashboard page served over HTTPS", page.ok && (await page.text()).includes("Shakhira Admin"));
for (const h of ["content-security-policy", "x-frame-options", "strict-transport-security", "x-content-type-options", "x-robots-tag"])
  check(`security header ${h}`, !!page.headers.get(h), page.headers.get(h) || "missing");

check("API refuses requests without a session", (await fetch(BASE + "/api/overview")).status === 401);
const s = await login();
check("login with the staging password", s.status === 200 && !!s.csrf);
for (const flag of ["HttpOnly", "Secure", "SameSite=Strict"]) check(`session cookie ${flag}`, s.setCookie.includes(flag));
check("changes refused without CSRF token", (await api(s, "/api/content", { method: "POST", body: { kind: "text", target: "public", text: "x" }, csrf: null })).status === 403);
check("changes refused with forged CSRF token", (await api(s, "/api/content", { method: "POST", body: { kind: "text", target: "public", text: "x" }, csrf: "forged" })).status === 403);

const settings = await (await api(s, "/api/settings")).json();
check("all features start OFF", Object.values(settings.features).every((f) => !f.enabled));

const tag = `[smoke ${new Date().toISOString().slice(0, 16)}Z]`;
const now = Math.floor(Date.now() / 1000);
const posts = [
  { kind: "text", target: "public", text: `${tag} text post` },
  { kind: "photo", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", text: `${tag} photo` },
  { kind: "video", target: "vip", media_url: "https://res.cloudinary.com/demo/video/upload/dog.mp4", text: `${tag} video` },
  { kind: "animation", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/kitten.gif", text: `${tag} gif` },
  { kind: "poll", target: "public", text: `${tag} poll?`, options: ["Red", "Black"], close_after_minutes: 5 },
  { kind: "quiz", target: "public", text: `${tag} quiz?`, options: ["Mumbai", "Goa"], correct_option: 1, explanation: "Goa" },
  { kind: "promo", target: "public", text: `${tag} VIP trial 49 stars` },
  { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", star_count: 25, text: `${tag} paid` },
];
const ids = [];
for (const p of posts) {
  const r = await api(s, "/api/content", { method: "POST", body: { ...p, schedule: true, scheduled_at: now - 5 } });
  const j = await r.json();
  check(`create + schedule ${p.kind}`, r.ok && j.status === "scheduled", j.error || "");
  ids.push(j.id);
}
const bad = await api(s, "/api/content", { method: "POST", body: { kind: "poll", target: "public", text: "Q", options: ["only one"] } });
check("invalid poll rejected with a clear message", bad.status === 400 && /2 to 10/.test((await bad.json()).error));

const cal = await (await api(s, `/api/calendar?start=${now - 3600}&end=${now + 86400}`)).json();
check("calendar shows the posts and the GitHub poster slots", ids.every((id) => cal.items.some((i) => i.id === id)) && cal.poster_slots.length >= 1);

for (const f of ["scheduled_posts", "poll_auto_close"])
  check(`enable ${f} (staging only)`, (await (await api(s, `/api/settings/features/${f}`, { method: "PUT", body: { enabled: true } })).json()).enabled === true);

console.log("Waiting for the cron trigger (runs every minute)…");
let items = [];
for (let i = 0; i < 18; i++) {
  await new Promise((r) => setTimeout(r, 10000));
  items = (await (await api(s, "/api/content")).json()).filter((x) => ids.includes(x.id));
  if (items.every((x) => x.status !== "scheduled")) break;
}
for (const p of posts) {
  const item = items.find((x) => x.kind === p.kind && x.text.startsWith(tag));
  check(`cron published ${p.kind} in SIMULATION`, item?.status === "simulated", item ? `${item.status}: ${item.last_error}` : "missing");
}
const o = await (await api(s, "/api/overview")).json();
check("worker heartbeat recorded by cron", o.worker_last_seen && now - 60 <= o.worker_last_seen, String(o.worker_last_seen));

// Persistence: a brand-new session sees the same data.
const s2 = await login();
const again = (await (await api(s2, "/api/content")).json()).filter((x) => ids.includes(x.id));
check("data persists across sessions (D1)", again.length === posts.length);

// Switch automation back off so staging stays idle.
for (const f of ["scheduled_posts", "poll_auto_close"]) await api(s, `/api/settings/features/${f}`, { method: "PUT", body: { enabled: false } });
check("features switched back off", Object.values((await (await api(s, "/api/settings")).json()).features).every((f) => !f.enabled));

const audit = (await (await api(s, "/api/audit")).json()).map((a) => a.action);
check("audit log recorded the changes", audit.includes("feature") && audit.includes("content_create"));

await api(s, "/api/logout", { method: "POST" });
check("logout revokes the session", (await api(s, "/api/me")).status === 401);

if (process.env.SKIP_RATE_LIMIT !== "1") {
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.STAGING_EMAIL, password: "wrong-password-" + i }) })).status;
  check("login rate limit (6th wrong attempt blocked)", last === 429, String(last));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
