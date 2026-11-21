// Content queue, captions, profiles, join requests, admin actions, moderation, analytics, audit, features.
// A port of shakhira_bot/ops.py for Cloudflare D1. Validation rules and messages are the same.

export const CONTENT_KINDS = ["text", "photo", "video", "animation", "poll", "quiz", "promo", "paid_media"];
export const TARGETS = ["public", "vip"];
export const ACTION_KINDS = ["approve_join", "decline_join", "remove_member", "unban_member", "send_dm", "close_poll"];
export const MODERATION_KINDS = ["word", "link"];
export const MODERATION_ACTIONS = ["delete", "delete_warn", "delete_mute"];
export const JOIN_POLICIES = ["manual", "approve_paid", "approve_all"];
// Every feature is OFF until switched on in the dashboard.
export const FEATURES = {
  scheduled_posts: "Publish scheduled posts, polls, quizzes, promotions and paid media",
  poll_auto_close: "Close polls after their set time and save the results",
  trial_reminders: "Remind trial members 24 hours before their trial ends",
  renewal_reminders: "Remind monthly subscribers 3 days before Telegram renews them",
  admin_actions: "Carry out admin actions queued in the dashboard (approve, remove, unban, message)",
  join_requests: "Record join requests to the channels (via the live bot; approval L8)",
  moderation: "Moderate the channel's existing discussion group, if it has one (via the live bot; approval L8)",
  reaction_tracking: "Record reaction counts on channel posts (via the live bot; approval L8)",
  post_expiry: "Delete posts automatically when their set expiry time is reached",
  auto_paid_media: "Post paid media automatically from its own Cloudinary folder on a schedule",
  member_sync: "Copy members and trials from the live VIP bot's database (read-only) into Subscribers",
};
// Telegram only lets bots delete their messages for 48 hours after sending.
export const MAX_EXPIRY_MINUTES = 48 * 60;
export const PAID_MEDIA_KEY = "paid_media:config";
export const DEFAULT_PAID_MEDIA = { default_stars: 50, folder: "", times_utc: [], target: "vip", expire_after_minutes: null, caption: "" };

export class OpsError extends Error {}

const MEDIA_KINDS = ["photo", "video", "animation", "paid_media"];
const URL_PREFIXES = ["https://"];
const TG_PREFIXES = ["https://t.me/", "tg://"];

function cleanText(value, limit, name) {
  const text = String(value ?? "").replaceAll("\r\n", "\n").trim();
  if (text.length > limit) throw new OpsError(`${name} is longer than ${limit} characters`);
  return text;
}
const startsWithAny = (s, prefixes) => prefixes.some((p) => s.startsWith(p));
const toInt = (v) => (v === null || v === undefined || v === "" || !/^-?\d+$/.test(String(v).trim()) ? NaN : Number(v));

export function validateContent(data) {
  const kind = data.kind, target = data.target;
  if (!CONTENT_KINDS.includes(kind)) throw new OpsError("Choose a post type");
  if (!TARGETS.includes(target)) throw new OpsError("Choose the public or the VIP channel");
  const limit = MEDIA_KINDS.includes(kind) ? 1024 : ["poll", "quiz"].includes(kind) ? 300 : 4096;
  const text = cleanText(data.text, limit, "Text");
  let mediaUrl = String(data.media_url ?? "").trim();
  let options = [], correct = null, explanation = "", closeAfter = data.close_after_minutes, stars = null;

  if (MEDIA_KINDS.includes(kind)) {
    if (!startsWithAny(mediaUrl, URL_PREFIXES) || mediaUrl.length > 2000)
      throw new OpsError("Media needs an https:// link (for example a Cloudinary URL)");
  } else mediaUrl = "";
  if (["text", "promo"].includes(kind) && !text) throw new OpsError("Write the message text");
  if (["poll", "quiz"].includes(kind)) {
    if (!text) throw new OpsError("Write the question");
    options = (data.options || []).filter((o) => String(o ?? "").trim()).map((o) => cleanText(o, 100, "Option"));
    if (options.length < 2 || options.length > 10) throw new OpsError("A poll needs 2 to 10 options");
    if (new Set(options).size !== options.length) throw new OpsError("Options must be different");
    if (kind === "quiz") {
      correct = toInt(data.correct_option);
      if (!(correct >= 0 && correct < options.length)) throw new OpsError("Pick the correct answer");
      explanation = cleanText(data.explanation, 200, "Explanation");
    }
    if (closeAfter === null || closeAfter === undefined || closeAfter === "") closeAfter = null;
    else {
      closeAfter = toInt(closeAfter);
      if (Number.isNaN(closeAfter)) throw new OpsError("Close-after must be a number of minutes");
      if (closeAfter < 5 || closeAfter > 60 * 24 * 30) throw new OpsError("Close-after must be between 5 minutes and 30 days");
    }
  } else closeAfter = null;
  if (kind === "paid_media") {
    stars = toInt(data.star_count);
    if (Number.isNaN(stars)) throw new OpsError("Set a price in Stars");
    if (stars < 1 || stars > 10000) throw new OpsError("Paid media price must be 1 to 10,000 Stars");
  }
  const buttonText = cleanText(data.button_text, 64, "Button text");
  const buttonUrl = String(data.button_url ?? "").trim();
  if (buttonText || buttonUrl) {
    if (["poll", "quiz", "paid_media"].includes(kind)) throw new OpsError("Polls, quizzes and paid media can't have a button");
    if (!buttonText || !startsWithAny(buttonUrl, [...URL_PREFIXES, ...TG_PREFIXES]) || buttonUrl.length > 500)
      throw new OpsError("A button needs text and an https:// or t.me link");
  }
  let expireAfter = data.expire_after_minutes;
  if (expireAfter === null || expireAfter === undefined || expireAfter === "") expireAfter = null;
  else {
    expireAfter = toInt(expireAfter);
    if (Number.isNaN(expireAfter) || expireAfter < 5 || expireAfter > MAX_EXPIRY_MINUTES)
      throw new OpsError("Delete-after must be between 5 minutes and 48 hours (Telegram's limit for deleting)");
  }
  let scheduledAt = data.scheduled_at;
  if (scheduledAt === "" || scheduledAt === null || scheduledAt === undefined) scheduledAt = null;
  else {
    scheduledAt = toInt(scheduledAt);
    if (Number.isNaN(scheduledAt)) throw new OpsError("Invalid schedule time");
  }
  // Hashtags: up to 10 tags of letters, digits or _; stored without duplicates as "#a #b".
  const rawTags = Array.isArray(data.hashtags) ? data.hashtags.join(" ") : String(data.hashtags ?? "");
  const tags = [...new Set(rawTags.split(/[\s,]+/).map((t) => t.replace(/^#+/, "")).filter(Boolean))];
  for (const t of tags) if (!/^[\p{L}\p{N}_]{1,40}$/u.test(t)) throw new OpsError(`Hashtag #${t} may use only letters, digits and _`);
  if (tags.length > 10) throw new OpsError("Use at most 10 hashtags");
  const hashtags = tags.map((t) => "#" + t).join(" ");
  if (hashtags && !["poll", "quiz"].includes(kind) && text.length + hashtags.length + 2 > limit)
    throw new OpsError(`Text plus hashtags must fit in ${limit} characters`);
  return {
    hashtags,
    kind, target, text, media_url: mediaUrl, options_json: JSON.stringify(options), correct_option: correct, explanation,
    multiple_answers: data.multiple_answers && kind === "poll" ? 1 : 0, close_after_minutes: closeAfter, star_count: stars,
    button_text: buttonText, button_url: buttonUrl,
    use_caption_library: data.use_caption_library && MEDIA_KINDS.includes(kind) && !text ? 1 : 0, scheduled_at: scheduledAt,
    expire_after_minutes: expireAfter,
  };
}

export const BACKUP_TABLES = ["settings", "content_items", "captions", "profiles", "join_requests", "admin_actions", "moderation_rules",
  "moderation_log", "reaction_counts", "reminders_sent", "audit_log", "payments", "trials", "member_events", "pending_unbans",
  "auto_paid_runs", "auto_paid_posted"];

function summarize(userId, profile, payments, trials, events, now) {
  profile = profile || { user_id: userId, username: "", first_name: "", source: "", tags: "", notes: "", first_seen: null, last_seen: null };
  const lastSub = events.find((e) => e.subscription_until)?.subscription_until ?? null;
  const activeTrial = trials.find((t) => t.status === "active" && t.expires_at > now);
  const latest = events[0]?.event;
  const membership = lastSub && lastSub > now && !["left", "removed"].includes(latest) ? "monthly"
    : activeTrial ? "trial" : ["left", "removed"].includes(latest) ? "left" : "none";
  const seen = [profile.last_seen, ...payments.map((p) => p.created_at), ...events.map((e) => e.created_at)].filter(Boolean);
  const { user_id: _u, ...rest } = profile;
  return {
    user_id: userId, ...rest, membership, subscription_until: lastSub, trial_expires_at: activeTrial ? activeTrial.expires_at : null,
    stars_paid: payments.filter((p) => (p.status === null || p.status === "accepted") && p.currency === "XTR").reduce((n, p) => n + Number(p.amount), 0),
    last_seen: seen.length ? Math.max(...seen.map(Number)) : null,
  };
}

export class Ops {
  constructor(db, now = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }
  q(sql, ...args) { return this.db.prepare(sql).bind(...args); }
  async all(sql, ...args) { return (await this.q(sql, ...args).all()).results || []; }
  async one(sql, ...args) { return (await this.q(sql, ...args).first()) ?? null; }
  async run(sql, ...args) { return this.q(sql, ...args).run(); }

  // Settings and features
  async getSetting(key, fallback = null) { const r = await this.one("SELECT value FROM settings WHERE key = ?", key); return r ? r.value : fallback; }
  async setSetting(key, value) {
    await this.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
  }
  async featureEnabled(name) { return (await this.getSetting("feature:" + name, "0")) === "1"; }
  // One query for every switch.
  async features() {
    const on = new Set((await this.all("SELECT key FROM settings WHERE key LIKE 'feature:%' AND value = '1'")).map((r) => r.key.slice(8)));
    return Object.fromEntries(Object.entries(FEATURES).map(([name, description]) => [name, { enabled: on.has(name), description }]));
  }
  async setFeature(name, enabled, actor) {
    if (!(name in FEATURES)) throw new OpsError(`Unknown feature '${name}'`);
    await this.setSetting("feature:" + name, enabled ? "1" : "0");
    await this.audit(actor, "feature", `${name} ${enabled ? "on" : "off"}`);
  }
  async joinPolicy(target) { return this.getSetting("join_policy:" + target, "manual"); }
  async setJoinPolicy(target, policy, actor) {
    if (!TARGETS.includes(target) || !JOIN_POLICIES.includes(policy)) throw new OpsError("Invalid join policy");
    if (target === "vip" && policy === "approve_all") throw new OpsError("The VIP channel can't approve everyone: that would give paid content away");
    await this.setSetting("join_policy:" + target, policy);
    await this.audit(actor, "join_policy", `${target}: ${policy}`);
  }

  // Audit
  async audit(actor, action, detail = "") {
    await this.run("INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)", actor, action, String(detail).slice(0, 500), this.now());
  }
  auditEntries(limit = 200) { return this.all("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", limit); }

  // Content
  async content(id) { return this.one("SELECT * FROM content_items WHERE id = ?", Number(id)); }
  async createContent(data, actor) {
    const v = validateContent(data), now = this.now();
    const r = await this.run(
      "INSERT INTO content_items (kind, target, text, media_url, options_json, correct_option, explanation, multiple_answers, " +
      "close_after_minutes, star_count, button_text, button_url, use_caption_library, status, scheduled_at, created_by, created_at, updated_at, " +
      "expire_after_minutes, source, hashtags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)",
      v.kind, v.target, v.text, v.media_url, v.options_json, v.correct_option, v.explanation, v.multiple_answers,
      v.close_after_minutes, v.star_count, v.button_text, v.button_url, v.use_caption_library, v.scheduled_at, actor, now, now,
      v.expire_after_minutes, String(data.source || "").slice(0, 200), v.hashtags);
    const id = r.meta.last_row_id;
    await this.audit(actor, "content_create", `#${id} ${v.kind} -> ${v.target}`);
    return this.content(id);
  }
  async editable(id) {
    const item = await this.content(id);
    if (!item) throw new OpsError("Not found");
    if (!["draft", "scheduled", "failed"].includes(item.status)) throw new OpsError(`A ${item.status} post can't be changed`);
    return item;
  }
  async updateContent(id, data, actor) {
    const item = await this.editable(id);
    const v = validateContent({ ...item, options: JSON.parse(item.options_json), ...data });
    await this.run(
      "UPDATE content_items SET kind=?, target=?, text=?, media_url=?, options_json=?, correct_option=?, explanation=?, multiple_answers=?, " +
      "close_after_minutes=?, star_count=?, button_text=?, button_url=?, use_caption_library=?, scheduled_at=?, expire_after_minutes=?, hashtags=?, updated_at=? WHERE id=?",
      v.kind, v.target, v.text, v.media_url, v.options_json, v.correct_option, v.explanation, v.multiple_answers, v.close_after_minutes,
      v.star_count, v.button_text, v.button_url, v.use_caption_library, v.scheduled_at, v.expire_after_minutes, v.hashtags, this.now(), Number(id));
    await this.audit(actor, "content_update", `#${id}`);
    return this.content(id);
  }
  async scheduleContent(id, when, actor) {
    const item = await this.editable(id);
    const at = toInt(when ?? item.scheduled_at ?? this.now());
    if (Number.isNaN(at)) throw new OpsError("Invalid schedule time");
    await this.run("UPDATE content_items SET status='scheduled', scheduled_at=?, last_error='', updated_at=? WHERE id=?", at, this.now(), Number(id));
    await this.audit(actor, "content_schedule", `#${id} at ${at}`);
    return this.content(id);
  }
  async cancelContent(id, actor) {
    const item = await this.content(id);
    if (!item) throw new OpsError("Not found");
    if (!["draft", "scheduled", "failed"].includes(item.status)) throw new OpsError(`A ${item.status} post can't be cancelled`);
    await this.run("UPDATE content_items SET status='cancelled', updated_at=? WHERE id=?", this.now(), Number(id));
    await this.audit(actor, "content_cancel", `#${id}`);
    return this.content(id);
  }
  async duplicateContent(id, actor) {
    const item = await this.content(id);
    if (!item) throw new OpsError("Not found");
    return this.createContent({ ...item, options: JSON.parse(item.options_json), scheduled_at: null }, actor);
  }
  async deleteContent(id, actor) {
    const item = await this.content(id);
    if (!item || !["draft", "cancelled"].includes(item.status)) throw new OpsError("Only drafts and cancelled posts can be deleted");
    await this.run("DELETE FROM content_items WHERE id=?", Number(id));
    await this.audit(actor, "content_delete", `#${id}`);
  }
  async contentList({ status = null, start = null, end = null, limit = 500 } = {}) {
    let sql = "SELECT * FROM content_items WHERE 1=1"; const args = [];
    if (status) { sql += " AND status = ?"; args.push(status); }
    if (start !== null) { sql += " AND COALESCE(posted_at, scheduled_at, created_at) >= ?"; args.push(start); }
    if (end !== null) { sql += " AND COALESCE(posted_at, scheduled_at, created_at) < ?"; args.push(end); }
    sql += " ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?"; args.push(limit);
    return this.all(sql, ...args);
  }

  // Paid media automation settings
  async paidMediaConfig() {
    try { return { ...DEFAULT_PAID_MEDIA, ...JSON.parse(await this.getSetting(PAID_MEDIA_KEY, "{}")) }; }
    catch { return { ...DEFAULT_PAID_MEDIA }; }
  }
  async setPaidMediaConfig(data, actor) {
    const stars = toInt(data.default_stars);
    if (!(stars >= 1 && stars <= 10000)) throw new OpsError("Default price must be 1 to 10,000 Stars");
    const folder = String(data.folder || "").trim().replace(/^\/+|\/+$/g, "");
    if (folder && !/^[\w\-/ ]{1,100}$/.test(folder)) throw new OpsError("Folder name can use letters, numbers, - _ / and spaces");
    if (folder.toLowerCase() === "tgpub") throw new OpsError("Use a separate folder: 'tgpub' belongs to the free-channel poster (GitHub)");
    const times = [...new Set((Array.isArray(data.times_utc) ? data.times_utc : String(data.times_utc || "").split(","))
      .map((t) => String(t).trim()).filter(Boolean))];
    for (const t of times) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw new OpsError(`Times must look like 14:30 (UTC), got '${t}'`);
    if (times.length > 6) throw new OpsError("At most 6 automatic paid-media posts a day");
    if (!TARGETS.includes(data.target)) throw new OpsError("Choose the public or the VIP channel");
    let expire = data.expire_after_minutes;
    if (expire === "" || expire === null || expire === undefined) expire = null;
    else {
      expire = toInt(expire);
      if (!(expire >= 5 && expire <= MAX_EXPIRY_MINUTES)) throw new OpsError("Delete-after must be between 5 minutes and 48 hours");
    }
    const cfg = { default_stars: stars, folder, times_utc: times.sort(), target: data.target, expire_after_minutes: expire,
      caption: cleanText(data.caption, 1024, "Caption") };
    await this.setSetting(PAID_MEDIA_KEY, JSON.stringify(cfg));
    await this.audit(actor, "paid_media_config", JSON.stringify(cfg).slice(0, 400));
    return cfg;
  }

  // Captions
  captions() { return this.all("SELECT * FROM captions ORDER BY id"); }
  async addCaption(text, actor) {
    const t = cleanText(text, 1024, "Caption");
    if (!t) throw new OpsError("Caption is empty");
    const r = await this.run("INSERT INTO captions (text) VALUES (?)", t);
    await this.audit(actor, "caption_add", `#${r.meta.last_row_id}`);
    return this.one("SELECT * FROM captions WHERE id=?", r.meta.last_row_id);
  }
  async setCaptionActive(id, active, actor) {
    await this.run("UPDATE captions SET active=? WHERE id=?", active ? 1 : 0, Number(id));
    await this.audit(actor, "caption_active", `#${id} ${active}`);
  }
  async deleteCaption(id, actor) { await this.run("DELETE FROM captions WHERE id=?", Number(id)); await this.audit(actor, "caption_delete", `#${id}`); }
  async nextCaption(now) {
    const row = await this.one("SELECT * FROM captions WHERE active=1 ORDER BY used_count, COALESCE(last_used_at, 0), id LIMIT 1");
    if (!row) return null;
    await this.run("UPDATE captions SET used_count=used_count+1, last_used_at=? WHERE id=?", now, row.id);
    return row.text;
  }

  // Profiles / subscribers
  async touchProfile(userId, username = "", firstName = "", source = "", now = this.now()) {
    await this.run(
      "INSERT INTO profiles (user_id, username, first_name, source, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET username = CASE WHEN excluded.username != '' THEN excluded.username ELSE profiles.username END, " +
      "first_name = CASE WHEN excluded.first_name != '' THEN excluded.first_name ELSE profiles.first_name END, " +
      "source = CASE WHEN profiles.source = '' THEN excluded.source ELSE profiles.source END, last_seen = excluded.last_seen",
      userId, username || "", firstName || "", source || "", now, now);
  }
  async updateProfile(userId, tags, notes, actor) {
    await this.touchProfile(userId);
    if (tags !== undefined && tags !== null) {
      const clean = [...new Set(String(tags).split(",").map((t) => t.trim().slice(0, 32)).filter(Boolean))].sort().join(",");
      await this.run("UPDATE profiles SET tags=? WHERE user_id=?", clean, userId);
    }
    if (notes !== undefined && notes !== null) await this.run("UPDATE profiles SET notes=? WHERE user_id=?", String(notes).slice(0, 2000), userId);
    await this.audit(actor, "profile_update", `user ${userId}`);
    return this.subscriber(userId, this.now());
  }
  // Four queries in total (not four per person): on Supabase every query is a network round trip.
  async subscribers(query = "", now = this.now(), limit = 500) {
    const [profiles, payments, trials, events] = await Promise.all([
      this.all("SELECT * FROM profiles"),
      this.all("SELECT telegram_payment_charge_id AS charge_id, user_id, plan, amount, currency, status, created_at FROM payments ORDER BY created_at DESC"),
      this.all("SELECT id, user_id, starts_at, expires_at, joined_at, status FROM trials ORDER BY id DESC"),
      this.all("SELECT user_id, event, invite_link_name, subscription_until, created_at FROM member_events ORDER BY created_at DESC, id DESC"),
    ]);
    const group = (rows) => { const m = new Map(); for (const r of rows) { const k = Number(r.user_id); if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
    const byProfile = new Map(profiles.map((p) => [Number(p.user_id), p]));
    const pay = group(payments), tri = group(trials), ev = group(events);
    const ids = new Set([...byProfile.keys(), ...pay.keys(), ...tri.keys(), ...ev.keys()]);
    let people = [...ids].map((id) => summarize(id, byProfile.get(id), pay.get(id) || [], tri.get(id) || [], (ev.get(id) || []).slice(0, 50), now));
    const q = query.trim().toLowerCase().replace(/^@/, "");
    if (q) people = people.filter((s) => String(s.user_id).includes(q) || s.username.toLowerCase().includes(q) || s.first_name.toLowerCase().includes(q) || s.tags.toLowerCase().includes(q));
    people.sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0));
    return people.slice(0, limit);
  }
  async subscriber(userId, now, brief = false) {
    const [profile, payments, trials, events] = await Promise.all([
      this.one("SELECT * FROM profiles WHERE user_id=?", userId),
      this.all("SELECT telegram_payment_charge_id AS charge_id, plan, amount, currency, status, created_at FROM payments WHERE user_id=? ORDER BY created_at DESC", userId),
      this.all("SELECT id, starts_at, expires_at, joined_at, status FROM trials WHERE user_id=? ORDER BY id DESC", userId),
      this.all("SELECT event, invite_link_name, subscription_until, created_at FROM member_events WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 50", userId),
    ]);
    const out = summarize(Number(userId), profile, payments, trials, events, now);
    return brief ? out : { ...out, payments, trials, events };
  }
  joinRequests(status = "pending", limit = 500) {
    return status ? this.all("SELECT * FROM join_requests WHERE status=? ORDER BY requested_at DESC LIMIT ?", status, limit)
      : this.all("SELECT * FROM join_requests ORDER BY requested_at DESC LIMIT ?", limit);
  }
  joinRequest(id) { return this.one("SELECT * FROM join_requests WHERE id=?", Number(id)); }
  async setJoinStatus(id, status, reason, actor, now) {
    await this.run("UPDATE join_requests SET status=?, reason=?, decided_at=?, decided_by=? WHERE id=?", status, String(reason).slice(0, 200), now, actor, Number(id));
  }
  async validateAction(kind, payload) {
    if (kind === "approve_join" || kind === "decline_join") {
      const r = await this.joinRequest(toInt(payload.request_id) || 0);
      if (!r || r.status !== "pending") throw new OpsError("That join request is not pending");
      return { request_id: r.id, chat_id: r.chat_id, user_id: r.user_id };
    }
    if (kind === "close_poll") {
      const item = await this.content(toInt(payload.content_id) || 0);
      if (!item || !["poll", "quiz"].includes(item.kind) || item.status !== "posted" || item.poll_closed_at) throw new OpsError("Only an open, posted poll can be closed");
      return { content_id: item.id };
    }
    const userId = toInt(payload.user_id);
    if (!(userId > 0)) throw new OpsError("Invalid user");
    if (kind === "send_dm") {
      const text = cleanText(payload.text, 4096, "Message");
      if (!text) throw new OpsError("Write the message");
      return { user_id: userId, text };
    }
    return { user_id: userId };
  }
  async queueAction(kind, payload, actor) {
    if (!ACTION_KINDS.includes(kind)) throw new OpsError(`Unknown action '${kind}'`);
    const clean = await this.validateAction(kind, payload || {});
    const r = await this.run("INSERT INTO admin_actions (kind, payload_json, created_by, created_at) VALUES (?, ?, ?, ?)", kind, JSON.stringify(clean), actor, this.now());
    await this.audit(actor, "action_queue", `#${r.meta.last_row_id} ${kind} ${JSON.stringify(clean).slice(0, 200)}`);
    return this.one("SELECT * FROM admin_actions WHERE id=?", r.meta.last_row_id);
  }
  queuedActions() { return this.all("SELECT * FROM admin_actions WHERE status='queued' ORDER BY id"); }
  actions(limit = 200) { return this.all("SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?", limit); }
  async finishAction(id, ok, error, now) {
    await this.run("UPDATE admin_actions SET status=?, error=?, done_at=? WHERE id=?", ok ? "done" : "failed", String(error).slice(0, 500), now, id);
  }

  // Moderation
  moderationRules() { return this.all("SELECT * FROM moderation_rules ORDER BY id"); }
  async addModerationRule(kind, pattern, action, actor) {
    const p = String(pattern || "").trim().toLowerCase();
    if (!MODERATION_KINDS.includes(kind) || !MODERATION_ACTIONS.includes(action)) throw new OpsError("Invalid rule");
    if (!p || p.length > 100) throw new OpsError("Pattern must be 1-100 characters");
    const r = await this.run("INSERT INTO moderation_rules (kind, pattern, action) VALUES (?, ?, ?)", kind, p, action);
    await this.audit(actor, "moderation_rule_add", `#${r.meta.last_row_id} ${kind}:${p} -> ${action}`);
    return this.one("SELECT * FROM moderation_rules WHERE id=?", r.meta.last_row_id);
  }
  async deleteModerationRule(id, actor) { await this.run("DELETE FROM moderation_rules WHERE id=?", Number(id)); await this.audit(actor, "moderation_rule_delete", `#${id}`); }
  moderationLog(limit = 200) { return this.all("SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?", limit); }

  // Backup: every dashboard table as JSON (sessions and login failures left out: they are short-lived security data).
  async exportAll() {
    const out = { format: "shakhira-backup-v1", exported_at: this.now(), tables: {} };
    const lists = await Promise.all(BACKUP_TABLES.map((t) => this.all(`SELECT * FROM ${t}`)));
    BACKUP_TABLES.forEach((t, i) => { out.tables[t] = lists[i]; });
    return out;
  }

  // Analytics
  async analytics(now, days = 30) {
    const start = now - days * 86400;
    // Grouped by UTC day here rather than in SQL, so the same code runs on D1 (SQLite) and Supabase (Postgres).
    const byDay = new Map();
    for (const p of await this.all("SELECT created_at, amount FROM payments WHERE created_at >= ? AND currency='XTR' AND (status IS NULL OR status='accepted')", start)) {
      const day = new Date(Number(p.created_at) * 1000).toISOString().slice(0, 10);
      const d = byDay.get(day) || { day, stars: 0, payments: 0 };
      d.stars += Number(p.amount); d.payments += 1; byDay.set(day, d);
    }
    const revenue = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    const n = (expr) => `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
    const t = (await this.one(`SELECT COUNT(*) AS started, ${n("status='converted'")} AS converted, ${n("status='active'")} AS active, ${n("joined_at IS NOT NULL")} AS joined FROM trials WHERE starts_at >= ?`, start)) || {};
    const posts = await this.all("SELECT kind, COUNT(*) AS count FROM content_items WHERE status='posted' AND posted_at >= ? GROUP BY kind", start);
    const polls = (await this.all("SELECT id, kind, text, poll_results_json, target FROM content_items WHERE poll_results_json IS NOT NULL ORDER BY poll_closed_at DESC LIMIT 10"))
      .map((r) => ({ id: r.id, kind: r.kind, question: r.text, target: r.target, ...JSON.parse(r.poll_results_json) }));
    const reactions = await this.all("SELECT chat_id, message_id, total, reactions_json FROM reaction_counts ORDER BY total DESC LIMIT 10");
    return {
      days, revenue_by_day: revenue, stars_total: revenue.reduce((n, r) => n + r.stars, 0),
      trials: { started: t.started || 0, converted: t.converted || 0, active: t.active || 0, joined: t.joined || 0 },
      posts_by_kind: posts, polls, top_reactions: reactions,
    };
  }
}
