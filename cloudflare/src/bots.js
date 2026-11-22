// Bot registry and integrations (Settings → Bots & integrations).
// - Tokens are stored encrypted (src/crypto.js); responses only ever carry masks.
// - Bots are identified with getMe; health uses getMe + getWebhookInfo (read-only). Webhooks are never set,
//   changed or deleted, and this Worker never receives updates, so no second receiver can exist.
// - Each channel belongs to one bot (unique chat_id). A bot's posts can only go to its own channels, and only
//   when that bot's automation switch and the matching permission are on.
import { decryptSecret, encryptSecret, maskToken, maskValue } from "./crypto.js";
import { OpsError } from "./ops.js";

export const PERMISSIONS = {
  posts: "Text, photo, video and GIF posts",
  polls: "Polls and quizzes",
  promos: "VIP promotions",
  paid_media: "Stars paid media",
  member_actions: "Member actions and reminders (primary bot only)",
};
const KIND_PERMISSION = { text: "posts", photo: "posts", video: "posts", animation: "posts", poll: "polls", quiz: "polls", promo: "promos", paid_media: "paid_media" };
const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const tokenContext = (botUserId) => `bot:${botUserId}`;

async function tgGet(fetchImpl, token, method, params = {}) {
  let res;
  try {
    res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  } catch { throw new OpsError(`Telegram ${method}: network error`); }
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new OpsError(`Telegram ${method}: ${String(body?.description || res.status).slice(0, 120)}`);
  return body.result;
}

export function botAllows(bot, kind) {
  if (!bot) return true; // legacy primary path without a registered bot: governed by the feature switches only
  const p = JSON.parse(bot.permissions_json || "{}");
  return !!p[KIND_PERMISSION[kind] || "posts"];
}

export class BotStore {
  constructor(ops, env, { fetchImpl = fetch, botUsername = "ShakhiraVIPBot" } = {}) {
    this.ops = ops; this.key = env.CREDENTIALS_KEY; this.fetch = (...args) => fetchImpl(...args); this.primaryUsername = String(botUsername).toLowerCase();
  }

  // Public shape: never includes the ciphertext.
  view(b, channels = []) {
    return {
      id: b.id, bot_user_id: b.bot_user_id, username: b.username, name: b.name, token: b.token_cipher ? b.token_hint : null,
      status: b.status, is_primary: !!Number(b.is_primary), automation_enabled: !!Number(b.automation_enabled),
      permissions: JSON.parse(b.permissions_json || "{}"), webhook: JSON.parse(b.webhook_json || "{}"),
      last_check_at: b.last_check_at, last_check_ok: b.last_check_ok === null || b.last_check_ok === undefined ? null : !!Number(b.last_check_ok),
      last_error: b.last_error, channels: channels.map((c) => ({ chat_id: c.chat_id, title: c.title, kind: c.kind })),
    };
  }
  async list() {
    const [bots, channels] = await Promise.all([this.ops.all("SELECT * FROM bots ORDER BY is_primary DESC, id"), this.ops.all("SELECT * FROM bot_channels ORDER BY id")]);
    return bots.map((b) => this.view(b, channels.filter((c) => Number(c.bot_id) === Number(b.id))));
  }
  async row(id) {
    const b = await this.ops.one("SELECT * FROM bots WHERE id = ?", Number(id));
    if (!b) throw new OpsError("Bot not found");
    return b;
  }
  async get(id) {
    const b = await this.row(id);
    return this.view(b, await this.ops.all("SELECT * FROM bot_channels WHERE bot_id = ? ORDER BY id", b.id));
  }
  async audit(actor, action, botId, detail = "") {
    await this.ops.run("INSERT INTO audit_log (actor, action, detail, created_at, bot_id) VALUES (?, ?, ?, ?, ?)", actor, action, String(detail).slice(0, 500), this.ops.now(), botId);
  }

  async health(token) {
    const [me, hook] = await Promise.all([tgGet(this.fetch, token, "getMe"), tgGet(this.fetch, token, "getWebhookInfo").catch((e) => ({ error: e.message }))]);
    const webhook = hook.error ? { error: hook.error } : { set: !!hook.url, pending_updates: hook.pending_update_count ?? 0,
      last_error_at: hook.last_error_date || null, last_error: hook.last_error_message || null };
    return { me, webhook };
  }

  async add(token, actor) {
    token = String(token || "").trim();
    if (!TOKEN_RE.test(token)) throw new OpsError("That doesn't look like a bot token (123456789:ABC…)");
    const { me, webhook } = await this.health(token);
    if (!me.is_bot) throw new OpsError("That token does not belong to a bot");
    if (await this.ops.one("SELECT id FROM bots WHERE bot_user_id = ?", me.id)) throw new OpsError(`@${me.username} is already connected. Use Replace token instead.`);
    const now = this.ops.now();
    const isPrimary = String(me.username).toLowerCase() === this.primaryUsername ? 1 : 0;
    const cipher = await encryptSecret(this.key, token, tokenContext(me.id));
    const r = await this.ops.run("INSERT INTO bots (bot_user_id, username, name, token_cipher, token_hint, is_primary, webhook_json, last_check_at, last_check_ok, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)", me.id, me.username, me.first_name || "", cipher, maskToken(token), isPrimary, JSON.stringify(webhook), now, now, now);
    const id = r.meta.last_row_id;
    await this.audit(actor, "bot_add", id, `@${me.username}${isPrimary ? " (primary)" : ""}; automation off, no permissions`);
    return this.get(id);
  }

  async token(id) {
    const b = await this.row(id);
    if (b.status !== "active" || !b.token_cipher) throw new OpsError(`@${b.username} has no connected token`);
    return decryptSecret(this.key, b.token_cipher, tokenContext(b.bot_user_id));
  }

  async test(id, actor) {
    const b = await this.row(id);
    let ok = 1, error = "", webhook = JSON.parse(b.webhook_json || "{}");
    try {
      const h = await this.health(await this.token(id));
      if (Number(h.me.id) !== Number(b.bot_user_id)) throw new OpsError("Token now belongs to a different bot");
      webhook = h.webhook;
    } catch (e) { ok = 0; error = String(e.message).slice(0, 200); }
    await this.ops.run("UPDATE bots SET last_check_at = ?, last_check_ok = ?, last_error = ?, webhook_json = ?, updated_at = ? WHERE id = ?",
      this.ops.now(), ok, error, JSON.stringify(webhook), this.ops.now(), b.id);
    await this.audit(actor, "bot_test", b.id, ok ? "ok" : error);
    return this.get(id);
  }

  async replace(id, token, actor) {
    const b = await this.row(id);
    token = String(token || "").trim();
    if (!TOKEN_RE.test(token)) throw new OpsError("That doesn't look like a bot token");
    const { me, webhook } = await this.health(token);
    if (Number(me.id) !== Number(b.bot_user_id)) throw new OpsError(`That token belongs to @${me.username}, not @${b.username}. Add it as a new bot instead.`);
    const cipher = await encryptSecret(this.key, token, tokenContext(b.bot_user_id));
    await this.ops.run("UPDATE bots SET token_cipher = ?, token_hint = ?, status = 'active', webhook_json = ?, last_check_at = ?, last_check_ok = 1, last_error = '', updated_at = ? WHERE id = ?",
      cipher, maskToken(token), JSON.stringify(webhook), this.ops.now(), this.ops.now(), b.id);
    await this.audit(actor, "bot_token_replace", b.id, `@${b.username}`);
    return this.get(id);
  }

  // Removes the dashboard's copy of the token and stops this bot's automation. The bot itself, its webhook and
  // whatever already receives its updates are untouched. History, content and channels are kept.
  async disconnect(id, actor) {
    const b = await this.row(id);
    await this.ops.run("UPDATE bots SET token_cipher = '', token_hint = '', status = 'disconnected', automation_enabled = 0, updated_at = ? WHERE id = ?", this.ops.now(), b.id);
    await this.audit(actor, "bot_disconnect", b.id, `@${b.username}`);
    return this.get(id);
  }

  async setAutomation(id, enabled, actor) {
    const b = await this.row(id);
    if (enabled && (b.status !== "active" || !b.token_cipher)) throw new OpsError("Connect a token before turning automation on");
    await this.ops.run("UPDATE bots SET automation_enabled = ?, updated_at = ? WHERE id = ?", enabled ? 1 : 0, this.ops.now(), b.id);
    await this.audit(actor, enabled ? "bot_automation_on" : "bot_automation_off", b.id, `@${b.username}`);
    return this.get(id);
  }

  async setPermissions(id, perms, actor) {
    const b = await this.row(id);
    const clean = {};
    for (const k of Object.keys(PERMISSIONS)) clean[k] = !!perms?.[k];
    if (!Number(b.is_primary)) clean.member_actions = false;
    await this.ops.run("UPDATE bots SET permissions_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(clean), this.ops.now(), b.id);
    await this.audit(actor, "bot_permissions", b.id, Object.entries(clean).filter(([, v]) => v).map(([k]) => k).join(",") || "none");
    return this.get(id);
  }

  // Assign a channel: the bot itself must be able to see it (getChat with ITS token), and no other bot may own it.
  async assignChannel(id, chatId, kind, actor) {
    const b = await this.row(id);
    chatId = String(chatId || "").trim();
    if (!/^(@[A-Za-z0-9_]{5,32}|-?\d{5,20})$/.test(chatId)) throw new OpsError("Use the channel's @username or numeric ID");
    const owner = await this.ops.one("SELECT bot_id FROM bot_channels WHERE chat_id = ?", chatId);
    if (owner) throw new OpsError(Number(owner.bot_id) === Number(b.id) ? "Already assigned to this bot" : "That channel belongs to another bot");
    const token = await this.token(id);
    const chat = await tgGet(this.fetch, token, "getChat", { chat_id: chatId });
    // The bot must be an admin that can post there; otherwise publishing would fail later.
    const me = await tgGet(this.fetch, token, "getChatMember", { chat_id: chatId, user_id: Number(b.bot_user_id) });
    if (!["administrator", "creator"].includes(me.status)) throw new OpsError(`@${b.username} is not an admin of ${chat.title || chatId}`);
    if (chat.type === "channel" && me.can_post_messages === false) throw new OpsError(`@${b.username} can't post in ${chat.title || chatId}`);
    const k = ["public", "vip"].includes(kind) && Number(b.is_primary) ? kind : "channel";
    if (k !== "channel" && (await this.ops.one("SELECT id FROM bot_channels WHERE kind = ?", k))) throw new OpsError(`A ${k} channel is already assigned`);
    await this.ops.run("INSERT INTO bot_channels (bot_id, chat_id, title, kind, created_at) VALUES (?, ?, ?, ?, ?)", b.id, chatId, chat.title || chatId, k, this.ops.now());
    await this.audit(actor, "bot_channel_assign", b.id, `${chat.title || chatId} (${k})`);
    return this.get(id);
  }
  async unassignChannel(id, chatId, actor) {
    const b = await this.row(id);
    const r = await this.ops.run("DELETE FROM bot_channels WHERE bot_id = ? AND chat_id = ?", b.id, String(chatId));
    if (r.meta.changes !== 1) throw new OpsError("That channel is not assigned to this bot");
    await this.audit(actor, "bot_channel_unassign", b.id, String(chatId));
    return this.get(id);
  }

  async history(id) {
    const b = await this.row(id);
    const [audit, content] = await Promise.all([
      this.ops.all("SELECT actor, action, detail, created_at FROM audit_log WHERE bot_id = ? ORDER BY id DESC LIMIT 200", b.id),
      this.ops.all("SELECT id, kind, target, status, scheduled_at, posted_at, last_error FROM content_items WHERE bot_id = ? ORDER BY id DESC LIMIT 200", b.id),
    ]);
    return { bot: this.view(b), audit, content };
  }

  // The token the primary (@ShakhiraVIPBot) automation uses: a Worker secret wins, else the connected primary bot.
  async primaryToken(env) {
    if (env.BOT_TOKEN) return env.BOT_TOKEN;
    const p = await this.ops.one("SELECT id FROM bots WHERE is_primary = 1 AND status = 'active' AND token_cipher != ''");
    return p ? this.token(p.id).catch(() => null) : null;
  }


}
