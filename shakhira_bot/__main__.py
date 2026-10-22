"""Run the bot:  python -m shakhira_bot

Other options:
  python -m shakhira_bot --check-config        validate .env without connecting to Telegram
  python -m shakhira_bot --reset-monthly-link  forget the saved VIP Monthly link (a new one is made on next use)
"""

import argparse
import logging
import os
import sys

from dotenv import find_dotenv, load_dotenv

from .config import Config, ConfigError
from .storage import Storage


def setup_logging() -> None:
    logging.basicConfig(
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
    )
    # httpx logs every request URL, and Telegram URLs contain the bot token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m shakhira_bot")
    parser.add_argument("--check-config", action="store_true")
    parser.add_argument("--reset-monthly-link", action="store_true")
    args = parser.parse_args(argv)

    load_dotenv(find_dotenv(usecwd=True))  # .env in the folder you run the bot from
    setup_logging()
    log = logging.getLogger("shakhira_bot")

    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        log.error("Configuration problem: %s", exc)
        return 1

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

    from .app import ALLOWED_UPDATES, build_application

    log.info("Starting CuteShakhira VIP bot")
    build_application(cfg, store).run_polling(allowed_updates=ALLOWED_UPDATES)
    return 0


if __name__ == "__main__":
    sys.exit(main())
