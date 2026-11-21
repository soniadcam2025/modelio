// Live checks for post expiry and paid-media automation on the DEPLOYED staging Worker (simulation only).
//   STAGING_URL=... STAGING_PASSWORD=... node test/remote/staging-features.mjs
const BASE = process.env.STAGING_URL, PW = process.env.STAGING_PASSWORD;
if (!BASE || !BASE.includes("staging")) { console.error("Refusing: STAGING_URL must be the staging Worker"); process.exit(2); }
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const r = await fetch(BASE + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: PW }) });
const s = { cookie: r.headers.get("set-cookie").split(";")[0], csrf: (await r.json()).csrf };
const api = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", cookie: s.cookie, "x-csrf-token": s.csrf },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const health = (await (await fetch(BASE + "/api/health")).json());
check("still simulation-only", health.automation === "simulated");
check("capabilities advertised", JSON.stringify((await api("/api/me")).body.capabilities) === '["post_expiry","paid_media_automation"]');
const feats = (await api("/api/settings")).body.features;
check("new features exist and start OFF", feats.post_expiry?.enabled === false && feats.auto_paid_media?.enabled === false);

const put = (b) => api("/api/settings/paid-media", { method: "PUT", body: { default_stars: 50, target: "vip", times_utc: [], ...b } });
check("paid media: tgpub folder refused", /separate folder/.test((await put({ folder: "tgpub" })).body.error || ""));
check("paid media: price 0 refused", /1 to 10,000/.test((await put({ default_stars: 0 })).body.error || ""));
check("paid media: expiry over 48 h refused", /48 hours/.test((await put({ expire_after_minutes: 3000 })).body.error || ""));
const saved = await put({ default_stars: 75, folder: "vip_drops", times_utc: "16:00", expire_after_minutes: 60 });
check("paid media: valid settings saved", saved.status === 200 && saved.body.default_stars === 75 && saved.body.folder === "vip_drops");
check("paid media: settings persist in D1", (await api("/api/settings/paid-media")).body.default_stars === 75);
check("media library reports Cloudinary not connected (no keys on staging)", (await api("/api/poster")).body.configured === false);
check("expiry over 48 h refused on a post", /48 hours/.test((await api("/api/content", { method: "POST", body: { kind: "text", target: "public", text: "x", expire_after_minutes: 3000 } })).body.error || ""));

const tag = `[expiry test ${new Date().toISOString().slice(11, 16)}Z]`;
const now = Math.floor(Date.now() / 1000);
const post = (await api("/api/content", { method: "POST", body: { kind: "paid_media", target: "vip", media_url: "https://res.cloudinary.com/demo/image/upload/sample.jpg",
  star_count: 40, text: tag, expire_after_minutes: 5, schedule: true, scheduled_at: now - 5 } })).body;
check("expiring paid-media post created (40 Stars, 5 min)", post.expire_after_minutes === 5 && post.star_count === 40);
for (const f of ["scheduled_posts", "post_expiry"]) await api(`/api/settings/features/${f}`, { method: "PUT", body: { enabled: true } });
console.log("Waiting for publish, then 5 minutes for expiry…");
let item;
for (let i = 0; i < 48; i++) {
  await new Promise((res) => setTimeout(res, 10000));
  item = (await api("/api/content")).body.find((x) => x.id === post.id);
  if (item?.expired_at) break;
}
check("published in simulation", item?.status === "simulated", item?.status);
check("expired on time (5 min after posting)", item?.expired_at && item.expired_at - item.posted_at >= 300 && item.expired_at - item.posted_at < 420,
  item ? `posted ${item.posted_at}, expired ${item.expired_at}` : "missing");

for (const f of ["scheduled_posts", "post_expiry", "auto_paid_media"]) await api(`/api/settings/features/${f}`, { method: "PUT", body: { enabled: false } });
await put({ default_stars: 50, folder: "", times_utc: [], expire_after_minutes: null });
check("all features OFF again and automation cleared", Object.values((await api("/api/settings")).body.features).every((f) => !f.enabled)
  && (await api("/api/settings/paid-media")).body.folder === "");
await api("/api/logout", { method: "POST" });
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
