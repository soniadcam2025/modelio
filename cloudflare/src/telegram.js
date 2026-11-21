// Send-only Telegram client for the staging/automation Worker.
//
// Safety:
// - Only the methods below can be called. getUpdates, setWebhook and deleteWebhook are impossible,
//   so this Worker can never take updates away from the live bot (which uses a webhook).
// - In staging (REQUIRE_PREVIEW) every message must go to PREVIEW_CHAT_ID; anything else is refused.
// - Without BOT_TOKEN nothing is sent at all: calls are simulated and recorded.

export const ALLOWED_METHODS = new Set([
  "sendMessage", "sendPhoto", "sendVideo", "sendAnimation", "sendPoll", "stopPoll", "sendPaidMedia", "deleteMessage",
  "approveChatJoinRequest", "declineChatJoinRequest", "banChatMember", "unbanChatMember", "getChatMember", "restrictChatMember",
]);

export class TelegramError extends Error {
  constructor(message, { code = 0, retryAfter = null, uncertain = false } = {}) {
    super(message);
    this.code = code; // Telegram error_code (400, 403, 429...) or 0 for network problems
    this.retryAfter = retryAfter;
    this.uncertain = uncertain; // the request may have reached Telegram
  }
}

// Read-only lookups for the dashboard's "Bot & channels" view. They change nothing in Telegram and are allowed
// even under the staging lock. (getWebhookInfo only reads; setWebhook/deleteWebhook remain impossible.)
export const READ_ONLY_METHODS = new Set(["getMe", "getWebhookInfo", "getChat", "getChatMemberCount", "getChatMember"]);
for (const m of READ_ONLY_METHODS) ALLOWED_METHODS.add(m);

export class SendOnlyTelegram {
  constructor({ token, previewChatId = null, requirePreview = false, fetchImpl = fetch }) {
    this.token = token || "";
    this.previewChatId = previewChatId ? String(previewChatId) : null;
    this.requirePreview = requirePreview;
    this.fetch = fetchImpl;
    this.simulated = [];
  }

  get simulating() {
    return !this.token;
  }

  async call(method, params) {
    if (!ALLOWED_METHODS.has(method)) throw new Error(`Telegram method ${method} is not allowed for this Worker`);
    if (this.requirePreview && !READ_ONLY_METHODS.has(method)) {
      if (!this.previewChatId && !this.simulating) throw new Error("Staging lock: PREVIEW_CHAT_ID is required to send anything");
      const chatBound = method.startsWith("send") || method === "deleteMessage" || method === "stopPoll";
      if (chatBound && !this.simulating && String(params.chat_id) !== this.previewChatId)
        throw new Error("Staging lock: messages may only go to the preview chat");
      if (!chatBound && !this.simulating)
        throw new Error(`Staging lock: ${method} is not allowed in staging`);
    }
    if (this.simulating) {
      this.simulated.push({ method, params });
      if (method === "stopPoll") return { total_voter_count: 0, options: [], correct_option_id: null };
      if (method === "deleteMessage") return true;
      return { message_id: null, simulated: true };
    }
    let response;
    try {
      response = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
      });
    } catch (err) {
      throw new TelegramError(`${method}: network error`, { uncertain: true });
    }
    let body = null;
    try { body = await response.json(); } catch { /* unreadable */ }
    if (body && body.ok === true) return body.result;
    const code = body?.error_code || response.status;
    const description = body?.description || `HTTP ${response.status}`;
    if (code === 429) throw new TelegramError(`${method}: rate limited`, { code, retryAfter: body?.parameters?.retry_after || 30 });
    if (response.status >= 500 || !body) throw new TelegramError(`${method}: ${description}`, { code, uncertain: true });
    throw new TelegramError(`${method}: ${description}`, { code });
  }
}
