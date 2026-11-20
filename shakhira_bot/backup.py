"""Consistent SQLite backups that are safe to take while the bot is running.

Each backup is written to a temporary file with SQLite's online backup API, checked with
PRAGMA integrity_check, then renamed into place, so a half-written file never looks like a backup.
Only the newest `keep` backups are kept. Copy the backup folder off the server too (see README).
"""

import logging
import os
import re
from datetime import datetime, timezone

from .storage import Storage

logger = logging.getLogger(__name__)

PREFIX = "shakhira_bot-"
NAME_RE = re.compile(r"^shakhira_bot-\d{8}-\d{6}\.db$")


def backup_name(now: float) -> str:
    return f"{PREFIX}{datetime.fromtimestamp(now, tz=timezone.utc).strftime('%Y%m%d-%H%M%S')}.db"


def make_backup(store: Storage, backup_dir: str, keep: int, now: float) -> str:
    """Write a new backup and prune old ones. Returns the backup's path."""
    os.makedirs(backup_dir, mode=0o700, exist_ok=True)
    final = os.path.join(backup_dir, backup_name(now))
    tmp = final + ".partial"
    try:
        store.backup_to(tmp)
        os.chmod(tmp, 0o600)  # subscriber records: owner-only
        os.replace(tmp, final)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    prune(backup_dir, keep)
    logger.info("Database backup written: %s", final)
    return final


def list_backups(backup_dir: str) -> list[str]:
    if not os.path.isdir(backup_dir):
        return []
    return sorted(os.path.join(backup_dir, n) for n in os.listdir(backup_dir) if NAME_RE.match(n))


def prune(backup_dir: str, keep: int) -> list[str]:
    """Delete all but the newest `keep` backups. Only files named like our backups are touched."""
    backups = list_backups(backup_dir)
    removed = backups[:-keep] if keep > 0 else []
    for path in removed:
        os.remove(path)
    return removed
