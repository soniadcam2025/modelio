// My.Club workspace. My.Club has no public, documented API for authentication or publishing (checked
// 22 Nov 2026), so nothing here calls My.Club. The dashboard keeps My.Club drafts, a content plan,
// manual subscriber/analytics snapshots and export packages for use in My.Club's own planner.
//
// Isolation from Telegram: everything lives under its own settings key ("myclub:workspace"), the
// Telegram scheduler never reads it, and no Telegram bot, channel, token or permission is referenced.
// No My.Club password or token is ever stored. The settings table is already in every backup.
import { OpsError } from "./ops.js";

export const MYCLUB_KEY = "myclub:workspace";
export const MYCLUB_STATUSES = ["draft", "ready", "exported", "scheduled_in_myclub", "published", "archived"];
export const MYCLUB_KINDS = ["post", "paid", "story", "message"];
const MAX_ITEMS = 500, MAX_METRICS = 400;

const clean = (v, max) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const httpsUrl = (u) => { const s = clean(u, 600); if (!s) return ""; if (!/^https:\/\/[^\s]+$/i.test(s)) throw new OpsError("Links must start with https://"); return s; };

function empty() {
  return { connection: { profile_url: "", handle: "", notes: "", connected_at: null }, items: [], metrics: [], next_id: 1 };
}

export class MyClubStore {
  constructor(ops) { this.ops = ops; }

  async load() {
    const raw = await this.ops.getSetting(MYCLUB_KEY);
    if (!raw) return empty();
    try { return { ...empty(), ...JSON.parse(raw) }; } catch { return empty(); }
  }
  async save(ws) { await this.ops.setSetting(MYCLUB_KEY, JSON.stringify(ws)); }

  async view() {
    const ws = await this.load();
    const counts = Object.fromEntries(MYCLUB_STATUSES.map((s) => [s, ws.items.filter((i) => i.status === s).length]));
    return { ...ws, counts, api: { publishing: false, auth: false,
      note: "My.Club publishes no public API. Content is prepared here and scheduled in My.Club's own planner." } };
  }

  async setConnection(b, actor) {
    const ws = await this.load();
    const handle = clean(b.handle, 80).replace(/^@/, "");
    ws.connection = { profile_url: httpsUrl(b.profile_url), handle, notes: clean(b.notes, 1000),
      connected_at: handle || b.profile_url ? (ws.connection.connected_at || this.ops.now()) : null };
    await this.save(ws);
    await this.ops.audit(actor, "myclub_connection", handle ? `@${handle}` : "cleared");
    return ws.connection;
  }

  validate(b, prev = {}) {
    const kind = b.kind ?? prev.kind ?? "post";
    if (!MYCLUB_KINDS.includes(kind)) throw new OpsError("Unknown My.Club post type");
    const status = b.status ?? prev.status ?? "draft";
    if (!MYCLUB_STATUSES.includes(status)) throw new OpsError("Unknown status");
    const caption = clean(b.caption ?? prev.caption, 5000);
    const title = clean(b.title ?? prev.title, 140) || caption.slice(0, 60) || "Untitled";
    const media = (b.media ?? prev.media ?? []).slice(0, 20).map(httpsUrl).filter(Boolean);
    let price = b.price ?? prev.price ?? null;
    if (kind === "paid") {
      price = Number(price);
      if (!Number.isFinite(price) || price <= 0 || price > 100000) throw new OpsError("Paid content needs a price above 0");
      price = Math.round(price * 100) / 100;
    } else price = null;
    const planned = b.planned_at === undefined ? (prev.planned_at ?? null) : (b.planned_at ? Number(b.planned_at) : null);
    if (planned !== null && !Number.isFinite(planned)) throw new OpsError("Invalid planned time");
    const tags = (b.tags ?? prev.tags ?? []).slice(0, 20).map((t) => clean(t, 40).replace(/^#/, "")).filter(Boolean);
    return { kind, status, title, caption, media, price, planned_at: planned, tags, myclub_url: httpsUrl(b.myclub_url ?? prev.myclub_url) };
  }

  async create(b, actor) {
    const ws = await this.load();
    if (ws.items.length >= MAX_ITEMS) throw new OpsError("The My.Club workspace is full: archive or delete old items");
    const now = this.ops.now();
    const item = { id: ws.next_id++, ...this.validate(b), created_at: now, updated_at: now };
    ws.items.push(item);
    await this.save(ws);
    await this.ops.audit(actor, "myclub_create", `#${item.id} ${item.kind}`);
    return item;
  }

  async update(id, b, actor) {
    const ws = await this.load();
    const i = ws.items.findIndex((x) => x.id === Number(id));
    if (i < 0) throw new OpsError("Not found");
    ws.items[i] = { ...ws.items[i], ...this.validate(b, ws.items[i]), updated_at: this.ops.now() };
    await this.save(ws);
    await this.ops.audit(actor, "myclub_update", `#${id} ${ws.items[i].status}`);
    return ws.items[i];
  }

  async remove(id, actor) {
    const ws = await this.load();
    const before = ws.items.length;
    ws.items = ws.items.filter((x) => x.id !== Number(id));
    if (ws.items.length === before) throw new OpsError("Not found");
    await this.save(ws);
    await this.ops.audit(actor, "myclub_delete", `#${id}`);
  }

  // Export package to copy into My.Club's own editor/planner. Marks the item "exported" (once).
  async exportItem(id, actor) {
    const ws = await this.load();
    const item = ws.items.find((x) => x.id === Number(id));
    if (!item) throw new OpsError("Not found");
    const caption = [item.caption, item.tags.length ? item.tags.map((t) => "#" + t).join(" ") : ""].filter(Boolean).join("\n\n");
    const pkg = { platform: "my.club", title: item.title, type: item.kind, caption, media: item.media, price: item.price,
      planned_at_iso: item.planned_at ? new Date(item.planned_at * 1000).toISOString() : null,
      steps: ["Open My.Club and start a new post in its editor.", "Upload the media files listed (download them from the links).",
        "Paste the caption.", item.kind === "paid" ? `Set the price to ${item.price}.` : "Set the audience.",
        item.planned_at ? "Use My.Club's scheduler/planner for the planned time." : "Publish or schedule in My.Club.",
        "Back in this dashboard, mark the item as Scheduled in My.Club or Published."] };
    if (["draft", "ready"].includes(item.status)) { item.status = "exported"; item.updated_at = this.ops.now(); await this.save(ws); }
    await this.ops.audit(actor, "myclub_export", `#${id}`);
    return pkg;
  }

  // Manual snapshots (copied from My.Club's own statistics), since no API exposes them.
  async addMetric(b, actor) {
    const ws = await this.load();
    const n = (v) => (v === "" || v === null || v === undefined ? null : Math.max(0, Math.round(Number(v)) || 0));
    const m = { at: this.ops.now(), subscribers: n(b.subscribers), paid_subscribers: n(b.paid_subscribers), revenue: b.revenue === "" || b.revenue == null ? null : Math.max(0, Number(b.revenue) || 0),
      views: n(b.views), note: clean(b.note, 300) };
    ws.metrics = [...ws.metrics, m].slice(-MAX_METRICS);
    await this.save(ws);
    await this.ops.audit(actor, "myclub_metric", `subs ${m.subscribers ?? "-"}`);
    return m;
  }

  // Calendar entries (references only, never copies of Telegram posts).
  async calendar(start, end) {
    const ws = await this.load();
    return ws.items.filter((i) => i.planned_at && i.planned_at >= start && i.planned_at < end && i.status !== "archived")
      .map((i) => ({ platform: "myclub", id: i.id, title: i.title, kind: i.kind, status: i.status, at: i.planned_at }));
  }
}
