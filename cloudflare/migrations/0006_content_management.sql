-- Content management: protected content, recurring series (one row per occurrence; the unique key stops a series
-- from ever creating the same occurrence twice), and preview/publish bookkeeping.
ALTER TABLE content_items ADD COLUMN protect_content INTEGER NOT NULL DEFAULT 0;
ALTER TABLE content_items ADD COLUMN repeat_json TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN series_id INTEGER;
ALTER TABLE content_items ADD COLUMN occurrence_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS content_occurrence ON content_items (occurrence_key);
ALTER TABLE content_items ADD COLUMN last_preview_at INTEGER;
