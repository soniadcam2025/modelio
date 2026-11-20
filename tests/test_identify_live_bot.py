"""The live-bot identification tool must only ever call read-only Telegram methods."""

import httpx
import pytest

from tools.identify_live_bot import READ_ONLY_METHODS, Inspector, guess_host, inspect, render


def fake_telegram(webhook_url=""):
    calls = []

    def handler(request):
        method = request.url.path.rsplit("/", 1)[-1]
        calls.append(method)
        results = {
            "getMe": {"id": 42, "username": "ShakhiraVIPBot"},
            "getWebhookInfo": {"url": webhook_url, "pending_update_count": 0, "ip_address": "203.0.113.5"},
            "getMyCommands": [{"command": "start", "description": "Start"}],
            "getMyDescription": {"description": "VIP"},
            "getMyShortDescription": {"short_description": "VIP"},
            "getChat": {"id": -100, "title": "Shakhira", "username": "yourshakhira", "linked_chat_id": None},
            "getChatMemberCount": 1234,
        }
        return httpx.Response(200, json={"ok": True, "result": results[method]})

    return Inspector("1:SECRET", client=httpx.Client(transport=httpx.MockTransport(handler))), calls


def test_webhook_reveals_host_without_the_secret_path():
    inspector, calls = fake_telegram("https://shakhira-bot.onrender.com/hook/SECRET-PATH")
    report = inspect(inspector, "@yourshakhira", "-1001234567890")
    assert report["delivery"]["mode"] == "webhook" and report["delivery"]["likely_hosting"] == "Render"
    assert report["delivery"]["webhook_host"] == "shakhira-bot.onrender.com"
    assert "SECRET-PATH" not in render(report)
    assert set(calls) <= set(READ_ONLY_METHODS) and "getUpdates" not in calls
    assert report["public_channel"]["members"] == 1234


def test_polling_bot():
    inspector, calls = fake_telegram("")
    report = inspect(inspector)
    assert report["delivery"]["mode"].startswith("long polling")
    assert "getUpdates" not in calls


def test_write_methods_are_refused():
    inspector, _ = fake_telegram()
    for method in ("getUpdates", "deleteWebhook", "setWebhook", "sendMessage"):
        with pytest.raises(RuntimeError):
            inspector.call(method)


@pytest.mark.parametrize("url, expected", [
    ("https://x.up.railway.app/h", "Railway"), ("https://abc-uc.a.run.app/h", "Google Cloud Run"),
    ("https://203.0.113.5:8443/h", "a server reached by IP address (most likely a VPS)"),
    ("https://bot.example.com/h", "your own domain (most likely a VPS or a custom-domain cloud service)"),
])
def test_host_guesses(url, expected):
    assert guess_host(url) == expected


def test_cloudinary_history_export_is_read_only():
    from tools.export_cloudinary_history import export

    from .poster_fakes import FakeSource, asset

    source = FakeSource([asset("tgpub/a", tags=["tgbot_posted", "tgbot_slot_20261120T1630Z", "mine"]), asset("tgpub/b")])
    source.folder = "tgpub"
    data = export(source, 1_800_000_000)
    assert data["assets"][0]["tgbot_tags"] == ["tgbot_posted", "tgbot_slot_20261120T1630Z"]
    assert source.log == []  # nothing tagged or untagged
