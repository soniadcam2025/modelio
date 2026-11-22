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
| **L2a** | Bot & channel status (read-only) | you | In the dashboard, go to **Bots & integrations → Add bot**, paste @ShakhiraVIPBot's token and confirm with your sign-in password. The token is encrypted with the Worker key `CREDENTIALS_KEY` and is only ever shown masked. It is identified with `getMe`; its webhook is only read. With `REQUIRE_PREVIEW` on, the Worker is **locked** and sends nothing. The bot starts with automation off and no permissions. The Overview's *Bot & channels* card then shows the bot, the webhook health and both channels. | **Manage → Disconnect** (removes the dashboard's copy only). |
| **L2** | Private Telegram preview | you, then Claude | You send `/start` to @ShakhiraVIPBot and get your user ID (@userinfobot). On **both** dashboard Workers, add the secret `BOT_TOKEN` (same token as the live bot). Claude sets `PREVIEW_CHAT_ID` = your ID and redeploys, then runs `test/remote/staging-preview.mjs`: 8 test posts (text, photo, video, GIF, poll, quiz, VIP promo, paid media at 1 ⭐) arrive **only in your private chat**. | Delete `BOT_TOKEN`. |
| **L3** | Cloudinary media library | you | Go to **Bots & integrations → Cloudinary → Connect**. The credentials are tested with Cloudinary before saving, then stored encrypted and shown masked. A read-only key is best; the Worker never tags or deletes. Worker secrets, if set, take priority. | **Disconnect**. |
| **L4 ✅ done** | Real subscribers in the dashboard (read-only) | Claude | Uncomment `LIVE_DB` in `wrangler.production.toml`, deploy, switch on **member_sync**. Members, trials and 49 ⭐ trial payments appear in Subscribers. Monthly 499 ⭐ payments are made through Telegram channel subscriptions, which no bot can see; members show as *monthly* with their renewal date. The code can only run SELECT on that database. | Switch off, re-comment, deploy. |
| **L5** | Channel publishing from the dashboard | Claude | `REQUIRE_PREVIEW = "false"`, `VIP_CHANNEL_ID` = the real VIP channel ID, `ADMIN_CHAT_ID` = your ID (for alerts), deploy. Switch on **scheduled_posts**. Verify one text post at a quiet time, then delete it. Never posts the Cloudinary media of the GitHub poster, so no duplicates. | Switch the feature off (within 1 minute). |
| **L6** | Paid media, polls, promotions, expiry, automated paid media | you | Switch on one feature at a time: **poll_auto_close**, **post_expiry**, **auto_paid_media**. Automated paid media uses its own Cloudinary folder (never `tgpub`) and is claimed per slot, so it can't double-post. | Switch off. |
| **L7** | Member notifications | you | **trial_reminders** (24 h before a trial ends), **renewal_reminders** (3 days before Telegram renews 499 ⭐), and **admin_actions** (approve, decline, remove, unban, DM from the dashboard). Each reminder is sent once (recorded before sending). | Switch off. |
| **L8** | Join requests, moderation, reactions | Claude | Change the live bot, following `LIVE_BOT_INTEGRATION.md`: about 15 lines plus a service binding. Then switch on **join_requests**, **moderation** and **reaction_tracking**. | Roll back the bot version in Cloudflare. |
| **L9** | Retire Vercel staging | Claude | Delete the Vercel project once the production Worker has run for a week. | Redeploy from `vercel/` in one command. |

## Production posting: ACTIVE since 22 Nov 2026 (01:17 IST)

**Before switching on**
- The private preview was confirmed by you: post #3 reached your chat.
- Overdue posts #1 and #2 were held as drafts, not published.

**Settings**
- **Bot permissions:** @ShakhiraVIPBot may publish posts, polls and promotions only. **Paid media** and **member actions** are off.
- **Features on:** `scheduled_posts` (plus `member_sync`). All other automations, reminders, admin actions and moderation stay off.
- **Lock:** `REQUIRE_PREVIEW = "false"`.

**Test post**
- **Post:** #3 (text) to the public channel, published with explicit confirmation.
- **Result:** Telegram message ID **43**.
- **Duplicate check:** watched over 3+ further cron runs; still one post. Every send is claimed before sending, so a post can't go out twice.

**Paid media guard:** in live mode the server refuses to queue any post type the bot isn't permitted to send. Paid media therefore can't be published until its preview and a real Stars payment are tested, and you approve. Then turn on the `paid_media` permission.

**Undo**
- **Instant:** Automation → pause *Dashboard posting*.
- **Full lock:** set `REQUIRE_PREVIEW = "true"` and run `npm run deploy:production`. Posts then go only to your preview chat.

## Content management (built 21 Nov 2026): activation order

Everything below works in the dashboard now. While posting is locked, nothing reaches a channel.

1. **Connect the bot and Cloudinary**
   - **Owner:** you.
   - **Where:** Bots & integrations → Add bot (@ShakhiraVIPBot's token) and Cloudinary → Connect.
   - **Effect:** uploads and the media library start working.
2. **Private preview**
   - **Owner:** you.
   - **Steps:**
     1. Send `/start` to @ShakhiraVIPBot from your own account.
     2. In Automation → Private preview chat, enter your Telegram user ID and confirm with your password.
   - **Result:** the dashboard is in **preview mode**. **Send preview to me** and every scheduled post go only to your chat. Members receive nothing, and member actions and reminders stay off.
3. **Your check**
   - **Owner:** you.
   - **Steps:** create one post of each type and use **Send preview to me**:
     - text, photo, video, GIF, poll, quiz, VIP promo
     - paid media at 1 ⭐, with protected content on
   - **Check:** the paid media shows "⭐ unlock" and can't be forwarded.
4. **Production switch**
   - **Owner:** Claude, after you approve in writing.
   - **Steps:**
     1. Set `REQUIRE_PREVIEW = "false"` in `wrangler.production.toml` and deploy.
     2. In the dashboard, switch on **scheduled_posts**. Switch on **poll_auto_close**, **post_expiry** and **auto_paid_media** only if wanted.
   - **Confirmation:** every real **Publish now**, **Schedule** and **Retry** asks for confirmation, and the server rejects unconfirmed requests in live mode.
   - **Not affected:** reminders, member actions and member-changing features stay locked by their own switches and the primary bot's `member_actions` permission.
   - **Undo:** Automation → pause *Dashboard posting* (instant), or redeploy with `REQUIRE_PREVIEW = "true"`.
5. **GitHub poster pause switch (optional)**
   - **Owner:** you.
   - **Step:** add the GitHub secret `POSTER_CONTROL_URL` = `<dashboard URL>/api/public/automation`.
   - **Effect:** Automation → *GitHub auto-poster* then pauses or resumes the 5 AM / 10 PM job.
   - **Fail-safe:** if the dashboard is unreachable, the job posts as normal.

**Paid media is not view-once**
- Telegram's native paid media (`sendPaidMedia`) lets everyone who paid open it again at any time.
- *Protected content* stops forwarding and saving in Telegram apps, but not screenshots or screen recording.
- *Delete automatically after* (up to 48 hours) removes the post from the channel.

## Bots & integrations (multi-bot)

**What it does**
- **Adding bots:** each bot is added by its token and identified with `getMe`.
- **Webhooks:** they are only ever *read*, with `getWebhookInfo`, and never set or deleted. The dashboard never receives updates.
- **Per-bot settings:** each bot has its own automation switch, permissions (posts, polls, promotions, paid media; member actions for the primary bot only), assigned channels and history.

**Isolation between bots**
- A channel can belong to only one bot.
- A bot's posts can only target its own channels, and only go out when that bot's switch and the matching permission are on.
- The staging lock and preview chat apply to every bot.

**Credential security**
- Tokens and Cloudinary secrets are encrypted with AES-256-GCM using the Worker secret `CREDENTIALS_KEY`. That key is a different value per Worker and is never stored in Supabase.
- Each ciphertext is bound to its own record, so a ciphertext copied onto another record won't decrypt.
- Every credential change needs a fresh sign-in password.
- Credentials never appear in API responses, logs, backups or this repository; tests check this.

**If `CREDENTIALS_KEY` is lost or rotated:** saved credentials can't be decrypted. Re-enter them with **Replace token** or **Update**; nothing else is affected.

**Rollback**
- **Configuration:** backups include the encrypted configuration, and restoring them brings back the previous tokens (tested).
- **Worker versions:** rollback was drilled on staging on 21 Nov 2026.

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

## Telegram-only dashboard and photo fix (22 Nov 2026)

**My.Club removed** from the dashboard at the owner's request: no menus, pages, routes or API. Its saved data stays in the `myclub:workspace` setting (in every backup); `src/myclub.js` is kept, unused, for a possible restore.

**Navigation:** Overview · Publishing (Create post, Scheduled posts, Calendar, Media library, Paid media) · VIP audience (Subscribers, Join requests, Moderation) · Automation (Automations, Features & settings, Bots & channels) · Analytics · System (Security & backups, Activity log). Old links still work.

**Photo posts (`sendPhoto: failed to get HTTP URL content`):**
- **Root cause (checked 22 Nov 2026):** the Cloudinary account `m4upuaai` now refuses public delivery. Every `res.cloudinary.com` image answers **HTTP 401, `x-cld-error: ACL deny`**, including photos that posted fine on 21 Nov. Telegram downloads photo links itself, so it gets the 401 and reports this error.
- **Fix:**
  1. Cloudinary photos are requested as a JPEG of at most 2560 px.
  2. If Telegram refuses the link (400), the Worker downloads the image itself: first the public link, then Cloudinary's **signed Admin-API download** using the dashboard's own Cloudinary keys, which isn't affected by the delivery restriction.
  3. It checks the real bytes (JPEG/PNG/WebP/GIF, ≤ 10 MB) and uploads the file. The same applies to paid-media photos and private previews.
- **No duplicates:** a 400 means nothing was posted, so the fallback can't post twice.
- **No automatic retries:** failed posts are never retried automatically; use **Retry**.

## Private media library on Cloudflare R2 (built 22 Nov 2026; activation pending)

**Storage:**
- Two private R2 buckets: `shakhira-media` (production) and `shakhira-media-staging` (staging, so tests can never touch production files).
- Both are bound to the Worker as `MEDIA`, with no public access and no r2.dev URL.
- Files are served only by signed-in routes (`/api/media/file`, `Cache-Control: no-store`), and reach Telegram as multipart uploads.

**Folders:** `public/{photos,videos,gifs,auto-post}`, `vip/{photos,videos,auto-post}`, `paid-media/{photos,videos}`, `drafts`, `archive`.
- These are created automatically, and default folders can't be renamed or deleted.
- Custom folders: only empty ones can be deleted, and renames move at most 200 exactly-prefixed objects.

**Separation (enforced on the server):**
- Public posts can't use `vip/` or `paid-media/` files.
- VIP posts can't use `paid-media/` files.
- Paid media must come from `paid-media/`.
- The same rules apply to Automations → Media sources.

**Uploads:**
- The file type is checked from the bytes: JPEG, PNG, WebP, GIF, MP4, MOV and WebM; HEIC is refused.
- Size limits: photos ≤ 10 MB, videos and GIFs ≤ 50 MB (Telegram's upload limits).

**Deletion:**
- One confirmation; the object is removed from R2 and re-checked.
- Every deletion goes to the audit log.
- Refused while a draft, scheduled or failed post still uses the file.

**Automatic posts from R2:**
- Feature `r2_autopost`. Rotation: new files first, then the file posted longest ago after a 30-day cooldown; one claim per slot.
- Public automatic posts stay inactive until "GitHub auto-poster switched off" is confirmed, so a slot can never be posted twice.

**Cloudinary → R2 copy:**
- Runs automatically on the cron, 2 files a minute, once `MEDIA` and the Cloudinary keys are both present.
- It only copies, and uses Cloudinary's signed download (public delivery returns 401 ACL deny). Copies are verified by size and type, and SHA-256 is stored.
- Unpublished posts are repointed to the copies, and the GitHub poster's rotation history is carried over.
- Files that can't be copied are listed in Media library for re-upload. Nothing in Cloudinary is deleted.

**Still on Cloudinary until handover:**
- The GitHub 5 AM / 10 PM poster (`poster/`, `post-to-channel.yml`).
- The migration's read-only credentials.

**Handover steps:**
1. Copy finished.
2. Private previews checked.
3. Switch on `r2_autopost`.
4. Tick "GitHub auto-poster switched off".
5. Disable the `post-to-channel.yml` schedule.
6. Remove the Cloudinary keys.

**Rollback:** roll the Worker back to the previous version. The R2 copies remain, and Cloudinary is untouched.
