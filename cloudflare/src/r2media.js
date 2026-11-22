// Private media storage in Cloudflare R2 (binding MEDIA). Nothing here is public: the bucket has no public
// access, files are served only through signed-in admin endpoints, and Telegram receives files as uploads.
//
// Keys are "<folder>/<file name>". Folders are key prefixes; an empty folder is kept by a ".folder" marker.
// Every operation validates keys (no "..", no leading "/", safe characters) and works on exact prefixes
// ending in "/", so a folder action can never touch a similarly named neighbour ("vip" vs "vip-old").
import { OpsError } from "./ops.js";

export const DEFAULT_FOLDERS = ["public", "public/photos", "public/videos", "public/gifs", "public/auto-post",
  "vip", "vip/photos", "vip/videos", "vip/auto-post", "paid-media", "paid-media/photos", "paid-media/videos", "drafts", "archive"];
const PROTECTED_FOLDERS = new Set(DEFAULT_FOLDERS);
const MARKER = ".folder";
const THUMBS = "_thumbs";          // hidden: "_" can't start a folder name, so users can never address it
const LOCK = "r2lock:";            // settings rows that reserve a key while it is being written
const SUMMARY_KEY = "r2:summary", SUMMARY_TTL = 600;

export const FREE_TIER_BYTES = 10 * 1024 ** 3; // R2 free tier: 10 GB-month of storage
export const LIMITS = { image: 10 * 1024 * 1024, video: 50 * 1024 * 1024 }; // Telegram Bot API upload limits
const TYPES = {
  "image/jpeg": ["image", "jpg"], "image/png": ["image", "png"], "image/webp": ["image", "webp"], "image/gif": ["gif", "gif"],
  "video/mp4": ["video", "mp4"], "video/quicktime": ["video", "mov"], "video/webm": ["video", "webm"],
};

// Default channel/workflow → folder assignments (Automations → Media sources).
export const DEFAULT_SOURCES = {
  public_photos: "public/photos", public_videos: "public/videos", public_auto: "public/auto-post",
  vip_photos: "vip/photos", vip_videos: "vip/videos", vip_auto: "vip/auto-post", paid_media: "paid-media",
};
export const SOURCE_LABELS = {
  public_photos: "Public channel photos", public_videos: "Public channel videos", public_auto: "Public automatic posts",
  vip_photos: "VIP channel photos", vip_videos: "VIP channel videos", vip_auto: "VIP automatic posts", paid_media: "Telegram Stars paid media",
};
const SOURCES_KEY = "media_sources";

// ---------- validation ----------

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9 ._()+\-]{0,99}$/;
export function cleanFolder(path) {
  const p = String(path ?? "").trim().replace(/\/+$/g, "");
  if (p.startsWith("/")) throw new OpsError("Folder paths can't start with /");
  if (!p) return "";
  const parts = p.split("/");
  if (parts.length > 6 || parts.some((s) => !SEGMENT.test(s) || s === "." || s === ".." || s.endsWith(".") || s === MARKER))
    throw new OpsError("Folder names can use letters, numbers, spaces and . _ - ( ) +, at most 6 levels");
  return parts.join("/");
}
export function cleanKey(key) {
  const k = String(key ?? "");
  const i = k.lastIndexOf("/");
  const folder = i < 0 ? "" : cleanFolder(k.slice(0, i));
  const name = cleanName(k.slice(i + 1));
  if (!folder) throw new OpsError("Files must be inside a folder");
  return `${folder}/${name}`;
}
export function cleanName(name) {
  const n = String(name ?? "").trim();
  if (!SEGMENT.test(n) || n === MARKER || n.includes("..")) throw new OpsError("File names can use letters, numbers, spaces and . _ - ( ) +");
  return n;
}
// The area a key belongs to decides which channels may use it.
export function zoneOf(key) {
  const top = String(key).split("/")[0];
  return top === "public" ? "public" : top === "vip" ? "vip" : top === "paid-media" ? "paid" : top === "drafts" ? "drafts" : top === "archive" ? "archive" : "custom";
}
// Public posts may never use VIP or paid files; paid media only from paid-media/; VIP never from paid-media/.
export function zoneAllowed(key, { target, kind }) {
  const z = zoneOf(key);
  if (kind === "paid_media") return z === "paid";
  if (z === "paid") return false;
  if (target === "public" && z === "vip") return false;
  return true;
}
export function checkMediaRef(data) {
  const url = String(data?.media_url || "");
  if (!url.startsWith("r2:")) return;
  const key = cleanKey(url.slice(3));
  if (!zoneAllowed(key, { target: data.target || "public", kind: data.kind }))
    throw new OpsError(data.kind === "paid_media" ? "Paid media must come from the paid-media folder"
      : "This file is in the VIP or paid-media area and can't be used for this channel");
}

// Content sniffing: the bytes decide the type, not the file name or the browser's claim.
export function sniff(bytes) {
  const b = bytes;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]);
    if (brand === "qt  ") return "video/quicktime";
    if (/^(heic|heix|mif1|msf1|hevc)/.test(brand)) return null; // HEIC photos: Telegram can't use them
    return "video/mp4";
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  return null;
}
export function mediaKind(type) { return TYPES[type]?.[0] || null; }

function describe(o) {
  const type = o.httpMetadata?.contentType || "application/octet-stream";
  return { key: o.key, name: o.key.slice(o.key.lastIndexOf("/") + 1), folder: o.key.slice(0, o.key.lastIndexOf("/")),
    size: o.size, type, kind: mediaKind(type), uploaded: o.uploaded ? Math.floor(new Date(o.uploaded).getTime() / 1000) : null,
    original_name: o.customMetadata?.original_name || null, source: o.customMetadata?.source || "upload" };
}

// ---------- store ----------

export class MediaStore {
  constructor(bucket, ops) {
    if (!bucket) throw new OpsError("Media storage (R2) is not connected to this Worker yet");
    this.b = bucket; this.ops = ops;
  }

  async ensureDefaults() {
    if ((await this.ops.getSetting("r2:defaults")) === "1") return;
    for (const f of DEFAULT_FOLDERS) {
      if (!(await this.b.head(`${f}/${MARKER}`))) await this.b.put(`${f}/${MARKER}`, "", { customMetadata: { folder: "1" } });
    }
    await this.ops.setSetting("r2:defaults", "1");
  }

  async #all(prefix = "") {
    const out = [];
    let cursor;
    for (let i = 0; i < 50; i++) {
      const page = await this.b.list({ prefix, cursor, include: ["httpMetadata", "customMetadata"] });
      out.push(...page.objects);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    return out;
  }

  // Folder counts and storage usage need a full listing, so they are cached (10 min) and cleared on every change.
  async #summary() {
    try {
      const c = JSON.parse((await this.ops.getSetting(SUMMARY_KEY)) || "null");
      if (c && this.ops.now() - c.at < SUMMARY_TTL) return c;
    } catch { /* rebuild */ }
    const folders = await this.#buildFolders();
    let files = 0, bytes = 0;
    for (const f of folders) { files += f.files; bytes += f.bytes; }
    const out = { at: this.ops.now(), folders, files, bytes };
    await this.ops.setSetting(SUMMARY_KEY, JSON.stringify(out));
    return out;
  }
  async dirty() { await this.ops.setSetting(SUMMARY_KEY, ""); }

  async folders() { await this.ensureDefaults(); return (await this.#summary()).folders; }

  async #buildFolders() {
    const map = new Map();
    const touch = (f) => { if (!map.has(f)) map.set(f, { path: f, files: 0, bytes: 0, protected: PROTECTED_FOLDERS.has(f) }); return map.get(f); };
    for (const o of await this.#all()) {
      if (o.key.startsWith(THUMBS + "/")) continue;
      const folder = o.key.slice(0, o.key.lastIndexOf("/"));
      if (!folder) continue;
      folder.split("/").forEach((_, i, parts) => touch(parts.slice(0, i + 1).join("/")));
      if (!o.key.endsWith("/" + MARKER)) { const f = touch(folder); f.files++; f.bytes += o.size; }
    }
    return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  // One folder (R2 delimiter listing: subfolders are not read) or, for search, everything. Newest first, paged.
  async list({ folder = "", recursive = false, q = "", kind = "", from = null, to = null, offset = 0, limit = 0 } = {}) {
    const f = cleanFolder(folder);
    const prefix = f ? f + "/" : "";
    const needle = String(q || "").toLowerCase();
    let objs;
    if (recursive) objs = await this.#all(prefix);
    else {
      objs = [];
      let cursor;
      for (let i = 0; i < 50; i++) {
        const page = await this.b.list({ prefix, delimiter: "/", cursor, include: ["httpMetadata", "customMetadata"] });
        objs.push(...page.objects);
        if (!page.truncated) break;
        cursor = page.cursor;
      }
    }
    const all = objs.filter((o) => !o.key.endsWith("/" + MARKER) && !o.key.startsWith(THUMBS + "/") && (recursive || o.key.slice(prefix.length).indexOf("/") < 0))
      .map(describe)
      .filter((m) => (!needle || m.name.toLowerCase().includes(needle) || (m.original_name || "").toLowerCase().includes(needle))
        && (!kind || m.kind === kind) && (!from || m.uploaded >= from) && (!to || m.uploaded < to))
      .sort((a, b) => (b.uploaded || 0) - (a.uploaded || 0) || a.key.localeCompare(b.key));
    if (!limit) return all;
    const start = Math.max(0, Number(offset) || 0), lim = Math.min(200, Math.max(1, Number(limit)));
    return { items: all.slice(start, start + lim), total: all.length, next: start + lim < all.length ? start + lim : null };
  }

  async usage() {
    const { files, bytes, at } = await this.#summary();
    const pct = Math.round((bytes / FREE_TIER_BYTES) * 1000) / 10;
    return { files, bytes, free_tier_bytes: FREE_TIER_BYTES, percent: pct, measured_at: at,
      warning: pct >= 90 ? "Storage is above 90% of the R2 free tier (10 GB). Archive or delete files to avoid charges."
        : pct >= 75 ? "Storage is above 75% of the R2 free tier (10 GB)." : null };
  }

  // Upload: the bytes are checked (type and Telegram size limit) before anything is stored.
  async upload(folder, filename, bytes, actor, extra = {}) {
    const f = cleanFolder(folder);
    if (!f) throw new OpsError("Choose a folder");
    const type = sniff(bytes);
    if (!type) throw new OpsError("Only JPEG, PNG, WebP, GIF, MP4, MOV or WebM files can be used with Telegram (HEIC photos: export as JPEG first)");
    const kind = mediaKind(type);
    const limit = kind === "image" ? LIMITS.image : LIMITS.video;
    if (bytes.byteLength > limit) throw new OpsError(`${kind === "image" ? "Photos" : "Videos and GIFs"} can be at most ${limit / 1048576} MB (Telegram's upload limit)`);
    const base = cleanName(String(filename || "file").replace(/[^A-Za-z0-9 ._()+\-]/g, "_").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "file")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "");
    // A free name is reserved in the database first (unique row), so parallel uploads can never pick the same key.
    const key = await this.#reserve(f, base, TYPES[type][1]);
    try {
      await this.b.put(key, bytes, { httpMetadata: { contentType: type },
        customMetadata: { original_name: String(filename || "").slice(0, 200), uploaded_by: actor, ...extra } });
      const check = await this.b.head(key);
      if (!check || check.size !== bytes.byteLength) throw new OpsError("The upload could not be verified in storage; please retry");
    } finally { await this.#release(key); }
    await this.dirty();
    await this.ops.audit(actor, "media_upload", `${key} (${bytes.byteLength} bytes)`);
    return describe({ key, size: bytes.byteLength, httpMetadata: { contentType: type }, uploaded: new Date(), customMetadata: { original_name: filename, ...extra } });
  }

  async #reserve(folder, base, ext) {
    for (let n = 1; n < 1000; n++) {
      const key = `${folder}/${base}${n === 1 ? "" : "-" + n}.${ext}`;
      const r = await this.ops.run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT DO NOTHING", LOCK + key, String(this.ops.now()));
      if (r.meta.changes !== 1) continue; // another upload is writing this name right now
      if (await this.b.head(key)) { await this.#release(key); continue; }
      return key;
    }
    throw new OpsError("Couldn't find a free file name");
  }
  async #release(key) { await this.ops.run("DELETE FROM settings WHERE key = ?", LOCK + key); }

  // Small preview images, made by the browser (no paid image service). Stored under a hidden prefix and served
  // only to signed-in admins; never listed, counted or selectable.
  async putThumb(key, bytes) {
    const k = cleanKey(key);
    if (!(await this.b.head(k))) throw new OpsError("File not found");
    const t = sniff(bytes);
    if (!["image/jpeg", "image/webp"].includes(t) || bytes.byteLength > 300 * 1024) throw new OpsError("Thumbnails must be JPEG/WebP up to 300 KB");
    await this.b.put(`${THUMBS}/${k}`, bytes, { httpMetadata: { contentType: t } });
    return { ok: true };
  }
  async getThumb(key) {
    const o = await this.b.get(`${THUMBS}/${cleanKey(key)}`);
    if (!o) throw new OpsError("No thumbnail");
    return o;
  }

  async get(key, range) {
    const k = cleanKey(key);
    const o = await this.b.get(k, range ? { range } : undefined);
    if (!o) throw new OpsError("File not found");
    return o;
  }

  // Posts that still need a file: drafts, scheduled and sending items (never touched by a move or delete).
  async usedBy(key) {
    return this.ops.all("SELECT id, status, kind FROM content_items WHERE media_url = ? AND status IN ('draft','scheduled','sending','failed')", "r2:" + key);
  }

  async #copyObject(from, to) {
    const src = await this.b.get(from);
    if (!src) throw new OpsError(`File not found: ${from}`);
    if (await this.b.head(to)) throw new OpsError(`A file named ${to} already exists`);
    await this.b.put(to, await src.arrayBuffer(), { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
    const th = await this.b.get(`${THUMBS}/${from}`);
    if (th) await this.b.put(`${THUMBS}/${to}`, await th.arrayBuffer(), { httpMetadata: th.httpMetadata });
    await this.dirty();
  }

  // Rename / move: copy, repoint unpublished posts, then remove the old object.
  async move(from, to, actor) {
    const a = cleanKey(from), b = cleanKey(to);
    if (a === b) return { key: b };
    await this.#copyObject(a, b);
    await this.ops.run("UPDATE content_items SET media_url = ? WHERE media_url = ? AND status IN ('draft','scheduled','failed','cancelled')", "r2:" + b, "r2:" + a);
    await this.b.delete(a);
    await this.b.delete(`${THUMBS}/${a}`);
    await this.ops.audit(actor, "media_move", `${a} -> ${b}`);
    return { key: b };
  }

  async copy(from, to, actor) {
    const a = cleanKey(from), b = cleanKey(to);
    await this.#copyObject(a, b);
    await this.ops.audit(actor, "media_copy", `${a} -> ${b}`);
    return { key: b };
  }

  // Permanent delete. Refused while a scheduled/draft post needs the file (cancel or change that post first).
  async remove(keys, actor) {
    const results = [];
    for (const raw of keys.slice(0, 100)) {
      let key;
      try { key = cleanKey(raw); } catch (e) { results.push({ key: raw, ok: false, error: e.message }); continue; }
      const used = await this.usedBy(key);
      if (used.length) { results.push({ key, ok: false, error: `Used by post ${used.map((u) => `#${u.id} (${u.status})`).join(", ")}. Cancel or change that post first.` }); continue; }
      const head = await this.b.head(key);
      if (!head) { results.push({ key, ok: false, error: "Already gone" }); continue; }
      try {
        await this.b.delete(key);
        if (await this.b.head(key)) throw new Error("still present after delete");
        await this.b.delete(`${THUMBS}/${key}`);
        await this.dirty();
        await this.ops.audit(actor, "media_delete", `${key} (${head.size} bytes)`);
        results.push({ key, ok: true });
      } catch (e) {
        await this.ops.audit(actor, "media_delete_failed", `${key}: ${e.message}`);
        results.push({ key, ok: false, error: `Delete failed: ${e.message}` });
      }
    }
    return results;
  }

  async createFolder(path, actor) {
    const f = cleanFolder(path);
    if (!f) throw new OpsError("Enter a folder name");
    await this.b.put(`${f}/${MARKER}`, "", { customMetadata: { folder: "1" } });
    await this.dirty();
    await this.ops.audit(actor, "media_folder_create", f);
    return { path: f };
  }

  // Renames a custom folder: moves exactly the objects under "<from>/" (at most 200).
  async renameFolder(from, to, actor) {
    const a = cleanFolder(from), b = cleanFolder(to);
    if (!a || !b || a === b) throw new OpsError("Choose a new folder name");
    if (PROTECTED_FOLDERS.has(a)) throw new OpsError("Default folders can't be renamed");
    if (b.startsWith(a + "/")) throw new OpsError("A folder can't be moved inside itself");
    const objs = await this.#all(a + "/");
    if (objs.length > 200) throw new OpsError("This folder has more than 200 files; move them in smaller groups");
    if ((await this.#all(b + "/")).length) throw new OpsError("A folder with that name already exists");
    for (const o of objs) {
      const nk = b + o.key.slice(a.length);
      if (o.key.endsWith("/" + MARKER)) { await this.b.put(nk, "", { customMetadata: { folder: "1" } }); await this.b.delete(o.key); }
      else await this.move(o.key, nk, actor);
    }
    await this.dirty();
    await this.ops.audit(actor, "media_folder_rename", `${a} -> ${b}`);
    return { path: b };
  }

  // Deletes an empty custom folder only. Files must be moved or deleted first, so nothing is lost by accident.
  async deleteFolder(path, actor) {
    const f = cleanFolder(path);
    if (!f || PROTECTED_FOLDERS.has(f)) throw new OpsError("Default folders can't be deleted");
    const objs = await this.#all(f + "/");
    if (objs.some((o) => !o.key.endsWith("/" + MARKER))) throw new OpsError("The folder isn't empty. Move or delete its files first.");
    for (const o of objs) await this.b.delete(o.key);
    await this.dirty();
    await this.ops.audit(actor, "media_folder_delete", f);
    return { ok: true };
  }
}

// ---------- folder assignments ----------

export async function mediaSources(ops) {
  let saved = {};
  try { saved = JSON.parse(await ops.getSetting(SOURCES_KEY, "{}")); } catch { /* defaults */ }
  return { ...DEFAULT_SOURCES, ...saved };
}
export async function setMediaSources(ops, data, actor) {
  const cur = await mediaSources(ops);
  for (const [k, v] of Object.entries(data || {})) {
    if (!(k in DEFAULT_SOURCES) && !/^bot\d+_(photos|videos|auto)$/.test(k)) throw new OpsError(`Unknown assignment ${k}`);
    const f = cleanFolder(v);
    if (!f) throw new OpsError("Choose a folder");
    const z = zoneOf(f + "/x");
    if (k === "paid_media" && z !== "paid") throw new OpsError("Paid media must use a folder inside paid-media/");
    if (k !== "paid_media" && z === "paid") throw new OpsError("Only paid media may use the paid-media folders");
    if (k.startsWith("public_") && z === "vip") throw new OpsError("Public channel workflows can't use VIP folders");
    cur[k] = f;
  }
  await ops.setSetting(SOURCES_KEY, JSON.stringify(cur));
  await ops.audit(actor, "media_sources", JSON.stringify(cur).slice(0, 400));
  return cur;
}

// ---------- Telegram delivery ----------

// Loads an R2 file for a Telegram upload, checking it again (type by content, size by Telegram's limit).
export async function loadForTelegram(bucket, ref, kind) {
  if (!bucket) throw new OpsError("Media storage (R2) is not connected");
  const key = cleanKey(String(ref).slice(3));
  const o = await bucket.get(key);
  if (!o) throw new OpsError(`The file ${key} no longer exists in the media library`);
  const bytes = new Uint8Array(await o.arrayBuffer());
  const type = sniff(bytes);
  const mk = mediaKind(type);
  if (!mk) throw new OpsError(`${key} is not a supported photo or video`);
  const want = kind === "photo" ? ["image"] : kind === "video" ? ["video"] : kind === "animation" ? ["gif", "video"] : ["image", "video"];
  if (!want.includes(mk)) throw new OpsError(`${key} is a ${mk === "gif" ? "GIF" : mk}, which doesn't match a ${kind} post`);
  if (bytes.byteLength > (mk === "image" ? LIMITS.image : LIMITS.video)) throw new OpsError(`${key} is over Telegram's upload limit`);
  return { blob: new Blob([bytes], { type }), type, mk, name: key.slice(key.lastIndexOf("/") + 1) };
}
