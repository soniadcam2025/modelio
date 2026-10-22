"""SQLite storage for payments, trials and bot settings."""

import os
import sqlite3
from dataclasses import dataclass

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY,
    telegram_payment_charge_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    plan TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trials (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    charge_id TEXT NOT NULL UNIQUE REFERENCES payments (telegram_payment_charge_id),
    starts_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    invite_link TEXT,
    joined_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',  -- active, ended, converted
    ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS trials_user ON trials (user_id);
CREATE INDEX IF NOT EXISTS trials_due ON trials (status, expires_at);

CREATE TABLE IF NOT EXISTS member_events (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    invite_link_name TEXT,
    subscription_until INTEGER,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class Trial:
    id: int
    user_id: int
    charge_id: str
    starts_at: int
    expires_at: int
    invite_link: str | None
    joined_at: int | None
    status: str


class Storage:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        # Schema version for future migrations (1 = the tables above).
        if self.conn.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    # Payments

    def record_payment(
        self, charge_id: str, user_id: int, plan: str, amount: int, currency: str, payload: str, now: int
    ) -> bool:
        """Save a payment. Returns False if this charge ID was already recorded (duplicate update)."""
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO payments "
            "(telegram_payment_charge_id, user_id, plan, amount, currency, payload, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (charge_id, user_id, plan, amount, currency, payload, now),
        )
        self.conn.commit()
        return cur.rowcount == 1

    # Trials

    def has_used_trial(self, user_id: int) -> bool:
        row = self.conn.execute("SELECT 1 FROM trials WHERE user_id = ? LIMIT 1", (user_id,)).fetchone()
        return row is not None

    def create_trial(self, user_id: int, charge_id: str, starts_at: int, expires_at: int) -> Trial:
        cur = self.conn.execute(
            "INSERT INTO trials (user_id, charge_id, starts_at, expires_at) VALUES (?, ?, ?, ?)",
            (user_id, charge_id, starts_at, expires_at),
        )
        self.conn.commit()
        return self._trial_by_id(cur.lastrowid)

    def active_trial(self, user_id: int, now: int) -> Trial | None:
        """The trial with the latest expiry that is still running for this user."""
        row = self.conn.execute(
            "SELECT * FROM trials WHERE user_id = ? AND status = 'active' AND expires_at > ? "
            "ORDER BY expires_at DESC LIMIT 1",
            (user_id, now),
        ).fetchone()
        return _trial(row) if row else None

    def due_trials(self, now: int) -> list[Trial]:
        rows = self.conn.execute(
            "SELECT * FROM trials WHERE status = 'active' AND expires_at <= ? ORDER BY expires_at",
            (now,),
        ).fetchall()
        return [_trial(r) for r in rows]

    def set_trial_link(self, trial_id: int, link: str) -> None:
        self.conn.execute("UPDATE trials SET invite_link = ? WHERE id = ?", (link, trial_id))
        self.conn.commit()

    def mark_trial_joined(self, invite_link: str, user_id: int, now: int) -> bool:
        """Mark the trial that owns this invite link as joined. Returns False if the joiner is not the buyer."""
        row = self.conn.execute("SELECT * FROM trials WHERE invite_link = ?", (invite_link,)).fetchone()
        if row is None or row["user_id"] != user_id:
            return False
        self.conn.execute("UPDATE trials SET joined_at = ? WHERE id = ? AND joined_at IS NULL", (now, row["id"]))
        self.conn.commit()
        return True

    def end_trial(self, trial_id: int, status: str, now: int) -> None:
        self.conn.execute("UPDATE trials SET status = ?, ended_at = ? WHERE id = ?", (status, now, trial_id))
        self.conn.commit()

    def _trial_by_id(self, trial_id: int) -> Trial:
        return _trial(self.conn.execute("SELECT * FROM trials WHERE id = ?", (trial_id,)).fetchone())

    # Member events and settings

    def log_member_event(
        self, user_id: int, event: str, invite_link_name: str | None, subscription_until: int | None, now: int
    ) -> None:
        self.conn.execute(
            "INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (user_id, event, invite_link_name, subscription_until, now),
        )
        self.conn.commit()

    def get_setting(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, value),
        )
        self.conn.commit()

    def delete_settings_with_prefix(self, prefix: str) -> int:
        cur = self.conn.execute("DELETE FROM settings WHERE key LIKE ?", (prefix + "%",))
        self.conn.commit()
        return cur.rowcount


def _trial(row: sqlite3.Row) -> Trial:
    return Trial(
        id=row["id"],
        user_id=row["user_id"],
        charge_id=row["charge_id"],
        starts_at=row["starts_at"],
        expires_at=row["expires_at"],
        invite_link=row["invite_link"],
        joined_at=row["joined_at"],
        status=row["status"],
    )
