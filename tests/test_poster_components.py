"""Config, Cloudinary listing/tagging, media handling, Telegram publishing and log redaction."""

import io
import logging

import cloudinary.api
import cloudinary.exceptions
import cloudinary.uploader
import httpx
import pytest

from poster import media
from poster.cloudinary_source import CloudinarySource, SourceError, in_folder, parse_asset
from poster.config import ConfigError, PosterConfig
from poster.logs import RedactingFormatter
from poster.telegram_publisher import PublishFailed, PublishUncertain, TelegramPublisher

from .poster_fakes import asset, make_cfg

ENV = {"TELEGRAM_BOT_TOKEN": "111:TOKEN-SECRET", "CLOUDINARY_CLOUD_NAME": "demo",
       "CLOUDINARY_API_KEY": "KEY-SECRET", "CLOUDINARY_API_SECRET": "API-SECRET-VALUE"}


# Config


def test_missing_secrets_are_named_without_values():
    with pytest.raises(ConfigError) as err:
        PosterConfig.from_env({"CLOUDINARY_CLOUD_NAME": "demo", "CLOUDINARY_API_KEY": "KEY-SECRET"})
    message = str(err.value)
    assert "TELEGRAM_BOT_TOKEN" in message and "CLOUDINARY_API_SECRET" in message
    assert "CLOUDINARY_API_KEY" not in message and "KEY-SECRET" not in message


def test_config_defaults_and_repr():
    cfg = PosterConfig.from_env(ENV)
    assert cfg.public_channel == "@yourshakhira" and cfg.folder == "tgpub" and cfg.folder_mode == "auto"
    assert cfg.caption == "" and cfg.when_exhausted == "stop"
    for secret in ENV.values():
        if secret != "demo":
            assert secret not in repr(cfg)


def test_config_validation():
    assert PosterConfig.from_env({**ENV, "PUBLIC_CHANNEL": "-1001234"}).public_channel == "-1001234"
    assert PosterConfig.from_env({**ENV, "PUBLIC_CHANNEL": "mychan"}).public_channel == "@mychan"
    assert PosterConfig.from_env({**ENV, "CLOUDINARY_FOLDER": "/tgpub/"}).folder == "tgpub"
    with pytest.raises(ConfigError):
        PosterConfig.from_env({**ENV, "CLOUDINARY_FOLDER_MODE": "weird"})
    with pytest.raises(ConfigError):
        PosterConfig.from_env({**ENV, "MAX_PHOTO_BYTES": str(20 * 1024 * 1024)})
    with pytest.raises(ConfigError):
        PosterConfig.from_env({**ENV, "POST_CAPTION": "x" * 1025})


# Cloudinary listing


def raw(public_id, resource_type="image", **extra):
    return {"public_id": public_id, "resource_type": resource_type, "type": "upload", "format": "jpg",
            "bytes": 10, "secure_url": f"https://res.cloudinary.com/demo/{public_id}.jpg",
            "created_at": "2026-01-01T00:00:00Z", "tags": [], **extra}


def test_folder_matching_in_both_modes():
    assert in_folder(raw("abc", asset_folder="tgpub"), "tgpub")  # dynamic: public ID has no folder prefix
    assert not in_folder(raw("tgpub/x", asset_folder="other"), "tgpub")  # dynamic: prefix is misleading
    assert in_folder(raw("tgpub/x"), "tgpub")  # fixed mode
    assert not in_folder(raw("tgpub/sub/x"), "tgpub")  # subfolder
    assert not in_folder(raw("tgpubx/y"), "tgpub")
    assert in_folder(raw("tgpub/x", folder="tgpub"), "tgpub")


def test_parse_asset_handles_malformed_and_context():
    assert parse_asset({"resource_type": "image"}) is None
    assert parse_asset(raw("a", resource_type="audio")) is None
    assert parse_asset(raw("a", bytes="lots")) is None
    parsed = parse_asset(raw("a", context={"custom": {"caption": "Hi"}}, tags=["x", 3], width=800, height=600))
    assert parsed.caption == "Hi" and parsed.tags == ("x",) and (parsed.width, parsed.height) == (800, 600)


def no_sleep(_):
    pass


def test_dynamic_listing_with_pagination(monkeypatch):
    pages = {None: {"resources": [raw("p1", asset_folder="tgpub")], "next_cursor": "c2"},
             "c2": {"resources": [raw("p2", resource_type="video", asset_folder="tgpub"), "garbage"]}}
    seen = []

    def by_folder(folder, **kw):
        seen.append((folder, kw.get("next_cursor"), kw["tags"], kw["context"]))
        return pages[kw.get("next_cursor")]

    monkeypatch.setattr(cloudinary.api, "resources_by_asset_folder", by_folder)
    assets = CloudinarySource("demo", "k", "s", "tgpub", sleep=no_sleep).list_assets()
    assert [a.name for a in assets] == ["image:p1", "video:p2"]
    assert seen == [("tgpub", None, True, True), ("tgpub", "c2", True, True)]


def test_auto_mode_falls_back_to_prefix_listing_and_filters_subfolders(monkeypatch):
    def by_folder(folder, **kw):
        raise cloudinary.exceptions.BadRequest("not supported")

    def resources(**kw):
        assert kw["type"] == "upload" and kw["prefix"] == "tgpub/"
        if kw["resource_type"] == "image":
            return {"resources": [raw("tgpub/a"), raw("tgpub/sub/b")]}
        return {"resources": [raw("tgpub/v", resource_type="video")]}

    monkeypatch.setattr(cloudinary.api, "resources_by_asset_folder", by_folder)
    monkeypatch.setattr(cloudinary.api, "resources", resources)
    assets = CloudinarySource("demo", "k", "s", "tgpub", sleep=no_sleep).list_assets()
    assert [a.name for a in assets] == ["image:tgpub/a", "video:tgpub/v"]


def test_dynamic_mode_does_not_fall_back(monkeypatch):
    monkeypatch.setattr(cloudinary.api, "resources_by_asset_folder",
                        lambda folder, **kw: (_ for _ in ()).throw(cloudinary.exceptions.NotFound("nope")))
    with pytest.raises(SourceError):
        CloudinarySource("demo", "k", "s", "tgpub", mode="dynamic", sleep=no_sleep).list_assets()


def test_retries_then_gives_up_on_rate_limit(monkeypatch):
    calls, sleeps = [], []

    def limited(folder, **kw):
        calls.append(1)
        raise cloudinary.exceptions.RateLimited("slow down")

    monkeypatch.setattr(cloudinary.api, "resources_by_asset_folder", limited)
    with pytest.raises(SourceError, match="after retries"):
        CloudinarySource("demo", "k", "s", "tgpub", mode="dynamic", sleep=sleeps.append).list_assets()
    assert len(calls) == 3 and sleeps == [5, 20]


def test_unexpected_listing_response_is_an_error(monkeypatch):
    monkeypatch.setattr(cloudinary.api, "resources_by_asset_folder", lambda folder, **kw: {"oops": 1})
    with pytest.raises(SourceError, match="unexpected"):
        CloudinarySource("demo", "k", "s", "tgpub", mode="dynamic", sleep=no_sleep).list_assets()


def test_tagging_uses_add_remove_per_resource_type(monkeypatch):
    calls = []
    monkeypatch.setattr(cloudinary.uploader, "add_tag", lambda tag, ids, **kw: calls.append(("add", tag, ids, kw)))
    monkeypatch.setattr(cloudinary.uploader, "remove_tag", lambda tag, ids, **kw: calls.append(("rm", tag, ids, kw)))
    source = CloudinarySource("demo", "k", "s", "tgpub", sleep=no_sleep)
    source.add_tag("tgbot_posted", [asset("a"), asset("v", resource_type="video", fmt="mp4"), asset("b")])
    source.remove_tag("tgbot_posted", [asset("a")])
    assert calls == [
        ("add", "tgbot_posted", ["a", "b"], {"resource_type": "image", "type": "upload"}),
        ("add", "tgbot_posted", ["v"], {"resource_type": "video", "type": "upload"}),
        ("rm", "tgbot_posted", ["a"], {"resource_type": "image", "type": "upload"}),
    ]


def test_get_tags_reads_single_resource(monkeypatch):
    monkeypatch.setattr(cloudinary.api, "resource", lambda pid, **kw: {"tags": ["x", "tgbot_posted"]})
    assert CloudinarySource("demo", "k", "s", "tgpub").get_tags(asset("a")) == ["x", "tgbot_posted"]


# Media


def test_classify_photo_video_and_skips():
    cfg = make_cfg()
    assert media.classify(asset("a", fmt="png"), cfg)[0] == "photo"
    assert media.classify(asset("v", resource_type="video", fmt="mp4"), cfg)[0] == "video"
    assert media.classify(asset("g", fmt="gif"), cfg)[0] == "animation"
    assert media.classify(asset("m", resource_type="video", fmt="mov"), cfg)[0] is None
    assert media.classify(asset("big", size=10 * 1024 * 1024 + 1), cfg)[0] is None
    assert media.classify(asset("bigv", resource_type="video", fmt="mp4", size=50 * 1024 * 1024 + 1), cfg)[0] is None
    from dataclasses import replace as _replace

    assert media.classify(_replace(asset("w"), width=9000, height=1500), cfg)[0] is None  # sides > 10000
    assert media.classify(_replace(asset("n"), width=4200, height=200), cfg)[0] is None  # ratio > 20
    assert media.classify(_replace(asset("ok"), width=4000, height=3000), cfg)[0] == "photo"
    private = asset("p")
    from dataclasses import replace

    assert media.classify(replace(private, delivery_type="private"), cfg)[0] is None


def test_download_enforces_size_limit():
    client = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"x" * 50)))
    assert media.download(client, asset("a"), 100) == b"x" * 50
    with pytest.raises(media.DownloadError):
        media.download(client, asset("a"), 10)
    empty = httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, content=b"")))
    with pytest.raises(media.DownloadError):
        media.download(empty, asset("a"), 100)


# Telegram publishing


def telegram(handler):
    requests = []

    def wrapped(request):
        requests.append(request)
        return handler(request, len(requests))

    return TelegramPublisher("111:TOKEN-SECRET", client=httpx.Client(transport=httpx.MockTransport(wrapped)),
                             sleep=no_sleep), requests


def ok(result):
    return httpx.Response(200, json={"ok": True, "result": result})


def test_send_photo_and_video_use_correct_methods():
    pub, requests = telegram(lambda r, n: ok({"message_id": 7}))
    assert pub.send_media("@chan", "photo", "a.jpg", b"img", "Hi") == 7
    assert pub.send_media("@chan", "video", "v.mp4", b"vid", "") == 7
    assert requests[0].url.path.endswith("/sendPhoto") and b'name="photo"' in requests[0].content
    assert b'name="caption"' in requests[0].content
    assert requests[1].url.path.endswith("/sendVideo") and b'name="video"' in requests[1].content
    assert b'name="supports_streaming"' in requests[1].content and b'name="caption"' not in requests[1].content


def test_rate_limit_is_retried():
    def handler(r, n):
        if n == 1:
            return httpx.Response(429, json={"ok": False, "description": "Too Many Requests",
                                             "parameters": {"retry_after": 3}})
        return ok({"message_id": 9})

    pub, requests = telegram(handler)
    assert pub.send_media("@chan", "photo", "a.jpg", b"img", "") == 9
    assert len(requests) == 2


def test_bad_request_is_a_definite_failure():
    pub, requests = telegram(lambda r, n: httpx.Response(400, json={"ok": False, "description": "Bad Request: x"}))
    with pytest.raises(PublishFailed) as err:
        pub.send_media("@chan", "photo", "a.jpg", b"img", "")
    assert len(requests) == 1 and err.value.rejected_request is True
    pub, _ = telegram(lambda r, n: httpx.Response(403, json={"ok": False, "description": "Forbidden"}))
    with pytest.raises(PublishFailed) as err:
        pub.send_media("@chan", "photo", "a.jpg", b"img", "")
    assert err.value.rejected_request is False


def test_server_error_or_lost_response_is_uncertain_and_not_retried():
    pub, requests = telegram(lambda r, n: httpx.Response(502, json={"ok": False, "description": "Bad Gateway"}))
    with pytest.raises(PublishUncertain):
        pub.send_media("@chan", "photo", "a.jpg", b"img", "")
    assert len(requests) == 1

    def timeout(r, n):
        raise httpx.ReadTimeout("slow", request=r)

    pub, requests = telegram(timeout)
    with pytest.raises(PublishUncertain):
        pub.send_media("@chan", "photo", "a.jpg", b"img", "")
    assert len(requests) == 1


def test_connect_error_is_retried_then_fails():
    def refuse(r, n):
        raise httpx.ConnectError("refused", request=r)

    pub, requests = telegram(refuse)
    with pytest.raises(PublishFailed):
        pub.send_media("@chan", "photo", "a.jpg", b"img", "")
    assert len(requests) == 3


def channel_api(member_status, can_post=True, chat_type="channel", chat_error=False):
    def handler(r, n):
        method = r.url.path.rsplit("/", 1)[-1]
        if method == "getMe":
            return ok({"id": 42, "username": "ShakhiraVIPBot"})
        if chat_error:
            return httpx.Response(400, json={"ok": False, "description": "Bad Request: chat not found"})
        if method == "getChat":
            return ok({"id": -100, "type": chat_type})
        return ok({"status": member_status, "can_post_messages": can_post})

    return handler


def test_channel_check():
    assert telegram(channel_api("administrator"))[0].check_channel("@yourshakhira") == []
    assert telegram(channel_api("creator"))[0].check_channel("@yourshakhira") == []
    assert "not an admin" in telegram(channel_api("member"))[0].check_channel("@yourshakhira")[0]
    assert "cannot post" in telegram(channel_api("administrator", can_post=False))[0].check_channel("@yourshakhira")[0]
    assert "cannot access" in telegram(channel_api("left", chat_error=True))[0].check_channel("@yourshakhira")[0]


# Logging


def test_secrets_are_redacted_from_logs_and_tracebacks():
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(RedactingFormatter(["111:TOKEN-SECRET", "API-SECRET-VALUE"], "%(message)s"))
    log = logging.getLogger("redaction-test")
    log.addHandler(handler)
    try:
        raise RuntimeError("https://api.telegram.org/bot111:TOKEN-SECRET/sendPhoto failed")
    except RuntimeError:
        log.exception("upload failed with secret API-SECRET-VALUE")
    log.removeHandler(handler)
    output = stream.getvalue()
    assert "TOKEN-SECRET" not in output and "API-SECRET-VALUE" not in output
    assert output.count("[REDACTED]") >= 3
