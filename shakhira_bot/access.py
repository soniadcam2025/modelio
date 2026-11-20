"""VIP channel access: subscription link, trial links, membership status, removals and trial expiry."""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from telegram import ChatMember, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import TelegramError

from . import texts
from .alerts import NO_ALERTS, AdminAlerts
from .config import Config
from .payments import check_payment
from .storage import REJECTED, Storage, Trial

logger = logging.getLogger(__name__)

# Telegram only allows 30-day periods for channel subscription links.
SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60
# How long a trial invite link stays usable (it is also single-use).
TRIAL_LINK_TTL_SECONDS = 24 * 60 * 60
# Most invite links one trial can ever receive (the first one plus re-issues from /status).
MAX_TRIAL_LINKS = 3
# Unban attempts before the admin is told that a removed member is still banned.
UNBAN_ALERT_AFTER = 3
MONTHLY_LINK_KEY = "monthly_link:"
TRIAL_LINK_NAME_PREFIX = "trial "


class TrialLinkLimitReached(Exception):
    """The trial already received MAX_TRIAL_LINKS links."""


class TrialLinkRevokeFailed(Exception):
    """An earlier link could not be revoked, so no new link was issued (it could otherwise be shared)."""


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


# Trial invite links


async def revoke_trial_links(bot, store: Storage, cfg: Config, trial: Trial, now: int) -> bool:
    """Revoke every link of this trial that is not revoked yet. Returns False if a live link survived.

    A link whose own expiry date has passed is dead anyway, so failing to revoke it is not a problem.
    """
    all_dead = True
    for link in store.unrevoked_trial_links(trial.id):
        try:
            await bot.revoke_chat_invite_link(chat_id=cfg.vip_channel_id, invite_link=link.invite_link)
        except TelegramError:
            if link.expires_at is not None and link.expires_at <= now:
                logger.info("Trial %s link already expired; marking it revoked", trial.id)
            else:
                logger.warning("Could not revoke a link of trial %s", trial.id)
                all_dead = False
                continue
        store.mark_link_revoked(link.invite_link, now)
    return all_dead


async def issue_trial_link(bot, store: Storage, cfg: Config, trial: Trial, now: int) -> str:
    """Create a single-use invite link for a paid trial, revoking any earlier link first.

    Raises TrialLinkLimitReached after MAX_TRIAL_LINKS links, TrialLinkRevokeFailed if an earlier
    link may still work, and TelegramError if Telegram refuses to create the link.
    """
    if store.trial_link_count(trial.id) >= MAX_TRIAL_LINKS:
        raise TrialLinkLimitReached()
    if not await revoke_trial_links(bot, store, cfg, trial, now):
        raise TrialLinkRevokeFailed()
    expire = min(trial.expires_at, now + TRIAL_LINK_TTL_SECONDS)
    link = await bot.create_chat_invite_link(
        chat_id=cfg.vip_channel_id,
        expire_date=expire,
        member_limit=1,
        name=f"{TRIAL_LINK_NAME_PREFIX}{trial.user_id}"[:32],
    )
    store.add_trial_link(trial, link.invite_link, now, expire)
    return link.invite_link


async def send_first_trial_link(bot, store: Storage, cfg: Config, trial: Trial, now: int,
                                alerts: AdminAlerts = NO_ALERTS) -> str | None:
    """Issue the first link for a newly paid trial. None if it failed (the user can retry from /status)."""
    try:
        return await issue_trial_link(bot, store, cfg, trial, now)
    except (TelegramError, TrialLinkLimitReached, TrialLinkRevokeFailed):
        logger.exception("Trial paid but invite link failed (user %s, trial %s)", trial.user_id, trial.id)
        await alerts.send(
            bot,
            f"Trial {trial.id} for user {trial.user_id} is paid, but its invite link could not be created. "
            "The user can retry from /status. If this repeats, check the bot's admin rights in the VIP channel.",
            key="trial-link-failed",
        )
        return None


# Removing members


async def remove_from_channel(bot, store: Storage, cfg: Config, user_id: int, now: int,
                              alerts: AdminAlerts = NO_ALERTS) -> None:
    """Remove a member without a permanent ban, so they can rejoin later by paying.

    Raises TelegramError if the ban fails (the member is still in the channel; the caller retries).
    If only the unban fails, the member is out but still banned: they are queued in pending_unbans
    and retry_pending_unbans() keeps trying until the ban is lifted.
    """
    await bot.ban_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id)
    for _ in range(2):
        try:
            await bot.unban_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id, only_if_banned=True)
            store.clear_pending_unban(user_id)
            return
        except TelegramError:
            logger.warning("Unban of user %s failed", user_id)
    store.add_pending_unban(user_id, now)
    logger.error("User %s was removed but is still banned; queued for unban retry", user_id)


async def retry_pending_unbans(bot, store: Storage, cfg: Config, now: int,
                               alerts: AdminAlerts = NO_ALERTS) -> list[int]:
    """Retry every queued unban. Returns the user IDs that were unbanned now."""
    done = []
    for user_id, attempts in store.pending_unbans():
        try:
            await bot.unban_chat_member(chat_id=cfg.vip_channel_id, user_id=user_id, only_if_banned=True)
        except TelegramError:
            store.add_pending_unban(user_id, now)
            if attempts + 1 == UNBAN_ALERT_AFTER:
                await alerts.send(
                    bot,
                    f"User {user_id} was removed from the VIP channel but is still BANNED after "
                    f"{attempts + 1} unban attempts, so they cannot rejoin even by paying. The bot keeps "
                    "retrying; you can also unban them by hand in the channel's Removed users list.",
                    key=f"unban-{user_id}",
                )
            continue
        store.clear_pending_unban(user_id)
        logger.info("Pending unban for user %s completed", user_id)
        done.append(user_id)
    return done


# Joins through trial links


async def handle_trial_link_join(bot, store: Storage, cfg: Config, user_id: int, invite_link: str,
                                 link_name: str | None, is_admin: bool, now: int,
                                 alerts: AdminAlerts = NO_ALERTS) -> str:
    """Decide what to do when someone joins the VIP channel through a trial-style link.

    Returns one of: joined_trial, admin, unknown_trial_link, unauthorized_removed, unauthorized_remove_failed.
    """
    trial = store.trial_for_link(invite_link)
    if trial is None:
        # Not a link this bot made (for example one from the older bot). Never remove on a guess.
        await alerts.send(
            bot, f"User {user_id} joined the VIP channel with a trial link this bot has no record of "
            f"({link_name!r}). Nothing was changed; check it if unexpected.", key="unknown-trial-link",
        )
        return "unknown_trial_link"

    own_active = trial.user_id == user_id and trial.status == "active" and trial.expires_at > now
    if own_active:
        store.mark_trial_joined(invite_link, user_id, now)
        return "joined_trial"
    if is_admin:
        return "admin"

    # Someone used another buyer's link, or a link of a trial that already ended.
    reason = "another user's trial link" if trial.user_id != user_id else "a link of an ended trial"
    if store.active_trial(user_id, now):
        # The joiner has their own paid trial; let expiry handle them as usual.
        await alerts.send(bot, f"User {user_id} joined via {reason} (trial {trial.id}) but has their own "
                          "active trial, so they were not removed.")
        return "joined_trial"
    try:
        await remove_from_channel(bot, store, cfg, user_id, now, alerts)
    except TelegramError:
        logger.exception("Could not remove unauthorized member %s", user_id)
        await alerts.send(bot, f"User {user_id} joined the VIP channel via {reason} (trial {trial.id}) "
                          "and could NOT be removed automatically. Please remove them by hand.")
        return "unauthorized_remove_failed"
    await revoke_trial_links(bot, store, cfg, trial, now)
    logger.warning("Removed user %s who joined via %s (trial %s)", user_id, reason, trial.id)
    await alerts.send(bot, f"Removed user {user_id}: they joined the VIP channel via {reason} "
                      f"(trial {trial.id}, bought by user {trial.user_id}).", key=f"unauthorized-{trial.id}")
    return "unauthorized_removed"


# Trial expiry


async def expire_trials(bot, store: Storage, cfg: Config, now: int,
                        alerts: AdminAlerts = NO_ALERTS) -> list[tuple[int, str]]:
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
                await remove_from_channel(bot, store, cfg, user_id, now, alerts)
                outcome = "removed"
            else:
                outcome = "not_in_channel"

            store.end_trial(trial.id, "converted" if outcome == "converted" else "ended", now)
            results.append((user_id, outcome))
            logger.info("Trial %s for user %s ended: %s", trial.id, user_id, outcome)
        except TelegramError:
            logger.exception("Could not end trial %s for user %s; will retry", trial.id, user_id)
            continue

        await revoke_trial_links(bot, store, cfg, trial, now)
    return results


# Recovery


async def recover_unprocessed_payments(bot, store: Storage, cfg: Config, now: int,
                                       alerts: AdminAlerts = NO_ALERTS) -> list[int]:
    """Give a trial to any accepted trial payment that has none (e.g. data from before the atomic save).

    Returns the user IDs that received a recovered trial.
    """
    recovered = []
    for payment in store.trial_payments_without_trial():
        if payment.status is None:  # saved by an older version: check it now
            reason = check_payment(cfg, payment.currency, payment.amount, payment.payload, payment.user_id)
            if reason:
                store.set_payment_status(payment.charge_id, REJECTED)
                await alerts.send(bot, f"Old payment from user {payment.user_id} ({payment.amount} {payment.currency}) "
                                  f"did not match an offer ({reason}); no trial given. Consider a refund.")
                continue
        trial = store.create_trial_for_payment(payment, now, cfg.trial_days * 86400)
        if trial is None:
            continue
        link = await send_first_trial_link(bot, store, cfg, trial, now, alerts)
        markup = InlineKeyboardMarkup([[InlineKeyboardButton("🔑 Join VIP", url=link)]]) if link else None
        try:
            await bot.send_message(chat_id=trial.user_id, text=texts.trial_recovered(trial.expires_at, bool(link)),
                                   reply_markup=markup)
        except TelegramError:
            logger.warning("Could not message user %s about their recovered trial", trial.user_id)
        await alerts.send(bot, f"Recovered a paid trial for user {trial.user_id} (trial {trial.id}) "
                          "that had no access recorded.")
        recovered.append(trial.user_id)
    return recovered
