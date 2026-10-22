"""Telegram update handlers: commands, menu buttons, Stars checkout and channel membership events."""

import logging
import time

from telegram import (
    ChatMember,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    LabeledPrice,
    SuccessfulPayment,
    Update,
)
from telegram.error import Forbidden, TelegramError
from telegram.ext import ContextTypes

from . import access, texts
from .config import Config
from .payments import STARS_CURRENCY, TRIAL_PLAN, check_payment, make_payload, parse_payload
from .storage import Storage

logger = logging.getLogger(__name__)


def _deps(context: ContextTypes.DEFAULT_TYPE) -> tuple[Config, Storage]:
    return context.application.bot_data["config"], context.application.bot_data["storage"]


# Keyboards


def main_menu(cfg: Config) -> InlineKeyboardMarkup:
    rows = [
        [InlineKeyboardButton(f"💎 VIP Monthly — {cfg.monthly_price} ⭐", callback_data="plan:monthly")],
        [InlineKeyboardButton(f"⏳ {cfg.trial_days}-day trial — {cfg.trial_price} ⭐", callback_data="plan:trial")],
        [InlineKeyboardButton("👤 My membership", callback_data="status")],
        [InlineKeyboardButton("📢 Free channel", url=cfg.public_channel_url)],
    ]
    rows.append(
        [InlineKeyboardButton("💬 Support", url=cfg.support_url)]
        if cfg.support_url
        else [InlineKeyboardButton("💬 Support", callback_data="support")]
    )
    return InlineKeyboardMarkup(rows)


def plans_menu(cfg: Config) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(f"💎 VIP Monthly — {cfg.monthly_price} ⭐", callback_data="plan:monthly")],
        [InlineKeyboardButton(f"⏳ {cfg.trial_days}-day trial — {cfg.trial_price} ⭐", callback_data="plan:trial")],
    ])


def link_button(text: str, url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(text, url=url)]])


# Shared logic (kept free of Update objects so it can be tested with a fake bot)


async def build_status(bot, store: Storage, cfg: Config, user_id: int, now: int) -> tuple[str, InlineKeyboardMarkup | None]:
    try:
        membership = await access.get_membership(bot, cfg, user_id)
    except TelegramError:
        logger.exception("Membership check failed for user %s", user_id)
        return texts.status_unavailable(), None

    trial = store.active_trial(user_id, now)
    if membership.is_admin:
        return texts.status_admin(), None
    if membership.subscription_until and membership.subscription_until > now:
        return texts.status_monthly(membership.subscription_until), None
    if trial and membership.in_channel:
        return texts.status_trial(trial.expires_at), None
    if trial:
        return texts.status_trial_not_joined(trial.expires_at), InlineKeyboardMarkup(
            [[InlineKeyboardButton("🔑 Get my access link", callback_data="trial_link")]]
        )
    if membership.in_channel:
        return texts.status_member_other(), None
    return texts.status_none(), plans_menu(cfg)


async def monthly_reply(bot, store: Storage, cfg: Config, user_id: int, now: int) -> tuple[str, InlineKeyboardMarkup | None]:
    try:
        membership = await access.get_membership(bot, cfg, user_id)
    except TelegramError:
        logger.exception("Membership check failed for user %s", user_id)
        return texts.status_unavailable(), None
    if membership.subscription_until and membership.subscription_until > now:
        return texts.already_subscribed(membership.subscription_until), None
    trial = store.active_trial(user_id, now)
    if trial and membership.in_channel:
        return texts.trial_member_monthly_later(trial.expires_at), None
    if membership.in_channel:
        return texts.already_member(), None
    try:
        link = await access.get_monthly_link(bot, store, cfg)
    except TelegramError:
        logger.exception("Could not create the VIP Monthly subscription link")
        return texts.link_error(), None
    return texts.monthly_offer(cfg), link_button("💎 Subscribe", link)


async def trial_block_reason(bot, store: Storage, cfg: Config, user_id: int) -> str | None:
    """Why this user can't buy a trial right now, or None if they can."""
    if cfg.trial_once_per_user and store.has_used_trial(user_id):
        return texts.trial_used()
    try:
        membership = await access.get_membership(bot, cfg, user_id)
    except TelegramError:
        logger.exception("Membership check failed for user %s", user_id)
        return texts.status_unavailable()
    if membership.in_channel:
        return texts.already_member()
    return None


async def process_trial_payment(
    bot, store: Storage, cfg: Config, user_id: int, payment: SuccessfulPayment, now: int
) -> tuple[str, InlineKeyboardMarkup | None] | None:
    """Grant a trial for a verified Stars payment. Returns None for a duplicate payment update."""
    reason = check_payment(cfg, payment.currency, payment.total_amount, payment.invoice_payload, user_id)
    parsed = parse_payload(payment.invoice_payload)
    plan = parsed[0] if parsed else "unknown"
    is_new = store.record_payment(
        payment.telegram_payment_charge_id,
        user_id,
        plan,
        payment.total_amount,
        payment.currency,
        payment.invoice_payload,
        now,
    )
    if not is_new:
        logger.warning("Duplicate payment update ignored (user %s)", user_id)
        return None
    if reason:
        logger.error("Payment from user %s did not match an offer (%s); access NOT granted", user_id, reason)
        return texts.support(cfg), None

    trial, link = await access.start_trial(bot, store, cfg, user_id, payment.telegram_payment_charge_id, now)
    logger.info("Trial %s started for user %s until %s", trial.id, user_id, trial.expires_at)
    if link is None:
        return texts.trial_paid_link_failed(), None
    return texts.trial_paid(trial.expires_at), link_button("🔑 Join VIP", link)


# Commands


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, _ = _deps(context)
    await update.effective_message.reply_text(texts.welcome(cfg), reply_markup=main_menu(cfg))


async def subscribe(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, _ = _deps(context)
    await update.effective_message.reply_text(texts.choose_plan(cfg), reply_markup=plans_menu(cfg))


async def status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store = _deps(context)
    text, markup = await build_status(context.bot, store, cfg, update.effective_user.id, int(time.time()))
    await update.effective_message.reply_text(text, reply_markup=markup)


async def rules(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, _ = _deps(context)
    await update.effective_message.reply_text(texts.rules(cfg))


async def paysupport(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, _ = _deps(context)
    await update.effective_message.reply_text(texts.support(cfg))


# Menu buttons


async def menu_button(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer()
    cfg, store = _deps(context)
    user_id = query.from_user.id
    chat_id = query.message.chat.id if query.message else user_id
    now = int(time.time())
    bot = context.bot

    if query.data == "plan:monthly":
        text, markup = await monthly_reply(bot, store, cfg, user_id, now)
    elif query.data == "plan:trial":
        blocked = await trial_block_reason(bot, store, cfg, user_id)
        if blocked:
            text, markup = blocked, None
        else:
            await bot.send_invoice(
                chat_id=chat_id,
                title=texts.trial_invoice_title(cfg),
                description=texts.trial_invoice_description(cfg),
                payload=make_payload(TRIAL_PLAN, user_id),
                currency=STARS_CURRENCY,
                prices=[LabeledPrice(f"{cfg.trial_days}-day trial", cfg.trial_price)],
            )
            return
    elif query.data == "status":
        text, markup = await build_status(bot, store, cfg, user_id, now)
    elif query.data == "trial_link":
        trial = store.active_trial(user_id, now)
        if trial is None:
            text, markup = texts.status_none(), plans_menu(cfg)
        else:
            try:
                link = await access.issue_trial_link(bot, store, cfg, trial, now)
                text, markup = texts.trial_paid(trial.expires_at), link_button("🔑 Join VIP", link)
            except TelegramError:
                logger.exception("Could not re-issue trial link for user %s", user_id)
                text, markup = texts.link_error(), None
    elif query.data == "support":
        text, markup = texts.support(cfg), None
    else:
        return
    await bot.send_message(chat_id=chat_id, text=text, reply_markup=markup)


# Payments


async def pre_checkout(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.pre_checkout_query
    cfg, store = _deps(context)
    user_id = query.from_user.id
    reason = check_payment(cfg, query.currency, query.total_amount, query.invoice_payload, user_id)
    if reason:
        logger.warning("Rejected checkout from user %s: %s", user_id, reason)
        await query.answer(ok=False, error_message=texts.checkout_rejected())
        return
    blocked = await trial_block_reason(context.bot, store, cfg, user_id)
    if blocked:
        await query.answer(ok=False, error_message=blocked)
        return
    await query.answer(ok=True)


async def successful_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store = _deps(context)
    message = update.effective_message
    result = await process_trial_payment(
        context.bot, store, cfg, update.effective_user.id, message.successful_payment, int(time.time())
    )
    if result:
        text, markup = result
        await message.reply_text(text, reply_markup=markup)


# VIP channel membership events


def _in_channel(member: ChatMember) -> bool:
    if member.status in (ChatMember.OWNER, ChatMember.ADMINISTRATOR, ChatMember.MEMBER):
        return True
    return member.status == ChatMember.RESTRICTED and bool(getattr(member, "is_member", False))


async def channel_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store = _deps(context)
    change = update.chat_member
    if change is None or change.chat.id != cfg.vip_channel_id:
        return
    was_in, now_in = _in_channel(change.old_chat_member), _in_channel(change.new_chat_member)
    if was_in == now_in:
        return

    user_id = change.new_chat_member.user.id
    now = int(time.time())
    invite = change.invite_link
    if now_in:
        until = access.to_ts(getattr(change.new_chat_member, "until_date", None))
        event = "joined_subscription" if invite and invite.subscription_period else "joined"
        if invite and invite.name and invite.name.startswith("trial "):
            if store.mark_trial_joined(invite.invite_link, user_id, now):
                event = "joined_trial"
            else:
                logger.warning("User %s joined with someone else's trial link %r", user_id, invite.name)
        store.log_member_event(user_id, event, invite.name if invite else None, until, now)
    else:
        store.log_member_event(user_id, "left", None, None, now)


# Scheduled trial expiry


async def expiry_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    cfg, store = _deps(context)
    bot = context.bot
    results = await access.expire_trials(bot, store, cfg, int(time.time()))
    for user_id, outcome in results:
        if outcome not in ("removed", "not_in_channel"):
            continue
        try:
            link = await access.get_monthly_link(bot, store, cfg)
            markup = link_button(f"💎 VIP Monthly — {cfg.monthly_price} ⭐", link)
        except TelegramError:
            logger.exception("Could not get monthly link for trial-ended message")
            markup = plans_menu(cfg)
        try:
            await bot.send_message(chat_id=user_id, text=texts.trial_ended(cfg), reply_markup=markup)
        except Forbidden:
            logger.info("User %s blocked the bot; trial-ended message not sent", user_id)
        except TelegramError:
            logger.exception("Could not send trial-ended message to user %s", user_id)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    logger.error("Unhandled error while processing an update", exc_info=context.error)
    # Only reply in private chats, never inside the VIP channel.
    if isinstance(update, Update) and update.effective_chat and update.effective_chat.type == "private":
        try:
            await context.bot.send_message(chat_id=update.effective_chat.id, text=texts.generic_error())
        except TelegramError:
            pass
