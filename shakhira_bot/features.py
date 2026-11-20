"""Handlers that need the bot to RECEIVE updates: join requests, reactions, moderation, profiles, /admin.

These only run in the full bot (python -m shakhira_bot), which may only be started once the
current live bot has been retired: Telegram delivers a token's updates to one program only.
The send-only worker never runs these.
"""

import logging
import re
import time

from telegram import ChatPermissions, Update
from telegram.error import Forbidden, TelegramError
from telegram.ext import ContextTypes

from . import texts
from .alerts import NO_ALERTS, AdminAlerts
from .config import Config
from .ops import Ops
from .storage import Storage

logger = logging.getLogger(__name__)

MUTE_SECONDS = 24 * 3600
STRIKE_WINDOW = 24 * 3600
STRIKES_BEFORE_MUTE = 3
URL_RE = re.compile(r"(https?://\S+|t\.me/\S+|www\.\S+)", re.IGNORECASE)


def _deps(context) -> tuple[Config, Storage, AdminAlerts]:
    data = context.application.bot_data
    return data["config"], data["storage"], data.get("alerts", NO_ALERTS)


def channel_target(cfg: Config, chat) -> str | None:
    if chat.id == cfg.vip_channel_id:
        return "vip"
    username = (getattr(chat, "username", None) or "").lower()
    if username and username == cfg.public_channel.lstrip("@").lower():
        return "public"
    return None


# Profiles


async def track_profile(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Runs before every other handler: remember who talks to the bot privately."""
    user = update.effective_user
    chat = update.effective_chat
    if user is None or user.is_bot or chat is None or chat.type != "private":
        return
    _, store, _ = _deps(context)
    source = ""
    message = update.effective_message
    if message and message.text and message.text.startswith("/start "):
        source = message.text.split(" ", 1)[1].strip()[:64]  # e.g. promo_12 from a promotion button
    store.ops.touch_profile(user.id, user.username or "", user.first_name or "", source)


# Join requests


async def decide_join_request(bot, ops: Ops, store: Storage, cfg: Config, target: str, chat_id: int, user,
                              now: int, alerts: AdminAlerts = NO_ALERTS) -> str:
    """Record a join request and apply the channel's policy. Returns approved, declined or pending."""
    request_id = ops.record_join_request(chat_id, user.id, user.username or "", user.first_name or "", now)
    ops.touch_profile(user.id, user.username or "", user.first_name or "", f"join_{target}", now)
    policy = ops.join_policy(target)
    approve = policy == "approve_all" and target == "public"
    if policy == "approve_paid" and target == "vip":
        approve = store.active_trial(user.id, now) is not None
    if approve:
        try:
            await bot.approve_chat_join_request(chat_id=chat_id, user_id=user.id)
            ops.set_join_status(request_id, "approved", f"policy {policy}", "bot", now)
            return "approved"
        except TelegramError as exc:
            ops.set_join_status(request_id, "failed", str(exc), "bot", now)
            return "failed"
    if target == "vip":
        # The requester can be messaged even without /start. Point them to the paid plans.
        try:
            await bot.send_message(chat_id=user.id, text=texts.join_request_vip(cfg))
        except (Forbidden, TelegramError):
            logger.info("Could not message join requester %s", user.id)
    await alerts.send(bot, f"New join request for the {target} channel from user {user.id} "
                      f"(@{user.username or '-'}). Review it in the dashboard.", key=f"join-{target}")
    return "pending"


async def join_request(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store, alerts = _deps(context)
    req = update.chat_join_request
    if req is None or not store.ops.feature_enabled("join_requests"):
        return
    target = channel_target(cfg, req.chat)
    if target is None:
        return
    await decide_join_request(context.bot, store.ops, store, cfg, target, req.chat.id, req.from_user,
                              int(time.time()), alerts)


# Reactions


def reaction_key(reaction_type) -> str:
    emoji = getattr(reaction_type, "emoji", None)
    if emoji:
        return emoji
    custom = getattr(reaction_type, "custom_emoji_id", None)
    return f"custom:{custom}" if custom else str(getattr(reaction_type, "type", "other"))


def record_reaction_counts(ops: Ops, cfg: Config, update_obj, now: int) -> bool:
    if channel_target(cfg, update_obj.chat) is None:
        return False
    counts: dict[str, int] = {}
    for reaction in update_obj.reactions:
        key = reaction_key(reaction.type)
        counts[key] = counts.get(key, 0) + reaction.total_count
    ops.save_reactions(update_obj.chat.id, update_obj.message_id, counts, now)
    return True


async def reaction_count(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store, _ = _deps(context)
    if update.message_reaction_count and store.ops.feature_enabled("reaction_tracking"):
        record_reaction_counts(store.ops, cfg, update.message_reaction_count, int(time.time()))


# Moderation of an EXISTING discussion group


def match_rule(text: str, rules: list[dict]) -> dict | None:
    """First rule the text breaks. Words match whole words; links match inside any URL in the text."""
    lowered = (text or "").lower()
    if not lowered:
        return None
    urls = [u.lower() for u in URL_RE.findall(lowered)]
    for rule in rules:
        pattern = rule["pattern"]
        if rule["kind"] == "word" and re.search(r"(?<!\w)" + re.escape(pattern) + r"(?!\w)", lowered):
            return rule
        if rule["kind"] == "link" and any(pattern in url for url in urls):
            return rule
    return None


async def moderate_message(bot, ops: Ops, cfg: Config, message, now: int) -> str | None:
    """Apply moderation rules to one group message. Returns the action taken, or None."""
    if cfg.discussion_group_id is None or message.chat.id != cfg.discussion_group_id:
        return None
    if getattr(message, "is_automatic_forward", False) or getattr(message, "sender_chat", None):
        return None  # the channel's own posts and anonymous admins
    user = message.from_user
    if user is None or user.is_bot:
        return None
    rule = match_rule(message.text or message.caption or "", ops.moderation_rules(active_only=True))
    if rule is None:
        return None
    member = await bot.get_chat_member(chat_id=message.chat.id, user_id=user.id)
    if member.status in ("creator", "administrator"):
        return None
    action = rule["action"]
    await bot.delete_message(chat_id=message.chat.id, message_id=message.message_id)
    ops.log_moderation(message.chat.id, user.id, rule["id"], action, message.text or message.caption or "", now)
    strikes = ops.strikes(user.id, now - STRIKE_WINDOW)
    if action == "delete_mute" or strikes >= STRIKES_BEFORE_MUTE:
        await bot.restrict_chat_member(chat_id=message.chat.id, user_id=user.id,
                                       permissions=ChatPermissions(can_send_messages=False),
                                       until_date=now + MUTE_SECONDS)
        ops.log_moderation(message.chat.id, user.id, rule["id"], "muted_24h", "", now)
        return "muted"
    if action == "delete_warn":
        await bot.send_message(chat_id=message.chat.id, text=texts.moderation_warning(user.first_name or "there"))
        return "warned"
    return "deleted"


async def group_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store, alerts = _deps(context)
    if update.effective_message is None or not store.ops.feature_enabled("moderation"):
        return
    try:
        await moderate_message(context.bot, store.ops, cfg, update.effective_message, int(time.time()))
    except TelegramError as exc:
        await alerts.send(context.bot, f"Moderation action failed: {exc}. Check the bot's admin rights in the "
                          "discussion group.", key="moderation-failed")


# Admin command


def stats(store: Storage, now: int) -> dict:
    ops = store.ops
    data = ops.analytics(now)
    data["scheduled"] = len(ops.content_list(status="scheduled"))
    data["join_pending"] = len(ops.join_requests("pending"))
    data["actions_queued"] = len(ops.queued_actions())
    return data


async def admin_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store, _ = _deps(context)
    user = update.effective_user
    if user is None or user.id not in cfg.admin_chat_ids:
        return  # silently ignore: don't reveal admin commands to members
    await update.effective_message.reply_text(texts.admin_stats(stats(store, int(time.time()))))
