// READ-ONLY Cloudinary access for the Worker: list a folder, never add or remove tags.
// The GitHub Actions poster owns the `tgpub` folder and its tgbot_* posting history.

const PHOTO = ["jpg", "jpeg", "png", "webp"];
const VIDEO = ["mp4"];
const GIF = ["gif"];
// Telegram limits when a file is sent BY URL (the Worker sends links, it does not upload files).
const URL_PHOTO_MAX = 5 * 1024 * 1024;
const URL_FILE_MAX = 20 * 1024 * 1024;
export const GITHUB_POSTER_FOLDER = "tgpub";
export const REUSE_COOLDOWN = 30 * 86400;

export function cloudinaryConfig(env) {
  const c = { cloud: env.CLOUDINARY_CLOUD_NAME, key: env.CLOUDINARY_API_KEY, secret: env.CLOUDINARY_API_SECRET };
  return c.cloud && c.key && c.secret ? c : null;
}

export function classify(a) {
  if ((a.type || "upload") !== "upload") return { kind: null, note: "private asset" };
  const fmt = String(a.format || "").toLowerCase();
  if (a.resource_type === "image" && PHOTO.includes(fmt)) return a.bytes <= URL_PHOTO_MAX ? { kind: "photo" } : { kind: null, note: "photo over 5 MB (Telegram's limit for links)" };
  if (a.resource_type === "image" && GIF.includes(fmt)) return a.bytes <= URL_FILE_MAX ? { kind: "animation" } : { kind: null, note: "GIF over 20 MB" };
  if (a.resource_type === "video" && VIDEO.includes(fmt)) return a.bytes <= URL_FILE_MAX ? { kind: "video" } : { kind: null, note: "video over 20 MB" };
  return { kind: null, note: `unsupported format ${fmt || "?"}` };
}

const inFolder = (a, folder) => (a.asset_folder !== undefined ? a.asset_folder === folder
  : (a.public_id || "").includes("/") ? a.public_id.slice(0, a.public_id.lastIndexOf("/")) === folder : false);

export async function listFolder(cfg, folder, fetchImpl = fetch) {
  const auth = "Basic " + btoa(`${cfg.key}:${cfg.secret}`);
  const base = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}`;
  const get = async (path) => {
    const r = await fetchImpl(base + path, { headers: { authorization: auth } });
    if (!r.ok) throw new Error(`Cloudinary ${r.status}`);
    return r.json();
  };
  let items = [];
  try {
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const page = await get(`/resources/by_asset_folder?asset_folder=${encodeURIComponent(folder)}&max_results=500&tags=true&context=true${cursor ? `&next_cursor=${cursor}` : ""}`);
      items.push(...(page.resources || []));
      if (!page.next_cursor) break;
      cursor = encodeURIComponent(page.next_cursor);
    }
  } catch {
    items = [];
  }
  if (!items.length) {
    for (const rt of ["image", "video"]) {
      const page = await get(`/resources/${rt}/upload?prefix=${encodeURIComponent(folder + "/")}&max_results=500&tags=true&context=true`);
      items.push(...(page.resources || []));
    }
  }
  return items.filter((a) => inFolder(a, folder)).map((a) => ({
    public_id: a.public_id, resource_type: a.resource_type, type: a.type || "upload", format: a.format, bytes: a.bytes || 0,
    secure_url: a.secure_url, created_at: a.created_at, tags: a.tags || [],
    caption: a.context?.custom?.caption || a.context?.caption || "",
    stars: Number(a.context?.custom?.stars || a.context?.stars || 0) || null,
  }));
}

const atTime = (tags) => Math.max(0, ...tags.filter((t) => t.startsWith("tgbot_at_")).map((t) => Number(t.slice(9)) || 0)) || null;

// Same picture of the GitHub poster's folder as `python -m poster --report`, computed read-only.
export function posterInventory(assets, now) {
  const inv = { total: assets.length, supported: 0, unsupported: 0, posted: 0, uncertain: 0, rejected: 0, remaining: 0,
    reusable_now: 0, next_reuse_at: null, unknown_time: 0 };
  for (const a of assets) {
    if (!classify(a).kind) { inv.unsupported++; continue; }
    inv.supported++;
    const t = new Set(a.tags);
    if (t.has("tgbot_uncertain")) inv.uncertain++;
    if (t.has("tgbot_rejected")) inv.rejected++;
    if (!t.has("tgbot_posted")) { if (!t.has("tgbot_uncertain") && !t.has("tgbot_rejected")) inv.remaining++; continue; }
    inv.posted++;
    if (t.has("tgbot_uncertain") || t.has("tgbot_rejected")) continue;
    const last = atTime(a.tags);
    if (!last) inv.unknown_time++;
    else if (now - last >= REUSE_COOLDOWN) inv.reusable_now++;
    else inv.next_reuse_at = Math.min(inv.next_reuse_at ?? Infinity, last + REUSE_COOLDOWN);
  }
  return inv;
}

export function libraryEntries(assets, limit = 200) {
  return [...assets].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit).map((a) => {
    const { kind, note } = classify(a);
    const t = new Set(a.tags);
    const state = t.has("tgbot_posted") ? "posted" : t.has("tgbot_uncertain") ? "uncertain" : t.has("tgbot_rejected") ? "rejected" : kind ? "queued" : "unsupported";
    return { name: a.public_id, kind: kind || a.format, state, url: a.secure_url, thumb: a.resource_type === "image" ? a.secure_url : "",
      bytes: a.bytes, created_at: a.created_at, caption: a.caption, note: note || "" };
  });
}

// ---- Direct uploads from the dashboard (signed by the Worker; the API secret never reaches the browser) ----
// Uploads land in the dashboard's own folder or the paid-media folder; `tgpub` (the GitHub auto-poster's queue)
// can receive uploads but nothing is ever deleted from it here.
export const ADMIN_MEDIA_FOLDER = "shakhira_admin";
export const UPLOAD_TAG = "shakhira_admin";

async function sha1Hex(text) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Cloudinary's signature: SHA-1 of the sorted "key=value" pairs joined with "&", followed by the API secret.
export async function signParams(params, secret) {
  const base = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  return sha1Hex(base + secret);
}
export async function uploadSignature(cfg, folder, now = Math.floor(Date.now() / 1000)) {
  const params = { asset_folder: folder, folder, tags: UPLOAD_TAG, timestamp: now };
  return { upload_url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}/auto/upload`, api_key: cfg.key,
    ...params, signature: await signParams(params, cfg.secret) };
}
export async function deleteAsset(cfg, publicId, resourceType, fetchImpl = fetch) {
  const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloud)}/resources/${resourceType === "video" ? "video" : "image"}/upload?public_ids[]=${encodeURIComponent(publicId)}`;
  const r = await fetchImpl(url, { method: "DELETE", headers: { authorization: "Basic " + btoa(`${cfg.key}:${cfg.secret}`) } });
  if (!r.ok) throw new Error(`Cloudinary ${r.status}`);
  const body = await r.json();
  return body.deleted?.[publicId] === "deleted";
}
