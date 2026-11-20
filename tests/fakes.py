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
    def __init__(self, members: dict | None = None, fail: set[str] | None = None, webhook_url: str = ""):
        self.members = members or {}  # user_id -> member(...)
        self.fail = fail or set()  # method names that should raise TelegramError
        self.calls: list[tuple[str, dict]] = []
        self._links = 0
        self.webhook_url = webhook_url
        self.raise_on: dict = {}  # method name -> exception instance to raise (e.g. BadRequest("..."))
        self.poll_votes = [3, 1]

    def _record(self, name: str, kwargs: dict) -> None:
        self.calls.append((name, kwargs))
        if name in self.raise_on:
            raise self.raise_on[name]
        if name in self.fail:
            raise TelegramError(f"{name} failed")

    def _message(self):
        return SimpleNamespace(message_id=1000 + len(self.calls))

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

    async def send_message(self, **kw):
        self._record("send_message", kw)
        return self._message()

    async def send_photo(self, **kw):
        self._record("send_photo", kw)
        return self._message()

    async def send_video(self, **kw):
        self._record("send_video", kw)
        return self._message()

    async def send_animation(self, **kw):
        self._record("send_animation", kw)
        return self._message()

    async def send_poll(self, **kw):
        self._record("send_poll", kw)
        return self._message()

    async def send_paid_media(self, **kw):
        self._record("send_paid_media", kw)
        return self._message()

    async def stop_poll(self, **kw):
        self._record("stop_poll", kw)
        options = [SimpleNamespace(text=f"opt{i}", voter_count=v) for i, v in enumerate(self.poll_votes)]
        return SimpleNamespace(total_voter_count=sum(self.poll_votes), options=options, correct_option_id=None)

    async def approve_chat_join_request(self, **kw):
        self._record("approve_chat_join_request", kw)
        return True

    async def decline_chat_join_request(self, **kw):
        self._record("decline_chat_join_request", kw)
        return True

    async def delete_message(self, **kw):
        self._record("delete_message", kw)
        return True

    async def restrict_chat_member(self, **kw):
        self._record("restrict_chat_member", kw)
        return True

    async def get_webhook_info(self, **kw):
        self._record("get_webhook_info", kw)
        return SimpleNamespace(url=self.webhook_url)


def join_update(user_id: int, link: str | None, link_name: str | None, status: str = ChatMember.MEMBER,
                chat_id: int = CHANNEL_ID, subscription_period: int | None = None):
    """A ChatMemberUpdated-like object for someone joining the VIP channel."""
    invite = None
    if link:
        invite = SimpleNamespace(invite_link=link, name=link_name, subscription_period=subscription_period)
    user = SimpleNamespace(id=user_id)
    return SimpleNamespace(
        chat=SimpleNamespace(id=chat_id),
        old_chat_member=SimpleNamespace(status=ChatMember.LEFT, user=user, is_member=False),
        new_chat_member=SimpleNamespace(status=status, user=user, until_date=None, is_member=True),
        invite_link=invite,
    )
