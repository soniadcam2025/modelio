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
function escClose(e) { if (e.key === "Escape") closeDrawer(); }
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
  { group: "system", label: "System", children: ["security", "activity"] },
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
    head("Overview", `Automatic Cloudinary posts: ${o.poster_slots_ist.join(" and ")} daily`),
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
  const mediaUrl = h("input", { type: "url", placeholder: "https://res.cloudinary.com/…", value: v.media_url || "" });
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
    media: h("div", {}, field("Media link", mediaUrl, "An https link Telegram can download (Cloudinary works). Photos up to 5 MB, other files up to 20 MB by link."),
      can("content_v2") ? h("div", { class: "row" },
        h("label", { class: "btn" }, "Upload from this device", h("input", { type: "file", accept: "image/*,video/*", hidden: true, onchange: async (e) => {
          const f = e.target.files[0]; if (!f) return;
          const bar = h("progress", { max: 100, value: 0, class: "upload-progress" });
          e.target.closest(".row").after(bar);
          const url = await act(() => uploadToCloudinary(f, "shakhira_admin", (pct) => { bar.value = pct; }), "Uploaded to the dashboard library");
          bar.remove();
          if (url) { mediaUrl.value = url; drawPreview(); }
        } })),
        h("button", { type: "button", onclick: () => pickMedia((url) => { mediaUrl.value = url; drawPreview(); }) }, "Choose from library")) : null),
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
  }
  // What the post will look like (approximate; Telegram decides the final layout).
  function drawPreview() {
    const k = kind.value, url = mediaUrl.value.trim(), isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(url);
    const media = ["photo", "video", "animation", "paid_media"].includes(k) && url.startsWith("https://")
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
  kind.addEventListener("change", () => { show(); drawPreview(); });
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
    const buttonsEls = [...document.querySelectorAll(".drawer .row.end button")];
    buttonsEls.forEach((b) => { b.disabled = true; });
    try { await saveInner(mode); } finally { busy = false; buttonsEls.forEach((b) => { b.disabled = false; }); }
  }
  async function saveInner(mode) {
    const body = payload();
    if (mode === true) mode = "schedule";
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
  drawer(item ? `Edit post #${item.id}` : "New post", h("form", { onsubmit: (e) => { e.preventDefault(); save(true); } },
    h("div", { class: "grid two" }, field("Type", kind), field("Channel", target)),
    groups.text, groups.format, groups.media, groups.lib, groups.poll, groups.multi, groups.quiz, groups.close, groups.stars, groups.button,
    can("hashtags") ? field("Hashtags (optional)", hashtags, "Up to 10, added on a new line at the end of the text or caption. Not added to polls or quizzes.") : null,
    can("post_expiry") ? field("Delete automatically after (minutes, optional)", expire,
      "5 minutes to 48 hours. Telegram lets bots delete their own posts only within 48 hours. Needs “Delete posts automatically” on.") : null,
    can("content_v2") ? h("label", { class: "inline field" }, protect, "Protected content (no forwarding or saving in Telegram apps)") : null,
    field("Publish at (India time)", at, "Posts go out within about a minute of this time, once Scheduled posts is on."),
    can("content_v2") ? repeatBox : null,
    can("content_v2") ? previewBox : null,
    h("div", { class: "row end" },
      h("button", { type: "button", onclick: () => save("draft") }, "Save draft"),
      can("content_v2") ? h("button", { type: "button", onclick: () => save("preview") }, "Send preview to me") : null,
      can("content_v2") ? h("button", { type: "button", onclick: () => save("publish") }, "Publish now") : null,
      h("button", { class: "primary", type: "submit" }, "Schedule"))));
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
  data.poster_slots.forEach((sl) => place(sl.at, h("div", { class: "cal-item auto", title: sl.label }, h("div", { class: "t" }, fmtTime.format(new Date(sl.at * 1000))), "Cloudinary auto-post")));
  data.items.forEach((i) => { const ts = i.posted_at || i.scheduled_at; if (ts) place(ts, h("div", { class: "cal-item", onclick: () => (["draft", "scheduled", "failed"].includes(i.status) ? editor(i) : null) },
    h("div", { class: "t" }, fmtTime.format(new Date(ts * 1000)), " ", chip(i.status)), h("div", { class: "clip" }, `${KIND_LABEL[i.kind]} · ${i.target === "vip" ? "VIP" : "Public"} · ${i.text || ""}`))); });
  const todayIdx = Math.floor((Date.now() / 1000 - start) / 86400);
  put(main, 
    head("Calendar", "India time. Grey items are the automatic Cloudinary posts from GitHub.",
      h("button", { onclick: () => { calendarStart -= 7 * 86400; route(); } }, "← Previous week"),
      h("button", { onclick: () => { calendarStart = null; route(); } }, "This week"),
      h("button", { onclick: () => { calendarStart += 7 * 86400; route(); } }, "Next week →"),
      h("button", { class: "primary", onclick: () => editor() }, "New post")),
    h("div", { class: "cal" }, days.map((d, idx) => h("div", { class: "cal-day" + (idx === todayIdx ? " today" : "") },
      h("h4", {}, fmtDay.format(new Date(d.start * 1000 + 3600 * 1000))), d.items.sort((a, b) => a[0] - b[0]).map((x) => x[1])))));
}

async function pageMedia(main) {
  if (can("content_v2")) return pageMediaV2(main);
  return pageMediaPoster(main);
}

async function pageMediaPoster(main, { append = false } = {}) {
  const p = await api("/api/poster");
  if (append) {
    if (!p.configured || p.error) return;
    const inv = p.inventory;
    main.append(h("section", { class: "card" }, h("h2", {}, `GitHub auto-poster queue “${p.folder}” (5 AM / 10 PM IST)`),
      h("div", { class: "grid kpis" }, kpi("Left to post", num(inv.remaining), "new files"), kpi("Posted", num(inv.posted), `${num(inv.reusable_now)} reusable now (30+ days)`),
        kpi("Need a check", num(inv.uncertain + inv.rejected), "uncertain or rejected"))));
    return;
  }
  put(main, head("Media library", "The Cloudinary folder the automatic poster uses (read-only)",
    p.configured ? h("button", { onclick: async () => { await api("/api/poster?refresh=true"); route(); } }, "Refresh") : null));
  if (!p.configured) {
    main.append(h("div", { class: "banner" }, "Not connected. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the dashboard's .env to see the folder here."));
    return;
  }
  if (p.error) { main.append(h("div", { class: "banner bad" }, p.error)); return; }
  const inv = p.inventory;
  main.append(
    inv.remaining >= 5 ? null : inv.remaining ? h("div", { class: "banner warn" }, `Only ${inv.remaining} new files left. Upload more to “${p.folder}”.`)
      : inv.reusable_now ? h("div", { class: "banner warn" }, `No new media: the poster is reposting the oldest posts (last posted 30+ days ago). ${num(inv.reusable_now)} can be reposted now. Upload new media to “${p.folder}” to post fresh content.`)
      : h("div", { class: "banner bad" }, `Nothing can be posted: no new media, and every post is still inside its 30-day cooldown${inv.next_reuse_at ? `. Reposting resumes ${when(inv.next_reuse_at)}` : ""}. Upload new media to “${p.folder}” to post sooner.`),
    h("div", { class: "grid kpis" }, kpi("Left to post", num(inv.remaining), `in “${p.folder}”`), kpi("Posted", num(inv.posted), `${num(inv.reusable_now)} reusable now (30+ days old)`),
      kpi("Need a check", num(inv.uncertain + inv.rejected), "uncertain or rejected"), kpi("Unsupported", num(inv.unsupported), "format or size"),
      p.paid_folder ? kpi("Paid-media folder", num(p.paid_folder.unused), `unused of ${num(p.paid_folder.total)} in “${p.paid_folder.folder}”`) : null),
    h("section", { class: "card", style: null }, h("h2", {}, "Files"), h("div", { class: "media-grid" }, p.library.map((m) => h("div", { class: "media-tile" },
      m.thumb ? h("img", { src: m.thumb, alt: m.name, loading: "lazy" }) : h("div", { class: "ph" }, m.kind),
      h("div", { class: "meta" }, h("span", { class: "clip mono" }, m.name), chip(m.state === "queued" ? "scheduled" : m.state === "posted" ? "posted" : "uncertain", m.state), m.note ? h("span", { class: "muted" }, m.note) : null))))));
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
    h("p", { class: "muted small" }, "Posts the oldest unused photo or video from its own Cloudinary folder at each time, as paid media. A file's own Cloudinary context ",
      h("span", { class: "mono" }, "stars=120"), " overrides the default price, and its ", h("span", { class: "mono" }, "caption"),
      " is used if set. Needs “Post paid media automatically” and “Publish scheduled posts” on. Used files are remembered here, never tagged in Cloudinary."),
    istTimes.length ? h("p", { class: "small" }, "Current times: ", istTimes.join(", ")) : null,
    h("form", { onsubmit: async (e) => { e.preventDefault();
      if (await act(() => api("/api/settings/paid-media", { method: "PUT", body: { default_stars: stars.value, folder: folder.value, times_utc: times.value,
        target: target.value, expire_after_minutes: expire.value || null, caption: caption.value } }), "Saved")) route(); } },
      h("div", { class: "grid two" }, field("Default price (Stars)", stars), field("Channel", target)),
      field("Cloudinary folder", folder, "A separate folder. tgpub is refused: it belongs to the free-channel poster."),
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
  const [{ bots, permissions }, cloud] = await Promise.all([api("/api/bots"), api("/api/integrations/cloudinary")]);
  const switchFor = (b) => h("button", { class: "switch", role: "switch", "aria-checked": String(b.automation_enabled), "aria-label": `Automation for @${b.username}`,
    disabled: b.status !== "active",
    onclick: async () => { if (await act(() => api(`/api/bots/${b.id}/automation`, { method: "PUT", body: { enabled: !b.automation_enabled } }), b.automation_enabled ? "Automation off" : "Automation on")) route(); } });
  put(main,
    head("Bots & integrations", "Connect bots and Cloudinary. Credentials are encrypted on the server and only ever shown masked."),
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
      ], bots, { empty: "No bots connected yet. Add @ShakhiraVIPBot (or another bot) by its token." })),
    h("section", { class: "card" }, h("h2", {}, "Cloudinary"),
      cloud.connected ? [
        h("div", { class: "toggle-row" }, h("div", {}, "Cloud name"), h("span", { class: "mono" }, cloud.cloud_name)),
        h("div", { class: "toggle-row" }, h("div", {}, "API key"), h("span", { class: "mono" }, cloud.api_key)),
        h("div", { class: "toggle-row" }, h("div", {}, "API secret"), h("span", { class: "mono" }, cloud.api_secret)),
        h("div", { class: "toggle-row" }, h("div", {}, "Connection"), cloud.last_check_ok === false ? chip("failed", cloud.last_error || "check failed")
          : chip("posted", cloud.last_check_at ? `ok · checked ${ago(cloud.last_check_at)}` : "ok")),
      ] : h("p", { class: "muted" }, "Not connected here. (Worker secrets, if set, are used instead and are not shown.)"),
      h("div", { class: "row" },
        cloud.connected ? h("button", { onclick: async () => { if (await act(() => api("/api/integrations/cloudinary/test", { method: "POST" }), "Checked")) route(); } }, "Test") : null,
        h("button", { onclick: () => cloudinaryDrawer(cloud) }, cloud.connected ? "Update" : "Connect"),
        cloud.connected ? h("button", { class: "danger", onclick: () => confirmDrawer("Disconnect Cloudinary", "Removes the saved Cloudinary credentials from this dashboard. Cloudinary itself is not changed.",
          (cred) => api("/api/integrations/cloudinary", { method: "DELETE", body: cred })) } , "Disconnect") : null)));
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

async function cloudinaryDrawer(cloud) {
  const name = h("input", { required: true, value: cloud.cloud_name || "" });
  const key = h("input", { required: true, inputmode: "numeric", autocomplete: "off" });
  const secret = h("input", { type: "password", required: true, autocomplete: "off" });
  const re = await reauthFields();
  drawer(cloud.connected ? "Update Cloudinary" : "Connect Cloudinary", h("form", { onsubmit: async (e) => {
    e.preventDefault();
    if (await act(() => api("/api/integrations/cloudinary", { method: "PUT", body: { cloud_name: name.value, api_key: key.value, api_secret: secret.value, ...re.values() } }), "Cloudinary saved")) { closeDrawer(); route(); }
  } }, field("Cloud name", name), field("API key", key), field("API secret", secret, "Tested with Cloudinary before saving. A read-only key is best."), ...re.nodes,
    h("div", { class: "row end" }, h("button", { class: "primary", type: "submit" }, "Test and save"))));
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

// ---------- Uploads, library picker, automation ----------

const MAX_UPLOAD = { image: 10 * 1024 * 1024, video: 100 * 1024 * 1024 };
// Signed by the Worker; the file goes straight from the browser to Cloudinary (the API secret never reaches the browser).
async function uploadToCloudinary(file, folder, onProgress = null) {
  const type = file.type.startsWith("video/") ? "video" : file.type.startsWith("image/") ? "image" : null;
  if (!type) throw new Error("Choose an image or a video");
  if (file.size > MAX_UPLOAD[type]) throw new Error(`Too large: ${type === "image" ? "10" : "100"} MB at most`);
  const sig = await api("/api/media/upload-signature", { method: "POST", body: { folder } });
  const form = new FormData();
  form.append("file", file);
  for (const k of ["api_key", "timestamp", "signature", "folder", "asset_folder", "tags"]) form.append(k, sig[k]);
  const out = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", sig.upload_url);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => { let b = {}; try { b = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300 && b.secure_url) resolve(b); else reject(new Error(b.error?.message || `Upload failed (${xhr.status})`)); };
    xhr.onerror = () => reject(new Error("Upload failed: network error"));
    xhr.send(form);
  });
  if (type === "image" && file.size > 5 * 1024 * 1024) toast("Uploaded. Note: Telegram accepts photos up to 5 MB by link; use a smaller image for photo posts.", true);
  return out.secure_url;
}

async function pickMedia(onPick) {
  let lib;
  try { lib = await api("/api/media/library?folder=shakhira_admin"); } catch (e) { toast(e.message, true); return; }
  const grid = h("div", { class: "media-grid" }, lib.items.map((m) => h("button", { type: "button", class: "media-tile pick", onclick: () => { onPick(m.url); document.querySelector(".picker-close")?.click(); } },
    m.resource_type === "video" ? h("div", { class: "ph" }, "▶ video") : h("img", { src: m.url, alt: m.public_id, loading: "lazy" }),
    h("div", { class: "meta" }, h("span", { class: "clip mono" }, m.public_id.split("/").pop())))));
  const box = h("div", { class: "picker" }, h("div", { class: "row" }, h("h3", {}, "Choose from the dashboard library"), h("button", { type: "button", class: "picker-close", onclick: () => box.remove() }, "Close")),
    lib.items.length ? grid : h("p", { class: "muted" }, "No files yet. Upload one first."));
  document.querySelector(".drawer")?.append(box);
  box.scrollIntoView({ behavior: "smooth" });
}

async function pageMediaV2(main) {
  const folderParam = new URLSearchParams(location.hash.split("?")[1] || "").get("folder") || "shakhira_admin";
  let folders = [], lib = null, problem = null;
  try { folders = await api("/api/media/folders"); lib = await api(`/api/media/library?folder=${encodeURIComponent(folderParam)}`); } catch (e) { problem = e.message; }
  const current = folders.find((f) => f.folder === folderParam) || folders[0];
  const picker = h("select", { onchange: (e) => (location.hash = `#media?folder=${encodeURIComponent(e.target.value)}`) },
    folders.map((f) => h("option", { value: f.folder, selected: f.folder === current?.folder }, f.label)));
  const status = h("p", { class: "small muted" });
  const input = h("input", { type: "file", accept: "image/*,video/*", multiple: true, hidden: true, onchange: async (e) => {
    const files = [...e.target.files];
    let done = 0;
    for (const f of files) {
      status.textContent = `Uploading ${done + 1} of ${files.length}: ${f.name}…`;
      try { await uploadToCloudinary(f, current.folder, (pct) => { status.textContent = `Uploading ${done + 1} of ${files.length}: ${f.name} — ${pct}%`; }); done++; } catch (err) { toast(`${f.name}: ${err.message}`, true); }
    }
    status.textContent = `${done} of ${files.length} uploaded.`;
    if (done) setTimeout(route, 600);
  } });
  put(main, head("Media library", "Upload, preview, reuse and remove media. Files are stored in your Cloudinary account."),
    problem ? h("div", { class: "banner warn" }, problem) : null,
    lib ? h("section", { class: "card" },
      h("div", { class: "row" }, field("Folder", picker), h("label", { class: "btn primary" }, "Upload photos or videos", input)),
      current && !current.deletable ? h("p", { class: "small muted" }, "Files here are posted automatically at 5 AM and 10 PM IST by the GitHub poster (smart rotation). They are not removed from the dashboard.") : null,
      status,
      lib.items.length ? h("div", { class: "media-grid" }, lib.items.map((m) => h("div", { class: "media-tile" },
        m.resource_type === "video" ? h("video", { src: m.url, preload: "metadata", muted: true, controls: true }) : h("img", { src: m.url, alt: m.public_id, loading: "lazy" }),
        h("div", { class: "meta" }, h("span", { class: "clip mono" }, m.public_id.split("/").pop()), h("span", { class: "muted" }, `${(m.bytes / 1048576).toFixed(1)} MB`), m.in_use ? chip("scheduled", "in a post") : null),
        h("div", { class: "row" },
          h("button", { class: "link", onclick: () => editor(null, { kind: m.resource_type === "video" ? "video" : "photo", media_url: m.url }) }, "New post"),
          h("button", { class: "link", onclick: () => editor(null, { kind: "paid_media", media_url: m.url, star_count: 50 }) }, "Paid post"),
          h("button", { class: "link", onclick: async () => { try { await navigator.clipboard.writeText(m.url); toast("Link copied"); } catch { toast(m.url); } } }, "Copy link"),
          current.deletable ? h("button", { class: "link danger", onclick: async () => {
            if (confirm("Remove this file from Cloudinary? This cannot be undone.") && await act(() => api("/api/media/delete", { method: "POST", body: { public_id: m.public_id, resource_type: m.resource_type } }), "Removed")) route();
          } }, "Remove") : null)))) : h("p", { class: "empty" }, "No files in this folder yet.")) : null);
  await pageMediaPoster(main, { append: true }).catch(() => {});
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
      sw("poster_paused", a.poster_paused, `GitHub auto-poster (${a.poster_slots_ist.join(" and ")})`, "Smart rotation from Cloudinary. When paused, the GitHub job skips its slot and posts nothing."),
      h("p", { class: "small muted" }, "The GitHub poster reads this switch only after its secret POSTER_CONTROL_URL is set to ", h("span", { class: "mono" }, location.origin + a.poster_control_path),
        " (GitHub → Settings → Secrets → Actions). If the dashboard can't be reached, it posts as normal."),
      h("p", { class: "small muted" }, "Individual features (polls, expiry, paid-media automation…) are in ", h("a", { href: "#settings" }, "Features & settings"), ". The dashboard never posts the GitHub poster's media, so nothing is posted twice.")),
    h("section", { class: "card" }, h("h2", {}, "Private preview chat"),
      h("p", { class: "small muted" }, "Your own Telegram user ID (from @userinfobot). Send /start to the bot from that account first. While the preview lock is on, everything is sent only here."),
      h("form", { onsubmit: async (e) => {
        e.preventDefault();
        if (await act(() => api("/api/automation/preview-chat", { method: "PUT", body: { preview_chat_id: chat.value.trim(), ...re.values() } }), "Saved")) route();
      } }, field("Preview chat ID", chat), ...re.nodes, h("div", { class: "row end" }, h("button", { class: "primary", type: "submit" }, "Save")))));
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
      "Telegram tokens and Cloudinary secrets encrypted per record; never shown in full",
      "Every change is written to the activity log",
    ].map((t) => h("li", {}, t))), h("a", { href: "#activity" }, "Open activity log →")),
    can("backup") ? await backupCard() : null);
}
