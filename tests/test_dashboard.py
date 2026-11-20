"""Web dashboard API: sign-in, CSRF, rate limit, headers, and every page's endpoints. No network."""

import pytest
from fastapi.testclient import TestClient

from dashboard.app import Settings, create_app, csv_safe
from dashboard.auth import Sessions, hash_password, verify_password
from shakhira_bot.storage import Storage

PASSWORD = "correct horse battery"
NOW = 1_800_000_000
HASH = hash_password(PASSWORD, iterations=1000)  # fast for tests; production default is 600,000


@pytest.fixture
def db(tmp_path):
    return str(tmp_path / "bot.db")


@pytest.fixture
def client(db):
    settings = Settings(database_path=db, password_hash=HASH, secret="s" * 40, secure_cookies=False)
    loader = lambda s: {"folder": "tgpub", "inventory": {"remaining": 3, "posted": 34, "total": 37, "supported": 37,
                                                        "unsupported": 0, "uncertain": 0, "rejected": 0},
                        "recent_slots": [], "library": []}
    app = create_app(settings, clock=lambda: NOW, poster_loader=loader)
    return TestClient(app)


def login(client) -> dict:
    r = client.post("/api/login", json={"password": PASSWORD})
    assert r.status_code == 200
    return {"X-CSRF-Token": r.json()["csrf"]}


# Security


def test_password_hashing():
    assert verify_password(PASSWORD, HASH) and not verify_password("wrong password!", HASH)
    assert not verify_password(PASSWORD, "garbage")
    with pytest.raises(ValueError):
        hash_password("short")


def test_everything_requires_sign_in(client):
    for path in ("/api/overview", "/api/content", "/api/subscribers", "/api/settings", "/api/audit",
                 "/api/export/subscribers.csv", "/api/poster"):
        assert client.get(path).status_code == 401, path
    assert client.post("/api/content", json={}).status_code == 401
    assert client.get("/api/health").json() == {"ok": True}


def test_wrong_password_and_rate_limit(client):
    for _ in range(5):
        assert client.post("/api/login", json={"password": "nope"}).status_code == 401
    assert client.post("/api/login", json={"password": PASSWORD}).status_code == 429


def test_session_cookie_flags(db):
    app = create_app(Settings(database_path=db, password_hash=HASH, secret="s" * 40), clock=lambda: NOW)
    r = TestClient(app, base_url="https://testserver").post("/api/login", json={"password": PASSWORD})
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "secure" in cookie and "samesite=strict" in cookie


def test_changes_need_csrf_token(client):
    csrf = login(client)
    body = {"kind": "text", "target": "public", "text": "hi"}
    assert client.post("/api/content", json=body).status_code == 403
    assert client.post("/api/content", json=body, headers={"X-CSRF-Token": "forged"}).status_code == 403
    assert client.post("/api/content", json=body, headers=csrf).status_code == 200


def test_logout_revokes_session(client):
    csrf = login(client)
    assert client.post("/api/logout", headers=csrf).status_code == 200
    assert client.get("/api/overview").status_code == 401


def test_expired_and_tampered_sessions():
    clock = [NOW]
    sessions = Sessions("k" * 40, clock=lambda: clock[0], lifetime=60)
    token = sessions.issue()
    assert sessions.valid(token)
    assert not sessions.valid(token[:-1] + ("0" if token[-1] != "0" else "1"))
    clock[0] += 61
    assert not sessions.valid(token)
    with pytest.raises(ValueError):
        Sessions("short")


def test_security_headers(client):
    r = client.get("/")
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    assert client.get("/api/health").headers["cache-control"] == "no-store"


def test_csv_export_is_formula_safe(client, db):
    csrf = login(client)
    store = Storage(db)
    store.ops.touch_profile(7, "=cmd|'/c calc'!A1", "+evil", "", NOW)
    store.close()
    text = client.get("/api/export/subscribers.csv").text
    assert "'=cmd" in text and "'+evil" in text
    assert csv_safe("-1") == "'-1" and csv_safe("ok") == "ok"
    assert client.get("/api/audit").json()[0]["action"] == "export"
    assert csrf


# Pages


def test_content_lifecycle(client):
    csrf = login(client)
    item = client.post("/api/content", headers=csrf, json={"kind": "quiz", "target": "public", "text": "Guess?",
                                                            "options": ["a", "b"], "correct_option": 1}).json()
    assert item["status"] == "draft" and item["options"] == ["a", "b"]
    bad = client.post("/api/content", headers=csrf, json={"kind": "poll", "target": "public", "text": "Q", "options": ["x"]})
    assert bad.status_code == 400 and "2 to 10" in bad.json()["error"]
    edited = client.put(f"/api/content/{item['id']}", headers=csrf, json={"text": "Guess again?"}).json()
    assert edited["text"] == "Guess again?" and edited["kind"] == "quiz"
    scheduled = client.post(f"/api/content/{item['id']}/schedule", headers=csrf, json={"scheduled_at": NOW + 3600}).json()
    assert scheduled["status"] == "scheduled"
    copy = client.post(f"/api/content/{item['id']}/duplicate", headers=csrf).json()
    assert copy["status"] == "draft" and copy["id"] != item["id"]
    assert client.post(f"/api/content/{item['id']}/cancel", headers=csrf).json()["status"] == "cancelled"
    assert client.delete(f"/api/content/{item['id']}", headers=csrf).status_code == 200
    assert [i["id"] for i in client.get("/api/content").json()] == [copy["id"]]
    created = client.post("/api/content", headers=csrf, json={"kind": "text", "target": "vip", "text": "Now",
                                                               "schedule": True, "scheduled_at": NOW + 60}).json()
    assert created["status"] == "scheduled"


def test_overview_and_calendar(client):
    csrf = login(client)
    client.post("/api/content", headers=csrf, json={"kind": "text", "target": "public", "text": "Soon",
                                                     "schedule": True, "scheduled_at": NOW + 600})
    o = client.get("/api/overview").json()
    assert o["scheduled_count"] == 1 and o["upcoming"][0]["text"] == "Soon"
    assert o["poster_slots_ist"] == ["10:00 PM IST", "5:00 AM IST"]
    assert not any(f["enabled"] for f in o["features"].values())
    cal = client.get(f"/api/calendar?start={NOW - 86400}&end={NOW + 6 * 86400}").json()
    assert len(cal["items"]) == 1 and len(cal["poster_slots"]) == 14
    assert client.get(f"/api/calendar?start={NOW}&end={NOW + 100 * 86400}").status_code == 400


def test_settings_and_join_policy(client):
    csrf = login(client)
    assert client.put("/api/settings/features/scheduled_posts", headers=csrf, json={"enabled": True}).json()["enabled"]
    assert client.put("/api/settings/features/nope", headers=csrf, json={"enabled": True}).status_code == 404
    assert client.put("/api/settings/join-policy/vip", headers=csrf, json={"policy": "approve_all"}).status_code == 400
    assert client.put("/api/settings/join-policy/vip", headers=csrf, json={"policy": "approve_paid"}).status_code == 200
    s = client.get("/api/settings").json()
    assert s["features"]["scheduled_posts"]["enabled"] and s["join_policies"]["vip"] == "approve_paid"
    assert {a["action"] for a in client.get("/api/audit").json()} >= {"feature", "join_policy"}


def test_subscribers_actions_and_join_requests(client, db):
    csrf = login(client)
    store = Storage(db)
    store.ops.touch_profile(7, "fan", "Fan", "promo_1", NOW)
    req = store.ops.record_join_request(-1001234567890, 9, "newbie", "New", NOW)
    store.close()
    assert client.get("/api/subscribers?q=fan").json()[0]["user_id"] == 7
    updated = client.put("/api/subscribers/7", headers=csrf, json={"tags": "vip", "notes": "top fan"}).json()
    assert updated["tags"] == "vip" and updated["notes"] == "top fan"
    assert client.get("/api/join-requests").json()[0]["user_id"] == 9
    a = client.post("/api/actions", headers=csrf, json={"kind": "approve_join", "payload": {"request_id": req}}).json()
    assert a["status"] == "queued"
    assert client.post("/api/actions", headers=csrf, json={"kind": "send_dm", "payload": {"user_id": 7}}).status_code == 400
    assert client.get("/api/actions").json()[0]["payload"]["user_id"] == 9


def test_captions_moderation_analytics_and_media(client):
    csrf = login(client)
    cap = client.post("/api/captions", headers=csrf, json={"text": "Good night ✨"}).json()
    client.put(f"/api/captions/{cap['id']}", headers=csrf, json={"active": False})
    assert client.get("/api/captions").json()[0]["active"] == 0
    rule = client.post("/api/moderation/rules", headers=csrf, json={"kind": "word", "pattern": "Spam",
                                                                     "action": "delete"}).json()
    assert rule["pattern"] == "spam"
    assert client.post("/api/moderation/rules", headers=csrf, json={"kind": "regex", "pattern": ".*",
                                                                     "action": "delete"}).status_code == 400
    assert client.delete(f"/api/moderation/rules/{rule['id']}", headers=csrf).status_code == 200
    a = client.get("/api/analytics?days=7").json()
    assert a["days"] == 7 and a["stars_total"] == 0
    media = client.get("/api/poster").json()
    assert media["configured"] and media["inventory"]["remaining"] == 3


def test_media_library_not_configured(db):
    app = create_app(Settings(database_path=db, password_hash=HASH, secret="s" * 40, secure_cookies=False))
    client = TestClient(app)
    login(client)
    assert client.get("/api/poster").json() == {"configured": False}


def test_static_app_is_served(client):
    assert "Shakhira Admin" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_settings_from_env():
    with pytest.raises(ValueError, match="DASHBOARD_PASSWORD_HASH"):
        Settings.from_env({})
    s = Settings.from_env({"DASHBOARD_PASSWORD_HASH": HASH, "DASHBOARD_SECRET": "x" * 40})
    assert s.secure_cookies and s.cloudinary == {} and s.slot_times == ((16, 30), (23, 30))
