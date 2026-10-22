"""Post one photo/video from Cloudinary to the public channel.

  python -m poster --check        only check that the bot can post to the channel
  python -m poster --dry-run      show what would be posted; changes nothing
  python -m poster                post one asset
  python -m poster --channel @my_test_channel   post to a test channel (history not recorded)
"""

import argparse
import logging
import os
import sys

import httpx
from dotenv import find_dotenv, load_dotenv

from . import runner
from .cloudinary_source import CloudinarySource
from .config import ConfigError, PosterConfig, normalize_channel
from .logs import setup_logging
from .telegram_publisher import TelegramPublisher


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m poster")
    parser.add_argument("--dry-run", action="store_true", help="choose an asset but do not post or tag anything")
    parser.add_argument("--check", action="store_true", help="only check the bot's channel permissions")
    parser.add_argument("--channel", default="", help="post to this channel instead (for testing)")
    args = parser.parse_args(argv)

    load_dotenv(find_dotenv(usecwd=True))
    try:
        cfg = PosterConfig.from_env()
        channel = normalize_channel(args.channel) if args.channel.strip() else None
    except ConfigError as exc:
        setup_logging([], os.getenv("LOG_LEVEL", "INFO"))
        logging.getLogger("poster").error("Configuration problem: %s", exc)
        return 2

    setup_logging(cfg.secrets(), os.getenv("LOG_LEVEL", "INFO"))
    log = logging.getLogger("poster")

    with httpx.Client(timeout=httpx.Timeout(30.0, read=180.0, write=180.0)) as http:
        publisher = TelegramPublisher(cfg.telegram_bot_token, client=http)
        if args.check:
            problems = publisher.check_channel(channel or cfg.public_channel)
            for problem in problems:
                log.error("Channel check failed: %s", problem)
            if not problems:
                log.info("OK: the bot can post to %s", channel or cfg.public_channel)
            return 1 if problems else 0

        source = CloudinarySource(cfg.cloud_name, cfg.api_key, cfg.api_secret, cfg.folder, cfg.folder_mode)
        result = runner.run(cfg, source, publisher, http, dry_run=args.dry_run, channel=channel)

    log.info("Result: %s%s", result.status, f" ({result.asset})" if result.asset else "")
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
