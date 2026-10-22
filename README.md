# CuteShakhira VIP bot (@ShakhiraVIPBot)

Telegram bot that sells access to the private VIP channel with Telegram Stars.

| Plan | Price | How it works |
|---|---|---|
| 💎 VIP Monthly | 499 ⭐ / 30 days | Telegram's own channel subscription link. Telegram charges, renews every 30 days, and removes people who cancel or stop paying. |
| ⏳ 3-day trial | 49 ⭐ once | Bot invoice in Stars. After payment the bot sends a single-use invite link and removes the member when the 3 days are over (unless they are a paying monthly subscriber or an admin). |

Prices and the trial length come from `.env`. The defaults match the bot that is live today.

**Commands:** `/start` (welcome menu), `/subscribe` (choose a plan), `/status` (check membership), `/rules` (membership information), `/paysupport` (payment help).

**Menu buttons:** VIP Monthly, 3-day trial, My membership, Free channel (`@yourshakhira`), Support.

## Project layout

```
shakhira_bot/
  __main__.py   start the bot: python -m shakhira_bot
  config.py     reads settings from .env
  texts.py      every message the bot sends (edit wording here)
  handlers.py   commands, buttons, payments, channel join/leave events
  access.py     subscription link, trial links, status, trial expiry
  payments.py   Stars invoice payload and payment checks
  storage.py    SQLite database (payments, trials, events)
  app.py        connects everything
tests/          automated tests (no Telegram connection needed)
deploy/         systemd service for a Linux server
```

## Before you start (Telegram side)

1. The VIP channel must be **private**, and `@ShakhiraVIPBot` must be an **admin** with:
   - **Invite Users via Link**: needed to create the subscription and trial links.
   - **Ban Users**: needed to remove members whose trial ended.
2. Find the VIP channel's numeric ID:
   1. On a computer, open <https://web.telegram.org/a/> and log in.
   2. Open the VIP channel.
   3. The address bar ends with something like `#-1001234567890`. That number (including `-100`) is `VIP_CHANNEL_ID`.
   4. If it doesn't start with `-100`, put `100` right after the minus sign.
3. **Only one program can run a bot at a time.** Stop the bot that is running now before you start this one. Otherwise Telegram returns a "Conflict" error. If the old bot used a webhook, starting this bot switches the bot to polling.

## Run it on your computer (for testing)

You need Python 3.10 or newer.

```bash
python -m venv .venv
# Windows PowerShell:  .venv\Scripts\Activate.ps1
# macOS / Linux:       source .venv/bin/activate
pip install -r requirements.txt
```

Copy `.env.example` to a new file named `.env` and fill in `BOT_TOKEN` and `VIP_CHANNEL_ID`. `.env` is ignored by Git: never commit it and never paste the token into a chat.

```bash
python -m shakhira_bot --check-config   # checks .env without connecting to Telegram
python -m shakhira_bot                  # starts the bot (Ctrl+C to stop)
```

## Run the tests

```bash
pip install -r requirements-dev.txt
pytest
```

## Run 24/7 on a server (Ubuntu VPS)

```bash
sudo adduser --system --group shakhira
sudo git clone https://github.com/soniadcam2025/modelio /opt/shakhira-bot
cd /opt/shakhira-bot
sudo python3 -m venv .venv
sudo .venv/bin/pip install -r requirements.txt
sudo cp .env.example .env && sudo nano .env      # fill in the real values
sudo chown -R shakhira:shakhira /opt/shakhira-bot && sudo chmod 600 .env
sudo cp deploy/shakhira-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shakhira-bot
sudo journalctl -u shakhira-bot -f               # live logs
```

The database lives in `data/shakhira_bot.db`. Back it up: it is the record of trial payments.

## Good to know

- **Cancelling monthly:** members cancel in Telegram (Settings → My Stars → their subscriptions). Telegram removes them when the paid period ends. The bot cannot cancel or refund for them.
- **Existing monthly subscribers** who joined through an older link keep their subscription. `/status` reads it directly from Telegram.
- **Trials sold by the old bot** are not in this bot's database, so this bot won't remove those people automatically.
- **Changing the monthly price:** Telegram doesn't let you edit a subscription link's price. Change `VIP_MONTHLY_PRICE` and the bot makes a new link. People already subscribed keep their old price.
- **If you revoke the monthly link** in Telegram, run `python -m shakhira_bot --reset-monthly-link` and restart. The bot makes a fresh link the next time someone taps VIP Monthly.
- Logs never include the bot token: request logging from the HTTP library is turned down on purpose.
