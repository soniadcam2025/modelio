# Connecting the live bot to the dashboard (approval D2: not applied)

**Current state:**
- The live bot, Worker `shakhira-vip-bot`, is the only Telegram webhook receiver and stays so.
- These changes add a **copy** step: after the bot has handled an update exactly as it does today, it forwards that update to the dashboard Worker `shakhira-admin`.
- If the dashboard is down or slow, members notice nothing, because the copy runs in the background (`ctx.waitUntil`) and its result is ignored.

**What it enables (each still has its own switch in Features & settings):**
- join requests and the auto-approve policies
- reaction counts
- discussion-group moderation
- private-chat profiles and `/start` promo sources

## 1. Service binding and secret (Cloudflare dashboard → Workers → `shakhira-vip-bot` → Settings)

1. **Bindings → Add → Service binding:**
   - variable name `ADMIN`
   - service `shakhira-admin`
2. **Variables and Secrets → Add → Secret:**
   - name `UPDATE_SECRET`
   - the same value as the `UPDATE_SECRET` secret on `shakhira-admin`
   - Claude can set both together, or you can generate one with `openssl rand -base64 48`.

## 2. Code change in the live bot (`worker.js`): about 15 lines

Add this function near the top:

```js
async function forwardCopy(env, raw) {
  if (!env.ADMIN || !env.UPDATE_SECRET) return;
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.UPDATE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${raw}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await env.ADMIN.fetch("https://shakhira-admin/internal/update", { method: "POST", body: raw, headers: { "x-update-time": String(t), "x-update-signature": sig } }).catch(() => {});
}
```

In `fetch(request, env)`, make these changes:
1. Add `ctx` as a third parameter: `fetch(request, env, ctx)`.
2. Read the body once as text, then parse it:
   ```js
   const raw = await request.text();
   update = JSON.parse(raw);
   ```
   This replaces `update = await request.json();`.
3. Just before the final `return new Response("OK")`, add:
   ```js
   ctx.waitUntil(forwardCopy(env, raw));
   ```

Nothing else in the bot changes: payments, `/status`, trials, the 49 ⭐ / 499 ⭐ prices and the cron all stay the same.

## 3. Update types Telegram sends (only if you want join requests and reactions)

The bot receives only the update types listed in its webhook's `allowed_updates`. To add `chat_join_request` and `message_reaction_count`, its webhook is set again with the **same URL and secret token** and a longer list. This is a production change, done once, by Claude after approval:

```
allowed_updates = ["message", "pre_checkout_query", "chat_member", "chat_join_request", "message_reaction_count"]
```

## 4. Rollout and rollback

1. **Deploy:** deploy the bot as a new version: `wrangler versions upload`, then `wrangler versions deploy` at 100%. Watch `/status` and a test trial for 1 hour.
2. **Roll back:** in Cloudflare → `shakhira-vip-bot` → Deployments, roll back to the previous version (instant). The webhook URL never changes, so Telegram is unaffected.
3. **Tested:**
   - The dashboard side of this path is already tested: signature, replay protection, join policies, reactions, moderation and profiles.
   - Covered by `test/integration.test.mjs`, and against the staging Worker with signed requests.
