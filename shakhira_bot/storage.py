"""SQLite storage for payments, trials, invite links, pending unbans and bot settings."""

import os
import sqlite3
from dataclasses import dataclass

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
    -- "status" (accepted / rejected) is added by _migrate() so older databases get it too
);

CREATE TABLE IF NOT EXISTS trials (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    charge_id TEXT NOT NULL UNIQUE REFERENCES payments (telegram_payment_charge_id),
    starts_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    invite_link TEXT,          -- the most recent link; every link ever issued is in trial_links
    joined_at INTEGER,
    status TEXT NOT NULL DEFAULT 'active',  -- active, ended, converted
    ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS trials_user ON trials (user_id);
CREATE INDEX IF NOT EXISTS trials_due ON trials (status, expires_at);

-- Every trial invite link the bot has created, so old links can be revoked and recognised.
CREATE TABLE IF NOT EXISTS trial_links (
    id INTEGER PRIMARY KEY,
    trial_id INTEGER NOT NULL REFERENCES trials (id),
    user_id INTEGER NOT NULL,
    invite_link TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS trial_links_trial ON trial_links (trial_id);

-- Members who were banned to remove them but whose unban did not go through yet.
CREATE TABLE IF NOT EXISTS pending_unbans (
    user_id INTEGER PRIMARY KEY,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

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

ACCEPTED = "accepted"
REJECTED = "rejected"


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


@dataclass(frozen=True)
class TrialLink:
    trial_id: int
    user_id: int
    invite_link: str
    created_at: int
    expires_at: int | None
    revoked_at: int | None


@dataclass(frozen=True)
class Payment:
    charge_id: str
    user_id: int
    plan: str
    amount: int
    currency: str
    payload: str
    created_at: int
    status: str | None  # None for rows saved before the status column existed


class Storage:
    def __init__(self, path: str):
        if path != ":memory:":
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self.conn = sqlite3.connect(path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self) -> None:
        columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(payments)")}
        if "status" not in columns:
            self.conn.execute("ALTER TABLE payments ADD COLUMN status TEXT")
        # Links saved by older versions only in trials.invite_link.
        self.conn.execute(
            "INSERT OR IGNORE INTO trial_links (trial_id, user_id, invite_link, created_at) "
            "SELECT id, user_id, invite_link, starts_at FROM trials WHERE invite_link IS NOT NULL"
        )

    def close(self) -> None:
        self.conn.close()

    # Payments

    def record_payment(
        self, charge_id: str, user_id: int, plan: str, amount: int, currency: str, payload: str, now: int,
        status: str | None = None,
    ) -> bool:
        """Save a payment. Returns False if this charge ID was already recorded (duplicate update)."""
        with self.conn:
            return self._insert_payment(charge_id, user_id, plan, amount, currency, payload, now, status)

    def _insert_payment(self, charge_id, user_id, plan, amount, currency, payload, now, status) -> bool:
        cur = self.conn.execute(
            "INSERT OR IGNORE INTO payments "
            "(telegram_payment_charge_id, user_id, plan, amount, currency, payload, created_at, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (charge_id, user_id, plan, amount, currency, payload, now, status),
        )
        return cur.rowcount == 1

    def record_trial_payment(
        self, charge_id: str, user_id: int, plan: str, amount: int, currency: str, payload: str, now: int,
        accepted: bool, trial_seconds: int,
    ) -> tuple[bool, Trial | None]:
        """Save a payment and, if it was accepted, its trial, in ONE transaction.

        A crash can never leave a paid, accepted payment without its trial (or the reverse).
        Returns (is_new, trial). For a duplicate charge ID nothing changes and is_new is False.
        """
        with self.conn:
            is_new = self._insert_payment(
                charge_id, user_id, plan, amount, currency, payload, now, ACCEPTED if accepted else REJECTED
            )
            if not is_new or not accepted:
                return is_new, None
            trial_id = self._insert_trial(user_id, charge_id, now, trial_seconds)
        return True, self._trial_by_id(trial_id)

    def payment(self, charge_id: str) -> Payment | None:
        row = self.conn.execute("SELECT * FROM payments WHERE telegram_payment_charge_id = ?", (charge_id,)).fetchone()
        return _payment(row) if row else None

    def trial_payments_without_trial(self) -> list[Payment]:
        """Trial payments that were not rejected but have no trial (possible only for pre-upgrade data)."""
        rows = self.conn.execute(
            "SELECT p.* FROM payments p LEFT JOIN trials t ON t.charge_id = p.telegram_payment_charge_id "
            "WHERE p.plan = 'trial' AND t.id IS NULL AND (p.status IS NULL OR p.status = ?) ORDER BY p.id",
            (ACCEPTED,),
        ).fetchall()
        return [_payment(r) for r in rows]

    def set_payment_status(self, charge_id: str, status: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE payments SET status = ? WHERE telegram_payment_charge_id = ?", (status, charge_id))

    # Trials

    def has_used_trial(self, user_id: int) -> bool:
        row = self.conn.execute("SELECT 1 FROM trials WHERE user_id = ? LIMIT 1", (user_id,)).fetchone()
        return row is not None

    def create_trial(self, user_id: int, charge_id: str, starts_at: int, expires_at: int) -> Trial:
        with self.conn:
            cur = self.conn.execute(
                "INSERT INTO trials (user_id, charge_id, starts_at, expires_at) VALUES (?, ?, ?, ?)",
                (user_id, charge_id, starts_at, expires_at),
            )
        return self._trial_by_id(cur.lastrowid)

    def create_trial_for_payment(self, payment: Payment, now: int, trial_seconds: int) -> Trial | None:
        """Create the missing trial for an accepted payment. Returns None if one already exists."""
        with self.conn:
            if self.conn.execute("SELECT 1 FROM trials WHERE charge_id = ?", (payment.charge_id,)).fetchone():
                return None
            self.conn.execute(
                "UPDATE payments SET status = ? WHERE telegram_payment_charge_id = ?", (ACCEPTED, payment.charge_id)
            )
            trial_id = self._insert_trial(payment.user_id, payment.charge_id, now, trial_seconds)
        return self._trial_by_id(trial_id)

    def _insert_trial(self, user_id: int, charge_id: str, now: int, trial_seconds: int) -> int:
        """Insert a trial that starts now, or right after the user's current trial. Caller commits."""
        row = self.conn.execute(
            "SELECT MAX(expires_at) AS until FROM trials WHERE user_id = ? AND status = 'active' AND expires_at > ?",
            (user_id, now),
        ).fetchone()
        starts_at = max(now, row["until"] or 0)
        cur = self.conn.execute(
            "INSERT INTO trials (user_id, charge_id, starts_at, expires_at) VALUES (?, ?, ?, ?)",
            (user_id, charge_id, starts_at, starts_at + trial_seconds),
        )
        return cur.lastrowid

    def trial_for_charge(self, charge_id: str) -> Trial | None:
        row = self.conn.execute("SELECT * FROM trials WHERE charge_id = ?", (charge_id,)).fetchone()
        return _trial(row) if row else None

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
        """Record a link for a trial (kept for older callers; prefer add_trial_link)."""
        trial = self._trial_by_id(trial_id)
        self.add_trial_link(trial, link, trial.starts_at, None)

    def mark_trial_joined(self, invite_link: str, user_id: int, now: int) -> bool:
        """Mark the trial that owns this invite link as joined. Returns False if the joiner is not the buyer."""
        trial = self.trial_for_link(invite_link)
        if trial is None or trial.user_id != user_id:
            return False
        with self.conn:
            self.conn.execute("UPDATE trials SET joined_at = ? WHERE id = ? AND joined_at IS NULL", (now, trial.id))
        return True

    def end_trial(self, trial_id: int, status: str, now: int) -> None:
        with self.conn:
            self.conn.execute("UPDATE trials SET status = ?, ended_at = ? WHERE id = ?", (status, now, trial_id))

    def _trial_by_id(self, trial_id: int) -> Trial:
        return _trial(self.conn.execute("SELECT * FROM trials WHERE id = ?", (trial_id,)).fetchone())

    # Trial invite links

    def add_trial_link(self, trial: Trial, link: str, now: int, expires_at: int | None) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT OR IGNORE INTO trial_links (trial_id, user_id, invite_link, created_at, expires_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (trial.id, trial.user_id, link, now, expires_at),
            )
            self.conn.execute("UPDATE trials SET invite_link = ? WHERE id = ?", (link, trial.id))

    def trial_link_count(self, trial_id: int) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM trial_links WHERE trial_id = ?", (trial_id,)).fetchone()[0]

    def unrevoked_trial_links(self, trial_id: int) -> list[TrialLink]:
        rows = self.conn.execute(
            "SELECT * FROM trial_links WHERE trial_id = ? AND revoked_at IS NULL ORDER BY id", (trial_id,)
        ).fetchall()
        return [_link(r) for r in rows]

    def mark_link_revoked(self, link: str, now: int) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE trial_links SET revoked_at = ? WHERE invite_link = ? AND revoked_at IS NULL", (now, link)
            )

    def trial_for_link(self, link: str) -> Trial | None:
        row = self.conn.execute(
            "SELECT t.* FROM trials t JOIN trial_links l ON l.trial_id = t.id WHERE l.invite_link = ?", (link,)
        ).fetchone()
        return _trial(row) if row else None

    # Pending unbans

    def add_pending_unban(self, user_id: int, now: int) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO pending_unbans (user_id, attempts, created_at, updated_at) VALUES (?, 1, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at",
                (user_id, now, now),
            )

    def pending_unbans(self) -> list[tuple[int, int]]:
        """(user_id, failed attempts so far) for every member still waiting to be unbanned."""
        rows = self.conn.execute("SELECT user_id, attempts FROM pending_unbans ORDER BY created_at").fetchall()
        return [(r["user_id"], r["attempts"]) for r in rows]

    def clear_pending_unban(self, user_id: int) -> None:
        with self.conn:
            self.conn.execute("DELETE FROM pending_unbans WHERE user_id = ?", (user_id,))

    # Member events and settings

    def log_member_event(
        self, user_id: int, event: str, invite_link_name: str | None, subscription_until: int | None, now: int
    ) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (user_id, event, invite_link_name, subscription_until, now),
            )

    def get_setting(self, key: str) -> str | None:
        row = self.conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def delete_settings_with_prefix(self, prefix: str) -> int:
        with self.conn:
            cur = self.conn.execute("DELETE FROM settings WHERE key LIKE ?", (prefix + "%",))
        return cur.rowcount

    # Backup

    def backup_to(self, path: str) -> None:
        """Copy the live database to `path` with SQLite's online backup API (safe while the bot runs)."""
        dest = sqlite3.connect(path)
        try:
            with dest:
                self.conn.backup(dest)
            result = dest.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            dest.close()
        if result != "ok":
            raise sqlite3.DatabaseError(f"backup integrity check failed: {result}")


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


def _link(row: sqlite3.Row) -> TrialLink:
    return TrialLink(
        trial_id=row["trial_id"],
        user_id=row["user_id"],
        invite_link=row["invite_link"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        revoked_at=row["revoked_at"],
    )


def _payment(row: sqlite3.Row) -> Payment:
    return Payment(
        charge_id=row["telegram_payment_charge_id"],
        user_id=row["user_id"],
        plan=row["plan"],
        amount=row["amount"],
        currency=row["currency"],
        payload=row["payload"],
        created_at=row["created_at"],
        status=row["status"],
    )
