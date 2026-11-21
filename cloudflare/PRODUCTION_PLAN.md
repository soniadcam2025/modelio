# Shakhira platform: production plan and launch approvals

## Architecture (one production system)

| Part | Production | Staging (for testing and comparison) |
|---|---|---|
| Dashboard, API, automation | Cloudflare Worker `shakhira-admin` (`wrangler.production.toml`) | Worker `shakhira-admin-staging` (`wrangler.toml`) |
| Database and sign-in | Supabase `shakhira-prod` (Mumbai), Supabase Auth | Supabase `shakhira-staging` |
| Daily backups (14 days) | D1 `shakhira-backups` | D1 `shakhira-backups-staging` |
| Live VIP bot data | D1 `shakhira-vip` (read-only link, **not linked yet**) | D1 `shakhira-vip-sim` (made-up people) |
| Media | Cloudinary (read-only listing) | same |
| Free-channel posts at 5 AM and 10 PM IST | GitHub Actions `post-to-channel.yml` (unchanged) | n/a |
| Previous staging | Vercel `shakhira-admin-staging` (kept for comparison; delete after launch) | n/a |

There is still exactly **one Telegram webhook receiver**: the live bot `shakhira-vip-bot`, which is unchanged. The dashboard Worker only sends.

### Production now (21 Nov 2026)
- **Status:** the production Worker is deployed and in **read-only mode**.
- **Live bot data (L4 done):** the live bot's database `shakhira-vip` is linked **read-only** and **member_sync** is on, so the real members, trials and trial payments show in Subscribers and Overview.
  - Before linking, a D1 Time Travel restore point was recorded and a dashboard backup taken.
  - The dashboard's counts were checked against the live database: 2 member rows (1 active monthly) and 0 trials.
- **Everything else is off:**
  - No bot token, so automation is simulated.
  - `REQUIRE_PREVIEW` is on.
  - Every other feature is off, so no posting, payment change or member action can happen.
- **VIP channel ID:** a secret, copied from the live bot's own setting.

### Free-plan use

| Service | Used | Limit |
|---|---|---|
| Workers | 3 | 100 |
| Cron triggers | 3 | 5 |
| D1 databases | 5 | 10 |
| Worker requests per day | about 3,000 | 100,000 |
| Supabase projects | 2 | 2 |

- **Supabase limits:** 500 MB database each. Free projects pause after 7 days without requests; the per-minute cron prevents that.
- **Per-run budget:** each page and each cron run stays under Workers Free's limit of 50 outbound requests. `test/integration.test.mjs` checks this; the largest is 28 database + 8 Telegram calls.

## Launch approvals (in order; each is reversible)

| # | Approval | Owner | What changes | Undo |
|---|---|---|---|---|
| **L1** | Your admin account | you | Sign in at the production URL with the generated login, then in Supabase `shakhira-prod` → Authentication → Users, change the email to yours and set a new password. | n/a |
| **L2a** | Bot & channel status (read-only) | you | Add the secret `BOT_TOKEN` (same token as the live bot) to `shakhira-admin`. With `REQUIRE_PREVIEW` on and no preview chat, the Worker is **locked**: it sends nothing. The Overview's *Bot & channels* card then shows the bot, webhook health, and both channels' titles and member counts, using only read-only `get*` calls. Member sync and backups continue. | Delete the secret. |
| **L2** | Private Telegram preview | you, then Claude | You send `/start` to @ShakhiraVIPBot and get your user ID (@userinfobot). On **both** dashboard Workers, add the secret `BOT_TOKEN` (same token as the live bot). Claude sets `PREVIEW_CHAT_ID` = your ID and redeploys, then runs `test/remote/staging-preview.mjs`: 8 test posts (text, photo, video, GIF, poll, quiz, VIP promo, paid media at 1 ⭐) arrive **only in your private chat**. | Delete `BOT_TOKEN`. |
| **L3** | Cloudinary media library | you | Add `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` as secrets on the Workers. A read-only key is best; the Worker never tags or deletes. | Delete the secrets. |
| **L4 ✅ done** | Real subscribers in the dashboard (read-only) | Claude | Uncomment `LIVE_DB` in `wrangler.production.toml`, deploy, switch on **member_sync**. Members, trials and 49 ⭐ trial payments appear in Subscribers. Monthly 499 ⭐ payments are made through Telegram channel subscriptions, which no bot can see; members show as *monthly* with their renewal date. The code can only run SELECT on that database. | Switch off, re-comment, deploy. |
| **L5** | Channel publishing from the dashboard | Claude | `REQUIRE_PREVIEW = "false"`, `VIP_CHANNEL_ID` = the real VIP channel ID, `ADMIN_CHAT_ID` = your ID (for alerts), deploy. Switch on **scheduled_posts**. Verify one text post at a quiet time, then delete it. Never posts the Cloudinary media of the GitHub poster, so no duplicates. | Switch the feature off (within 1 minute). |
| **L6** | Paid media, polls, promotions, expiry, automated paid media | you | Switch on one feature at a time: **poll_auto_close**, **post_expiry**, **auto_paid_media**. Automated paid media uses its own Cloudinary folder (never `tgpub`) and is claimed per slot, so it can't double-post. | Switch off. |
| **L7** | Member notifications | you | **trial_reminders** (24 h before a trial ends), **renewal_reminders** (3 days before Telegram renews 499 ⭐), and **admin_actions** (approve, decline, remove, unban, DM from the dashboard). Each reminder is sent once (recorded before sending). | Switch off. |
| **L8** | Join requests, moderation, reactions | Claude | Change the live bot, following `LIVE_BOT_INTEGRATION.md`: about 15 lines plus a service binding. Then switch on **join_requests**, **moderation** and **reaction_tracking**. | Roll back the bot version in Cloudflare. |
| **L9** | Retire Vercel staging | Claude | Delete the Vercel project once the production Worker has run for a week. | Redeploy from `vercel/` in one command. |

## Monitoring

- **Health endpoint:** `GET /api/health` returns:
  - database status and latency
  - when the scheduler last ran
  - when the last backup ran
  - when the last member sync ran
  - HTTP 503 if the database is down
- **Dashboard view:** Features & settings → *Backups & monitoring* shows the same.
- **GitHub email alerts:** `.github/workflows/health-check.yml` runs every 30 minutes; a failure sends GitHub's failure email. To turn it on, add the repository secret `HEALTH_URLS` with the two Worker URLs separated by a space. It's a secret because the repository is public.
- **Telegram alerts:** after L5, failed or uncertain posts and failed backups go to `ADMIN_CHAT_ID`, at most one per kind per hour.
- **Logs:** Cloudflare → Worker → Logs (Workers Logs, free).

## Backup and restore

**Backups**
- **Automatic:** daily at 03:10 IST to D1, kept 14 days. One transaction per backup.
- **On demand:** **Back up now** in Features & settings, or **Download backup (JSON)**.

**Restore**

First do a dry run:
```bash
node supabase/tools/restore-backup.mjs --project <ref> --d1 shakhira-backups
```
Then restore for real, which runs as one transaction, rebuilds the id sequences and verifies row counts:
```bash
node supabase/tools/restore-backup.mjs --project <ref> --d1 shakhira-backups --confirm
```
To restore from a downloaded file instead of D1, use `--file backup.json` in place of `--d1 …`.

**Drill done 21 Nov 2026 on staging**
1. Backed up 239 rows.
2. Deleted the captions and 10 posts.
3. Restored.
4. Counts matched.

**What these backups cover:** they cover the dashboard database. The live bot's own D1 (`shakhira-vip`) has Cloudflare D1 Time Travel, which can restore any point in the last 7 days on the free plan (30 on paid); see `wrangler d1 time-travel`.

## Rollback

| What | How |
|---|---|
| Dashboard Worker release | Cloudflare → `shakhira-admin` → Deployments → roll back (instant), or `wrangler rollback -c wrangler.production.toml` |
| A feature | switch it off in Features & settings |
| Database | restore a backup (above) |
| Live bot change (L8) | roll back its version; the webhook stays the same |

## Never changed without your explicit approval
- **Live bot:** `shakhira-vip-bot`'s code, webhook and cron.
- **Its database:** `shakhira-vip`.
- **Channels and money:** channel settings, prices (499 ⭐ / 30 days, 49 ⭐ / 3 days), subscriptions and payments.
- **GitHub poster:** its 5 AM / 10 PM IST schedule and smart rotation.
- **Paid services:** none are activated.
