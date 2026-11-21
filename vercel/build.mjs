// Builds .vercel/output (Vercel Build Output API v3): static dashboard + one Node function for /api/*.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { SECURITY_HEADERS } from "../cloudflare/src/index.js";

const out = new URL("./.vercel/output/", import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out + "static", { recursive: true });
for (const f of ["index.html", "app.js", "styles.css"]) cpSync(new URL(`../dashboard/static/${f}`, import.meta.url).pathname, out + "static/" + f);

const fn = out + "functions/api/index.func/";
mkdirSync(fn, { recursive: true });
await build({ entryPoints: [new URL("./entry.mjs", import.meta.url).pathname], bundle: true, platform: "node", format: "esm",
  target: "node20", outfile: fn + "index.mjs", logLevel: "warning" });
writeFileSync(fn + ".vc-config.json", JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 60, regions: ["bom1"] }, null, 2));

const headers = { ...SECURITY_HEADERS };
writeFileSync(out + "config.json", JSON.stringify({
  version: 3,
  routes: [
    { src: "/(.*)", headers, continue: true },
    { src: "/", headers: { "cache-control": "no-cache" }, continue: true },
    { src: "/api/(.*)", dest: "/api/index?__p=$1" },
    { handle: "filesystem" },
  ],
}, null, 2));
console.log("built", out);
