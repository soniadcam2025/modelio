-- Optional post expiry and automated paid media (both OFF by default).
ALTER TABLE content_items ADD COLUMN expire_after_minutes INTEGER;
ALTER TABLE content_items ADD COLUMN expired_at INTEGER;
ALTER TABLE content_items ADD COLUMN source TEXT NOT NULL DEFAULT '';

-- One row per automation slot, claimed BEFORE anything is created: a slot can never produce two posts.
CREATE TABLE IF NOT EXISTS auto_paid_runs (slot TEXT PRIMARY KEY, public_id TEXT, content_id INTEGER, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
-- Which Cloudinary assets the paid-media automation has used (kept here, never as Cloudinary tags,
-- so the GitHub poster's posting history is never touched).
CREATE TABLE IF NOT EXISTS auto_paid_posted (public_id TEXT PRIMARY KEY, content_id INTEGER, posted_at INTEGER NOT NULL);
