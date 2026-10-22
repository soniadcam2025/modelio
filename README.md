# Modelio: CuteShakhira Telegram system

This repo has two separate parts. A problem in one doesn't stop the other.

| Part | What it does | Where it runs |
|---|---|---|
| **Subscription bot** (`shakhira_bot/`) | `@ShakhiraVIPBot`: sells VIP access to the private VIP channel with Telegram Stars | Must run **all the time** (a VPS or other always-on host). GitHub Actions can't host it. |
| **Channel poster** (`poster/`) | Posts one photo/video from the Cloudinary `tgpub` folder to `@yourshakhira` | **GitHub Actions**, twice a day, on the free tier. Nothing to host. |

Both use the same bot token. They don't share a database or files.

```
shakhira_bot/   subscription bot (python -m shakhira_bot)
poster/         Cloudinary -> Telegram poster (python -m poster)
  config.py             settings and validation
  cloudinary_source.py  find media in the folder, read/write posting-history tags
  media.py              photo/video rules, size limits, safe download
  telegram_publisher.py upload to Telegram, channel permission check
  runner.py             one posting run: pick, claim, post, record
tests/          automated tests (no real Telegram or Cloudinary needed)
.github/workflows/post-to-channel.yml   the twice-daily schedule
deploy/         systemd service for running the bot on a Linux server
```

---

## Part 1: Channel poster (Cloudinary → @yourshakhira)

### Which secret is which

| Name | What it is | Secret? |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | The bot's password, from @BotFather. Looks like `123456789:AA...` | **Yes** |
| `CLOUDINARY_CLOUD_NAME` | Your Cloudinary account name (it appears in your media URLs) | Not really, but kept as a secret |
| `CLOUDINARY_API_KEY` | Cloudinary API key (a number) | **Yes** |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret. Never share it. | **Yes** |
| `PUBLIC_CHANNEL` | Where to post: a **username** like `@yourshakhira`, or a numeric **channel ID** like `-1001234567890` | No |

**Where to find the Cloudinary values:** log in at <https://console.cloudinary.com> → **Settings** (gear icon) → **API Keys**. The page shows the cloud name, the API key, and the API secret (click the eye icon to reveal it).

**Where to find the bot token:** Telegram → **@BotFather** → `/mybots` → **ShakhiraVIPBot** → **API Token**.

Never paste these into a chat, a file in this repo, or an issue.

### Step 1: Let the bot post in @yourshakhira

1. In Telegram, open **@yourshakhira** → tap the channel name → **Edit** → **Administrators** → **Add Admin**.
2. Pick **@ShakhiraVIPBot**.
3. Turn on **Post Messages**. Everything else can stay off.
4. Save.

The poster checks this at the start of every run. If anything is wrong, it stops and tells you exactly what.

### Step 2: Add the GitHub secrets

1. Open <https://github.com/soniadcam2025/modelio> → **Settings** → **Secrets and variables** → **Actions**.
2. Under **Secrets**, click **New repository secret** and add each of these with its value:
   - `TELEGRAM_BOT_TOKEN`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_API_KEY`
   - `CLOUDINARY_API_SECRET`
3. Optional: on the **Variables** tab, add any of these (they aren't secret):
   - `POST_CAPTION`: default caption. Empty means no caption.
   - `PUBLIC_CHANNEL`: default `@yourshakhira`
   - `CLOUDINARY_FOLDER`: default `tgpub`

**Captions:** if an asset has a `caption` field in its Cloudinary metadata (Media Library → asset → **Metadata/Context**), that caption is used. Otherwise `POST_CAPTION` is used. The poster never edits your media.

### Step 3: Test safely before scheduled posting

Scheduled workflows only run from the **default branch** (`main`), so nothing posts on a schedule until this code is merged.

1. Go to **Actions** → **Post to public channel** → **Run workflow**.
2. Choose **mode: check**. This only confirms the bot can post to the channel. It should finish with a green tick.
3. Run it again with **mode: dry-run**. The log shows how many assets were found and which one would be posted next. Nothing is posted or changed.
4. Optional real test without touching the public channel:
   1. Create a private test channel and add the bot as admin with **Post Messages**.
   2. Give the channel a public username, or use its `-100…` ID.
   3. Run with **mode: post** and **channel: @your_test_channel**.

   Test-channel posts are **not** recorded, so that asset still goes to the public channel later.
5. When you're happy, run **mode: post** with an empty channel to make the first real post. The schedule takes over after that.

To run it on your own computer instead: copy `.env.example` to `.env`, fill it in, then:
```bash
pip install -r requirements-poster.txt
python -m poster --check
python -m poster --dry-run
python -m poster --channel @your_test_channel
```

### Schedule

| UTC cron | India time (IST = UTC+5:30) |
|---|---|
| `30 4 * * *` | 10:00 AM |
| `30 13 * * *` | 7:00 PM |

**The times are approximate.** GitHub often starts scheduled jobs 5–30 minutes late, sometimes more, and can skip a run when GitHub is very busy. Also, in a public repo GitHub **pauses schedules after 60 days with no commits**. It emails you, and you can re-enable the schedule on the Actions tab.

**To see runs and logs:** **Actions** tab → **Post to public channel** → click a run → **post** job → **Run poster** step.

### How duplicate prevention works

The posting history is stored **on the assets themselves, as Cloudinary tags**. It survives between GitHub runs, and you can see it in the Cloudinary Media Library.

| Tag | Meaning |
|---|---|
| `tgbot_posted` | Telegram confirmed the post. Never picked again (unless rotation is set to `restart`). |
| `tgbot_run_<number>` | The GitHub run that posted it. If a run is re-run, it sees this tag and doesn't post again. |
| `tgbot_claim_<time>_<id>` | A temporary lock while a run is posting. Other runs skip the asset. It expires after 30 minutes if a run crashes. |
| `tgbot_uncertain` | The upload may have reached Telegram, but no confirmation came back. Skipped so it's never double-posted. Check the channel, then either add `tgbot_posted` or remove `tgbot_uncertain` so it's posted again. |
| `tgbot_rejected` | Telegram refused the file (for example, unsupported dimensions). Skipped so it doesn't block every later run. Remove the tag after fixing or replacing the file. |

- An asset is marked posted **only after Telegram confirms**. A failed upload leaves no `tgbot_posted` tag, so the asset is tried again next time.
- Only these `tgbot_` tags are ever added or removed. **Your own tags are never touched.**
- Two runs can't post the same asset:
  - GitHub runs one posting job at a time (`concurrency` in the workflow).
  - Each run also claims an asset and re-reads its tags before posting. If another run claimed it too, it backs off.
- When every asset has been posted, the poster stops posting and says so in the log. To start a new round automatically, set the variable `POST_WHEN_EXHAUSTED=restart`.

### What gets posted, and the limits

- **Photos** (jpg, png, webp) up to **10 MB** are sent as photos. Telegram also requires width + height of at most 10,000 pixels, and the long side at most 20 times the short side. Photos outside that are skipped.
- **MP4 videos** up to **50 MB** are sent as playable videos.
- **GIFs** up to **50 MB** are sent as animations.
- Anything else is skipped with a reason in the log: other formats (`.mov`, `.pdf`…), larger files, and private/authenticated assets.
- The 10 MB and 50 MB figures are the Telegram Bot API upload limits for bots. Files are downloaded from Cloudinary and uploaded to Telegram as real files.
- Only assets **directly** in `tgpub` are used, not subfolders. This works with both Cloudinary folder modes:
  - "dynamic folders", where the folder isn't part of the asset's ID
  - older "fixed folders", where IDs start with `tgpub/`
- The order is oldest upload first. Set `POST_SELECTION=random` for random order.

### Free-tier usage

- **GitHub Actions:** each run takes about 1 minute, so roughly 60 minutes a month. That's free for public repos and well inside the 2,000 free minutes for private repos.
- **Cloudinary free plan:**
  - Each run makes a few Admin API calls, far below the hourly limit.
  - Each post downloads one original file, which counts toward your monthly bandwidth/credits. Large videos use more.
  - Check usage in Cloudinary → **Dashboard**.

### Troubleshooting

| Log message | Fix |
|---|---|
| `Missing required environment variable(s): ...` | Add the named secret(s) in GitHub (Step 2). |
| `not an admin of @yourshakhira` / `cannot post messages` | Step 1. |
| `Telegram rejected the bot token` | The token is wrong or was revoked. Copy it again from @BotFather. |
| `Cloudinary ... AuthorizationRequired` | Wrong Cloudinary API key or secret. |
| `Cloudinary folder 'tgpub' is empty` | Check the folder name and casing in the Media Library, or set `CLOUDINARY_FOLDER`. |
| `Every supported asset has already been posted` | Upload more media, or set `POST_WHEN_EXHAUSTED=restart`. |
| `POSTED ... but could not record it` | The post worked but tagging failed. Add the tag `tgbot_posted` to that asset by hand. |

---

## Part 2: Subscription bot (@ShakhiraVIPBot)

> **This is not the bot that is running today.** The `@ShakhiraVIPBot` currently live in Telegram runs code that is not in this repository. The code here (`shakhira_bot/`) is a separate implementation, built from an earlier starter ZIP plus the plans and commands you described. It has **not been deployed**, and **never tested against real Telegram or real payments**. Its wording and menu are my reconstruction and may not match the live bot word for word.

| Plan | Price | How it works in this code |
|---|---|---|
| 💎 VIP Monthly | 499 ⭐ / 30 days | Telegram's own channel subscription link. Telegram charges, renews every 30 days, and removes people who cancel or stop paying. |
| ⏳ 3-day trial | 49 ⭐ once | Stars invoice. After the payment is verified, the bot sends a single-use invite link and removes the member when 3 days are up. It never removes admins or paying monthly subscribers. |

**Commands:** `/start`, `/subscribe`, `/status`, `/rules`, plus `/paysupport` (see below).

**Waiting for your approval.** These are in the code but aren't part of the terms you described. Neither affects prices or durations.

| Item | What the code does now | How to change it |
|---|---|---|
| One trial per account | On by default. A second trial purchase is refused before payment, and `/rules` shows "One trial per account." | Set `TRIAL_ONCE_PER_USER=false` in `.env`. Repeat trials then extend the current trial, and the `/rules` line disappears. |
| `/paysupport` command | Added. It replies with the support contact. `/rules` and two error messages point to it. | Ask me to remove it. Telegram's payment rules appear to expect a way for buyers to reach payment support; I couldn't confirm the exact rule from this environment. |
| Free channel / Support buttons in `/start` | Added under the two plan buttons | Ask me to remove them |

**What the bot checks and protects against:**
- **Payments:** checked before and after checkout (currency `XTR`, amount, invoice payload, buyer). Duplicate payment updates are ignored.
- **Records:** payments and trials are saved in SQLite, so they survive restarts.
- **Expired trials:** checked every 5 minutes.

### What the bot needs

- An **always-on** process: a VPS (the `deploy/shakhira-bot.service` file sets this up) or any host that keeps a Python program running.
- The bot as an **admin of the private VIP channel**, with **Invite Users via Link** and **Ban Users** on.
- `.env` on that machine with:
  - `TELEGRAM_BOT_TOKEN` (or `BOT_TOKEN`)
  - `VIP_CHANNEL_ID`: the private channel's **numeric ID**. Find it at <https://web.telegram.org/a/>: open the channel and copy the `-100…` number at the end of the address.
- **Only one copy** of the bot may run at a time. Stop any older bot first.

### Run the bot

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
cp .env.example .env                 # then edit .env
python -m shakhira_bot --check-config
python -m shakhira_bot
```

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

Back up `data/shakhira_bot.db`: it holds the trial payment records.

### Good to know

- **Cancelling monthly:** members cancel in Telegram (Settings → My Stars). Telegram removes them when the paid period ends. The bot can't cancel or refund.
- **Refunds:** not built into the bot.
- **Trials sold by an older bot** aren't in this database, so they won't be removed automatically.
- **Changing the monthly price** creates a new subscription link. Existing subscribers keep their old price.
- **If you revoke the monthly link** in Telegram, run `python -m shakhira_bot --reset-monthly-link` and restart the bot.

---

## Tests

```bash
pip install -r requirements-dev.txt
pytest
```

The tests use fake Telegram and Cloudinary services. They never charge Stars, post anything, or touch real members.

## Status

| | Status |
|---|---|
| Poster code, workflow, tests | Done. Tested with fakes only. |
| Poster against the real Cloudinary account and channel | **Not verified yet.** Run Step 3. |
| Bot admin rights in @yourshakhira | **Not verified.** The `check` mode verifies it. |
| Subscription bot code and tests (this repo) | Done. Tested with fakes only. **Not the code of the bot that is live today.** |
| Subscription bot from this repo deployed | **No.** Needs an always-on host and your go-ahead. Your current live bot keeps running unchanged. |
| One-trial rule, `/paysupport`, extra menu buttons | **Waiting for your approval** (see Part 2). |
