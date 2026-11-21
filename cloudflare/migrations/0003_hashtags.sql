-- Hashtags appended to a post's text or caption when it is published.
ALTER TABLE content_items ADD COLUMN hashtags TEXT NOT NULL DEFAULT '';
