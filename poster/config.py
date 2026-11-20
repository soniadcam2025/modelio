"""Poster settings from environment variables (GitHub Actions secrets/variables or a local .env)."""

import os
from dataclasses import dataclass

from .slots import SlotError, parse_times

REQUIRED = ("TELEGRAM_BOT_TOKEN", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET")

# Telegram Bot API limits for files uploaded by a bot (multipart upload).
TELEGRAM_PHOTO_LIMIT = 10 * 1024 * 1024
TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024
TELEGRAM_CAPTION_LIMIT = 1024


class ConfigError(ValueError):
    """A required setting is missing or invalid. Messages never contain secret values."""


def _choice(env: dict, name: str, default: str, allowed: set[str]) -> str:
    value = (env.get(name) or "").strip().lower() or default
    if value not in allowed:
        raise ConfigError(f"{name} must be one of {sorted(allowed)}, got {value!r}")
    return value


def _int(env: dict, name: str, default: int, minimum: int, maximum: int | None = None) -> int:
    raw = (env.get(name) or "").strip() or str(default)
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} must be a whole number, got {raw!r}") from None
    if value < minimum or (maximum is not None and value > maximum):
        raise ConfigError(f"{name} must be between {minimum} and {maximum or 'unlimited'}")
    return value


def normalize_channel(value: str) -> str:
    value = value.strip()
    if not value:
        raise ConfigError("PUBLIC_CHANNEL is empty")
    if value.lstrip("-").isdigit():
        return value
    return value if value.startswith("@") else "@" + value


@dataclass(frozen=True)
class PosterConfig:
    telegram_bot_token: str
    cloud_name: str
    api_key: str
    api_secret: str
    public_channel: str = "@yourshakhira"
    folder: str = "tgpub"
    folder_mode: str = "auto"  # auto, dynamic, fixed
    caption: str = ""
    selection: str = "oldest"  # oldest, random
    # reuse (default): when no new asset is left, repost the one posted longest ago, once it is past
    # the cooldown. stop: never repeat a post. History tags are never removed in either mode.
    when_exhausted: str = "reuse"
    reuse_cooldown_days: int = 30
    max_photo_bytes: int = TELEGRAM_PHOTO_LIMIT
    max_video_bytes: int = TELEGRAM_FILE_LIMIT
    claim_ttl_minutes: int = 30
    run_id: str = ""
    # Warn when fewer than this many unpublished assets remain after a post (0 = never warn).
    low_stock_threshold: int = 5
    # Optional Telegram chat (your user ID, or a private admin group/channel) for alerts. Never the public channel.
    admin_chat_id: str = ""
    # The UTC times of the daily schedule; must match the cron lines in the workflow.
    slot_times: tuple[tuple[int, int], ...] = ((16, 30), (23, 30))
    # Optional rotating captions (POST_CAPTIONS, separated by ||) and a footer added to every caption.
    caption_pool: tuple[str, ...] = ()
    footer: str = ""

    @classmethod
    def from_env(cls, env: dict | None = None) -> "PosterConfig":
        env = dict(os.environ if env is None else env)
        missing = [name for name in REQUIRED if not (env.get(name) or "").strip()]
        if missing:
            raise ConfigError("Missing required environment variable(s): " + ", ".join(missing))

        folder = (env.get("CLOUDINARY_FOLDER") or "").strip().strip("/") or "tgpub"
        caption = (env.get("POST_CAPTION") or "").replace("\\n", "\n").strip()
        if len(caption) > TELEGRAM_CAPTION_LIMIT:
            raise ConfigError(f"POST_CAPTION is longer than Telegram's {TELEGRAM_CAPTION_LIMIT}-character limit")

        try:
            slot_times = tuple(parse_times((env.get("POST_SLOTS_UTC") or "").strip() or "16:30,23:30"))
        except SlotError as exc:
            raise ConfigError(str(exc)) from None

        caption_pool = tuple(c.replace("\\n", "\n").strip() for c in (env.get("POST_CAPTIONS") or "").split("||")
                             if c.strip())
        if any(len(c) > TELEGRAM_CAPTION_LIMIT for c in caption_pool):
            raise ConfigError(f"Every POST_CAPTIONS entry must be at most {TELEGRAM_CAPTION_LIMIT} characters")
        footer = (env.get("POST_FOOTER") or "").replace("\\n", "\n").strip()
        if len(footer) > 200:
            raise ConfigError("POST_FOOTER must be at most 200 characters")

        public_channel = normalize_channel(env.get("PUBLIC_CHANNEL") or "@yourshakhira")
        admin_chat_id = (env.get("ADMIN_CHAT_ID") or "").strip()
        if admin_chat_id:
            admin_chat_id = normalize_channel(admin_chat_id)
            if admin_chat_id == public_channel:
                raise ConfigError("ADMIN_CHAT_ID must not be the public channel")

        return cls(
            telegram_bot_token=env["TELEGRAM_BOT_TOKEN"].strip(),
            cloud_name=env["CLOUDINARY_CLOUD_NAME"].strip(),
            api_key=env["CLOUDINARY_API_KEY"].strip(),
            api_secret=env["CLOUDINARY_API_SECRET"].strip(),
            public_channel=public_channel,
            folder=folder,
            folder_mode=_choice(env, "CLOUDINARY_FOLDER_MODE", "auto", {"auto", "dynamic", "fixed"}),
            caption=caption,
            selection=_choice(env, "POST_SELECTION", "oldest", {"oldest", "random", "smart"}),
            # "restart" is accepted for older settings and now means the safe "reuse".
            when_exhausted={"restart": "reuse"}.get(w := _choice(env, "POST_WHEN_EXHAUSTED", "reuse",
                                                              {"reuse", "stop", "restart"}), w),
            reuse_cooldown_days=_int(env, "REUSE_COOLDOWN_DAYS", 30, 1, 3650),
            max_photo_bytes=_int(env, "MAX_PHOTO_BYTES", TELEGRAM_PHOTO_LIMIT, 1, TELEGRAM_PHOTO_LIMIT),
            max_video_bytes=_int(env, "MAX_VIDEO_BYTES", TELEGRAM_FILE_LIMIT, 1, TELEGRAM_FILE_LIMIT),
            claim_ttl_minutes=_int(env, "CLAIM_TTL_MINUTES", 30, 5, 24 * 60),
            run_id=(env.get("GITHUB_RUN_ID") or "").strip(),
            low_stock_threshold=_int(env, "LOW_STOCK_THRESHOLD", 5, 0, 10_000),
            admin_chat_id=admin_chat_id,
            slot_times=slot_times,
            caption_pool=caption_pool,
            footer=footer,
        )

    def secrets(self) -> list[str]:
        return [self.telegram_bot_token, self.api_key, self.api_secret]

    def __repr__(self) -> str:  # never print secrets
        return f"PosterConfig(cloud={self.cloud_name!r}, folder={self.folder!r}, channel={self.public_channel!r})"
