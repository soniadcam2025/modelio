// Shakhira admin dashboard. Plain JS, no build step. All text is inserted with textContent
// (never innerHTML), so names, captions and messages from Telegram users can't inject markup.

const state = { csrf: null, user: null, badges: {}, caps: null };
const can = (cap) => (state.caps || []).includes(cap);
const TZ = "Asia/Kolkata";
const IST_OFFSET_MS = 330 * 60 * 1000;

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren() would print "null" for empty slots; this drops them.
function put(parent, ...children) {
  parent.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return parent;
}

const svgNS = "http://www.w3.org/2000/svg";
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v);
  }
  children.flat().forEach((c) => el.append(c instanceof Node ? c : document.createTextNode(String(c))));
  return el;
}

const fmt = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtDay = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const fmtTime = new Intl.DateTimeFormat("en-IN", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const when = (ts) => (ts ? fmt.format(new Date(ts * 1000)) + " IST" : "—");
const num = (n) => new Intl.NumberFormat("en-IN").format(n || 0);

function ago(ts) {
  if (!ts) return "never";
  const secs = Math.round(Date.now() / 1000 - ts);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
  if (secs < 129600) return `${Math.round(secs / 3600)} h ago`;
  return `${Math.round(secs / 86400)} days ago`;
}

// datetime-local values are treated as India time, whatever the browser's own time zone is.
function istInputToTs(value) {
  if (!value) return null;
  const [d, t] = value.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return Math.round((Date.UTC(y, m - 1, day, hh, mm) - IST_OFFSET_MS) / 1000);
}
function tsToIstInput(ts) {
  if (!ts) return "";
  return new Date(ts * 1000 + IST_OFFSET_MS).toISOString().slice(0, 16);
}

function toast(message, bad = false) {
  const box = document.getElementById("toast");
  const el = h("div", { class: "msg" + (bad ? " bad" : "") }, message);
  box.append(el);
  setTimeout(() => el.remove(), 4000);
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  if (res.status === 401 && path !== "/api/login") { state.user = null; renderLogin(); throw new Error("Please sign in"); }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && (data.error || data.detail)) || `Request failed (${res.status})`);
  return data;
}

async function act(fn, success) {
  try { const r = await fn(); if (success) toast(success); return r; } catch (e) { toast(e.message, true); return null; }
}

const STATUS_CHIP = {
  posted: "good", scheduled: "info", simulated: "info", draft: "", sending: "warn", failed: "bad", uncertain: "warn", cancelled: "",
  approved: "good", declined: "", pending: "warn", done: "good", queued: "info",
  monthly: "good", trial: "info", left: "", none: "",
};
const chip = (status, label) => h("span", { class: "chip " + (STATUS_CHIP[status] ?? "") }, label || status);

const KIND_LABEL = {
  text: "Text", photo: "Photo", video: "Video", animation: "GIF", poll: "Poll", quiz: "Quiz",
  promo: "VIP promotion", paid_media: "Paid media (Stars)",
};

function tooltip(evt, text) {
  const tip = document.getElementById("tooltip");
  if (!text) { tip.hidden = true; return; }
  tip.textContent = text;
  tip.hidden = false;
  const x = Math.min(evt.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${evt.clientY - tip.offsetHeight - 10}px`;
}

// Single-series bar chart: one hue, thin rounded bars, recessive grid, hover tooltip, table view.
function barChart(points, { unit = "", empty = "No data yet" } = {}) {
  const wrap = h("div", { class: "chart" });
  if (!points.length) { wrap.append(h("p", { class: "empty" }, empty)); return wrap; }
  const W = 640, H = 200, padL = 36, padB = 22, padT = 8;
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = (W - padL) / points.length;
  const barW = Math.max(2, Math.min(28, step - 2));
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `Bar chart, ${points.length} bars` });
  for (const frac of [0, 0.5, 1]) {
    const y = padT + (H - padT - padB) * (1 - frac);
    svg.append(s("line", { class: "grid-line", x1: padL, x2: W, y1: y, y2: y }));
    svg.append(s("text", { class: "axis-label", x: padL - 6, y: y + 4, "text-anchor": "end" }, num(Math.round(max * frac))));
  }
  points.forEach((p, i) => {
    const bh = ((H - padT - padB) * p.value) / max;
    const x = padL + i * step + (step - barW) / 2;
    const y = H - padB - bh;
    const r = Math.min(4, barW / 2, bh);
    const path = bh > 0
      ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + barW - r} Q${x + barW},${y} ${x + barW},${y + r} V${H - padB} Z`
      : "";
    const bar = s("path", { class: "bar", d: path });
    const label = `${p.label}: ${num(p.value)}${unit}`;
    const hit = s("rect", { class: "hit", x: padL + i * step, y: padT, width: step, height: H - padT - padB,
      onmousemove: (e) => { bar.classList.add("hover"); tooltip(e, label); },
      onmouseleave: (e) => { bar.classList.remove("hover"); tooltip(e, null); } });
    svg.append(bar, hit);
    if (points.length <= 12 || i % Math.ceil(points.length / 8) === 0) {
      svg.append(s("text", { class: "axis-label", x: x + barW / 2, y: H - 6, "text-anchor": "middle" }, p.short || p.label));
    }
  });
  const table = h("table", { hidden: true }, h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", { class: "num" }, "Value"))),
    h("tbody", {}, points.map((p) => h("tr", {}, h("td", {}, p.label), h("td", { class: "num" }, num(p.value) + unit)))));
  const toggle = h("button", { class: "link small", onclick: () => { table.hidden = !table.hidden; svg.style.display = table.hidden ? "" : "none"; toggle.textContent = table.hidden ? "Show as table" : "Show as chart"; } }, "Show as table");
  wrap.append(svg, h("div", { class: "table-wrap" }, table), h("div", { class: "row end" }, toggle));
  return wrap;
}

function hbars(rows, { unit = "" } = {}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return h("div", {}, rows.map((r) => {
    const fill = h("div", { class: "fill" });
    fill.style.width = `${(100 * r.value) / max}%`;
    return h("div", { class: "hbar" }, h("span", { class: "clip" }, r.label), h("div", { class: "track" }, fill),
      h("span", { class: "num" }, num(r.value) + unit));
  }));
}

function table(columns, rows, { empty = "Nothing here yet", onRow } = {}) {
  if (!rows.length) return h("p", { class: "empty" }, empty);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, columns.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", { class: onRow ? "clickable" : "", onclick: onRow ? () => onRow(r) : null },
      columns.map((c) => h("td", { class: c.num ? "num" : "" }, c.render ? c.render(r) : (r[c.key] ?? "—"))))))));
}

function drawer(title, body) {
  closeDrawer();
  const bg = h("div", { class: "drawer-bg", onclick: closeDrawer });
  const panel = h("aside", { class: "drawer", role: "dialog", "aria-label": title },
    h("div", { class: "drawer-head" }, h("h2", {}, title), h("button", { onclick: closeDrawer, "aria-label": "Close" }, "✕")), body);
  document.body.append(bg, panel);
  document.addEventListener("keydown", escClose);
}
function escClose(e) { if (e.key === "Escape" && !document.querySelector(".composer")) closeDrawer(); }

// Full-screen, centered workspace (Create / edit post). Uses the drawer classes so closeDrawer() closes it too.
function composer(title, body) {
  closeDrawer();
  const bg = h("div", { class: "drawer-bg" });
  const close = () => { if (confirm("Close the editor? Unsaved changes are lost.")) closeDrawer(); };
  const panel = h("div", { class: "drawer composer", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "composer-top" }, h("h1", {}, title), h("button", { type: "button", onclick: close, "aria-label": "Close" }, "✕ Close")), body);
  document.body.append(bg, panel);
  document.body.classList.add("composing");
  const onKey = (e) => { if (e.key === "Escape" && document.querySelector(".composer") && !document.querySelector(".picker")) close(); };
  document.addEventListener("keydown", onKey);
  new MutationObserver((_, obs) => { if (!panel.isConnected) { document.body.classList.remove("composing"); document.removeEventListener("keydown", onKey); obs.disconnect(); } })
    .observe(document.body, { childList: true });
  panel.querySelector("select, textarea, input")?.focus();
}
function closeDrawer() {
  document.querySelectorAll(".drawer, .drawer-bg").forEach((n) => n.remove());
  document.removeEventListener("keydown", escClose);
}

const field = (label, input, hint) => h("label", { class: "field" }, label, input, hint ? h("span", { class: "hint" }, hint) : null);

// ---------- shell ----------

// Pages by route id. Old ids (content, media, bots, tg-*…) keep working as links.
const PAGES = [
  ["overview", "Overview", pageOverview],
  ["tg-create", "Create post", pageCreatePost],
  ["content", "Scheduled posts", pageContent],
  ["calendar", "Calendar", pageCalendar],
  ["media", "Media library", pageMedia],
  ["tg-paid", "Paid media", pagePaidMedia],
  ["subscribers", "VIP subscribers", pageSubscribers],
  ["joins", "Join requests", pageJoins],
  ["moderation", "Moderation", pageModeration],
  ["automation", "Automations", pageAutomation],
  ["settings", "Features & settings", pageSettings],
  ["bots", "Bots & channels", pageBots],
  ["analytics", "Analytics", pageAnalytics],
  ["security", "Security & backups", pageSecurity],
  ["account", "Admin account", pageAccount],
  ["activity", "Activity log", pageActivity],
];
// Former routes from the multi-platform layout, sent to their Telegram pages.
const ROUTE_ALIAS = { "tg-overview": "overview", library: "media", integrations: "bots" };

// Sidebar tree. Leaves are route ids; groups collapse (remembered per browser).
const NAV = [
  { id: "overview" },
  { group: "publishing", label: "Publishing", children: ["tg-create", "content", "calendar", "media", "tg-paid"] },
  { group: "audience", label: "VIP audience", children: ["subscribers", "joins", "moderation"] },
  { group: "automation", label: "Automation", children: ["automation", "settings", "bots"] },
  { id: "analytics" },
  { group: "system", label: "System", children: ["account", "security", "activity"] },
];
const NAV_LABEL = {};
const pageVisible = (id) => (id !== "bots" || can("bots")) && (id !== "automation" || can("content_v2"));

function navOpenState() { try { return JSON.parse(localStorage.getItem("nav_open") || "{}"); } catch { return {}; } }
function setNavOpen(group, open) { const o = navOpenState(); o[group] = open; try { localStorage.setItem("nav_open", JSON.stringify(o)); } catch { /* private mode */ } }
const leafIds = (n) => (typeof n === "string" ? [n] : n.id ? [n.id] : n.children.flatMap(leafIds));

function navTree(nodes, active, depth = 0) {
  const saved = navOpenState();
  return nodes.map((n) => {
    if (typeof n === "string" || n.id) {
      const id = typeof n === "string" ? n : n.id;
      if (!pageVisible(id)) return null;
      const label = NAV_LABEL[id] || PAGES.find((p) => p[0] === id)?.[1] || id;
      return h("a", { href: `#${id}`, class: (id === active ? "active " : "") + `depth-${depth}`, "aria-current": id === active ? "page" : null },
        h("span", {}, label), state.badges[id] ? h("span", { class: "count" }, state.badges[id]) : null);
    }
    if (n.cap && !can(n.cap)) return null;
    const containsActive = leafIds(n).includes(active);
    const open = saved[n.group] ?? (containsActive || depth === 0);
    const kids = h("div", { class: "nav-kids", id: `nav-${n.group}`, hidden: !open }, navTree(n.children, active, depth + 1));
    const btn = h("button", { type: "button", class: `nav-group depth-${depth}` + (containsActive ? " has-active" : ""), "aria-expanded": String(open), "aria-controls": `nav-${n.group}`,
      onclick: () => { const now = btn.getAttribute("aria-expanded") !== "true"; btn.setAttribute("aria-expanded", String(now)); kids.hidden = !now; setNavOpen(n.group, now); } },
      h("span", {}, n.icon ? h("span", { class: "nav-icon", "aria-hidden": "true" }, n.icon) : null, n.label), h("span", { class: "caret", "aria-hidden": "true" }, "▸"));
    return h("div", { class: "nav-section" }, btn, kids);
  });
}

async function renderLogin(message) {
  // Supabase Auth deployments sign in with email + password; the others with the dashboard password only.
  if (state.authMode === undefined) {
    try { state.authMode = (await api("/api/health")).auth || "password"; } catch { state.authMode = "password"; }
  }
  const withEmail = state.authMode === "supabase";
  const email = withEmail ? h("input", { type: "email", autocomplete: "username", required: true, "aria-label": "Email" }) : null;
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
  const err = h("p", { class: "small", hidden: !message }, message || "");
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/login", { method: "POST", body: withEmail ? { email: email.value, password: pw.value } : { password: pw.value } });
      state.csrf = r.csrf; state.user = r.user; route();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; pw.select(); }
  } }, withEmail ? field("Email", email) : null, field("Password", pw), err, h("button", { class: "primary", type: "submit" }, "Sign in"));
  put(document.getElementById("app"), h("div", { class: "login" },
    h("div", { class: "card glass" }, h("h1", {}, "💎 Shakhira admin"), h("p", { class: "muted" }, "Sign in to manage the channels."), form)));
  (email || pw).focus();
}

function renderShell(active) {
  const close = () => document.body.classList.remove("nav-open");
  const nav = h("nav", { class: "nav", id: "sidenav", "aria-label": "Sections", onclick: (e) => { if (e.target.closest("a")) close(); } },
    h("div", { class: "brand" }, h("span", {}, "💎"), "Shakhira", h("span", { class: "brand-sub" }, "Admin")),
    navTree(NAV, active),
    h("div", { class: "nav-foot" },
      h("button", { onclick: toggleTheme }, "Light / dark"),
      h("button", { onclick: async () => { await act(() => api("/api/logout", { method: "POST" })); state.user = null; renderLogin(); } }, "Sign out")));
  const title = PAGES.find((p) => p[0] === active)?.[1] || "";
  const topbar = h("header", { class: "topbar" },
    h("button", { class: "menu-btn", "aria-label": "Open menu", "aria-controls": "sidenav", onclick: () => document.body.classList.toggle("nav-open") }, "☰"),
    h("span", { class: "brand" }, "💎 ", title));
  const scrim = h("div", { class: "scrim", onclick: close });
  const main = h("main", { class: "main", id: "main" });
  put(document.getElementById("app"), h("div", { class: "shell" }, topbar, nav, scrim, main));
  return main;
}

function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch { /* private mode */ }
}

async function route() {
  if (!state.user) {
    try { const me = await api("/api/me"); state.user = me.user; state.csrf = me.csrf; state.caps = me.capabilities || []; state.automation = me.automation; } catch { return renderLogin(); }
    if ((state.caps || []).includes("bots")) api("/api/bots").then((r) => { state.primaryBot = r.bots.find((b) => b.is_primary)?.username; }).catch(() => {});
  }
  if (state.caps === null) {
    try { const me = await api("/api/me"); state.caps = me.capabilities || []; state.automation = me.automation; } catch { state.caps = []; }
    if ((state.caps || []).includes("bots") && !state.primaryBot) api("/api/bots").then((r) => { state.primaryBot = r.bots.find((b) => b.is_primary)?.username; }).catch(() => {});
  }
  if (typeof cancelThumbs === "function") cancelThumbs();
  const raw = (location.hash || "#overview").slice(1).split(/[?/]/)[0];
  const id = ROUTE_ALIAS[raw] || raw;
  const page = PAGES.find((p) => p[0] === id) || PAGES[0];
  const main = renderShell(page[0]);
  main.append(h("p", { class: "muted" }, "Loading…"));
  try { await page[2](main); } catch (e) { put(main, h("div", { class: "banner bad" }, e.message)); }
}

const head = (title, sub, ...actions) => h("div", { class: "page-head" },
  h("div", {}, h("h1", {}, title), sub ? h("p", { class: "muted", style: null }, sub) : null), h("div", { class: "row" }, actions));

// ---------- pages ----------

async function pageOverview(main) {
  const o = await api("/api/overview");
  state.badges.joins = o.join_pending || 0;
  const offCount = Object.values(o.features).filter((f) => !f.enabled).length;
  const worker = o.worker_last_seen && Date.now() / 1000 - o.worker_last_seen < 600;
  put(main, 
    head("Overview", `Automatic posts: ${o.poster_slots_ist.join(" and ")} daily`),
    o.environment === "staging" || ["simulated", "preview", "locked"].includes(o.automation) ? h("div", { class: "banner warn" },
      `${String(o.environment || "").toUpperCase()}: ` + (o.automation === "preview"
        ? "automation sends only to the private preview chat. Nothing reaches the channels or members."
        : o.automation === "locked" ? (o.environment === "production"
          ? "read-only mode. Posting, payments and member actions are off until approved; viewing, member sync and backups are active."
          : "a bot token is set but no preview chat, so automation is paused.")
        : o.automation === "simulated" ? "automation is simulated (no bot token). Nothing is sent to Telegram."
        : "automation is live.")) : null,
    offCount === Object.keys(o.features).length
      ? h("div", { class: "banner warn" }, "All automated features are switched off. Turn them on one by one in Features & settings once the worker is running.")
      : null,
    h("div", { class: "grid kpis" },
      kpi("Stars received", num(o.stars_30d) + " ⭐", "last 30 days"),
      kpi("Monthly members", num(o.members.monthly), "known to this system"),
      kpi("Active trials", num(o.trials.active), `${num(o.trials.started)} started in 30 days`),
      kpi("Scheduled posts", num(o.scheduled_count), "waiting to publish"),
      kpi("Join requests", num(o.join_pending), "waiting for review"),
      kpi("Worker", worker ? "Running" : "Not seen", o.worker_last_seen ? `last seen ${ago(o.worker_last_seen)}` : "not started yet")),
    h("div", { class: "grid two" },
      h("section", { class: "card" }, h("h2", {}, "Stars per day"),
        barChart(o.revenue_by_day.map((r) => ({ label: r.day, short: r.day.slice(5), value: r.stars })), { unit: " ⭐", empty: "No payments recorded by this system yet" })),
      h("section", { class: "card" }, h("h2", {}, "Coming up"),
        o.upcoming.length ? h("ul", { class: "list" }, o.upcoming.map((i) => h("li", {},
          h("div", {}, h("div", { class: "clip" }, i.text || KIND_LABEL[i.kind]), h("div", { class: "small muted" }, `${KIND_LABEL[i.kind]} → ${i.target === "vip" ? "VIP channel" : "public channel"}`)),
          h("span", { class: "small" }, when(i.scheduled_at))))) : h("p", { class: "empty" }, "Nothing scheduled"))),
    can("telegram_status") ? telegramCard() : null,
    o.attention.length ? h("section", { class: "card", style: null }, h("h2", {}, "Needs attention"),
      table([{ label: "Post", render: (i) => `#${i.id} ${KIND_LABEL[i.kind]}` }, { label: "Status", render: (i) => chip(i.status) },
        { label: "Problem", render: (i) => i.last_error }], o.attention, { onRow: () => (location.hash = "#content") })) : null,
  );
}

// Bot & channels: read-only status, loaded after the page so a slow Telegram reply never delays the overview.
function telegramCard() {
  const box = h("section", { class: "card" }, h("h2", {}, "Bot & channels"), h("p", { class: "muted small" }, "Checking Telegram…"));
  api("/api/telegram").then((t) => {
    if (!t.configured) { put(box, h("h2", {}, "Bot & channels"), h("p", { class: "muted" }, "Add the BOT_TOKEN secret to this Worker to see the bot and channel status here (read-only).")); return; }
    const row = (label, value) => h("div", { class: "toggle-row" }, h("div", {}, label), value);
    const ch = (c, name) => !c ? chip("pending", "not configured") : c.error ? chip("failed", c.error) : h("span", {}, chip("posted", `${c.title}${c.members !== null ? ` · ${num(c.members)} members` : ""}`),
      h("span", { class: "small muted" }, ` reactions: ${c.reactions === "all" ? "all emoji" : Array.isArray(c.reactions) ? (c.reactions.length ? c.reactions.join(" ") : "off") : "—"}`));
    const w = t.webhook || {};
    put(box, h("h2", {}, "Bot & channels"),
      row("Bot", t.bot.error ? chip("failed", t.bot.error) : chip("posted", `@${t.bot.username}`)),
      row("Webhook (live bot)", w.error ? chip("failed", w.error) : chip(w.set && !w.last_error ? "posted" : "failed",
        w.set ? `${w.last_error ? "error: " + w.last_error : "receiving"} · ${num(w.pending_updates)} waiting` : "not set")),
      row("Public channel", ch(t.channels.public)), row("VIP channel", ch(t.channels.vip)));
  }).catch((e) => put(box, h("h2", {}, "Bot & channels"), h("p", { class: "muted" }, e.message)));
  return box;
}

const kpi = (label, value, sub) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub));

async function pageContent(main) {
  const filter = new URLSearchParams(location.hash.split("?")[1] || "").get("status") || "";
  const [items, captions] = await Promise.all([api("/api/content" + (filter ? `?status=${filter}` : "")), api("/api/captions")]);
  const tabs = h("div", { class: "tabs", role: "tablist" }, ["", "scheduled", "draft", "posted", "simulated", "failed", "uncertain"].map((st) =>
    h("button", { class: st === filter ? "active" : "", role: "tab", "aria-selected": String(st === filter),
      onclick: () => (location.hash = st ? `#content?status=${st}` : "#content") }, st ? st[0].toUpperCase() + st.slice(1) : "All")));
  put(main, 
    head("Posts & polls", "Text, media, polls, quizzes, VIP promotions and paid media for both channels", h("button", { class: "primary", onclick: () => editor() }, "New post")),
    h("section", { class: "card" }, tabs, table([
      { label: "When", render: (i) => when(i.posted_at || i.scheduled_at) },
      { label: "Type", render: (i) => h("span", {}, KIND_LABEL[i.kind], i.repeat_json ? " 🔁" : "", Number(i.protect_content) ? " 🔒" : "") },
      { label: "Channel", render: (i) => (i.target === "vip" ? "VIP" : i.target === "public" ? "Public" : String(i.target).replace("chat:", "")) },
      { label: "Content", render: (i) => h("div", { class: "clip" }, i.text || (i.use_caption_library ? "(caption from library)" : "—")) },
      { label: "Status", render: (i) => h("div", {}, chip(i.status), i.last_error ? h("div", { class: "small muted" }, i.last_error) : null) },
      { label: "", render: (i) => rowActions(i) },
    ], items, { empty: "No posts yet. Create one with New post." })),
    h("section", { class: "card", style: null }, h("h2", {}, "Caption library"),
      h("p", { class: "muted small" }, "Media posts set to “use caption library” take the least-used active caption, so captions rotate evenly."),
      captionEditor(captions)));
}

function rowActions(i) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  const btns = [];
  if (["draft", "scheduled", "failed"].includes(i.status)) btns.push(h("button", { class: "link", onclick: stop(() => editor(i)) }, "Edit"));
  if (["draft", "failed"].includes(i.status)) btns.push(h("button", { class: "link", onclick: stop(() => schedulePrompt(i)) }, "Schedule"));
  if (["draft", "scheduled", "failed"].includes(i.status)) btns.push(h("button", { class: "link danger", onclick: stop(async () => { if (await act(() => api(`/api/content/${i.id}/cancel`, { method: "POST" }), "Cancelled")) route(); }) }, "Cancel"));
  if (["draft", "cancelled"].includes(i.status)) btns.push(h("button", { class: "link danger", onclick: stop(async () => { if (confirm("Delete this post?") && await act(() => api(`/api/content/${i.id}`, { method: "DELETE" }), "Deleted")) route(); }) }, "Delete"));
  if (["poll", "quiz"].includes(i.kind) && i.status === "posted" && !i.poll_closed_at) btns.push(h("button", { class: "link", onclick: stop(async () => { if (await act(() => api("/api/actions", { method: "POST", body: { kind: "close_poll", payload: { content_id: i.id } } }), "The worker will close the poll")) route(); }) }, "Close poll"));
  if (can("content_v2")) {
    btns.push(h("button", { class: "link", onclick: stop(async () => { await act(() => api(`/api/content/${i.id}/preview`, { method: "POST" }), "Preview sent to your Telegram"); }) }, "Preview"));
    if (i.status === "failed") btns.push(h("button", { class: "link", onclick: stop(async (e) => {
      const btn = e?.currentTarget; if (btn) btn.disabled = true;
      if (await act(() => api(`/api/content/${i.id}/publish`, { method: "POST" }), "Retrying within a minute")) route(); else if (btn) btn.disabled = false;
    }) }, "Retry"));
    if (i.repeat_json || i.series_id) btns.push(h("button", { class: "link danger", onclick: stop(async () => { if (confirm("Stop this repeating post? Upcoming copies are cancelled.") && await act(() => api(`/api/content/${i.id}/stop-series`, { method: "POST" }), "Series stopped")) route(); }) }, "Stop repeating"));
  }
  btns.push(h("button", { class: "link", onclick: stop(async () => { if (await act(() => api(`/api/content/${i.id}/duplicate`, { method: "POST" }), "Copied as a draft")) route(); }) }, "Copy"));
  return h("div", { class: "row" }, btns);
}

function schedulePrompt(i) {
  const input = h("input", { type: "datetime-local", value: tsToIstInput(i.scheduled_at || Math.floor(Date.now() / 1000) + 600) });
  drawer(`Schedule post #${i.id}`, h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => api(`/api/content/${i.id}/schedule`, { method: "POST", body: { scheduled_at: istInputToTs(input.value) } }), "Scheduled")) { closeDrawer(); route(); }
  } }, field("Publish at (India time)", input), h("button", { class: "primary", type: "submit" }, "Schedule")));
}

function editor(item, preset = {}) {
  const v = item || { kind: "text", target: "public", options: ["", ""], ...preset };
  const kind = h("select", {}, Object.entries(KIND_LABEL).map(([k, l]) => h("option", { value: k, selected: k === v.kind }, l)));
  const target = h("select", {}, h("option", { value: "public", selected: v.target === "public" }, "Public channel"), h("option", { value: "vip", selected: v.target === "vip" }, "VIP channel"));
  // Other connected bots' own channels ("<bot id>|chat:<chat id>"); each bot can only post to its assigned channels.
  if (can("bots")) api("/api/bots").then(({ bots }) => {
    for (const b of bots.filter((x) => !x.is_primary && x.status === "active")) for (const ch of b.channels) {
      const value = `${b.id}|chat:${ch.chat_id}`;
      target.append(h("option", { value, selected: Number(v.bot_id) === b.id && v.target === `chat:${ch.chat_id}` }, `@${b.username} → ${ch.title}`));
    }
  }).catch(() => {});
  const targetValue = () => { const [a, b] = target.value.split("|"); return b ? { bot_id: Number(a), target: b } : { bot_id: null, target: a }; };
  const text = h("textarea", { maxlength: 4096 }); text.value = v.text || "";
  const mediaUrl = h("input", { type: "hidden", value: v.media_url || "" });
  // Media: choose from the library, or upload here (straight into R2, in the folder for this channel and type).
  // Removing the attachment only detaches it; the stored file stays in the Media library.
  const attachBox = h("div", { class: "attach" });
  const uploadStatus = h("div", { class: "upload-queue" });
  const curTarget = () => target.value.split("|").pop() === "vip" ? "vip" : "public";
  const attachProblem = () => {
    const ref = mediaUrl.value;
    if (!ref || !ref.startsWith("r2:")) return null;
    const key = ref.slice(3), k = kind.value;
    if (!allowedFor(key, { kind: k, target: curTarget() }))
      return k === "paid_media" ? "Paid media must come from a paid-media folder. Choose or upload it again." : "This file is in a VIP or paid-media folder and can't be used for this channel. Choose another file or move it first.";
    const video = isVideoRef(key), gif = /\.gif$/i.test(key);
    if (k === "photo" && (video || gif)) return "This is a video/GIF; choose a photo or change the post type.";
    if (k === "video" && !video) return "This is a photo; choose a video or change the post type.";
    if (k === "animation" && !(gif || video)) return "Choose a GIF or a short video for a GIF post.";
    return null;
  };
  function showMediaName() {
    const ref = mediaUrl.value;
    if (!ref) { put(attachBox, h("p", { class: "muted small" }, "No media attached yet.")); return; }
    const url = ref.startsWith("r2:") ? fileUrl(ref.slice(3)) : ref, problem = attachProblem();
    put(attachBox, h("div", { class: "attach-card" + (problem ? " bad" : "") },
      isVideoRef(ref) ? h("video", { src: url, controls: true, muted: true, preload: "metadata" }) : h("img", { src: url, alt: "" }),
      h("div", { class: "attach-meta" }, h("span", { class: "mono small" }, ref.startsWith("r2:") ? ref.slice(3) : ref),
        problem ? h("span", { class: "bad-text small" }, problem) : h("span", { class: "small muted" }, "Saved in the Media library"),
        h("div", { class: "row" },
          h("button", { type: "button", onclick: () => openPicker() }, "Replace"),
          h("button", { type: "button", class: "danger", onclick: () => { mediaUrl.value = ""; showMediaName(); drawPreview(); } }, "Remove from post")))));
  }
  const openPicker = () => pickMedia((ref) => { mediaUrl.value = ref; showMediaName(); drawPreview(); }, { kind: kind.value, target: curTarget() });
  async function uploadHere(file) {
    const problem = checkUpload(file);
    if (problem) { toast(`${file.name}: ${problem}`, true); return; }
    const folder = await uploadFolderFor(kind.value, target.value, file);
    const bar = h("progress", { max: 100, value: 0, class: "upload-progress" }), row = h("div", { class: "small" }, `Uploading ${file.name} to ${folder} `, bar);
    uploadStatus.replaceChildren(row);
    try {
      const r = await uploadToLibrary(file, folder, (pct) => { bar.value = pct; });
      row.replaceChildren(`✓ ${file.name} saved to ${r.key.slice(0, r.key.lastIndexOf("/"))}`);
      mediaUrl.value = "r2:" + r.key; showMediaName(); drawPreview();
    } catch (e) {
      row.replaceChildren(h("span", { class: "bad-text" }, `✕ ${file.name}: ${e.message} `), h("button", { type: "button", onclick: () => uploadHere(file) }, "Retry"));
    }
  }
  const fileInput = h("input", { type: "file", accept: ACCEPT, hidden: true, onchange: (e) => { if (e.target.files[0]) uploadHere(e.target.files[0]); e.target.value = ""; } });
  const folderHint = h("span", { class: "small muted" });
  const refreshFolderHint = async () => { folderHint.textContent = `New uploads go to ${await uploadFolderFor(kind.value, target.value, { type: kind.value === "video" ? "video/mp4" : kind.value === "animation" ? "image/gif" : "image/jpeg" })}`; };
  const dropArea = h("div", { class: "dropzone", ondragover: (e) => { e.preventDefault(); dropArea.classList.add("over"); }, ondragleave: () => dropArea.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); dropArea.classList.remove("over"); if (e.dataTransfer.files[0]) uploadHere(e.dataTransfer.files[0]); } },
    h("label", { class: "btn primary" }, "Upload new", fileInput), h("button", { type: "button", onclick: () => openPicker() }, "Choose from library"),
    h("span", { class: "small muted" }, "or drop a file here"), folderHint);
  const mediaPanel = h("div", {}, attachBox, dropArea, uploadStatus,
    h("p", { class: "small muted" }, "Photos up to 10 MB; videos and GIFs up to 50 MB. Sent to Telegram as an upload from your private storage."));
  const useLib = h("input", { type: "checkbox", checked: !!v.use_caption_library });
  const optsBox = h("div", {});
  const correct = h("select", {});
  const explanation = h("input", { maxlength: 200, value: v.explanation || "" });
  const multi = h("input", { type: "checkbox", checked: !!v.multiple_answers });
  const closeAfter = h("input", { type: "number", min: 5, placeholder: "e.g. 1440 for one day", value: v.close_after_minutes || "" });
  const stars = h("input", { type: "number", min: 1, max: 10000, value: v.star_count || "" });
  const btnText = h("input", { maxlength: 64, value: v.button_text || "" });
  const btnUrl = h("input", { type: "url", placeholder: "https://t.me/…", value: v.button_url || "" });
  const at = h("input", { type: "datetime-local", value: tsToIstInput(v.scheduled_at) });
  const expire = h("input", { type: "number", min: 5, max: 2880, placeholder: "e.g. 1440 for 24 hours", value: v.expire_after_minutes || "" });
  const hashtags = h("input", { maxlength: 420, placeholder: "#vip #newdrop", value: v.hashtags || "" });
  const protect = h("input", { type: "checkbox", checked: !!Number(v.protect_content || 0) });
  const html = h("input", { type: "checkbox", checked: v.parse_mode === "HTML" });
  let buttons = v.buttons_json ? JSON.parse(v.buttons_json) : v.button_text ? [{ text: v.button_text, url: v.button_url }] : [];
  const buttonsBox = h("div", {});
  function drawButtons() {
    put(buttonsBox, ...buttons.map((b, i) => h("div", { class: "row option-row" },
      h("input", { maxlength: 64, placeholder: "Button text", value: b.text || "", oninput: (e) => { buttons[i].text = e.target.value; drawPreview(); } }),
      h("input", { type: "url", placeholder: "https://… or https://t.me/…", value: b.url || "", oninput: (e) => { buttons[i].url = e.target.value; } }),
      h("button", { type: "button", class: "link danger", onclick: () => { buttons.splice(i, 1); drawButtons(); drawPreview(); } }, "Remove"))),
      buttons.length < 6 ? h("button", { type: "button", onclick: () => { buttons.push({ text: "", url: "" }); drawButtons(); } }, "Add button") : null);
  }
  const rule = v.repeat_json ? JSON.parse(v.repeat_json) : {};
  const repeat = h("select", {}, [["", "Once"], ["daily", "Every day"], ["weekly", "Every week"]].map(([val, l]) => h("option", { value: val, selected: (rule.every || "") === val }, l)));
  const repeatCount = h("input", { type: "number", min: 2, max: 365, placeholder: "no limit", value: rule.count || "" });
  const repeatBox = h("div", { class: "grid two" }, field("Repeat", repeat), field("Number of posts (optional)", repeatCount, "Includes the first one."));
  const previewBox = h("div", { class: "post-preview card" });
  let options = [...(v.options && v.options.length ? v.options : ["", ""])];

  function drawOptions() {
    put(optsBox, ...options.map((o, idx) => h("div", { class: "row option-row" },
      h("input", { value: o, maxlength: 100, "aria-label": `Option ${idx + 1}`, oninput: (e) => { options[idx] = e.target.value; drawCorrect(); } }),
      options.length > 2 ? h("button", { type: "button", onclick: () => { options.splice(idx, 1); drawOptions(); } }, "Remove") : null)),
      options.length < 10 ? h("button", { type: "button", onclick: () => { options.push(""); drawOptions(); } }, "Add option") : null);
    drawCorrect();
  }
  function drawCorrect() {
    const cur = correct.value || String(v.correct_option ?? 0);
    put(correct, ...options.map((o, idx) => h("option", { value: idx, selected: String(idx) === cur }, o || `Option ${idx + 1}`)));
  }
  drawOptions();

  const groups = {
    text: field("Text", text, "Up to 4,096 characters for text posts, 1,024 for captions, 300 for poll questions."),
    media: mediaPanel,
    lib: h("label", { class: "inline field" }, useLib, "Leave the caption empty and use the caption library"),
    format: h("div", {}, h("label", { class: "inline field" }, html, "Formatting (bold, italic, links with their own text)"),
      h("p", { class: "small muted" }, 'Use <b>bold</b>, <i>italic</i>, <u>underline</u>, <s>strike</s>, <tg-spoiler>spoiler</tg-spoiler>, <a href="https://…">link text</a>. Plain links and emoji work without it.')),
    poll: h("div", {}, h("h3", {}, "Options"), optsBox),
    multi: h("label", { class: "inline field" }, multi, "Allow several answers"),
    quiz: h("div", {}, field("Correct answer", correct), field("Explanation (shown after answering)", explanation)),
    close: field("Close automatically after (minutes)", closeAfter, "Results are saved for Analytics when the poll closes."),
    stars: field("Price in Stars", stars, "Each viewer unlocks it for this many Stars (Telegram's native paid media). It is NOT view-once: anyone who paid can open it again at any time. “Protected content” stops forwarding and saving in Telegram apps, but not screenshots or screen recording."),
    button: h("div", {}, h("h3", {}, "Buttons (optional, up to 6)"), buttonsBox, h("p", { class: "small muted" }, "Each button opens a link. VIP promotions without buttons get a “💎 Join VIP” button automatically.")),
  };
  let mediaSection = null, buttonsSection = null;
  function syncSections() {
    if (mediaSection) mediaSection.hidden = groups.media.hidden;
    if (buttonsSection) buttonsSection.hidden = groups.button.hidden;
  }
  function show() {
    const k = kind.value;
    const isMedia = ["photo", "video", "animation", "paid_media"].includes(k);
    groups.media.hidden = !isMedia;
    groups.lib.hidden = !isMedia || k === "paid_media";
    groups.poll.hidden = !["poll", "quiz"].includes(k);
    groups.multi.hidden = k !== "poll";
    groups.quiz.hidden = k !== "quiz";
    groups.close.hidden = !["poll", "quiz"].includes(k);
    groups.stars.hidden = k !== "paid_media";
    groups.button.hidden = ["poll", "quiz"].includes(k);
    groups.format.hidden = ["poll", "quiz"].includes(k);
    groups.text.firstChild.textContent = ["poll", "quiz"].includes(k) ? "Question" : isMedia ? "Caption" : "Text";
    syncSections();
  }
  // What the post will look like (approximate; Telegram decides the final layout).
  function drawPreview() {
    const k = kind.value, ref = mediaUrl.value.trim(), url = ref.startsWith("r2:") ? fileUrl(ref.slice(3)) : ref, isVideo = isVideoRef(ref);
    const media = ["photo", "video", "animation", "paid_media"].includes(k) && (ref.startsWith("r2:") || ref.startsWith("https://"))
      ? (isVideo ? h("video", { src: url, muted: true, controls: true, preload: "metadata" }) : h("img", { src: url, alt: "", loading: "lazy" })) : null;
    const body = ["poll", "quiz"].includes(k)
      ? h("div", {}, h("strong", {}, text.value || "Question"), h("ul", {}, options.filter(Boolean).map((o, i) => h("li", {}, o, k === "quiz" && String(i) === correct.value ? " ✓" : ""))))
      : h("div", { class: "pre" }, html.checked ? renderTelegramHtml(text.value) : text.value || (useLib.checked ? "(caption from the library)" : ""), hashtags.value ? `\n\n${hashtags.value}` : "");
    const paid = k === "paid_media";
    const shownMedia = paid && media ? h("div", { class: "paid-wrap" }, media, h("div", { class: "paid-overlay" }, h("span", {}, `⭐ Unlock for ${stars.value || "?"}`))) : media;
    if (paid && media) media.removeAttribute("controls");
    const btns = buttons.filter((b) => (b.text || "").trim());
    put(previewBox, h("div", { class: "small muted" }, `Preview · ${target.options[target.selectedIndex]?.text || ""}${html.checked ? " · formatted by Telegram" : ""}`),
      shownMedia, body,
      btns.length ? h("div", { class: "preview-buttons" }, btns.map((b) => h("div", {}, b.text))) : k === "promo" ? h("div", { class: "preview-buttons" }, h("div", {}, "💎 Join VIP")) : null,
      protect.checked ? h("div", { class: "small muted" }, "🔒 Protected: no forwarding or saving") : null,
      paid ? h("p", { class: "small muted" }, "Paid media is not view-once: after paying, viewers can open it again.") : null,
      !["poll", "quiz"].includes(k) ? h("p", { class: "small muted" }, "Reactions under the post follow the channel's own reaction settings in Telegram (shown on Overview → Bot & channels).") : null);
  }
  drawButtons();
  showMediaName();
  kind.addEventListener("change", () => { show(); drawPreview(); showMediaName(); refreshFolderHint(); });
  target.addEventListener("change", () => { showMediaName(); refreshFolderHint(); });
  refreshFolderHint();
  for (const el of [text, mediaUrl, stars, hashtags, target, protect, correct, html]) { el.addEventListener("input", drawPreview); el.addEventListener("change", drawPreview); }
  show();
  drawPreview();

  const payload = () => ({
    kind: kind.value, ...targetValue(), text: text.value, media_url: mediaUrl.value, use_caption_library: useLib.checked,
    options, correct_option: Number(correct.value || 0), explanation: explanation.value, multiple_answers: multi.checked,
    close_after_minutes: closeAfter.value || null, star_count: stars.value || null, button_text: "", button_url: "",
    buttons: buttons.filter((b) => (b.text || "").trim() || (b.url || "").trim()), parse_mode: html.checked ? "HTML" : "", scheduled_at: istInputToTs(at.value),
    ...(can("post_expiry") ? { expire_after_minutes: expire.value || null } : {}),
    ...(can("hashtags") ? { hashtags: hashtags.value } : {}),
    ...(can("content_v2") ? { protect_content: protect.checked, repeat: repeat.value ? { every: repeat.value, count: repeatCount.value || null } : null } : {}),
  });
  // mode: "draft" | "schedule" | "publish" | "preview"
  // One request at a time: every action button in the editor is disabled until the current one finishes.
  let busy = false;
  async function save(mode) {
    if (busy) return;
    busy = true;
    const buttonsEls = [...document.querySelectorAll(".composer-actions button")];
    buttonsEls.forEach((b) => { b.disabled = true; });
    try { await saveInner(mode); } finally { busy = false; buttonsEls.forEach((b) => { b.disabled = false; }); }
  }
  async function saveInner(mode) {
    const body = payload();
    if (mode === true) mode = "schedule";
    if (["photo", "video", "animation", "paid_media"].includes(body.kind)) {
      if (!body.media_url) { toast("Attach a photo or video first", true); return; }
      const problem = attachProblem();
      if (problem) { toast(problem, true); return; }
    }
    if (mode === "schedule" && !body.scheduled_at) { toast("Choose when to publish", true); return; }
    const saved = await act(async () => {
      let r = item && item.id ? await api(`/api/content/${item.id}`, { method: "PUT", body }) : await api("/api/content", { method: "POST", body });
      item = r;
      if (mode === "schedule") r = await api(`/api/content/${r.id}/schedule`, { method: "POST", body: { scheduled_at: body.scheduled_at } });
      if (mode === "publish") r = await api(`/api/content/${r.id}/publish`, { method: "POST" });
      if (mode === "preview") await api(`/api/content/${r.id}/preview`, { method: "POST" });
      return r;
    }, { draft: "Saved as draft", schedule: "Scheduled", publish: "Publishing within a minute", preview: "Preview sent to your Telegram (saved as a draft)" }[mode]);
    if (saved && mode !== "preview") { closeDrawer(); location.hash = "#content"; route(); }
  }
  const section = (title, ...kids) => h("section", { class: "card composer-section" }, h("h2", {}, title), ...kids);
  const settings = section("Publishing",
    h("div", { class: "grid two" }, field("Publish at (India time)", at, "Posts go out within about a minute of this time, once Scheduled posts is on."),
      can("post_expiry") ? field("Delete automatically after (minutes)", expire, "Optional. 5 minutes to 48 hours (Telegram's limit for bots).") : h("span")),
    can("content_v2") ? repeatBox : null,
    can("content_v2") ? h("label", { class: "inline field" }, protect, "Protected content (no forwarding or saving in Telegram apps)") : null);
  composer(item ? `Edit post #${item.id}` : "Create post", h("form", { class: "composer-form", onsubmit: (e) => { e.preventDefault(); save(true); } },
    h("div", { class: "composer-head" }, field("Post type", kind), field("Channel", target)),
    h("div", { class: "composer-body" },
      h("div", { class: "composer-main" },
        section("Content", groups.text, groups.format, groups.lib, groups.poll, groups.multi, groups.quiz, groups.close, groups.stars,
          can("hashtags") ? field("Hashtags (optional)", hashtags, "Up to 10, added on a new line at the end. Not added to polls or quizzes.") : null),
        groups.media.hidden !== undefined ? mediaSection = section("Media", groups.media) : null,
        groups.button.hidden !== undefined ? buttonsSection = section("Buttons & links", groups.button) : null,
        settings),
      can("content_v2") ? h("aside", { class: "composer-preview" }, h("h2", {}, "Preview"), previewBox) : null),
    h("div", { class: "composer-actions" },
      h("button", { type: "button", onclick: () => save("draft") }, "Save draft"),
      can("content_v2") ? h("button", { type: "button", onclick: () => save("preview") }, "Send preview to me") : null,
      h("span", { class: "spacer" }),
      h("button", { type: "submit" }, "Schedule"),
      can("content_v2") ? h("button", { type: "button", class: "primary", onclick: () => save("publish") }, "Publish now") : null)));
  syncSections();
}

function captionEditor(captions) {
  const input = h("textarea", { maxlength: 1024, placeholder: "New caption…" });
  return h("div", {},
    table([
      { label: "Caption", render: (c) => h("div", { class: "clip" }, c.text) },
      { label: "Used", key: "used_count", num: true },
      { label: "Status", render: (c) => chip(c.active ? "posted" : "cancelled", c.active ? "active" : "paused") },
      { label: "", render: (c) => h("div", { class: "row" },
        h("button", { class: "link", onclick: async () => { if (await act(() => api(`/api/captions/${c.id}`, { method: "PUT", body: { active: !c.active } }))) route(); } }, c.active ? "Pause" : "Resume"),
        h("button", { class: "link danger", onclick: async () => { if (confirm("Delete this caption?") && await act(() => api(`/api/captions/${c.id}`, { method: "DELETE" }))) route(); } }, "Delete")) },
    ], captions, { empty: "No captions yet" }),
    h("form", { onsubmit: async (e) => { e.preventDefault(); if (await act(() => api("/api/captions", { method: "POST", body: { text: input.value } }), "Caption added")) route(); } },
      field("Add a caption", input), h("button", { type: "submit" }, "Add caption")));
}

let calendarStart = null;
async function pageCalendar(main) {
  if (calendarStart === null) {
    const now = new Date(Date.now() + IST_OFFSET_MS);
    const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
    calendarStart = Math.round((monday - IST_OFFSET_MS) / 1000);
  }
  const start = calendarStart, end = start + 7 * 86400;
  const data = await api(`/api/calendar?start=${start}&end=${end}`);
  const days = [...Array(7)].map((_, d) => ({ start: start + d * 86400, items: [] }));
  const place = (ts, el) => { const d = Math.floor((ts - start) / 86400); if (d >= 0 && d < 7) days[d].items.push([ts, el]); };
  data.poster_slots.forEach((sl) => place(sl.at, h("div", { class: "cal-item auto", title: sl.label }, h("div", { class: "t" }, fmtTime.format(new Date(sl.at * 1000))), "Automatic post")));
  data.items.forEach((i) => { const ts = i.posted_at || i.scheduled_at; if (ts) place(ts, h("div", { class: "cal-item", onclick: () => (["draft", "scheduled", "failed"].includes(i.status) ? editor(i) : null) },
    h("div", { class: "t" }, fmtTime.format(new Date(ts * 1000)), " ", chip(i.status)), h("div", { class: "clip" }, `${KIND_LABEL[i.kind]} · ${i.target === "vip" ? "VIP" : "Public"} · ${i.text || ""}`))); });
  const todayIdx = Math.floor((Date.now() / 1000 - start) / 86400);
  put(main, 
    head("Calendar", "India time. Grey items are the automatic 5 AM / 10 PM posts.",
      h("button", { onclick: () => { calendarStart -= 7 * 86400; route(); } }, "← Previous week"),
      h("button", { onclick: () => { calendarStart = null; route(); } }, "This week"),
      h("button", { onclick: () => { calendarStart += 7 * 86400; route(); } }, "Next week →"),
      h("button", { class: "primary", onclick: () => editor() }, "New post")),
    h("div", { class: "cal" }, days.map((d, idx) => h("div", { class: "cal-day" + (idx === todayIdx ? " today" : "") },
      h("h4", {}, fmtDay.format(new Date(d.start * 1000 + 3600 * 1000))), d.items.sort((a, b) => a[0] - b[0]).map((x) => x[1])))));
}

async function pageSubscribers(main) {
  const q = new URLSearchParams(location.hash.split("?")[1] || "").get("q") || "";
  const people = await api("/api/subscribers?q=" + encodeURIComponent(q));
  const search = h("input", { type: "search", placeholder: "Search name, @username, ID or tag", value: q });
  put(main, 
    head("Subscribers", "Everyone this system has seen: buyers, members, join requests and people who started the bot",
      h("a", { class: "btn", href: "/api/export/subscribers.csv" }, "Export CSV")),
    h("form", { class: "row search-form", onsubmit: (e) => { e.preventDefault(); location.hash = "#subscribers?q=" + encodeURIComponent(search.value); } }, search, h("button", { type: "submit" }, "Search")),
    h("section", { class: "card", style: null }, table([
      { label: "User", render: (p) => h("div", {}, p.first_name || "—", h("div", { class: "small muted" }, p.username ? "@" + p.username : `ID ${p.user_id}`)) },
      { label: "Membership", render: (p) => chip(p.membership) },
      { label: "Until", render: (p) => when(p.subscription_until || p.trial_expires_at) },
      { label: "Stars paid", render: (p) => num(p.stars_paid), num: true },
      { label: "Tags", render: (p) => p.tags || "—" },
      { label: "Last seen", render: (p) => ago(p.last_seen) },
    ], people, { onRow: (p) => subscriberDrawer(p.user_id), empty: "Nobody yet. Profiles appear as people pay, join or message the bot." })));
}

async function subscriberDrawer(userId) {
  const p = await api(`/api/subscribers/${userId}`);
  const tags = h("input", { value: p.tags, placeholder: "vip, loyal" });
  const notes = h("textarea", {}); notes.value = p.notes;
  const dm = h("textarea", { placeholder: "Message to send from the bot" });
  const queue = (kind, payload, msg) => act(() => api("/api/actions", { method: "POST", body: { kind, payload } }), msg);
  drawer(p.first_name || (p.username ? "@" + p.username : `User ${p.user_id}`), h("div", {},
    h("p", {}, chip(p.membership), " ", h("span", { class: "mono" }, `ID ${p.user_id}`), p.username ? ` · @${p.username}` : "", p.source ? ` · came from ${p.source}` : ""),
    h("form", { onsubmit: async (e) => { e.preventDefault(); if (await act(() => api(`/api/subscribers/${userId}`, { method: "PUT", body: { tags: tags.value, notes: notes.value } }), "Saved")) subscriberDrawer(userId); } },
      field("Tags", tags, "Comma-separated"), field("Private notes", notes), h("button", { type: "submit" }, "Save")),
    h("h3", {}, "Payments"), table([{ label: "Date", render: (x) => when(x.created_at) }, { label: "Plan", key: "plan" }, { label: "Amount", render: (x) => `${x.amount} ${x.currency === "XTR" ? "⭐" : x.currency}`, num: true }, { label: "Status", render: (x) => x.status || "—" }], p.payments, { empty: "No payments recorded here" }),
    h("h3", {}, "Trials"), table([{ label: "Start", render: (x) => when(x.starts_at) }, { label: "End", render: (x) => when(x.expires_at) }, { label: "Joined", render: (x) => (x.joined_at ? "yes" : "no") }, { label: "Status", key: "status" }], p.trials, { empty: "No trials" }),
    h("h3", {}, "VIP channel history"), table([{ label: "Date", render: (x) => when(x.created_at) }, { label: "Event", key: "event" }, { label: "Link", render: (x) => x.invite_link_name || "—" }], p.events, { empty: "No events" }),
    h("h3", {}, "Actions"),
    h("p", { class: "small muted" }, "Actions are queued and carried out by the worker within about 30 seconds (Admin actions must be on)."),
    field("Send a message", dm, "Only works if they have started the bot."),
    h("div", { class: "row" },
      h("button", { onclick: () => dm.value.trim() && queue("send_dm", { user_id: userId, text: dm.value }, "Message queued") }, "Send message"),
      h("button", { class: "danger", onclick: () => confirm("Remove this person from the VIP channel? They can rejoin by paying.") && queue("remove_member", { user_id: userId }, "Removal queued") }, "Remove from VIP"),
      h("button", { onclick: () => queue("unban_member", { user_id: userId }, "Unban queued") }, "Unban"))));
}

async function pageJoins(main) {
  const status = new URLSearchParams(location.hash.split("?")[1] || "").get("status") || "pending";
  const rows = await api(`/api/join-requests?status=${status}`);
  if (status === "pending") state.badges.joins = rows.length;
  const decide = (r, kind) => act(() => api("/api/actions", { method: "POST", body: { kind, payload: { request_id: r.id } } }), kind === "approve_join" ? "Approval queued" : "Decline queued").then((x) => x && route());
  put(main, 
    head("Join requests", "Requests to join a channel that needs approval. Recording them needs the full bot (see Features & settings)."),
    h("div", { class: "tabs" }, ["pending", "approved", "declined", "all"].map((st) => h("button", { class: st === status ? "active" : "", onclick: () => (location.hash = `#joins?status=${st}`) }, st[0].toUpperCase() + st.slice(1)))),
    h("section", { class: "card" }, table([
      { label: "Requested", render: (r) => when(r.requested_at) },
      { label: "User", render: (r) => h("div", {}, r.first_name || "—", h("div", { class: "small muted" }, r.username ? "@" + r.username : `ID ${r.user_id}`)) },
      { label: "Channel ID", render: (r) => h("span", { class: "mono" }, r.chat_id) },
      { label: "Status", render: (r) => h("div", {}, chip(r.status), r.reason ? h("div", { class: "small muted" }, r.reason) : null) },
      { label: "", render: (r) => (r.status === "pending" ? h("div", { class: "row" }, h("button", { class: "primary", onclick: () => decide(r, "approve_join") }, "Approve"), h("button", { onclick: () => decide(r, "decline_join") }, "Decline")) : "") },
    ], rows, { empty: status === "pending" ? "No requests waiting" : "None" })));
}

async function pageModeration(main) {
  const m = await api("/api/moderation");
  const kind = h("select", {}, h("option", { value: "word" }, "Word or phrase"), h("option", { value: "link" }, "Link containing"));
  const pattern = h("input", { maxlength: 100, required: true, placeholder: "e.g. free crypto, bit.ly" });
  const action = h("select", {}, h("option", { value: "delete" }, "Delete"), h("option", { value: "delete_warn" }, "Delete and warn"), h("option", { value: "delete_mute" }, "Delete and mute 24 h"));
  put(main, 
    head("Moderation", "Rules for the public channel's comments"),
    h("div", { class: "banner" }, "Channels don't allow member messages; comments live in a linked discussion group. Moderation works only if such a group already exists, the bot is an admin there, DISCUSSION_GROUP_ID is set and the full bot is running. This system never creates a group. Three breaks in 24 hours mute the person for 24 hours."),
    h("div", { class: "grid two" },
      h("section", { class: "card" }, h("h2", {}, "Rules"), table([
        { label: "Type", render: (r) => (r.kind === "word" ? "Word" : "Link") }, { label: "Pattern", render: (r) => h("span", { class: "mono" }, r.pattern) },
        { label: "Action", key: "action" }, { label: "", render: (r) => h("button", { class: "link danger", onclick: async () => { if (await act(() => api(`/api/moderation/rules/${r.id}`, { method: "DELETE" }))) route(); } }, "Delete") },
      ], m.rules, { empty: "No rules" }),
      h("form", { onsubmit: async (e) => { e.preventDefault(); if (await act(() => api("/api/moderation/rules", { method: "POST", body: { kind: kind.value, pattern: pattern.value, action: action.value } }), "Rule added")) route(); } },
        h("h3", {}, "Add a rule"), field("Match", kind), field("Pattern", pattern, "Words match whole words only, ignoring case."), field("Action", action), h("button", { type: "submit" }, "Add rule"))),
      h("section", { class: "card" }, h("h2", {}, "Recent actions"), table([
        { label: "When", render: (r) => when(r.created_at) }, { label: "User", render: (r) => h("span", { class: "mono" }, r.user_id) },
        { label: "Action", key: "action" }, { label: "Message", render: (r) => h("div", { class: "clip" }, r.excerpt || "—") },
      ], m.log, { empty: "Nothing moderated yet" }))));
}

async function pageAnalytics(main) {
  const days = Number(new URLSearchParams(location.hash.split("?")[1] || "").get("days") || 30);
  const a = await api(`/api/analytics?days=${days}`);
  const t = a.trials;
  put(main, 
    head("Analytics", "From payments, trials and posts recorded by this system",
      h("div", { class: "tabs" }, [7, 30, 90].map((d) => h("button", { class: d === days ? "active" : "", onclick: () => (location.hash = `#analytics?days=${d}`) }, `${d} days`)))),
    h("div", { class: "grid kpis" }, kpi("Stars received", num(a.stars_total) + " ⭐", `last ${days} days`), kpi("Trials started", num(t.started), `${num(t.joined)} joined the channel`),
      kpi("Trial → monthly", t.started ? `${Math.round((100 * t.converted) / t.started)}%` : "—", `${num(t.converted)} converted`),
      kpi("Posts published", num(a.posts_by_kind.reduce((n, p) => n + p.count, 0)), "scheduled from this dashboard")),
    h("section", { class: "card", style: null }, h("h2", {}, "Stars per day"), barChart(a.revenue_by_day.map((r) => ({ label: r.day, short: r.day.slice(5), value: r.stars })), { unit: " ⭐", empty: "No payments in this period" })),
    h("div", { class: "grid two", style: null },
      h("section", { class: "card" }, h("h2", {}, "Poll and quiz results"), a.polls.length ? a.polls.map((p) => h("div", {},
        h("h3", {}, `${p.kind === "quiz" ? "Quiz" : "Poll"}: ${p.question}`), p.error ? h("p", { class: "muted small" }, p.error) : hbars(p.options.map((o, i) => ({ label: (p.correct_option === i ? "✓ " : "") + o.text, value: o.votes }))),
        h("p", { class: "small muted" }, `${num(p.total_voters)} voters`))) : h("p", { class: "empty" }, "Results appear when a poll closes")),
      h("section", { class: "card" }, h("h2", {}, "Most reactions"), a.top_reactions.length ? hbars(a.top_reactions.map((r) => ({ label: `Post ${r.message_id}  ${Object.keys(JSON.parse(r.reactions_json)).slice(0, 3).join(" ")}`, value: r.total })))
        : h("p", { class: "empty" }, "Reaction counts need the full bot with Reaction tracking on"))));
}

const FULL_BOT_FEATURES = new Set(["join_requests", "moderation", "reaction_tracking"]);
async function pageSettings(main) {
  const st = await api("/api/settings");
  const toggle = (name, f) => h("button", { class: "switch", role: "switch", "aria-checked": String(f.enabled), "aria-label": name,
    onclick: async () => { if (await act(() => api(`/api/settings/features/${name}`, { method: "PUT", body: { enabled: !f.enabled } }), `${f.enabled ? "Switched off" : "Switched on"}`)) route(); } });
  const policy = (target, label) => {
    const sel = h("select", { onchange: async (e) => { if (!(await act(() => api(`/api/settings/join-policy/${target}`, { method: "PUT", body: { policy: e.target.value } }), "Saved"))) route(); } },
      st.join_policy_options.filter((p) => !(target === "vip" && p === "approve_all")).map((p) => h("option", { value: p, selected: p === st.join_policies[target] },
        { manual: "Review each request here", approve_paid: "Approve paid trial buyers, review the rest", approve_all: "Approve everyone" }[p])));
    return field(label, sel);
  };
  put(main, 
    head("Features & settings", "Everything is off until you switch it on. Switch on one feature at a time and watch the results."),
    h("div", { class: "banner warn" }, "Safety: this dashboard only sends to Telegram; the live VIP bot stays the only receiver of Telegram updates, and members keep using it exactly as before. Features marked “via live bot” work once the live bot forwards a copy of its updates here (launch approval L8); until then they record nothing."),
    h("section", { class: "card" }, h("h2", {}, "Features"), Object.entries(st.features).map(([name, f]) => h("div", { class: "toggle-row" },
      h("div", {}, h("div", {}, f.description, " ", FULL_BOT_FEATURES.has(name) ? chip("pending", "via live bot") : chip("scheduled", "worker")), h("div", { class: "small muted mono" }, name)), toggle(name, f)))),
    h("section", { class: "card", style: null }, h("h2", {}, "Join requests"), policy("public", `Public channel (${st.public_channel})`), policy("vip", "VIP channel")),
    can("paid_media_automation") ? await paidMediaSettings() : null,
    can("backup") ? await backupCard() : null);
}

async function backupCard() {
  let health = null;
  try { health = await api("/api/health"); } catch { /* shown as unknown */ }
  const db = health && health.database;
  const seen = health && health.scheduler_last_seen;
  return h("section", { class: "card" }, h("h2", {}, "Backups & monitoring"),
    h("div", { class: "toggle-row" }, h("div", {}, "Database"), db ? chip(db.ok ? "posted" : "failed", `${db.kind} · ${db.ok ? `ok, ${db.ms} ms` : "unreachable"}`) : chip("failed", "unknown")),
    h("div", { class: "toggle-row" }, h("div", {}, "Scheduler last ran"), seen ? chip(Date.now() / 1000 - seen < 300 ? "posted" : "failed", fmt.format(new Date(seen * 1000))) : chip("pending", "not yet")),
    health && health.backup_configured !== undefined ? h("div", { class: "toggle-row" }, h("div", {}, "Daily backup (03:10 IST, kept 14 days)"),
      !health.backup_configured ? chip("pending", "not linked") : health.backup_last ? chip(Date.now() / 1000 - health.backup_last < 26 * 3600 ? "posted" : "failed", fmt.format(new Date(health.backup_last * 1000))) : chip("pending", "none yet")) : null,
    health && health.live_bot_linked !== undefined ? h("div", { class: "toggle-row" }, h("div", {}, "Live VIP bot members (read-only sync)"),
      !health.live_bot_linked ? chip("pending", "not linked") : health.member_sync_last ? chip("posted", fmt.format(new Date(health.member_sync_last * 1000))) : chip("pending", "switch on “member_sync”")) : null,
    h("p", { class: "small muted" }, "Download a full copy of the dashboard data (posts, captions, settings, profiles, members, analytics and the activity log). Each download is recorded in the activity log."),
    h("div", { class: "row" },
      h("a", { class: "btn", href: "/api/backup", download: "" }, "Download backup (JSON)"),
      health && health.backup_configured ? h("button", { onclick: async () => { if (await act(() => api("/api/backup/now", { method: "POST" }), "Backup stored")) route(); } }, "Back up now") : null));
}

async function paidMediaSettings() {
  const cfg = await api("/api/settings/paid-media");
  const stars = h("input", { type: "number", min: 1, max: 10000, value: cfg.default_stars, required: true });
  const folder = h("input", { value: cfg.folder, placeholder: "e.g. vip_drops (never tgpub)" });
  const times = h("input", { value: cfg.times_utc.join(", "), placeholder: "e.g. 08:00, 18:30 (UTC)" });
  const target = h("select", {}, h("option", { value: "vip", selected: cfg.target === "vip" }, "VIP channel"), h("option", { value: "public", selected: cfg.target === "public" }, "Public channel"));
  const expire = h("input", { type: "number", min: 5, max: 2880, value: cfg.expire_after_minutes || "", placeholder: "optional" });
  const caption = h("textarea", { maxlength: 1024, placeholder: "Used when the file has no caption of its own" }); caption.value = cfg.caption || "";
  const istTimes = cfg.times_utc.map((t) => { const [hh, mm] = t.split(":").map(Number); const m = (hh * 60 + mm + 330) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")} IST`; });
  return h("section", { class: "card" }, h("h2", {}, "Paid media automation"),
    h("p", { class: "muted small" }, "Posts the oldest unused photo or video from the paid-media folder (Automations → Media sources) at each time, as paid media. Each file is used once. Needs “Post paid media automatically”, “Publish scheduled posts” and the bot's paid-media permission."),
    istTimes.length ? h("p", { class: "small" }, "Current times: ", istTimes.join(", ")) : null,
    h("form", { onsubmit: async (e) => { e.preventDefault();
      if (await act(() => api("/api/settings/paid-media", { method: "PUT", body: { default_stars: stars.value, folder: folder.value, times_utc: times.value,
        target: target.value, expire_after_minutes: expire.value || null, caption: caption.value } }), "Saved")) route(); } },
      h("div", { class: "grid two" }, field("Default price (Stars)", stars), field("Channel", target)),
      field("Times (UTC, comma-separated)", times, "Up to 6 a day. 16:30 UTC is 10:00 PM IST."),
      field("Delete after (minutes, optional)", expire, "5 to 2,880 (48 hours). Needs “Delete posts automatically” on."),
      field("Default caption (optional)", caption),
      h("button", { type: "submit" }, "Save")));
}

async function pageActivity(main) {
  const [audit, actions] = await Promise.all([api("/api/audit"), api("/api/actions")]);
  put(main, head("Activity log", "Every change made here, and what the worker did with queued actions"),
    h("div", { class: "grid two" },
      h("section", { class: "card" }, h("h2", {}, "Queued actions"), table([
        { label: "Queued", render: (a) => when(a.created_at) }, { label: "Action", key: "kind" },
        { label: "Status", render: (a) => h("div", {}, chip(a.status), a.error ? h("div", { class: "small muted" }, a.error) : null) },
      ], actions, { empty: "No actions yet" })),
      h("section", { class: "card" }, h("h2", {}, "Changes"), table([
        { label: "When", render: (a) => when(a.created_at) }, { label: "Who", key: "actor" }, { label: "What", key: "action" },
        { label: "Detail", render: (a) => h("span", { class: "small" }, a.detail) },
      ], audit, { empty: "No changes yet" }))));
}

// ---------- start ----------

try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch { /* ignore */ }
window.addEventListener("hashchange", route);
route();

// ---------- Bots & integrations ----------
// Saved credentials are encrypted on the server and only ever come back masked. Every credential change asks for
// the sign-in password again. Webhooks are shown, never changed.

async function reauthFields() {
  if (state.authMode === undefined) { try { state.authMode = (await api("/api/health")).auth || "password"; } catch { state.authMode = "password"; } }
  const email = state.authMode === "supabase" ? h("input", { type: "email", autocomplete: "username", required: true }) : null;
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true });
  return {
    nodes: [h("h3", {}, "Confirm it's you"), email ? field("Sign-in email", email) : null, field("Sign-in password", pw, "Needed for every credential change.")],
    values: () => ({ ...(email ? { email: email.value } : {}), password: pw.value }),
  };
}

const webhookChip = (w) => !w || w.error ? chip("failed", w?.error || "unknown")
  : w.set ? chip(w.last_error ? "failed" : "posted", w.last_error ? `webhook error: ${w.last_error}` : `webhook set · ${num(w.pending_updates || 0)} waiting`)
  : chip("none", "no webhook");

async function pageBots(main) {
  const { bots, permissions } = await api("/api/bots");
  const switchFor = (b) => h("button", { class: "switch", role: "switch", "aria-checked": String(b.automation_enabled), "aria-label": `Automation for @${b.username}`,
    disabled: b.status !== "active",
    onclick: async () => { if (await act(() => api(`/api/bots/${b.id}/automation`, { method: "PUT", body: { enabled: !b.automation_enabled } }), b.automation_enabled ? "Automation off" : "Automation on")) route(); } });
  put(main,
    head("Bots & channels", "Connect bots and assign their channels. Tokens are encrypted on the server and only ever shown masked."),
    h("div", { class: "banner warn" }, "Safety: connecting a bot here never changes its webhook or starts another receiver. A new bot starts with automation off and no permissions; it can only post to channels assigned to it, and only to the preview chat while the dashboard is in preview or read-only mode."),
    h("section", { class: "card" },
      h("div", { class: "row", style: null }, h("h2", {}, "Bots"), h("span", { style: null }), h("button", { class: "primary", onclick: () => addBotDrawer() }, "Add bot")),
      table([
        { label: "Bot", render: (b) => h("div", {}, h("div", {}, `${b.name} `, b.is_primary ? chip("scheduled", "primary") : null), h("div", { class: "small muted" }, `@${b.username}`)) },
        { label: "Token", render: (b) => h("span", { class: "mono" }, b.token || "—") },
        { label: "Status", render: (b) => b.status !== "active" ? chip("cancelled", "disconnected") : b.last_check_ok === false ? chip("failed", b.last_error || "check failed") : chip("posted", "connected") },
        { label: "Webhook", render: (b) => webhookChip(b.webhook) },
        { label: "Channels", render: (b) => b.channels.length ? b.channels.map((c) => c.title).join(", ") : "—" },
        { label: "Automation", render: (b) => switchFor(b) },
        { label: "", render: (b) => h("div", { class: "row" },
          h("button", { onclick: async (e) => { e.stopPropagation(); if (await act(() => api(`/api/bots/${b.id}/test`, { method: "POST" }), "Checked")) route(); } }, "Test"),
          h("button", { onclick: (e) => { e.stopPropagation(); manageBot(b, permissions); } }, "Manage")) },
      ], bots, { empty: "No bots connected yet. Add @ShakhiraVIPBot (or another bot) by its token." })));
}

async function addBotDrawer() {
  const token = h("input", { type: "password", autocomplete: "off", required: true, placeholder: "123456789:ABC…" });
  const re = await reauthFields();
  drawer("Add bot", h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => api("/api/bots", { method: "POST", body: { token: token.value, ...re.values() } }), "Bot connected")) { closeDrawer(); route(); }
  } }, field("Bot token (from @BotFather)", token, "The bot is identified automatically. Its webhook is not changed."), ...re.nodes,
    h("div", { class: "row end" }, h("button", { class: "primary", type: "submit" }, "Connect bot"))));
}

async function confirmDrawer(title, text, fn) {
  const re = await reauthFields();
  drawer(title, h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => fn(re.values()), "Done")) { closeDrawer(); route(); }
  } }, h("p", {}, text), ...re.nodes, h("div", { class: "row end" }, h("button", { class: "danger", type: "submit" }, title))));
}


async function manageBot(b, permissions) {
  const history = await api(`/api/bots/${b.id}/history`);
  const perms = Object.entries(permissions).filter(([k]) => b.is_primary || k !== "member_actions")
    .map(([k, label]) => [k, h("input", { type: "checkbox", checked: !!b.permissions[k] }), label]);
  const chatId = h("input", { placeholder: "@channelname or -100…" });
  const kind = b.is_primary ? h("select", {}, ["channel", "public", "vip"].map((k) => h("option", { value: k }, k === "channel" ? "Other channel" : k === "vip" ? "VIP channel" : "Public channel"))) : null;
  const newToken = h("input", { type: "password", autocomplete: "off", placeholder: "New token for the same bot" });
  const re = await reauthFields();
  drawer(`@${b.username}`, h("div", {},
    h("p", { class: "small muted" }, `Telegram ID ${b.bot_user_id} · token ${b.token || "not connected"} · `, webhookChip(b.webhook)),
    h("h3", {}, "Permissions (what this bot's automation may post)"),
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      const body = { permissions: Object.fromEntries(perms.map(([k, box]) => [k, box.checked])) };
      if (await act(() => api(`/api/bots/${b.id}/permissions`, { method: "PUT", body }), "Permissions saved")) { closeDrawer(); route(); }
    } }, perms.map(([k, box, label]) => h("label", { class: "inline" }, box, label)), h("div", { class: "row end" }, h("button", { type: "submit" }, "Save permissions"))),
    h("h3", {}, "Channels"),
    b.channels.length ? h("ul", { class: "list" }, b.channels.map((c) => h("li", {}, h("div", {}, c.title, h("div", { class: "small muted mono" }, `${c.chat_id} · ${c.kind}`)),
      h("button", { onclick: async () => { if (await act(() => api(`/api/bots/${b.id}/channels/${encodeURIComponent(c.chat_id)}`, { method: "DELETE" }), "Channel removed")) { closeDrawer(); route(); } } }, "Remove")))) : h("p", { class: "muted small" }, "No channels assigned."),
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      if (await act(() => api(`/api/bots/${b.id}/channels`, { method: "POST", body: { chat_id: chatId.value, kind: kind ? kind.value : "channel" } }), "Channel assigned")) { closeDrawer(); route(); }
    } }, field("Assign a channel this bot is an admin of", chatId, "Checked with this bot's own token. A channel can belong to only one bot."), kind ? field("Type", kind) : null,
      h("div", { class: "row end" }, h("button", { type: "submit" }, "Assign"))),
    h("h3", {}, "Token"),
    h("form", { onsubmit: async (e) => {
      e.preventDefault();
      const cred = re.values();
      if (e.submitter?.dataset.action === "disconnect") { if (await act(() => api(`/api/bots/${b.id}/token`, { method: "DELETE", body: cred }), "Disconnected")) { closeDrawer(); route(); } return; }
      if (await act(() => api(`/api/bots/${b.id}/token`, { method: "PUT", body: { token: newToken.value, ...cred } }), "Token replaced")) { closeDrawer(); route(); }
    } }, field("Replace token", newToken, "Must be a token for this same bot."), ...re.nodes,
      h("div", { class: "row end" },
        b.status === "active" ? h("button", { class: "danger", type: "submit", "data-action": "disconnect", formnovalidate: true }, "Disconnect") : null,
        h("button", { class: "primary", type: "submit" }, "Replace token"))),
    h("h3", {}, "History"),
    table([{ label: "When", render: (a) => when(a.created_at) }, { label: "Action", key: "action" }, { label: "Detail", key: "detail" }, { label: "By", key: "actor" }], history.audit, { empty: "No history yet" }),
    history.content.length ? table([{ label: "Post", render: (i) => `#${i.id} ${KIND_LABEL[i.kind] || i.kind}` }, { label: "Status", render: (i) => chip(i.status) }, { label: "Error", key: "last_error" }], history.content) : null));
}

// Telegram-style formatting for the preview, built as DOM nodes (never innerHTML): only Telegram's tags are kept,
// links only for https:// and tg://, everything else becomes plain text.
function renderTelegramHtml(src) {
  const TAGS = { b: "strong", strong: "strong", i: "em", em: "em", u: "u", ins: "u", s: "s", strike: "s", del: "s", code: "code", pre: "pre", blockquote: "blockquote", "tg-spoiler": "span" };
  const doc = new DOMParser().parseFromString(`<body>${src}</body>`, "text/html");
  const walk = (node) => [...node.childNodes].map((n) => {
    if (n.nodeType === 3) return n.textContent;
    const tag = n.nodeName.toLowerCase();
    if (tag === "a") { const href = n.getAttribute("href") || ""; return /^(https:|tg:)/.test(href) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, walk(n)) : n.textContent; }
    if (TAGS[tag]) return h(TAGS[tag], tag === "tg-spoiler" ? { class: "spoiler" } : {}, walk(n));
    return n.textContent;
  });
  return walk(doc.body);
}

// ---------- Media library (private Cloudflare R2) ----------

// Upload folder from Automations → Media sources: paid media → paid-media/, VIP → vip/…, otherwise public/…
async function uploadFolderFor(kind, target, file) {
  let src = {};
  try { src = (await api("/api/media/sources")).sources; } catch { /* defaults below */ }
  const video = file.type.startsWith("video/") || file.type === "image/gif";
  if (kind === "paid_media") return `${src.paid_media || "paid-media"}/${video ? "videos" : "photos"}`.replace(/\/(photos|videos)\/(photos|videos)$/, "/$1");
  const t = String(target).split("|").pop() === "vip" ? "vip" : "public";
  if (file.type === "image/gif" && t === "public") return "public/gifs";
  return src[`${t}_${video ? "videos" : "photos"}`] || `${t}/${video ? "videos" : "photos"}`;
}

// v = the file's upload time: a name reused after a delete gets a new URL, so the browser never shows the old file.
const fileUrl = (key, download = false, v = 0) => `/api/media/file?key=${encodeURIComponent(key)}${download ? "&download=1" : ""}${v ? `&v=${v}` : ""}`;
const isVideoRef = (ref) => /\.(mp4|mov|webm)(\?|$)/i.test(ref);
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const KIND_NAME = { image: "Photo", gif: "GIF", video: "Video" };

const ACCEPT = "image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm";
const OK_TYPES = ACCEPT.split(",");
// Checked before uploading (the server checks the bytes again).
function checkUpload(file) {
  if (!OK_TYPES.includes(file.type)) return /hei[cf]/i.test(file.type + file.name) ? "HEIC photos can't be sent to Telegram; export as JPEG first" : "Only JPEG, PNG, WebP, GIF, MP4, MOV or WebM files";
  if (file.size > 50 * 1024 * 1024) return "Files can be at most 50 MB (Telegram's upload limit)";
  if (file.type.startsWith("image/") && file.type !== "image/gif" && file.size > 10 * 1024 * 1024) return "Photos can be at most 10 MB";
  if (!file.size) return "The file is empty";
  return null;
}

// Upload one file to an R2 folder (body = the file; checked again on the server, which also picks a unique name).
// Returns { promise, abort }. After a successful upload a small thumbnail is made in the browser and stored.
// opts.uploadId: the same id on a retry, so the server never stores a second copy of a file it already saved.
// opts.onSaving: the bytes are all sent; the server is now writing and checking the file in R2 (not saved yet).
function startUpload(file, folder, onProgress = null, opts = {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    const problem = checkUpload(file);
    if (problem) return reject(new Error(problem));
    xhr.open("POST", `/api/media/upload?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(file.name)}`);
    if (state.csrf) xhr.setRequestHeader("X-CSRF-Token", state.csrf);
    if (opts.uploadId) xhr.setRequestHeader("X-Upload-Id", opts.uploadId);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.upload.onload = () => opts.onSaving?.();
    xhr.onload = () => { let b = {}; try { b = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && b.key) { if (!b.duplicate_retry) saveThumbFromFile(file, b.key).catch(() => {}); resolve(b); }
      else reject(new Error(b.error || b.detail || `Upload failed (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error("Network error — Retry is safe (no duplicate is created)"));
    xhr.onabort = () => reject(new Error("Cancelled"));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
const uploadToLibrary = (file, folder, onProgress) => startUpload(file, folder, onProgress).promise;

// ---- Thumbnails: made in the browser (no paid image service), 360 px JPEG, stored privately next to the file ----
const THUMB_PX = 360;
async function frameToJpeg(source, w, h) {
  const scale = Math.min(1, THUMB_PX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.78));
}
async function thumbFromBlob(blob, type) {
  if (type.startsWith("image/")) {
    const bmp = await createImageBitmap(blob);
    try { return await frameToJpeg(bmp, bmp.width, bmp.height); } finally { bmp.close?.(); }
  }
  const url = URL.createObjectURL(blob);
  try {
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = url;
    await new Promise((ok, bad) => { v.onloadeddata = ok; v.onerror = bad; setTimeout(bad, 8000); });
    v.currentTime = Math.min(0.5, (v.duration || 1) / 2);
    await new Promise((ok) => { v.onseeked = ok; setTimeout(ok, 3000); });
    return await frameToJpeg(v, v.videoWidth || 320, v.videoHeight || 180);
  } finally { URL.revokeObjectURL(url); }
}
async function putThumb(key, jpeg) {
  if (!jpeg || jpeg.size > 290 * 1024) return;
  await fetch(`/api/media/thumb?key=${encodeURIComponent(key)}`, { method: "PUT", body: jpeg, credentials: "same-origin", headers: { "X-CSRF-Token": state.csrf || "" } });
}
async function saveThumbFromFile(file, key) { await putThumb(key, await thumbFromBlob(file, file.type)); }
const thumbUrl = (key, v = 0) => `/api/media/thumb?key=${encodeURIComponent(key)}${v ? `&v=${v}` : ""}`;

// Older files without a thumbnail: made once, only when the card is on screen, two at a time.
// Thumbnail loading: at most 6 at a time, only when on screen; switching folder/page cancels what is still queued.
const thumbs = { queue: [], running: 0, gen: 0 };
function cancelThumbs() {
  thumbs.gen++;
  for (const t of thumbs.queue) t.img.removeAttribute("src");
  thumbs.queue = [];
}
function pumpThumbs() {
  while (thumbs.running < 6 && thumbs.queue.length) {
    const t = thumbs.queue.shift();
    if (t.gen !== thumbs.gen || !t.img.isConnected) continue;
    thumbs.running++;
    t.run().finally(() => { thumbs.running--; pumpThumbs(); });
  }
}
const enqueueThumb = (img, run) => { thumbs.queue.push({ img, run, gen: thumbs.gen }); pumpThumbs(); };
const loadImg = (img, src) => new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = src; });

// Files without a stored thumbnail (older uploads): one is made once from the original, two at a time.
const backfill = { queue: [], running: 0 };
function queueBackfill(m, img) { backfill.queue.push([m, img, thumbs.gen]); pumpBackfill(); }
function pumpBackfill() {
  while (backfill.running < 2 && backfill.queue.length) {
    const [m, img, gen] = backfill.queue.shift();
    if (gen !== thumbs.gen || !img.isConnected) continue;
    backfill.running++;
    (async () => {
      const res = await fetch(fileUrl(m.key, false, m.uploaded), { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      const jpeg = await thumbFromBlob(await res.blob(), m.type);
      await putThumb(m.key, jpeg);
      img.src = URL.createObjectURL(jpeg); img.classList.remove("ph-img");
    })().catch(() => thumbFailed(m, img)).finally(() => { backfill.running--; pumpBackfill(); });
  }
}
function thumbFailed(m, img) {
  if (!img.isConnected) return;
  const ph = h("div", { class: "ph" }, h("span", {}, m.kind === "video" ? "▶ Video" : "Photo"),
    h("button", { type: "button", class: "link", onclick: (e) => { e.stopPropagation(); const fresh = thumbEl(m); ph.replaceWith(fresh); } }, "Retry"));
  img.replaceWith(ph);
}
const seen = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { seen.unobserve(en.target); en.target._onVisible?.(); }
}, { rootMargin: "300px" }) : null;

// A thumbnail: the stored small JPEG (privately cached by the browser), never the original; made once if missing.
function thumbEl(m) {
  const img = h("img", { alt: m.name, class: "ph-img", decoding: "async" });
  const load = () => enqueueThumb(img, () => loadImg(img, thumbUrl(m.key, m.uploaded))
    .then(() => img.classList.remove("ph-img"))
    .catch(() => { if (m.size <= 50 * 1024 * 1024) queueBackfill(m, img); else thumbFailed(m, img); }));
  if (seen) { img._onVisible = load; seen.observe(img); } else load();
  return img;
}

function allowedFor(key, { kind, target }) {
  const top = String(key).split("/")[0];
  if (kind === "paid_media") return top === "paid-media";
  if (top === "paid-media") return false;
  if (target === "public" && top === "vip") return false;
  return true;
}

async function pickMedia(onPick, ctx = { kind: "photo", target: "public" }) {
  let files;
  try { files = await api("/api/media/files?recursive=1"); } catch (e) { toast(e.message, true); return; }
  const want = ctx.kind === "video" ? ["video"] : ctx.kind === "animation" ? ["gif", "video"] : ctx.kind === "photo" ? ["image"] : ["image", "video"];
  const usable = files.filter((m) => allowedFor(m.key, ctx) && want.includes(m.kind));
  const box = h("div", { class: "picker" });
  const grid = h("div", { class: "media-grid" }, usable.map((m) => h("button", { type: "button", class: "media-tile pick", onclick: () => { onPick("r2:" + m.key); box.remove(); } },
    h("div", { class: "thumb" }, thumbEl(m), m.kind === "video" ? h("span", { class: "badge" }, "▶") : null),
    h("div", { class: "meta" }, h("span", { class: "clip" }, m.original_name || m.name), h("span", { class: "muted small" }, m.folder)))));
  put(box, h("div", { class: "row spread" }, h("h3", {}, "Choose from the media library"), h("button", { type: "button", onclick: () => box.remove() }, "Close")),
    h("p", { class: "small muted" }, ctx.kind === "paid_media" ? "Only the paid-media folders are shown." : ctx.target === "public" ? "VIP and paid-media files are hidden for the public channel." : "Paid-media files are hidden here."),
    usable.length ? grid : h("p", { class: "muted" }, "No matching files yet. Upload one first."));
  box.classList.add("picker-modal");
  (document.querySelector(".composer") || document.querySelector(".drawer"))?.append(box);
  box.querySelector("button")?.focus();
}

function storageBar(st) {
  if (!st?.connected) return h("div", { class: "banner warn" }, "Media storage (Cloudflare R2) is not connected to this deployment.");
  const u = st.usage;
  return h("div", { class: "storage" },
    h("div", { class: "row spread" }, h("strong", {}, "Storage"), h("span", { class: "small muted" }, `${num(u.files)} files · ${mb(u.bytes)} of 10 GB free tier (${u.percent}%)`)),
    h("progress", { max: 100, value: Math.min(100, u.percent), class: "upload-progress" }),
    u.warning ? h("p", { class: "small" }, chip("failed", "Warning"), " ", u.warning) : null);
}

// Full-screen preview (the original, loaded only when opened).
function lightbox(m) {
  const close = () => wrap.remove();
  const wrap = h("div", { class: "lightbox", role: "dialog", "aria-label": m.name, onclick: (e) => { if (e.target === wrap) close(); } },
    h("div", { class: "lightbox-bar" }, h("span", { class: "clip" }, `${m.original_name || m.name} · ${mb(m.size)}`),
      h("a", { class: "btn", href: fileUrl(m.key, true) }, "Download"), h("button", { onclick: close }, "✕ Close")),
    m.kind === "video" ? h("video", { src: fileUrl(m.key, false, m.uploaded), controls: true, autoplay: true }) : h("img", { src: fileUrl(m.key, false, m.uploaded), alt: m.name }));
  const onKey = (e) => { if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);
  document.body.append(wrap);
}

// Three-dot menu (one open at a time; closes on outside click or Escape).
function menu(items) {
  const list = h("div", { class: "menu-list", role: "menu", hidden: true }, items.filter(Boolean).map(([label, fn, cls]) =>
    h("button", { type: "button", role: "menuitem", class: cls || "", onclick: (e) => { e.stopPropagation(); list.hidden = true; fn(); } }, label)));
  const btn = h("button", { type: "button", class: "menu-btn-dots", "aria-label": "Actions", "aria-haspopup": "menu", onclick: (e) => {
    e.stopPropagation();
    document.querySelectorAll(".menu-list").forEach((l) => { if (l !== list) l.hidden = true; });
    document.querySelectorAll(".menu-open").forEach((t) => t.classList.remove("menu-open"));
    list.hidden = !list.hidden;
    if (!list.hidden) btn.closest(".media-tile")?.classList.add("menu-open"); // above the neighbouring cards
  } }, "⋯");
  return h("div", { class: "menu" }, btn, list);
}
document.addEventListener("click", () => { document.querySelectorAll(".menu-list").forEach((l) => { l.hidden = true; }); document.querySelectorAll(".menu-open").forEach((t) => t.classList.remove("menu-open")); });

const PAGE_SIZES = [24, 48, 96];
function treeOpen() { try { return JSON.parse(localStorage.getItem("media_tree") || "{}"); } catch { return {}; } }
function setTreeOpen(path, open) { const o = treeOpen(); o[path] = open; try { localStorage.setItem("media_tree", JSON.stringify(o)); } catch { /* private mode */ } }
function viewMode() { try { return localStorage.getItem("media_view") || "grid"; } catch { return "grid"; } }
function pageSize() { try { const n = Number(localStorage.getItem("media_page_size")); return PAGE_SIZES.includes(n) ? n : 24; } catch { return 24; } }
let uploadSeq = 0;
const newUploadId = () => `${Date.now().toString(36)}-${(++uploadSeq).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

async function pageMedia(main) {
  cancelThumbs();
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const folder = params.get("folder") || "public/photos", q = params.get("q") || "", kind = params.get("kind") || "", days = params.get("days") || "";
  const searching = !!(q || kind || days);
  // Changing folder, search or filters starts again at page 1 (page lives only in this view, not in the link).
  const go = (o) => { const p = new URLSearchParams({ folder, ...(q ? { q } : {}), ...(kind ? { kind } : {}), ...(days ? { days } : {}), ...o });
    for (const [k, v] of [...p]) if (!v) p.delete(k); location.hash = "#media?" + p; };
  let page = 1, size = pageSize(), total = 0, pages = 1, current = [];

  const storageBox = h("div", { class: "card storage-card" }, h("div", { class: "skeleton line" }));
  const treeBox = h("nav", { class: "folder-tree", "aria-label": "Folders" }, [1, 2, 3, 4, 5, 6].map(() => h("div", { class: "skeleton line" })));
  const skeletons = (n) => Array.from({ length: Math.min(n, 12) }, () => h("div", { class: "media-tile skeleton-tile" }));
  const gridBox = h("div", { class: "media-grid " + viewMode() }, skeletons(size));
  const scroller = h("div", { class: "media-scroll" }, gridBox);
  const rangeBox = h("span", { class: "muted small" }, "Loading…");
  const pager = h("div", { class: "pager" });

  // ---- selection: current page vs all matching files ----
  const selected = new Set();
  const selCount = h("span", { class: "small muted" });
  const pageCheck = h("input", { type: "checkbox", "aria-label": "Select current page", onchange: (e) => {
    gridBox.querySelectorAll(".tile-check input").forEach((c) => { c.checked = e.target.checked; c.dispatchEvent(new Event("change")); }); } });
  const selectAllBtn = h("button", { type: "button", class: "link", onclick: async () => {
    const r = await act(() => api(`${listBase()}&keys=1`)); if (!r) return;
    r.keys.forEach((k) => selected.add(k)); gridBox.querySelectorAll(".tile-check input").forEach((c) => { c.checked = true; }); syncSel();
    if (r.total > r.keys.length) toast(`Selected the first ${num(r.keys.length)} of ${num(r.total)}`, true); } }, "Select all matching");
  const clearSel = h("button", { type: "button", class: "link", onclick: () => { selected.clear(); gridBox.querySelectorAll(".tile-check input").forEach((c) => { c.checked = false; }); pageCheck.checked = false; syncSel(); } }, "Clear selection");
  const bulk = h("div", { class: "row", hidden: true },
    h("button", { onclick: () => moveDrawer([...selected]) }, "Move"),
    h("button", { onclick: () => downloadMany([...selected]) }, "Download"),
    h("button", { class: "danger", onclick: () => removeKeys([...selected]) }, "Delete"));
  const syncSel = () => { selCount.textContent = selected.size ? `${num(selected.size)} selected` : ""; bulk.hidden = !selected.size; clearSel.hidden = !selected.size; };
  syncSel();

  const search = h("input", { type: "search", value: q, placeholder: "Search all folders", "aria-label": "Search" });
  const kindSel = h("select", { "aria-label": "Type", onchange: (e) => go({ kind: e.target.value }) }, [["", "All types"], ["image", "Photos"], ["video", "Videos"], ["gif", "GIFs"]].map(([v, l]) => h("option", { value: v, selected: v === kind }, l)));
  const daySel = h("select", { "aria-label": "Date", onchange: (e) => go({ days: e.target.value }) }, [["", "Any date"], ["1", "Last 24 hours"], ["7", "Last 7 days"], ["30", "Last 30 days"]].map(([v, l]) => h("option", { value: v, selected: v === days }, l)));
  const sizeSel = h("select", { "aria-label": "Files per page", onchange: (e) => { size = Number(e.target.value); try { localStorage.setItem("media_page_size", String(size)); } catch { /* ignore */ } loadPage(1); } },
    PAGE_SIZES.map((n) => h("option", { value: n, selected: n === size }, `${n} per page`)));
  const viewBtn = h("button", { type: "button", "aria-label": "Switch grid or list view", onclick: () => {
    const next = viewMode() === "grid" ? "list" : "grid"; try { localStorage.setItem("media_view", next); } catch { /* ignore */ }
    gridBox.classList.toggle("grid", next === "grid"); gridBox.classList.toggle("list", next === "list"); viewBtn.textContent = next === "grid" ? "List view" : "Grid view"; } },
    viewMode() === "grid" ? "List view" : "Grid view");

  // ---- uploads: queue panel (collapsible, scrolls on its own), 3 at a time, per-file and overall progress ----
  const STATE = { queued: "Waiting", uploading: "Uploading", saving: "Saving…", done: "Saved", failed: "Failed", cancelled: "Cancelled" };
  let jobs = [], active = 0, savedSinceRefresh = 0;
  const overall = h("progress", { max: 100, value: 0, class: "upload-progress" });
  const overallText = h("span", { class: "small muted" });
  const queueList = h("div", { class: "upload-queue" });
  const collapseBtn = h("button", { type: "button", class: "link", "aria-expanded": "true", onclick: () => {
    const open = collapseBtn.getAttribute("aria-expanded") !== "true"; collapseBtn.setAttribute("aria-expanded", String(open)); queueList.hidden = !open; collapseBtn.textContent = open ? "Hide" : "Show"; } }, "Hide");
  const panel = h("section", { class: "upload-panel", hidden: true },
    h("div", { class: "row spread" }, h("strong", {}, "Uploads"), overallText,
      h("div", { class: "row" }, collapseBtn, h("button", { type: "button", class: "link", onclick: () => {
        jobs = jobs.filter((j) => { const fin = ["done", "failed", "cancelled"].includes(j.status); if (fin) j.row.remove(); return !fin; }); drawOverall(); } }, "Clear finished"))),
    overall, queueList);
  const drawOverall = () => {
    panel.hidden = !jobs.length;
    const bytes = jobs.reduce((n, j) => n + j.file.size, 0) || 1;
    const sent = jobs.reduce((n, j) => n + j.file.size * (j.status === "done" ? 1 : ["uploading", "saving"].includes(j.status) ? j.pct / 100 : 0), 0);
    overall.value = Math.round((sent / bytes) * 100);
    const c = (st) => jobs.filter((j) => j.status === st).length;
    overallText.textContent = `${c("done")} saved · ${c("uploading") + c("saving")} in progress · ${c("queued")} waiting${c("failed") ? ` · ${c("failed")} failed` : ""}${c("cancelled") ? ` · ${c("cancelled")} cancelled` : ""}`;
  };
  const draw = (j) => {
    const bar = ["uploading", "saving"].includes(j.status) ? h("progress", { max: 100, value: j.status === "saving" ? 100 : j.pct, class: "upload-progress" }) : h("span");
    const actions = j.status === "queued" ? h("button", { type: "button", class: "link danger", onclick: () => { if (j.status === "queued") { j.status = "cancelled"; draw(j); drawOverall(); } } }, "Remove")
      : j.status === "uploading" ? h("button", { type: "button", class: "link danger", onclick: () => j.abort?.() }, "Cancel")
      : ["failed", "cancelled"].includes(j.status) && !j.invalid ? h("button", { type: "button", onclick: (e) => { e.target.disabled = true; retry(j); } }, "Retry") : h("span");
    j.row.replaceChildren(h("span", { class: "clip up-name", title: j.file.name }, j.file.name), h("span", { class: "muted small" }, mb(j.file.size)), bar,
      h("span", { class: `small up-state ${j.status}` }, j.status === "done" ? `✓ ${j.savedAs}` : j.status === "failed" ? j.error : STATE[j.status]), actions);
  };
  const run = (j) => {
    j.status = "uploading"; j.pct = 0; active++; draw(j); drawOverall();
    const up = startUpload(j.file, j.folder, (pct) => { j.pct = pct; const bar = j.row.querySelector("progress"); if (bar) bar.value = pct; drawOverall(); },
      { uploadId: j.id, onSaving: () => { j.status = "saving"; draw(j); drawOverall(); } });
    j.abort = up.abort;
    up.promise.then((r) => { j.status = "done"; j.savedAs = r.name; savedSinceRefresh++; }) // also after a retry that found the file already saved
      .catch((e) => { j.status = e.message === "Cancelled" ? "cancelled" : "failed"; j.error = e.message; })
      .finally(() => { active--; draw(j); drawOverall(); pump(); });
  };
  const pump = () => {
    while (active < 3) { const j = jobs.find((x) => x.status === "queued"); if (!j) break; run(j); }
    if (!active && !jobs.some((x) => x.status === "queued") && savedSinceRefresh) { savedSinceRefresh = 0; afterUploads(); }
  };
  const retry = (j) => { if (!["failed", "cancelled"].includes(j.status)) return; j.status = "queued"; draw(j); drawOverall(); pump(); }; // same upload id: never a second copy
  const addFiles = (list) => {
    for (const file of [...list]) {
      const j = { file, folder, id: newUploadId(), status: "queued", pct: 0, row: h("div", { class: "upload-row" }) };
      const problem = checkUpload(file);
      if (problem) { j.status = "failed"; j.error = problem; j.invalid = true; }
      jobs.push(j); queueList.append(j.row); draw(j);
    }
    drawOverall(); pump();
  };
  const input = h("input", { type: "file", accept: ACCEPT, multiple: true, hidden: true, onchange: (e) => { addFiles(e.target.files); e.target.value = ""; } });
  const drop = h("div", { class: "dropzone compact", ondragover: (e) => { e.preventDefault(); drop.classList.add("over"); }, ondragleave: () => drop.classList.remove("over"),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); } },
    h("label", { class: "btn primary" }, "Upload", input),
    h("span", { class: "small" }, "or drop files — into ", h("strong", { class: "mono" }, folder)),
    h("span", { class: "small muted" }, "photos ≤ 10 MB · videos ≤ 50 MB"));

  // ---- actions ----
  const removeKeys = async (keys) => {
    if (!keys.length || !confirm(`Permanently delete ${keys.length === 1 ? keys[0].split("/").pop() : num(keys.length) + " files"} from storage? This cannot be undone.`)) return;
    let ok = 0; const bad = [];
    for (let i = 0; i < keys.length; i += 100) {
      const r = await act(() => api("/api/media/delete", { method: "POST", body: { keys: keys.slice(i, i + 100) } }));
      if (!r) break;
      for (const x of r.results) { if (x.ok) { ok++; selected.delete(x.key); } else bad.push(x); }
    }
    if (bad.length) toast(`${ok} deleted. Not deleted: ${bad.slice(0, 5).map((x) => `${x.key.split("/").pop()} (${x.error})`).join(" · ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}`, true);
    else toast(ok === 1 ? "Deleted" : `${num(ok)} files deleted`);
    syncSel(); refreshAll();
  };
  const downloadMany = (keys) => keys.slice(0, 50).forEach((k, i) => setTimeout(() => { const a = h("a", { href: fileUrl(k, true), download: "" }); document.body.append(a); a.click(); a.remove(); }, i * 400));
  const moveDrawer = async (keys, copy = false) => {
    const folders = await api("/api/media/folders").catch(() => []);
    const target = h("select", {}, folders.map((f) => h("option", { value: f.path, selected: f.path === folder }, f.path)));
    const name = keys.length === 1 ? h("input", { value: keys[0].split("/").pop() }) : null;
    drawer(copy ? "Copy to folder" : keys.length === 1 ? "Rename or move" : `Move ${num(keys.length)} files`, h("form", { onsubmit: async (e) => {
      e.preventDefault(); e.submitter.disabled = true;
      let ok = 0;
      for (const k of keys) if (await act(() => api(copy ? "/api/media/copy" : "/api/media/move", { method: "POST", body: { from: k, to: `${target.value}/${name ? name.value.trim() : k.split("/").pop()}` } }))) { ok++; selected.delete(k); }
      if (ok) { toast(`${ok} file${ok > 1 ? "s" : ""} ${copy ? "copied" : "moved"}`); closeDrawer(); syncSel(); refreshAll(); } else e.submitter.disabled = false;
    } }, field("Folder", target), name ? field("File name", name, "Letters, numbers, spaces and . _ - ( ) +") : null,
      h("p", { class: "small muted" }, "Scheduled and draft posts using a moved file are updated automatically. Public posts can't use VIP or paid-media files."),
      h("button", { class: "primary", type: "submit" }, copy ? "Copy" : "Save")));
  };

  const tile = (m) => {
    const cb = h("input", { type: "checkbox", checked: selected.has(m.key), "aria-label": `Select ${m.name}`, onchange: (e) => { e.target.checked ? selected.add(m.key) : selected.delete(m.key); syncSel(); } });
    const ctx = { kind: m.kind === "video" ? "video" : m.kind === "gif" ? "animation" : "photo", target: m.key.startsWith("vip/") ? "vip" : "public" };
    const paid = m.key.startsWith("paid-media/");
    return h("div", { class: "media-tile" },
      h("label", { class: "tile-check" }, cb),
      h("button", { type: "button", class: "thumb", "aria-label": `Preview ${m.name}`, onclick: () => lightbox(m) }, thumbEl(m), m.kind === "video" ? h("span", { class: "badge" }, "▶") : null),
      h("div", { class: "meta" },
        h("span", { class: "clip", title: m.original_name || m.name }, m.name),
        h("span", { class: "muted small" }, `${KIND_NAME[m.kind] || m.type} · ${mb(m.size)} · ${m.uploaded ? fmtDay.format(new Date(m.uploaded * 1000)) : ""}`),
        searching ? h("span", { class: "muted small" }, m.folder) : null),
      menu([
        ["Preview", () => lightbox(m)],
        ["Download original", () => downloadMany([m.key])],
        paid ? ["Create paid post", () => editor(null, { kind: "paid_media", target: "vip", media_url: "r2:" + m.key, star_count: 50 })] : ["Create post", () => editor(null, { ...ctx, media_url: "r2:" + m.key })],
        ["Rename", () => moveDrawer([m.key])],
        ["Move", () => moveDrawer([m.key])],
        ["Copy", () => moveDrawer([m.key], true)],
        ["Delete permanently", () => removeKeys([m.key]), "danger"],
      ]));
  };

  // ---- listing: one server page at a time (cached index on the server; nothing else is downloaded) ----
  const since = days ? Math.floor(Date.now() / 1000) - Number(days) * 86400 : 0;
  const listBase = () => searching ? `/api/media/files?recursive=1&q=${encodeURIComponent(q)}&kind=${kind}${since ? `&from=${since}` : ""}` : `/api/media/files?folder=${encodeURIComponent(folder)}`;
  let loadSeq = 0;
  async function loadPage(p, { keepScroll = false } = {}) {
    const seq = ++loadSeq, top = scroller.scrollTop;
    cancelThumbs();
    if (!keepScroll) gridBox.replaceChildren(...skeletons(size));
    let r;
    try { r = await api(`${listBase()}&page=${p}&size=${size}`); }
    catch (e) { if (seq === loadSeq) put(gridBox, h("div", { class: "banner bad" }, e.message, " ", h("button", { onclick: () => loadPage(p) }, "Retry"))); return; }
    if (seq !== loadSeq) return; // a newer request (folder/page switch) won
    ({ page, pages, total } = r); current = r.items;
    gridBox.replaceChildren(...(current.length ? current.map(tile) : [h("p", { class: "empty" }, searching ? "No files match." : "No files here yet. Upload or drop some above.")]));
    rangeBox.textContent = total ? `${num(r.from)}–${num(r.to)} of ${num(total)} file${total === 1 ? "" : "s"}` : "0 files";
    pageCheck.checked = false;
    drawPager();
    scroller.scrollTop = keepScroll ? top : 0;
  }
  function drawPager() {
    const nums = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    const list = [...nums].sort((a, b) => a - b);
    const items = [];
    list.forEach((n, i) => {
      if (i && n - list[i - 1] > 1) items.push(h("span", { class: "muted" }, "…"));
      items.push(h("button", { type: "button", class: n === page ? "active" : "", "aria-current": n === page ? "page" : null, onclick: () => loadPage(n) }, String(n)));
    });
    put(pager, h("button", { type: "button", disabled: page <= 1, onclick: () => loadPage(page - 1) }, "‹ Previous"), ...items,
      h("button", { type: "button", disabled: page >= pages, onclick: () => loadPage(page + 1) }, "Next ›"), sizeSel);
  }
  const refreshStatus = () => api("/api/media/status").then((s) => put(storageBox, storageBar(s))).catch((e) => put(storageBox, h("p", { class: "bad-text" }, e.message)));
  const refreshAll = () => { loadPage(page, { keepScroll: true }); refreshStatus(); refreshTree(); };
  const afterUploads = () => { loadPage(searching ? page : 1, { keepScroll: page !== 1 }); refreshStatus(); refreshTree(); };

  const folderTools = h("div", { class: "row" });
  const drawTree = (folders) => {
    const open = treeOpen();
    const kids = (p) => folders.filter((f) => f.path.startsWith(p + "/") && f.path.split("/").length === p.split("/").length + 1);
    const node = (f) => {
      const children = kids(f.path);
      const isOpen = open[f.path] ?? (folder === f.path || folder.startsWith(f.path + "/"));
      const sub = children.length ? h("div", { class: "tree-kids", hidden: !isOpen }, children.map(node)) : null;
      const caret = children.length ? h("button", { type: "button", class: "caret-btn", "aria-expanded": String(isOpen), "aria-label": `Show ${f.path}`, onclick: (e) => {
        e.preventDefault(); const now = e.currentTarget.getAttribute("aria-expanded") !== "true"; e.currentTarget.setAttribute("aria-expanded", String(now)); sub.hidden = !now; setTreeOpen(f.path, now); } }, "▸") : h("span", { class: "caret-sp" });
      const totalHere = folders.filter((x) => x.path === f.path || x.path.startsWith(f.path + "/")).reduce((n, x) => n + x.files, 0);
      return h("div", {}, h("div", { class: "tree-row" + (f.path === folder && !searching ? " active" : "") }, caret,
        h("a", { href: `#media?folder=${encodeURIComponent(f.path)}`, title: f.path }, h("span", {}, f.path.split("/").pop()), totalHere ? h("span", { class: "count-muted" }, num(totalHere)) : null)), sub);
    };
    put(treeBox, folders.filter((f) => !f.path.includes("/")).map(node));
    put(folderTools, h("button", { onclick: () => { const n = prompt(`New folder inside ${folder}/ (or a full path like campaigns/december):`); if (n) act(() => api("/api/media/folders", { method: "POST", body: { path: n.includes("/") ? n : `${folder}/${n}` } }), "Folder created").then((r) => r && go({ folder: r.path })); } }, "New folder"),
      folders.find((f) => f.path === folder && !f.protected) ? [
        h("button", { onclick: () => { const n = prompt("New folder path:", folder); if (n && n !== folder) act(() => api("/api/media/folders/rename", { method: "POST", body: { from: folder, to: n } }), "Folder renamed").then((r) => r && go({ folder: r.path })); } }, "Rename folder"),
        h("button", { class: "danger", onclick: () => { if (confirm(`Delete the empty folder ${folder}? Folders with files can't be deleted.`)) act(() => api("/api/media/folders/delete", { method: "POST", body: { path: folder } }), "Folder deleted").then((r) => r && go({ folder: "public/photos" })); } }, "Delete folder")] : null);
  };
  const refreshTree = () => api("/api/media/folders").then(drawTree).catch((e) => put(treeBox, h("p", { class: "small bad-text" }, e.message)));

  put(main,
    h("div", { class: "media-page" },
      h("div", { class: "media-top" }, h("div", {}, h("h1", {}, "Media library"), h("p", { class: "muted small" }, "Private storage (Cloudflare R2): only signed-in admins can see these files.")), storageBox),
      h("div", { class: "media-layout" },
        h("section", { class: "card folder-card" }, h("h3", {}, "Folders"), treeBox),
        h("section", { class: "card media-panel" },
          h("div", { class: "media-toolbar" },
            h("form", { class: "row search-row", onsubmit: (e) => { e.preventDefault(); go({ q: search.value.trim() }); } }, search, kindSel, daySel, h("button", { type: "submit" }, "Search"),
              searching ? h("button", { type: "button", onclick: () => (location.hash = `#media?folder=${encodeURIComponent(folder)}`) }, "Clear") : null),
            h("div", { class: "row spread" }, h("div", {}, h("h2", { class: "clip" }, searching ? "Search results" : folder), rangeBox), h("div", { class: "row" }, folderTools, viewBtn)),
            !searching ? drop : null,
            h("div", { class: "row sel-row" }, h("label", { class: "inline" }, pageCheck, "Select current page"), selectAllBtn, clearSel, selCount, bulk)),
          panel, scroller, pager))));
  await Promise.all([refreshStatus(), refreshTree(), loadPage(1)]);
}

async function pageAutomation(main) {
  const a = await api("/api/automation");
  const sw = (key, on, label, desc) => h("div", { class: "toggle-row" }, h("div", {}, h("div", {}, label), h("div", { class: "small muted" }, desc)),
    h("button", { class: "switch", role: "switch", "aria-checked": String(!on), "aria-label": label,
      onclick: async () => { if (await act(() => api("/api/automation", { method: "PUT", body: { [key]: !on } }), on ? "Resumed" : "Paused")) route(); } }));
  const chat = h("input", { inputmode: "numeric", placeholder: "e.g. 123456789", value: a.preview_chat_id || "" });
  const re = await reauthFields();
  const modeText = { simulated: "Simulation: no bot token is connected, so nothing is sent to Telegram.",
    locked: "Locked: a bot is connected but no preview chat is set, so nothing is sent.",
    preview: "Preview: posts go ONLY to your private preview chat. Channels and members receive nothing.",
    live: "Live: approved posts are published to the channels." }[a.mode];
  put(main, head("Automation", "Pause or resume posting, and set your private preview chat"),
    h("div", { class: `banner ${a.mode === "live" ? "" : "warn"}` }, modeText),
    h("section", { class: "card" }, h("h2", {}, "Posting"),
      sw("automation_paused", a.automation_paused, "Dashboard posting", "Scheduled posts, repeating posts, poll closing and post expiry from this dashboard. Member sync and backups keep running."),
      sw("poster_paused", a.poster_paused, `GitHub auto-poster (${a.poster_slots_ist.join(" and ")})`, "The original scheduled job (GitHub). When paused, it skips its slot and posts nothing. Replaced by the R2 automatic posts below once you retire it."),
      h("p", { class: "small muted" }, "The GitHub poster reads this switch only after its secret POSTER_CONTROL_URL is set to ", h("span", { class: "mono" }, location.origin + a.poster_control_path),
        " (GitHub → Settings → Secrets → Actions). If the dashboard can't be reached, it posts as normal."),
      h("p", { class: "small muted" }, "Individual features (polls, expiry, paid-media automation…) are in ", h("a", { href: "#settings" }, "Features & settings"), ". The dashboard never posts the GitHub poster's media, so nothing is posted twice.")),
    await mediaSourcesCard(),
    h("section", { class: "card" }, h("h2", {}, "Private preview chat"),
      h("p", { class: "small muted" }, "Your own Telegram user ID (from @userinfobot). Send /start to the bot from that account first. While the preview lock is on, everything is sent only here."),
      h("form", { onsubmit: async (e) => {
        e.preventDefault();
        if (await act(() => api("/api/automation/preview-chat", { method: "PUT", body: { preview_chat_id: chat.value.trim(), ...re.values() } }), "Saved")) route();
      } }, field("Preview chat ID", chat), ...re.nodes, h("div", { class: "row end" }, h("button", { class: "primary", type: "submit" }, "Save")))));
}


// Automations → Media sources: which R2 folder each channel/workflow uses, and the R2 automatic posts.
async function mediaSourcesCard() {
  let d, folders;
  try { [d, folders] = await Promise.all([api("/api/media/sources"), api("/api/media/folders")]); }
  catch (e) { return h("section", { class: "card" }, h("h2", {}, "Media sources"), h("p", { class: "muted" }, e.message)); }
  const sel = {};
  const allowed = (k, f) => (k === "paid_media" ? f.startsWith("paid-media") : !f.startsWith("paid-media") && !(k.startsWith("public_") && f.startsWith("vip")));
  const rows = Object.entries(d.labels).map(([k, label]) => {
    sel[k] = h("select", {}, folders.filter((f) => allowed(k, f.path)).map((f) => h("option", { value: f.path, selected: f.path === d.sources[k] }, f.path)));
    return field(label, sel[k]);
  });
  const toIst = (t) => { const [hh, mm] = t.split(":").map(Number); const m = (hh * 60 + mm + 330) % 1440; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  const auto = (t, label) => {
    const c = d.autopost[t] || {};
    const times = h("input", { value: (c.times_utc || []).join(", "), placeholder: t === "public" ? "default 16:30, 23:30 (5 AM / 10 PM IST)" : "e.g. 14:30 (UTC)" });
    const on = h("input", { type: "checkbox", checked: !!c.enabled });
    return h("form", { class: "card inner", onsubmit: async (e) => { e.preventDefault();
      if (await act(() => api(`/api/media/autopost/${t}`, { method: "PUT", body: { enabled: on.checked, times_utc: times.value } }), "Saved")) route(); } },
      h("h3", {}, label), h("label", { class: "inline field" }, on, `Post automatically from ${d.sources[`${t}_auto`]}`),
      field("Times (UTC, comma-separated)", times, c.times_utc?.length ? `India time: ${c.times_utc.map(toIst).join(", ")}` : "Empty = the same 5 AM / 10 PM IST slots as before."),
      h("p", { class: "small muted" }, t === "public" ? "On by default once “Automatic posts from R2” is switched on in Features & settings. New files first, then the file posted longest ago after a 30-day cooldown. One post per time slot." : "Needs this switch and “Automatic posts from R2” in Features & settings. New files first, then the longest-ago file after a 30-day cooldown. One post per time slot."),
      h("button", { type: "submit" }, "Save"));
  };
  return h("section", { class: "card" }, h("h2", {}, "Media sources"),
    h("p", { class: "small muted" }, "Which private folder each channel and workflow uses. Public workflows can never use VIP or paid-media folders; paid media only uses paid-media folders. Newly uploaded files are never posted unless the matching automation is on."),
    h("form", { onsubmit: async (e) => { e.preventDefault();
      if (await act(() => api("/api/media/sources", { method: "PUT", body: { sources: Object.fromEntries(Object.entries(sel).map(([k, el]) => [k, el.value])) } }), "Saved")) route(); } },
      h("div", { class: "grid two" }, rows), h("button", { class: "primary", type: "submit" }, "Save folders")),
    h("div", { class: "grid two" }, auto("public", "Public channel automatic posts"), auto("vip", "VIP channel automatic posts")));
}

// ---------- Admin account (single admin, the deployment's own sign-in) ----------

function passwordInput(label, autocomplete) {
  const input = h("input", { type: "password", autocomplete, required: true, maxlength: 200 });
  const toggle = h("button", { type: "button", class: "link", "aria-label": `Show ${label}`, onclick: () => {
    const show = input.type === "password"; input.type = show ? "text" : "password"; toggle.textContent = show ? "Hide" : "Show"; } }, "Show");
  return { input, node: h("label", { class: "field" }, label, h("div", { class: "pw-row" }, input, toggle)) };
}
const strengthHint = (pw) => !pw ? "" : pw.length < 12 ? "Too short: at least 12 characters"
  : (pw.length < 16 && [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length < 3) ? "Mix at least three of: lowercase, uppercase, numbers, symbols (or 16+ characters)" : "Strong enough";

async function pageAccount(main) {
  const a = await api("/api/account");
  const msg = (box, text, bad = false) => put(box, h("div", { class: `banner ${bad ? "bad" : ""}` }, text));
  // Password
  const cur = passwordInput("Current password", "current-password"), np = passwordInput("New password", "new-password"), cp = passwordInput("Confirm new password", "new-password");
  const hint = h("span", { class: "hint" });
  np.input.addEventListener("input", () => { hint.textContent = strengthHint(np.input.value); });
  const pwMsg = h("div", {});
  const pwForm = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (np.input.value !== cp.input.value) return msg(pwMsg, "The new passwords don't match.", true);
    const btn = e.submitter; btn.disabled = true;
    try {
      const r = await api("/api/account/password", { method: "PUT", body: { current_password: cur.input.value, new_password: np.input.value, confirm_password: cp.input.value } });
      state.csrf = r.csrf;
      pwForm.reset(); hint.textContent = "";
      msg(pwMsg, "Password changed. Every other signed-in browser has been signed out; this one stays signed in.");
    } catch (ex) { msg(pwMsg, ex.message, true); } finally { btn.disabled = false; }
  } }, cur.node, np.node, hint, cp.node, pwMsg, h("button", { class: "primary", type: "submit" }, "Change password"));
  // Email
  const emMsg = h("div", {});
  const newEmail = h("input", { type: "email", autocomplete: "email", required: true, maxlength: 200 });
  const emPw = passwordInput("Current password", "current-password");
  const emailForm = a.email_supported ? h("form", { onsubmit: async (e) => {
    e.preventDefault();
    const btn = e.submitter; btn.disabled = true;
    try {
      const r = await api("/api/account/email", { method: "PUT", body: { new_email: newEmail.value, current_password: emPw.input.value } });
      emailForm.reset();
      msg(emMsg, `Supabase sent a confirmation link to ${r.pending_email}. Open it to finish; until then keep signing in with your current email. Then sign in with the new email.`);
    } catch (ex) { msg(emMsg, ex.message, true); } finally { btn.disabled = false; }
  } }, field("New email", newEmail), emPw.node, emMsg, h("button", { class: "primary", type: "submit" }, "Change email")) : null;
  // Sign out other sessions
  const soPw = passwordInput("Current password", "current-password"), soMsg = h("div", {});
  const soForm = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try { const r = await api("/api/account/signout-others", { method: "POST", body: { current_password: soPw.input.value } }); state.csrf = r.csrf; soForm.reset(); msg(soMsg, "All other sessions are signed out."); }
    catch (ex) { msg(soMsg, ex.message, true); }
  } }, soPw.node, soMsg, h("button", { type: "submit" }, "Sign out everywhere else"));
  const row = (k, v) => h("div", { class: "toggle-row" }, h("div", {}, k), h("div", { class: "small" }, v));
  put(main, head("Admin account", "Your single administrator login. Every change needs your current password."),
    h("section", { class: "card" }, h("h2", {}, "Account"),
      row("Sign-in method", a.mode === "supabase" ? "Email and password (Supabase Auth)" : "Password only"),
      a.mode === "supabase" ? row("Email", h("span", {}, a.email, " ", a.email_confirmed ? chip("posted", "confirmed") : chip("pending", "unconfirmed"))) : null,
      a.pending_email ? row("Pending email change", h("span", {}, a.pending_email, " ", chip("pending", "awaiting confirmation"))) : null,
      a.last_sign_in_at ? row("Last sign-in", fmt.format(new Date(a.last_sign_in_at)) + " IST") : null,
      row("Password last changed here", a.password_changed_at ? when(a.password_changed_at) : "not yet"),
      row("Other sessions last signed out", a.sessions_reset_at ? when(a.sessions_reset_at) : "never"),
      a.note ? h("p", { class: "small muted" }, a.note) : null),
    h("div", { class: "grid two" },
      h("section", { class: "card" }, h("h2", {}, "Change password"), h("p", { class: "small muted" }, "At least 12 characters mixing letters, numbers and symbols, or 16+ characters. Other sessions are signed out afterwards."), pwForm),
      emailForm ? h("section", { class: "card" }, h("h2", {}, "Change email"),
        h("p", { class: "small muted" }, "Supabase emails a confirmation link to the new address. Nothing changes until you click it, so you can't be locked out by a typo, and your account (same user, same admin rights) is kept."),
        a.email_is_placeholder ? h("div", { class: "banner warn" },
          h("strong", {}, "Your current email is a placeholder that can't receive mail. "),
          "Before changing it, in your Supabase project (free settings):",
          h("ol", {},
            h("li", {}, "Authentication → Sign In / Providers → Email: switch off “Secure email change” for now, so only the new address has to confirm. Switch it back on afterwards."),
            h("li", {}, "Authentication → Emails → SMTP Settings: add your mail provider's SMTP, or invite the new address to the Supabase project. Supabase's built-in mailer only delivers to project members."),
            h("li", {}, `Authentication → URL Configuration → Redirect URLs: add ${location.origin}/** so the confirmation link brings you back here.`))) : null,
        emailForm) : null),
    h("section", { class: "card" }, h("h2", {}, "Sessions"), h("p", { class: "small muted" }, "Sign out every other browser or device that is signed in to this dashboard."), soForm),
    h("p", { class: "small muted" }, "Forgot your password? Reset it in Supabase (Authentication → Users → your user → Send password recovery) or ask your developer; nothing here sends passwords by email."));
}

// ---------- Telegram pages added with the sidebar restructure ----------

async function pageCreatePost(main) {
  await pageContent(main);
  main.querySelector("h1").textContent = "Create post";
  editor();
}

async function pagePaidMedia(main) {
  const items = (await api("/api/content")).filter((i) => i.kind === "paid_media");
  put(main,
    head("Paid media", "Telegram Stars paid media (sendPaidMedia). Publishing requires the bot's paid-media permission.",
      h("button", { class: "primary", onclick: () => editor(null, { kind: "paid_media" }) }, "New paid media post")),
    h("div", { class: "banner warn" }, "Paid media is locked by the bot's permission guard until you approve it in Bots & channels → Manage. Stars go to the channel's balance."),
    h("section", { class: "card" }, table([
      { label: "When", render: (i) => when(i.posted_at || i.scheduled_at) },
      { label: "Channel", render: (i) => (i.target === "vip" ? "VIP" : "Public") },
      { label: "Price", render: (i) => (i.star_count ? `${num(i.star_count)} ⭐` : "—") },
      { label: "Caption", render: (i) => h("div", { class: "clip" }, i.text || "—") },
      { label: "Status", render: (i) => chip(i.status) }, { label: "", render: (i) => rowActions(i) },
    ], items, { empty: "No paid media posts yet" })),
    can("paid_media_automation") ? await paidMediaSettings() : null);
}

async function pageSecurity(main) {
  put(main, head("Security & backups", "Sign-in, credential protection, backups and restore"),
    h("section", { class: "card" }, h("h2", {}, "Protection in place"), h("ul", { class: "list" }, [
      "Supabase Auth sign-in, CSRF tokens, login rate limit (15-minute lockout)",
      "Every credential change needs your password again",
      "Telegram tokens encrypted per record; never shown in full",
      "Media is stored privately in Cloudflare R2: no public bucket, no public links; files reach Telegram as uploads",
      "Every change is written to the activity log",
    ].map((t) => h("li", {}, t))), h("a", { href: "#activity" }, "Open activity log →")),
    can("backup") ? await backupCard() : null);
}
