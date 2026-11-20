"""Admin alerts: short Telegram messages to the admin chat(s) when something needs a human.

Alerts are best effort: a failure to deliver one is logged and never breaks the bot.
The same alert (same key) is sent at most once per cooldown, so a recurring error cannot flood the admin.
"""

import logging
import time

from telegram.error import TelegramError

logger = logging.getLogger(__name__)

DEFAULT_COOLDOWN_SECONDS = 15 * 60
PREFIX = "⚠️ VIP bot alert\n\n"
MAX_LENGTH = 3500  # Telegram allows 4096; leave room for the prefix


class AdminAlerts:
    def __init__(self, chat_ids, cooldown: int = DEFAULT_COOLDOWN_SECONDS, clock=time.time):
        self.chat_ids = tuple(chat_ids)
        self.cooldown = cooldown
        self._clock = clock
        self._last_sent: dict[str, float] = {}
        self.sent: list[str] = []  # what was delivered, newest last (handy for tests and debugging)

    async def send(self, bot, text: str, key: str | None = None) -> bool:
        """Send `text` to every admin chat. Returns True if it went to at least one."""
        logger.warning("Admin alert: %s", text)
        if not self.chat_ids:
            return False
        key = key or text
        now = self._clock()
        last = self._last_sent.get(key)
        if last is not None and now - last < self.cooldown:
            return False
        self._last_sent[key] = now
        delivered = False
        for chat_id in self.chat_ids:
            try:
                await bot.send_message(chat_id=chat_id, text=(PREFIX + text)[:MAX_LENGTH])
                delivered = True
            except TelegramError as exc:
                logger.error("Could not deliver admin alert to %s: %s", chat_id, type(exc).__name__)
        if delivered:
            self.sent.append(text)
        return delivered


NO_ALERTS = AdminAlerts(())
