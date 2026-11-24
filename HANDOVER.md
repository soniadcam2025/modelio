# Shakhira Admin V1.0 — handover

Dashboard: https://shakhira-admin.adminhkg-ofc.workers.dev (Cloudflare Worker `shakhira-admin`)
Staging: https://shakhira-admin-staging.adminhkg-ofc.workers.dev (Worker `shakhira-admin-staging`, its own R2 bucket and database)

## Admin guide

1. **Upload photos and videos:**
   - Go to **Media library**, choose a folder on the left, then click **Upload photos or videos** or drop files onto the dashed box.
   - Up to 3 files upload at a time. Each has a progress bar, **Cancel**, and **Retry** if it fails.
   - Limits: photos up to 10 MB, videos and GIFs up to 50 MB (Telegram's upload limits).
   - A file with an existing name is saved as `-2`, `-3`; nothing is ever overwritten.
2. **Create folders:** Media library → **New folder**.
   - A plain name creates the folder inside the current one; a full path like `campaigns/december` works too.
   - Custom folders can be renamed. They can only be deleted when empty.
   - The default folders can't be renamed or deleted.
3. **Download:** open a card's **⋯** menu → **Download original**, or tick several cards → **Download**. Clicking a thumbnail opens a full-screen preview.
4. **Delete permanently:** **⋯** → **Delete permanently**, or tick several cards → **Delete**.
   - One confirmation, then the file is removed from storage and the deletion is recorded in the Activity log.
   - Files used by a draft, scheduled or failed post are refused. Cancel or change that post first.
5. **Create a Telegram post:** **Create post**, then fill in the fields from top to bottom:
   - Choose the type and channel.
   - Write the text, with optional formatting, hashtags and buttons.
   - Set the publishing options.
   - Click **Save draft**, **Send preview to me**, **Schedule** or **Publish now**.
6. **Upload media inside Create post:** in the **Media** section, click **Upload new** or drop a file.
   - It is saved straight into the folder assigned to that channel and type, for example public photo → `public/photos` and VIP video → `vip/videos`. It then appears in the Media library.
   - **Choose from library** picks an existing file. **Remove from post** only detaches it; the file stays in the library.
7. **Private preview:** **Automation → Private preview chat** must hold your own Telegram user ID (send `/start` to the bot first). Then **Send preview to me** sends the post only to you, and the post is saved as a draft.
8. **Schedule:** set **Publish at (India time)** and click **Schedule**. **Repeat** makes daily or weekly copies. "Delete automatically after" removes the post later; Telegram allows this for up to 48 hours.
9. **Automatic public posts:** upload photos or videos to `public/auto-post`. They're posted at 5 AM / 10 PM IST once the R2 automatic posts are switched on (see Cutover below):
   - new files are posted first;
   - after that, the file posted longest ago, once its 30-day cooldown has passed.
10. **Media sources:** **Automation → Media sources** sets the folder for each channel and workflow.
   - Public workflows can't use VIP or paid-media folders.
   - Paid media can only use paid-media folders.
11. **Admin account:** **System → Admin account** changes your password or email.
    - Your current password is always required. After a password change, every other browser is signed out.
    - Email changes only take effect after you click Supabase's confirmation link.

## Maintenance

| What | Where |
|---|---|
| Production configuration | `cloudflare/wrangler.production.toml` (variables, bindings). Secrets: Cloudflare → Workers → `shakhira-admin` → Settings → Variables and secrets. |
| Media storage | Cloudflare → R2 → `shakhira-media` (production) / `shakhira-media-staging`. Both private, with public `r2.dev` access disabled. Thumbnails live under the hidden `_thumbs/` prefix. |
| Database | Supabase project `shakhira-prod` (sign-in, posts, members). Daily backup at 03:10 IST to D1 `shakhira-backups`, kept 14 days. |
| Restore a backup | Dry run with `node supabase/tools/restore-backup.mjs --project <ref> --d1 shakhira-backups`, then add `--confirm`. Details in `cloudflare/PRODUCTION_PLAN.md`. |
| Roll back the dashboard | Cloudflare → Workers → `shakhira-admin` → Deployments → roll back, or `npx wrangler rollback <version> -c wrangler.production.toml`. |
| Automation failures | Dashboard **Scheduled posts** (status and error per post) and **Activity log**. Telegram alerts go to `ADMIN_CHAT_ID`. Cloudflare → Workers → `shakhira-admin` → Logs (each cron run logs `cycle {…}`). GitHub → Actions → *Post to public channel* for the old poster. |
| Free-tier usage | Storage use is shown at the top of the Media library, with warnings at 75% and 90% of 10 GB. Detailed usage is under Cloudflare → R2 → Overview (storage and operations) and Cloudflare → Workers → Overview (requests). |
| Failed Telegram post | Open **Scheduled posts** and read the error. Fix the cause: a permission, a missing file, a size limit, or the bot not being an admin of the channel. Then click **Retry**; failed posts are never resent automatically. |
| Health | `GET /api/health` (database, scheduler, backup and member-sync times). GitHub workflow *Health check* every 30 minutes, if the `HEALTH_URLS` secret is set. |

## Cutover of the 5 AM / 10 PM posts to R2 (needs owner approval)

- **Done 24 Nov 2026:** the GitHub schedule is off (`post-to-channel.yml`); the owner completes steps 2–3 in the dashboard.
- **Before the switch:** upload a few photos to `public/auto-post`.

**Switch steps (all in one sitting):**
1. Disable the GitHub workflow *Post to public channel*: GitHub → Actions → the workflow → **Disable workflow**.
2. In **Automation → Media sources → Public channel automatic posts**, tick **Post automatically** and **The old GitHub auto-poster is switched off**, then Save. Leave the times empty to keep 5 AM / 10 PM IST.
3. In **Features & settings**, switch on **Automatic posts from R2** (`r2_autopost`). **Publish scheduled posts** is already on.

**How duplicates are prevented:**
- Each slot is claimed once in the database, so at most one post per slot.
- Public automatic posts stay inactive until step 2's tick is saved.

**Rollback:** switch off `r2_autopost`, untick the box, and re-enable the GitHub workflow.
