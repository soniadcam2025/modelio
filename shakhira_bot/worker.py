"""The send-only worker: python -m shakhira_bot --worker

Runs scheduler.run_cycle every WORKER_INTERVAL_SECONDS. It uses the bot token only to SEND
(like the GitHub poster) and never asks Telegram for updates, so it does not compete with the
live bot. It does not expire trials or remove members on its own; those belong to the full bot.
"""

import asyncio
import logging
import signal
import time

from telegram import Bot

from . import scheduler
from .alerts import AdminAlerts
from .config import Config
from .storage import Storage

logger = logging.getLogger(__name__)


class ForbiddenCall(RuntimeError):
    pass


class SendOnlyBot(Bot):
    """A Bot that refuses the calls that would take updates away from the live bot."""

    async def get_updates(self, *args, **kwargs):
        raise ForbiddenCall("the send-only worker must never call getUpdates")

    async def set_webhook(self, *args, **kwargs):
        raise ForbiddenCall("the send-only worker must never change the webhook")

    async def delete_webhook(self, *args, **kwargs):
        raise ForbiddenCall("the send-only worker must never change the webhook")


async def run_worker(cfg: Config, store: Storage, stop: asyncio.Event, bot=None, clock=time.time) -> int:
    alerts = AdminAlerts(cfg.admin_chat_ids)
    cycles = 0
    owns_bot = bot is None
    bot = bot or SendOnlyBot(cfg.bot_token)
    if owns_bot:
        await bot.initialize()
    try:
        while not stop.is_set():
            try:
                summary = await scheduler.run_cycle(bot, store, cfg, int(clock()), alerts)
                if any(v for v in summary.values()):
                    logger.info("Worker cycle: %s", summary)
            except Exception as exc:  # noqa: BLE001 - keep the worker alive; report and continue
                logger.exception("Worker cycle failed")
                await alerts.send(bot, f"Send-only worker error: {type(exc).__name__}: {exc}", key="worker-error")
            cycles += 1
            try:
                await asyncio.wait_for(stop.wait(), timeout=cfg.worker_interval_seconds)
            except asyncio.TimeoutError:
                pass
    finally:
        if owns_bot:
            await bot.shutdown()
    return cycles


def main(cfg: Config, store: Storage) -> int:
    if cfg.require_preview and cfg.preview_chat_id is None:
        logger.error("Not starting: WORKER_REQUIRE_PREVIEW is on but PREVIEW_CHAT_ID is not set. "
                     "This server may only run the worker in preview mode.")
        return 3
    async def runner():
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, stop.set)
            except NotImplementedError:  # Windows
                pass
        logger.info("Send-only worker started (no updates are received; the live bot is not affected)")
        if cfg.preview_chat_id is not None:
            logger.warning("PREVIEW MODE: scheduled items go only to chat %s, never to the channels",
                           cfg.preview_chat_id)
        await run_worker(cfg, store, stop)
        logger.info("Send-only worker stopped")

    asyncio.run(runner())
    return 0
