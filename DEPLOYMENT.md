# Deployment, backups and rollback

Nothing in this repository has been deployed by Claude. Every step below needs the owner's explicit
approval. No new bots, channels, groups or discussion groups are created anywhere: only
`@ShakhiraVIPBot`, `@yourshakhira` and the existing private VIP channel are used.

## 1. What runs where

| Component | Receives Telegram updates? | Safe next to the live bot? | Status |
|---|---|---|---|
| Channel poster (`poster/`, GitHub Actions) | No, sends only | Yes (running since 23 Oct) | **Live** |
| Send-only worker (`python -m shakhira_bot --worker`) | No, sends only; `getUpdates` and webhook calls are blocked in code | Yes, same pattern as the poster | Built and tested, **not deployed** |
| Admin dashboard (`python -m dashboard serve`) | Holds **no** bot token | Yes | Built and tested, **not deployed** |
| Full bot (`python -m shakhira_bot`) | **Yes** | **No.** Only one program can receive a token's updates. It refuses to start while a webhook is set. | Built and tested, **must not run** until the live bot is retired |

## 2. Feature matrix

| Feature | Where it lives | Runs in | Telegram support and limits |
|---|---|---|---|
| Automated media posting | `poster/` | GitHub Actions (live) | Supported. 5 AM / 10 PM IST from Cloudinary `tgpub`. |
| Automated text, media, poll, quiz posts to either channel | Dashboard → `content_items` → `scheduler.publish_due` | Worker | Supported. Media by https link: photos ≤ 5 MB, other files ≤ 20 MB (Telegram's limits for URLs). |
| Smart content rotation | Poster `runner.py`; caption library rotation (worker) | Poster / worker | Supported:<br>• new media always first<br>• then the asset posted longest ago, after a `REUSE_COOLDOWN_DAYS` (30) cooldown<br>• posting time saved per asset (`tgbot_at_`)<br>• history tags never removed<br>• nothing qualifies → skip and alert<br>Optional `POST_SELECTION=smart`: priority tag `tgpriority`, then a different media type than the last post. |
| Captions | Asset caption → `POST_CAPTIONS` pool (with `{date}`, `{weekday}`, `{channel}`) → `POST_CAPTION`; `POST_FOOTER`; dashboard caption library | Poster / worker | Supported. 1,024-character limit enforced. |
| Polls and quizzes | Dashboard; auto-close and results via `stopPoll` | Worker | Supported. Channel polls are always anonymous, so the bot sees totals, not voters. |
| Channel engagement and analytics | Poll results, reaction counts, revenue, trial conversion | Worker / full bot | Partly. Telegram gives bots **no view counts** for channel posts. Reaction totals need the full bot (`message_reaction_count` updates, bot must be admin). |
| Reactions | Read-only reaction counts | Full bot | Only counting is implemented. The bot adding its own reactions would not be real engagement, and bots can't use paid reactions. |
| VIP promotions | `promo` posts with a "Join VIP" deep link (`?start=promo_<id>`) | Worker; attribution by the full bot | Supported. Which promotion brought a user is recorded only once the full bot handles `/start`. |
| Paid media | `paid_media` posts (`sendPaidMedia`) | Worker | Supported in channels. Stars go to the **channel's** balance. 1 to 10,000 Stars. |
| Join-request processing | Record requests; policy (manual, approve trial buyers, approve all for public); approve or decline from the dashboard | Full bot (recording); worker (approve/decline) | Supported only for invite links that **require approval**. A public `@username` channel has none unless "approve new members" is on. The VIP policy can never be "approve everyone". |
| Moderation | Word and link rules, delete / warn / 24 h mute, 3 strikes in 24 h | Full bot | Channels have no member messages. Works only if the public channel **already** has a linked discussion group (`DISCUSSION_GROUP_ID`). None will be created. |
| Subscriber profiles | Profiles from payments, trials, channel events, join requests and `/start`; tags, notes, CSV export | Dashboard | Telegram gives bots **no member list**. Profiles cover only people this system has seen. Monthly subscribers who joined before the full bot ran are unknown to it. |
| Notifications | Trial-ending (24 h) and renewal (3 days) reminders; admin alerts | Worker / full bot | Bots can message only users who started the bot (join requesters for 5 minutes after asking). Blocked users are skipped. |
| Admin controls | Web dashboard; `/admin` stats command | Dashboard; full bot | Supported. Remove, unban and DM run as queued, audited actions. |
| Web admin dashboard | `dashboard/` | VPS (127.0.0.1 behind SSH or HTTPS) | Password sign-in, CSRF, rate limit, audit log. No token. |

Every worker and full-bot feature is **off** until switched on in the dashboard (Features & settings).

## 3. Before deploying: identify the live bot

The live `@ShakhiraVIPBot` code is not in this repository. Run this **read-only** check (it never
calls `getUpdates` and changes nothing) on a trusted computer:

```bash
TELEGRAM_BOT_TOKEN=... VIP_CHANNEL_ID=-100... python tools/identify_live_bot.py
```

It reports whether the live bot uses a webhook (and on which host: Render, Railway, Google Cloud, a VPS IP, …)
or long polling, its commands, and whether `@yourshakhira` already has a linked discussion group.
Then collect:

- [ ] Where the live bot runs (host account, server or service name), and who can log in.
- [ ] Its source code (repository, ZIP, or a copy from the server).
- [ ] Its database: type, location, and how subscribers and payments are stored.
- [ ] How it creates VIP access (subscription link, invite links, manual?) and its prices (499 ⭐ / 49 ⭐ expected).
- [ ] Its bot settings (commands, description) from the report above.

**Until then, only the poster and the send-only worker may run.**

## 4. Backups (before every change)

| What | How | Where to keep |
|---|---|---|
| Live bot database | On its host (step 3), stop nothing; copy the DB file or `pg_dump` / `mysqldump` | Off the server, encrypted |
| Poster history (Cloudinary tags) | `python tools/export_cloudinary_history.py backups/poster-history-$(date +%Y%m%d).json` (read-only) | Off the server |
| This system's database | `python -m shakhira_bot --backup` (automatic daily in the bot) | `data/backups/` **and** off the server |
| GitHub repository variables | Screenshot or list of Settings → Secrets and variables → Actions → Variables | With the backups |
| Code version | Git tag on `main` before each merge, e.g. `pre-phase-2` | GitHub |

## 5. Rollout, one step at a time (each step needs approval)

**Step A: merge the pull request.** It changes only the poster's behaviour on GitHub Actions:
- alerts when content runs out
- once-per-slot guard
- smart rotation: reuse of the oldest post after 30 days, never removing history
- optional captions

The schedule lines are unchanged.
*Check:*
- Until about 22 Nov (30 days after the first post), runs are red with "No content to post … next one qualifies <date>".
- After that, they are green "Reposted" runs.
- New media in `tgpub` is posted first, as soon as it is uploaded.
*Rollback:* revert the merge commit on `main` (GitHub → the PR → Revert). Cloudinary tags stay valid.

**Step B: VPS with dashboard and send-only worker, in PREVIEW mode.**
1. Install as README "Run it 24/7" describes, with `deploy/shakhira-dashboard.service` and `deploy/shakhira-worker.service`. **Do not install `shakhira-bot.service`.**
2. `.env` settings:
   - `PREVIEW_CHAT_ID` = your own Telegram user ID. Every scheduled item then goes only to your private chat with the bot; nothing reaches the channels, and reminders and admin actions are skipped.
   - `ADMIN_CHAT_IDS` = your ID.
   - Dashboard password hash and secret (README).
3. In the dashboard, switch on **Scheduled posts**, create one of each post type, and check them in your chat.

*Rollback:* `sudo systemctl disable --now shakhira-worker shakhira-dashboard`. Nothing in Telegram changed.

**Step C: worker live.** Remove `PREVIEW_CHAT_ID`, then restart the worker. Turn features on one at a time (Scheduled posts, then Poll auto-close, then Reminders), watching the Activity log.
*Rollback:* switch the feature off in the dashboard (takes effect within 30 s), or stop the worker. Posts already published stay; delete them in Telegram if needed.

**Step D: full bot (replaces the live bot). Only after step 3 is complete.**
1. Back up the live bot's database.
2. Migrate its subscribers and trials into this database. A migration script is written once the live data format is known.
3. Stop the live bot.
4. Start `shakhira-bot.service` (add `--take-over-webhook` only if the old bot used a webhook).
5. Watch `/status`, payments and joins for an hour.

*Rollback:*
1. `sudo systemctl stop shakhira-bot`.
2. Restart the old bot exactly as before. If it used a webhook, it must call `setWebhook` again; most frameworks do this on start.
3. Payments made in between are in this system's database: hand them over manually.

## 6. Regression tests

```bash
pip install -r requirements-dev.txt -r requirements-dashboard.txt
pytest -q
```

They use fake Telegram and Cloudinary services only. They also run on every pull request (`.github/workflows/tests.yml`).

## 7. Costs

| Item | Cost |
|---|---|
| GitHub Actions poster, cron-job.org trigger | Free |
| VPS for dashboard + worker (+ full bot later): 1 vCPU, 1 GB RAM | about $5–6 / month |
| Domain + HTTPS for the dashboard (optional; an SSH tunnel is free) | about $10 / year; free certificates (Let's Encrypt) |
| Off-server backups (e.g. object storage) | free tier to under $1 / month |
