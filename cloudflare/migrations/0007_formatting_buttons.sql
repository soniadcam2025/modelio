-- Formatted text (Telegram HTML: bold, italic, links…) and several inline buttons per post.
ALTER TABLE content_items ADD COLUMN parse_mode TEXT NOT NULL DEFAULT '';
ALTER TABLE content_items ADD COLUMN buttons_json TEXT NOT NULL DEFAULT '';
