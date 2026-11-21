-- The gateway runs every statement as a dedicated role that can touch only the shakhira tables,
-- so even a bug in the server's quoting cannot reach auth, storage or other schemas.
-- (Replaces 0001's keyword filter, which also rejected harmless text such as a caption containing "drop".)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'shakhira_app') then
    create role shakhira_app nologin noinherit;
  end if;
end $$;
grant shakhira_app to postgres;
grant usage on schema shakhira to shakhira_app;
grant select, insert, update, delete on all tables in schema shakhira to shakhira_app;
grant usage, select on all sequences in schema shakhira to shakhira_app;
alter default privileges in schema shakhira grant select, insert, update, delete on tables to shakhira_app;
alter default privileges in schema shakhira grant usage, select on sequences to shakhira_app;
-- The role bypasses RLS only on its own schema's tables (no policies exist for anyone else).
alter role shakhira_app bypassrls;

create or replace function public.shakhira_exec(q text, mode text default 'all')
returns jsonb language plpgsql security definer set search_path = shakhira, pg_temp as $$
declare res jsonb;
begin
  if q !~* '^\s*(select|insert|update|delete|with)\s' then raise exception 'statement type not allowed'; end if;
  if mode = 'all' then
    execute format('select coalesce(jsonb_agg(t), ''[]''::jsonb) from (%s) t', q) into res;
  else
    execute format('with t as (%s) select jsonb_build_object(''rows'', coalesce(jsonb_agg(t), ''[]''::jsonb), ''changes'', count(*)) from t', q) into res;
  end if;
  return res;
end $$;
-- Changing the owner needs CREATE on public for a moment; it is taken back straight after.
grant create on schema public to shakhira_app;
alter function public.shakhira_exec(text, text) owner to shakhira_app;
revoke create on schema public from shakhira_app;
revoke all on function public.shakhira_exec(text, text) from public, anon, authenticated;
grant execute on function public.shakhira_exec(text, text) to service_role;
