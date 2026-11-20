"""Run the bot:  python -m shakhira_bot

Other options:
  python -m shakhira_bot --check-config        validate .env without connecting to Telegram
  python -m shakhira_bot --reset-monthly-link  forget the saved VIP Monthly link (a new one is made on next use)
  python -m shakhira_bot --backup              write one database backup to BACKUP_DIR and exit
  python -m shakhira_bot --worker              SEND-ONLY worker: scheduled posts, polls, reminders and dashboard
                                               actions. Never receives updates, so it can run next to the live bot.
"""

import argparse
import asyncio
import logging
import os
import sys
import time

from dotenv import find_dotenv, load_dotenv

from .config import Config, ConfigError
from .storage import Storage


class RedactingFormatter(logging.Formatter):
    """Hides the bot token anywhere in a log line, including tracebacks."""

    def __init__(self, fmt: str):
        super().__init__(fmt)
        self.secret = ""

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        return text.replace(self.secret, "[REDACTED]") if self.secret else text


FORMATTER = RedactingFormatter("%(asctime)s %(levelname)s %(name)s: %(message)s")


def setup_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(FORMATTER)
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    # httpx logs every request URL, and Telegram URLs contain the bot token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


async def webhook_problem(bot) -> str | None:
    """Return a reason not to start if this token already delivers updates to a webhook.

    run_polling() deletes any webhook, which would silently cut off another bot (for example the
    current live bot) that uses this token through a webhook. getWebhookInfo is read-only.
    """
    info = await bot.get_webhook_info()
    if info.url:
        return (
            "This bot token has a webhook set, so another program (probably the live bot) receives its "
            "updates. Starting would delete that webhook and take over. Stop and retire the other bot "
            "first, then start with --take-over-webhook."
        )
    return None


async def _check_webhook(token: str) -> str | None:
    from telegram import Bot

    async with Bot(token) as bot:
        return await webhook_problem(bot)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m shakhira_bot")
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--reset-monthly-link", action="store_true")
    parser.add_argument("--backup", action="store_true", help="write one database backup and exit")
    parser.add_argument("--worker", action="store_true",
                        help="run only the send-only worker (safe next to the live bot)")
    parser.add_argument("--take-over-webhook", action="store_true",
                        help="start even if the token has a webhook (only after retiring the old bot)")
    args = parser.parse_args(argv)

    load_dotenv(find_dotenv(usecwd=True))  # .env in the folder you run the bot from
    setup_logging()
    log = logging.getLogger("shakhira_bot")

    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        log.error("Configuration problem: %s", exc)
        return 1
    FORMATTER.secret = cfg.bot_token

    if args.check_config:
        log.info(
            "Config OK: VIP channel %s, monthly %s Stars, trial %s Stars / %s days, database %s",
            cfg.vip_channel_id, cfg.monthly_price, cfg.trial_price, cfg.trial_days, cfg.database_path,
        )
        return 0

    store = Storage(cfg.database_path)
    if args.reset_monthly_link:
        from .access import MONTHLY_LINK_KEY

        removed = store.delete_settings_with_prefix(MONTHLY_LINK_KEY)
        log.info("Removed %s saved monthly link(s).", removed)
        return 0
    if args.backup:
        from .backup import make_backup

        make_backup(store, cfg.backup_dir, cfg.backup_keep, time.time())
        return 0

    if args.worker:
        from .worker import main as worker_main

        return worker_main(cfg, store)

    if not args.take_over_webhook:
        problem = asyncio.run(_check_webhook(cfg.bot_token))
        if problem:
            log.error("Not starting: %s", problem)
            return 3

    from .app import ALLOWED_UPDATES, build_application

    log.info("Starting CuteShakhira VIP bot")
    build_application(cfg, store).run_polling(allowed_updates=ALLOWED_UPDATES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
