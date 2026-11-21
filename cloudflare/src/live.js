// Read-only mirror of the live bot's D1 database (`shakhira-vip`) into the dashboard database.
//
// The live bot (`shakhira-vip-bot`) keeps:
//   members(chat_id, user_id, status, until_date, checked_at)   - last known VIP membership; until_date = Telegram
//                                                                  subscription expiry for monthly (499 ⭐) members
//   events(update_id, chat_id, user_id, status, until_date, event_date) - chat_member changes in the VIP channel
//   trial_access(user_id, expires_at, active, payment_charge_id, updated_at) - latest 49 ⭐ trial per user
// It never sees the monthly payments themselves: Telegram charges those as channel subscriptions.
//
// Nothing here can write to the live database: the binding is wrapped so only SELECT statements pass.

export const TRIAL_SECONDS = 3 * 86400;
export const TRIAL_PRICE = 49;
export const MONTHLY_PRICE = 499;
const CHUNK = 50;

export function readOnly(db) {
  if (!db) return null;
  return {
    prepare(sql) {
      if (!/^\s*select\s/i.test(sql) || /;\s*\S/.test(sql)) throw new Error("Live bot database is read-only from the dashboard");
      return db.prepare(sql);
    },
  };
}

const eventName = (status) => ({ member: "joined", left: "left", kicked: "removed", restricted: "restricted", administrator: "admin", creator: "owner" }[status] || String(status || "unknown"));

async function upsertMany(ops, head, tail, rows, width) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    const placeholders = part.map(() => `(${Array(width).fill("?").join(", ")})`).join(", ");
    await ops.run(`${head} VALUES ${placeholders} ${tail}`, ...part.flat());
  }
}

// One-way sync, incremental by the live rows' own timestamps. Returns counts.
export async function syncLiveBot(liveDb, ops, now) {
  const live = readOnly(liveDb);
  const cursor = JSON.parse((await ops.getSetting("live_sync:cursor")) || "{}");
  const since = { members: Number(cursor.members || 0), events: Number(cursor.events || 0), trials: Number(cursor.trials || 0) };

  const members = (await live.prepare("SELECT chat_id, user_id, status, until_date, checked_at FROM members WHERE checked_at > ? ORDER BY checked_at LIMIT 500").bind(since.members).all()).results || [];
  const events = (await live.prepare("SELECT update_id, chat_id, user_id, status, until_date, event_date FROM events WHERE update_id > ? ORDER BY update_id LIMIT 500").bind(since.events).all()).results || [];
  const trials = (await live.prepare("SELECT user_id, expires_at, active, payment_charge_id, updated_at FROM trial_access WHERE updated_at > ? ORDER BY updated_at LIMIT 500").bind(since.trials).all()).results || [];

  // Membership snapshot: one row per user, refreshed in place; history rows from events.
  const memberRows = [
    ...members.map((m) => [m.user_id, eventName(m.status), "live:status", m.status === "member" ? m.until_date ?? null : null, Number(m.checked_at), `live:member:${m.user_id}`]),
    ...events.map((e) => [e.user_id, eventName(e.status), "live:event", e.status === "member" ? e.until_date ?? null : null, Number(e.event_date), `live:event:${e.update_id}`]),
  ];
  await upsertMany(ops, "INSERT INTO member_events (user_id, event, invite_link_name, subscription_until, created_at, ext_id)",
    "ON CONFLICT(ext_id) DO UPDATE SET event = excluded.event, subscription_until = excluded.subscription_until, created_at = excluded.created_at",
    memberRows, 6);

  // Trials and their 49 ⭐ payments (only the latest charge per user is kept by the live bot).
  const trialRows = trials.map((t) => [t.user_id, t.payment_charge_id, Number(t.expires_at) - TRIAL_SECONDS, Number(t.expires_at),
    Number(t.active) === 1 && Number(t.expires_at) > now ? "active" : "ended"]);
  await upsertMany(ops, "INSERT INTO trials (user_id, charge_id, starts_at, expires_at, status)",
    "ON CONFLICT(charge_id) DO UPDATE SET expires_at = excluded.expires_at, status = excluded.status", trialRows, 5);
  const paymentRows = trials.map((t) => [t.payment_charge_id, t.user_id, "trial", TRIAL_PRICE, "XTR", "vip_trial_3d_v1", Number(t.updated_at), "accepted"]);
  await upsertMany(ops, "INSERT INTO payments (telegram_payment_charge_id, user_id, plan, amount, currency, payload, created_at, status)",
    "ON CONFLICT(telegram_payment_charge_id) DO NOTHING", paymentRows, 8);

  // Profiles, so every live member appears in Subscribers.
  const users = [...new Set([...members, ...events, ...trials].map((r) => r.user_id))];
  await upsertMany(ops, "INSERT INTO profiles (user_id, source, first_seen, last_seen)", "ON CONFLICT(user_id) DO NOTHING",
    users.map((u) => [u, "vip-bot", now, now]), 4);

  const next = {
    members: members.length ? Math.max(since.members, ...members.map((m) => Number(m.checked_at))) : since.members,
    events: events.length ? Math.max(since.events, ...events.map((e) => Number(e.update_id))) : since.events,
    trials: trials.length ? Math.max(since.trials, ...trials.map((t) => Number(t.updated_at))) : since.trials,
  };
  await ops.setSetting("live_sync:cursor", JSON.stringify(next));
  await ops.setSetting("live_sync:last", now);
  return { members: members.length, events: events.length, trials: trials.length };
}
