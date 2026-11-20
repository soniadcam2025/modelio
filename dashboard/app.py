"""Web admin dashboard (FastAPI). Serves a JSON API under /api and the single-page app under /.

Security model
- The dashboard never holds the Telegram bot token. It only reads the shared SQLite database and
  writes *requests* to it (posts to schedule, admin actions to run). The send-only worker or the
  full bot, which hold the token, carry those out, and only for features switched on.
- One admin password (PBKDF2 hash in DASHBOARD_PASSWORD_HASH), signed HttpOnly SameSite=Strict
  session cookie, CSRF header on every change, login rate limit, strict security headers.
- Listens on 127.0.0.1 by default: reach it through an SSH tunnel or an HTTPS reverse proxy.
"""

import csv
import io
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from fastapi import Body, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from shakhira_bot.ops import FEATURES, JOIN_POLICIES, TARGETS, Ops, OpsError, connect
from shakhira_bot.storage import Storage

from .auth import LoginLimiter, Sessions, verify_password

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
SESSION_COOKIE = "sb_session"
POSTER_CACHE_SECONDS = 300
IST = timezone(timedelta(hours=5, minutes=30))


@dataclass
class Settings:
    database_path: str
    password_hash: str
    secret: str
    secure_cookies: bool = True
    admin_name: str = "admin"
    public_channel: str = "@yourshakhira"
    slot_times: tuple[tuple[int, int], ...] = ((16, 30), (23, 30))
    cloudinary: dict = field(default_factory=dict)  # cloud_name, api_key, api_secret, folder (optional)

    @classmethod
    def from_env(cls, env: dict | None = None) -> "Settings":
        env = dict(os.environ if env is None else env)
        missing = [n for n in ("DASHBOARD_PASSWORD_HASH", "DASHBOARD_SECRET") if not env.get(n, "").strip()]
        if missing:
            raise ValueError("Missing " + ", ".join(missing) + " (see README: Admin dashboard)")
        from poster.slots import parse_times

        cloud = {}
        if all(env.get(k) for k in ("CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET")):
            cloud = {"cloud_name": env["CLOUDINARY_CLOUD_NAME"], "api_key": env["CLOUDINARY_API_KEY"],
                     "api_secret": env["CLOUDINARY_API_SECRET"], "folder": env.get("CLOUDINARY_FOLDER") or "tgpub"}
        return cls(
            database_path=env.get("DATABASE_PATH", "").strip() or "data/shakhira_bot.db",
            password_hash=env["DASHBOARD_PASSWORD_HASH"].strip(),
            secret=env["DASHBOARD_SECRET"].strip(),
            secure_cookies=env.get("DASHBOARD_INSECURE_COOKIES", "").lower() not in ("1", "true", "yes"),
            public_channel=env.get("PUBLIC_CHANNEL", "").strip() or "@yourshakhira",
            slot_times=tuple(parse_times(env.get("POST_SLOTS_UTC", "") or "16:30,23:30")),
            cloudinary=cloud,
        )


SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' https: data:; media-src https:; "
                               "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
                               "base-uri 'none'; form-action 'self'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
}


def csv_safe(value) -> str:
    """Stop spreadsheet formula injection in exported CSV cells."""
    text = "" if value is None else str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def create_app(settings: Settings, clock=time.time, poster_loader=None) -> FastAPI:
    # Create or upgrade the schema once, with the same code the bot uses.
    Storage(settings.database_path).close()
    sessions = Sessions(settings.secret, clock=clock)
    limiter = LoginLimiter(clock=clock)
    poster_cache: dict = {}
    app = FastAPI(title="Shakhira admin", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        for key, value in SECURITY_HEADERS.items():
            response.headers.setdefault(key, value)
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(OpsError)
    async def ops_error(_request: Request, exc: OpsError):
        return JSONResponse({"error": str(exc)}, status_code=400)

    def get_ops():
        conn = connect(settings.database_path)
        try:
            ops = Ops(conn, clock=clock)
            yield ops
        finally:
            conn.close()

    def require_session(request: Request) -> str:
        token = request.cookies.get(SESSION_COOKIE)
        if not sessions.valid(token):
            raise HTTPException(401, "Please sign in")
        if request.method not in ("GET", "HEAD"):
            sent = request.headers.get("x-csrf-token", "")
            if not sent or sent != sessions.csrf_for(token):
                raise HTTPException(403, "Security check failed; reload the page")
        return settings.admin_name

    # Sign-in

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.post("/api/login")
    def login(request: Request, response: Response, body: dict = Body(...)):
        client = request.client.host if request.client else "unknown"
        if limiter.blocked(client):
            raise HTTPException(429, "Too many attempts. Wait 15 minutes.")
        if not verify_password(str(body.get("password", "")), settings.password_hash):
            limiter.failed(client)
            raise HTTPException(401, "Wrong password")
        limiter.succeeded(client)
        token = sessions.issue()
        response.set_cookie(SESSION_COOKIE, token, max_age=sessions.lifetime, httponly=True,
                            secure=settings.secure_cookies, samesite="strict", path="/")
        return {"user": settings.admin_name, "csrf": sessions.csrf_for(token)}

    @app.post("/api/logout")
    def logout(request: Request, response: Response, _actor: str = Depends(require_session)):
        sessions.revoke(request.cookies.get(SESSION_COOKIE))
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/me")
    def me(request: Request, actor: str = Depends(require_session)):
        return {"user": actor, "csrf": sessions.csrf_for(request.cookies[SESSION_COOKIE])}

    # Overview

    @app.get("/api/overview")
    def overview(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        now = ops.now()
        stats = ops.analytics(now, days=30)
        upcoming = [i for i in ops.content_list(status="scheduled") if i["scheduled_at"]]
        upcoming.sort(key=lambda i: i["scheduled_at"])
        attention = ops.content_list(status="failed") + ops.content_list(status="uncertain")
        people = ops.subscribers(now=now, limit=100000)
        heartbeat = ops.get_setting("heartbeat:worker")
        return {
            "now": now,
            "stars_30d": stats["stars_total"],
            "revenue_by_day": stats["revenue_by_day"],
            "trials": stats["trials"],
            "members": {k: sum(1 for p in people if p["membership"] == k) for k in ("monthly", "trial", "left", "none")},
            "scheduled_count": len(upcoming),
            "upcoming": upcoming[:6],
            "attention": attention[:10],
            "join_pending": len(ops.join_requests("pending")),
            "actions_queued": len(ops.queued_actions()),
            "features": ops.features(),
            "worker_last_seen": int(heartbeat) if heartbeat else None,
            "poster_slots_ist": [_slot_label(t) for t in settings.slot_times],
        }

    # Content

    @app.get("/api/content")
    def content_list(status: str | None = None, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return [_content_out(i) for i in ops.content_list(status=status or None)]

    @app.post("/api/content")
    def content_create(body: dict = Body(...), actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        item = ops.create_content(body, actor)
        if body.get("schedule"):
            item = ops.schedule_content(item["id"], body.get("scheduled_at"), actor)
        return _content_out(item)

    @app.put("/api/content/{item_id}")
    def content_update(item_id: int, body: dict = Body(...), actor: str = Depends(require_session),
                       ops: Ops = Depends(get_ops)):
        return _content_out(ops.update_content(item_id, body, actor))

    @app.post("/api/content/{item_id}/schedule")
    def content_schedule(item_id: int, body: dict = Body(default={}), actor: str = Depends(require_session),
                         ops: Ops = Depends(get_ops)):
        return _content_out(ops.schedule_content(item_id, body.get("scheduled_at"), actor))

    @app.post("/api/content/{item_id}/cancel")
    def content_cancel(item_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return _content_out(ops.cancel_content(item_id, actor))

    @app.post("/api/content/{item_id}/duplicate")
    def content_duplicate(item_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return _content_out(ops.duplicate_content(item_id, actor))

    @app.delete("/api/content/{item_id}")
    def content_delete(item_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        ops.delete_content(item_id, actor)
        return {"ok": True}

    @app.get("/api/calendar")
    def calendar(start: int, end: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        if end <= start or end - start > 62 * 86400:
            raise OpsError("Choose a range of up to 62 days")
        items = [_content_out(i) for i in ops.content_list(start=start, end=end)
                 if i["status"] not in ("cancelled",)]
        slots = []
        day = datetime.fromtimestamp(start, tz=timezone.utc).replace(hour=0, minute=0, second=0)
        while day.timestamp() < end:
            for hour, minute in settings.slot_times:
                moment = day.replace(hour=hour, minute=minute)
                if start <= moment.timestamp() < end:
                    slots.append({"at": int(moment.timestamp()), "label": "Cloudinary auto-post (GitHub)"})
            day += timedelta(days=1)
        return {"items": items, "poster_slots": slots}

    # Captions

    @app.get("/api/captions")
    def captions(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.captions()

    @app.post("/api/captions")
    def caption_add(body: dict = Body(...), actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.add_caption(str(body.get("text", "")), actor)

    @app.put("/api/captions/{caption_id}")
    def caption_update(caption_id: int, body: dict = Body(...), actor: str = Depends(require_session),
                       ops: Ops = Depends(get_ops)):
        ops.set_caption_active(caption_id, bool(body.get("active")), actor)
        return {"ok": True}

    @app.delete("/api/captions/{caption_id}")
    def caption_delete(caption_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        ops.delete_caption(caption_id, actor)
        return {"ok": True}

    # Subscribers

    @app.get("/api/subscribers")
    def subscribers(q: str = "", actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.subscribers(q)

    @app.get("/api/subscribers/{user_id}")
    def subscriber(user_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.subscriber(user_id, ops.now())

    @app.put("/api/subscribers/{user_id}")
    def subscriber_update(user_id: int, body: dict = Body(...), actor: str = Depends(require_session),
                          ops: Ops = Depends(get_ops)):
        return ops.update_profile(user_id, body.get("tags"), body.get("notes"), actor)

    @app.get("/api/export/subscribers.csv")
    def export_subscribers(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        out = io.StringIO()
        writer = csv.writer(out)
        columns = ["user_id", "username", "first_name", "membership", "subscription_until", "trial_expires_at",
                   "stars_paid", "source", "tags", "first_seen", "last_seen"]
        writer.writerow(columns)
        for person in ops.subscribers(limit=100000):
            writer.writerow([csv_safe(person.get(c)) for c in columns])
        ops.audit(actor, "export", "subscribers.csv")
        return PlainTextResponse(out.getvalue(), media_type="text/csv",
                                 headers={"Content-Disposition": "attachment; filename=subscribers.csv"})

    # Join requests and admin actions

    @app.get("/api/join-requests")
    def join_requests(status: str = "pending", actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.join_requests(status if status != "all" else None)

    @app.get("/api/actions")
    def actions(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return [{**a, "payload": json.loads(a["payload_json"])} for a in ops.actions()]

    @app.post("/api/actions")
    def queue_action(body: dict = Body(...), actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.queue_action(str(body.get("kind", "")), dict(body.get("payload") or {}), actor)

    # Moderation

    @app.get("/api/moderation")
    def moderation(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return {"rules": ops.moderation_rules(), "log": ops.moderation_log()}

    @app.post("/api/moderation/rules")
    def moderation_add(body: dict = Body(...), actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.add_moderation_rule(str(body.get("kind", "")), str(body.get("pattern", "")),
                                       str(body.get("action", "")), actor)

    @app.delete("/api/moderation/rules/{rule_id}")
    def moderation_delete(rule_id: int, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        ops.delete_moderation_rule(rule_id, actor)
        return {"ok": True}

    # Analytics, settings, audit

    @app.get("/api/analytics")
    def analytics(days: int = 30, actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.analytics(ops.now(), days=max(1, min(days, 365)))

    @app.get("/api/settings")
    def get_settings(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return {
            "features": ops.features(),
            "join_policies": {t: ops.join_policy(t) for t in TARGETS},
            "join_policy_options": JOIN_POLICIES,
            "public_channel": settings.public_channel,
        }

    @app.put("/api/settings/features/{name}")
    def set_feature(name: str, body: dict = Body(...), actor: str = Depends(require_session),
                    ops: Ops = Depends(get_ops)):
        if name not in FEATURES:
            raise HTTPException(404, "Unknown feature")
        ops.set_feature(name, bool(body.get("enabled")), actor)
        return ops.features()[name]

    @app.put("/api/settings/join-policy/{target}")
    def set_join_policy(target: str, body: dict = Body(...), actor: str = Depends(require_session),
                        ops: Ops = Depends(get_ops)):
        ops.set_join_policy(target, str(body.get("policy", "")), actor)
        return {"target": target, "policy": ops.join_policy(target)}

    @app.get("/api/audit")
    def audit(actor: str = Depends(require_session), ops: Ops = Depends(get_ops)):
        return ops.audit_entries()

    # Cloudinary media library (read-only)

    @app.get("/api/poster")
    def poster(refresh: bool = False, actor: str = Depends(require_session)):
        if not settings.cloudinary and poster_loader is None:
            return {"configured": False}
        now = clock()
        if refresh or not poster_cache or now - poster_cache["at"] > POSTER_CACHE_SECONDS:
            loader = poster_loader or _load_poster
            try:
                poster_cache.update(at=now, data=loader(settings))
            except Exception as exc:  # noqa: BLE001 - show the problem instead of a 500
                return {"configured": True, "error": f"{type(exc).__name__}: {exc}"[:300]}
        return {"configured": True, **poster_cache["data"]}

    # Single-page app

    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(STATIC_DIR, "index.html"))

    return app


def _slot_label(time_utc: tuple[int, int]) -> str:
    moment = datetime(2026, 1, 1, *time_utc, tzinfo=timezone.utc).astimezone(IST)
    return moment.strftime("%I:%M %p").lstrip("0") + " IST"


def _content_out(item: dict) -> dict:
    return {**item, "options": json.loads(item.get("options_json") or "[]"),
            "poll_results": json.loads(item["poll_results_json"]) if item.get("poll_results_json") else None}


def _load_poster(settings: Settings) -> dict:
    """Read-only Cloudinary listing: what is left to post and recent posts."""
    from poster import media, runner
    from poster.cloudinary_source import CloudinarySource
    from poster.config import PosterConfig

    c = settings.cloudinary
    cfg = PosterConfig(telegram_bot_token="unused", cloud_name=c["cloud_name"], api_key=c["api_key"],
                       api_secret=c["api_secret"], folder=c["folder"], slot_times=settings.slot_times)
    assets = CloudinarySource(c["cloud_name"], c["api_key"], c["api_secret"], c["folder"]).list_assets()
    inv = runner.inventory(cfg, assets)
    library = []
    for a in sorted(assets, key=lambda x: x.created_at, reverse=True)[:200]:
        kind, reason = media.classify(a, cfg)
        state = ("posted" if runner.POSTED_TAG in a.tags else "uncertain" if runner.UNCERTAIN_TAG in a.tags
                 else "rejected" if runner.REJECTED_TAG in a.tags else "unsupported" if kind is None else "queued")
        thumb = a.secure_url if a.resource_type == "image" else ""
        library.append({"name": a.public_id, "kind": kind or a.format, "state": state, "url": a.secure_url,
                        "thumb": thumb, "bytes": a.bytes, "created_at": a.created_at, "caption": a.caption,
                        "note": "" if kind else reason})
    return {"folder": c["folder"], "inventory": {k: getattr(inv, k) for k in
            ("total", "supported", "unsupported", "posted", "uncertain", "rejected", "remaining")},
            "recent_slots": [{"slot": s, "asset": n} for s, n in inv.slots[:20]], "library": library}
