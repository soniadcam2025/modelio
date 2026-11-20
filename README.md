# Modelio: CuteShakhira Telegram system

This repo has two separate parts. A problem in one doesn't stop the other.

| Part | What it does | Where it runs |
|---|---|---|
| **Channel poster** (`poster/`) | Posts one photo/video from the Cloudinary `tgpub` folder to `@yourshakhira` | **GitHub Actions**, automatically at **5:00 AM and 10:00 PM IST**. Live since 23 Oct 2026. |
| **Subscription bot** (`shakhira_bot/`) | Sells VIP access to the private VIP channel with Telegram Stars | **Not deployed.** The live `@ShakhiraVIPBot` runs other code (see Part 2). |

Both use the same bot token. They don't share a database or files. The poster only *sends* messages, so it never competes with the live bot for updates.

```
poster/         Cloudinary -> Telegram poster (python -m poster)
  config.py             settings and validation
  cloudinary_source.py  find media in the folder, read/write posting-history tags
  media.py              photo/video rules, size limits, safe download
  telegram_publisher.py upload to Telegram, channel permission check, admin alert messages
  runner.py             one posting run: pick, claim, post, record; folder inventory
  slots.py              which scheduled slot (5 AM / 10 PM) a run belongs to
  monitor.py            run summary, GitHub annotations, admin alerts, posting report
shakhira_bot/   subscription bot (python -m shakhira_bot) and the send-only worker (--worker)
  ops.py                content queue, captions, profiles, join requests, moderation, analytics data
  scheduler.py          send-only engine: posts, polls/quizzes, paid media, reminders, admin actions
  features.py           join requests, moderation, reactions, profiles, /admin (full bot only)
dashboard/      web admin dashboard (python -m dashboard serve); holds no bot token
tools/          identify_live_bot.py (read-only), export_cloudinary_history.py (read-only backup)
DEPLOYMENT.md   feature matrix, live-bot identification, backups, rollout steps and rollback
tests/          automated tests (fake Telegram and Cloudinary; nothing real is touched)
.github/workflows/post-to-channel.yml   the posting schedule and manual runs
.github/workflows/tests.yml             runs the tests on every pull request (no secrets)
deploy/         systemd service for running the bot on a Linux server
```

---

## Part 1: Channel poster (Cloudinary → @yourshakhira)

### Current state (checked 20 Nov 2026)

- **Schedule is ON:** `30 16 * * *` (10:00 PM IST) and `30 23 * * *` (5:00 AM IST).
- 34 posts went out between 23 Oct and 8 Nov (messages 5 → 38), with no duplicates and no failed runs.
- **Since 9 Nov nothing has been posted:** all 34 files in `tgpub` were used, and the old version reported "nothing to post" as a green run. This version turns that into a red run plus an alert. **Upload new media to `tgpub` to resume posting.**
- GitHub starts the scheduled runs **3 to 6.5 hours late** (see "On-time posting" below).

### Which secret is which

| Name | What it is | Secret? |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot's password, from @BotFather. Looks like `123456789:AA...` | **Yes** |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary account name (it appears in your media URLs) | Not really, but kept as a secret |
| `CLOUDINARY_API_KEY` | Cloudinary API key (a number) | **Yes** |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret. Never share it. | **Yes** |

**Where to find the Cloudinary values:** <https://console.cloudinary.com> → **Settings** (gear icon) → **API Keys**.
**Where to find the bot token:** Telegram → **@BotFather** → `/mybots` → **ShakhiraVIPBot** → **API Token**.

Never paste these into a chat, a file in this repo, or an issue.

### Setup (already done for @yourshakhira)

1. **Bot is admin of the channel:** @yourshakhira → Edit → Administrators → @ShakhiraVIPBot with **Post Messages** on.
2. **GitHub secrets:** <https://github.com/soniadcam2025/modelio> → **Settings** → **Secrets and variables** → **Actions** → **Secrets**: the four values above.
3. **Optional GitHub variables** (same page, **Variables** tab; none of these are secret):

| Variable | Default | What it does |
|---|---|---|
| `ADMIN_CHAT_ID` | empty | **Recommended.** Your numeric Telegram user ID. Alerts (nothing left to post, low content, failures) are sent there. Get it from @userinfobot, then press **Start** in @ShakhiraVIPBot once so the bot is allowed to message you. Never the public channel. |
| `LOW_STOCK_THRESHOLD` | `5` | Warn when fewer than this many unpublished files are left after a post. `0` = never warn. |
| `POST_WHEN_EXHAUSTED` | `stop` | `stop` = when everything is posted, stop and alert. `restart` = **re-post old media** in a new round. Only set `restart` if you want recycling. |
| `POST_CAPTION` | empty | Default caption. An asset's own `caption` (Cloudinary → asset → Metadata/Context) wins. |
| `POST_SELECTION` | `oldest` | `oldest` first, `random`, or `smart`: files tagged `tgpriority` first, then a different type (photo/video) than the last post, then oldest. |
| `POST_CAPTIONS` | empty | Captions that rotate post by post, separated by `\|\|`. Supports `{date}`, `{weekday}`, `{channel}`. An asset's own caption still wins. |
| `POST_FOOTER` | empty | Added under every caption (e.g. `💎 VIP: @ShakhiraVIPBot`), if it fits in 1,024 characters. |
| `PUBLIC_CHANNEL` | `@yourshakhira` | Where to post. |
| `CLOUDINARY_FOLDER` | `tgpub` | Which folder to post from. |

### Manual runs

**Actions** → **Post to public channel** → **Run workflow**, then pick a mode:

| Mode | Changes anything? | Use it to |
|---|---|---|
| `check` | No | Confirm the bot can post to the channel. |
| `dry-run` | No | See which file would be posted next and how many are left. |
| `report` | No | See how many files are left, and which of the last 7 days' 5 AM / 10 PM slots got a post. |
| `post` + a test channel ID | Posts to **that** channel only | Test an upload without touching @yourshakhira. Nothing is recorded. |
| `post`, channel empty, slot empty | **Posts to @yourshakhira** | An extra one-off post. |
| `post`, slot `auto` | **Posts to @yourshakhira** | Post for the slot due now; does nothing if that slot already has a post. Used by the on-time trigger below. |

To run it on your own computer: copy `.env.example` to `.env`, fill it in, `pip install -r requirements-poster.txt`, then `python -m poster --report` (or `--check`, `--dry-run`, `--channel -100…`).

### Alerts and monitoring

A green run now means **a post was made** (or that slot already had one). It no longer means "the job ran".

| Run result | Run colour | Annotation on the run page | Telegram alert to `ADMIN_CHAT_ID` |
|---|---|---|---|
| Posted | ✅ green | `Posted <file> (message N)` | Only if fewer than `LOW_STOCK_THRESHOLD` files are left: **Low content** |
| Slot already posted | ✅ green | `Already posted` | — |
| Nothing left to post / folder empty | ❌ red (exit 3) | **No content to post** | **No content to post** |
| Upload failed, uncertain, or not recorded | ❌ red (exit 1) | The error | The error |

- Each run's **Summary** page shows a table: result, slot, file, Telegram message ID and **unpublished files left**.
- GitHub also emails you when a scheduled run fails (GitHub → your avatar → **Settings** → **Notifications** → **Actions**: keep "Send notifications for failed workflows" on).
- Alerts are only sent for real posting runs to the public channel. `check`, `dry-run`, `report` and test-channel runs never send alerts.
- `report` mode lists **missed slots**: scheduled times in the last 7 days with no post. Slot tracking starts with the first scheduled post after this update.

### On-time posting (proposal, not switched on)

**What's going on:** GitHub runs scheduled workflows "best effort". In this repo the 10 PM run actually started between 12:40 AM and 5:10 AM IST, and the 5 AM run between 6:55 AM and 10:40 AM IST. GitHub's schedule can't be made punctual. Also, in a **public** repo GitHub **turns off** schedules after 60 days without a commit (from 22 Oct, that's about 21 Dec 2026). Merging this update resets that clock.

**Free fix: an external scheduler triggers the workflow on time.** [cron-job.org](https://cron-job.org) (free) calls GitHub's API at exactly 5:00 and 22:00 IST. A manually triggered run starts within about a minute. GitHub's own schedule stays as a backup. Every post is tagged with its slot (`tgbot_slot_…`), so whichever run arrives first posts and the other one does nothing. Duplicates are impossible. External triggers also keep working if GitHub turns off the schedule after 60 days.

Setup, about 10 minutes, after this update is merged:
1. GitHub → avatar → **Settings** → **Developer settings** → **Fine-grained tokens** → **Generate new token**. Repository access: **only `soniadcam2025/modelio`**. Permissions: **Actions: Read and write** (nothing else). Pick an expiry and put a reminder in your calendar to renew it.
2. cron-job.org → **Create cronjob**, twice (one at 05:00, one at 22:00), time zone **Asia/Kolkata**:
   - URL: `https://api.github.com/repos/soniadcam2025/modelio/actions/workflows/post-to-channel.yml/dispatches`
   - Method **POST**. Headers: `Authorization: Bearer <your token>`, `Accept: application/vnd.github+json`, `Content-Type: application/json`
   - Body: `{"ref":"main","inputs":{"mode":"post","slot":"auto"}}`
3. The next morning, check **Actions**: one green "Posted" run at about 5:00, and GitHub's late run later shows "Already posted".

If the token expires, the external runs stop and GitHub's (late) schedule still posts, so nothing breaks.

### How duplicate prevention works

The posting history is stored **on the assets themselves, as Cloudinary tags**.

| Tag | Meaning |
|---|---|
| `tgbot_posted` | Telegram confirmed the post. Never picked again (unless `POST_WHEN_EXHAUSTED=restart`). |
| `tgbot_slot_<YYYYMMDDTHHMMZ>` | The scheduled slot (UTC) it was posted for. Another run for the same slot won't post. |
| `tgbot_run_<number>` | The GitHub run that posted it. A re-run doesn't post again. |
| `tgbot_claim_<time>_<id>` | A temporary lock while a run is posting. Expires after 30 minutes if a run crashes. |
| `tgbot_uncertain` | The upload may have reached Telegram, but no confirmation came back. Skipped so it's never double-posted. Check the channel, then add `tgbot_posted` or remove `tgbot_uncertain`. |
| `tgbot_rejected` | Telegram refused the file. Remove the tag after fixing or replacing the file. |

- An asset is marked posted **only after Telegram confirms**.
- Only these `tgbot_` tags are ever added or removed. **Your own tags are never touched.**
- Only one posting job runs at a time (`concurrency` in the workflow). Each run also claims its asset and re-checks before posting.
- When everything has been posted, the poster **stops and alerts**. It never re-posts old media unless you set `POST_WHEN_EXHAUSTED=restart`.

### What gets posted, and the limits

- **Photos** (jpg, png, webp) up to **10 MB**, width + height ≤ 10,000 px, long side ≤ 20 × short side.
- **MP4 videos** up to **50 MB** (sent as playable videos). **GIFs** up to **50 MB** (sent as animations).
- Anything else is skipped with a reason in the log.
- Only assets **directly** in `tgpub` (not subfolders). Both Cloudinary folder modes work.

### Free-tier usage

- **GitHub Actions:** about 1 minute per run, roughly 60 minutes a month. Free for public repos.
- **Cloudinary:** a few Admin API calls per run, plus one original-file download per post. Check Cloudinary → **Dashboard**.
- **cron-job.org** (if used): free.

### Troubleshooting

| Log message / alert | Fix |
|---|---|
| `Missing required environment variable(s): ...` | Add the named secret(s) in GitHub. |
| `not an admin of @yourshakhira` / `cannot post messages` | Make the bot an admin with Post Messages. |
| `Telegram rejected the bot token` | The token is wrong or was revoked. Copy it again from @BotFather. |
| `Cloudinary ... AuthorizationRequired` | Wrong Cloudinary API key or secret. |
| **No content to post** / `Every supported asset has already been posted` | Upload new media to `tgpub`. (Or, only if you want old posts repeated, set `POST_WHEN_EXHAUSTED=restart`.) |
| **Low content** | Fewer than 5 unpublished files left. Upload more soon. |
| **Posted but not recorded** | The post worked but tagging failed. Add the tag `tgbot_posted` to that asset by hand. |
| No Telegram alerts arrive | Check `ADMIN_CHAT_ID` is your numeric ID and that you pressed **Start** in the bot. |

---

## Part 2: Subscription bot (@ShakhiraVIPBot)

> **This is not the bot that is running today.** The live `@ShakhiraVIPBot` runs code that is not in this repository, on a host that is not yet identified. The code here has **not been deployed** and has **never been tested against real Telegram or real payments**. Don't start it with the live token until the live bot has been identified and retired. The bot refuses to start if the token has a webhook (see below).

| Plan | Price | How it works in this code |
|---|---|---|
| 💎 VIP Monthly | 499 ⭐ / 30 days | Telegram's own channel subscription link. Telegram charges, renews and removes people who stop paying. |
| ⏳ 3-day trial | 49 ⭐ once | Stars invoice. After the payment is verified, the bot sends a single-use invite link and removes the member when 3 days are up. Admins and paying monthly subscribers are never removed. |

**Commands:** `/start`, `/subscribe`, `/status`, `/rules`, `/paysupport`.

**Waiting for your approval** (in the code, but not part of the terms you described; none of them affect prices or durations): one trial per account (`TRIAL_ONCE_PER_USER`), the `/paysupport` command, and the Free channel / Support buttons in `/start`.

### Protections

| Risk | What the bot does |
|---|---|
| Trial buyer creates unlimited invite links | At most **3 links per trial**. A new link is only given to a buyer who is not in the channel, and **every older link is revoked first**. If an old link can't be revoked, no new one is made. |
| Someone joins with another buyer's link, or with a link of an ended trial | **Removed** immediately (not permanently banned), the link is revoked, and admins are alerted. Admins, and users with their own paid trial, are left alone. Trial-style links the bot has no record of (for example from the older bot) are **never** acted on, only reported. |
| Crash between payment and trial | Payment and trial are saved in **one database transaction**. When Telegram re-sends the payment after a restart, the buyer gets their link. Older records with a payment but no trial are found and fixed automatically. |
| Payment that doesn't match an offer | Recorded, no access given, **admin alerted** (consider a refund). |
| Unban after removal fails, so the member stays banned | The member is put in a retry queue. The bot retries every 5 minutes until the unban works, and alerts admins after 3 failures. |
| Unexpected errors | Logged (the bot token is removed from logs) and sent to admins, at most once per 15 minutes per kind of error. |
| Database loss | Automatic daily backups (see below). |
| Starting this bot would take over the live bot's webhook | At startup the bot checks (read-only) whether the token has a webhook. If it does, it **refuses to start**. |

### What the bot needs

- An **always-on** process (a VPS; `deploy/shakhira-bot.service` sets it up).
- The bot as an **admin of the private VIP channel**, with **Invite Users via Link** and **Ban Users** on.
- `.env` on that machine (see `.env.example`):
  - `BOT_TOKEN`: the bot token. The poster's `TELEGRAM_BOT_TOKEN` is the same value.
  - `VIP_CHANNEL_ID`: the private channel's numeric `-100…` ID.
  - `ADMIN_CHAT_IDS`: your numeric Telegram user ID(s) for alerts. Press **Start** in the bot once.
  - Optional: `BACKUP_DIR` (default `data/backups`), `BACKUP_KEEP` (14), `BACKUP_INTERVAL_HOURS` (24, `0` = off).
- **Only one copy** of the bot may run per token. The old bot must be stopped first.

### Run the bot

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                 # then edit .env
python -m shakhira_bot --check-config
python -m shakhira_bot
```

If it says `Not starting: This bot token has a webhook set`, another program (probably the live bot) is using this token. Retire that first. Only then start with `python -m shakhira_bot --take-over-webhook`.

### Run it 24/7 on an Ubuntu server

```bash
sudo adduser --system --group shakhira
sudo git clone https://github.com/soniadcam2025/modelio /opt/shakhira-bot
cd /opt/shakhira-bot
sudo python3 -m venv .venv && sudo .venv/bin/pip install -r requirements.txt
sudo cp .env.example .env && sudo nano .env
sudo chown -R shakhira:shakhira /opt/shakhira-bot && sudo chmod 600 .env
sudo cp deploy/shakhira-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now shakhira-bot
sudo journalctl -u shakhira-bot -f
```

### Backups and restore

- The bot writes a backup to `data/backups/` two minutes after starting, then every 24 hours. It uses SQLite's online backup, so the bot keeps running. Each copy is integrity-checked and readable only by the bot's user. The newest 14 are kept.
- One backup by hand: `sudo -u shakhira .venv/bin/python -m shakhira_bot --backup`
- **Copy backups off the server** too, for example a daily `rsync` or `rclone` of `data/backups/` to cloud storage. A backup on the same disk doesn't survive losing the server.
- **Restore:** `sudo systemctl stop shakhira-bot`, then copy the chosen `data/backups/shakhira_bot-YYYYMMDD-HHMMSS.db` over `data/shakhira_bot.db` (keep the old file aside), then `sudo systemctl start shakhira-bot`.

### Good to know

- **Cancelling monthly:** members cancel in Telegram (Settings → My Stars). The bot can't cancel or refund.
- **Refunds:** not built in. Payment alerts tell you when one may be needed.
- **Trials sold by the older bot** aren't in this database, so they won't be removed automatically.
- **Changing the monthly price** creates a new subscription link. Existing subscribers keep their old price.
- **If you revoke the monthly link** in Telegram, run `python -m shakhira_bot --reset-monthly-link` and restart.
- Dates shown to users are in UTC.

---

## Part 3: Admin dashboard and send-only worker

A web dashboard to manage both channels, plus a worker that carries out what you schedule there.
Built and tested; **not deployed**. See [DEPLOYMENT.md](DEPLOYMENT.md) for the feature matrix, Telegram limits and the step-by-step rollout.

- **Dashboard** (`python -m dashboard serve`):
  - Pages: overview; posts and polls; calendar; Cloudinary media library; subscribers (profiles, tags, notes, CSV); join requests; moderation rules; analytics; feature switches; activity log.
  - Holds **no bot token**: it writes requests to the database, and the worker carries them out.
  - Listens on `127.0.0.1:8080`; reach it with `ssh -L 8080:127.0.0.1:8080 you@server`.
- **Worker** (`python -m shakhira_bot --worker`):
  - Sends scheduled text, media, polls, quizzes, VIP promotions and paid media; closes polls and keeps their results; sends trial and renewal reminders; carries out dashboard actions.
  - It **never receives updates**, so it runs safely next to the live bot.
  - Every feature is off until switched on in the dashboard.
  - With `PREVIEW_CHAT_ID` set, everything goes only to your private chat with the bot.

Setup:

```bash
pip install -r requirements.txt -r requirements-poster.txt -r requirements-dashboard.txt
python -m dashboard make-secret        # put the output in .env as DASHBOARD_SECRET
python -m dashboard hash-password      # put the output in .env as DASHBOARD_PASSWORD_HASH
python -m dashboard serve
python -m shakhira_bot --worker        # in another terminal (or the systemd units in deploy/)
```

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The tests use fake Telegram and Cloudinary services. They never charge Stars, post anything, or touch real members. They also run automatically on every pull request (`.github/workflows/tests.yml`, no secrets).

## Status

| | Status |
|---|---|
| Poster on GitHub Actions, 5 AM and 10 PM IST | **Running.** 34 posts, 23 Oct to 8 Nov. |
| Content in Cloudinary `tgpub` | **Used up since 9 Nov.** Upload new media. |
| Exhaustion and low-content alerts, run summary, posting report, once-per-slot guard | Done in this update, tested with fakes. Alerts by Telegram need the `ADMIN_CHAT_ID` variable. |
| On-time external trigger (cron-job.org) | **Proposed, not set up.** See "On-time posting". |
| Content recycling | **Off.** Only with `POST_WHEN_EXHAUSTED=restart`. |
| Subscription bot code (this repo) | Security fixes done and tested with fakes. **Not deployed, not the live bot.** |
| Live @ShakhiraVIPBot | Runs elsewhere; source and host not yet identified. |
| One-trial rule, `/paysupport`, extra menu buttons | **Waiting for your approval** (Part 2). |
| Admin dashboard, send-only worker, new bot features | Built and tested with fakes (Part 3). **Not deployed.** See DEPLOYMENT.md. |
| Smart rotation, caption pool and footer for the poster | Built, **off by default**. |
