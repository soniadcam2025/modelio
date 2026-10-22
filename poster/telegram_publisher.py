"""Publish files to a Telegram channel with the Bot API, and check the bot's channel permissions."""

import logging
import time

import httpx

logger = logging.getLogger(__name__)

SEND_METHODS = {"photo": "sendPhoto", "video": "sendVideo", "animation": "sendAnimation"}
# Errors where the request never reached Telegram, so retrying cannot double-post.
NOT_SENT_ERRORS = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.WriteTimeout, httpx.ProxyError)
MAX_RETRY_AFTER = 60


class PublishFailed(RuntimeError):
    """Telegram definitely did not publish the post."""


class PublishUncertain(RuntimeError):
    """The request may have reached Telegram; the post may or may not exist."""


class TelegramPublisher:
    def __init__(self, token: str, client: httpx.Client | None = None, sleep=time.sleep):
        self._client = client or httpx.Client(timeout=httpx.Timeout(30.0, read=180.0, write=180.0))
        self._base = f"https://api.telegram.org/bot{token}/"
        self._sleep = sleep

    def _request(self, method: str, *, data: dict | None = None, files: dict | None = None,
                 safe_to_repeat: bool) -> dict:
        attempts = 0
        while True:
            attempts += 1
            try:
                response = self._client.post(self._base + method, data=data, files=files)
            except NOT_SENT_ERRORS as exc:
                if attempts < 3:
                    logger.warning("Telegram %s: %s, retrying", method, type(exc).__name__)
                    self._sleep(2 * attempts)
                    continue
                raise PublishFailed(f"{method}: could not reach Telegram ({type(exc).__name__})") from None
            except httpx.HTTPError as exc:
                if safe_to_repeat and attempts < 3:
                    self._sleep(2 * attempts)
                    continue
                raise PublishUncertain(f"{method}: connection problem after sending ({type(exc).__name__})") from None

            try:
                body = response.json()
            except ValueError:
                body = None
            if not isinstance(body, dict):
                if response.status_code >= 500 or response.status_code == 200:
                    raise PublishUncertain(f"{method}: unreadable response (HTTP {response.status_code})")
                raise PublishFailed(f"{method}: unreadable response (HTTP {response.status_code})")

            if body.get("ok") is True:
                return body.get("result")

            description = str(body.get("description") or "no description")
            retry_after = (body.get("parameters") or {}).get("retry_after")
            if response.status_code == 429 and isinstance(retry_after, int) and attempts < 3:
                wait = min(retry_after, MAX_RETRY_AFTER)
                logger.warning("Telegram rate limit on %s; waiting %ss", method, wait)
                self._sleep(wait)
                continue
            if response.status_code >= 500:
                if safe_to_repeat and attempts < 3:
                    self._sleep(2 * attempts)
                    continue
                raise PublishUncertain(f"{method}: Telegram server error {response.status_code}: {description}")
            raise PublishFailed(f"{method}: {description}")

    def check_channel(self, channel: str) -> list[str]:
        """Return problems that would stop the bot posting to `channel` (empty list = OK)."""
        try:
            me = self._request("getMe", safe_to_repeat=True)
        except (PublishFailed, PublishUncertain) as exc:
            return [f"Telegram rejected the bot token or is unreachable ({exc})"]
        try:
            chat = self._request("getChat", data={"chat_id": channel}, safe_to_repeat=True)
            member = self._request("getChatMember", data={"chat_id": channel, "user_id": me["id"]},
                                   safe_to_repeat=True)
        except (PublishFailed, PublishUncertain) as exc:
            return [f"The bot cannot access {channel} ({exc}). Add @{me.get('username')} to the channel as an admin."]

        problems = []
        if chat.get("type") != "channel":
            problems.append(f"{channel} is a {chat.get('type')}, not a channel")
        status = member.get("status")
        if status == "creator":
            return problems
        if status != "administrator":
            problems.append(f"@{me.get('username')} is not an admin of {channel} (status: {status})")
        elif chat.get("type") == "channel" and not member.get("can_post_messages"):
            problems.append(f"@{me.get('username')} is an admin of {channel} but cannot post messages")
        return problems

    def send_media(self, channel: str, kind: str, name: str, content: bytes, caption: str) -> int:
        """Upload the file and return the new message ID."""
        method = SEND_METHODS[kind]
        data = {"chat_id": channel}
        if caption:
            data["caption"] = caption
        if kind == "video":
            data["supports_streaming"] = "true"
        result = self._request(method, data=data, files={kind: (name, content)}, safe_to_repeat=False)
        message_id = result.get("message_id") if isinstance(result, dict) else None
        if not isinstance(message_id, int):
            raise PublishUncertain(f"{method}: Telegram did not return a message ID")
        return message_id
