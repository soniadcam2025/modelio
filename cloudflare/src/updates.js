// Handles COPIES of Telegram updates forwarded by the live bot (shakhira-vip-bot) through a Cloudflare service
// binding. This Worker never receives updates from Telegram itself: there is still exactly one webhook receiver.
// Same behaviour as shakhira_bot/features.py: join requests, reaction counts, discussion-group moderation, profiles.

export const STRIKE_WINDOW = 7 * 86400;
export const STRIKES_BEFORE_MUTE = 3;
export const MUTE_SECONDS = 86400;
const URL_RE = /(?:https?:\/\/|www\.|t\.me\/)[^\s]+/gi;

const enc = new TextEncoder();
async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// The live bot signs each forwarded update: HMAC(UPDATE_SECRET, "<unix time>.<body>").
export async function signUpdate(secret, body, now = Math.floor(Date.now() / 1000)) {
  return { "x-update-time": String(now), "x-update-signature": await hmacHex(secret, `${now}.${body}`) };
}
export async function verifyUpdate(secret, headers, body, now) {
  if (!secret || secret.length < 32) return false;
  const t = Number(headers.get("x-update-time"));
  if (!Number.isInteger(t) || Math.abs(now - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  const got = headers.get("x-update-signature") || "";
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function channelTarget(config, chat) {
  if (!chat) return null;
  if (config.vipChannelId && String(chat.id) === String(config.vipChannelId)) return "vip";
  const u = String(chat.username || "").toLowerCase();
  if (u && u === String(config.publicChannel || "").replace(/^@/, "").toLowerCase()) return "public";
  return null;
}

export function matchRule(text, rules) {
  const lowered = String(text || "").toLowerCase();
  if (!lowered) return null;
  const urls = (lowered.match(URL_RE) || []);
  for (const rule of rules) {
    const p = String(rule.pattern).toLowerCase();
    if (rule.kind === "word") {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u");
      if (re.test(lowered)) return rule;
    }
    if (rule.kind === "link" && urls.some((u) => u.includes(p))) return rule;
  }
  return null;
}

const reactionKey = (t) => t?.emoji || (t?.custom_emoji_id ? `custom:${t.custom_emoji_id}` : String(t?.type || "other"));

// Returns a short description of what was done (for logs and tests).
export async function handleUpdate(update, { ops, tg, config, now, alert = async () => {} }) {
  if (!Number.isSafeInteger(update?.update_id)) return "invalid";
  const fresh = await ops.run("INSERT INTO forwarded_updates (update_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING", update.update_id, now);
  if (fresh.meta.changes !== 1) return "duplicate";

  // Profiles: people who talk to the bot privately.
  const msg = update.message;
  if (msg?.chat?.type === "private" && msg.from && !msg.from.is_bot) {
    const text = String(msg.text || "");
    const source = text.startsWith("/start ") ? text.slice(7).trim().slice(0, 64) : "";
    await ops.touchProfile(msg.from.id, msg.from.username || "", msg.from.first_name || "", source, now);
  }

  // Join requests.
  const req = update.chat_join_request;
  if (req && (await ops.featureEnabled("join_requests"))) {
    const target = channelTarget(config, req.chat);
    if (!target) return "join: unknown chat";
    const user = req.from || {};
    const r = await ops.run("INSERT INTO join_requests (chat_id, user_id, username, first_name, requested_at) VALUES (?, ?, ?, ?, ?)",
      req.chat.id, user.id, user.username || "", user.first_name || "", now);
    const id = r.meta.last_row_id;
    await ops.touchProfile(user.id, user.username || "", user.first_name || "", `join_${target}`, now);
    const policy = await ops.joinPolicy(target);
    let approve = policy === "approve_all" && target === "public";
    if (policy === "approve_paid" && target === "vip")
      approve = !!(await ops.one("SELECT 1 AS ok FROM trials WHERE user_id = ? AND status = 'active' AND expires_at > ?", user.id, now));
    if (approve) {
      try {
        await tg.call("approveChatJoinRequest", { chat_id: req.chat.id, user_id: user.id });
        await ops.setJoinStatus(id, "approved", `policy ${policy}`, "bot", now);
        return "join: approved";
      } catch (e) {
        await ops.setJoinStatus(id, "failed", String(e.message).slice(0, 200), "bot", now);
        return "join: failed";
      }
    }
    await alert(`New join request for the ${target} channel from user ${user.id} (@${user.username || "-"}). Review it in the dashboard.`);
    return "join: pending";
  }

  // Reaction counts on channel posts.
  const rc = update.message_reaction_count;
  if (rc && (await ops.featureEnabled("reaction_tracking"))) {
    if (!channelTarget(config, rc.chat)) return "reactions: unknown chat";
    const counts = {};
    for (const r of rc.reactions || []) counts[reactionKey(r.type)] = (counts[reactionKey(r.type)] || 0) + Number(r.total_count || 0);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    await ops.run("INSERT INTO reaction_counts (chat_id, message_id, reactions_json, total, updated_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(chat_id, message_id) DO UPDATE SET reactions_json = excluded.reactions_json, total = excluded.total, updated_at = excluded.updated_at",
      rc.chat.id, rc.message_id, JSON.stringify(counts), total, now);
    return "reactions: saved";
  }

  // Moderation of the channel's existing discussion group.
  if (msg && config.discussionGroupId && String(msg.chat?.id) === String(config.discussionGroupId) && (await ops.featureEnabled("moderation"))) {
    if (msg.is_automatic_forward || msg.sender_chat || !msg.from || msg.from.is_bot) return "moderation: skipped";
    const rules = (await ops.moderationRules()).filter((r) => Number(r.active) === 1);
    const text = msg.text || msg.caption || "";
    const rule = matchRule(text, rules);
    if (!rule) return "moderation: clean";
    const member = await tg.call("getChatMember", { chat_id: msg.chat.id, user_id: msg.from.id });
    if (["creator", "administrator"].includes(member?.status)) return "moderation: admin";
    await tg.call("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    const log = (action, excerpt) => ops.run("INSERT INTO moderation_log (chat_id, user_id, rule_id, action, excerpt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      msg.chat.id, msg.from.id, rule.id, action, String(excerpt).slice(0, 200), now);
    await log(rule.action, text);
    const strikes = Number((await ops.one("SELECT COUNT(*) AS n FROM moderation_log WHERE user_id = ? AND created_at >= ?", msg.from.id, now - STRIKE_WINDOW))?.n || 0);
    if (rule.action === "delete_mute" || strikes >= STRIKES_BEFORE_MUTE) {
      await tg.call("restrictChatMember", { chat_id: msg.chat.id, user_id: msg.from.id, permissions: { can_send_messages: false }, until_date: now + MUTE_SECONDS });
      await log("muted_24h", "");
      return "moderation: muted";
    }
    if (rule.action === "delete_warn") {
      await tg.call("sendMessage", { chat_id: msg.chat.id, text: `${msg.from.first_name || "Hi"}, that message broke the group rules and was removed.` });
      return "moderation: warned";
    }
    return "moderation: deleted";
  }
  return "ignored";
}
