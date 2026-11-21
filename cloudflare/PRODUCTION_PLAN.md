# Production integration checklist for @ShakhiraVIPBot

Status (21 Nov 2026):
- **Staging dashboard:** https://shakhira-admin-staging.vercel.app (Vercel Hobby, region bom1) on Supabase `shakhira-staging` (ap-south-1), in **simulation**, with all features off. Sign-in uses Supabase Auth. See `supabase/README.md`.
- **Staging clock:** the Worker `shakhira-admin-staging` cron sends one signed request per minute to Vercel, which runs the cycle. Its own D1 `shakhira-staging` holds the earlier staging data, which has been copied to Supabase.
- **Live bot:** the Worker `shakhira-vip-bot` (webhook, cron every 5 minutes, D1 `shakhira-vip`) has never been changed.
- **Free-channel posting:** GitHub Actions posts at 5 AM and 10 PM IST with smart rotation.

How each step is written:
- **Owner:** who acts.
- **Changes:** exactly what is touched.
- **Verify:** how we know it worked.
- **Undo:** how to reverse it.

Nothing moves to the next step without your written approval.

---

## A. Staging acceptance (no production impact)

**A1. Admin login**
- **Owner:** you.
- **Changes:** set your own staging password with `cd cloudflare && node tools/hash-password.mjs | npx wrangler secret put DASHBOARD_PASSWORD_HASH`.
- **Verify:** sign in.
- **Undo:** run the same command again.
- **Sign out every session at once:** `openssl rand -base64 48 | npx wrangler secret put DASHBOARD_SECRET`.

**A2. Private Telegram preview**
1. You: in Telegram, send `/start` to @ShakhiraVIPBot (once; lets the bot message you) and get your numeric user ID from @userinfobot.
2. You: Cloudflare dashboard → Workers & Pages → `shakhira-admin-staging` → Settings → Variables and Secrets → **Add → Secret** `BOT_TOKEN` (the same token as the live bot).
   - Safe in any order: a token without a preview chat is **locked** (nothing is sent).
3. Claude: set `PREVIEW_CHAT_ID = "<your ID>"` in `wrangler.toml` and redeploy staging.
4. Claude: run `test/remote/staging-preview.mjs`. Eight messages (text, photo, video, GIF, poll, quiz, VIP promotion, paid media at 1 ⭐) arrive **only in your private chat**.

- **Verify:** you see the eight messages; the dashboard shows them `posted` with Telegram message IDs.
- **Undo:** delete the `BOT_TOKEN` secret, which returns staging to simulation.

**A3. Media library**
- **Owner:** you.
- **Changes:** add three secrets to `shakhira-admin-staging`: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
  - Use the same values as the GitHub secrets, or better, a read-only Cloudinary API key.
  - The Worker only **reads** the `tgpub` folder and never adds or removes tags.
- **Verify:** the Media library page shows the same numbers as the GitHub `report` run (new, posted, reusable after 30 days).
- **Undo:** delete the secrets.

## A4. Choose the production host (decision needed)
- **Vercel Hobby** is non-commercial only. A paid VIP channel is commercial use, so production on Vercel needs **Pro at US$20/month** (your approval).
- **Free alternative:** run the same code as the Cloudflare Worker `shakhira-admin` (section B) with Supabase as its database (set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` secrets), at no cost. The Vercel deployment then stays as staging only.

## B. Production admin Worker: channel content (send-only)

**B1. Create production resources**
- **Owner:** Claude, after your approval.
- **Changes:** Worker `shakhira-admin` (a copy of staging with `ENVIRONMENT = "production"`) and a new empty D1 `shakhira-admin-prod`, with no example data.
- **Free plan:** 3 Workers of 100, 3 cron triggers of 5, 3 D1 databases of 10.
- **Undo:** `wrangler delete shakhira-admin`, then `wrangler d1 delete shakhira-admin-prod`.

**B2. Production settings**
- `REQUIRE_PREVIEW = "false"` and `PREVIEW_CHAT_ID = ""`.
- `VIP_CHANNEL_ID` = the real VIP channel ID. You confirm it; it is not in this repository.
- `BOT_TOKEN`: set by you as a secret.
- Admin password: new and different from staging.

**B3. Turn on one feature: “Publish scheduled posts”**
- **Changes:** dashboard posts can go to the channels.
- **Never sends:** Cloudinary auto-posts (GitHub keeps those). Member actions and reminders stay off.
- **Verify:** one test text post to the public channel at a quiet time, then delete it.
- **Undo:** switch the feature off (within 1 minute).

**B4. Planned guard before B3**
- The Worker refuses to schedule a post within 15 minutes of 5:00 AM or 10:00 PM IST, so dashboard posts never land on top of the GitHub auto-posts.
- About 1 hour of work, plus tests.

## C. Paid media: configurable Stars pricing and optional expiry

Already built and tested in staging; production use needs B.

**C1. Manual paid media**
- **Where:** Posts & polls → New post → *Paid media (Stars)*.
- **Price:** set per post, 1–10,000 ⭐.
- **Optional:** “Delete automatically after” 5 minutes to 48 hours. Telegram only lets bots delete within 48 hours.
- Stars from paid media posted in a channel go to **the channel's** Stars balance.

**C2. Automated paid media**
- **Where:** Features & settings → *Paid media automation*.
- **Settings:**
  - default price
  - a **separate** Cloudinary folder (for example `vip_drops`; `tgpub` is refused)
  - up to 6 daily times (UTC)
  - target channel
  - optional delete-after
  - default caption
- **Per file:** set a Cloudinary context `stars=120` to override the price, and `caption=…` for its own caption.
- **Rules:**
  - The oldest unused file is posted at each time.
  - Each time slot is claimed in D1 first, so a slot can never post twice.
  - Used files are remembered in D1, never tagged in Cloudinary.
- **Turn on:** “Post paid media automatically” + “Publish scheduled posts”, and “Delete posts automatically” if expiry is used.
- **Verify in staging first:**
  - Simulation: add the Cloudinary secrets (A3) and a test folder.
  - Then preview (A2): the paid post arrives only in your private chat.
- **Undo:** switch the feature off; already-queued posts can be cancelled in Posts & polls.

## D. Member features (changes the live bot: separate approval, needs its source)

These need incoming Telegram updates, which only `shakhira-vip-bot` receives through its webhook:
- join requests
- trial and renewal reminders
- moderation
- reaction counts
- `/admin`

**D1.** You provide the live bot's source code (or approve downloading the deployed script read-only from Cloudflare).

**D2.** Smallest change: add a **service binding** from `shakhira-vip-bot` to `shakhira-admin` and forward a *copy* of selected updates. The live bot keeps answering members exactly as today.

**D3. Rollout**
- Deploy as a new version of `shakhira-vip-bot`.
- Watch `/status` and payments for 1 hour.
- **Undo:** `wrangler rollback` to the previous version (Cloudflare keeps versions).

## E. Subscriber data and payments (last)

**E1.** Read-only export of subscribers and payments from `shakhira-vip` into the dashboard's subscriber view. No writes to the live database.

**E2.** Refund helpers or manual access changes, each with its own approval.
- Prices stay 499 ⭐ / 30 days and 49 ⭐ / 3 days.

---

## Things that never change without your explicit approval
- **Live bot:** `shakhira-vip-bot`'s code, cron and webhook.
- **Its database:** `shakhira-vip`.
- **Channels:** both channels' settings, the bot's admin rights, prices and subscriptions.
- **GitHub poster:** its workflow, schedule (5 AM / 10 PM IST) and smart rotation.
- **Paid services:** no paid Cloudflare plan or add-on.
