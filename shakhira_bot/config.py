"""Settings loaded from environment variables (or a local .env file)."""

import os
from dataclasses import dataclass


class ConfigError(ValueError):
    """Raised when a required setting is missing or invalid."""


def _int(env: dict, name: str, default: int, minimum: int = 1) -> int:
    raw = env.get(name, "").strip() or str(default)
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from None
    if value < minimum:
        raise ConfigError(f"{name} must be at least {minimum}")
    return value


def _bool(env: dict, name: str, default: bool) -> bool:
    raw = env.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    raise ConfigError(f"{name} must be true or false, got {raw!r}")


@dataclass(frozen=True)
class Config:
    bot_token: str
    vip_channel_id: int
    public_channel: str = "@yourshakhira"
    support_username: str = ""
    monthly_price: int = 499
    trial_price: int = 49
    trial_days: int = 3
    trial_once_per_user: bool = True
    database_path: str = "data/shakhira_bot.db"
    expiry_check_seconds: int = 300

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Config":
        env = dict(os.environ if env is None else env)

        token = env.get("BOT_TOKEN", "").strip()
        if not token or token == "put_your_bot_token_here":
            raise ConfigError("BOT_TOKEN is missing. Put it in your .env file (never in Git).")

        raw_channel = env.get("VIP_CHANNEL_ID", "").strip()
        if not raw_channel:
            raise ConfigError(
                "VIP_CHANNEL_ID is missing. Set it to the private VIP channel's numeric ID "
                "(it starts with -100). See README.md."
            )
        try:
            channel_id = int(raw_channel)
        except ValueError:
            raise ConfigError(
                f"VIP_CHANNEL_ID must be the numeric channel ID (starts with -100), got {raw_channel!r}"
            ) from None
        if not str(channel_id).startswith("-100"):
            raise ConfigError("VIP_CHANNEL_ID must start with -100 (a channel ID).")

        public_channel = env.get("PUBLIC_CHANNEL", "").strip() or "@yourshakhira"
        if not public_channel.startswith("@"):
            public_channel = "@" + public_channel

        support = env.get("SUPPORT_USERNAME", "").strip()
        if support and not support.startswith("@"):
            support = "@" + support

        return cls(
            bot_token=token,
            vip_channel_id=channel_id,
            public_channel=public_channel,
            support_username=support,
            monthly_price=_int(env, "VIP_MONTHLY_PRICE", 499),
            trial_price=_int(env, "TRIAL_PRICE", 49),
            trial_days=_int(env, "TRIAL_DAYS", 3),
            trial_once_per_user=_bool(env, "TRIAL_ONCE_PER_USER", True),
            database_path=env.get("DATABASE_PATH", "").strip() or "data/shakhira_bot.db",
            expiry_check_seconds=_int(env, "EXPIRY_CHECK_SECONDS", 300, minimum=30),
        )

    @property
    def public_channel_url(self) -> str:
        return f"https://t.me/{self.public_channel.lstrip('@')}"

    @property
    def support_url(self) -> str | None:
        return f"https://t.me/{self.support_username.lstrip('@')}" if self.support_username else None

    def __repr__(self) -> str:  # never print the token
        return f"Config(vip_channel_id={self.vip_channel_id}, public_channel={self.public_channel!r}, ...)"
