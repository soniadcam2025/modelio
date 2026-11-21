# Shakhira dashboard on Vercel + Supabase (staging)

**Dashboard:** https://shakhira-admin-staging.vercel.app

**Status:** staging, with simulated Telegram.
- No bot token is configured, so nothing is ever sent.
- The live bot `shakhira-vip-bot` and its D1 `shakhira-vip` are not connected and were not changed.

## How it fits together

```
browser ──► Vercel (bom1, Mumbai)  ── one Node function for /api/*, plus the static dashboard
               │  service-role key (server only)
               ▼
            Supabase (ap-south-1): Postgres schema `shakhira` + Supabase Auth
               ▲
Cloudflare Worker shakhira-admin-staging ── cron every minute ── signed POST /api/internal/cycle
```

### Request path
- **API code:** the API is `cloudflare/src/index.js`, the same code the Worker runs. Vercel bundles it through `vercel/entry.mjs`.
- **Database choice:** `getDB(env)` uses Supabase when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set; otherwise it uses the Worker's D1 binding.
- **Query path:** every query goes through one RPC, `public.shakhira_exec`.
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

### Scheduler
- The Worker cron sends `HMAC(CYCLE_SECRET, "cycle:<time>")`, valid for 2 minutes.
- Each cycle claims rows before sending, so a second request never posts twice.

## Settings (names only; values live in Vercel, Cloudflare and Supabase, never in git)

| Where | Name | |
|---|---|---|
| Vercel (Production env) | `ENVIRONMENT=staging`, `REQUIRE_PREVIEW=true`, `AUTH_MODE=supabase`, `SUPABASE_URL`, `PUBLIC_CHANNEL`, `BOT_USERNAME`, `POST_SLOTS_UTC` | plain |
| Vercel | `SUPABASE_SECRET_KEY`, `DASHBOARD_SECRET`, `CYCLE_SECRET` | sensitive |
| Cloudflare `shakhira-admin-staging` | `CYCLE_URL` (wrangler.toml), `CYCLE_SECRET` (secret) | |

`BOT_TOKEN` is deliberately **not** set anywhere in staging.

## Deploy

```bash
cd vercel && npm ci && npm run build && npx vercel deploy --prebuilt --prod
```

Database changes are SQL files in `supabase/migrations/`, applied in order with the Supabase SQL editor or the Management API.

## Admin accounts

Create one in Supabase → Authentication → Users → Add user (auto-confirm). Then run this in the SQL editor:

```sql
update auth.users set raw_app_meta_data = raw_app_meta_data || '{"shakhira_admin": true}' where email = 'you@example.com';
```

To remove access, delete the user or set the flag to false.
- Existing sessions end within 12 hours.
- To end them at once, rotate `DASHBOARD_SECRET` in Vercel and redeploy.

## Backups and recovery

- **Download:** Features & settings → *Backups & monitoring* → **Download backup (JSON)**, or `GET /api/backup` while signed in.
  - Contains every dashboard table.
  - Each download is recorded in the activity log.
- **Free-plan limit:** Supabase Free has no downloadable automatic backups. Download one weekly and before every change.
- **Restore:**
  1. Create the schema from `supabase/migrations/`.
  2. Insert the JSON rows, for example with a small script that reuses `supabase/tools/migrate-d1-staging.mjs`'s insert builder.
- **D1 copy:** the staging D1 `shakhira-staging` still holds the earlier staging data. `supabase/tools/migrate-d1-staging.mjs` copies it (idempotent, staging only).

## Monitoring

- **Health:** `GET /api/health` (no sign-in) returns:
  - `ok`
  - `database.{kind, ok, ms}`
  - `scheduler_last_seen`
  - the `auth` and `automation` modes
- **Status codes:** 503 when the database is unreachable.
- **Dashboard:** *Backups & monitoring* shows the same; the scheduler is flagged if it has not run for 5 minutes.
- **Logs:** Vercel → Project → Logs (function errors), and Cloudflare → Worker → Logs (cron hand-off status).

## Rollback

| What | How |
|---|---|
| Dashboard release | Vercel → Deployments → previous → *Promote to Production* (instant) |
| Scheduler back to D1 | remove `CYCLE_URL` from `cloudflare/wrangler.toml`, redeploy the staging Worker |
| Stop the scheduler entirely | Cloudflare → `shakhira-admin-staging` → Triggers → remove the cron |
| Data | restore from the latest JSON backup |

## Costs (free plans)

**Supabase Free**
- Limits: 500 MB database, 50k monthly users.
- The project pauses after 7 days without requests; the per-minute cron prevents that.

**Vercel Hobby**
- Limits: 100 GB-hours of functions and 100 GB of transfer.
- **Hobby is for non-commercial use only.** Before taking paid subscribers through this dashboard, either move to Vercel Pro (US$20/month) or serve the same code from the Cloudflare Worker (free), which already works.

**Cloudflare Workers Free**
- Limits: 100k requests/day.
- The cron uses about 1,440 requests/day.
