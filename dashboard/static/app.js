// Shakhira admin dashboard. Plain JS, no build step. All text is inserted with textContent
// (never innerHTML), so names, captions and messages from Telegram users can't inject markup.

const state = { csrf: null, user: null, badges: {} };
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
  posted: "good", scheduled: "info", draft: "", sending: "warn", failed: "bad", uncertain: "warn", cancelled: "",
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

const PAGES = [
  ["overview", "Overview", pageOverview],
  ["content", "Posts & polls", pageContent],
  ["calendar", "Calendar", pageCalendar],
  ["media", "Media library", pageMedia],
  ["subscribers", "Subscribers", pageSubscribers],
  ["joins", "Join requests", pageJoins],
  ["moderation", "Moderation", pageModeration],
  ["analytics", "Analytics", pageAnalytics],
  ["settings", "Features & settings", pageSettings],
  ["activity", "Activity log", pageActivity],
];

function renderLogin(message) {
  const pw = h("input", { type: "password", autocomplete: "current-password", required: true, "aria-label": "Password" });
  const err = h("p", { class: "small", hidden: !message }, message || "");
  const form = h("form", { onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/login", { method: "POST", body: { password: pw.value } });
      state.csrf = r.csrf; state.user = r.user; route();
    } catch (ex) { err.hidden = false; err.textContent = ex.message; pw.select(); }
  } }, field("Password", pw), err, h("button", { class: "primary", type: "submit" }, "Sign in"));
  put(document.getElementById("app"), h("div", { class: "login" },
    h("div", { class: "card" }, h("h1", {}, "💎 Shakhira admin"), h("p", { class: "muted" }, "Sign in to manage the channels."), form)));
  pw.focus();
}

function renderShell(active) {
  const nav = h("nav", { class: "nav", "aria-label": "Sections" },
    h("div", { class: "brand" }, h("span", {}, "💎"), "Shakhira admin"),
    PAGES.map(([id, label]) => h("a", { href: `#${id}`, class: id === active ? "active" : "", "aria-current": id === active ? "page" : null },
      label, state.badges[id] ? h("span", { class: "count" }, state.badges[id]) : null)),
    h("div", { class: "nav-foot" },
      h("button", { onclick: toggleTheme }, "Light / dark"),
      h("button", { onclick: async () => { await act(() => api("/api/logout", { method: "POST" })); state.user = null; renderLogin(); } }, "Sign out")));
  const main = h("main", { class: "main", id: "main" });
  put(document.getElementById("app"), h("div", { class: "shell" }, nav, main));
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
    try { const me = await api("/api/me"); state.user = me.user; state.csrf = me.csrf; } catch { return renderLogin(); }
  }
  const id = (location.hash || "#overview").slice(1).split("/")[0];
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
    o.attention.length ? h("section", { class: "card", style: null }, h("h2", {}, "Needs attention"),
      table([{ label: "Post", render: (i) => `#${i.id} ${KIND_LABEL[i.kind]}` }, { label: "Status", render: (i) => chip(i.status) },
        { label: "Problem", render: (i) => i.last_error }], o.attention, { onRow: () => (location.hash = "#content") })) : null,
  );
}

const kpi = (label, value, sub) => h("div", { class: "card kpi" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), h("div", { class: "sub" }, sub));

async function pageContent(main) {
  const filter = new URLSearchParams(location.hash.split("?")[1] || "").get("status") || "";
  const [items, captions] = await Promise.all([api("/api/content" + (filter ? `?status=${filter}` : "")), api("/api/captions")]);
  const tabs = h("div", { class: "tabs", role: "tablist" }, ["", "scheduled", "draft", "posted", "failed", "uncertain"].map((st) =>
    h("button", { class: st === filter ? "active" : "", role: "tab", "aria-selected": String(st === filter),
      onclick: () => (location.hash = st ? `#content?status=${st}` : "#content") }, st ? st[0].toUpperCase() + st.slice(1) : "All")));
  put(main, 
    head("Posts & polls", "Text, media, polls, quizzes, VIP promotions and paid media for both channels", h("button", { class: "primary", onclick: () => editor() }, "New post")),
    h("section", { class: "card" }, tabs, table([
      { label: "When", render: (i) => when(i.posted_at || i.scheduled_at) },
      { label: "Type", render: (i) => KIND_LABEL[i.kind] },
      { label: "Channel", render: (i) => (i.target === "vip" ? "VIP" : "Public") },
      { label: "Content", render: (i) => h("div", { class: "clip" }, i.text || (i.use_caption_library ? "(caption from library)" : "—")) },
      { label: "Status", render: (i) => h("div", {}, chip(i.status), i.last_error ? h("div", { class: "small muted" }, i.last_error) : null) },
      { label: "", render: (i) => rowActions(i) },
    ], items, { empty: "No posts yet. Create one with New post." })),
    h("section", { class: "card", style: null }, h("h2", {}, "Caption library"),
      h("p", { class: "muted small" }, "Media posts set to “use caption library” take the least-used active caption, so captions rotate evenly."),
      captionEditor(captions)));
}

function rowActions(i) {
  const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
  const btns = [];
  if (["draft", "scheduled", "failed"].includes(i.status)) btns.push(h("button", { class: "link", onclick: stop(() => editor(i)) }, "Edit"));
  if (["draft", "failed"].includes(i.status)) btns.push(h("button", { class: "link", onclick: stop(() => schedulePrompt(i)) }, "Schedule"));
  if (["draft", "scheduled", "failed"].includes(i.status)) btns.push(h("button", { class: "link danger", onclick: stop(async () => { if (await act(() => api(`/api/content/${i.id}/cancel`, { method: "POST" }), "Cancelled")) route(); }) }, "Cancel"));
  if (["draft", "cancelled"].includes(i.status)) btns.push(h("button", { class: "link danger", onclick: stop(async () => { if (confirm("Delete this post?") && await act(() => api(`/api/content/${i.id}`, { method: "DELETE" }), "Deleted")) route(); }) }, "Delete"));
  if (["poll", "quiz"].includes(i.kind) && i.status === "posted" && !i.poll_closed_at) btns.push(h("button", { class: "link", onclick: stop(async () => { if (await act(() => api("/api/actions", { method: "POST", body: { kind: "close_poll", payload: { content_id: i.id } } }), "The worker will close the poll")) route(); }) }, "Close poll"));
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

function editor(item) {
  const v = item || { kind: "text", target: "public", options: ["", ""] };
  const kind = h("select", {}, Object.entries(KIND_LABEL).map(([k, l]) => h("option", { value: k, selected: k === v.kind }, l)));
  const target = h("select", {}, h("option", { value: "public", selected: v.target === "public" }, "Public channel"), h("option", { value: "vip", selected: v.target === "vip" }, "VIP channel"));
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
    media: field("Media link", mediaUrl, "An https link Telegram can download (Cloudinary works). Photos up to 5 MB, other files up to 20 MB by link."),
    lib: h("label", { class: "inline field" }, useLib, "Leave the caption empty and use the caption library"),
    poll: h("div", {}, h("h3", {}, "Options"), optsBox),
    multi: h("label", { class: "inline field" }, multi, "Allow several answers"),
    quiz: h("div", {}, field("Correct answer", correct), field("Explanation (shown after answering)", explanation)),
    close: field("Close automatically after (minutes)", closeAfter, "Results are saved for Analytics when the poll closes."),
    stars: field("Price in Stars", stars, "Paid media is unlocked by each viewer for this many Stars."),
    button: h("div", {}, h("h3", {}, "Button (optional)"), field("Button text", btnText), field("Button link", btnUrl)),
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
    groups.button.hidden = ["poll", "quiz", "paid_media"].includes(k);
    groups.text.firstChild.textContent = ["poll", "quiz"].includes(k) ? "Question" : isMedia ? "Caption" : "Text";
  }
  kind.addEventListener("change", show);
  show();

  const payload = () => ({
    kind: kind.value, target: target.value, text: text.value, media_url: mediaUrl.value, use_caption_library: useLib.checked,
    options, correct_option: Number(correct.value || 0), explanation: explanation.value, multiple_answers: multi.checked,
    close_after_minutes: closeAfter.value || null, star_count: stars.value || null, button_text: btnText.value,
    button_url: btnUrl.value, scheduled_at: istInputToTs(at.value),
  });
  async function save(schedule) {
    const body = payload();
    if (schedule && !body.scheduled_at) { toast("Choose when to publish", true); return; }
    const saved = await act(async () => {
      let r = item ? await api(`/api/content/${item.id}`, { method: "PUT", body }) : await api("/api/content", { method: "POST", body });
      if (schedule) r = await api(`/api/content/${r.id}/schedule`, { method: "POST", body: { scheduled_at: body.scheduled_at } });
      return r;
    }, schedule ? "Scheduled" : "Saved as draft");
    if (saved) { closeDrawer(); location.hash = "#content"; route(); }
  }
  drawer(item ? `Edit post #${item.id}` : "New post", h("form", { onsubmit: (e) => { e.preventDefault(); save(true); } },
    h("div", { class: "grid two" }, field("Type", kind), field("Channel", target)),
    groups.text, groups.media, groups.lib, groups.poll, groups.multi, groups.quiz, groups.close, groups.stars, groups.button,
    field("Publish at (India time)", at, "Posts go out within about 30 seconds of this time, once the worker is running and Scheduled posts is on."),
    h("div", { class: "row end" }, h("button", { type: "button", onclick: () => save(false) }, "Save draft"), h("button", { class: "primary", type: "submit" }, "Schedule"))));
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
  const p = await api("/api/poster");
  put(main, head("Media library", "The Cloudinary folder the automatic poster uses (read-only)",
    p.configured ? h("button", { onclick: async () => { await api("/api/poster?refresh=true"); route(); } }, "Refresh") : null));
  if (!p.configured) {
    main.append(h("div", { class: "banner" }, "Not connected. Add CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET to the dashboard's .env to see the folder here."));
    return;
  }
  if (p.error) { main.append(h("div", { class: "banner bad" }, p.error)); return; }
  const inv = p.inventory;
  main.append(
    inv.remaining < 5 ? h("div", { class: "banner " + (inv.remaining ? "warn" : "bad") }, inv.remaining ? `Only ${inv.remaining} unpublished files left. Upload more to “${p.folder}”.` : `Nothing left to post. Upload new media to “${p.folder}”.`) : null,
    h("div", { class: "grid kpis" }, kpi("Left to post", num(inv.remaining), `in “${p.folder}”`), kpi("Posted", num(inv.posted), `${num(inv.reusable_now)} reusable now (30+ days old)`),
      kpi("Need a check", num(inv.uncertain + inv.rejected), "uncertain or rejected"), kpi("Unsupported", num(inv.unsupported), "format or size")),
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
    h("div", { class: "banner warn" }, "Safety: the dashboard never holds the bot token. The send-only worker carries out these features and never receives updates, so the live bot keeps working. Features marked “full bot” only work after the live bot has been retired and replaced; until then they record nothing."),
    h("section", { class: "card" }, h("h2", {}, "Features"), Object.entries(st.features).map(([name, f]) => h("div", { class: "toggle-row" },
      h("div", {}, h("div", {}, f.description, " ", FULL_BOT_FEATURES.has(name) ? chip("pending", "full bot") : chip("scheduled", "worker")), h("div", { class: "small muted mono" }, name)), toggle(name, f)))),
    h("section", { class: "card", style: null }, h("h2", {}, "Join requests"), policy("public", `Public channel (${st.public_channel})`), policy("vip", "VIP channel")));
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
