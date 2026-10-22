"""Logging that can never print a secret, even inside an exception traceback."""

import logging


class RedactingFormatter(logging.Formatter):
    def __init__(self, secrets: list[str], fmt: str):
        super().__init__(fmt)
        # Longest first so a secret that contains another is fully hidden.
        self._secrets = sorted({s for s in secrets if s and len(s) >= 4}, key=len, reverse=True)

    def format(self, record: logging.LogRecord) -> str:
        text = super().format(record)
        for secret in self._secrets:
            text = text.replace(secret, "[REDACTED]")
        return text


def setup_logging(secrets: list[str], level: str = "INFO") -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(RedactingFormatter(secrets, "%(asctime)s %(levelname)s %(name)s: %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # HTTP libraries log full request URLs; Telegram URLs contain the bot token.
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
