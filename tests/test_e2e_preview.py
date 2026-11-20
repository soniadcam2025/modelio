"""End to end, in PREVIEW mode: the real dashboard API creates every kind of post, the real worker
code publishes them, and a fake Telegram records where each one would have gone.

Proves: every post type works through the whole path; preview mode sends ONLY to the admin's private
chat (never a channel, never a subscriber); the calendar and status views reflect the result.
"""

import asyncio

from fastapi.testclient import TestClient

from dashboard.app import Settings, create_app
from dashboard.auth import hash_password
from shakhira_bot import scheduler
from shakhira_bot.storage import Storage

from .fakes import FakeBot, make_config

NOW = 1_800_000_000
ADMIN_PREVIEW_CHAT = 424242
PASSWORD = "preview-password-123"

POSTS = [
    {"kind": "text", "target": "public", "text": "Good morning ☀️", "button_text": "Join VIP",
     "button_url": "https://t.me/ShakhiraVIPBot"},
    {"kind": "photo", "target": "public", "media_url": "https://res.cloudinary.com/demo/image/upload/sample.jpg",
     "text": "Photo caption"},
    {"kind": "video", "target": "vip", "media_url": "https://res.cloudinary.com/demo/video/upload/dog.mp4"},
    {"kind": "animation", "target": "public", "media_url": "https://res.cloudinary.com/demo/image/upload/kitten.gif"},
    {"kind": "poll", "target": "public", "text": "Which look next?", "options": ["Red", "Black", "Denim"],
     "close_after_minutes": 60},
    {"kind": "quiz", "target": "public", "text": "Favourite city?", "options": ["Mumbai", "Goa"], "correct_option": 1,
     "explanation": "Goa!"},
    {"kind": "promo", "target": "public", "text": "💎 VIP trial: 3 days for 49 ⭐"},
    {"kind": "paid_media", "target": "vip", "media_url": "https://res.cloudinary.com/demo/image/upload/sample.jpg",
     "star_count": 25, "text": "Exclusive"},
]


def test_every_post_type_end_to_end_in_preview_mode(tmp_path):
    db = str(tmp_path / "preview.db")
    app = create_app(Settings(database_path=db, password_hash=hash_password(PASSWORD, iterations=1000),
                              secret="p" * 40, secure_cookies=False), clock=lambda: NOW)
    client = TestClient(app)
    csrf = {"X-CSRF-Token": client.post("/api/login", json={"password": PASSWORD}).json()["csrf"]}

    # 1. Admin creates and schedules one of each type, and switches publishing on.
    ids = []
    for post in POSTS:
        r = client.post("/api/content", headers=csrf, json={**post, "schedule": True, "scheduled_at": NOW - 5})
        assert r.status_code == 200, (post["kind"], r.text)
        ids.append(r.json()["id"])
    for feature in ("scheduled_posts", "poll_auto_close", "admin_actions", "trial_reminders"):
        assert client.put(f"/api/settings/features/{feature}", headers=csrf, json={"enabled": True}).status_code == 200
    client.post("/api/actions", headers=csrf, json={"kind": "send_dm", "payload": {"user_id": 7, "text": "hi"}})
    cal = client.get(f"/api/calendar?start={NOW - 86400}&end={NOW + 86400}").json()
    assert len(cal["items"]) == len(POSTS) and len(cal["poster_slots"]) == 4

    # 2. The worker runs one cycle in preview mode.
    store = Storage(db)
    bot = FakeBot()
    cfg = make_config(preview_chat_id=ADMIN_PREVIEW_CHAT, database_path=db)
    asyncio.run(scheduler.run_cycle(bot, store, cfg, NOW))

    # 3. Everything went to the admin's private chat only.
    sent = [(name, kw) for name, kw in bot.calls]
    assert {kw["chat_id"] for _, kw in sent} == {ADMIN_PREVIEW_CHAT}
    assert [name for name, _ in sent] == ["send_message", "send_photo", "send_video", "send_animation",
                                          "send_poll", "send_poll", "send_message", "send_paid_media"]
    assert sent[5][1]["type"] == "quiz" and sent[7][1]["star_count"] == 25
    assert sent[6][1]["reply_markup"].inline_keyboard[0][0].url.startswith("https://t.me/ShakhiraVIPBot?start=promo_")
    # No subscriber was contacted: the queued DM stays queued in preview mode.
    assert client.get("/api/actions").json()[0]["status"] == "queued"

    # 4. The dashboard shows the outcome.
    statuses = {i["id"]: i["status"] for i in client.get("/api/content").json()}
    assert all(statuses[i] == "posted" for i in ids)
    overview = client.get("/api/overview").json()
    assert overview["worker_last_seen"] == NOW and overview["scheduled_count"] == 0

    # 5. The poll closes on time and its results reach Analytics.
    asyncio.run(scheduler.run_cycle(bot, store, cfg, NOW + 3600))
    polls = client.get("/api/analytics?days=30").json()["polls"]
    assert polls and polls[0]["total_voters"] == 4
    store.close()
