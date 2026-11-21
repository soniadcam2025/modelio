"""The GitHub poster's pause switch from the admin dashboard: honoured only when explicitly paused, fail-open otherwise."""
import httpx

from poster.__main__ import dashboard_paused


def client(handler):
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_paused_only_when_dashboard_says_so():
    assert dashboard_paused(client(lambda r: httpx.Response(200, json={"poster_paused": True})), "https://d/api/public/automation") is True
    assert dashboard_paused(client(lambda r: httpx.Response(200, json={"poster_paused": False})), "https://d/x") is False
    assert dashboard_paused(client(lambda r: httpx.Response(200, json={"poster_paused": "yes"})), "https://d/x") is False


def test_fail_open_keeps_the_schedule():
    def boom(request):
        raise httpx.ConnectError("down")
    assert dashboard_paused(client(boom), "https://d/x") is False
    assert dashboard_paused(client(lambda r: httpx.Response(503, json={"poster_paused": True})), "https://d/x") is False
    assert dashboard_paused(client(lambda r: httpx.Response(200, text="<html>")), "https://d/x") is False
    assert dashboard_paused(client(lambda r: httpx.Response(200, json={"poster_paused": True})), "") is False
