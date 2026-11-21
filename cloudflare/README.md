# Shakhira admin on Cloudflare (staging)

The admin dashboard and send-only automation, ported to a **separate** Cloudflare Worker
(`shakhira-admin-staging`) with its own D1 database (`shakhira-staging`). The dashboard frontend is
shared with the Python version (`dashboard/static`).

**The live bot Worker (`shakhira-vip-bot`) is never read, changed, redeployed or restarted by anything here.**

## Safety design

| Risk | Protection |
|---|---|
| Taking over the live bot's updates | The Telegram client only allows send-type methods. `getUpdates`, `setWebhook`, `deleteWebhook`, `getWebhookInfo` and `logOut` are impossible (`src/telegram.js`). |
| Posting to the real channels from staging | `REQUIRE_PREVIEW = "true"`. No `BOT_TOKEN` → every send is **simulated** (nothing reaches Telegram). `BOT_TOKEN` and `PREVIEW_CHAT_ID` → only that private chat. `BOT_TOKEN` without `PREVIEW_CHAT_ID` → **locked** (nothing sent). The client also refuses any other chat. |
| Contacting members | In staging, admin actions (DMs, removals, approvals) and reminders never run. |
| Double posting with GitHub Actions | This Worker never posts Cloudinary media. The 5 AM / 10 PM IST auto-posts and smart rotation stay entirely in GitHub Actions; the calendar only *shows* those slots. Each scheduled item is claimed atomically in D1 before it is sent, and never re-sent after an uncertain result. |
| New features switching on by surprise | Every feature flag starts **off**. |
| Dashboard access | Password (PBKDF2-SHA256, 100,000 iterations), HMAC-signed HttpOnly/Secure/SameSite=Strict session, CSRF header on every change, 5 failed logins per 15 min per IP **and** 20 per 15 min account-wide (stops guessing spread over many IPs; the trade-off is that a flood can lock the login for 15 min), revocable sessions in D1, strict CSP, `noindex`. To unlock early: `npx wrangler d1 execute shakhira-staging --remote --command "DELETE FROM login_failures"`. |

## Free-plan fit (audited 20 Nov 2026)

| Resource | Live bot uses | This Worker adds | Free limit |
|---|---|---|---|
| Workers | 1 | 1 | 100 |
| Cron triggers | 1 (every 5 min) | 1 (every minute) | 5 per account |
| Requests/day | ~290 | ~1,440 cron + dashboard use | 100,000 |
| D1 | not used | 1 database, a few MB | 10 databases, 5 GB, 5 M reads and 100 k writes per day |

## Staging status (21 Nov 2026)

- **Deployed:** `shakhira-admin-staging` on the account's workers.dev subdomain, bound to D1 `shakhira-staging` (region ENAM).
- **Automation:** simulated (no `BOT_TOKEN`). The cron runs every minute.
- **Remote tests:** smoke 40/40 (`test/remote/staging-smoke.mjs`), features 14/14 (`test/remote/staging-features.mjs`: paid media, expiry).
- **Private preview:** `test/remote/staging-preview.mjs`, once `BOT_TOKEN` and `PREVIEW_CHAT_ID` are set.
- **Optional features:** automated paid media and post expiry, both off by default. See `PRODUCTION_PLAN.md`.
- **Browsers:** desktop, iPhone 13 and Pixel 7 checked on all 10 pages.
- **Workers Logs:** 0 errors.
- **Not shown here:** the URL and password. This repository is public; the owner has them.
- Cron triggers take about 10–15 minutes to start after the first deploy.
- The dashboard frontend is bundled into the script by `build.mjs`. A separate static-asset upload is not used, because it fails behind proxies that rewrite the Authorization header.

## Deploy staging

The token needs Account → Workers Scripts: Edit and **D1: Edit**.

```bash
cd cloudflare && npm install
export CLOUDFLARE_ACCOUNT_ID=<account id>
npx wrangler d1 create shakhira-staging          # put the printed database_id into wrangler.toml
npx wrangler d1 migrations apply shakhira-staging --remote
npx wrangler d1 execute shakhira-staging --remote --file seed/demo.sql   # example data only
node tools/hash-password.mjs | npx wrangler secret put DASHBOARD_PASSWORD_HASH
openssl rand -base64 48 | npx wrangler secret put DASHBOARD_SECRET
npm run deploy:staging
```

Optional real preview: put your own Telegram user ID in `PREVIEW_CHAT_ID` (wrangler.toml) and run `npx wrangler secret put BOT_TOKEN`. Posts then reach only your private chat with the bot.

## Tests

```bash
npm test                                  # Node tests with a D1 stand-in (no network)
npx wrangler dev --local --test-scheduled # real Workers runtime + local D1; /__scheduled runs the cron
```

## Rollback

Staging is self-contained; removing it changes nothing else:

```bash
npx wrangler delete shakhira-admin-staging     # removes the Worker and its cron trigger
npx wrangler d1 delete shakhira-staging        # removes the staging database
```

To pause automation without deleting anything, switch the features off in the dashboard, or remove `[triggers]` from wrangler.toml and deploy again.
