// Shakhira admin dashboard + send-only automation as a Cloudflare Worker (staging).
// Same /api routes as dashboard/app.py, so the dashboard frontend is shared unchanged.

import { LoginLimiter, Sessions, constantTimeEqual, readCookie, verifyPassword } from "./auth.js";
import { SupabaseDB } from "./pg.js";
import { runBackup } from "./backup.js";
import { syncLiveBot } from "./live.js";
import { handleUpdate, verifyUpdate } from "./updates.js";
import { FEATURES, JOIN_POLICIES, Ops, OpsError, TARGETS } from "./ops.js";
import { runCycle } from "./scheduler.js";
import { SendOnlyTelegram } from "./telegram.js";
import { cloudinaryConfig, GITHUB_POSTER_FOLDER, libraryEntries, listFolder, posterInventory } from "./cloudinary.js";
import BUNDLED_ASSETS from "./assets.generated.js";

const SESSION_COOKIE = "sb_session";

// The database: Supabase (Postgres) when its URL and secret key are configured, otherwise the Worker's D1 binding.
export function getDB(env) {
  if (env.SUPABASE_URL && env.SUPABASE_SECRET_KEY) {
    env.__pg ||= new SupabaseDB({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
    return env.__pg;
  }
  if (!env.DB) throw new Error("No database configured");
  return env.DB;
}
const authMode = (env) => (String(env.AUTH_MODE || "").toLowerCase() === "supabase" && env.SUPABASE_URL ? "supabase" : "password");

// The caller's address for the login limiter: Cloudflare's or Vercel's own header (both set by the platform, not the client).
function clientAddress(request) {
  const h = request.headers;
  return h.get("cf-connecting-ip") || h.get("x-real-ip") || (h.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}

// Supabase Auth: password grant, then require app_metadata.shakhira_admin (set only by the service key, never by users).
async function supabaseSignIn(env, email, password, fetchImpl = fetch) {
  const res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { "content-type": "application/json", apikey: env.SUPABASE_SECRET_KEY },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.user?.app_metadata?.shakhira_admin === true ? data.user : null;
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Signed request from the Cloudflare cron to the Vercel backend: HMAC(CYCLE_SECRET, "cycle:<unix time>"), valid for 2 minutes.
export async function signCycle(secret, now = Math.floor(Date.now() / 1000)) {
  return { "x-cycle-time": String(now), "x-cycle-signature": await hmacHex(secret, `cycle:${now}`) };
}
async function cycleAuthorized(request, env, now) {
  if (!env.CYCLE_SECRET || env.CYCLE_SECRET.length < 32) return false;
  const t = Number(request.headers.get("x-cycle-time"));
  if (!Number.isInteger(t) || Math.abs(now - t) > 120) return false;
  return constantTimeEqual(request.headers.get("x-cycle-signature") || "", await hmacHex(env.CYCLE_SECRET, `cycle:${t}`));
}
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
    discussionGroupId: String(env.DISCUSSION_GROUP_ID || "").trim() || null,
    adminChatId: String(env.ADMIN_CHAT_ID || "").trim() || null,
    monthlyPrice: 499,
    trialPrice: 49,
    // Daily backup minute (UTC "HH:MM"); 21:40 UTC = 03:10 IST, away from the 5 AM / 10 PM IST posts.
    backupAt: String(env.BACKUP_AT_UTC || "21:40"),
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

  add("GET", "/api/health", async (c) => {
    const database = { kind: c.env.SUPABASE_URL && c.env.SUPABASE_SECRET_KEY ? "supabase" : "d1", ok: false };
    try { const t0 = Date.now(); await c.ops.one("SELECT 1 AS ok"); database.ok = true; database.ms = Date.now() - t0; } catch { /* reported as ok:false */ }
    const [hb, backup, sync] = database.ok ? await Promise.all(["heartbeat:worker", "backup:last", "live_sync:last"].map((k) => c.ops.getSetting(k).catch(() => null))) : [];
    const n = (v) => (v ? Number(v) : null);
    return json({ ok: database.ok, environment: c.config.environment, automation: automationMode(c.env, c.config), auth: authMode(c.env),
      database, scheduler_last_seen: n(hb), backup_last: n(backup), member_sync_last: n(sync),
      backup_configured: !!c.env.BACKUP_DB, live_bot_linked: !!c.env.LIVE_DB }, database.ok ? 200 : 503);
  }, { auth: false });
  add("POST", "/api/login", async (c) => {
    const client = clientAddress(c.request);
    if (await c.limiter.blocked(client)) return err("Too many attempts. Wait 15 minutes.", 429);
    const b = await body(c.request);
    let who = c.config.adminName;
    if (authMode(c.env) === "supabase") {
      const email = String(b.email ?? "").trim().toLowerCase().slice(0, 200);
      const user = email ? await supabaseSignIn(c.env, email, String(b.password ?? "").slice(0, 200)) : null;
      if (!user) { await c.limiter.failed(client); return err("Wrong email or password", 401); }
      who = email;
    } else if (!(await verifyPassword(String(b.password ?? ""), c.env.DASHBOARD_PASSWORD_HASH || ""))) {
      await c.limiter.failed(client);
      return err("Wrong password", 401);
    }
    await c.limiter.succeeded(client);
    await c.ops.audit(who, "login", `from ${client}`);
    const token = await c.sessions.issue();
    const res = json({ user: c.config.adminName, csrf: await c.sessions.csrfFor(token) });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=${token}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return res;
  }, { auth: false });
  // Cron hand-off from the Cloudflare staging Worker (one signed request per minute) so the cycle runs next to the database.
  add("POST", "/api/internal/cycle", async (c) => {
    if (!(await cycleAuthorized(c.request, c.env, Math.floor(Date.now() / 1000)))) return err("Not allowed", 403);
    return json(await runScheduled(c.env));
  }, { auth: false });
  // Read-only view of the bot and both channels (needs BOT_TOKEN; uses only get* methods).
  add("GET", "/api/telegram", async (c) => {
    if (!c.env.BOT_TOKEN) return json({ configured: false });
    const tg = new SendOnlyTelegram({ token: c.env.BOT_TOKEN, previewChatId: c.config.previewChatId, requirePreview: c.config.requirePreview });
    const safe = (p) => p.then((v) => v).catch((e) => ({ error: String(e.message).slice(0, 120) }));
    const channel = async (chatId) => {
      if (!chatId) return null;
      const [chat, members] = await Promise.all([safe(tg.call("getChat", { chat_id: chatId })), safe(tg.call("getChatMemberCount", { chat_id: chatId }))]);
      return chat.error ? { error: chat.error } : { title: chat.title, type: chat.type, username: chat.username || null, members: typeof members === "number" ? members : null };
    };
    const [me, hook, pub, vip] = await Promise.all([safe(tg.call("getMe", {})), safe(tg.call("getWebhookInfo", {})),
      channel(c.config.publicChannel), channel(c.config.vipChannelId)]);
    return json({
      configured: true,
      bot: me.error ? me : { username: me.username, name: me.first_name, can_join_groups: me.can_join_groups },
      // Only whether a webhook is set and its health; the URL itself is not shown.
      webhook: hook.error ? hook : { set: !!hook.url, pending_updates: hook.pending_update_count ?? 0, last_error_at: hook.last_error_date || null,
        last_error: hook.last_error_message || null, allowed_updates: hook.allowed_updates || [] },
      channels: { public: pub, vip },
    });
  });
  // On-demand copy to the backup D1 (the same as the daily 03:10 IST backup).
  add("POST", "/api/backup/now", async (c) => {
    if (!c.env.BACKUP_DB) throw new OpsError("No backup database is linked to this deployment");
    const r = await runBackup(c.ops, c.env.BACKUP_DB, c.ops.now());
    await c.ops.audit(c.actor, "backup_now", `${r.rows} rows, ${r.bytes} bytes, id ${r.backup_id}`);
    return json(r);
  });
  add("GET", "/api/backup/log", async (c) => json(await c.ops.all("SELECT * FROM backups_log ORDER BY id DESC LIMIT 30")));
  // Backup: download every dashboard table as JSON.
  add("GET", "/api/backup", async (c) => {
    const data = await c.ops.exportAll();
    await c.ops.audit(c.actor, "backup_export", Object.entries(data.tables).map(([t, r]) => `${t}:${r.length}`).join(" ").slice(0, 500));
    const res = json(data);
    res.headers.set("Content-Disposition", `attachment; filename="shakhira-backup-${new Date(data.exported_at * 1000).toISOString().slice(0, 10)}.json"`);
    return res;
  });
  add("POST", "/api/logout", async (c) => {
    await c.sessions.revoke(c.token);
    const res = json({ ok: true });
    res.headers.set("Set-Cookie", `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
    return res;
  });
  add("GET", "/api/me", async (c) => json({ user: c.config.adminName, csrf: await c.sessions.csrfFor(c.token),
    capabilities: ["post_expiry", "paid_media_automation", "hashtags", "backup", "member_sync", "telegram_status"], environment: c.config.environment, automation: automationMode(c.env, c.config) }));

  add("GET", "/api/overview", async (c) => {
    const now = c.ops.now();
    // Independent reads, run together (each is a network round trip on Supabase).
    const [stats, scheduled, failed, uncertain, people, hb, joinPending, queued, features] = await Promise.all([
      c.ops.analytics(now, 30), c.ops.contentList({ status: "scheduled" }), c.ops.contentList({ status: "failed" }),
      c.ops.contentList({ status: "uncertain" }), c.ops.subscribers("", now, 100000), c.ops.getSetting("heartbeat:worker"),
      c.ops.joinRequests("pending"), c.ops.queuedActions(), c.ops.features()]);
    const upcoming = scheduled.filter((i) => i.scheduled_at).sort((a, b) => a.scheduled_at - b.scheduled_at);
    const attention = [...failed, ...uncertain];
    return json({
      now, stars_30d: stats.stars_total, revenue_by_day: stats.revenue_by_day, trials: stats.trials,
      members: Object.fromEntries(["monthly", "trial", "left", "none"].map((k) => [k, people.filter((p) => p.membership === k).length])),
      scheduled_count: upcoming.length, upcoming: upcoming.slice(0, 6).map(contentOut), attention: attention.slice(0, 10).map(contentOut),
      join_pending: joinPending.length, actions_queued: queued.length,
      features, worker_last_seen: hb ? Number(hb) : null, poster_slots_ist: c.config.slotTimes.map(slotLabel),
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
  add("GET", "/api/settings", async (c) => {
    const [features, ...policies] = await Promise.all([c.ops.features(), ...TARGETS.map((t) => c.ops.joinPolicy(t))]);
    return json({ features, join_policies: Object.fromEntries(TARGETS.map((t, i) => [t, policies[i]])),
      join_policy_options: JOIN_POLICIES, public_channel: c.config.publicChannel });
  });
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
  let sessions, db;
  try { db = getDB(env); sessions = new Sessions(env.DASHBOARD_SECRET, db, now); } catch (e) { return err("Dashboard is not configured: " + e.message, 503); }
  const c = { request, env, url, config, sessions, limiter: new LoginLimiter(db, now), ops: new Ops(db, now), actor: config.adminName, token: null };
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

// Alerts go to ADMIN_CHAT_ID (an admin's own Telegram chat), at most one per key per hour; otherwise to the log.
function makeAlert(tg, ops, config, now) {
  return async (msg, key = "general") => {
    console.warn("ALERT", msg);
    if (!config.adminChatId || tg.simulating) return;
    const claim = await ops.run("INSERT INTO reminders_sent (key, sent_at) VALUES (?, ?) ON CONFLICT DO NOTHING", `alert:${key}:${Math.floor(now / 3600)}`, now);
    if (claim.meta.changes === 1) await tg.call("sendMessage", { chat_id: config.adminChatId, text: `⚠️ Shakhira: ${msg}` }).catch(() => {});
  };
}

export async function runScheduled(env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch) {
  const config = loadConfig(env);
  const mode = automationMode(env, config);
  const ops = new Ops(getDB(env), () => now);
  const tg = new SendOnlyTelegram({ token: env.BOT_TOKEN, previewChatId: config.previewChatId, requirePreview: config.requirePreview, fetchImpl });
  if (mode === "locked") {
    // A token without a preview chat: nothing is sent, but read-only work (member sync, backups) continues.
    await ops.setSetting("heartbeat:worker", now);
    const out = { mode };
    if (env.BACKUP_DB && new Date(now * 1000).toISOString().slice(11, 16) === config.backupAt) out.backup = await runBackup(ops, env.BACKUP_DB, now).catch((e) => ({ error: e.message }));
    else if (env.LIVE_DB && (await ops.featureEnabled("member_sync"))) out.member_sync = await syncLiveBot(env.LIVE_DB, ops, now).catch((e) => ({ error: e.message }));
    return out;
  }
  const cfg = cloudinaryConfig(env);
  const listAssets = cfg ? (folder) => listFolder(cfg, folder, fetchImpl) : null;
  const hhmm = new Date(now * 1000).toISOString().slice(11, 16);
  if (env.BACKUP_DB && hhmm === config.backupAt) {
    // The backup gets its own run (no posting in the same minute) to stay inside the per-run request limit.
    try { return { mode, backup: await runBackup(ops, env.BACKUP_DB, now) }; }
    catch (e) { await makeAlert(tg, ops, config, now)(`Daily backup failed: ${e.message}`, "backup"); return { mode, backup_error: e.message }; }
  }
  const summary = await runCycle(tg, ops, config, now, makeAlert(tg, ops, config, now), { listAssets, liveDb: env.LIVE_DB || null });
  return { mode, summary, simulated: tg.simulated.length };
}

// A copy of one Telegram update, forwarded by the live bot (service binding or HTTPS) and signed with UPDATE_SECRET.
export async function receiveForwardedUpdate(request, env, now = Math.floor(Date.now() / 1000)) {
  const body = await request.text();
  if (body.length > 200_000 || !(await verifyUpdate(env.UPDATE_SECRET, request.headers, body, now))) return err("Not allowed", 403);
  let update;
  try { update = JSON.parse(body); } catch { return err("Invalid JSON", 400); }
  const config = loadConfig(env);
  const ops = new Ops(getDB(env), () => now);
  const tg = new SendOnlyTelegram({ token: env.BOT_TOKEN, previewChatId: config.previewChatId, requirePreview: config.requirePreview });
  try {
    return json({ result: await handleUpdate(update, { ops, tg, config, now, alert: makeAlert(tg, ops, config, now) }) });
  } catch (e) {
    console.error("update error", e.message);
    return err("Temporary failure", 503); // the live bot ignores this; it never affects members
  }
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
    if (url.pathname === "/internal/update" && request.method === "POST") return withHeaders(await receiveForwardedUpdate(request, env), true);
    const isApi = url.pathname.startsWith("/api/");
    const response = isApi ? await handleApi(request, env) : await serveStatic(request, env);
    return withHeaders(response, isApi);
  },
  async scheduled(_event, env, ctx) {
    // With CYCLE_URL set, this Worker is only the clock: it asks the Vercel backend (next to Supabase) to run the cycle.
    if (env.CYCLE_URL && env.CYCLE_SECRET) {
      ctx.waitUntil(fetch(env.CYCLE_URL, { method: "POST", headers: await signCycle(env.CYCLE_SECRET) })
        .then(async (r) => console.log("cycle via backend", r.status, (await r.text()).slice(0, 300))));
      return;
    }
    ctx.waitUntil(runScheduled(env).then((r) => console.log("cycle", JSON.stringify(r))));
  },
};
