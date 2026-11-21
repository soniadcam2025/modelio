-- STAGING ONLY: the live bot's table layout (from shakhira-vip's sqlite_master) with made-up people,
-- so member sync, reminders and subscriber views can be tested without reading any real subscriber.
CREATE TABLE IF NOT EXISTS members (chat_id TEXT, user_id INTEGER, status TEXT, until_date INTEGER, checked_at INTEGER, PRIMARY KEY(chat_id,user_id));
CREATE TABLE IF NOT EXISTS events (update_id INTEGER PRIMARY KEY, chat_id TEXT, user_id INTEGER, status TEXT, until_date INTEGER, event_date INTEGER);
CREATE TABLE IF NOT EXISTS processed (update_id INTEGER PRIMARY KEY, processed_at INTEGER);
CREATE TABLE IF NOT EXISTS trial_access (user_id INTEGER PRIMARY KEY, expires_at INTEGER NOT NULL, active INTEGER NOT NULL, payment_charge_id TEXT UNIQUE NOT NULL, updated_at INTEGER NOT NULL);
INSERT OR IGNORE INTO members VALUES ('-1009999999999', 900000001, 'member', unixepoch() + 2*86400, unixepoch() - 600);
INSERT OR IGNORE INTO members VALUES ('-1009999999999', 900000002, 'member', unixepoch() + 25*86400, unixepoch() - 500);
INSERT OR IGNORE INTO members VALUES ('-1009999999999', 900000003, 'left', NULL, unixepoch() - 400);
INSERT OR IGNORE INTO events VALUES (1, '-1009999999999', 900000001, 'member', unixepoch() + 2*86400, unixepoch() - 28*86400);
INSERT OR IGNORE INTO events VALUES (2, '-1009999999999', 900000003, 'left', NULL, unixepoch() - 400);
INSERT OR IGNORE INTO trial_access VALUES (900000004, unixepoch() + 20*3600, 1, 'sim_trial_charge_4', unixepoch() - 52*3600);
