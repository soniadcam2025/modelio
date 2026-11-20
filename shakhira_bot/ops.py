"""Operations data shared by the bot, the send-only worker and the web dashboard.

All of it lives in the same SQLite file as payments and trials. The dashboard only ever writes
*requests* here (content to publish, admin actions to run); the worker or the bot, which hold the
bot token, carry them out. The dashboard process never holds the token.
"""

import json
import sqlite3
import time
from dataclasses import dataclass

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS content_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,              -- text, photo, video, animation, poll, quiz, promo, paid_media
    target TEXT NOT NULL,            -- public or vip
    text TEXT NOT NULL DEFAULT '',   -- message text, caption, or poll question
    media_url TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '[]',
    correct_option INTEGER,
    explanation TEXT NOT NULL DEFAULT '',
    multiple_answers INTEGER NOT NULL DEFAULT 0,
    close_after_minutes INTEGER,
    star_count INTEGER,
    button_text TEXT NOT NULL DEFAULT '',
    button_url TEXT NOT NULL DEFAULT '',
    use_caption_library INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft, scheduled, sending, posted, failed, uncertain, cancelled
    scheduled_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    sending_since INTEGER,
    posted_at INTEGER,
    message_id INTEGER,
    poll_closed_at INTEGER,
    poll_results_json TEXT,
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_due ON content_items (status, scheduled_at);

CREATE TABLE IF NOT EXISTS captions (
    id INTEGER PRIMARY KEY,
    text TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    used_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER
);

CREATE TABLE IF NOT EXISTS profiles (
    user_id INTEGER PRIMARY KEY,
    username TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS join_requests (
    id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    requested_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, declined, failed
    reason TEXT NOT NULL DEFAULT '',
    decided_at INTEGER,
    decided_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS join_pending ON join_requests (status, chat_id);

CREATE TABLE IF NOT EXISTS admin_actions (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,               -- approve_join, decline_join, remove_member, unban_member, send_dm, close_poll
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued, done, failed
    error TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    done_at INTEGER
);

CREATE TABLE IF NOT EXISTS moderation_rules (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,     -- word or link
    pattern TEXT NOT NULL,
    action TEXT NOT NULL,   -- delete, delete_warn, delete_mute
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS moderation_log (
    id INTEGER PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    rule_id INTEGER,
    action TEXT NOT NULL,
    excerpt TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reaction_counts (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    reactions_json TEXT NOT NULL,
    total INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS reminders_sent (
    key TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
);
"""

CONTENT_KINDS = ("text", "photo", "video", "animation", "poll", "quiz", "promo", "paid_media")
TARGETS = ("public", "vip")
ACTION_KINDS = ("approve_join", "decline_join", "remove_member", "unban_member", "send_dm", "close_poll")
MODERATION_KINDS = ("word", "link")
MODERATION_ACTIONS = ("delete", "delete_warn", "delete_mute")

# Every feature that changes something in Telegram is OFF until switched on in the dashboard.
FEATURES = {
    "scheduled_posts": "Publish scheduled posts, polls, quizzes, promotions and paid media",
    "poll_auto_close": "Close polls after their set time and save the results",
    "trial_reminders": "Remind trial members 24 hours before their trial ends",
    "renewal_reminders": "Remind monthly subscribers 3 days before Telegram renews them",
    "admin_actions": "Carry out admin actions queued in the dashboard (approve, remove, unban, message)",
    "join_requests": "Record join requests to the channels (needs the full bot; see README)",
    "moderation": "Moderate the channel's existing discussion group, if it has one (needs the full bot)",
    "reaction_tracking": "Record reaction counts on channel posts (needs the full bot)",
}
JOIN_POLICIES = ("manual", "approve_paid", "approve_all")
FEATURE_PREFIX = "feature:"
JOIN_POLICY_KEY = "join_policy:"


class OpsError(ValueError):
    """Invalid input from the dashboard; the message is safe to show."""


def connect(path: str) -> sqlite3.Connection:
    """A connection tuned for several processes sharing one SQLite file."""
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(OPS_SCHEMA)
    conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    conn.commit()


def _row(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


@dataclass
class Ops:
    conn: sqlite3.Connection
    clock: object = time.time

    def now(self) -> int:
        return int(self.clock())

    # Settings and features

    def get_setting(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def set_setting(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def feature_enabled(self, name: str) -> bool:
        return self.get_setting(FEATURE_PREFIX + name, "0") == "1"

    def features(self) -> dict[str, dict]:
        return {name: {"enabled": self.feature_enabled(name), "description": desc} for name, desc in FEATURES.items()}

    def set_feature(self, name: str, enabled: bool, actor: str) -> None:
        if name not in FEATURES:
            raise OpsError(f"Unknown feature {name!r}")
        self.set_setting(FEATURE_PREFIX + name, "1" if enabled else "0")
        self.audit(actor, "feature", f"{name} {'on' if enabled else 'off'}")

    def join_policy(self, target: str) -> str:
        return self.get_setting(JOIN_POLICY_KEY + target, "manual")

    def set_join_policy(self, target: str, policy: str, actor: str) -> None:
        if target not in TARGETS or policy not in JOIN_POLICIES:
            raise OpsError("Invalid join policy")
        if target == "vip" and policy == "approve_all":
            raise OpsError("The VIP channel can't approve everyone: that would give paid content away")
        self.set_setting(JOIN_POLICY_KEY + target, policy)
        self.audit(actor, "join_policy", f"{target}: {policy}")

    # Audit

    def audit(self, actor: str, action: str, detail: str = "") -> None:
        with self.conn:
            self.conn.execute("INSERT INTO audit_log (actor, action, detail, created_at) VALUES (?, ?, ?, ?)",
                              (actor, action, detail[:500], self.now()))

    def audit_entries(self, limit: int = 200) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return [dict(r) for r in rows]

    # Content

    def create_content(self, data: dict, actor: str) -> dict:
        values = validate_content(data)
        now = self.now()
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO content_items (kind, target, text, media_url, options_json, correct_option, explanation, "
                "multiple_answers, close_after_minutes, star_count, button_text, button_url, use_caption_library, "
                "status, scheduled_at, created_by, created_at, updated_at) "
                "VALUES (:kind, :target, :text, :media_url, :options_json, :correct_option, :explanation, "
                ":multiple_answers, :close_after_minutes, :star_count, :button_text, :button_url, :use_caption_library, "
                "'draft', :scheduled_at, :actor, :now, :now)",
                {**values, "actor": actor, "now": now},
            )
        self.audit(actor, "content_create", f"#{cur.lastrowid} {values['kind']} -> {values['target']}")
        return self.content(cur.lastrowid)

    def update_content(self, item_id: int, data: dict, actor: str) -> dict:
        item = self._editable(item_id)
        values = validate_content({**item, "options": json.loads(item["options_json"]), **data})
        with self.conn:
            self.conn.execute(
                "UPDATE content_items SET kind=:kind, target=:target, text=:text, media_url=:media_url, "
                "options_json=:options_json, correct_option=:correct_option, explanation=:explanation, "
                "multiple_answers=:multiple_answers, close_after_minutes=:close_after_minutes, star_count=:star_count, "
                "button_text=:button_text, button_url=:button_url, use_caption_library=:use_caption_library, "
                "scheduled_at=:scheduled_at, updated_at=:now WHERE id=:id",
                {**values, "now": self.now(), "id": item_id},
            )
        self.audit(actor, "content_update", f"#{item_id}")
        return self.content(item_id)

    def schedule_content(self, item_id: int, when: int | None, actor: str) -> dict:
        item = self._editable(item_id)
        when = int(when if when is not None else (item["scheduled_at"] or self.now()))
        with self.conn:
            self.conn.execute("UPDATE content_items SET status='scheduled', scheduled_at=?, last_error='', updated_at=? "
                              "WHERE id=?", (when, self.now(), item_id))
        self.audit(actor, "content_schedule", f"#{item_id} at {when}")
        return self.content(item_id)

    def cancel_content(self, item_id: int, actor: str) -> dict:
        item = self.content(item_id)
        if item is None:
            raise OpsError("Not found")
        if item["status"] not in ("draft", "scheduled", "failed"):
            raise OpsError(f"A {item['status']} post can't be cancelled")
        with self.conn:
            self.conn.execute("UPDATE content_items SET status='cancelled', updated_at=? WHERE id=?",
                              (self.now(), item_id))
        self.audit(actor, "content_cancel", f"#{item_id}")
        return self.content(item_id)

    def duplicate_content(self, item_id: int, actor: str) -> dict:
        item = self.content(item_id)
        if item is None:
            raise OpsError("Not found")
        data = {**item, "options": json.loads(item["options_json"]), "scheduled_at": None}
        return self.create_content(data, actor)

    def delete_content(self, item_id: int, actor: str) -> None:
        item = self.content(item_id)
        if item is None or item["status"] not in ("draft", "cancelled"):
            raise OpsError("Only drafts and cancelled posts can be deleted")
        with self.conn:
            self.conn.execute("DELETE FROM content_items WHERE id=?", (item_id,))
        self.audit(actor, "content_delete", f"#{item_id}")

    def _editable(self, item_id: int) -> dict:
        item = self.content(item_id)
        if item is None:
            raise OpsError("Not found")
        if item["status"] not in ("draft", "scheduled", "failed"):
            raise OpsError(f"A {item['status']} post can't be changed")
        return item

    def content(self, item_id: int) -> dict | None:
        return _row(self.conn.execute("SELECT * FROM content_items WHERE id=?", (item_id,)).fetchone())

    def content_list(self, status: str | None = None, start: int | None = None, end: int | None = None,
                     limit: int = 500) -> list[dict]:
        sql, args = "SELECT * FROM content_items WHERE 1=1", []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if start is not None:
            sql += " AND COALESCE(posted_at, scheduled_at, created_at) >= ?"
            args.append(start)
        if end is not None:
            sql += " AND COALESCE(posted_at, scheduled_at, created_at) < ?"
            args.append(end)
        sql += " ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?"
        args.append(limit)
        return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def due_content(self, now: int) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM content_items WHERE status='scheduled' AND scheduled_at <= ? "
                                 "ORDER BY scheduled_at, id", (now,)).fetchall()
        return [dict(r) for r in rows]

    def claim_for_sending(self, item_id: int, now: int) -> bool:
        """Move a due item to 'sending'. False if another process already took it."""
        with self.conn:
            cur = self.conn.execute("UPDATE content_items SET status='sending', sending_since=?, attempts=attempts+1, "
                                    "updated_at=? WHERE id=? AND status='scheduled'", (now, now, item_id))
        return cur.rowcount == 1

    def mark_posted(self, item_id: int, message_id: int, now: int, text: str | None = None) -> None:
        with self.conn:
            self.conn.execute("UPDATE content_items SET status='posted', message_id=?, posted_at=?, last_error='', "
                              "text=COALESCE(?, text), updated_at=? WHERE id=?", (message_id, now, text, now, item_id))

    def mark_failed(self, item_id: int, status: str, error: str, now: int, retry_at: int | None = None) -> None:
        with self.conn:
            if retry_at is not None:
                self.conn.execute("UPDATE content_items SET status='scheduled', scheduled_at=?, last_error=?, "
                                  "updated_at=? WHERE id=?", (retry_at, error[:500], now, item_id))
            else:
                self.conn.execute("UPDATE content_items SET status=?, last_error=?, updated_at=? WHERE id=?",
                                  (status, error[:500], now, item_id))

    def stale_sending(self, older_than: int) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM content_items WHERE status='sending' AND sending_since < ?",
                                 (older_than,)).fetchall()
        return [dict(r) for r in rows]

    def polls_to_close(self, now: int) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM content_items WHERE kind IN ('poll','quiz') AND status='posted' AND poll_closed_at IS NULL "
            "AND close_after_minutes IS NOT NULL AND posted_at + close_after_minutes * 60 <= ?", (now,)).fetchall()
        return [dict(r) for r in rows]

    def save_poll_results(self, item_id: int, results: dict, now: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE content_items SET poll_closed_at=?, poll_results_json=?, updated_at=? WHERE id=?",
                              (now, json.dumps(results), now, item_id))

    # Caption library

    def captions(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM captions ORDER BY id").fetchall()]

    def add_caption(self, text: str, actor: str) -> dict:
        text = _clean_text(text, 1024, "Caption")
        if not text:
            raise OpsError("Caption is empty")
        with self.conn:
            cur = self.conn.execute("INSERT INTO captions (text) VALUES (?)", (text,))
        self.audit(actor, "caption_add", f"#{cur.lastrowid}")
        return _row(self.conn.execute("SELECT * FROM captions WHERE id=?", (cur.lastrowid,)).fetchone())

    def set_caption_active(self, caption_id: int, active: bool, actor: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE captions SET active=? WHERE id=?", (1 if active else 0, caption_id))
        self.audit(actor, "caption_active", f"#{caption_id} {active}")

    def delete_caption(self, caption_id: int, actor: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM captions WHERE id=?", (caption_id,))
        self.audit(actor, "caption_delete", f"#{caption_id}")

    def next_caption(self, now: int) -> str | None:
        """The active caption used least (then longest ago), and record its use: an even rotation."""
        row = self.conn.execute("SELECT * FROM captions WHERE active=1 ORDER BY used_count, "
                                "COALESCE(last_used_at, 0), id LIMIT 1").fetchone()
        if row is None:
            return None
        with self.conn:
            self.conn.execute("UPDATE captions SET used_count=used_count+1, last_used_at=? WHERE id=?",
                              (now, row["id"]))
        return row["text"]

    # Profiles

    def touch_profile(self, user_id: int, username: str = "", first_name: str = "", source: str = "",
                      now: int | None = None) -> None:
        now = self.now() if now is None else now
        with self.conn:
            self.conn.execute(
                "INSERT INTO profiles (user_id, username, first_name, source, first_seen, last_seen) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET "
                "username = CASE WHEN excluded.username != '' THEN excluded.username ELSE username END, "
                "first_name = CASE WHEN excluded.first_name != '' THEN excluded.first_name ELSE first_name END, "
                "source = CASE WHEN source = '' THEN excluded.source ELSE source END, last_seen = excluded.last_seen",
                (user_id, username or "", first_name or "", source or "", now, now),
            )

    def update_profile(self, user_id: int, tags: str | None, notes: str | None, actor: str) -> dict:
        self.touch_profile(user_id)
        with self.conn:
            if tags is not None:
                clean = ",".join(sorted({t.strip()[:32] for t in tags.split(",") if t.strip()}))
                self.conn.execute("UPDATE profiles SET tags=? WHERE user_id=?", (clean, user_id))
            if notes is not None:
                self.conn.execute("UPDATE profiles SET notes=? WHERE user_id=?", (notes[:2000], user_id))
        self.audit(actor, "profile_update", f"user {user_id}")
        return self.subscriber(user_id, int(self.clock()))

    def subscribers(self, query: str = "", limit: int = 500, now: int | None = None) -> list[dict]:
        """Everyone the bot knows about: profiles plus anyone seen in payments, trials or member events."""
        now = self.now() if now is None else now
        ids = self.conn.execute(
            "SELECT user_id FROM profiles UNION SELECT user_id FROM payments UNION SELECT user_id FROM trials "
            "UNION SELECT user_id FROM member_events").fetchall()
        result = [self.subscriber(r["user_id"], now, brief=True) for r in ids]
        q = query.strip().lower().lstrip("@")
        if q:
            result = [s for s in result if q in str(s["user_id"]) or q in s["username"].lower()
                      or q in s["first_name"].lower() or q in s["tags"].lower()]
        result.sort(key=lambda s: s["last_seen"] or 0, reverse=True)
        return result[:limit]

    def subscriber(self, user_id: int, now: int, brief: bool = False) -> dict:
        profile = _row(self.conn.execute("SELECT * FROM profiles WHERE user_id=?", (user_id,)).fetchone()) or {
            "user_id": user_id, "username": "", "first_name": "", "source": "", "tags": "", "notes": "",
            "first_seen": None, "last_seen": None}
        payments = [dict(r) for r in self.conn.execute(
            "SELECT telegram_payment_charge_id AS charge_id, plan, amount, currency, status, created_at FROM payments "
            "WHERE user_id=? ORDER BY created_at DESC", (user_id,)).fetchall()]
        trials = [dict(r) for r in self.conn.execute(
            "SELECT id, starts_at, expires_at, joined_at, status FROM trials WHERE user_id=? ORDER BY id DESC",
            (user_id,)).fetchall()]
        events = [dict(r) for r in self.conn.execute(
            "SELECT event, invite_link_name, subscription_until, created_at FROM member_events WHERE user_id=? "
            "ORDER BY id DESC LIMIT 50", (user_id,)).fetchall()]
        last_sub = next((e["subscription_until"] for e in events if e["subscription_until"]), None)
        active_trial = next((t for t in trials if t["status"] == "active" and t["expires_at"] > now), None)
        if last_sub and last_sub > now:
            membership = "monthly"
        elif active_trial:
            membership = "trial"
        elif events and events[0]["event"] == "left":
            membership = "left"
        else:
            membership = "none"
        seen = [x for x in [profile["last_seen"]] + [p["created_at"] for p in payments] + [e["created_at"] for e in events] if x]
        summary = {
            **profile,
            "membership": membership,
            "subscription_until": last_sub,
            "trial_expires_at": active_trial["expires_at"] if active_trial else None,
            "stars_paid": sum(p["amount"] for p in payments if p["status"] in (None, "accepted") and p["currency"] == "XTR"),
            "last_seen": max(seen) if seen else None,
        }
        if not brief:
            summary.update(payments=payments, trials=trials, events=events)
        return summary

    # Join requests

    def record_join_request(self, chat_id: int, user_id: int, username: str, first_name: str, now: int) -> int:
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO join_requests (chat_id, user_id, username, first_name, requested_at) VALUES (?, ?, ?, ?, ?)",
                (chat_id, user_id, username or "", first_name or "", now))
        return cur.lastrowid

    def join_requests(self, status: str | None = "pending", limit: int = 500) -> list[dict]:
        if status:
            rows = self.conn.execute("SELECT * FROM join_requests WHERE status=? ORDER BY requested_at DESC LIMIT ?",
                                     (status, limit)).fetchall()
        else:
            rows = self.conn.execute("SELECT * FROM join_requests ORDER BY requested_at DESC LIMIT ?",
                                     (limit,)).fetchall()
        return [dict(r) for r in rows]

    def join_request(self, request_id: int) -> dict | None:
        return _row(self.conn.execute("SELECT * FROM join_requests WHERE id=?", (request_id,)).fetchone())

    def set_join_status(self, request_id: int, status: str, reason: str, actor: str, now: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE join_requests SET status=?, reason=?, decided_at=?, decided_by=? WHERE id=?",
                              (status, reason[:200], now, actor, request_id))

    # Admin actions (queued by the dashboard, carried out by the worker or bot)

    def queue_action(self, kind: str, payload: dict, actor: str) -> dict:
        if kind not in ACTION_KINDS:
            raise OpsError(f"Unknown action {kind!r}")
        payload = validate_action(kind, payload, self)
        with self.conn:
            cur = self.conn.execute("INSERT INTO admin_actions (kind, payload_json, created_by, created_at) "
                                    "VALUES (?, ?, ?, ?)", (kind, json.dumps(payload), actor, self.now()))
        self.audit(actor, "action_queue", f"#{cur.lastrowid} {kind} {json.dumps(payload)[:200]}")
        return _row(self.conn.execute("SELECT * FROM admin_actions WHERE id=?", (cur.lastrowid,)).fetchone())

    def queued_actions(self) -> list[dict]:
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM admin_actions WHERE status='queued' ORDER BY id").fetchall()]

    def actions(self, limit: int = 200) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM admin_actions ORDER BY id DESC LIMIT ?",
                                                   (limit,)).fetchall()]

    def finish_action(self, action_id: int, ok: bool, error: str, now: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE admin_actions SET status=?, error=?, done_at=? WHERE id=?",
                              ("done" if ok else "failed", error[:500], now, action_id))

    # Moderation

    def moderation_rules(self, active_only: bool = False) -> list[dict]:
        sql = "SELECT * FROM moderation_rules" + (" WHERE active=1" if active_only else "") + " ORDER BY id"
        return [dict(r) for r in self.conn.execute(sql).fetchall()]

    def add_moderation_rule(self, kind: str, pattern: str, action: str, actor: str) -> dict:
        pattern = (pattern or "").strip().lower()
        if kind not in MODERATION_KINDS or action not in MODERATION_ACTIONS:
            raise OpsError("Invalid rule")
        if not pattern or len(pattern) > 100:
            raise OpsError("Pattern must be 1-100 characters")
        with self.conn:
            cur = self.conn.execute("INSERT INTO moderation_rules (kind, pattern, action) VALUES (?, ?, ?)",
                                    (kind, pattern, action))
        self.audit(actor, "moderation_rule_add", f"#{cur.lastrowid} {kind}:{pattern} -> {action}")
        return _row(self.conn.execute("SELECT * FROM moderation_rules WHERE id=?", (cur.lastrowid,)).fetchone())

    def delete_moderation_rule(self, rule_id: int, actor: str) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM moderation_rules WHERE id=?", (rule_id,))
        self.audit(actor, "moderation_rule_delete", f"#{rule_id}")

    def log_moderation(self, chat_id: int, user_id: int, rule_id: int | None, action: str, excerpt: str,
                       now: int) -> None:
        with self.conn:
            self.conn.execute("INSERT INTO moderation_log (chat_id, user_id, rule_id, action, excerpt, created_at) "
                              "VALUES (?, ?, ?, ?, ?, ?)", (chat_id, user_id, rule_id, action, excerpt[:200], now))

    def strikes(self, user_id: int, since: int) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM moderation_log WHERE user_id=? AND created_at>=?",
                                 (user_id, since)).fetchone()[0]

    def moderation_log(self, limit: int = 200) -> list[dict]:
        return [dict(r) for r in self.conn.execute("SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?",
                                                   (limit,)).fetchall()]

    # Reactions

    def save_reactions(self, chat_id: int, message_id: int, counts: dict[str, int], now: int) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO reaction_counts (chat_id, message_id, reactions_json, total, updated_at) "
                "VALUES (?, ?, ?, ?, ?) ON CONFLICT(chat_id, message_id) DO UPDATE SET "
                "reactions_json=excluded.reactions_json, total=excluded.total, updated_at=excluded.updated_at",
                (chat_id, message_id, json.dumps(counts), sum(counts.values()), now))

    # Reminders

    def reminder_sent(self, key: str) -> bool:
        return self.conn.execute("SELECT 1 FROM reminders_sent WHERE key=?", (key,)).fetchone() is not None

    def mark_reminder(self, key: str, now: int) -> None:
        with self.conn:
            self.conn.execute("INSERT OR IGNORE INTO reminders_sent (key, sent_at) VALUES (?, ?)", (key, now))

    # Analytics

    def analytics(self, now: int, days: int = 30) -> dict:
        start = now - days * 86400
        day = "date(created_at, 'unixepoch')"
        revenue = [dict(r) for r in self.conn.execute(
            f"SELECT {day} AS day, SUM(amount) AS stars, COUNT(*) AS payments FROM payments "
            f"WHERE created_at >= ? AND currency='XTR' AND (status IS NULL OR status='accepted') GROUP BY day ORDER BY day",
            (start,)).fetchall()]
        trials = self.conn.execute(
            "SELECT COUNT(*) AS started, SUM(status='converted') AS converted, SUM(status='active') AS active, "
            "SUM(joined_at IS NOT NULL) AS joined FROM trials WHERE starts_at >= ?", (start,)).fetchone()
        posts = [dict(r) for r in self.conn.execute(
            "SELECT kind, COUNT(*) AS count FROM content_items WHERE status='posted' AND posted_at >= ? GROUP BY kind",
            (start,)).fetchall()]
        polls = []
        for r in self.conn.execute("SELECT id, kind, text, poll_results_json, message_id, target FROM content_items "
                                   "WHERE poll_results_json IS NOT NULL ORDER BY poll_closed_at DESC LIMIT 10"):
            polls.append({"id": r["id"], "kind": r["kind"], "question": r["text"], "target": r["target"],
                          **json.loads(r["poll_results_json"])})
        reactions = [dict(r) for r in self.conn.execute(
            "SELECT chat_id, message_id, total, reactions_json FROM reaction_counts ORDER BY total DESC LIMIT 10")]
        return {
            "days": days,
            "revenue_by_day": revenue,
            "stars_total": sum(r["stars"] for r in revenue),
            "trials": {k: (trials[k] or 0) for k in ("started", "converted", "active", "joined")},
            "posts_by_kind": posts,
            "polls": polls,
            "top_reactions": reactions,
        }


# Validation


URL_PREFIXES = ("https://",)
TG_LINK_PREFIXES = ("https://t.me/", "tg://")


def _clean_text(value, limit: int, name: str) -> str:
    text = str(value or "").replace("\r\n", "\n").strip()
    if len(text) > limit:
        raise OpsError(f"{name} is longer than {limit} characters")
    return text


def validate_content(data: dict) -> dict:
    """Check a content item against what Telegram accepts. Returns the database values."""
    kind = data.get("kind")
    target = data.get("target")
    if kind not in CONTENT_KINDS:
        raise OpsError("Choose a post type")
    if target not in TARGETS:
        raise OpsError("Choose the public or the VIP channel")
    media_kinds = ("photo", "video", "animation", "paid_media")
    text_limit = 1024 if kind in media_kinds else 300 if kind in ("poll", "quiz") else 4096
    text = _clean_text(data.get("text"), text_limit, "Text")
    media_url = str(data.get("media_url") or "").strip()
    options: list[str] = []
    correct = None
    explanation = ""
    close_after = data.get("close_after_minutes")
    star_count = None

    if kind in media_kinds:
        if not media_url.startswith(URL_PREFIXES) or len(media_url) > 2000:
            raise OpsError("Media needs an https:// link (for example a Cloudinary URL)")
    else:
        media_url = ""
    if kind in ("text", "promo") and not text:
        raise OpsError("Write the message text")
    if kind in ("poll", "quiz"):
        if not text:
            raise OpsError("Write the question")
        options = [_clean_text(o, 100, "Option") for o in (data.get("options") or []) if str(o or "").strip()]
        if not 2 <= len(options) <= 10:
            raise OpsError("A poll needs 2 to 10 options")
        if len(set(options)) != len(options):
            raise OpsError("Options must be different")
        if kind == "quiz":
            try:
                correct = int(data.get("correct_option"))
            except (TypeError, ValueError):
                raise OpsError("Pick the correct answer") from None
            if not 0 <= correct < len(options):
                raise OpsError("Pick the correct answer")
            explanation = _clean_text(data.get("explanation"), 200, "Explanation")
        if close_after not in (None, ""):
            try:
                close_after = int(close_after)
            except (TypeError, ValueError):
                raise OpsError("Close-after must be a number of minutes") from None
            if not 5 <= close_after <= 60 * 24 * 30:
                raise OpsError("Close-after must be between 5 minutes and 30 days")
        else:
            close_after = None
    else:
        close_after = None
    if kind == "paid_media":
        try:
            star_count = int(data.get("star_count"))
        except (TypeError, ValueError):
            raise OpsError("Set a price in Stars") from None
        if not 1 <= star_count <= 10000:
            raise OpsError("Paid media price must be 1 to 10,000 Stars")
    button_text = _clean_text(data.get("button_text"), 64, "Button text")
    button_url = str(data.get("button_url") or "").strip()
    if button_text or button_url:
        if kind in ("poll", "quiz", "paid_media"):
            raise OpsError("Polls, quizzes and paid media can't have a button")
        if not button_text or not button_url.startswith(URL_PREFIXES + TG_LINK_PREFIXES) or len(button_url) > 500:
            raise OpsError("A button needs text and an https:// or t.me link")
    scheduled_at = data.get("scheduled_at")
    if scheduled_at in ("", None):
        scheduled_at = None
    else:
        try:
            scheduled_at = int(scheduled_at)
        except (TypeError, ValueError):
            raise OpsError("Invalid schedule time") from None
    use_library = 1 if data.get("use_caption_library") and kind in media_kinds and not text else 0
    return {
        "kind": kind, "target": target, "text": text, "media_url": media_url, "options_json": json.dumps(options),
        "correct_option": correct, "explanation": explanation,
        "multiple_answers": 1 if data.get("multiple_answers") and kind == "poll" else 0,
        "close_after_minutes": close_after, "star_count": star_count, "button_text": button_text,
        "button_url": button_url, "use_caption_library": use_library, "scheduled_at": scheduled_at,
    }


def validate_action(kind: str, payload: dict, ops: "Ops") -> dict:
    if kind in ("approve_join", "decline_join"):
        request = ops.join_request(int(payload.get("request_id", 0)))
        if request is None or request["status"] != "pending":
            raise OpsError("That join request is not pending")
        return {"request_id": request["id"], "chat_id": request["chat_id"], "user_id": request["user_id"]}
    if kind == "close_poll":
        item = ops.content(int(payload.get("content_id", 0)))
        if item is None or item["kind"] not in ("poll", "quiz") or item["status"] != "posted" or item["poll_closed_at"]:
            raise OpsError("Only an open, posted poll can be closed")
        return {"content_id": item["id"]}
    try:
        user_id = int(payload.get("user_id"))
    except (TypeError, ValueError):
        raise OpsError("Invalid user") from None
    if user_id <= 0:
        raise OpsError("Invalid user")
    if kind == "send_dm":
        text = _clean_text(payload.get("text"), 4096, "Message")
        if not text:
            raise OpsError("Write the message")
        return {"user_id": user_id, "text": text}
    return {"user_id": user_id}
