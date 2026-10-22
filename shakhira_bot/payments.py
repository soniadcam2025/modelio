"""Telegram Stars invoice payloads and payment checks (no network calls here)."""

import secrets

from .config import Config

STARS_CURRENCY = "XTR"
TRIAL_PLAN = "trial"


def make_payload(plan: str, user_id: int) -> str:
    return f"{plan}:{user_id}:{secrets.token_hex(8)}"


def parse_payload(payload: str) -> tuple[str, int] | None:
    parts = payload.split(":")
    if len(parts) != 3:
        return None
    plan, user_id, _nonce = parts
    try:
        return plan, int(user_id)
    except ValueError:
        return None


def check_payment(cfg: Config, currency: str, amount: int, payload: str, user_id: int) -> str | None:
    """Return None if the payment matches what we sell, or a short reason why it does not."""
    parsed = parse_payload(payload)
    if parsed is None:
        return "unknown payload"
    plan, payload_user = parsed
    if plan != TRIAL_PLAN:
        return f"unknown plan {plan!r}"
    if payload_user != user_id:
        return "payload belongs to a different user"
    if currency != STARS_CURRENCY:
        return f"wrong currency {currency!r}"
    if amount != cfg.trial_price:
        return f"wrong amount {amount}"
    return None
