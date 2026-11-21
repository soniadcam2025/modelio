// Vercel serverless function: the same API as the Cloudflare Worker (cloudflare/src/index.js), backed by Supabase.
// Bundled by build.mjs into .vercel/output (Build Output API v3) and deployed with `vercel deploy --prebuilt`.
import { handleApi, SECURITY_HEADERS } from "../cloudflare/src/index.js";

// Plain object (not process.env) so the adapter can cache its connection on it.
const env = {};
for (const k of ["ENVIRONMENT", "REQUIRE_PREVIEW", "PREVIEW_CHAT_ID", "PUBLIC_CHANNEL", "VIP_CHANNEL_ID", "BOT_USERNAME", "POST_SLOTS_UTC",
  "AUTH_MODE", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "DASHBOARD_SECRET", "DASHBOARD_PASSWORD_HASH", "CYCLE_SECRET",
  "BOT_TOKEN", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]) {
  if (process.env[k] !== undefined) env[k] = process.env[k];
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1_000_000) throw new Error("too large"); chunks.push(c); }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    // The route rewrite passes the original /api/<path> as ?__p=<path>.
    const p = url.searchParams.get("__p");
    if (p !== null) { url.pathname = "/api/" + p; url.searchParams.delete("__p"); }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const method = req.method || "GET";
    const body = ["GET", "HEAD"].includes(method) ? undefined : await readBody(req);
    const response = await handleApi(new Request(url, { method, headers, body }), env);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("Cache-Control", "no-store");
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error("handler error", e && e.message);
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ detail: "Bad request" }));
  }
}
