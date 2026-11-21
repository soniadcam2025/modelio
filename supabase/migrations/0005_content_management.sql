-- Same as cloudflare/migrations/0006_content_management.sql.
alter table shakhira.content_items add column if not exists protect_content integer not null default 0;
alter table shakhira.content_items add column if not exists repeat_json text not null default '';
alter table shakhira.content_items add column if not exists series_id bigint;
alter table shakhira.content_items add column if not exists occurrence_key text;
create unique index if not exists content_occurrence on shakhira.content_items (occurrence_key);
alter table shakhira.content_items add column if not exists last_preview_at bigint;
