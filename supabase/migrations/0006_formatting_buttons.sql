-- Same as cloudflare/migrations/0007_formatting_buttons.sql.
alter table shakhira.content_items add column if not exists parse_mode text not null default '';
alter table shakhira.content_items add column if not exists buttons_json text not null default '';
