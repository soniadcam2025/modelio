# Shakhira platform database: Supabase

**Production:** the Cloudflare Worker `shakhira-admin` uses the Supabase project `shakhira-prod` (Mumbai) for its data and for sign-in (Supabase Auth).

**Staging:** the Worker `shakhira-admin-staging` uses `shakhira-staging`. The older Vercel staging deployment (https://shakhira-admin-staging.vercel.app) uses the same staging project and is kept only for comparison until launch.

Launch steps, monitoring, backups and rollback are in `cloudflare/PRODUCTION_PLAN.md`; this file covers the database.

## How it fits together

```
browser ──► Cloudflare Worker (dashboard + API + per-minute cron), Smart Placement near Mumbai
               │  secret key (server only)          │ BACKUP_DB (daily copy, 14 days)
               ▼                                     ▼
            Supabase: schema `shakhira` + Auth     Cloudflare D1 `shakhira-backups`
live bot shakhira-vip-bot ──(after approval L8: signed copy of each update)──► /internal/update
live bot D1 shakhira-vip ──(after approval L4: read-only member sync)──► Subscribers
```

### Query path
- **One gateway:** every query goes through one RPC, `public.shakhira_exec`.
  - It runs as the role `shakhira_app`, which can reach only the `shakhira` schema (not `auth` or `storage`).
  - It can be called only with the secret key; the `anon` and `authenticated` roles have no access.
- **Row-level security:** RLS is on for every table, with no policies. The schema is not exposed by the REST API.
- **Value quoting:** values are quoted as SQL literals in `cloudflare/src/pg.js` (quotes doubled, NUL refused), and this is tested.

### Sign-in
- Email and password go through Supabase Auth.
- The account must have `app_metadata.shakhira_admin = true`. Only the secret key can set this, so a user cannot grant it to themselves.
- Public sign-up is disabled and passwords must be at least 12 characters.
- After sign-in, the dashboard issues its own signed session cookie: HttpOnly, Secure, SameSite=Strict, valid 12 hours, plus a CSRF token.
- Failed sign-ins are rate-limited: 5 per address and 20 overall per 15 minutes.

### Migrations
Apply in order: `0001` (schema), `0002` (least-privilege gateway), `0003` (live sync and forwarded updates). Both projects are at `0003`.

## Settings (names only; values live in Vercel, Cloudflare and Supabase, never in git)

| Where | Name | |
|---|---|---|
| Vercel staging (Production env) | `ENVIRONMENT=staging`, `REQUIRE_PREVIEW=true`, `AUTH_MODE=supabase`, `SUPABASE_URL`, `PUBLIC_CHANNEL`, `BOT_USERNAME`, `POST_SLOTS_UTC` | plain |
| Vercel | `SUPABASE_SECRET_KEY`, `DASHBOARD_SECRET`, `CYCLE_SECRET` | sensitive |
| Cloudflare `shakhira-admin` and `shakhira-admin-staging` | `SUPABASE_URL`, `AUTH_MODE` (wrangler files) | plain |
| Cloudflare Workers | `SUPABASE_SECRET_KEY`, `DASHBOARD_SECRET`, `UPDATE_SECRET` | secrets |

`BOT_TOKEN` is deliberately **not** set anywhere yet (launch approval L2).

## Deploy

```bash
cd cloudflare && npm ci && npm test && npm run deploy:production   # Worker shakhira-admin
cd cloudflare && npm run deploy:staging                             # Worker shakhira-admin-staging
cd vercel && npm ci && npm run build && npx vercel deploy --prebuilt --prod   # old staging (until L9)
```

Database changes are SQL files in `supabase/migrations/`, applied in order with the Supabase SQL editor or the Management API.

## Admin accounts

Create one in Supabase → Authentication → Users → Add user (auto-confirm). Then run this in the SQL editor:

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"shakhira_admin": true}' where email = 'you@example.com';
```

To remove access, delete the user or set the flag to false.
- Existing sessions end within 12 hours.
- To end them at once, rotate `DASHBOARD_SECRET` on the Worker (`wrangler secret put DASHBOARD_SECRET -c wrangler.production.toml`).

## Backups, monitoring and rollback

These are in `cloudflare/PRODUCTION_PLAN.md`:
- daily D1 backups and **Back up now**
- `supabase/tools/restore-backup.mjs`, with a restore drill done on staging
- the `/api/health` endpoint and the GitHub health-check workflow
- Worker rollback

`supabase/tools/migrate-d1-staging.mjs` copied the earlier staging data from D1 `shakhira-staging` into `shakhira-staging` once (idempotent, staging only).

## Costs (free plans)

**Supabase Free**
- Two projects: production and staging.
- Limits: 500 MB database each, 50k monthly users.
- A project pauses after 7 days without requests; the per-minute cron prevents that.

**Cloudflare Workers Free**
- Limits: 100k requests/day, 5 crons (3 used), 10 D1 databases (5 used).
- Commercial use is allowed.

**Vercel Hobby (old staging only)**
- Non-commercial use only, so it is not used for production.
- Delete it after launch (approval L9).
