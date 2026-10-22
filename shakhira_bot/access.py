"""VIP channel access: subscription link, trial links, membership status and trial expiry."""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from telegram import ChatMember
from telegram.error import TelegramError

from .config import Config
from .storage import Storage, Trial

logger = logging.getLogger(__name__)

# Telegram only allows 30-day periods for channel subscription links.
SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60
# How long a trial invite link stays usable (it is also single-use).
TRIAL_LINK_TTL_SECONDS = 24 * 60 * 60
MONTHLY_LINK_KEY = "monthly_link:"


@dataclass(frozen=True)
class Membership:
    in_channel: bool
    is_admin: bool = False
    subscription_until: int | None = None  # set by Telegram for paying monthly subscribers


def to_ts(value: datetime | None) -> int | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return int(value.timestamp())


async def get_monthly_link(bot, store: Storage, cfg: Config) -> str:
    """Return the 30-day Stars subscription invite link, creating it once per price."""
    key = f"{MONTHLY_LINK_KEY}{cfg.monthly_price}"
    link = store.get_setting(key)
    if link:
        return link
    created = await bot.create_chat_subscription_invite_link(
        chat_id=cfg.vip_channel_id,
        subscription_period=SUBSCRIPTION_PERIOD_SECONDS,
        subscription_price=cfg.monthly_price,
        name=f"VIP Monthly {cfg.monthly_price}",
    )
    store.set_setting(key, created.invite_link)
    logger.info("Created VIP Monthly subscription link for %s Stars", cfg.monthly_price)
    return created.invite_link


async def get_membership(bot, cfg: Config, user_id: int) -> Membership:
    member = await bot.get_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id)
    status = member.status
    if status in (ChatMember.OWNER, ChatMember.ADMINISTRATOR):
        return Membership(in_channel=True, is_admin=True)
    if status == ChatMember.MEMBER:
        return Membership(in_channel=True, subscription_until=to_ts(getattr(member, "until_date", None)))
    if status == ChatMember.RESTRICTED:
        return Membership(in_channel=bool(getattr(member, "is_member", False)))
    return Membership(in_channel=False)


async def issue_trial_link(bot, store: Storage, cfg: Config, trial: Trial, now: int) -> str:
    """Create a single-use invite link for a paid trial."""
    expire = min(trial.expires_at, now + TRIAL_LINK_TTL_SECONDS)
    link = await bot.create_chat_invite_link(
        chat_id=cfg.vip_channel_id,
        expire_date=expire,
        member_limit=1,
        name=f"trial {trial.user_id}"[:32],
    )
    store.set_trial_link(trial.id, link.invite_link)
    return link.invite_link


async def start_trial(bot, store: Storage, cfg: Config, user_id: int, charge_id: str, now: int) -> tuple[Trial, str | None]:
    """Create the trial record for a verified payment and try to issue its invite link.

    The trial is saved before any Telegram call, so a failed link can be re-issued later from /status.
    """
    current = store.active_trial(user_id, now)
    starts_at = max(now, current.expires_at) if current else now
    trial = store.create_trial(user_id, charge_id, starts_at, starts_at + cfg.trial_days * 86400)
    try:
        link = await issue_trial_link(bot, store, cfg, trial, now)
    except TelegramError:
        logger.exception("Trial paid but invite link failed (user %s, trial %s)", user_id, trial.id)
        link = None
    return trial, link


async def remove_from_channel(bot, cfg: Config, user_id: int) -> None:
    """Remove a member without a permanent ban, so they can rejoin later by paying."""
    await bot.ban_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id)
    await bot.unban_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id, only_if_banned=True)


async def expire_trials(bot, store: Storage, cfg: Config, now: int) -> list[tuple[int, str]]:
    """End every trial whose time is up. Returns (user_id, outcome) for each processed trial.

    A user is only removed when they have no newer trial, are not an admin, and have no
    active Telegram subscription. Failures leave the trial active so the next run retries.
    """
    results = []
    for trial in store.due_trials(now):
        user_id = trial.user_id
        try:
            if store.active_trial(user_id, now):
                store.end_trial(trial.id, "ended", now)
                results.append((user_id, "extended"))
                continue

            membership = await get_membership(bot, cfg, user_id)
            if membership.is_admin:
                outcome = "admin"
            elif membership.subscription_until and membership.subscription_until > now:
                outcome = "converted"
            elif membership.in_channel:
                await remove_from_channel(bot, cfg, user_id)
                outcome = "removed"
            else:
                outcome = "not_in_channel"

            store.end_trial(trial.id, "converted" if outcome == "converted" else "ended", now)
            results.append((user_id, outcome))
            logger.info("Trial %s for user %s ended: %s", trial.id, user_id, outcome)
        except TelegramError:
            logger.exception("Could not end trial %s for user %s; will retry", trial.id, user_id)
            continue

        if trial.invite_link and not trial.joined_at:
            try:
                await bot.revoke_chat_invite_link(chat_id=cfg.vip_channel_id, invite_link=trial.invite_link)
            except TelegramError:
                logger.warning("Could not revoke unused trial link for trial %s", trial.id)
    return results
