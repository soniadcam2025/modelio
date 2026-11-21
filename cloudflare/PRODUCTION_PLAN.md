# Production integration plan (draft, needs approval at every step)

Current state (21 Nov 2026):
- **Live bot:** the Worker `shakhira-vip-bot` (webhook, one cron every 5 minutes) is untouched.
- **GitHub poster:** posting at 5 AM and 10 PM IST with smart rotation.
- **Staging:** the admin Worker is built and tested, and waits only for D1 permission on the Cloudflare token.

Rules for every step:
- **Live bot:** never modified or redeployed unless a step says so and you approved it.
- **Resources:** free Cloudflare allowances only; no new bots, channels or groups.
- **Reversibility:** each step can be undone on its own.

## Step 1: Staging sign-off (no production impact)
- Deploy `shakhira-admin-staging` + D1 `shakhira-staging` with example data and **simulated** automation.
- Test all eight post types, security, persistence and logs on the live staging URL, on desktop and mobile.
- Optional real preview: you set `BOT_TOKEN` yourself and put your own user ID in `PREVIEW_CHAT_ID`. Posts then reach only your private chat with the bot.
- **Undo:** `wrangler delete shakhira-admin-staging`, then `wrangler d1 delete shakhira-staging`.

## Step 2: Production admin Worker for channel content (send-only)
- A separate Worker `shakhira-admin` with its own D1 `shakhira-prod`, no example data, and every feature off.
- You switch on **Scheduled posts** only. The Worker can then publish text, media, polls, quizzes, promotions and paid media to the two channels.
- It still only sends, so the live bot's webhook and members are unaffected.
- **No overlap with the GitHub poster:**
  - The Worker never posts Cloudinary auto-posts.
  - Planned addition: the Worker refuses to schedule within 15 minutes of the 5 AM / 10 PM IST slots, so posts never land on top of each other.
- **Cost:** a second cron trigger, so 3 of the 5 free ones in use. Requests stay far under 100,000 a day.
- **Undo:** switch the feature off (takes effect within 1 minute), or delete the Worker. Published messages can be deleted in Telegram.

## Step 3: Member features (join requests, reminders, moderation, reactions, payment events)
- These need incoming Telegram updates, which only the live bot's webhook receives. Two options, both changing the live bot, so both need its source code and your explicit approval:
  1. **Forwarding (smallest change):** the live bot forwards a copy of selected updates to the admin Worker over a Cloudflare service binding. It keeps answering members exactly as today.
  2. **Merge:** move these features into the live bot's own code.
- Until then they stay off. Reminders also need subscription data, which only the live bot holds today.
- **Undo:** remove the forwarding line and redeploy the previous live-bot version (Cloudflare keeps versions; rollback is one command).

## Step 4: Subscriber data (read-only first)
- Locate where the live bot stores subscribers and payments (KV or D1 in the same account), then make a **read-only export** for the dashboard's subscriber view.
- No writes to live subscriber data in this step.
- **Undo:** drop the copied data from `shakhira-prod`.

## Step 5: Payment-related actions (last, if wanted)
- Refund helpers or manual access changes only after steps 2–4 have run cleanly, each with its own approval.
- Prices (499 ⭐ / 30 days, 49 ⭐ / 3 days) stay as they are.

## Free-tier budget after all steps

| Resource | Use | Free limit |
|---|---|---|
| Workers | 3 (live bot, staging, production) | 100 |
| Cron triggers | 3 | 5 |
| Requests/day | ~3,500 | 100,000 |
| D1 | 2 databases, a few MB | 10 databases, 5 GB |
