// Copies the dashboard frontend (shared with the Python version) into ./public for Workers Static Assets.
import { cpSync, mkdirSync, rmSync } from "node:fs";
rmSync("public", { recursive: true, force: true });
mkdirSync("public/static", { recursive: true });
cpSync("../dashboard/static/index.html", "public/index.html");
for (const f of ["app.js", "styles.css"]) cpSync(`../dashboard/static/${f}`, `public/static/${f}`);
console.log("Built public/ from dashboard/static");
