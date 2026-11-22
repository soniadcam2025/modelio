// One-time copy of the Cloudinary media into the private R2 library. Runs a few files per cron minute.
// It only COPIES: nothing is deleted or changed in Cloudinary. Downloads use Cloudinary's signed Admin-API
// download (the account's public delivery answers 401 "ACL deny"). Each copy is checked (size against
// Cloudinary's record, real file type) before any post is pointed at it. Posted history is not rewritten.
import { cloudinaryConfig, GITHUB_POSTER_FOLDER, listFolder, ADMIN_MEDIA_FOLDER, signParams } from "./cloudinary.js";
import { cleanName, LIMITS, mediaKind, sniff, zoneAllowed } from "./r2media.js";

export const MIGRATION_KEY = "r2_migration";
const PER_RUN = 2;

export function publicIdFromUrl(url) {
  const m = /^https:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video)\/upload\/(.+)$/.exec(String(url || ""));
  if (!m) return null;
  const parts = m[3].split("?")[0].split("/");
  while (parts.length > 1 && (parts[0].includes(",") || /^[a-z]{1,3}_[^/]+$/.test(parts[0]))) parts.shift();
  if (parts.length > 1 && /^v\d+$/.test(parts[0])) parts.shift();
  const path = decodeURIComponent(parts.join("/"));
  const dot = path.lastIndexOf(".");
  const hasExt = dot > path.lastIndexOf("/");
  return { cloud: m[1], resource_type: m[2], public_id: hasExt ? path.slice(0, dot) : path, format: hasExt ? path.slice(dot + 1).toLowerCase() : "" };
}

async function downloadUrl(cfg, a, format, now) {
  const params = { format, public_id: a.public_id, timestamp: now, type: "upload" };
  const q = new URLSearchParams({ ...params, timestamp: String(now), api_key: cfg.key, signature: await signParams(params, cfg.secret) });
  return `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}/${a.resource_type === "video" ? "video" : "image"}/download?${q}`;
}

function folderFor(a, kind) {
  const sub = (k) => (k === "image" ? "photos" : k === "gif" ? "gifs" : "videos");
  if (a.dest === "paid") return `paid-media/${kind === "image" ? "photos" : "videos"}`;
  if (a.dest === "vip") return `vip/${kind === "image" ? "photos" : "videos"}`;
  if (a.dest === "auto") return "public/auto-post";
  return `public/${sub(kind)}`;
}

async function load(ops) {
  try { return JSON.parse(await ops.getSetting(MIGRATION_KEY, "null")); } catch { return null; }
}
const save = (ops, st) => ops.setSetting(MIGRATION_KEY, JSON.stringify(st));

export async function migrationStatus(ops) {
  const st = await load(ops);
  if (!st) return { status: "not_started" };
  return { status: st.status, total: st.total || 0, copied: Object.keys(st.done || {}).length, remaining: (st.queue || []).length,
    failed: Object.entries(st.failed || {}).map(([public_id, error]) => ({ public_id, error })), started_at: st.started_at, finished_at: st.finished_at || null };
}

// Called from the cron. Returns a short summary, or null when there is nothing to do.
export async function migrateStep(env, ops, now, fetchImpl = fetch) {
  const bucket = env.MEDIA, cfg = cloudinaryConfig(env);
  if (!bucket || !cfg) return null;
  let st = await load(ops);
  if (st?.status === "done") return null;
  if (!st) {
    // Inventory: the dashboard library, the GitHub poster folder, the paid folder, and every Cloudinary link in posts.
    const queue = new Map();
    const add = (a, dest) => { if (a?.public_id && !queue.has(a.public_id)) queue.set(a.public_id, { ...a, dest }); };
    const paidFolder = (await ops.paidMediaConfig()).folder;
    for (const [folder, dest] of [[ADMIN_MEDIA_FOLDER, "public"], [GITHUB_POSTER_FOLDER, "auto"], ...(paidFolder ? [[paidFolder, "paid"]] : [])]) {
      try { for (const a of await listFolder(cfg, folder, fetchImpl)) add({ public_id: a.public_id, resource_type: a.resource_type, format: a.format, bytes: a.bytes, created_at: a.created_at,
        posted_at: Math.max(0, ...(a.tags || []).filter((t) => t.startsWith("tgbot_at_")).map((t) => Number(t.slice(9)) || 0)) || null }, dest); }
      catch (e) { /* folder missing or listing refused: reported through the content references below */ }
    }
    for (const r of await ops.all("SELECT DISTINCT media_url, kind, target FROM content_items WHERE media_url LIKE 'https://res.cloudinary.com/%'")) {
      const p = publicIdFromUrl(r.media_url);
      if (p && p.cloud === cfg.cloud) add({ public_id: p.public_id, resource_type: p.resource_type, format: p.format, bytes: null },
        r.kind === "paid_media" ? "paid" : r.target === "vip" ? "vip" : "public");
    }
    st = { status: "copying", started_at: now, total: queue.size, queue: [...queue.values()], done: {}, failed: {} };
    await save(ops, st);
    return { inventory: st.total };
  }
  const batch = st.queue.splice(0, PER_RUN);
  for (const a of batch) {
    try { st.done[a.public_id] = await copyOne(bucket, cfg, ops, a, now, fetchImpl); }
    catch (e) { st.failed[a.public_id] = String(e.message).slice(0, 200); }
  }
  if (!st.queue.length) { st.status = "done"; st.finished_at = now; }
  await save(ops, st);
  if (st.status === "done") await ops.audit("automation", "r2_migration_done", `${Object.keys(st.done).length} copied, ${Object.keys(st.failed).length} failed`);
  return { copied: batch.length, remaining: st.queue.length };
}

async function copyOne(bucket, cfg, ops, a, now, fetchImpl) {
  // Original first (size must match Cloudinary's record); HEIC and other unusable formats as JPEG.
  const attempts = [[a.format || (a.resource_type === "video" ? "mp4" : "jpg"), true], ...(a.resource_type === "image" ? [["jpg", false]] : [])];
  let bytes = null, type = null, problems = [];
  for (const [fmt, exact] of attempts) {
    const res = await fetchImpl(await downloadUrl(cfg, a, fmt, now));
    if (!res.ok) { problems.push(`${fmt}: HTTP ${res.status}`); continue; }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (exact && a.bytes && buf.byteLength !== a.bytes) { problems.push(`${fmt}: size ${buf.byteLength} ≠ ${a.bytes}`); continue; }
    const t = sniff(buf);
    if (!t) { problems.push(`${fmt}: not a Telegram-compatible file`); continue; }
    bytes = buf; type = t; break;
  }
  if (!bytes) throw new Error(`could not copy (${problems.join("; ")}) — please re-upload it in the media library`);
  const kind = mediaKind(type);
  if (bytes.byteLength > (kind === "image" ? LIMITS.image : LIMITS.video)) throw new Error("larger than Telegram's upload limit — re-upload a smaller version");
  const folder = folderFor(a, kind);
  const base = cleanName(a.public_id.split("/").pop().replace(/[^A-Za-z0-9 ._()+\-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "file");
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" }[type];
  let key = `${folder}/${base}.${ext}`;
  for (let n = 2; await bucket.head(key); n++) key = `${folder}/${base}-${n}.${ext}`;
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await bucket.put(key, bytes, { httpMetadata: { contentType: type }, customMetadata: { source: "cloudinary", original_name: a.public_id.slice(0, 200), sha256: digest } });
  const check = await bucket.head(key);
  if (!check || check.size !== bytes.byteLength) throw new Error("R2 copy could not be verified");
  // Point unpublished posts at the verified copy (posted history keeps its original link).
  for (const r of await ops.all("SELECT id, media_url, kind, target FROM content_items WHERE media_url LIKE 'https://res.cloudinary.com/%' AND status <> 'posted'")) {
    const p = publicIdFromUrl(r.media_url);
    if (p && p.cloud === cfg.cloud && p.public_id === a.public_id && zoneAllowed(key, { target: r.target, kind: r.kind }))
      await ops.run("UPDATE content_items SET media_url = ? WHERE id = ?", "r2:" + key, r.id);
  }
  // Carry the GitHub poster's rotation history over to the R2 auto-post history.
  if (a.dest === "auto" && a.posted_at) {
    let h = {};
    try { h = JSON.parse(await ops.getSetting("autopost_history:public", "{}")); } catch { /* fresh */ }
    h[key] = a.posted_at;
    await ops.setSetting("autopost_history:public", JSON.stringify(h));
  }
  await ops.audit("automation", "r2_migrate", `${a.public_id} -> ${key} (${bytes.byteLength} bytes)`);
  return key;
}
