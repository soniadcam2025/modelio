"""A fake Telegram bot that records calls instead of talking to Telegram."""

from datetime import datetime, timezone
from types import SimpleNamespace

from telegram import ChatMember
from telegram.error import TelegramError

from shakhira_bot.config import Config

CHANNEL_ID = -1001234567890


def make_config(**overrides) -> Config:
    values = dict(bot_token="123456:TEST-TOKEN", vip_channel_id=CHANNEL_ID, database_path=":memory:")
    values.update(overrides)
    return Config(**values)


def member(status: str = ChatMember.MEMBER, until: int | None = None, is_member: bool = False):
    until_date = datetime.fromtimestamp(until, tz=timezone.utc) if until else None
    return SimpleNamespace(status=status, until_date=until_date, is_member=is_member)


class FakeBot:
    def __init__(self, members: dict | None = None, fail: set[str] | None = None):
        self.members = members or {}  # user_id -> member(...)
        self.fail = fail or set()  # method names that should raise TelegramError
        self.calls: list[tuple[str, dict]] = []
        self._links = 0

    def _record(self, name: str, kwargs: dict) -> None:
        self.calls.append((name, kwargs))
        if name in self.fail:
            raise TelegramError(f"{name} failed")

    def called(self, name: str) -> list[dict]:
        return [kwargs for n, kwargs in self.calls if n == name]

    async def get_chat_member(self, **kw):
        self._record("get_chat_member", kw)
        return self.members.get(kw["user_id"], member(ChatMember.LEFT))

    async def create_chat_subscription_invite_link(self, **kw):
        self._record("create_chat_subscription_invite_link", kw)
        self._links += 1
        return SimpleNamespace(invite_link=f"https://t.me/+sub{self._links}")

    async def create_chat_invite_link(self, **kw):
        self._record("create_chat_invite_link", kw)
        self._links += 1
        return SimpleNamespace(invite_link=f"https://t.me/+trial{self._links}")

    async def revoke_chat_invite_link(self, **kw):
        self._record("revoke_chat_invite_link", kw)

    async def ban_chat_member(self, **kw):
        self._record("ban_chat_member", kw)
        return True

    async def unban_chat_member(self, **kw):
        self._record("unban_chat_member", kw)
        return True
