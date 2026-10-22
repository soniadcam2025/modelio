"""In-memory stand-ins for Cloudinary and Telegram used by the poster tests."""

from dataclasses import replace

import httpx

from poster.cloudinary_source import Asset, SourceError
from poster.config import PosterConfig
from poster.telegram_publisher import PublishFailed, PublishUncertain

NOW = 1_800_000_000


def make_cfg(**overrides) -> PosterConfig:
    values = dict(telegram_bot_token="111:TOKEN-SECRET", cloud_name="demo", api_key="KEY-SECRET",
                  api_secret="API-SECRET-VALUE")
    values.update(overrides)
    return PosterConfig(**values)


def asset(public_id: str, resource_type: str = "image", fmt: str = "jpg", size: int = 1000,
          created: str = "2026-01-01T00:00:00Z", tags=(), caption: str = "") -> Asset:
    return Asset(public_id=public_id, resource_type=resource_type, delivery_type="upload", format=fmt,
                 bytes=size, secure_url=f"https://res.cloudinary.com/demo/{resource_type}/upload/{public_id}.{fmt}",
                 created_at=created, tags=tuple(tags), caption=caption)


class FakeSource:
    def __init__(self, assets: list[Asset], fail: set[str] | None = None):
        self.tags = {a.key: list(a.tags) for a in assets}
        self.assets = {a.key: a for a in assets}
        self.fail = fail or set()
        self.on_get_tags = None  # optional hook to simulate another run acting in between
        self.log: list[tuple] = []

    def _maybe_fail(self, name):
        if name in self.fail:
            raise SourceError(f"{name} failed")

    def list_assets(self):
        self._maybe_fail("list_assets")
        return [replace(a, tags=tuple(self.tags[k])) for k, a in self.assets.items()]

    def get_tags(self, a):
        self._maybe_fail("get_tags")
        if self.on_get_tags:
            self.on_get_tags(self, a)
        return list(self.tags[a.key])

    def add_tag(self, tag, assets):
        self.log.append(("add", tag, [a.public_id for a in assets]))
        if tag.startswith("tgbot_posted") or tag.startswith("tgbot_run"):
            self._maybe_fail("record")
        self._maybe_fail("add_tag")
        for a in assets:
            if tag not in self.tags[a.key]:
                self.tags[a.key].append(tag)

    def remove_tag(self, tag, assets):
        self.log.append(("remove", tag, [a.public_id for a in assets]))
        self._maybe_fail("remove_tag")
        for a in assets:
            if tag in self.tags[a.key]:
                self.tags[a.key].remove(tag)

    def tags_of(self, public_id, resource_type="image"):
        return self.tags[(resource_type, "upload", public_id)]


class FakePublisher:
    def __init__(self, problems=None, outcome="ok"):
        self.problems = problems or []
        self.outcome = outcome  # ok, failed, rejected, uncertain
        self.sent: list[dict] = []

    def check_channel(self, channel):
        return list(self.problems)

    def send_media(self, channel, kind, name, content, caption):
        self.sent.append(dict(channel=channel, kind=kind, name=name, size=len(content), caption=caption))
        if self.outcome == "failed":
            raise PublishFailed("sendPhoto: Forbidden: bot was kicked from the channel chat")
        if self.outcome == "rejected":
            raise PublishFailed("sendPhoto: Bad Request: PHOTO_INVALID_DIMENSIONS", rejected_request=True)
        if self.outcome == "uncertain":
            raise PublishUncertain("sendPhoto: connection problem after sending")
        return 100 + len(self.sent)


def media_http(status: int = 200, body: bytes = b"x" * 1000) -> httpx.Client:
    """An httpx client whose every GET returns the given file body."""
    return httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(status, content=body)))
