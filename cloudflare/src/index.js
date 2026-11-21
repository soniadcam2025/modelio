// Shakhira admin dashboard + send-only automation as a Cloudflare Worker (staging).
// Same /api routes as dashboard/app.py, so the dashboard frontend is shared unchanged.

import { LoginLimiter, Sessions, readCookie, verifyPassword } from "./auth.js";
import { FEATURES, JOIN_POLICIES, Ops, OpsError, TARGETS } from "./ops.js";
import { runCycle } from "./scheduler.js";
import { SendOnlyTelegram } from "./telegram.js";
import { cloudinaryConfig, GITHUB_POSTER_FOLDER, libraryEntries, listFolder, posterInventory } from "./cloudinary.js";
import BUNDLED_ASSETS from "./assets.generated.js";

const SESSION_COOKIE = "sb_session";
export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; media-src https:; style-src 'self'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000",
  "X-Robots-Tag": "noindex, nofollow",
};

export function loadConfig(env) {
  const slots = String(env.POST_SLOTS_UTC || "16:30,23:30").split(",").map((s) => s.trim()).filter(Boolean)
    .map((s) => s.split(":").map(Number));
  return {
    environment: env.ENVIRONMENT || "staging",
    requirePreview: String(env.REQUIRE_PREVIEW || "true").toLowerCase() === "true",
    previewChatId: String(env.PREVIEW_CHAT_ID || "").trim() || null,
    publicChannel: env.PUBLIC_CHANNEL || "@yourshakhira",
    vipChannelId: String(env.VIP_CHANNEL_ID || "").trim() || null,
    botUsername: env.BOT_USERNAME || "ShakhiraVIPBot",
    slotTimes: slots,
    adminName: "admin",
  };
}

export function automationMode(env, config) {
  if (!env.BOT_TOKEN) return "simulated";
  if (config.previewChatId) return "preview";
  return config.requirePreview ? "locked" : "live";
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (message, status) => json(status === 400 ? { error: message } : { detail: message }, status);

function withHeaders(response, isApi) {
  const r = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v);
  if (isApi) r.headers.set("Cache-Control", "no-store");
  return r;
}

export function csvSafe(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return ["=", "+", "-", "@", "\t", "\r"].includes(text[0]) ? "'" + text : text;
}
const csvCell = (v) => { const s = csvSafe(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

function slotLabel([h, m]) {
  const total = (h * 60 + m + 330) % 1440;
  const hh = Math.floor(total / 60), mm = total % 60;
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"} IST`;
}
const contentOut = (i) => ({ ...i, options: JSON.parse(i.options_json || "[]"), poll_results: i.poll_results_json ? JSON.parse(i.poll_results_json) : null });

async function body(request) {
  try { return (await request.json()) || {}; } catch { return {}; }
}

function routes() {
  const r = [];
  const add = (method, pattern, handler, { auth = true } = {}) => r.push({ method, re: new RegExp(`^${pattern}$`), handler, auth });

  add("GET", "/api/health", async (c) => json({ ok: true, environment: c.config.environment, automation: automationMode(c.env, c.config) }), { auth: false });
  add("POST", "/api/login", async (c) => {
    const client = c.request.headers.get("cf-connecting-ip") || "unknown";
    if (await c.limiter.blocked(client)) return err("Too many attempts. Wait 15 minutes.", 429);
    const b = await body(c.request);
    if (!(await verifyPassword(String(b.password ?? ""), c.env.DASHBOARD_PASSWORD_HASH || ""))) {
      await c.limiter.failed(client);
      return err("Wrong password", 401);
    }
    await c.limiter.succeeded(client);
    const token = await c.sessions.issue();
    const res = json({ user: c.config.adminName, csrf: await c.sessions.csrfFor(token) });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=${token}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return res;
  }, { auth: false });
  add("POST", "/api/logout", async (c) => {
    await c.sessions.revoke(c.token);
    const res = json({ ok: true });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return res;
  });
  add("GET", "/api/me", async (c) => json({ user: c.config.adminName, csrf: await c.sessions.csrfFor(c.token),
    capabilities: ["post_expiry", "paid_media_automation"], environment: c.config.environment, automation: automationMode(c.env, c.config) }));

  add("GET", "/api/overview", async (c) => {
    const now = c.ops.now(), stats = await c.ops.analytics(now, 30);
    const upcoming = (await c.ops.contentList({ status: "scheduled" })).filter((i) => i.scheduled_at).sort((a, b) => a.scheduled_at - b.scheduled_at);
    const attention = [...(await c.ops.contentList({ status: "failed" })), ...(await c.ops.contentList({ status: "uncertain" }))];
    const people = await c.ops.subscribers("", now, 100000);
    const hb = await c.ops.getSetting("heartbeat:worker");
    return json({
      now, stars_30d: stats.stars_total, revenue_by_day: stats.revenue_by_day, trials: stats.trials,
      members: Object.fromEntries(["monthly", "trial", "left", "none"].map((k) => [k, people.filter((p) => p.membership === k).length])),
      scheduled_count: upcoming.length, upcoming: upcoming.slice(0, 6).map(contentOut), attention: attention.slice(0, 10).map(contentOut),
      join_pending: (await c.ops.joinRequests("pending")).length, actions_queued: (await c.ops.queuedActions()).length,
      features: await c.ops.features(), worker_last_seen: hb ? Number(hb) : null, poster_slots_ist: c.config.slotTimes.map(slotLabel),
      environment: c.config.environment, automation: automationMode(c.env, c.config),
    });
  });

  add("GET", "/api/content", async (c) => json((await c.ops.contentList({ status: c.url.searchParams.get("status") || null })).map(contentOut)));
  add("POST", "/api/content", async (c) => {
    const b = await body(c.request);
    let item = await c.ops.createContent(b, c.actor);
    if (b.schedule) item = await c.ops.scheduleContent(item.id, b.scheduled_at, c.actor);
    return json(contentOut(item));
  });
  add("PUT", "/api/content/(\\d+)", async (c, m) => json(contentOut(await c.ops.updateContent(m[1], await body(c.request), c.actor))));
  add("POST", "/api/content/(\\d+)/schedule", async (c, m) => json(contentOut(await c.ops.scheduleContent(m[1], (await body(c.request)).scheduled_at, c.actor))));
  add("POST", "/api/content/(\\d+)/cancel", async (c, m) => json(contentOut(await c.ops.cancelContent(m[1], c.actor))));
  add("POST", "/api/content/(\\d+)/duplicate", async (c, m) => json(contentOut(await c.ops.duplicateContent(m[1], c.actor))));
  add("DELETE", "/api/content/(\\d+)", async (c, m) => { await c.ops.deleteContent(m[1], c.actor); return json({ ok: true }); });

  add("GET", "/api/calendar", async (c) => {
    const start = Number(c.url.searchParams.get("start")), end = Number(c.url.searchParams.get("end"));
    if (!(end > start) || end - start > 62 * 86400) throw new OpsError("Choose a range of up to 62 days");
    const items = (await c.ops.contentList({ start, end })).filter((i) => i.status !== "cancelled").map(contentOut);
    const slots = [];
    for (let day = Math.floor(start / 86400) * 86400; day < end; day += 86400)
      for (const [h, mi] of c.config.slotTimes) { const at = day + h * 3600 + mi * 60; if (at >= start && at < end) slots.push({ at, label: "Cloudinary auto-post (GitHub)" }); }
    return json({ items, poster_slots: slots });
  });

  add("GET", "/api/captions", async (c) => json(await c.ops.captions()));
  add("POST", "/api/captions", async (c) => json(await c.ops.addCaption((await body(c.request)).text, c.actor)));
  add("PUT", "/api/captions/(\\d+)", async (c, m) => { await c.ops.setCaptionActive(m[1], !!(await body(c.request)).active, c.actor); return json({ ok: true }); });
  add("DELETE", "/api/captions/(\\d+)", async (c, m) => { await c.ops.deleteCaption(m[1], c.actor); return json({ ok: true }); });

  add("GET", "/api/subscribers", async (c) => json(await c.ops.subscribers(c.url.searchParams.get("q") || "")));
  add("GET", "/api/subscribers/(\\d+)", async (c, m) => json(await c.ops.subscriber(Number(m[1]), c.ops.now())));
  add("PUT", "/api/subscribers/(\\d+)", async (c, m) => { const b = await body(c.request); return json(await c.ops.updateProfile(Number(m[1]), b.tags, b.notes, c.actor)); });
  add("GET", "/api/export/subscribers.csv", async (c) => {
    const cols = ["user_id", "username", "first_name", "membership", "subscription_until", "trial_expires_at", "stars_paid", "source", "tags", "first_seen", "last_seen"];
    const rows = [cols.join(","), ...(await c.ops.subscribers("", c.ops.now(), 100000)).map((p) => cols.map((k) => csvCell(p[k])).join(","))];
    await c.ops.audit(c.actor, "export", "subscribers.csv");
    return new Response(rows.join("\r\n") + "\r\n", { headers: { "content-type": "text/csv", "content-disposition": "attachment; filename=subscribers.csv" } });
  });

  add("GET", "/api/join-requests", async (c) => { const s = c.url.searchParams.get("status") || "pending"; return json(await c.ops.joinRequests(s === "all" ? null : s)); });
  add("GET", "/api/actions", async (c) => json((await c.ops.actions()).map((a) => ({ ...a, payload: JSON.parse(a.payload_json) }))));
  add("POST", "/api/actions", async (c) => { const b = await body(c.request); return json(await c.ops.queueAction(String(b.kind || ""), b.payload || {}, c.actor)); });

  add("GET", "/api/moderation", async (c) => json({ rules: await c.ops.moderationRules(), log: await c.ops.moderationLog() }));
  add("POST", "/api/moderation/rules", async (c) => { const b = await body(c.request); return json(await c.ops.addModerationRule(String(b.kind || ""), String(b.pattern || ""), String(b.action || ""), c.actor)); });
  add("DELETE", "/api/moderation/rules/(\\d+)", async (c, m) => { await c.ops.deleteModerationRule(m[1], c.actor); return json({ ok: true }); });

  add("GET", "/api/analytics", async (c) => json(await c.ops.analytics(c.ops.now(), Math.max(1, Math.min(Number(c.url.searchParams.get("days")) || 30, 365)))));
  add("GET", "/api/settings", async (c) => json({
    features: await c.ops.features(), join_policies: Object.fromEntries(await Promise.all(TARGETS.map(async (t) => [t, await c.ops.joinPolicy(t)]))),
    join_policy_options: JOIN_POLICIES, public_channel: c.config.publicChannel,
  }));
  add("PUT", "/api/settings/features/(\\w+)", async (c, m) => {
    if (!(m[1] in FEATURES)) return err("Unknown feature", 404);
    await c.ops.setFeature(m[1], !!(await body(c.request)).enabled, c.actor);
    return json((await c.ops.features())[m[1]]);
  });
  add("PUT", "/api/settings/join-policy/(\\w+)", async (c, m) => {
    await c.ops.setJoinPolicy(m[1], String((await body(c.request)).policy || ""), c.actor);
    return json({ target: m[1], policy: await c.ops.joinPolicy(m[1]) });
  });
  add("GET", "/api/audit", async (c) => json(await c.ops.auditEntries()));
  add("GET", "/api/settings/paid-media", async (c) => json(await c.ops.paidMediaConfig()));
  add("PUT", "/api/settings/paid-media", async (c) => json(await c.ops.setPaidMediaConfig(await body(c.request), c.actor)));

  // Read-only view of the GitHub poster's Cloudinary folder (and the paid-media folder, if set).
  add("GET", "/api/poster", async (c) => {
    const cfg = cloudinaryConfig(c.env);
    if (!cfg) return json({ configured: false });
    try {
      const assets = await listFolder(cfg, GITHUB_POSTER_FOLDER);
      const paid = await c.ops.paidMediaConfig();
      let paidFolder = null;
      if (paid.folder) {
        const pa = await listFolder(cfg, paid.folder);
        const used = new Set((await c.ops.all("SELECT public_id FROM auto_paid_posted")).map((r) => r.public_id));
        paidFolder = { folder: paid.folder, total: pa.length, unused: pa.filter((a) => !used.has(a.public_id)).length };
      }
      return json({ configured: true, folder: GITHUB_POSTER_FOLDER, inventory: posterInventory(assets, c.ops.now()),
        recent_slots: [], library: libraryEntries(assets), paid_folder: paidFolder });
    } catch (e) {
      return json({ configured: true, error: String(e.message).slice(0, 200) });
    }
  });
  return r;
}
const ROUTES = routes();

export async function handleApi(request, env, now = () => Math.floor(Date.now() / 1000)) {
  const url = new URL(request.url);
  const route = ROUTES.find((rt) => rt.method === request.method && rt.re.test(url.pathname));
  if (!route) return err("Not found", 404);
  const config = loadConfig(env);
  let sessions;
  try { sessions = new Sessions(env.DASHBOARD_SECRET, env.DB, now); } catch (e) { return err("Dashboard is not configured: " + e.message, 503); }
  const c = { request, env, url, config, sessions, limiter: new LoginLimiter(env.DB, now), ops: new Ops(env.DB, now), actor: config.adminName, token: null };
  if (route.auth) {
    c.token = readCookie(request, SESSION_COOKIE);
    if (!(await sessions.valid(c.token))) return err("Please sign in", 401);
    if (!["GET", "HEAD"].includes(request.method)) {
      const sent = request.headers.get("x-csrf-token") || "";
      if (!sent || sent !== (await sessions.csrfFor(c.token))) return err("Security check failed; reload the page", 403);
    }
  }
  try {
    return await route.handler(c, url.pathname.match(route.re));
  } catch (e) {
    if (e instanceof OpsError) return err(e.message, 400);
    console.error("API error", e);
    return err("Something went wrong", 500);
  }
}

export async function runScheduled(env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch) {
  const config = loadConfig(env);
  const mode = automationMode(env, config);
  if (mode === "locked") {
    console.warn("Staging lock: BOT_TOKEN is set but PREVIEW_CHAT_ID is not; automation paused");
    await new Ops(env.DB).setSetting("heartbeat:worker", now);
    return { mode };
  }
  const tg = new SendOnlyTelegram({ token: env.BOT_TOKEN, previewChatId: config.previewChatId, requirePreview: config.requirePreview, fetchImpl });
  const cfg = cloudinaryConfig(env);
  const listAssets = cfg ? (folder) => listFolder(cfg, folder, fetchImpl) : null;
  const summary = await runCycle(tg, new Ops(env.DB, () => now), config, now, async (msg) => console.warn("ALERT", msg), { listAssets });
  return { mode, summary, simulated: tg.simulated.length };
}

export function serveStatic(request, env) {
  if (env.ASSETS) return env.ASSETS.fetch(request);
  const { pathname } = new URL(request.url);
  const file = BUNDLED_ASSETS[pathname] || (pathname === "/index.html" ? BUNDLED_ASSETS["/"] : null);
  if (!file || !["GET", "HEAD"].includes(request.method)) return new Response("Not found", { status: 404 });
  return new Response(request.method === "HEAD" ? null : file.body, {
    headers: { "content-type": file.type, "cache-control": pathname === "/" ? "no-cache" : "public, max-age=300" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith("/api/");
    const response = isApi ? await handleApi(request, env) : await serveStatic(request, env);
    return withHeaders(response, isApi);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runScheduled(env).then((r) => console.log("cycle", JSON.stringify(r))));
  },
};
