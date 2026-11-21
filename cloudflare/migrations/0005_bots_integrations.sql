-- Bots and integrations. Tokens and API secrets are stored ENCRYPTED (AES-GCM) with a key that exists only as a
-- Worker secret (CREDENTIALS_KEY); this database never holds the key or a plaintext credential.
CREATE TABLE IF NOT EXISTS bots (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_user_id INTEGER NOT NULL UNIQUE, username TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', token_cipher TEXT NOT NULL DEFAULT '', token_hint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', is_primary INTEGER NOT NULL DEFAULT 0, automation_enabled INTEGER NOT NULL DEFAULT 0,
  permissions_json TEXT NOT NULL DEFAULT '{}', webhook_json TEXT NOT NULL DEFAULT '{}', last_check_at INTEGER, last_check_ok INTEGER,
  last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
-- A channel belongs to at most one bot, so one bot can never post to another bot's channel.
CREATE TABLE IF NOT EXISTS bot_channels (id INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, chat_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'channel', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS integration_secrets (name TEXT PRIMARY KEY, cipher TEXT NOT NULL, hint_json TEXT NOT NULL DEFAULT '{}',
  last_check_at INTEGER, last_check_ok INTEGER, last_error TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);
ALTER TABLE content_items ADD COLUMN bot_id INTEGER;
ALTER TABLE audit_log ADD COLUMN bot_id INTEGER;
CREATE INDEX IF NOT EXISTS audit_bot ON audit_log (bot_id, id);
