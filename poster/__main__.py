"""Post one photo/video from Cloudinary to the public channel.

  python -m poster --check        only check that the bot can post to the channel
  python -m poster --dry-run      show what would be posted; changes nothing
  python -m poster --report       read-only: how many assets are left, and which recent slots got a post
  python -m poster                post one asset
  python -m poster --slot auto    post one asset for the slot due now (skips if that slot already has a post)
  python -m poster --channel @my_test_channel   post to a test channel (history not recorded)

Exit codes: 0 = posted / nothing needed, 1 = something failed, 2 = configuration problem,
3 = nothing left to post (upload more media).
"""

import argparse
import logging
import os
import sys
import time
from datetime import datetime

import httpx
from dotenv import find_dotenv, load_dotenv

from . import monitor, runner
from .cloudinary_source import CloudinarySource, SourceError
from .config import ConfigError, PosterConfig, normalize_channel
from .logs import setup_logging
from .slots import SlotError, resolve_slot
from .telegram_publisher import TelegramPublisher


def github_run_time(http: httpx.Client, repository: str, token: str):
    """A function run_id -> start time (unix) of that GitHub Actions run, or None if unavailable.

    Used only for posts made before tgbot_at_ tags existed. Read-only, cached per run.
    """
    if not repository or not token:
        return None
    cache: dict[str, int | None] = {}

    def lookup(run_id: str) -> int | None:
        if not run_id.isdigit():
            return None
        if run_id not in cache:
            cache[run_id] = None
            try:
                response = http.get(f"https://api.github.com/repos/{repository}/actions/runs/{run_id}",
                                    headers={"Authorization": f"Bearer {token}",
                                             "Accept": "application/vnd.github+json"}, timeout=15)
                if response.status_code == 200:
                    started = response.json().get("run_started_at") or response.json().get("created_at")
                    cache[run_id] = int(datetime.fromisoformat(started.replace("Z", "+00:00")).timestamp())
            except (httpx.HTTPError, ValueError, AttributeError, TypeError):
                logging.getLogger("poster").warning("Could not look up GitHub run %s", run_id)
        return cache[run_id]

    return lookup


def main(argv: list[str] | None = None, env: dict | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m poster")
    parser.add_argument("--dry-run", action="store_true", help="choose an asset but do not post or tag anything")
    parser.add_argument("--check", action="store_true", help="only check the bot's channel permissions")
    parser.add_argument("--report", action="store_true", help="read-only report of remaining media and recent slots")
    parser.add_argument("--channel", default="", help="post to this channel instead (for testing)")
    parser.add_argument("--slot", default=None,
                        help="'auto' for the slot due now, or a slot ID like 20261120T1630Z (default: POST_SLOT)")
    args = parser.parse_args(argv)

    if env is None:
        load_dotenv(find_dotenv(usecwd=True))
        env = dict(os.environ)
    try:
        cfg = PosterConfig.from_env(env)
        channel = normalize_channel(args.channel) if args.channel.strip() else None
        requested = args.slot if args.slot is not None else env.get("POST_SLOT", "")
        slot = None
        if not (args.check or args.report or args.dry_run or channel):
            slot = resolve_slot(env.get("SCHEDULE_CRON", ""), requested or "", list(cfg.slot_times), time.time())
    except (ConfigError, SlotError) as exc:
        setup_logging([], env.get("LOG_LEVEL", "INFO"))
        logging.getLogger("poster").error("Configuration problem: %s", exc)
        return 2

    github_token = (env.get("GITHUB_TOKEN") or "").strip()
    setup_logging(cfg.secrets() + ([github_token] if github_token else []), env.get("LOG_LEVEL", "INFO"))
    log = logging.getLogger("poster")
    if slot:
        log.info("Posting slot %s", slot)

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
        run_time = github_run_time(http, env.get("GITHUB_REPOSITORY", ""), github_token)
        if args.report:
            try:
                inv = runner.inventory(cfg, source.list_assets(), time.time(), run_time)
            except SourceError as exc:
                log.error("%s", exc)
                return 1
            text = monitor.report_markdown(inv, cfg, time.time())
            print(text)
            level = "warning" if inv.remaining < cfg.low_stock_threshold else "notice"
            monitor.emit([monitor.annotation(level, "Unpublished assets", f"{inv.remaining} left to post")],
                         text, env)
            return 0

        result = runner.run(cfg, source, publisher, http, dry_run=args.dry_run, channel=channel, slot=slot,
                            run_time=run_time)
        target = channel or cfg.public_channel
        production = not args.dry_run and target == cfg.public_channel
        monitor.report_result(result, cfg, target, publisher, production=production, env=env)

    log.info("Result: %s%s", result.status, f" ({result.asset})" if result.asset else "")
    return result.exit_code


if __name__ == "__main__":
    sys.exit(main())
