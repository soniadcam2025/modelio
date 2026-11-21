// Send-only automation, run by the Worker's cron trigger. A port of shakhira_bot/scheduler.py.
// Every part is off until its feature flag is on. A post is claimed before it is sent and is never re-sent
// after an uncertain result. This Worker never posts the Cloudinary media that the GitHub Actions poster
// handles, so the two can never post the same thing.

import { TelegramError } from "./telegram.js";
import { classify, GITHUB_POSTER_FOLDER } from "./cloudinary.js";

const STALE_SENDING_SECONDS = 10 * 60;
const MAX_RETRY_DELAY = 15 * 60;
const VIDEO_EXT = [".mp4", ".mov", ".m4v", ".webm"];

export function targetChat(config, target) {
  if (config.previewChatId) return config.previewChatId;
  return target === "vip" ? config.vipChannelId : config.publicChannel;
}

function markup(item, config) {
  if (item.button_text && item.button_url) return { inline_keyboard: [[{ text: item.button_text, url: item.button_url }]] };
  if (item.kind === "promo") return { inline_keyboard: [[{ text: "💎 Join VIP", url: `https://t.me/${config.botUsername}?start=promo_${item.id}` }]] };
  return undefined;
}

export async function sendItem(tg, config, item, text) {
  const chat_id = targetChat(config, item.target);
  const reply_markup = markup(item, config);
  const caption = text || undefined;
  switch (item.kind) {
    case "text": case "promo": return tg.call("sendMessage", { chat_id, text, reply_markup });
    case "photo": return tg.call("sendPhoto", { chat_id, photo: item.media_url, caption, reply_markup });
    case "video": return tg.call("sendVideo", { chat_id, video: item.media_url, caption, reply_markup, supports_streaming: true });
    case "animation": return tg.call("sendAnimation", { chat_id, animation: item.media_url, caption, reply_markup });
    case "poll": case "quiz": {
      const params = { chat_id, question: text, options: JSON.parse(item.options_json).map((t) => ({ text: t })),
        is_anonymous: true, allows_multiple_answers: !!item.multiple_answers };
      if (item.kind === "quiz") Object.assign(params, { type: "quiz", correct_option_id: item.correct_option, explanation: item.explanation || undefined });
      return tg.call("sendPoll", params);
    }
    case "paid_media": {
      const path = item.media_url.toLowerCase().split("?")[0];
      const type = VIDEO_EXT.some((e) => path.endsWith(e)) ? "video" : "photo";
      return tg.call("sendPaidMedia", { chat_id, star_count: item.star_count, media: [{ type, media: item.media_url }], caption });
    }
    default: throw new Error(`Unknown content kind ${item.kind}`);
  }
}

async function claim(ops, id, now) {
  const r = await ops.run("UPDATE content_items SET status='sending', sending_since=?, attempts=attempts+1, updated_at=? WHERE id=? AND status='scheduled'", now, now, id);
  return r.meta.changes === 1;
}
const setStatus = (ops, id, status, error, now) =>
  ops.run("UPDATE content_items SET status=?, last_error=?, updated_at=? WHERE id=?", status, String(error).slice(0, 500), now, id);

export async function publishDue(tg, ops, config, now, alert = async () => {}) {
  const counts = { posted: 0, simulated: 0, failed: 0, uncertain: 0, retry: 0 };
  for (const stale of await ops.all("SELECT * FROM content_items WHERE status='sending' AND sending_since < ?", now - STALE_SENDING_SECONDS)) {
    await setStatus(ops, stale.id, "uncertain", "the worker stopped while sending; check the channel", now);
    counts.uncertain++;
    await alert(`Scheduled post #${stale.id} may or may not have been sent. It will NOT be sent again automatically.`);
  }
  for (const item of await ops.all("SELECT * FROM content_items WHERE status='scheduled' AND scheduled_at <= ? ORDER BY scheduled_at, id", now)) {
    if (!(await claim(ops, item.id, now))) continue;
    let text = item.text;
    if (!text && item.use_caption_library) text = (await ops.nextCaption(now)) || "";
    if (item.hashtags && !["poll", "quiz"].includes(item.kind)) text = text ? `${text}\n\n${item.hashtags}` : item.hashtags;
    let result;
    try {
      result = await sendItem(tg, config, item, text);
    } catch (err) {
      if (err instanceof TelegramError && err.retryAfter) {
        const at = now + Math.min(Math.max(1, err.retryAfter), MAX_RETRY_DELAY);
        await ops.run("UPDATE content_items SET status='scheduled', scheduled_at=?, last_error='Telegram rate limit', updated_at=? WHERE id=?", at, now, item.id);
        counts.retry++;
      } else if (err instanceof TelegramError && err.uncertain) {
        await setStatus(ops, item.id, "uncertain", `no confirmation from Telegram: ${err.message}`, now);
        counts.uncertain++;
        await alert(`Scheduled post #${item.id} may or may not have been sent. It will NOT be sent again automatically.`);
      } else {
        await setStatus(ops, item.id, "failed", `Telegram refused it: ${err.message}`, now);
        counts.failed++;
        await alert(`Scheduled post #${item.id} (${item.kind}) was refused: ${err.message}`);
      }
      continue;
    }
    const status = result?.simulated ? "simulated" : "posted";
    await ops.run("UPDATE content_items SET status=?, message_id=?, posted_at=?, last_error=?, text=?, updated_at=? WHERE id=?",
      status, result?.message_id ?? null, now, result?.simulated ? "Simulated in staging: nothing was sent to Telegram" : "", text, now, item.id);
    counts[status]++;
  }
  return counts;
}

export async function closeDuePolls(tg, ops, config, now) {
  let closed = 0;
  const due = await ops.all("SELECT * FROM content_items WHERE kind IN ('poll','quiz') AND status IN ('posted','simulated') AND poll_closed_at IS NULL " +
    "AND close_after_minutes IS NOT NULL AND posted_at + close_after_minutes * 60 <= ?", now);
  for (const item of due) {
    let results;
    if (item.status === "simulated") {
      results = { total_voters: 0, options: JSON.parse(item.options_json).map((t) => ({ text: t, votes: 0 })), correct_option: item.correct_option, simulated: true };
    } else {
      try {
        const poll = await tg.call("stopPoll", { chat_id: targetChat(config, item.target), message_id: item.message_id });
        results = { total_voters: poll.total_voter_count, options: (poll.options || []).map((o) => ({ text: o.text, votes: o.voter_count })), correct_option: poll.correct_option_id ?? null };
      } catch (err) {
        if (err instanceof TelegramError && err.code === 400) results = { error: err.message, options: [], total_voters: 0 };
        else continue;
      }
    }
    await ops.run("UPDATE content_items SET poll_closed_at=?, poll_results_json=?, updated_at=? WHERE id=?", now, JSON.stringify(results), now, item.id);
    closed++;
  }
  return closed;
}

export async function runAdminActions(tg, ops, config, now) {
  const counts = { done: 0, failed: 0 };
  for (const action of await ops.queuedActions()) {
    const p = JSON.parse(action.payload_json);
    try {
      if (action.kind === "approve_join" || action.kind === "decline_join") {
        const req = await ops.joinRequest(p.request_id);
        if (!req || req.status !== "pending") throw new Error("join request is no longer pending");
        await tg.call(action.kind === "approve_join" ? "approveChatJoinRequest" : "declineChatJoinRequest", { chat_id: p.chat_id, user_id: p.user_id });
        await ops.setJoinStatus(req.id, action.kind === "approve_join" ? "approved" : "declined", "by dashboard", action.created_by, now);
      } else if (action.kind === "remove_member") {
        const member = await tg.call("getChatMember", { chat_id: config.vipChannelId, user_id: p.user_id });
        if (["creator", "administrator"].includes(member?.status)) throw new Error("that user is a channel admin");
        await tg.call("banChatMember", { chat_id: config.vipChannelId, user_id: p.user_id });
        await tg.call("unbanChatMember", { chat_id: config.vipChannelId, user_id: p.user_id, only_if_banned: true });
      } else if (action.kind === "unban_member") {
        await tg.call("unbanChatMember", { chat_id: config.vipChannelId, user_id: p.user_id, only_if_banned: true });
      } else if (action.kind === "send_dm") {
        await tg.call("sendMessage", { chat_id: p.user_id, text: p.text });
      } else if (action.kind === "close_poll") {
        const item = await ops.content(p.content_id);
        if (!item || item.poll_closed_at) throw new Error("poll is already closed");
        const poll = await tg.call("stopPoll", { chat_id: targetChat(config, item.target), message_id: item.message_id });
        await ops.run("UPDATE content_items SET poll_closed_at=?, poll_results_json=? WHERE id=?", now,
          JSON.stringify({ total_voters: poll.total_voter_count, options: (poll.options || []).map((o) => ({ text: o.text, votes: o.voter_count })) }), item.id);
      } else throw new Error(`unknown action ${action.kind}`);
    } catch (err) {
      await ops.finishAction(action.id, false, `${err.name}: ${err.message}`, now);
      counts.failed++;
      continue;
    }
    await ops.finishAction(action.id, true, "", now);
    await ops.audit("worker", "action_done", `#${action.id} ${action.kind}`);
    counts.done++;
  }
  return counts;
}

// Posts with an expiry are deleted once it passes. Telegram allows bots to delete for 48 hours.
export async function expirePosts(tg, ops, config, now) {
  let expired = 0;
  const due = await ops.all("SELECT * FROM content_items WHERE status IN ('posted','simulated') AND expire_after_minutes IS NOT NULL " +
    "AND expired_at IS NULL AND posted_at + expire_after_minutes * 60 <= ?", now);
  for (const item of due) {
    let note = "";
    if (item.status === "posted" && item.message_id) {
      try {
        await tg.call("deleteMessage", { chat_id: targetChat(config, item.target), message_id: item.message_id });
      } catch (err) {
        if (!(err instanceof TelegramError && err.code === 400)) continue; // retry next minute
        note = `could not delete: ${err.message}`;               // already gone or too old: stop trying
      }
    }
    await ops.run("UPDATE content_items SET expired_at=?, last_error=CASE WHEN ?='' THEN last_error ELSE ? END, updated_at=? WHERE id=?",
      now, note, note, now, item.id);
    expired++;
  }
  return expired;
}

// The latest occurrence (<= now) of each configured HH:MM UTC time, as slot IDs like 20261121T1430Z.
export function dueSlots(times, now, windowSeconds = 30 * 60) {
  const out = [];
  for (const t of times) {
    const [h, m] = t.split(":").map(Number);
    let at = Math.floor(now / 86400) * 86400 + h * 3600 + m * 60;
    if (at > now) at -= 86400;
    if (now - at <= windowSeconds) {
      const d = new Date(at * 1000).toISOString();
      out.push({ slot: `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}T${d.slice(11, 13)}${d.slice(14, 16)}Z`, at });
    }
  }
  return out;
}

// Automated paid media: at each configured time, queue the next unused asset from its own Cloudinary folder.
// The slot is claimed in D1 first (INSERT … ON CONFLICT DO NOTHING), so one slot can never create two posts.
// Used assets are remembered in D1, never as Cloudinary tags. The GitHub poster's folder is refused.
export async function queueAutoPaidMedia(ops, now, listAssets) {
  const cfg = await ops.paidMediaConfig();
  if (!cfg.folder || !cfg.times_utc.length || cfg.folder.toLowerCase() === GITHUB_POSTER_FOLDER || !listAssets) return [];
  const queued = [];
  for (const { slot } of dueSlots(cfg.times_utc, now)) {
    const claim = await ops.run("INSERT INTO auto_paid_runs (slot, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING", slot, now);
    if (claim.meta.changes !== 1) continue; // this slot was already handled
    let assets;
    try {
      assets = await listAssets(cfg.folder);
    } catch (err) {
      await ops.run("UPDATE auto_paid_runs SET note=? WHERE slot=?", `listing failed: ${err.message}`, slot);
      continue;
    }
    const used = new Set((await ops.all("SELECT public_id FROM auto_paid_posted")).map((r) => r.public_id));
    const next = assets.filter((a) => classify(a).kind && ["photo", "video"].includes(classify(a).kind) && !used.has(a.public_id))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.public_id.localeCompare(b.public_id))[0];
    if (!next) {
      await ops.run("UPDATE auto_paid_runs SET note='no unused media left in the folder' WHERE slot=?", slot);
      continue;
    }
    const item = await ops.createContent({
      kind: "paid_media", target: cfg.target, media_url: next.secure_url, star_count: next.stars || cfg.default_stars,
      text: next.caption || cfg.caption || "", expire_after_minutes: cfg.expire_after_minutes, source: `auto:${next.public_id}`,
    }, "automation");
    await ops.scheduleContent(item.id, now, "automation");
    await ops.run("INSERT INTO auto_paid_posted (public_id, content_id, posted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", next.public_id, item.id, now);
    await ops.run("UPDATE auto_paid_runs SET public_id=?, content_id=? WHERE slot=?", next.public_id, item.id, slot);
    queued.push(item.id);
  }
  return queued;
}

export async function runCycle(tg, ops, config, now, alert, { listAssets = null } = {}) {
  await ops.setSetting("heartbeat:worker", now);
  // Housekeeping: forget expired session revocations and old login failures.
  await ops.run("DELETE FROM revoked_sessions WHERE expires_at < ?", now);
  await ops.run("DELETE FROM login_failures WHERE at < ?", now - 86400);
  const summary = {};
  if (await ops.featureEnabled("auto_paid_media")) summary.auto_paid_queued = (await queueAutoPaidMedia(ops, now, listAssets)).length;
  if (await ops.featureEnabled("scheduled_posts")) summary.posts = await publishDue(tg, ops, config, now, alert);
  if (await ops.featureEnabled("poll_auto_close")) summary.polls_closed = await closeDuePolls(tg, ops, config, now);
  if (await ops.featureEnabled("post_expiry")) summary.expired = await expirePosts(tg, ops, config, now);
  // Preview/staging touches no real member: no admin actions, no reminders.
  if (config.previewChatId || config.requirePreview) return summary;
  if (await ops.featureEnabled("admin_actions")) summary.actions = await runAdminActions(tg, ops, config, now);
  return summary;
}
