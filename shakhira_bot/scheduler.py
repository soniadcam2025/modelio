"""Send-only engine: scheduled posts, polls/quizzes, promotions, paid media, reminders and admin actions.

Everything here only SENDS to Telegram (sendMessage, sendPoll, stopPoll, sendPaidMedia,
approveChatJoinRequest, ...). It never receives updates (no getUpdates, no webhook), so it can run
next to the live bot on the same token without taking anything over, exactly like the GitHub poster.

Every part is switched off until its feature flag is turned on in the dashboard.
A post is never sent twice: an item is claimed ('sending') before the send, and if the process
dies mid-send the item becomes 'uncertain' for a human to check, instead of being retried.
"""

import json
import logging
import warnings
from datetime import timedelta

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, InputPaidMediaPhoto, InputPaidMediaVideo
from telegram.error import BadRequest, Forbidden, NetworkError, RetryAfter, TelegramError, TimedOut

from . import access
from .alerts import NO_ALERTS, AdminAlerts
from .config import Config
from .ops import Ops
from .storage import Storage

logger = logging.getLogger(__name__)

STALE_SENDING_SECONDS = 10 * 60
MAX_RETRY_DELAY = 15 * 60
TRIAL_REMINDER_BEFORE = 24 * 3600
RENEWAL_REMINDER_BEFORE = 3 * 86400
VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".webm")


def target_chat(cfg: Config, target: str):
    if cfg.preview_chat_id is not None:
        return cfg.preview_chat_id  # preview mode: nothing reaches the channels
    return cfg.vip_channel_id if target == "vip" else cfg.public_channel


def _retry_seconds(exc: RetryAfter) -> int:
    with warnings.catch_warnings():  # PTB 22 warns that retry_after will become a timedelta; both are handled
        warnings.simplefilter("ignore")
        value = exc.retry_after
    if isinstance(value, timedelta):
        value = value.total_seconds()
    return max(1, min(int(value), MAX_RETRY_DELAY))


def _markup(item: dict, cfg: Config) -> InlineKeyboardMarkup | None:
    if item["button_text"] and item["button_url"]:
        return InlineKeyboardMarkup([[InlineKeyboardButton(item["button_text"], url=item["button_url"])]])
    if item["kind"] == "promo":
        # Deep link into the bot, so a full bot can tell which promotion brought the user.
        url = f"https://t.me/{cfg.bot_username}?start=promo_{item['id']}"
        return InlineKeyboardMarkup([[InlineKeyboardButton("💎 Join VIP", url=url)]])
    return None


async def send_item(bot, cfg: Config, item: dict, text: str):
    """Send one content item. Returns the Telegram Message."""
    chat = target_chat(cfg, item["target"])
    kind = item["kind"]
    markup = _markup(item, cfg)
    caption = text or None
    if kind in ("text", "promo"):
        return await bot.send_message(chat_id=chat, text=text, reply_markup=markup)
    if kind == "photo":
        return await bot.send_photo(chat_id=chat, photo=item["media_url"], caption=caption, reply_markup=markup)
    if kind == "video":
        return await bot.send_video(chat_id=chat, video=item["media_url"], caption=caption, reply_markup=markup,
                                    supports_streaming=True)
    if kind == "animation":
        return await bot.send_animation(chat_id=chat, animation=item["media_url"], caption=caption,
                                        reply_markup=markup)
    if kind in ("poll", "quiz"):
        options = json.loads(item["options_json"])
        extra = {}
        if kind == "quiz":
            extra = {"type": "quiz", "correct_option_id": item["correct_option"],
                     "explanation": item["explanation"] or None}
        # Polls in channels must be anonymous.
        return await bot.send_poll(chat_id=chat, question=text, options=options, is_anonymous=True,
                                   allows_multiple_answers=bool(item["multiple_answers"]), **extra)
    if kind == "paid_media":
        url = item["media_url"]
        media = InputPaidMediaVideo(media=url) if url.lower().split("?")[0].endswith(VIDEO_EXTENSIONS) \
            else InputPaidMediaPhoto(media=url)
        return await bot.send_paid_media(chat_id=chat, star_count=item["star_count"], media=[media], caption=caption)
    raise ValueError(f"Unknown content kind {kind!r}")


async def publish_due(bot, ops: Ops, cfg: Config, now: int, alerts: AdminAlerts = NO_ALERTS) -> dict:
    """Send every scheduled item that is due. Returns counts per outcome."""
    counts = {"posted": 0, "failed": 0, "uncertain": 0, "retry": 0}
    for stale in ops.stale_sending(now - STALE_SENDING_SECONDS):
        ops.mark_failed(stale["id"], "uncertain", "the worker stopped while sending; check the channel", now)
        counts["uncertain"] += 1
        await alerts.send(bot, f"Scheduled post #{stale['id']} may or may not have been sent (the worker stopped "
                          "mid-send). Check the channel; it will NOT be sent again automatically.")
    for item in ops.due_content(now):
        if not ops.claim_for_sending(item["id"], now):
            continue
        text = item["text"]
        if not text and item["use_caption_library"]:
            text = ops.next_caption(now) or ""
        try:
            message = await send_item(bot, cfg, item, text)
        except RetryAfter as exc:
            ops.mark_failed(item["id"], "scheduled", "Telegram rate limit", now, retry_at=now + _retry_seconds(exc))
            counts["retry"] += 1
            continue
        except (BadRequest, Forbidden) as exc:
            ops.mark_failed(item["id"], "failed", f"Telegram refused it: {exc}", now)
            counts["failed"] += 1
            await alerts.send(bot, f"Scheduled post #{item['id']} ({item['kind']} to {item['target']}) was refused "
                              f"by Telegram: {exc}. Fix it in the dashboard and schedule it again.")
            continue
        except (TimedOut, NetworkError) as exc:
            ops.mark_failed(item["id"], "uncertain", f"no confirmation from Telegram: {type(exc).__name__}", now)
            counts["uncertain"] += 1
            await alerts.send(bot, f"Scheduled post #{item['id']} may or may not have been sent (no confirmation "
                              "from Telegram). Check the channel; it will NOT be sent again automatically.")
            continue
        except TelegramError as exc:
            ops.mark_failed(item["id"], "failed", f"{type(exc).__name__}: {exc}", now)
            counts["failed"] += 1
            continue
        ops.mark_posted(item["id"], message.message_id, now, text if text != item["text"] else None)
        logger.info("Posted scheduled item %s (%s) as message %s", item["id"], item["kind"], message.message_id)
        counts["posted"] += 1
    return counts


def poll_results(poll) -> dict:
    return {
        "total_voters": poll.total_voter_count,
        "options": [{"text": o.text, "votes": o.voter_count} for o in poll.options],
        "correct_option": getattr(poll, "correct_option_id", None),
    }


async def close_poll(bot, ops: Ops, cfg: Config, item: dict, now: int) -> dict:
    poll = await bot.stop_poll(chat_id=target_chat(cfg, item["target"]), message_id=item["message_id"])
    results = poll_results(poll)
    ops.save_poll_results(item["id"], results, now)
    return results


async def close_due_polls(bot, ops: Ops, cfg: Config, now: int) -> int:
    closed = 0
    for item in ops.polls_to_close(now):
        try:
            await close_poll(bot, ops, cfg, item, now)
            closed += 1
        except BadRequest as exc:
            # Already closed or deleted by hand: stop trying.
            ops.save_poll_results(item["id"], {"error": str(exc), "options": [], "total_voters": 0}, now)
        except TelegramError:
            logger.warning("Could not close poll #%s; will retry", item["id"])
    return closed


async def run_admin_actions(bot, store: Storage, ops: Ops, cfg: Config, now: int,
                            alerts: AdminAlerts = NO_ALERTS) -> dict:
    counts = {"done": 0, "failed": 0}
    for action in ops.queued_actions():
        payload = json.loads(action["payload_json"])
        kind = action["kind"]
        try:
            if kind in ("approve_join", "decline_join"):
                request = ops.join_request(payload["request_id"])
                if request is None or request["status"] != "pending":
                    raise ValueError("join request is no longer pending")
                if kind == "approve_join":
                    await bot.approve_chat_join_request(chat_id=payload["chat_id"], user_id=payload["user_id"])
                else:
                    await bot.decline_chat_join_request(chat_id=payload["chat_id"], user_id=payload["user_id"])
                ops.set_join_status(request["id"], "approved" if kind == "approve_join" else "declined",
                                    "by dashboard", action["created_by"], now)
            elif kind == "remove_member":
                membership = await access.get_membership(bot, cfg, payload["user_id"])
                if membership.is_admin:
                    raise ValueError("that user is a channel admin")
                await access.remove_from_channel(bot, store, cfg, payload["user_id"], now, alerts)
            elif kind == "unban_member":
                await bot.unban_chat_member(chat_id=cfg.vip_channel_id, user_id=payload["user_id"], only_if_banned=True)
                store.clear_pending_unban(payload["user_id"])
            elif kind == "send_dm":
                await bot.send_message(chat_id=payload["user_id"], text=payload["text"])
            elif kind == "close_poll":
                item = ops.content(payload["content_id"])
                if item is None or item["poll_closed_at"]:
                    raise ValueError("poll is already closed")
                await close_poll(bot, ops, cfg, item, now)
            else:
                raise ValueError(f"unknown action {kind}")
        except (TelegramError, ValueError) as exc:
            ops.finish_action(action["id"], False, f"{type(exc).__name__}: {exc}", now)
            if kind in ("approve_join", "decline_join") and isinstance(exc, TelegramError):
                ops.set_join_status(payload["request_id"], "failed", str(exc), action["created_by"], now)
            counts["failed"] += 1
            continue
        ops.finish_action(action["id"], True, "", now)
        ops.audit("worker", "action_done", f"#{action['id']} {kind}")
        counts["done"] += 1
    return counts


async def _remind(bot, ops: Ops, key: str, user_id: int, text: str, now: int) -> bool:
    try:
        await bot.send_message(chat_id=user_id, text=text)
    except Forbidden:
        logger.info("User %s blocked the bot; reminder %s skipped", user_id, key)
    except TelegramError:
        logger.warning("Reminder %s failed; will retry", key)
        return False
    ops.mark_reminder(key, now)
    return True


async def send_reminders(bot, store: Storage, ops: Ops, cfg: Config, now: int) -> int:
    from . import texts

    sent = 0
    if ops.feature_enabled("trial_reminders"):
        for row in store.conn.execute(
                "SELECT id, user_id, expires_at FROM trials WHERE status='active' AND joined_at IS NOT NULL "
                "AND expires_at > ? AND expires_at <= ?", (now, now + TRIAL_REMINDER_BEFORE)).fetchall():
            key = f"trial_end:{row['id']}"
            if not ops.reminder_sent(key):
                # Only the saved link is used: a send-only worker never creates invite links.
                link = store.get_setting(f"{access.MONTHLY_LINK_KEY}{cfg.monthly_price}")
                sent += await _remind(bot, ops, key, row["user_id"], texts.trial_ending(row["expires_at"], cfg, link), now)
    if ops.feature_enabled("renewal_reminders"):
        rows = store.conn.execute(
            "SELECT user_id, MAX(subscription_until) AS until FROM member_events WHERE subscription_until IS NOT NULL "
            "GROUP BY user_id HAVING until > ? AND until <= ?", (now, now + RENEWAL_REMINDER_BEFORE)).fetchall()
        for row in rows:
            left = store.conn.execute("SELECT 1 FROM member_events WHERE user_id=? AND event='left' AND created_at > "
                                      "(SELECT MAX(created_at) FROM member_events WHERE user_id=? AND "
                                      "subscription_until IS NOT NULL)", (row["user_id"], row["user_id"])).fetchone()
            key = f"renew:{row['user_id']}:{row['until']}"
            if not left and not ops.reminder_sent(key):
                sent += await _remind(bot, ops, key, row["user_id"], texts.renewal_coming(row["until"]), now)
    return sent


async def run_cycle(bot, store: Storage, cfg: Config, now: int, alerts: AdminAlerts = NO_ALERTS) -> dict:
    """One pass of every enabled send-only feature."""
    ops = store.ops
    ops.set_setting("heartbeat:worker", str(now))  # the dashboard shows when the worker last ran
    summary: dict = {}
    if ops.feature_enabled("scheduled_posts"):
        summary["posts"] = await publish_due(bot, ops, cfg, now, alerts)
    if ops.feature_enabled("poll_auto_close"):
        summary["polls_closed"] = await close_due_polls(bot, ops, cfg, now)
    if cfg.preview_chat_id is not None:
        return summary  # preview mode touches no real member: no admin actions, no reminders
    if ops.feature_enabled("admin_actions"):
        summary["actions"] = await run_admin_actions(bot, store, ops, cfg, now, alerts)
    summary["reminders"] = await send_reminders(bot, store, ops, cfg, now)
    return summary
