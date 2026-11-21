-- Read-only mirror of the live bot's members/trials (keyed by their source row) and de-duplication of forwarded updates.
ALTER TABLE member_events ADD COLUMN ext_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS member_events_ext ON member_events (ext_id);
CREATE TABLE IF NOT EXISTS forwarded_updates (update_id INTEGER PRIMARY KEY, received_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS backups_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, kind TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '');
