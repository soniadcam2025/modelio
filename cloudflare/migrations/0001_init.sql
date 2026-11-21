-- Shakhira staging database (Cloudflare D1). Mirrors shakhira_bot/storage.py + ops.py.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS content_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL, target TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', media_url TEXT NOT NULL DEFAULT '',
  options_json TEXT NOT NULL DEFAULT '[]', correct_option INTEGER, explanation TEXT NOT NULL DEFAULT '',
  multiple_answers INTEGER NOT NULL DEFAULT 0, close_after_minutes INTEGER, star_count INTEGER,
  button_text TEXT NOT NULL DEFAULT '', button_url TEXT NOT NULL DEFAULT '', use_caption_library INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', sending_since INTEGER, posted_at INTEGER, message_id INTEGER,
  poll_closed_at INTEGER, poll_results_json TEXT, created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS content_due ON content_items (status, scheduled_at);

CREATE TABLE IF NOT EXISTS captions (id INTEGER PRIMARY KEY, text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER);

CREATE TABLE IF NOT EXISTS profiles (user_id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT '',
  first_name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS join_requests (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', requested_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', reason TEXT NOT NULL DEFAULT '', decided_at INTEGER, decided_by TEXT NOT NULL DEFAULT '');

CREATE TABLE IF NOT EXISTS admin_actions (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', error TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, done_at INTEGER);

CREATE TABLE IF NOT EXISTS moderation_rules (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, pattern TEXT NOT NULL,
  action TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS moderation_log (id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  rule_id INTEGER, action TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reaction_counts (chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
  reactions_json TEXT NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (chat_id, message_id));
CREATE TABLE IF NOT EXISTS reminders_sent (key TEXT PRIMARY KEY, sent_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);

-- Subscription records (empty in staging; filled by the full bot in production).
CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY, telegram_payment_charge_id TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL, plan TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, payload TEXT NOT NULL,
  created_at INTEGER NOT NULL, status TEXT);
CREATE TABLE IF NOT EXISTS trials (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, charge_id TEXT NOT NULL UNIQUE,
  starts_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, invite_link TEXT, joined_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active', ended_at INTEGER);
CREATE TABLE IF NOT EXISTS member_events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, event TEXT NOT NULL,
  invite_link_name TEXT, subscription_until INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_unbans (user_id INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- Dashboard security (Workers are stateless, so these live in D1).
CREATE TABLE IF NOT EXISTS revoked_sessions (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_failures (id INTEGER PRIMARY KEY, client TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_failures_client ON login_failures (client, at);
