"""Every message the bot sends. Edit wording here; prices come from .env."""

from datetime import datetime, timezone

from .config import Config


def fmt_date(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%d %b %Y, %H:%M UTC")


def welcome(cfg: Config) -> str:
    return (
        "Welcome to CuteShakhira VIP 💎\n\n"
        f"{plans(cfg)}\n\n"
        "Commands:\n"
        "/subscribe — choose a plan\n"
        "/status — check membership\n"
        "/rules — membership information"
    )


def plans(cfg: Config) -> str:
    return (
        f"💎 VIP Monthly — {cfg.monthly_price} ⭐\n"
        "30 days · automatic renewal\n\n"
        f"⏳ {cfg.trial_days}-day trial — {cfg.trial_price} ⭐\n"
        "One-time payment · no automatic renewal"
    )


def choose_plan(cfg: Config) -> str:
    return f"Choose your plan:\n\n{plans(cfg)}"


def monthly_offer(cfg: Config) -> str:
    return (
        f"💎 VIP Monthly — {cfg.monthly_price} ⭐ every 30 days\n\n"
        "Tap Subscribe to pay with Telegram Stars and join the VIP channel. "
        "Telegram renews it automatically every 30 days until you cancel."
    )


def rules(cfg: Config) -> str:
    return (
        "📜 Membership information\n\n"
        f"💎 VIP Monthly ({cfg.monthly_price} ⭐ / 30 days)\n"
        "• Paid with Telegram Stars through Telegram's own subscription checkout.\n"
        "• Renews automatically every 30 days.\n"
        "• Cancel anytime in Telegram: Settings → My Stars → your subscriptions. "
        "You keep access until the paid period ends.\n\n"
        f"⏳ {cfg.trial_days}-day trial ({cfg.trial_price} ⭐)\n"
        "• One-time payment, no automatic renewal.\n"
        f"• Access ends automatically after {cfg.trial_days} days.\n"
        + ("• One trial per account.\n" if cfg.trial_once_per_user else "")
        + "\n• VIP content is personal. Do not share invite links or content.\n"
        "• Payment questions: /paysupport"
    )


def support(cfg: Config) -> str:
    if cfg.support_username:
        return f"💬 Need help with your membership or a payment? Message {cfg.support_username}."
    return "💬 Need help? Support contact is not set up yet. Please try again later."


def status_admin() -> str:
    return "👑 You are an admin of the VIP channel."


def status_monthly(until: int) -> str:
    return (
        "💎 VIP Monthly is active.\n"
        f"Current period ends: {fmt_date(until)}\n"
        "It renews automatically unless you cancel in Telegram."
    )


def status_trial(expires_at: int) -> str:
    return f"⏳ Your trial is active until {fmt_date(expires_at)}.\nIt does not renew automatically."


def status_trial_not_joined(expires_at: int) -> str:
    return (
        f"⏳ Your trial is paid and runs until {fmt_date(expires_at)}, "
        "but you haven't joined the VIP channel yet. Tap below to get your access link."
    )


def status_member_other() -> str:
    return "💎 You currently have access to the VIP channel."


def status_none() -> str:
    return "You don't have an active VIP membership right now. Tap a plan below to join."


def status_unavailable() -> str:
    return "I couldn't check your membership right now. Please try again in a minute."


def already_subscribed(until: int) -> str:
    return f"💎 You're already subscribed. Your current period ends {fmt_date(until)}."


def already_member() -> str:
    return "💎 You're already in the VIP channel. Check /status for details."


def trial_member_monthly_later(expires_at: int) -> str:
    return (
        f"⏳ You're on a trial until {fmt_date(expires_at)}. "
        "When it ends I'll send you the VIP Monthly link so you can continue."
    )


def trial_used() -> str:
    return "You've already used your trial. Choose VIP Monthly to continue."


def trial_invoice_title(cfg: Config) -> str:
    return f"CuteShakhira VIP — {cfg.trial_days}-day trial"


def trial_invoice_description(cfg: Config) -> str:
    return f"{cfg.trial_days} days of VIP channel access. One-time payment, no automatic renewal."


def trial_paid(expires_at: int) -> str:
    return (
        "✅ Payment received — thank you!\n\n"
        f"Your trial runs until {fmt_date(expires_at)}.\n"
        "Tap below to join. This link works once and only for you, so don't share it."
    )


def trial_paid_link_failed() -> str:
    return (
        "✅ Payment received — thank you!\n\n"
        "I couldn't create your access link just now. Send /status in a minute to get it. "
        "If it still fails, use /paysupport."
    )


def trial_ended(cfg: Config) -> str:
    return (
        "⏳ Your VIP trial has ended.\n\n"
        f"Continue with VIP Monthly — {cfg.monthly_price} ⭐ every 30 days."
    )


def link_error() -> str:
    return "Sorry, I couldn't create the link right now. Please try again in a minute or use /paysupport."


def checkout_rejected() -> str:
    return "This payment couldn't be accepted. Please start again with /subscribe."


def generic_error() -> str:
    return "Sorry, something went wrong. Please try again."
