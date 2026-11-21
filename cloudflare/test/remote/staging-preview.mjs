// PRIVATE PREVIEW test: sends one of each post type ONLY to the owner's private chat with the bot.
// Runs only when staging reports automation "preview" (BOT_TOKEN + PREVIEW_CHAT_ID set, REQUIRE_PREVIEW on).
//   STAGING_URL=... STAGING_PASSWORD=... node test/remote/staging-preview.mjs
const BASE = process.env.STAGING_URL, PW = process.env.STAGING_PASSWORD;
const health = await (await fetch(BASE + "/api/health")).json();
if (!BASE?.includes("staging") || health.environment !== "staging" || health.automation !== "preview") {
  console.error(`Refusing: staging must be in preview mode (got ${JSON.stringify(health)})`); process.exit(2);
}
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: process.env.STAGING_EMAIL, password: PW }) });
const s = { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
const api = async (path, { method = "GET", body } = {}) => (await fetch(BASE + path, { method,
  headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": s.csrf }, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const tag = "🧪 Shakhira PREVIEW test (only you can see this)";
const now = Math.floor(Date.now() / 1000);
const posts = [
  { kind: "text", target: "public", text: `${tag}: text post`, button_text: "Open channel", button_url: "https://t.me/yourshakhira" },
  { kind: "photo", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", text: `${tag}: photo` },
  { kind: "video", target: "vip", media_url: "https://res.cloudinary.com/demo/video/upload/dog.mp4", text: `${tag}: video` },
  { kind: "animation", target: "public", media_url: "https://res.cloudinary.com/demo/image/upload/kitten.gif", text: `${tag}: GIF` },
  { kind: "poll", target: "public", text: `${tag}: which look next?`, options: ["Red", "Black", "Denim"], close_after_minutes: 10 },
  { kind: "quiz", target: "public", text: `${tag}: favourite city?`, options: ["Mumbai", "Goa"], correct_option: 1, explanation: "Goa!" },
  { kind: "promo", target: "public", text: `${tag}: 💎 VIP trial, 3 days for 49 ⭐` },
  { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg", star_count: 1, text: `${tag}: paid media (1 ⭐)`, expire_after_minutes: 30 },
];
const ids = [];
for (const p of posts) ids.push((await api("/api/content", { method: "POST", body: { ...p, schedule: true, scheduled_at: now - 5 } })).id);
for (const f of ["scheduled_posts", "poll_auto_close", "post_expiry"]) await api(`/api/settings/features/${f}`, { method: "PUT", body: { enabled: true } });
console.log("Waiting for the cron to send them to your private chat…");
let items = [];
for (let i = 0; i < 18; i++) {
  await new Promise((res) => setTimeout(res, 10000));
  items = (await api("/api/content")).filter((x) => ids.includes(x.id));
  if (items.every((x) => x.status !== "scheduled" && x.status !== "sending")) break;
}
for (const p of posts) {
  const it = items.find((x) => x.text?.startsWith(tag) && x.kind === p.kind);
  check(`${p.kind} delivered to the preview chat`, it?.status === "posted" && it.message_id > 0, it ? `${it.status} ${it.message_id ?? ""} ${it.last_error}` : "missing");
}
console.log("Leaving poll close (10 min) and paid-media deletion (30 min) running; switch features off in the dashboard afterwards, or run this again with CLEANUP=1.");
if (process.env.CLEANUP === "1") for (const f of ["scheduled_posts", "poll_auto_close", "post_expiry"]) await api(`/api/settings/features/${f}`, { method: "PUT", body: { enabled: false } });
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
