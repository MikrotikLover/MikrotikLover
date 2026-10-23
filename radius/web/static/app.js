// MikrotikLover RADIUS dashboard — vanilla JS, no build step, no external requests.
// All data is rendered with textContent (never innerHTML) so names from the network cannot inject HTML.

const $app = document.getElementById("app");
let me = null;            // {user, role, csrf}
let timers = [];          // page refresh timers, cleared on navigation

// ------------------------------------------------------------------ DOM helper
// like h(): replaceChildren(a, cond ? b : null, [c, d]) skips the empty ones instead of writing "null"
const _replaceChildren = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function (...kids) {
  return _replaceChildren.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
};
function h(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(tag === "svg" || attrs._svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false || k === "_svg") continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.setAttribute("class", v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svg = (tag, attrs = {}, ...kids) => h(tag, { ...attrs, _svg: true }, ...kids);

const ICONS = {
  home: "M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  users: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6m13 9v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  groups: "M4 6h16M4 12h16M4 18h10",
  mac: "M4 5h16v10H4zM8 19h8M12 15v4",
  router: "M3 14h18v5H3zM7 17h.01M11 17h.01M12 14V8m-4-2a6 6 0 0 1 8 0M5.5 3.5a10 10 0 0 1 13 0",
  online: "M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01",
  live: "M3 12h4l3-8 4 16 3-8h4",
  reports: "M4 20V10m6 10V4m6 16v-7m6 7H2",
  data: "M12 3v12m0 0-4-4m4 4 4-4M5 21h14",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6m7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2",
  menu: "M4 6h16M4 12h16M4 18h16",
  term: "M3 4h18v16H3zM7 9l3 3-3 3M13 15h4",
  graph: "M3 3v18h18M7 15l4-4 3 3 6-7",
  team: "M17 20v-2a4 4 0 0 0-3-3.9M7 20v-2a4 4 0 0 1 4-4h2M12 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 8v6M16 11h6",
  pin: "M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12zM12 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  plan: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5",
  voucher: "M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM14 7v12",
  money: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01",
  print: "M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14m10 3-5.2-5.2",
  block: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M5.6 5.6l12.8 12.8",
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  device: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 7h4M12 17h4",
  mail: "M3 6h18v12H3zM3 7l9 6 9-6",
  wall: "M3 5h18v14H3zM3 9.7h18M3 14.3h18M9 5v4.7M15 9.7v4.6M9 14.3V19",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM12 8v5m0 3h.01",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  phone: "M7 2h10v20H7zM11 18h2",
  brush: "M4 20c3 0 5-2 5-5l9-9a2 2 0 0 0-3-3l-9 9c-3 0-5 2-5 5zM13 7l3 3",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9",
  vpn: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  ports: "M7 7h10v10H7zM3 9h4M3 15h4M17 9h4M17 15h4M9 3v4M15 3v4M9 17v4M15 17v4",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 16v-4M12 8h.01",
  edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
};
const icon = (name) => svg("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }, svg("path", { d: ICONS[name] }));

// ------------------------------------------------------------------ formatting
function bytes(n) {
  n = Number(n) || 0;
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}`;
}
function duration(s) {
  s = Math.max(0, Number(s) || 0);
  const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${m}m` : `${m}m`;
}
function ago(ts) {
  if (!ts) return "—";
  const t = new Date(String(ts).replace(" ", "T"));
  if (isNaN(t)) return ts;
  const s = (Date.now() - t.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return String(ts).slice(0, 16);
}
const num = (n) => Number(n || 0).toLocaleString();
const money = (n, cur = "Rs") => `${cur} ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
function dur(sec) {          // plan durations: 86400 -> "1 day", 7200 -> "2 h"
  sec = Number(sec) || 0;
  if (!sec) return "—";
  if (sec % 86400 === 0) return `${sec / 86400} day${sec === 86400 ? "" : "s"}`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  return `${Math.round(sec / 60)} min`;
}
const gb = (b) => (Number(b) ? bytes(b) : "Unlimited");
const isAdmin = () => me && me.role === "admin";

// ------------------------------------------------------------------ API
async function api(method, path, data) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (method !== "GET" && data === undefined) data = {};   // the server only accepts JSON bodies for changes
  if (data !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(data); }
  if (method !== "GET" && me) opts.headers["X-CSRF-Token"] = me.csrf;
  const r = await fetch(path, opts);
  let body = {};
  try { body = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && path !== "/api/login") { me = null; renderLogin(); throw new Error("login required"); }
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function toast(msg, error = false) {
  const t = h("div", { class: "toast" + (error ? " error" : "") }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), error ? 8000 : 4500);
}

async function act(promise, okMsg) {
  try { const r = await promise; toast(r.message || okMsg || "Done"); return r; }
  catch (e) { if (e.message !== "login required") toast(e.message, true); return null; }
}

// ------------------------------------------------------------------ dialogs
function dialog(title, bodyEl, buttons) {
  const dlg = h("dialog", {},
    h("div", { class: "dlg-head" }, title),
    h("div", { class: "dlg-body" }, bodyEl),
    h("div", { class: "dlg-foot" }, buttons.map((b) => h("button", {
      class: b.class || "", onclick: async (ev) => {
        if (b.action) {
          ev.target.disabled = true;
          const keep = await b.action();
          ev.target.disabled = false;
          if (keep === false) return;
        }
        dlg.close();
      },
    }, b.label))));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}
function confirmDlg(title, text, label = "Confirm", danger = true) {
  return new Promise((resolve) => {
    let ok = false;
    const d = dialog(title, h("p", {}, text), [
      { label: "Cancel" },
      { label, class: danger ? "primary danger-fill" : "primary", action: () => { ok = true; } },
    ]);
    d.addEventListener("close", () => resolve(ok));
  });
}
function showSecret(title, label, secret, extra) {
  dialog(title, h("div", { class: "stack" }, h("div", {}, label), h("div", { class: "secret-box" }, secret),
    extra ? h("div", { class: "muted" }, extra) : null), [{ label: "Close", class: "primary" }]);
}
const formValues = (form) => Object.fromEntries([...form.querySelectorAll("[name]")].map((el) =>
  [el.name, el.type === "checkbox" ? el.checked : el.value.trim()]));

// ------------------------------------------------------------------ small components
function table(cols, rows, empty = "Nothing here yet.") {
  if (!rows.length) return h("div", { class: "empty" }, empty);
  return h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
    h("tbody", {}, rows.map((r) => h("tr", {}, cols.map((c) => {
      const v = c.render ? c.render(r) : r[c.key];
      return h("td", { class: (c.num ? "num " : "") + (c.wrap ? "wrap" : ""), "data-l": c.label || null }, v ?? "—");
    }))))));
}
const card = (title, sub, ...kids) => h("div", { class: "card" }, title ? h("h2", {}, h("span", {}, title), sub ? h("span", { class: "sub" }, sub) : null) : null, ...kids);
const tile = (label, value, hint) => h("div", { class: "card tile" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), hint ? h("div", { class: "hint" }, hint) : null);
const badge = (text, kind = "") => h("span", { class: "badge " + kind }, text);

function hbars(rows, labelKey) {
  if (!rows.length) return h("div", { class: "empty" }, "No data yet.");
  const max = Math.max(...rows.map((r) => Number(r.down) + Number(r.up)), 1);
  return h("div", { class: "hbars" }, rows.map((r) => {
    const down = h("div", { class: "hbar-down" }), up = h("div", { class: "hbar-up" });
    down.style.width = `${(Number(r.down) / max) * 100}%`;
    up.style.width = `${(Number(r.up) / max) * 100}%`;
    return h("div", { class: "hbar-row" }, h("div", { class: "hbar-label", title: r[labelKey] }, r[labelKey]),
      h("div", { class: "hbar-track" }, down, up), h("div", { class: "hbar-val" }, bytes(Number(r.down) + Number(r.up))));
  }));
}

function columnChart(points) {           // points: [{label, down, up}]
  const W = 720, H = 220, P = { l: 52, r: 8, t: 10, b: 26 };
  const max = Math.max(...points.map((p) => p.down + p.up), 1);
  const nice = Math.pow(1024, Math.floor(Math.log(max) / Math.log(1024)));
  const top = Math.ceil(max / nice / 2) * 2 * nice || 1;
  const bw = (W - P.l - P.r) / Math.max(points.length, 1);
  const y = (v) => H - P.b - (v / top) * (H - P.t - P.b);
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    kids.push(svg("line", { class: "grid-line", x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }));
    kids.push(svg("text", { class: "axis", x: P.l - 6, y: y(v) + 4, "text-anchor": "end" }, bytes(v)));
  }
  points.forEach((p, i) => {
    const x = P.l + i * bw + bw * 0.15, w = bw * 0.7;
    const t = svg("title", {}, `${p.label}: ↓ ${bytes(p.down)}  ↑ ${bytes(p.up)}`);
    kids.push(svg("rect", { class: "bar-down", x, width: w, y: y(p.down), height: Math.max(0, H - P.b - y(p.down)), rx: 2 }, t));
    kids.push(svg("rect", { class: "bar-up", x, width: w, y: y(p.down + p.up), height: Math.max(0, y(p.down) - y(p.down + p.up)), rx: 2 }));
    if (points.length <= 12 || i % Math.ceil(points.length / 12) === 0)
      kids.push(svg("text", { class: "axis", x: x + w / 2, y: H - 8, "text-anchor": "middle" }, p.label));
  });
  return svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Data usage chart" }, kids);
}
const legend = () => h("div", { class: "legend" }, h("span", {}, h("i", { class: "down" }), "Download"), h("span", {}, h("i", { class: "up" }), "Upload"));

// ------------------------------------------------------------------ shell + router
const NAV = [
  ["dashboard", "Dashboard", "home"], ["golive", "Setup steps", "flag"], ["users", "Users", "users"], ["groups", "Groups & policies", "groups"], ["departments", "Departments", "team"],
  ["macs", "MAC devices", "mac"], ["ipbind", "IP binding", "pin"], ["routers", "Routers", "router"], ["devices", "Devices (SNMP)", "device"], ["setup", "Router setup", "term"], "-",
  ["plans", "Plans", "plan"], ["vouchers", "Vouchers", "voucher"], ["sales", "Sales", "money"], ["speed", "Speed schedule", "clock"], ["hotspot", "Hotspot page", "brush"], ["social", "Social WiFi", "phone"], "-",
  ["online", "Online now", "online"], ["live", "Live log", "live"], ["insights", "Insights (samajh)", "bulb"], ["reports", "Reports", "reports"], ["cdn", "CDN detective", "search"],
  ["traffic", "Traffic graphs", "graph"], ["data", "Data usage", "data"], ["apps", "Apps on network", "apps"], ["ports", "Ports & protocols", "ports"], "-",
  ["firewall", "Firewall", "wall"], ["mail", "Mail server", "mail"], ["blocking", "Blocking", "block"], ["vpn", "VPN & proxy watch", "vpn"], ["security", "Security", "shield"], ["domains", "Website names", "globe"], "-", ["health", "Health check", "pulse"], ["settings", "Settings", "settings"],
];

function shell(title, content, actions) {
  const side = h("aside", { class: "side" },
    h("div", { class: "brand" }, h("div", { class: "brand-logo" }, icon("online")), h("div", {}, "MikrotikLover", h("small", {}, "RADIUS dashboard"))),
    h("nav", { class: "nav" }, NAV.map((n) => n === "-" ? h("div", { class: "nav-sep" }) :
      h("a", { href: `#/${n[0]}`, class: location.hash.split("/")[1] === n[0] ? "active" : "", onclick: () => side.classList.remove("open") }, icon(n[2]), n[1]))));
  $app.className = "";
  $app.replaceChildren(h("div", { class: "shell" }, side,
    h("div", { class: "main" },
      h("header", { class: "top" },
        h("div", { class: "toolbar" }, h("button", { class: "icon menu-btn", "aria-label": "Menu", onclick: () => side.classList.toggle("open") }, icon("menu")), h("h1", {}, title)),
        h("div", { class: "top-right" }, actions || null, h("span", {}, `${me.user}`, " ", badge(me.role, me.role === "admin" ? "info" : "")),
          h("button", { class: "small", onclick: async () => { await api("POST", "/api/logout", {}); me = null; renderLogin(); } }, "Log out"))),
      h("main", { class: "content" }, content))));
}

const ROUTES = {};
// One page is drawn at a time. A click while a page is still loading waits for it and then draws the
// newest page — before, a slow page that finished late was drawn over the page the user went to.
let routeBusy = null, routeAgain = false;
function route() {
  if (routeBusy) { routeAgain = true; return routeBusy; }
  routeBusy = (async () => {
    do { routeAgain = false; await routeOnce(); } while (routeAgain);
  })().finally(() => { routeBusy = null; });
  return routeBusy;
}
async function routeOnce() {
  timers.forEach(clearInterval); timers = [];
  if (!me) return renderLogin();
  const [, page = "dashboard", ...rest] = location.hash.split("/");
  const fn = ROUTES[page] || ROUTES.dashboard;
  try { await fn(...rest.map(decodeURIComponent)); }
  catch (e) { if (e.message !== "login required") shell("Error", card(null, null, h("div", { class: "note" }, e.message))); }
}
// another page (link, Back button): a dialog of the old page must not stay open on top of it
window.addEventListener("hashchange", () => { document.querySelectorAll("dialog[open]").forEach((d) => d.close()); route(); });
const every = (ms, fn) => timers.push(setInterval(fn, ms));

// ------------------------------------------------------------------ login
function renderLogin() {
  timers.forEach(clearInterval); timers = [];
  const err = h("div", { class: "note", hidden: true });
  const form = h("form", { class: "form", onsubmit: async (ev) => {
    ev.preventDefault();
    err.hidden = true;
    try {
      me = await api("POST", "/api/login", formValues(form));
      if (!location.hash || location.hash === "#/login") location.hash = "#/dashboard";
      route();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  } },
    h("label", { class: "field" }, "Username", h("input", { name: "username", autocomplete: "username", required: true, autofocus: true })),
    h("label", { class: "field" }, "Password", h("input", { name: "password", type: "password", autocomplete: "current-password", required: true })),
    err, h("button", { class: "primary", type: "submit" }, "Log in"));
  $app.className = "";
  $app.replaceChildren(h("div", { class: "login-wrap" }, h("div", { class: "card login" },
    h("div", { class: "brand" }, h("div", { class: "brand-logo" }, icon("online")), h("div", {}, "MikrotikLover", h("small", {}, "RADIUS dashboard"))), form)));
}

// ------------------------------------------------------------------ dashboard
ROUTES.dashboard = async () => {
  const load = async () => {
    const d = await api("GET", "/api/summary");
    const c = d.counts;
    const byHour = new Map(d.hours.map((r) => [r.bucket.slice(0, 13), r]));
    const points = [];
    for (let i = 23; i >= 0; i--) {
      const t = new Date(Date.now() - i * 3600e3);
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")} ${String(t.getHours()).padStart(2, "0")}`;
      const r = byHour.get(key);
      points.push({ label: `${String(t.getHours()).padStart(2, "0")}h`, down: Number(r?.down || 0), up: Number(r?.up || 0) });
    }
    shell("Dashboard", h("div", { class: "stack" },
      h("div", { class: "grid g-tiles" },
        tile("Online now", num(c.online), "active sessions"),
        tile("Users", num(c.users), `${num(c.groups)} groups`),
        tile("MAC devices", num(c.macs)),
        tile("Routers", num(c.routers)),
        tile("Logins today", num(c.accepts), `${num(c.rejects)} rejected`),
        tile("Data today", bytes(Number(c.down_today) + Number(c.up_today)), `↓ ${bytes(c.down_today)}  ↑ ${bytes(c.up_today)}`),
        tile("Blocked today", num(c.blocked_today), "web-filter hits"),
        tile("Sales today", money(c.sales_today, c.currency), `${money(c.sales_month, c.currency)} this month`),
        tile("Active packages", num(c.active_plans), `${num(c.unused_vouchers)} unused vouchers`)),
      h("div", { class: "grid g-3" },
        card("Data usage", "last 24 hours", columnChart(points), legend()),
        card("Top sites today", "download + upload", hbars(d.top_sites, "site"))),
      card("Recent logins", h("a", { href: "#/reports/logins" }, "All →"), table([
        { label: "User", render: (r) => h("a", { href: `#/users/${encodeURIComponent(r.username)}` }, r.username) },
        { label: "Result", render: (r) => r.reply === "Access-Accept" ? badge("accepted", "ok") : badge("rejected", "bad") },
        { label: "When", render: (r) => ago(r.authdate) }], d.logins))));
  };
  await load();
  every(30000, () => load().catch(() => {}));
};

// ------------------------------------------------------------------ users
function userForm(groups, policies) {
  return h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
    h("label", { class: "field" }, "Username", h("input", { name: "name", required: true, pattern: "[A-Za-z0-9._@+\\-]{1,64}", placeholder: "ali" })),
    h("label", { class: "field" }, "Password", h("input", { name: "password", type: "text", autocomplete: "off", placeholder: "empty = generate" })),
    h("label", { class: "field" }, "Group", h("select", { name: "group" }, h("option", { value: "" }, "— none —"), groups.map((g) => h("option", { value: g.name }, g.name)))),
    h("label", { class: "check full" }, h("input", { type: "checkbox", name: "nt_hash" }), "Store NT-hash instead of the password (WPA-Enterprise only — breaks hotspot CHAP login)"));
}

ROUTES.users = async (name) => {
  if (name) return userDetail(name);
  const [{ users }, { groups, policies }] = await Promise.all([api("GET", "/api/users"), api("GET", "/api/groups")]);
  const list = users.filter((u) => !u.is_mac);
  const vouchers = users.filter((u) => u.voucher_batch).length;
  const search = h("input", { type: "search", placeholder: "Search users…", oninput: () => draw() });
  const holder = h("div");
  const draw = () => {
    const s = search.value.toLowerCase();
    holder.replaceChildren(table([
      { label: "User", render: (u) => h("a", { href: `#/users/${encodeURIComponent(u.username)}` }, u.username) },
      { label: "Group", render: (u) => u.grp || "—" },
      { label: "Policy", render: (u) => u.policy ? h("span", {}, u.policy, " ", u.policy_source === "group" ? h("span", { class: "muted" }, "(group)") : null) : "—" },
      { label: "Plan / expiry", render: (u) => u.plan ? h("span", {}, u.plan, " ", h("span", { class: "muted" }, u.expires_at ? (new Date(u.expires_at.replace(" ", "T")) < new Date() ? "expired" : `till ${u.expires_at.slice(0, 16)}`) : "not started")) : "—" },
      { label: "Status", render: (u) => u.disabled ? badge("disabled", "bad") : u.online ? badge("online", "ok") : badge("offline") },
      { label: "Last login", render: (u) => ago(u.last_login) },
      { label: "", render: (u) => isAdmin() ? h("div", { class: "row-actions" },
          u.online ? h("button", { class: "small", onclick: () => act(api("POST", `/api/users/${encodeURIComponent(u.username)}/kick`, {})).then(route) }, "Kick") : null,
          h("button", { class: "small", onclick: () => act(api("POST", `/api/users/${encodeURIComponent(u.username)}/${u.disabled ? "enable" : "disable"}`, {})).then(route) }, u.disabled ? "Enable" : "Disable")) : null },
    ], list.filter((u) => s ? (u.username.toLowerCase().includes(s) || (u.grp || "").toLowerCase().includes(s)) : !u.voucher_batch), "No users yet — add the first one."));
  };
  draw();
  const add = () => {
    const form = userForm(groups, policies);
    dialog("Add user", form, [{ label: "Cancel" }, { label: "Create user", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      const r = await act(api("POST", "/api/users", formValues(form)));
      if (!r) return false;
      if (r.password) showSecret("User created", "Give this password to the user:", r.password);
      route();
    } }]);
  };
  shell("Users", card(null, null, h("div", { class: "toolbar" }, search, h("span", { class: "grow" }), h("span", { class: "muted" }, `${list.length - vouchers} users`, vouchers ? ` · ${vouchers} vouchers (see Vouchers)` : ""),
    isAdmin() ? h("button", { class: "primary", onclick: add }, icon("plus"), "Add user") : null), holder));
};

async function userDetail(name) {
  const [d, { groups, policies }] = await Promise.all([api("GET", `/api/users/${encodeURIComponent(name)}`), api("GET", "/api/groups")]);
  const enc = encodeURIComponent(name);
  const disabled = d.check.some((c) => c.attribute === "Auth-Type" && c.value === "Reject");
  const ownPolicy = (d.reply.find((r) => r.attribute === "Mikrotik-Address-List")?.value || "").replace(/^policy-/, "");
  const online = d.sessions.filter((s) => !s.acctstoptime);
  const days = d.usage.map((u) => ({ label: u.day.slice(5), down: Number(u.down), up: Number(u.up) }));

  const groupSel = h("select", {}, h("option", { value: "" }, "— none —"), groups.map((g) => h("option", { value: g.name, selected: g.name === d.group }, g.name)));
  const policySel = h("select", {}, h("option", { value: "" }, "— group policy —"), policies.map((p) => h("option", { value: p.name, selected: p.name === ownPolicy }, p.name)));
  const adminBox = isAdmin() ? card("Manage", null, h("div", { class: "form" },
    h("label", { class: "field" }, "Group", h("div", { class: "toolbar" }, groupSel,
      h("button", { onclick: () => act(api("POST", `/api/users/${enc}/group`, { group: groupSel.value })).then(route) }, "Save"))),
    h("label", { class: "field" }, "Own web-filter policy", h("span", { class: "help" }, "Overrides the group's policy. Hotspot users; the user is disconnected so it applies at the next login."),
      h("div", { class: "toolbar" }, policySel,
        h("button", { onclick: () => act(api("POST", `/api/users/${enc}/policy`, { policy: policySel.value })).then(route) }, "Save"))),
    (() => {
      const phIn = h("input", { value: d.phone || "", placeholder: "03001234567", size: 14, inputmode: "tel" });
      return h("label", { class: "field" }, "Phone (warning SMS)", h("span", { class: "help" }, "SMS warning before expiry or when the data is almost used up (Settings → Warn users)."),
        h("div", { class: "toolbar" }, phIn, h("button", { onclick: () => act(api("POST", `/api/users/${enc}/phone`, { phone: phIn.value.trim() })).then(route) }, "Save")));
    })(),
    (() => {
      const cur = d.reply.find((r) => r.attribute === "Framed-IP-Address")?.value || "";
      const ipIn = h("input", { value: cur, placeholder: "e.g. 10.20.0.50", size: 14 });
      return h("label", { class: "field" }, "Static IP (PPPoE)", h("span", { class: "help" }, "Empty = an address from the pool."),
        h("div", { class: "toolbar" }, ipIn, h("button", { onclick: () => act(api("POST", `/api/users/${enc}/ip`, { ip: ipIn.value.trim() })).then(route) }, "Save")));
    })(),
    h("div", { class: "toolbar" },
      h("button", { onclick: () => {
        const f = h("form", { class: "form" }, h("label", { class: "field" }, "New password", h("input", { name: "password", autocomplete: "off", placeholder: "empty = generate" })),
          h("label", { class: "check" }, h("input", { type: "checkbox", name: "nt_hash" }), "Store NT-hash (WPA-Enterprise only)"));
        dialog(`Password for ${name}`, f, [{ label: "Cancel" }, { label: "Change", class: "primary", action: async () => {
          const r = await act(api("POST", `/api/users/${enc}/password`, formValues(f)));
          if (!r) return false;
          if (r.password) showSecret("Password changed", "New password:", r.password);
        } }]);
      } }, "Change password"),
      online.length ? h("button", { onclick: () => act(api("POST", `/api/users/${enc}/kick`, {})).then(route) }, "Kick now") : null,
      h("button", { onclick: () => act(api("POST", `/api/users/${enc}/${disabled ? "enable" : "disable"}`, {})).then(route) }, disabled ? "Enable" : "Disable"),
      h("button", { class: "danger", onclick: async () => {
        if (await confirmDlg("Delete user", `Delete ${name}? This cannot be undone.`, "Delete"))
          if (await act(api("DELETE", `/api/users/${enc}`))) location.hash = "#/users";
      } }, "Delete")))) : null;

  const subCard = await subscriptionCard(name, d.account);
  shell(name, h("div", { class: "stack" },
    h("div", {}, h("a", { href: "#/users" }, "← Users")),
    h("div", { class: "grid g-tiles" },
      tile("Status", disabled ? "Disabled" : online.length ? "Online" : "Offline", online[0] ? `${online[0].framedipaddress || ""} since ${ago(online[0].acctstarttime)}` : null),
      tile("Group", d.group || "—"),
      tile("Policy", ownPolicy || "group"),
      tile("Data 30 days", bytes(days.reduce((a, x) => a + x.down + x.up, 0)))),
    d.notice ? h("div", { class: "note warn-note" }, h("b", {}, "⚠ Warning this user sees now: "), d.notice) : null,
    subCard,
    h("div", { class: "grid g-2" }, adminBox,
      card("Settings", null, table([{ label: "Type", key: "t" }, { label: "Attribute", key: "attribute" }, { label: "Value", key: "value", wrap: true }],
        [...d.check.map((c) => ({ ...c, t: "check" })), ...d.reply.map((r) => ({ ...r, t: "reply" }))]))),
    h("div", { class: "grid g-3" },
      card("Data per day", "last 30 days", days.length ? [columnChart(days), legend()] : h("div", { class: "empty" }, "No traffic data (traffic collector).")),
      card("Top sites", "7 days", hbars(d.sites, "site"))),
    card("Sessions", "last 20", table([
      { label: "Started", render: (s) => String(s.acctstarttime || "").slice(0, 16) },
      { label: "Duration", render: (s) => duration(s.acctsessiontime) },
      { label: "IP", key: "framedipaddress" }, { label: "MAC", key: "callingstationid" }, { label: "Router", key: "nasipaddress" },
      { label: "Down", num: true, render: (s) => bytes(s.acctoutputoctets) }, { label: "Up", num: true, render: (s) => bytes(s.acctinputoctets) },
      { label: "End", render: (s) => s.acctstoptime ? (s.acctterminatecause || "stopped") : badge("online", "ok") }], d.sessions)),
    card("Login attempts", null, table([{ label: "When", render: (l) => String(l.authdate).slice(0, 19) },
      { label: "Result", render: (l) => l.reply === "Access-Accept" ? badge("accepted", "ok") : badge("rejected", "bad") }], d.logins))));
}

// ------------------------------------------------------------------ groups
function groupForm(g, policies) {
  const opt = (v, label, sel) => h("option", { value: v, selected: v === sel }, label);
  return h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
    h("label", { class: "field" }, "Name", h("input", { name: "name", required: true, pattern: "[A-Za-z0-9._@+\\-]{1,64}", value: g?.name || "", readonly: !!g })),
    h("label", { class: "field" }, "Description", h("input", { name: "description", maxlength: 128, value: g?.description || "" })),
    h("label", { class: "field" }, "Speed limit", h("span", { class: "help" }, "MikroTik rx/tx, e.g. 10M/10M"), h("input", { name: "rate", value: g?.rate || "", placeholder: "10M/10M" })),
    h("label", { class: "field" }, "VLAN", h("span", { class: "help" }, "1–4094 (WPA-Enterprise / MAC)"), h("input", { name: "vlan", type: "number", min: 1, max: 4094, value: g?.vlan || "" })),
    h("label", { class: "field" }, "Session timeout (s)", h("input", { name: "session_timeout", type: "number", min: 0, value: g?.session_timeout || "" })),
    h("label", { class: "field" }, "Idle timeout (s)", h("input", { name: "idle_timeout", type: "number", min: 0, value: g?.idle_timeout || "" })),
    h("label", { class: "field" }, "Devices per user", h("input", { name: "max_sessions", type: "number", min: 0, value: g?.max_sessions || "" })),
    h("label", { class: "field" }, "IP pool (PPPoE)", h("span", { class: "help" }, "MikroTik /ip pool name"), h("input", { name: "pool", value: g?.pool || "", placeholder: "pppoe-pool" })),
    h("label", { class: "field" }, "Web-filter policy", h("span", { class: "help" }, "Applies to hotspot logins"),
      h("select", { name: "policy" }, opt("", "— none —", g?.policy || ""), policies.map((p) => opt(p.name, `${p.name} — ${p.description}`, g?.policy || "")))));
}

ROUTES.groups = async () => {
  const { groups, policies } = await api("GET", "/api/groups");
  const edit = (g) => {
    const form = groupForm(g, policies);
    dialog(g ? `Edit group ${g.name}` : "Add group", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      const r = await act(api("POST", "/api/groups", { ...formValues(form), edit: !!g }));
      if (!r) return false;
      route();
    } }]);
  };
  shell("Groups & policies", h("div", { class: "stack" },
    card(null, null, h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "A group sets speed, VLAN, time limits and the web-filter policy for all its members."),
      isAdmin() ? h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "Add group") : null),
    table([
      { label: "Group", render: (g) => h("span", {}, h("b", {}, g.name), g.description ? h("div", { class: "muted" }, g.description) : null) },
      { label: "Users", key: "members", num: true },
      { label: "Speed", render: (g) => g.rate || "—" }, { label: "VLAN", render: (g) => g.vlan || "—" },
      { label: "Session", render: (g) => g.session_timeout ? duration(g.session_timeout) : "—" },
      { label: "Devices", render: (g) => g.max_sessions || "—" },
      { label: "Policy", render: (g) => g.policy ? badge(g.policy, "info") : g.address_list ? badge(g.address_list) : "—" },
      { label: "", render: (g) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: () => edit(g) }, "Edit"),
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Delete group", `Delete group ${g.name}? ${g.members} user(s) will have no group.`, "Delete"))
              if (await act(api("DELETE", `/api/groups/${encodeURIComponent(g.name)}`))) route();
          } }, "Delete")) : null }], groups, "No groups yet.")),
    card("Web-filter policies", "edit webfilter/policies/*.txt, then build.sh + import on the router",
      table([{ label: "Policy", render: (p) => badge(p.name, "info") }, { label: "What it blocks", key: "description", wrap: true },
        { label: "Router address list", render: (p) => h("code", {}, `policy-${p.name}`) }], policies, "No policies installed."))));
};

// ------------------------------------------------------------------ MAC devices
ROUTES.macs = async () => {
  const [{ macs }, { groups }, meta] = await Promise.all([api("GET", "/api/macs"), api("GET", "/api/groups"), api("GET", "/api/blocking").catch(() => ({ policies: [] }))]);
  const polOptions = (sel, empty) => [h("option", { value: "" }, empty), ...meta.policies.map((p) => h("option", { value: p.name, selected: p.name === sel }, `${p.name} — ${p.description}`))];
  const policyDlg = (m) => {
    const sel = h("select", { name: "policy" }, polOptions(m.policy, m.grp ? `follow the group (${m.group_policy || "no policy"})` : "— none —"));
    dialog(`Policy for ${m.mac}`, h("form", { class: "form", onsubmit: (e) => e.preventDefault() }, h("label", { class: "field" }, "Policy", sel,
      h("span", { class: "help" }, "Its own policy beats the group's. Applies at the device's next login (it is logged out once now)."))),
      [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => { if (!(await act(api("POST", `/api/macs/${m.mac}/policy`, { policy: sel.value })))) return false; route(); } }]);
  };
  const add = () => {
    const form = h("form", { class: "form policy-editor", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "MAC address", h("span", { class: "help" }, "Any format: aa:bb:cc:dd:ee:ff, AABB.CCDD.EEFF"), h("input", { name: "mac", required: true, placeholder: "aa:bb:cc:dd:ee:ff" })),
      h("label", { class: "field" }, "Description", h("input", { name: "description", maxlength: 128, placeholder: "Reception printer" })),
      h("label", { class: "field" }, "Group", h("select", { name: "group" }, h("option", { value: "" }, "— none —"), groups.map((g) => h("option", { value: g.name }, g.name)))),
      h("label", { class: "field" }, "Policy (optional)", h("select", { name: "policy" }, polOptions("", "— the group's / none —")),
        h("span", { class: "help" }, "e.g. a TV: no-video; a CCTV recorder: whatsapp-hikconnect; a POS: only its own site")));
    dialog("Add MAC device", form, [{ label: "Cancel" }, { label: "Add", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      if (!(await act(api("POST", "/api/macs", formValues(form))))) return false;
      route();
    } }]);
  };
  shell("MAC devices", card(null, null,
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "Printers, CCTV, TVs, POS — connect by MAC address, no password."),
      isAdmin() ? h("button", { class: "primary", onclick: add }, icon("plus"), "Add device") : null),
    table([
      { label: "MAC", render: (m) => h("code", {}, m.mac) }, { label: "Description", key: "description", wrap: true },
      { label: "Group", render: (m) => m.grp || "—" },
      { label: "Policy", render: (m) => m.policy ? badge(m.policy, "info") : m.group_policy ? h("span", {}, badge(m.group_policy, ""), h("span", { class: "muted small" }, " (group)")) : h("span", { class: "muted" }, "—") },
      { label: "Status", render: (m) => m.disabled ? badge("disabled", "bad") : m.online ? badge("online", "ok") : badge("offline") },
      { label: "Last seen", render: (m) => ago(m.last_seen) },
      { label: "", render: (m) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: () => policyDlg(m) }, "Policy"),
          h("button", { class: "small", onclick: () => act(api("POST", `/api/macs/${m.mac}/${m.disabled ? "enable" : "disable"}`, {})).then(route) }, m.disabled ? "Enable" : "Disable"),
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Remove device", `Remove ${m.mac}?`, "Remove"))
              if (await act(api("DELETE", `/api/macs/${m.mac}`))) route();
          } }, "Remove")) : null }], macs, "No MAC devices yet.")));
};

// ------------------------------------------------------------------ routers
ROUTES.routers = async () => {
  const { nas } = await api("GET", "/api/nas");
  const add = () => {
    const form = h("form", { class: "form policy-editor", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Router IP", h("span", { class: "help" }, "The address RADIUS packets come from (public IP behind NAT, or the WireGuard IP). A subnet like 10.10.0.0/24 is allowed."),
        h("input", { name: "ip", required: true, placeholder: "192.168.88.1" })),
      h("label", { class: "field" }, "Name", h("input", { name: "name", placeholder: "office-hap" })),
      h("label", { class: "field" }, "Shared secret", h("input", { name: "secret", autocomplete: "off", placeholder: "empty = generate a strong one" })));
    dialog("Add router", form, [{ label: "Cancel" }, { label: "Add router", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      const r = await act(api("POST", "/api/nas", formValues(form)));
      if (!r) return false;
      showSecret("Router added", "Run this on the MikroTik (Terminal):",
        `/radius add address=<this-server-ip> secret=${r.secret} service=wireless,hotspot,ppp,login timeout=3s\n/radius incoming set accept=yes`,
        "FreeRADIUS was restarted to load the new router.");
      route();
    } }]);
  };
  const net = await api("GET", "/api/network").catch(() => ({ routers: [], nas_without_report: [] }));
  shell("Routers", h("div", { class: "stack" }, routerHealth(net), card("RADIUS clients", "routers allowed to use this server",
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "MikroTik routers allowed to use this RADIUS server."),
      isAdmin() ? h("button", { class: "primary", onclick: add }, icon("plus"), "Add router") : null),
    table([
      { label: "Address", render: (n) => h("code", {}, n.nasname) }, { label: "Name", key: "shortname" },
      { label: "Secret", render: (n) => h("code", {}, n.secret) },
      { label: "", render: (n) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: async () => {
            try {
              const r = await api("GET", `/api/nas/secret?ip=${encodeURIComponent(n.nasname)}`);
              showSecret(`Secret of ${n.nasname}`, "Shared secret:", r.secret);
            } catch (e) { toast(e.message, true); }
          } }, "Show secret"),
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Remove router", `Remove ${n.nasname}? It will no longer be able to log users in.`, "Remove"))
              if (await act(api("DELETE", `/api/nas?ip=${encodeURIComponent(n.nasname)}`))) route();
          } }, "Remove")) : null }], nas, "No routers yet — add your MikroTik first."))));
};

// Network control: health of every router (autosync.rsc → ml-stats, every minute)
const bps = (b) => { b = Number(b) || 0; const u = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"]; let i = 0; while (b >= 1000 && i < 3) { b /= 1000; i++; } return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`; };
const meter = (pct, warnAt = 70, badAt = 90) => {
  const bar = h("i", {}); bar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  return h("div", { class: "meter " + (pct >= badAt ? "bad" : pct >= warnAt ? "warn" : "ok") }, bar);
};
function routerHealth(net) {
  const cards = net.routers.map((r) => {
    const silent = r.age >= 300;
    const memPct = r.mem_total ? Math.round(100 - (r.mem_free * 100) / r.mem_total) : 0;
    const hddPct = r.hdd_total ? Math.round(100 - (r.hdd_free * 100) / r.hdd_total) : 0;
    const down = r.links.filter((l) => l.status === "down");
    const ifs = r.interfaces.filter((i) => !i.disabled).sort((a, b) => (b.rx_bps + b.tx_bps) - (a.rx_bps + a.tx_bps));
    const hist = r.history.map((x) => ({ label: x.t, down: Number(x.rx_bps) / 8, up: Number(x.tx_bps) / 8 }));
    return card(h("span", {}, r.identity, " ", silent ? badge(`silent ${Math.round(r.age / 60)} min`, "bad") : down.length ? badge("internet link down", "bad") : badge("online", "ok")),
      `${r.router_ip}${r.nas_name ? ` · ${r.nas_name}` : ""} · ${r.board} · RouterOS ${r.version}`,
      h("div", { class: "rh-grid" },
        h("div", { class: "rh-stat" }, h("span", {}, "CPU"), h("b", {}, `${r.cpu}%`), meter(r.cpu)),
        h("div", { class: "rh-stat" }, h("span", {}, "Memory"), h("b", {}, `${memPct}%`), meter(memPct)),
        h("div", { class: "rh-stat" }, h("span", {}, "Disk"), h("b", {}, `${hddPct}%`), meter(hddPct, 80, 95)),
        h("div", { class: "rh-stat" }, h("span", {}, "Uptime"), h("b", {}, r.uptime || "—")),
        h("div", { class: "rh-stat" }, h("span", {}, "Users online"), h("b", {}, String(Number(r.users_hotspot) + Number(r.users_ppp))),
          h("small", { class: "muted" }, `hotspot ${r.users_hotspot} · PPPoE ${r.users_ppp} · DHCP ${r.dhcp_leases}`))),
      r.links.length ? h("div", { class: "toolbar wrap" }, h("b", {}, "Internet links:"), r.links.map((l) =>
        badge(`${(l.comment || "").replace("ml-link: ", "") || l.host} · ${l.host} · ${l.status}`, l.status === "up" ? "ok" : l.status === "down" ? "bad" : ""))) :
        h("div", { class: "muted small" }, "No netwatch link check on this router (the auto-sync script adds two)."),
      hist.length > 1 ? h("div", {}, h("div", { class: "muted small" }, "Traffic on the busiest interface, last 24 h (per second)"), columnChart(hist)) : null,
      table([{ label: "Interface", render: (i) => h("b", {}, i.name) }, { label: "Type", key: "type" },
        { label: "State", render: (i) => i.running ? badge("up", "ok") : badge("down", "bad") },
        { label: "↓ now", num: true, render: (i) => bps(i.rx_bps) }, { label: "↑ now", num: true, render: (i) => bps(i.tx_bps) },
        { label: "↓ total", num: true, render: (i) => bytes(i.rx) }], ifs.slice(0, 12)),
      isAdmin() ? h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, `last report ${r.last_seen}`),
        h("button", { class: "small", onclick: async () => { if (await act(api("POST", "/api/network/forget", { router_ip: r.router_ip, identity: r.identity }))) route(); } }, "Forget")) : null);
  });
  const missing = net.nas_without_report.length ? h("div", { class: "note" }, `No health report from: ${net.nas_without_report.map((n) => `${n.name || n.ip} (${n.ip})`).join(", ")}. `,
    "Import the new auto-sync script on them (Blocking → Router auto-sync → Download script): it now also sends the router's health every minute.") : null;
  return h("div", { class: "stack" },
    card("Router health", `${net.routers.length} router(s) reporting`, h("div", { class: "muted" }, "CPU, memory, disk, uptime, interfaces, internet links and users online of every MikroTik, every minute. A router that goes silent or loses its internet link comes as an alert (Settings → Alerts → Router down / back)."), missing),
    net.routers.length ? h("div", { class: "grid g-2" }, cards) : null);
}

// ------------------------------------------------------------------ online
ROUTES.online = async () => {
  const holder = h("div");
  const load = async () => {
    const { sessions } = await api("GET", "/api/online");
    holder.replaceChildren(table([
      { label: "User", render: (s) => h("a", { href: `#/users/${encodeURIComponent(s.username)}` }, s.username) },
      { label: "IP", key: "framedipaddress" }, { label: "MAC", key: "callingstationid" }, { label: "Router", key: "nasipaddress" },
      { label: "Online for", render: (s) => duration(s.seconds) },
      { label: "Down", num: true, render: (s) => bytes(s.acctoutputoctets) }, { label: "Up", num: true, render: (s) => bytes(s.acctinputoctets) },
      { label: "", render: (s) => isAdmin() ? h("button", { class: "small", onclick: () => act(api("POST", `/api/users/${encodeURIComponent(s.username)}/kick`, {})).then(load) }, "Kick") : null }],
    sessions, "Nobody is online right now."));
  };
  await load();
  shell("Online now", card(null, "refreshes every 15 s", holder));
  every(15000, () => load().catch(() => {}));
};

// ------------------------------------------------------------------ live log
ROUTES.live = async () => {
  let cursor = "", paused = false;
  const seen = new Map();
  const feed = h("div", { class: "feed" });
  const userFilter = h("input", { type: "search", placeholder: "Only this user…" });
  const pause = h("button", { onclick: () => { paused = !paused; pause.textContent = paused ? "Resume" : "Pause"; } }, "Pause");
  const poll = async () => {
    if (paused) return;
    const r = await api("GET", `/api/live?cursor=${encodeURIComponent(cursor)}`);
    cursor = r.cursor;
    const f = userFilter.value.trim();
    for (const e of r.events) {
      const key = `${e.ip}|${e.site}|${e.type}`, t = Date.parse(e.time.replace(" ", "T"));
      if (e.type === "visit" && seen.has(key) && t - seen.get(key) < 30000) continue;
      seen.set(key, t);
      if (f && e.user !== f) continue;
      feed.prepend(h("div", { class: "feed-row" + (e.type === "blocked" ? " blocked" : "") },
        h("span", {}, e.time.slice(5)), h("span", {}, e.user), h("span", {}, e.ip),
        h("span", {}, e.type === "blocked" ? `BLOCKED ${e.site} → ${e.detail}` : e.site, " ", e.type === "visit" ? h("span", { class: "host" }, e.detail) : null)));
    }
    while (feed.childNodes.length > 500) feed.lastChild.remove();
    if (!feed.childNodes.length) feed.replaceChildren(h("div", { class: "empty" }, "Waiting for activity… (needs the DNS logger and router logging — see README)"));
    else feed.querySelector(".empty")?.remove();
  };
  shell("Live log", card(null, null, h("div", { class: "toolbar" }, userFilter, h("span", { class: "grow muted" }, "Sites opened and blocked attempts, newest first."), pause), feed));
  await poll();
  every(3000, () => poll().catch(() => {}));
};

// ------------------------------------------------------------------ reports
// ------------------------------------------------------------------ reports aur samajh (insights)
const changeBadge = (c) => c === null || c === undefined ? badge("new", "info") : badge(`${c > 0 ? "▲" : c < 0 ? "▼" : ""} ${Math.abs(c)}%`, c > 20 ? "warn" : c < -20 ? "info" : "");
ROUTES.insights = async () => {
  shell("Insights", h("div", { class: "empty" }, "Working it out …"));
  const r = await api("GET", "/api/insights");
  const daily = r.daily.map((d) => ({ label: d.day.slice(5), down: d.bytes, up: 0 }));
  const hours = r.hours.map((b, i) => ({ label: String(i).padStart(2, "0"), down: b, up: 0 }));
  const sales = r.sales?.now;
  shell("Insights", h("div", { class: "stack" },
    h("div", { class: "grid g-tiles" },
      tile("Data this week", bytes(r.total_now), r.total_before ? h("span", {}, "last week ", bytes(r.total_before), " ", changeBadge(r.change)) : "first week"),
      tile("Users / devices", String(r.users_now), r.users_before ? `last week ${r.users_before}` : null),
      tile("Unusual use", String(r.anomalies.length), r.anomalies.length ? "users far above their normal day" : "nothing unusual"),
      sales ? tile("Sales this week", `${sales.count}`, `${Math.round(sales.amount).toLocaleString()}`) : null),
    card("Is hafte ki samajh", `${r.week_start} – ${r.today}`, h("ul", { class: "insight-words" }, r.words.map((w) => h("li", { class: w.startsWith("⚠") ? "warn" : "" }, w)))),
    h("div", { class: "grid g-2" },
      card("Data per day", "last 30 days", columnChart(daily)),
      card("Busy hours", "this week, average per day", columnChart(hours))),
    r.anomalies.length ? card("Unusual data use", "10x or more of the user's normal day — virus, a shared password, or a big download?",
      table([{ label: "User", render: (a) => h("a", { href: `#/users/${encodeURIComponent(a.user)}` }, a.user) }, { label: "Day", key: "day" },
        { label: "Used", num: true, render: (a) => bytes(a.bytes) }, { label: "Normal day", num: true, render: (a) => bytes(a.normal) },
        { label: "", render: (a) => badge(`${a.times}x`, "bad") }], r.anomalies)) : null,
    h("div", { class: "grid g-2" },
      card("Top users", "this week vs last week", table([{ label: "User", render: (u) => h("a", { href: `#/users/${encodeURIComponent(u.user)}` }, u.user) },
        { label: "This week", num: true, render: (u) => bytes(u.now) }, { label: "Last week", num: true, render: (u) => u.before ? bytes(u.before) : "—" },
        { label: "Change", render: (u) => changeBadge(u.change) }], r.top_users, "No data yet.")),
      card("Top apps / sites", "this week vs last week", table([{ label: "Site", key: "site" },
        { label: "This week", num: true, render: (x) => bytes(x.now) }, { label: "Last week", num: true, render: (x) => x.before ? bytes(x.before) : "—" },
        { label: "Change", render: (x) => changeBadge(x.change) }], r.top_sites, "No data yet."))),
    h("div", { class: "muted" }, "Every Monday this report also comes to your phone / email (Settings → Alerts → Weekly report). Server: sudo radius-admin insights")));
};

ROUTES.reports = async (tab = "sites") => {
  const tabs = [["sites", "Visited sites"], ["history", "History"], ["blocked", "Blocked"], ["logins", "Login log"]];
  const user = h("input", { type: "search", placeholder: "User" }), ip = h("input", { type: "search", placeholder: "IP" });
  const days = h("select", {}, [["1", "Today (24 h)"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const holder = h("div");
  const load = async () => {
    const qs = new URLSearchParams({ user: user.value.trim(), ip: ip.value.trim(), days: days.value });
    holder.replaceChildren(h("div", { class: "empty" }, "Loading…"));
    if (tab === "sites") {
      const { rows } = await api("GET", `/api/sites?${qs}&top=100`);
      holder.replaceChildren(table([{ label: "Site", key: "site" }, { label: "Visits", key: "visits", num: true },
        { label: "Users", key: "users", num: true }, { label: "Last visit", key: "last" }, { label: "Who", key: "who", wrap: true }], rows, "No visits found (is the DNS logger on?)."));
    } else if (tab === "history") {
      const { rows } = await api("GET", `/api/history?${qs}&n=500`);
      holder.replaceChildren(table([{ label: "Time", key: "time" }, { label: "User", key: "user" }, { label: "IP", key: "ip" },
        { label: "Site", key: "site" }, { label: "Hostname", key: "hostname", wrap: true }], rows, "No history found."));
    } else if (tab === "blocked") {
      const { rows } = await api("GET", `/api/blocked?${qs}&n=500`);
      holder.replaceChildren(table([{ label: "Time", key: "time" }, { label: "User", key: "user" }, { label: "IP", key: "ip" },
        { label: "Policy", render: (r) => badge(r.policy, "info") }, { label: "Blocked by", render: (r) => badge(r.reason, "bad") },
        { label: "Site", render: (r) => r.site || "—", wrap: true }, { label: "Destination", key: "destination" }], rows, "No blocked attempts found."));
    } else {
      const { log } = await api("GET", `/api/auth-log?n=300&user=${encodeURIComponent(user.value.trim())}`);
      holder.replaceChildren(table([{ label: "When", render: (l) => String(l.authdate).slice(0, 19) }, { label: "User", key: "username" },
        { label: "Result", render: (l) => l.reply === "Access-Accept" ? badge("accepted", "ok") : badge("rejected", "bad") }], log, "No logins yet."));
    }
  };
  shell("Reports", h("div", {},
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/reports/${k}`, class: k === tab ? "active" : "" }, l))),
    card(null, null, h("div", { class: "toolbar" }, user, tab !== "logins" ? [ip, days] : null, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show")), holder)));
  await load();
};

// ------------------------------------------------------------------ data usage
ROUTES.data = async (by = "site") => {
  const tabs = [["site", "Per website"], ["ip", "Per IP"], ["user", "Per user"], ["usersites", "User → top sites"], ["day", "Per day"], ["now", "Live now"]];
  const holder = h("div", { class: "stack" });
  const user = h("input", { type: "search", placeholder: "User" }), ip = h("input", { type: "search", placeholder: "IP" }), site = h("input", { type: "search", placeholder: "Site e.g. youtube.com" });
  const days = h("select", {}, [["1", "Today (24 h)"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: by === "day" && v === "30" }, l)));
  const load = async () => {
    if (by === "now") {
      const r = await api("GET", "/api/traffic-now");
      if (!r.available) return holder.replaceChildren(h("div", { class: "empty" }, "No live data — turn the traffic collector on (radius-admin traffic collector on)."));
      const secs = Math.max(r.interval || 60, 1);
      holder.replaceChildren(h("div", { class: "muted" }, `Last ${Math.round(secs)} s · updated ${r.age} s ago`), table([
        { label: "IP", key: "ip" }, { label: "User", render: (x) => x.user || "—" }, { label: "Site", key: "site" },
        { label: "Download", num: true, render: (x) => bytes(x.down) }, { label: "Upload", num: true, render: (x) => bytes(x.up) },
        { label: "Speed", num: true, render: (x) => `${((x.down + x.up) * 8 / secs / 1e6).toFixed(2)} Mbps` }], r.rows, "No traffic in the last minute."));
      return;
    }
    if (by === "usersites") return userSites(holder, days.value);
    const qs = new URLSearchParams({ by, days: days.value, user: user.value.trim(), ip: ip.value.trim(), site: site.value.trim(), top: 100 });
    const { rows } = await api("GET", `/api/traffic?${qs}`);
    const label = { site: "Website", ip: "IP", user: "User", day: "Day" }[by];
    const total = rows.reduce((a, r) => a + Number(r.down) + Number(r.up), 0);
    holder.replaceChildren(
      h("div", { class: "grid g-3" },
        by === "day" ? card(null, null, columnChart([...rows].reverse().map((r) => ({ label: String(r.k).slice(5), down: Number(r.down), up: Number(r.up) }))), legend())
          : card(null, null, hbars(rows.slice(0, 12).map((r) => ({ ...r, k: String(r.k) })), "k")),
        h("div", { class: "grid" }, tile("Total", bytes(total)), tile("Download", bytes(rows.reduce((a, r) => a + Number(r.down), 0))), tile("Upload", bytes(rows.reduce((a, r) => a + Number(r.up), 0))))),
      h("div", { class: "card" }, table([
        { label, render: (r) => by === "user" && r.k !== "(no login)" ? h("a", { href: `#/users/${encodeURIComponent(r.k)}` }, r.k)
            : by === "site" && /^\d+\.\d+\.\d+\.\d+$/.test(r.k) ? h("a", { href: `#/cdn/${r.k}`, title: "Who is this? (CDN detective)" }, r.k, " 🔍")
            : String(r.k).slice(0, by === "day" ? 10 : 80) },
        { label: "Download", num: true, render: (r) => bytes(r.down) }, { label: "Upload", num: true, render: (r) => bytes(r.up) },
        { label: "Total", num: true, render: (r) => bytes(Number(r.down) + Number(r.up)) },
        by === "site" || by === "day" ? { label: "Devices", key: "devices", num: true } : { label: "Sites", key: "sites", num: true },
        by === "site" || by === "ip" ? { label: "Users", key: "users", wrap: true } : null].filter(Boolean), rows, "No data yet (traffic collector + router traffic-flow).")));
  };
  shell("Data usage", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/data/${k}`, class: k === by ? "active" : "" }, l))),
    by !== "now" ? card(null, null, h("div", { class: "toolbar" }, days, by === "usersites" ? null : [user, ip, site], h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))) : null,
    holder));
  await load();
  if (by === "now") every(10000, () => load().catch(() => {}));
};

// ------------------------------------------------------------------ settings
// ------------------------------------------------------------------ health check
ROUTES.health = async (fresh) => {
  let r = null;
  if (fresh !== "now") r = await api("GET", "/api/health?saved=1").catch(() => null);
  if (!r || !r.checks) {
    shell("Health check", h("div", { class: "empty" }, "Checking every part of the server … (about half a minute)"));
    r = await api("GET", "/api/health");
  }
  const n = { ok: 0, warn: 0, fail: 0 };
  r.checks.forEach((c) => n[c.status]++);
  const mark = { ok: "✔", warn: "!", fail: "✘" };
  const groups = [...new Set(r.checks.map((c) => c.group))];
  const todo = r.checks.filter((c) => c.status !== "ok").sort((x, y) => (x.status === "fail" ? 0 : 1) - (y.status === "fail" ? 0 : 1));
  const since = Math.max(0, Math.round((Date.now() - new Date(r.checked.replace(" ", "T")).getTime()) / 60000));
  const when = r.saved ? `automatic check ${since < 2 ? "just now" : since < 120 ? since + " min ago" : Math.round(since / 60) + " h ago"} · runs every hour by itself` : `checked just now`;
  const copyText = () => [`MikrotikLover health — ${r.host} — ${r.checked}`, `${n.ok} ok, ${n.warn} to look at, ${n.fail} problems`, "",
    ...todo.map((c) => `${c.status === "fail" ? "PROBLEM" : "LOOK"}: ${c.name} — ${c.detail}${c.fix ? `\n   fix: ${c.fix}` : ""}`),
    ...(todo.length ? [""] : []), ...r.checks.filter((c) => c.status === "ok").map((c) => `ok: ${c.name} — ${c.detail}`)].join("\n");
  const hero = h("div", { class: `card health-hero ${r.status}` },
    h("div", { class: "hh-mark" }, { ok: "✔", warn: "!", fail: "✘" }[r.status]),
    h("div", { class: "grow" },
      h("div", { class: "hh-title" }, r.status === "ok" ? "Everything is working" : r.status === "warn" ? `${n.warn} thing${n.warn > 1 ? "s" : ""} to look at when you can` : `${n.fail} problem${n.fail > 1 ? "s" : ""} — fix now`),
      h("div", { class: "muted" }, `${n.ok} of ${r.checks.length} checks fine · ${when} · ${r.host}`),
      h("div", { class: "muted small" }, "You get a Telegram / WhatsApp / email message by yourself when something breaks and when it is fine again (Settings → Alerts → Health check).")),
    h("div", { class: "toolbar" },
      h("button", { class: "primary", onclick: () => { location.hash === "#/health/now" ? route() : (location.hash = "#/health/now"); } }, icon("refresh"), "Check now"),
      h("button", { onclick: async () => { try { await navigator.clipboard.writeText(copyText()); toast("Report copied — paste it in WhatsApp / email"); } catch (e) { dialog("Health report", h("pre", { class: "code-box" }, copyText()), [{ label: "Close" }]); } } }, "Copy report")));
  const row = (c) => h("div", { class: `health-row ${c.status}` }, h("span", { class: "health-mark", "aria-label": c.status }, mark[c.status]),
    h("div", { class: "grow" }, h("b", {}, c.name), h("span", { class: "muted small" }, ` · ${c.group}`), h("div", { class: "muted" }, c.detail),
      c.fix ? h("div", { class: "health-fix" }, "How to fix: ", h("code", {}, c.fix)) : null));
  const body = groups.map((g) => card(g, `${r.checks.filter((c) => c.group === g && c.status === "ok").length}/${r.checks.filter((c) => c.group === g).length} fine`,
    h("div", { class: "health-list" }, r.checks.filter((c) => c.group === g).map(row))));
  shell("Health check", h("div", { class: "stack" }, hero,
    todo.length ? card("Your to-do", `${todo.length}`, h("div", { class: "health-list" }, todo.map(row))) : null,
    h("details", { class: "card", open: !todo.length }, h("summary", {}, `All ${r.checks.length} checks`), h("div", { class: "grid g-2" }, body)),
    h("div", { class: "muted small" }, "Green = working · yellow = look when you can · red = fix now. On the server: sudo radius-admin doctor")));
};

ROUTES.settings = async () => {
  const sys = await api("GET", "/api/system");
  const parts = [
    card("System", `uptime ${duration(sys.uptime)} · load ${sys.load.map((x) => x.toFixed(2)).join(" ")}`,
      table([{ label: "Service", key: "name" }, { label: "State", render: (s) => s.running ? badge("running", "ok") : badge("stopped", "warn") }], sys.services),
      h("dl", { class: "kv" }, h("dt", {}, "Disk free"), h("dd", {}, `${bytes(sys.disk.free)} of ${bytes(sys.disk.total)}`),
        h("dt", {}, "Database"), h("dd", {}, bytes(sys.db_bytes)),
        h("dt", {}, "DNS log"), h("dd", {}, sys.logs["dns.log"] == null ? "—" : bytes(sys.logs["dns.log"])),
        h("dt", {}, "Web-filter log"), h("dd", {}, sys.logs["webfilter.log"] == null ? "—" : bytes(sys.logs["webfilter.log"])))),
  ];
  const pw = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(pw);
    if (v.new !== v.repeat) return toast("New passwords do not match", true);
    if (await act(api("POST", "/api/me/password", { old: v.old, new: v.new }))) pw.reset();
  } },
    h("label", { class: "field" }, "Current password", h("input", { name: "old", type: "password", autocomplete: "current-password", required: true })),
    h("label", { class: "field" }, "New password", h("input", { name: "new", type: "password", autocomplete: "new-password", minlength: 10, required: true })),
    h("label", { class: "field" }, "Repeat new password", h("input", { name: "repeat", type: "password", autocomplete: "new-password", minlength: 10, required: true })),
    h("div", {}, h("button", { class: "primary", type: "submit" }, "Change my password")));
  parts.push(card("My password", me.user, pw));
  const bs = await api("GET", "/api/settings");
  const bf = h("form", { class: "form cols", onsubmit: async (e) => { e.preventDefault(); await act(api("POST", "/api/settings", formValues(bf))); } },
    [["brand", "Business name (cards, connect page)"], ["currency", "Currency"], ["hotspot_ssid", "Hotspot Wi-Fi name"], ["hotspot_url", "Hotspot login address"],
     ["ssid", "Staff Wi-Fi name (WPA-Enterprise)"], ["contact", "Contact / WhatsApp number"]].map(([k, l]) =>
      h("label", { class: "field" }, l, h("input", { name: k, value: bs[k] || "", disabled: !isAdmin() }))),
    h("label", { class: "field full" }, "Text at the bottom of voucher cards", h("input", { name: "card_footer", value: bs.card_footer || "", disabled: !isAdmin() })),
    h("div", { class: "full muted" }, "Users' connect guide: ", h("a", { href: "/connect", target: "_blank", rel: "noopener" }, `${location.origin}/connect`), ` · RADIUS domain: ${bs.radius_domain || "—"}`),
    isAdmin() ? h("div", {}, h("button", { class: "primary", type: "submit" }, "Save")) : null);
  parts.push(card("Business & branding", null, bf));
  const wide = [];
  if (isAdmin()) {
    const bk = await api("GET", "/api/backups");
    wide.push(card("Backups", `${bk.backups.length} in ${bk.dir}`,
      h("div", { class: "muted" }, "A backup has everything: users, plans, vouchers, sales, reports, routers, certificates, FreeRADIUS, policies, learned lists and dashboard accounts. One is made every night (newest 14 kept). Download them and keep a copy OFF this server. Restore on the server: sudo radius-admin restore FILE"),
      table([{ label: "Backup", render: (b) => h("span", {}, b.name, b.encrypted ? " 🔒" : "") }, { label: "Kind", render: (b) => badge(b.auto ? "nightly" : "manual", b.auto ? "info" : "ok") },
        { label: "Size", num: true, render: (b) => bytes(b.size) }, { label: "Made", key: "time" },
        { label: "", render: (b) => h("a", { class: "btn small", href: `/api/backups/${encodeURIComponent(b.name)}` }, "⬇ Download") }], bk.backups, "No backup yet."),
      h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: async (e) => { e.target.disabled = true; await act(api("POST", "/api/backups")); route(); } }, "Backup now"))));
    wide.push(offsiteCard(bk.offsite || { type: "off" }));
    wide.push(await alertsCard());
    wide.push(await noticeCard());
    wide.push(card("Automatic updates", "every week (Tuesday night) + hourly lists",
      h("div", { class: "muted" }, "App catalog, IP owner lists, names of newly found apps, threat lists (virus / attacks), VPN lists and the router rules update themselves. Hourly: app inventory, website names, VPN watch, security scan, learned app domains."),
      table([{ label: "Job", key: "name" }, { label: "Last run", key: "when" },
        { label: "Result", render: (u) => badge(u.result.slice(0, 80), u.result.startsWith("ok") ? "ok" : "bad"), wrap: true }], bk.updates, "Not run yet."),
      h("div", { class: "toolbar" }, h("button", { onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Updating … (a few minutes)"; await act(api("POST", "/api/updates")); route(); } }, "Run all updates now"))));
    const [{ admins }, { audit }] = await Promise.all([api("GET", "/api/admins"), api("GET", "/api/audit")]);
    const addAdmin = (a) => {
      const f = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
        h("label", { class: "field" }, "Username", h("input", { name: "username", required: true, value: a?.username || "", readonly: !!a, pattern: "[A-Za-z0-9._@+\\-]{1,64}" })),
        h("label", { class: "field" }, "Role", h("select", { name: "role" }, h("option", { value: "admin", selected: a?.role === "admin" }, "admin — full control"), h("option", { value: "viewer", selected: a?.role === "viewer" }, "viewer — read only"))),
        h("label", { class: "field" }, a ? "New password (empty = keep)" : "Password", h("input", { name: "password", type: "password", autocomplete: "new-password", minlength: 10, required: !a })));
      dialog(a ? `Dashboard account ${a.username}` : "Add dashboard account", f, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
        if (!f.reportValidity()) return false;
        if (!(await act(api("POST", "/api/admins", formValues(f))))) return false;
        route();
      } }]);
    };
    parts.push(card("Dashboard accounts", null, h("div", { class: "toolbar" }, h("span", { class: "grow" }), h("button", { class: "primary", onclick: () => addAdmin(null) }, icon("plus"), "Add account")),
      table([{ label: "Username", key: "username" }, { label: "Role", render: (a) => badge(a.role, a.role === "admin" ? "info" : "") },
        { label: "Last login", render: (a) => ago(a.last_login) },
        { label: "", render: (a) => h("div", { class: "row-actions" }, h("button", { class: "small", onclick: () => addAdmin(a) }, "Edit"),
            a.username !== me.user ? h("button", { class: "small danger", onclick: async () => {
              if (await confirmDlg("Delete account", `Delete dashboard account ${a.username}?`, "Delete"))
                if (await act(api("DELETE", `/api/admins/${encodeURIComponent(a.username)}`))) route();
            } }, "Delete") : null) }], admins)));
    parts.push(card("Audit log", "every change made from this dashboard", table([
      { label: "When", render: (a) => String(a.at).slice(0, 19) }, { label: "Admin", key: "admin" }, { label: "IP", key: "ip" },
      { label: "Action", key: "action", wrap: true }, { label: "Result", render: (a) => a.result === "ok" ? badge("ok", "ok") : badge(a.result, "bad") }], audit)));
  }
  shell("Settings", h("div", { class: "stack" }, h("div", { class: "grid g-2" }, parts), wide));
};

// "Pehle se khabardari": warn users before the package or the data runs out
const noticeCard = async () => {
  const n = await api("GET", "/api/notice");
  const st = n.settings;
  const f = h("form", { class: "form cols", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(f);
    if (await act(api("POST", "/api/notice", v))) route();
  } },
    h("label", { class: "field" }, "Warn days before expiry (0 = off)", h("input", { name: "notice_days", type: "number", min: 0, max: 99, value: st.notice_days })),
    h("label", { class: "field" }, "Warn when this % of data is used (0 = off)", h("input", { name: "notice_quota_pct", type: "number", min: 0, max: 99, value: st.notice_quota_pct })),
    h("label", { class: "field full" }, "Expiry message", h("input", { name: "notice_expiry", maxlength: 200, value: st.notice_expiry })),
    h("label", { class: "field full" }, "Data message", h("input", { name: "notice_quota", maxlength: 200, value: st.notice_quota })),
    h("div", { class: "full muted small" }, "Words in { } are filled in: {user} {date} {left} {used} {quota} {contact} {brand}. Hotspot users see it on the status page after login (mikrotik/hotspot-login/status.html); everyone gets it in the login reply."),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "notice_sms", checked: st.notice_sms === "1" }), "Also send an SMS to users with a phone number (once per expiry / data period)"),
    h("label", { class: "field" }, "Send SMS only between (hours)", h("input", { name: "notice_hours", value: st.notice_hours, pattern: "[0-9]{1,2}-[0-9]{1,2}", placeholder: "9-21" })),
    isAdmin() ? h("div", { class: "full" }, h("button", { class: "primary", type: "submit" }, "Save")) : null);
  const gw = h("form", { class: "form cols", onsubmit: async (e) => {
    e.preventDefault();
    if (await act(api("POST", "/api/notice/gateway", formValues(gw)))) route();
  } },
    h("label", { class: "field full" }, n.gateway.set ? `SMS gateway URL (saved, ${n.gateway.method}) — enter again to change` : "SMS gateway URL",
      h("input", { name: "url", placeholder: "https://sms.provider.pk/api?key=KEY&to={phone0}&msg={text}", required: true })),
    h("label", { class: "field" }, "POST body (empty = GET)", h("input", { name: "body", placeholder: '{"number":"{phone}","message":"{text}"}' })),
    h("label", { class: "field" }, "Success word in the answer (optional)", h("input", { name: "ok", placeholder: "OK" })),
    h("div", { class: "full muted small" }, "Any SMS or WhatsApp gateway with an HTTP API (Pakistani SMS companies, UltraMsg, Green-API …). {phone} = +923001234567, {phone0} = 03001234567, {text} = the message."),
    isAdmin() ? h("div", { class: "full toolbar" }, h("button", { type: "submit" }, "Save gateway"),
      (() => { const t = h("input", { placeholder: "03001234567", size: 13, inputmode: "tel" });
        return h("span", { class: "toolbar" }, t, h("button", { type: "button", disabled: !n.gateway.set, onclick: () => act(api("POST", "/api/notice/test", { phone: t.value.trim() })) }, "Send test SMS")); })()) : null);
  return card("Warn users before it runs out", `${n.users.length} user(s) warned now · ${n.phones} with a phone`,
    h("div", { class: "muted" }, "\"Pehle se khabardari\": users see a warning a few days before their package ends or when most of their data is used, so they renew in time."),
    f,
    h("details", {}, h("summary", {}, "SMS gateway"), gw),
    h("details", {}, h("summary", {}, `Users with a warning now (${n.users.length})`),
      table([{ label: "User", render: (u) => h("a", { href: `#/users/${encodeURIComponent(u.username)}` }, u.username) }, { label: "Phone", key: "phone" },
        { label: "Warning", key: "text", wrap: true }], n.users, "Nobody right now.")),
    h("details", {}, h("summary", {}, `SMS sent (${n.log.length})`),
      table([{ label: "When", render: (x) => String(x.at).slice(0, 16) }, { label: "User", key: "username" }, { label: "Phone", key: "phone" },
        { label: "Kind", render: (x) => badge(x.kind, "warn") }, { label: "Message", key: "text", wrap: true },
        { label: "Result", render: (x) => badge(x.result.slice(0, 60), /^sms: ok/.test(x.result) ? "ok" : "bad"), wrap: true }], n.log, "No SMS sent yet.")));
};

// Alerts: Telegram / WhatsApp / email when something needs attention, plus a daily summary
const ALERT_EVENTS = [
  ["security", "Virus, hacker attack, DDoS", "only HIGH danger"], ["quarantine", "Device quarantined", "automatic or by an admin"],
  ["router", "Router down / back", "router stops answering (2 checks)"], ["service", "Server service stopped", "FreeRADIUS, database, DNS logger, traffic"],
  ["jobs", "Backup / update failed", "nightly backup, off-site copy, updates"], ["disk", "Disk almost full", "under 10% free"],
  ["expiring", "Users expiring", "subscription ends within 24 hours"], ["anomaly", "Unusual data use", "a user uses 10x a normal day"], ["requests", "Unblock requests", "a user asks to open a blocked site (block page)"], ["newapp", "New apps", "an app never seen before is used (with Android / iPhone devices)"], ["health", "Health check", "the hourly self-check finds a problem, and when it is fine again"], ["devices", "Devices (SNMP)", "UPS on battery, a device stops answering, printer jam / toner, watched port down"],
  ["summary", "Daily summary", "users, data, sales, security"], ["weekly", "Weekly report", "Monday: top users & apps, this week vs last"],
  ["monthly", "Monthly security report", "1st of the month: PDF by email / Telegram"]];
const alertsCard = async () => {
  const { status: st = {}, log = [] } = await api("GET", "/api/alerts");
  const s = st.settings || {}, on = st.channels || [], evs = st.events || [];
  const inp = (name, label, attrs = {}) => h("label", { class: "field" }, label, h("input", { name, value: s[name] || "", ...attrs }));
  const secret = (name, label) => inp(name, label, { type: "password", autocomplete: "off", placeholder: s[name] ? "saved — empty = keep" : "", value: "" });
  const test = (ch) => h("button", { type: "button", class: "small", disabled: !on.includes(ch), onclick: async (e) => {
    e.target.disabled = true; await act(api("POST", "/api/alerts/test", { channel: ch })); route(); } }, "Send test");
  const off = (ch) => on.includes(ch) ? h("button", { type: "button", class: "small danger", onclick: async () => {
    if (await act(api("POST", "/api/alerts", { [`off_${ch}`]: true }))) route(); } }, "Turn off") : null;
  const head = (ch, title) => h("div", { class: "toolbar" }, h("b", { class: "grow" }, title), badge(on.includes(ch) ? "on" : "off", on.includes(ch) ? "ok" : ""), test(ch), off(ch));
  const chatSel = h("div", { class: "muted small" });
  const f = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(f);
    v.events = ALERT_EVENTS.map(([k]) => k).filter((k) => v[`ev_${k}`]);
    if (await act(api("POST", "/api/alerts", v))) route();
  } },
    h("div", { class: "grid g-2 alert-channels" },
      h("div", { class: "sub-card" }, head("telegram", "Telegram"),
        h("div", { class: "muted small" }, "In Telegram open @BotFather → /newbot → copy the token. Then open your new bot and press Start, and click Find my chat."),
        secret("TELEGRAM_TOKEN", "Bot token"),
        h("label", { class: "field" }, "Chat id", h("div", { class: "toolbar" }, h("input", { name: "TELEGRAM_CHAT", value: s.TELEGRAM_CHAT || "", class: "grow" }),
          h("button", { type: "button", class: "small", onclick: async () => {
            const tok = f.querySelector("[name=TELEGRAM_TOKEN]").value.trim();
            let r = null;
            try { r = await api("POST", "/api/alerts/telegram-chats", { token: tok }); } catch (err) { return toast(err.message, true); }
            chatSel.replaceChildren();
            if (!r.chats.length) return toast(r.message || "No chat yet — press Start in your bot, then try again", true);
            r.chats.forEach((c) => chatSel.append(h("button", { type: "button", class: "small", onclick: () => { f.querySelector("[name=TELEGRAM_CHAT]").value = c.id; } }, `${c.name || "chat"} (${c.id})`)));
            if (r.chats.length === 1) { f.querySelector("[name=TELEGRAM_CHAT]").value = r.chats[0].id; toast(`Chat found: ${r.chats[0].name} — press Save`); }
          } }, "Find my chat"))), chatSel),
      h("div", { class: "sub-card" }, head("whatsapp", "WhatsApp (CallMeBot)"),
        h("div", { class: "muted small" }, "Free: save +34 644 66 32 62 in your phone, send it on WhatsApp \"I allow callmebot to send me messages\" — the reply has your API key."),
        inp("WHATSAPP_PHONE", "Your WhatsApp number", { placeholder: "+923001234567" }), secret("WHATSAPP_APIKEY", "API key")),
      h("div", { class: "sub-card full" }, head("email", "Email (SMTP)"),
        h("div", { class: "muted small" }, "Gmail: smtp.gmail.com, port 587, STARTTLS, your address, and an App password (Google account → Security → App passwords)."),
        h("div", { class: "form cols" }, inp("EMAIL_TO", "Send to (comma = more)", { placeholder: "owner@example.com" }), inp("SMTP_HOST", "SMTP server", { placeholder: "smtp.gmail.com" }),
          inp("SMTP_PORT", "Port", { type: "number", min: 1, max: 65535, placeholder: "587" }),
          h("label", { class: "field" }, "Security", h("select", { name: "SMTP_TLS" }, ["starttls", "ssl", "none"].map((t) => h("option", { value: t, selected: (s.SMTP_TLS || "starttls") === t }, t.toUpperCase())))),
          inp("SMTP_USER", "Login (user)"), secret("SMTP_PASS", "Password / app password"), inp("EMAIL_FROM", "From (empty = login)")))),
    h("div", {}, h("b", {}, "Send an alert for"),
      h("div", { class: "checks alert-events" }, ALERT_EVENTS.map(([k, t, d]) => {
        const cb = h("input", { type: "checkbox", name: `ev_${k}`, checked: evs.includes(k), onchange: (e) => e.target.closest(".check").classList.toggle("on", e.target.checked) });
        return h("label", { class: "check" + (evs.includes(k) ? " on" : "") }, cb, h("div", {}, h("b", {}, t), h("span", {}, d)));
      })),
      h("label", { class: "field inline" }, "Daily summary at", h("select", { name: "SUMMARY_HOUR" },
        Array.from({ length: 24 }, (_, i) => h("option", { value: i, selected: (st.summary_hour ?? 21) === i }, `${String(i).padStart(2, "0")}:00`))))),
    h("div", { class: "toolbar" }, h("button", { class: "primary", type: "submit" }, "Save"),
      h("button", { type: "button", disabled: !on.length, onclick: async (e) => { e.target.disabled = true; await act(api("POST", "/api/alerts/test", {})); route(); } }, "Send test to all"),
      h("button", { type: "button", disabled: !on.length, onclick: async (e) => { e.target.disabled = true; await act(api("POST", "/api/alerts/summary")); route(); } }, "Send summary now"),
      h("span", { class: "muted" }, st.last_check ? `Checked every 5 minutes · last ${st.last_check}` : "Checked every 5 minutes")));
  return card("Alerts", on.length ? `on: ${on.map((c) => ({ telegram: "Telegram", whatsapp: "WhatsApp", email: "Email" })[c]).join(", ")}` : "off — set up a channel",
    h("div", { class: "muted" }, "Get a message on your phone when a router goes down, a virus or attack is found, a device is quarantined, a backup fails … Many problems at once come as one message. Nothing is sent twice."),
    f,
    h("details", {}, h("summary", {}, `Sent alerts (${log.length})`),
      table([{ label: "When", render: (a) => String(a.at).slice(0, 16) }, { label: "Kind", render: (a) => badge(a.kind, a.kind === "test" ? "" : a.kind === "summary" ? "info" : "warn") },
        { label: "Alert", render: (a) => h("span", { title: a.text }, a.title), wrap: true },
        { label: "Result", render: (a) => badge(a.result.slice(0, 80), /^((telegram|whatsapp|email): ok(, )?)+$/.test(a.result) ? "ok" : "bad"), wrap: true }], log, "No alert sent yet.")));
};

// Off-site copy of the nightly backup: a backup server over SSH, or Google Drive / Dropbox / S3 ... via rclone
const offsiteCard = (o) => {
  const on = o.type && o.type !== "off";
  const last = o.last || "";
  const f = h("form", { class: "form cols", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(f);
    let r = null;
    try { r = await api("POST", "/api/backups/offsite", v); } catch (err) { if (err.message !== "login required") toast(err.message, true); }
    if (r) { if (r.message) dialog("Off-site backup", h("pre", { class: "code-box" }, r.message), [{ label: "OK", class: "primary", action: () => route() }]); }
  } },
    h("label", { class: "field" }, "Where", h("select", { name: "type", onchange: (e) => { f.querySelector(".port").hidden = e.target.value !== "ssh"; f.querySelector(".hint").textContent = hints[e.target.value]; } },
      h("option", { value: "ssh", selected: o.type !== "rclone" }, "Another server (SSH)"),
      h("option", { value: "rclone", selected: o.type === "rclone" }, "Cloud: Google Drive, Dropbox, S3 … (rclone)"))),
    h("label", { class: "field" }, "Target", h("input", { name: "target", required: true, value: o.target || "", placeholder: "backup@192.168.1.20:/srv/backups  or  gdrive:mikrotiklover" })),
    h("label", { class: "field port", hidden: o.type === "rclone" }, "SSH port", h("input", { name: "port", type: "number", min: 1, max: 65535, value: o.port || 22 })),
    h("label", { class: "field" }, "Copies to keep there", h("input", { name: "keep", type: "number", min: 1, max: 1000, value: o.keep || 30 })),
    h("div", { class: "full muted hint" }, ""),
    h("div", { class: "full toolbar" }, h("button", { class: "primary", type: "submit" }, on ? "Save" : "Turn on"),
      on ? h("button", { type: "button", onclick: async (e) => { e.target.disabled = true; await act(api("POST", "/api/backups/offsite/test")); e.target.disabled = false; } }, "Test connection") : null,
      on ? h("button", { type: "button", onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Sending …"; await act(api("POST", "/api/backups/offsite/send")); route(); } }, "Send newest backup now") : null,
      on ? h("button", { type: "button", onclick: async () => { const r = await act(api("POST", "/api/backups/offsite/password")); if (r) dialog("Off-site backup password", h("div", {}, h("p", {}, "Needed to restore a copy from there. Write it down and keep it safe:"), h("pre", { class: "code-box" }, r.password)), [{ label: "OK", class: "primary" }]); } }, "Show password") : null,
      on ? h("button", { type: "button", class: "danger", onclick: async () => { if (await confirmDlg("Off-site backup", "Stop sending copies? The copies already there are kept.", "Turn off")) if (await act(api("POST", "/api/backups/offsite", { type: "off" }))) route(); } }, "Turn off") : null));
  const hints = {
    ssh: "Any Linux PC/server (or NAS with SSH). Save, then add the key shown above to ~/.ssh/authorized_keys of that user there (once), then Test connection.",
    rclone: "Make the cloud remote once on this server: sudo rclone config (e.g. name it gdrive), then enter gdrive:folder here.",
  };
  f.querySelector(".hint").textContent = hints[o.type === "rclone" ? "rclone" : "ssh"];
  return card("Off-site copy", on ? `${o.type === "ssh" ? "SSH" : "rclone"} → ${o.target}` : "off — backups only on this server",
    h("div", { class: "muted" }, "Every nightly backup is also copied to another place, encrypted with a password, so a dead disk or a stolen server never loses your data. Restore from there: sudo radius-admin backup offsite fetch, then radius-admin restore FILE."),
    on ? h("div", { class: "toolbar" }, "Last copy: ", last ? badge(last.slice(0, 120), /\bok:/.test(last) ? "ok" : "bad") : badge("not sent yet", "")) : null,
    on && o.public_key ? h("label", { class: "field" }, "This server's key (put it in ~/.ssh/authorized_keys on the backup server)",
      h("textarea", { readonly: true, rows: 2, class: "mono", onclick: (e) => e.target.select() }, o.public_key)) : null,
    f);
};

// ------------------------------------------------------------------ start
(async () => {
  try { me = await api("GET", "/api/me"); } catch { me = null; }
  if (!me) renderLogin(); else route();
})();

// ------------------------------------------------------------------ hotspot business
async function subscriptionCard(name, acc) {
  const enc = encodeURIComponent(name);
  const { plans, currency } = await api("GET", "/api/plans");
  const planSel = h("select", {}, h("option", { value: "" }, "— no plan —"), plans.map((p) => h("option", { value: p.name, selected: acc && p.name === acc.plan }, `${p.name} (${money(p.price, currency)})`)));
  const free = h("input", { type: "checkbox" });
  const items = [];
  if (acc) {
    const check = acc.radius_check || "";
    const state = check.startsWith("reject:") ? badge(check.slice(7), "bad") : acc.first_login ? badge("active", "ok") : badge("not used yet", "info");
    const quota = Number(acc.quota_bytes);
    let bar = null;
    if (quota) {
      const used = Number(acc.used_bytes || 0), pct = Math.min(100, (used / quota) * 100);
      const fill = h("div", { class: "hbar-down" }); fill.style.width = `${pct}%`;
      bar = h("div", {}, h("div", { class: "hbar-track" }, fill), h("div", { class: "muted" }, `${bytes(used)} of ${bytes(quota)} used (${acc.quota_period})`));
    }
    items.push(h("dl", { class: "kv" },
      h("dt", {}, "Plan"), h("dd", {}, acc.plan || "—", " ", state),
      h("dt", {}, "First login"), h("dd", {}, acc.first_login ? String(acc.first_login).slice(0, 16) : "—"),
      h("dt", {}, "Expires"), h("dd", {}, acc.expires_at ? String(acc.expires_at).slice(0, 16) : acc.validity_seconds ? `${dur(acc.validity_seconds)} after first login` : "never"),
      h("dt", {}, "Data quota"), h("dd", {}, quota ? bar : "unlimited"),
      h("dt", {}, "Time per day"), h("dd", {}, Number(acc.daily_seconds) ? dur(acc.daily_seconds) : "unlimited"),
      acc.voucher_batch ? [h("dt", {}, "Voucher"), h("dd", {}, h("a", { href: `#/vouchers/${acc.voucher_batch}` }, `batch #${acc.voucher_batch}`))] : null));
  } else items.push(h("p", { class: "muted" }, "No package: this user has no expiry, data quota or time limit."));
  if (isAdmin()) {
    const expiry = h("input", { type: "datetime-local", value: acc?.expires_at ? String(acc.expires_at).slice(0, 16).replace(" ", "T") : "" });
    const quota = h("input", { placeholder: "e.g. 20G", size: 8 });
    items.push(h("div", { class: "form" },
      h("div", { class: "toolbar" }, planSel, h("label", { class: "check" }, free, "free (no sale)"),
        h("button", { onclick: () => act(api("POST", `/api/users/${enc}/sub/plan`, { plan: planSel.value, free: free.checked })).then(route) }, "Set plan"),
        acc?.plan ? h("button", { class: "primary", onclick: () => act(api("POST", `/api/users/${enc}/sub/renew`, { free: free.checked })).then(route) }, "Renew") : null),
      h("div", { class: "toolbar" }, h("span", { class: "muted" }, "Expiry"), expiry,
        h("button", { onclick: () => act(api("POST", `/api/users/${enc}/sub/expiry`, { expiry: expiry.value ? expiry.value.replace("T", " ") : "" })).then(route) }, "Save"),
        h("span", { class: "muted" }, "Own quota"), quota,
        h("button", { onclick: () => act(api("POST", `/api/users/${enc}/sub/quota`, { quota: quota.value.trim() })).then(route) }, "Save"))));
  }
  return card("Package", "plan, expiry, data quota", items);
}

// ------------------------------------------------------------------ speed schedule
const SPEED_DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const timeline = (r) => {
  const segs = r.start_min === r.end_min ? [[0, 1440]] : r.start_min < r.end_min ? [[r.start_min, r.end_min]] : [[r.start_min, 1440], [0, r.end_min]];
  return h("div", { class: "timeline", title: r.start_min === r.end_min ? "all day" : `${hhmm(r.start_min)}–${hhmm(r.end_min)}` },
    segs.map(([a, b]) => { const e = h("span", { class: "seg" + (r.enabled ? "" : " off") }); e.style.left = `${a / 14.4}%`; e.style.width = `${(b - a) / 14.4}%`; return e; }),
    [6, 12, 18].map((x) => { const e = h("i"); e.style.left = `${x / 0.24}%`; return e; }));
};
ROUTES.speed = async () => {
  const d = await api("GET", "/api/speed");
  const edit = (r, preset) => {
    const v = r || preset || {};
    const days = v.days && v.days !== "all" ? v.days.split(",") : SPEED_DAYS.map(([k]) => k);
    const tsel = h("select", { name: "target_type", onchange: () => fill() },
      [["all", "Everyone"], ["group", "A group"], ["plan", "A plan"], ["user", "One user"]].map(([k, l]) => h("option", { value: k, selected: (v.target_type || "all") === k }, l)));
    const target = h("label", { class: "field" }, "Which", h("span"));
    const fill = () => {
      const t = tsel.value;
      target.hidden = t === "all";
      const opts = t === "group" ? d.groups : t === "plan" ? d.plans : null;
      target.lastChild.replaceWith(opts ? h("select", { name: "target" }, opts.map((o) => h("option", { value: o, selected: v.target === o }, o)))
        : h("input", { name: "target", value: v.target || "", placeholder: "username" }));
    };
    const f = h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Name", h("input", { name: "name", required: true, value: v.name || "", readonly: !!r, pattern: "[A-Za-z0-9._\\-]{1,64}" })),
      h("label", { class: "field" }, "Speed (download/upload)", h("input", { name: "rate", required: true, value: v.rate || "", placeholder: "20M/20M", pattern: "[0-9]+[kKmMgG]?/[0-9]+[kKmMgG]?" })),
      h("label", { class: "field" }, "From", h("input", { name: "start", type: "time", required: true, value: hhmm(v.start_min ?? 1320) })),
      h("label", { class: "field" }, "To (next day if earlier)", h("input", { name: "end", type: "time", required: true, value: hhmm(v.end_min ?? 360) })),
      h("div", { class: "field full" }, h("b", {}, "Days (the day the time starts)"), h("div", { class: "day-picks" },
        SPEED_DAYS.map(([k, l]) => h("label", { class: "check" }, h("input", { type: "checkbox", name: `day_${k}`, checked: days.includes(k) }), l)))),
      h("label", { class: "field" }, "Applies to", tsel), target,
      h("div", { class: "full muted" }, "Most specific wins: one user > plan > group > everyone. A fair-usage speed (quota used up) always wins. Running sessions change within 5 minutes."));
    fill();
    dialog(r ? `Speed schedule ${r.name}` : "Add speed schedule", f, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!f.reportValidity()) return false;
      const x = formValues(f);
      const body = { name: x.name, rate: x.rate, start: x.start, end: x.end, target_type: x.target_type, target: x.target || "",
        days: SPEED_DAYS.map(([k]) => k).filter((k) => x[`day_${k}`]) };
      if (!body.days.length) { toast("Pick at least one day", true); return false; }
      if (!(await act(api("POST", "/api/speed", body)))) return false;
      route();
    } }]);
  };
  const presets = [
    ["🌙 Night boost", { name: "night-boost", rate: "20M/20M", start_min: 1320, end_min: 480, target_type: "all" }],
    ["🕖 Peak-hour limit", { name: "peak-hours", rate: "2M/2M", start_min: 1080, end_min: 1380, target_type: "all", days: "mon,tue,wed,thu,fri" }],
    ["📅 Weekend boost", { name: "weekend", rate: "15M/15M", start_min: 0, end_min: 0, target_type: "all", days: "sat,sun" }]];
  const check = h("form", { class: "toolbar wrap", onsubmit: async (e) => {
    e.preventDefault();
    const x = formValues(check);
    const at = x.at ? x.at.replace("T", " ") : "";
    try { const r = await api("GET", `/api/speed/check?user=${encodeURIComponent(x.user)}${at ? `&at=${encodeURIComponent(at)}` : ""}`); out.textContent = r.message; }
    catch (err) { out.textContent = ""; toast(err.message, true); }
  } }, h("input", { name: "user", placeholder: "username", required: true }), h("input", { name: "at", type: "datetime-local", title: "empty = now" }),
    h("button", { type: "submit" }, "Which speed?"));
  const out = h("b", { class: "speed-out" });
  shell("Speed schedule", h("div", { class: "stack" },
    card("Speed by time of day", `now: ${d.now}`,
      h("div", { class: "muted" }, "Give more speed at night or on weekends, or less in busy evening hours. Users get the scheduled speed when they log in, and running sessions are changed automatically (RADIUS CoA)."),
      isAdmin() ? h("div", { class: "toolbar wrap" }, h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "Add"),
        h("span", { class: "muted" }, "Quick start:"), presets.map(([l, p]) => h("button", { class: "small", onclick: () => edit(null, p) }, l))) : null,
      table([{ label: "Name", render: (r) => h("b", {}, r.name) },
        { label: "Now", render: (r) => !r.enabled ? badge("off", "") : r.active ? badge("active", "ok") : badge("waiting", "info") },
        { label: "Speed", key: "rate" },
        { label: "When", render: (r) => h("div", { class: "when" }, h("span", {}, (r.start_min === r.end_min ? "all day" : `${hhmm(r.start_min)}–${hhmm(r.end_min)}`) + " · " +
          (r.days === "all" ? "every day" : r.days.split(",").map((x) => x[0].toUpperCase() + x.slice(1)).join(" "))), timeline(r)) },
        { label: "Applies to", render: (r) => r.target_type === "all" ? "everyone" : `${r.target_type} ${r.target}` },
        { label: "", render: (r) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: () => edit(r) }, "Edit"),
          h("button", { class: "small", onclick: async () => { if (await act(api("POST", `/api/speed/${r.id}/${r.enabled ? "off" : "on"}`, {}))) route(); } }, r.enabled ? "Turn off" : "Turn on"),
          h("button", { class: "small danger", onclick: async () => { if (await confirmDlg("Delete", `Delete speed schedule ${r.name}?`, "Delete")) if (await act(api("POST", `/api/speed/${r.id}/del`, {}))) route(); } }, "Delete")) : null }],
        d.rules, "No speed schedule yet — everyone has their normal speed all day.")),
    card("Check a user", "which speed, and why", check, out)));
};

// ------------------------------------------------------------------ traffic graphs (speed over time)
function lineChart(points, step, labels = ["Download", "Upload"], limit = null) {   // points: [{t, rx_bps, tx_bps}]
  const W = 720, H = 220, P = { l: 70, r: 10, t: 12, b: 26 };
  const lim = limit ? [limit.down_bps, limit.up_bps].filter(Boolean) : [];
  const max = Math.max(...points.map((p) => Math.max(p.rx_bps, p.tx_bps)), ...lim, 1000);
  const mag = Math.pow(1000, Math.floor(Math.log(max) / Math.log(1000)));
  const top = Math.ceil(max / mag / 2) * 2 * mag;
  const n = Math.max(points.length - 1, 1);
  const x = (i) => P.l + (i / n) * (W - P.l - P.r), y = (v) => H - P.b - (v / top) * (H - P.t - P.b);
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    kids.push(svg("line", { class: "grid-line", x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }));
    kids.push(svg("text", { class: "axis", x: P.l - 6, y: y(v) + 4, "text-anchor": "end" }, bps(v)));
  }
  const fmt = (t) => { const d = new Date(t * 1000); return step >= 3 * 3600 ? `${d.getDate()}/${d.getMonth() + 1}` : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const every = Math.ceil(points.length / 8);
  points.forEach((p, i) => { if (i % every === 0) kids.push(svg("text", { class: "axis", x: x(i), y: H - 8, "text-anchor": "middle" }, fmt(p.t))); });
  const path = (key) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join("");
  if (points.length) {
    kids.push(svg("path", { class: "area-down", d: `${path("rx_bps")}L${x(points.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }));
    kids.push(svg("path", { class: "line-down", d: path("rx_bps") }));
    kids.push(svg("path", { class: "line-up", d: path("tx_bps") }));
  }
  if (limit && limit.down_bps) kids.push(svg("line", { class: "limit-line", x1: P.l, x2: W - P.r, y1: y(limit.down_bps), y2: y(limit.down_bps) }, svg("title", {}, `Department download limit ${bps(limit.down_bps)}`)));
  const hover = svg("g", { class: "hover" });
  const tip = h("div", { class: "chart-tip" });
  tip.style.display = "none";
  const box = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Speed over time" }, kids, hover);
  box.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - P.l) / (W - P.l - P.r)) * n)));
    const p = points[i]; if (!p) return;
    hover.replaceChildren(svg("line", { class: "hover-line", x1: x(i), x2: x(i), y1: P.t, y2: H - P.b }));
    tip.textContent = `${new Date(p.t * 1000).toLocaleString()} — ${labels[0]} ${bps(p.rx_bps)} · ${labels[1]} ${bps(p.tx_bps)}`;
    tip.style.display = "";
  });
  box.addEventListener("mouseleave", () => { hover.replaceChildren(); tip.style.display = "none"; });
  return h("div", { class: "chart-wrap" }, box, tip);
}

ROUTES.traffic = async (kind = "if", name = "", range = "24h") => {
  const items = await api("GET", "/api/traffic/items");
  const KINDS = [["if", "Interfaces"], ["user", "Users"], ["group", "Groups"], ["dept", "Departments"]];
  const list = { if: items.interfaces.map((i) => [i.key, `${i.router} — ${i.name}`]), user: items.users.map((u) => [u, u]),
    group: items.groups.map((g) => [g, g]), dept: items.departments.map((d) => [d, d]) }[kind] || [];
  if (!name && list.length) name = list[0][0];
  const go = (k, n, r) => { location.hash = `#/traffic/${k}/${encodeURIComponent(n || "")}/${r}`; };
  const tabs = h("div", { class: "tabs" }, KINDS.map(([k, l]) => h("a", { href: `#/traffic/${k}//${range}`, class: k === kind ? "active" : "" }, l)));
  const sel = kind === "user"
    ? h("input", { list: "tr-users", value: name, placeholder: "user name", onchange: (e) => go(kind, e.target.value.trim(), range) })
    : h("select", { onchange: (e) => go(kind, e.target.value, range) }, list.map(([v, l]) => h("option", { value: v, selected: v === name }, l)));
  const ranges = h("div", { class: "seg" }, ["6h", "24h", "7d", "30d"].map((r) => h("button", { type: "button", class: r === range ? "on" : "", onclick: () => go(kind, name, r) }, r)));
  const head = h("div", { class: "toolbar wrap" }, sel, kind === "user" ? h("datalist", { id: "tr-users" }, items.users.map((u) => h("option", { value: u }))) : null, h("span", { class: "grow" }), ranges);
  let body;
  if (!name) {
    body = h("div", { class: "empty" }, { if: "No router reports yet — the routers send them every minute after auto-sync (Router setup).",
      user: "No user traffic yet — it is counted every 5 minutes from the logins.", group: "No groups yet.", dept: h("span", {}, "No departments yet — ", h("a", { href: "#/departments" }, "make one")) }[kind]);
  } else {
    const d = await api("GET", `/api/traffic/series?kind=${kind}&name=${encodeURIComponent(name)}&range=${range}`);
    const labels = kind === "if" ? ["In (rx)", "Out (tx)"] : ["Download", "Upload"];
    const stat = (l, v) => h("div", { class: "rh-stat" }, h("span", {}, l), h("b", {}, v));
    body = h("div", { class: "stack" },
      h("div", { class: "rh-grid" },
        stat(`${labels[0]} total`, bytes(d.total_rx)), stat(`${labels[1]} total`, bytes(d.total_tx)),
        stat(`${labels[0]} peak`, bps(d.peak_rx)), stat(`${labels[1]} peak`, bps(d.peak_tx)),
        kind === "group" || kind === "dept" ? stat("Users", String(d.members)) : null,
        d.limit ? stat("Shared limit", `${d.limit.down_bps ? bps(d.limit.down_bps) : "none"} ↓ / ${d.limit.up_bps ? bps(d.limit.up_bps) : "none"} ↑`) : null),
      lineChart(d.points, d.step, labels, d.limit),
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "down" }), labels[0]), h("span", {}, h("i", { class: "up" }), labels[1]),
        d.limit && d.limit.down_bps ? h("span", {}, h("i", { class: "limit" }), "department limit") : null,
        h("span", { class: "muted" }, `average per ${d.step >= 3600 ? d.step / 3600 + " h" : d.step / 60 + " min"}`)),
      d.top.length ? h("div", {}, h("h3", {}, "Most traffic"), table([
        { label: "User", render: (r) => h("a", { href: `#/traffic/user/${encodeURIComponent(r.name)}/${range}` }, r.name) },
        { label: "Download", num: true, render: (r) => bytes(Number(r.down)) }, { label: "Upload", num: true, render: (r) => bytes(Number(r.up)) }], d.top)) : null);
  }
  shell("Traffic graphs", card(null, kind === "user" ? "from RADIUS accounting, every 5 min" : kind === "if" ? "from the routers' minute reports" : "sum of their users", tabs, head, body));
};

// ------------------------------------------------------------------ departments: one shared speed for a team
ROUTES.departments = async () => {
  const d = await api("GET", "/api/departments");
  const edit = (x) => {
    const mb = (k) => (k ? String(k / 1000) : "0");
    const form = h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Name", h("span", { class: "help" }, "a-z 0-9 -"), h("input", { name: "name", required: true, pattern: "[a-z0-9][a-z0-9-]{0,23}", value: x ? x.name : "", readonly: !!x, placeholder: "sales" })),
      h("label", { class: "field" }, "Title", h("input", { name: "title", maxlength: 80, value: x ? x.title : "", placeholder: "Sales team" })),
      h("label", { class: "field" }, "Download for the whole department (Mbit/s)", h("input", { name: "down", type: "number", min: 0, step: "0.1", required: true, value: x ? mb(x.down_kbps) : "10" })),
      h("label", { class: "field" }, "Upload (Mbit/s)", h("input", { name: "up", type: "number", min: 0, step: "0.1", required: true, value: x ? mb(x.up_kbps) : "5" })),
      h("div", { class: "full muted small" }, "0 = no limit. One user online gets all of it; 10 users online share it equally (about a tenth each)."));
    dialog(x ? `Department ${x.name}` : "New department", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      const v = formValues(form);
      const r = await act(api("POST", "/api/departments", { ...v, down: v.down === "0" ? "0" : `${v.down}M`, up: v.up === "0" ? "0" : `${v.up}M`, new: !x }));
      if (!r) return false; route();
    } }]);
  };
  const addMember = (x) => {
    const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Add", h("select", { name: "kind" }, h("option", { value: "user" }, "a user"), h("option", { value: "group" }, "a whole group"))),
      h("label", { class: "field" }, "Name", h("input", { name: "name", required: true, list: "dept-groups", placeholder: "ali  or  staff" }),
        h("datalist", { id: "dept-groups" }, d.groups.map((g) => h("option", { value: g })))),
      h("div", { class: "muted small" }, "A user can be in one department. A user's own entry wins over their group's."));
    dialog(`Add to ${x.name}`, form, [{ label: "Cancel" }, { label: "Add", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      if (!(await act(api("POST", `/api/departments/${x.name}/member`, formValues(form))))) return false; route();
    } }]);
  };
  const meter = (now, lim) => {
    const m = h("div", { class: "meter" }), f = h("i");
    f.style.width = `${lim ? Math.min(100, (now / (lim * 1000)) * 100) : 0}%`;
    m.append(f); return m;
  };
  const cards = d.departments.map((x) => card(`${x.name}${x.title ? " — " + x.title : ""}`,
    `${x.down_kbps ? bps(x.down_kbps * 1000) : "no limit"} ↓ · ${x.up_kbps ? bps(x.up_kbps * 1000) : "no limit"} ↑ shared`,
    h("div", { class: "rh-grid" },
      h("div", { class: "rh-stat" }, h("span", {}, "Users"), h("b", {}, String(x.users.length)), h("small", { class: "muted" }, `${x.online.length} online now`)),
      h("div", { class: "rh-stat" }, h("span", {}, "Download now"), h("b", {}, bps(x.now_down_bps)), meter(x.now_down_bps, x.down_kbps)),
      h("div", { class: "rh-stat" }, h("span", {}, "Each online user gets"), h("b", {}, x.down_kbps ? (x.online.length ? `~${bps((x.down_kbps * 1000) / x.online.length)}` : bps(x.down_kbps * 1000)) : "—"),
        h("small", { class: "muted" }, "when all are busy"))),
    h("div", { class: "chips" }, x.members.length ? x.members.map((m) => h("span", { class: "chip" }, m.kind === "group" ? h("b", {}, "group ") : null, m.name,
      isAdmin() ? h("button", { type: "button", class: "chip-x", title: "remove", onclick: async () => { if (await act(api("POST", "/api/departments/unmember", m))) route(); } }, "×") : null))
      : h("span", { class: "muted" }, "No members yet.")),
    h("div", { class: "toolbar wrap" },
      h("a", { class: "btn small", href: `#/traffic/dept/${x.name}/24h` }, icon("graph"), "Graph"),
      isAdmin() ? h("button", { class: "small", onclick: () => addMember(x) }, icon("plus"), "Add user / group") : null,
      isAdmin() ? h("button", { class: "small", onclick: () => edit(x) }, "Speed") : null,
      isAdmin() ? h("button", { class: "small danger", onclick: async () => {
        if (await confirmDlg("Remove department", `Remove ${x.name}? Its users get their own speed only.`, "Remove"))
          if (await act(api("DELETE", `/api/departments/${x.name}`))) route();
      } }, "Remove") : null)));
  shell("Departments", h("div", { class: "stack" },
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "Give a team one internet speed: 10 Mbit/s for Sales means one user alone gets 10, ten users share the 10."),
      isAdmin() ? h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "New department") : null),
    cards.length ? h("div", { class: "grid dept-grid" }, cards) : card(null, null, h("div", { class: "empty" }, "No departments yet.")),
    card("How it works on the router", null, h("ul", { class: "tips" },
      h("li", {}, "Auto-sync puts a queue (PCQ) per department on every router: the speed is shared equally by the users who are online and busy."),
      h("li", {}, "Every minute the router asks this server which addresses belong to which department (logins and logouts)."),
      h("li", {}, "A user's own speed (plan / group) still applies on top: e.g. 2 Mbit/s each inside a 10 Mbit/s department."),
      h("li", {}, "FastTrack would skip the queue — department traffic is kept out of it by itself. Each router has its own 10 Mbit/s.")))));
};

// ------------------------------------------------------------------ IP binding: every user keeps one address
ROUTES.ipbind = async () => {
  const d = await api("GET", "/api/ipbind");
  const edit = (b) => {
    const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "User", h("input", { name: "user", required: true, value: b ? b.username : "", readonly: !!b, placeholder: "ali" })),
      h("label", { class: "field" }, "Address", h("span", { class: "help" }, "in the router's LAN, e.g. 192.168.88.50 — better outside the DHCP pool"),
        h("input", { name: "ip", required: true, value: b ? b.ip : "", placeholder: "192.168.88.50", pattern: "^\\d{1,3}(\\.\\d{1,3}){3}$" })));
    dialog(b ? `Change address of ${b.username}` : "Bind a user to an address", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      if (!(await act(api("POST", "/api/ipbind", formValues(form))))) return false;
      route();
    } }]);
  };
  const auto = h("label", { class: "check" + (d.auto ? " on" : "") }, h("input", { type: "checkbox", checked: d.auto, disabled: !isAdmin(),
    onchange: async (e) => { await act(api("POST", "/api/ipbind/settings", { auto: e.target.checked })); route(); } }),
    h("div", {}, h("b", {}, "Every user keeps the first address DHCP gives them"),
      h("span", {}, "Checked every 5 minutes. The routers get a DHCP static lease (auto-sync, 15 min); the device gets it at its next DHCP renewal or Wi-Fi off/on. PPPoE users: static IP on the user (Users → user → IP).")));
  const days = h("input", { type: "number", min: 0, max: 3650, value: d.days, class: "w-num" });
  const settings = h("div", { class: "toolbar wrap" }, h("span", {}, "Free an automatic address after"), days, h("span", {}, "days without a login (0 = never)"),
    isAdmin() ? h("button", { class: "small", onclick: async () => { if (await act(api("POST", "/api/ipbind/settings", { days: days.value }))) route(); } }, "Save") : null);
  const search = h("input", { type: "search", placeholder: "Search user, address or MAC", class: "grow" });
  const holder = h("div");
  const draw = () => {
    const f = search.value.trim().toLowerCase();
    const rows = d.bindings.filter((b) => !f || `${b.username} ${b.ip} ${b.mac}`.toLowerCase().includes(f));
    holder.replaceChildren(table([
      { label: "User", render: (b) => h("b", {}, b.username) },
      { label: "Address", render: (b) => h("code", {}, b.ip) },
      { label: "Device", render: (b) => b.mac ? h("span", {}, h("code", {}, b.mac), " ", b.random ? badge("random MAC", "warn") : null) : h("span", { class: "muted" }, "known at the next login") },
      { label: "How", render: (b) => b.locked ? badge("set by admin", "ok") : badge("auto") },
      { label: "Now", render: (b) => !b.ip_now ? h("span", { class: "muted" }, "offline") : b.ip_now === b.ip ? badge("online on it", "ok")
          : h("span", {}, h("code", {}, b.ip_now), " ", badge("moves at the next DHCP renewal", "warn")) },
      { label: "Last seen", render: (b) => ago(b.last_seen) },
      { label: "", render: (b) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: () => edit(b) }, "Change"),
          b.locked ? h("button", { class: "small", onclick: async () => { if (await act(api("POST", "/api/ipbind/unlock", { user: b.username }))) route(); } }, "Auto") : null,
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Remove binding", `${b.username} will get any free address again.`, "Remove"))
              if (await act(api("POST", "/api/ipbind/del", { user: b.username }))) route();
          } }, "Remove")) : null }],
      rows, d.auto ? "No bindings yet — they appear after users log in." : "No bindings. Turn on the automatic binding above, or bind a user yourself."));
  };
  search.addEventListener("input", draw);
  draw();
  const nRandom = d.bindings.filter((b) => b.random).length;
  shell("IP binding", h("div", { class: "stack" },
    card("Fixed address per user", `${d.bindings.length} bound · ${d.bindings.filter((b) => b.locked).length} by the admin`, auto, settings),
    card(null, null, h("div", { class: "toolbar" }, search, isAdmin() ? h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "Bind a user") : null), holder),
    card("Random (private) MAC addresses", nRandom ? `${nRandom} device(s) here use one` : null,
      h("ul", { class: "tips" },
        h("li", {}, h("b", {}, "The address follows the user, not the MAC. "), "When a phone comes back with a new random MAC, the binding moves to the new MAC by itself after the login."),
        h("li", {}, "Android 10+ and iPhone (iOS 14+) use one random MAC per Wi-Fi name that normally stays the same — nothing to do."),
        h("li", {}, "iPhone 'Rotating' and Android 'non-persistent' change it now and then: the user logs in again once (hotspot), then keeps the same address."),
        h("li", {}, "Things that work by MAC (MAC devices, hotspot auto-login cookie) need the real MAC: Wi-Fi settings → this network → Private address ", h("b", {}, "Off"), " (iPhone) / ", h("b", {}, "Use device MAC"), " (Android)."),
        h("li", {}, "Staff Wi-Fi with username + password (WPA-Enterprise) never depends on the MAC.")))));
};

// ------------------------------------------------------------------ router setup: one line for the MikroTik terminal
const SETUP_PRESETS = {
  blocking: { webfilter: 1, logging: 1, dnslog: 1, autosync: 1 },
  hotspot: { hotspot: 1, base_done: 1 }, usage: { traffic: 1, base_done: 1 }, security: { security: 1, languard: 1, base_done: 1 },
};
ROUTES.setup = async (preset = "blocking") => {
  if (!isAdmin()) return shell("Router setup", card(null, null, h("div", { class: "empty" }, "Only an admin can make router scripts.")));
  const d = await api("GET", "/api/router-setup");
  const DEF = { ...(SETUP_PRESETS[preset] || SETUP_PRESETS.blocking) };
  const HELP = {
    hotspot: "Login page with vouchers / social WiFi on the LAN",
    wpa_ros7: "Staff log in with their own username + password (RouterOS 7 routers: hAP ax, cAP ax …)",
    wpa_legacy: "Same, for older routers with the 'wireless' menu (hAP ac², RB951 …)",
    pppoe: "Customers dial in with PPPoE (ISP style)",
    macauth: "Printers, TVs, CCTV join a separate Wi-Fi by MAC address",
    webfilter: "Needed by blocking, logs and auto-sync — added by itself when needed",
    logging: "Router logs come to this server (Live log, Security)",
    dnslog: "Which sites and apps everyone opens",
    traffic: "Data usage per user, DDoS detection",
    autosync: "Policies, block lists, hotspot pages and router health — every 15 min by itself",
    security: "Stops port scans, password guessing, SYN flood",
    languard: "Warns about a fake DHCP router or ARP spoofing on the LAN",
    snmp: "Devices page: the router's CPU, temperature, ports and traffic; traps (port down, restart) to the server — read only, for this server only",
  };
  const extra = {};
  const fld = (label, name, attrs = {}, help) => h("label", { class: "field" }, label, help ? h("span", { class: "help" }, help) : null, h("input", { name, ...attrs }));
  extra.hotspot = h("div", { class: "form cols sub-opts" },
    h("label", { class: "check full" }, h("input", { type: "checkbox", name: "hotspot_create" }),
      h("div", {}, h("b", {}, "Make the hotspot too"), h("span", {}, "Only if this router has no hotspot yet. Else it uses the one made by IP → Hotspot → Hotspot Setup."))),
    fld("Router's LAN address", "lan_net", { placeholder: "192.168.88.1/24" }), fld("Login page name", "dns_name", { placeholder: "login.wifi" }));
  extra.wpa_ros7 = h("div", { class: "form cols sub-opts" }, fld("Staff Wi-Fi name", "staff_ssid", { placeholder: "Office-WiFi", maxlength: 32 }));
  extra.wpa_legacy = h("div", { class: "form cols sub-opts" }, fld("Staff Wi-Fi name", "staff_ssid_legacy", { placeholder: "Office-WiFi", maxlength: 32 }));
  extra.pppoe = h("div", { class: "form cols sub-opts" }, fld("Customer side port", "pppoe_if", { placeholder: "ether2" }, "interface, bridge or VLAN"));
  extra.macauth = h("div", { class: "form cols sub-opts" }, fld("Devices Wi-Fi name", "devices_ssid", { placeholder: "Devices-WiFi", maxlength: 32 }),
    fld("Devices Wi-Fi password", "devices_key", { placeholder: "8 letters or more", maxlength: 63, autocomplete: "off" }));
  extra.webfilter = h("div", { class: "form cols sub-opts" }, h("label", { class: "check full" }, h("input", { type: "checkbox", name: "base_done", checked: !!DEF.base_done }),
    h("div", {}, h("b", {}, "Already on this router"), h("span", {}, "Tick when adding a part later, so the base is not added twice."))));
  const parts = d.modules.map((m) => {
    const box = h("input", { type: "checkbox", name: m.key, checked: !!DEF[m.key] });
    const wrap = h("label", { class: "check" + (DEF[m.key] ? " on" : "") }, box, h("div", {}, h("b", {}, m.title), h("span", {}, HELP[m.key] || "")));
    const ex = extra[m.key];
    const sync = () => { wrap.classList.toggle("on", box.checked); if (ex) ex.style.display = (box.checked || m.key === "webfilter") ? "" : "none"; };
    box.addEventListener("change", () => {
      if (box.checked && m.key === "wpa_ros7") f.querySelector("[name=wpa_legacy]").checked = false;
      if (box.checked && m.key === "wpa_legacy") f.querySelector("[name=wpa_ros7]").checked = false;
      f.querySelectorAll(".parts input[type=checkbox]").forEach((b) => b.dispatchEvent(new Event("sync")));
    });
    box.addEventListener("sync", sync);
    setTimeout(sync);
    return h("div", { class: "part" }, wrap, ex || null);
  });
  const out = h("div", { class: "stack" });
  const f = h("form", { class: "stack", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(f);
    if (v.wpa_legacy) v.staff_ssid = v.staff_ssid_legacy;
    const r = await act(api("POST", "/api/router-setup", v));
    if (!r) return;
    showResult(r, v.router);
  } },
    card("1 · Router and server", null, h("div", { class: "form cols" },
      h("label", { class: "field" }, "Router", h("span", { class: "help" }, "from the Routers page — its RADIUS secret goes in by itself"),
        d.routers.length ? h("select", { name: "router" }, d.routers.map((r) => h("option", { value: r.nasname }, r.shortname ? `${r.shortname} (${r.nasname})` : r.nasname)))
          : h("div", { class: "empty" }, h("a", { href: "#/routers" }, "Add the router first"))),
      fld("This server's IP (as the router sees it)", "server_ip", { value: d.server_ip, placeholder: "10.10.10.10", required: true }),
      fld("LAN interface", "lan_if", { value: "bridge" }, "where the users are: bridge, ether2, vlan20"),
      h("div", {}),
      fld("Server port (optional)", "server_if", { placeholder: "ether5" }, "the port the server's cable is in — taken out of the bridge"),
      fld("Router address on that port", "server_net", { placeholder: "10.10.10.1/24" }))),
    card("2 · What to set up", "tick what this router needs", h("div", { class: "parts" }, parts)),
    h("div", { class: "toolbar" }, h("button", { class: "primary", type: "submit", disabled: !d.routers.length }, icon("term"), "Make the script")),
    out);
  let timer;
  function showResult(r, router) {
    clearInterval(timer);
    const state = h("span", {}, badge("waiting for the router…"));
    const copy = h("button", { type: "button", class: "primary", onclick: async () => {
      try { await navigator.clipboard.writeText(r.line); toast("Copied"); } catch { toast("Select the line and copy it", true); }
    } }, "Copy");
    const dl = h("button", { type: "button", onclick: () => {
      const a = h("a", { href: URL.createObjectURL(new Blob([r.script], { type: "text/plain" })), download: `ml-setup-${router}.rsc` });
      document.body.append(a); a.click(); a.remove();
    } }, icon("data"), "Download .rsc");
    const pre = h("pre", { class: "rsc-view" }, r.script);
    pre.style.display = "none";
    out.replaceChildren(card("3 · Paste on the router", `${r.lines} lines · link works for 1 hour`,
      h("ol", { class: "steps" },
        h("li", {}, "Winbox → connect to the router → ", h("b", {}, "New Terminal"), "."),
        h("li", {}, "Paste this one line and press ", h("b", {}, "Enter"), ":"),
      ),
      h("div", { class: "secret-box", id: "setup-line" }, r.line),
      h("div", { class: "toolbar wrap" }, copy, dl, h("button", { type: "button", onclick: () => { pre.style.display = pre.style.display ? "" : "none"; } }, "Show the script"), h("span", { class: "grow" }), state),
      h("div", { class: "muted small" }, "No internet path from router to server? Download the .rsc, drag it into Winbox → Files, then in the terminal: /import file-name=ml-setup.rsc"),
      pre));
    out.scrollIntoView({ behavior: "smooth" });
    const poll = async () => {
      if (!document.body.contains(state)) return clearInterval(timer);
      try {
        const s = await api("GET", `/api/router-setup/${r.token}`);
        if (s.fetched) { state.replaceChildren(badge("router downloaded it ✔", "ok")); clearInterval(timer); }
      } catch { clearInterval(timer); state.replaceChildren(badge("link expired")); }
    };
    timer = setInterval(poll, 4000);
  }
  shell("Router setup", h("div", { class: "stack" },
    h("div", { class: "muted" }, "Makes one script for a MikroTik with this server's address, the router's secret and your names filled in. No file editing — copy one line into the router's terminal."),
    f));
};

// ------------------------------------------------------------------ hotspot login page designer
ROUTES.hotspot = async (pageName = "login.html") => {
  const d = await api("GET", "/api/hotspot");
  const st = d.settings;
  const frame = h("iframe", { class: "hs-preview", title: "preview", sandbox: "" });
  const load = (pg) => { frame.src = `/api/hotspot/preview/${pg}?t=${Date.now()}`; };
  const tabs = h("div", { class: "tabs" }, [["login.html", "Login"], ["status.html", "After login (status)"], ["alogin.html", "Just logged in"]].map(([k, l]) =>
    h("a", { href: `#/hotspot/${k}`, class: k === pageName ? "active" : "", onclick: (e) => { e.preventDefault(); tabs.querySelectorAll("a").forEach((a) => a.classList.remove("active")); e.target.classList.add("active"); pageName = k; load(k); } }, l)));
  const f = h("form", { class: "form", onsubmit: async (e) => {
    e.preventDefault();
    const v = formValues(f);
    if (await act(api("POST", "/api/hotspot", v))) load(pageName);
  } },
    h("label", { class: "field" }, "Title", h("input", { name: "hs_title", maxlength: 80, value: st.hs_title, placeholder: d.brand })),
    h("label", { class: "field" }, "Line under the title", h("input", { name: "hs_sub", maxlength: 80, value: st.hs_sub, placeholder: "Card par likha username aur password likhein" })),
    h("div", { class: "toolbar wrap" },
      h("label", { class: "field" }, "Colour 1", h("input", { name: "hs_color1", type: "color", value: st.hs_color1 || "#1d4ed8" })),
      h("label", { class: "field" }, "Colour 2", h("input", { name: "hs_color2", type: "color", value: st.hs_color2 || "#0ea5e9" })),
      h("div", { class: "toolbar wrap" }, [["#1d4ed8", "#0ea5e9"], ["#15803d", "#84cc16"], ["#7e22ce", "#ec4899"], ["#b91c1c", "#f97316"], ["#0f172a", "#475569"]].map(([a, b]) => {
        const sw = h("button", { type: "button", class: "swatch", title: `${a} → ${b}`, onclick: () => { f.querySelector("[name=hs_color1]").value = a; f.querySelector("[name=hs_color2]").value = b; } });
        sw.style.background = `linear-gradient(135deg, ${a}, ${b})`; return sw;
      }))),
    h("label", { class: "field" }, "Notice / advert box (| = new line)", h("textarea", { name: "hs_notice", maxlength: 400, rows: 2, placeholder: "Naya offer: 30 din 500 Rs | Raat 12 se 8 double speed" }, st.hs_notice || "")),
    h("label", { class: "field" }, "Footer", h("input", { name: "hs_footer", maxlength: 80, value: st.hs_footer, placeholder: "Masla? Rabta: 0300-…" })),
    isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", type: "submit" }, "Save & preview")) : null);
  const logoIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp" });
  const logoBox = h("div", { class: "toolbar wrap" }, h("b", {}, "Logo:"), d.logo ? badge("set", "ok") : badge("none", ""), logoIn,
    isAdmin() ? h("button", { type: "button", onclick: () => {
      const file = logoIn.files[0];
      if (!file) return toast("Choose a picture first", true);
      if (file.size > 100000) return toast("Logo too big — 100 KB at most", true);
      const rd = new FileReader();
      rd.onload = async () => { if (await act(api("POST", "/api/hotspot/logo", { data: rd.result }))) route(); };
      rd.readAsDataURL(file);
    } }, "Upload") : null,
    d.logo && isAdmin() ? h("button", { type: "button", class: "small danger", onclick: async () => { if (await act(api("POST", "/api/hotspot/logo", { data: "" }))) route(); } }, "Remove") : null);
  const push = h("label", { class: "check" + (st.hs_push === "1" ? " on" : "") }, h("input", { type: "checkbox", checked: st.hs_push === "1", disabled: !isAdmin(),
    onchange: async (e) => { await act(api("POST", "/api/hotspot/push", { on: e.target.checked })); route(); } }),
    h("div", {}, h("b", {}, "Put these pages on the routers automatically"), h("span", {}, "Router auto-sync downloads login.html, status.html and alogin.html into every hotspot profile's folder (within 15 minutes after a change). Off = the routers keep their own pages.")));
  shell("Hotspot page", h("div", { class: "grid hs-grid" },
    h("div", { class: "stack" }, card("Login page design", d.version ? `design ${d.version}` : "not made yet", f, logoBox), card("Routers", null, push,
      h("div", { class: "muted small" }, "By hand instead: Winbox → Files → hotspot/ → upload the 3 files from the server folder /var/lib/mikrotiklover/router/hotspot/."))),
    card("Preview", "phone size", tabs, h("div", { class: "hs-phone" }, frame))));
  load(pageName);
};

// ------------------------------------------------------------------ social WiFi (cafe): phone number + code
ROUTES.social = async () => {
  const d = await api("GET", "/api/social");
  const st = d.settings, s = d.stats, on = st.social_on === "1";
  const f = h("form", { class: "form cols", onsubmit: async (e) => {
    e.preventDefault();
    if (await act(api("POST", "/api/social", formValues(f)))) route();
  } },
    h("label", { class: "field" }, "Free minutes per day", h("input", { name: "minutes", type: "number", min: 1, max: 9999, value: st.social_minutes })),
    h("label", { class: "field" }, "Free data per day (MB)", h("input", { name: "mb", type: "number", min: 1, value: st.social_mb })),
    h("label", { class: "field" }, "Speed (empty = no limit)", h("input", { name: "rate", value: st.social_rate, placeholder: "2M/2M" })),
    h("label", { class: "field" }, "Code message (SMS / WhatsApp)", h("input", { name: "message", maxlength: 160, value: st.social_msg })),
    isAdmin() ? h("div", { class: "full" }, h("button", { class: "primary", type: "submit" }, "Save")) : null);
  const toggle = h("label", { class: "check" + (on ? " on" : "") }, h("input", { type: "checkbox", checked: on, disabled: !isAdmin(),
    onchange: async (e) => { if (!(await act(api("POST", "/api/social", { on: e.target.checked })))) e.target.checked = !e.target.checked; route(); } }),
    h("div", {}, h("b", {}, "Free WiFi with the phone number"), h("span", {}, "The hotspot login page gets a button \"📱 Phone number se free WiFi\". The customer types the number, gets a 6-digit code by SMS / WhatsApp, and is online — within the daily limit below.")));
  const offer = h("input", { maxlength: 300, placeholder: "Aaj chai + paratha sirf 200 Rs — 5 baje tak!", class: "grow" });
  const send = (dry) => async (e) => {
    if (!offer.value.trim()) return toast("Write the offer first", true);
    if (!dry && !(await confirmDlg("Send offer", `Send this SMS to the customers who allowed offers (${s.consent})?`, "Send"))) return;
    e.target.disabled = true; await act(api("POST", "/api/social/offer", { text: offer.value.trim(), dry })); e.target.disabled = false; if (!dry) route();
  };
  const needs = [];
  if (!st.server_ip) needs.push("this server's IP for the routers (Security → Protection & lists → server IP)");
  shell("Social WiFi", h("div", { class: "stack" },
    h("div", { class: "grid g-tiles" },
      tile("Customers", String(s.customers), `${s.came_back} came back`), tile("Today", String(s.today), `${s.new_today} new`),
      tile("Allow offers", String(s.consent), "can get your SMS offers"), tile("Free per day", `${st.social_minutes} min`, `${st.social_mb} MB${st.social_rate ? ` · ${st.social_rate}` : ""}`)),
    card("Social WiFi for the cafe", on ? "on" : "off",
      h("div", { class: "muted" }, "Customers get free internet for a while by giving their mobile number (checked with a code). You get a list of your customers and can send them offers. Needs an SMS / WhatsApp gateway (Settings → Warn users → SMS gateway) and the login pages on the routers (Hotspot page → put on the routers)."),
      needs.length ? h("div", { class: "note" }, "First set: ", needs.join("; ")) : null,
      h("div", { class: "checks" }, toggle), f),
    card("Send an offer", "only to customers who allowed it · once a day at most",
      h("div", { class: "toolbar wrap" }, offer, isAdmin() ? h("button", { onclick: send(true) }, "How many?") : null, isAdmin() ? h("button", { class: "primary", onclick: send(false) }, "Send") : null)),
    card("Customers", `${d.customers.length} shown`,
      isAdmin() ? h("div", { class: "toolbar" }, h("span", { class: "grow" }), h("a", { class: "btn small", href: "/api/social/export.csv" }, "⬇ Export CSV")) : null,
      table([{ label: "Phone", render: (c) => h("code", {}, c.phone) }, { label: "Name", key: "name" },
        { label: "Offers", render: (c) => c.consent ? badge("yes", "ok") : badge("no", "") }, { label: "Visits", key: "visits", num: true },
        { label: "First", render: (c) => String(c.first_seen).slice(0, 16) }, { label: "Last", render: (c) => String(c.last_seen).slice(0, 16) },
        { label: "", render: (c) => isAdmin() ? h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Forget customer", `Remove ${c.phone} and their WiFi account?`, "Remove")) if (await act(api("POST", "/api/social/forget", { phone: c.phone }))) route();
          } }, "Forget") : null }], d.customers, "No customer yet."))));
};

ROUTES.plans = async () => {
  const [{ plans, currency }, meta] = await Promise.all([api("GET", "/api/plans"), api("GET", "/api/blocking").catch(() => ({ policies: [] }))]);
  const edit = (p) => {
    const toDur = (s) => { s = Number(s) || 0; return !s ? "" : s % 86400 === 0 ? `${s / 86400}d` : s % 3600 === 0 ? `${s / 3600}h` : `${Math.round(s / 60)}m`; };
    const toSize = (b) => { b = Number(b) || 0; return !b ? "" : b % (1 << 30) === 0 ? `${b / (1 << 30)}G` : `${Math.round(b / (1 << 20))}M`; };
    const f = h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Name", h("input", { name: "name", required: true, pattern: "[A-Za-z0-9._@+\\-]{1,64}", value: p?.name || "", readonly: !!p, placeholder: "day-1gb" })),
      h("label", { class: "field" }, `Price (${currency})`, h("input", { name: "price", type: "number", min: 0, step: "0.01", value: p ? Number(p.price) : "" })),
      h("label", { class: "field" }, "Validity", h("span", { class: "help" }, "Counts from the first login: 1d, 7d, 30d, 12h — empty = never expires"), h("input", { name: "validity", value: toDur(p?.validity_seconds), placeholder: "30d" })),
      h("label", { class: "field" }, "Data quota", h("span", { class: "help" }, "500M, 1G, 10G — empty = unlimited"), h("input", { name: "quota", value: toSize(p?.quota_bytes), placeholder: "10G" })),
      h("label", { class: "field" }, "Quota resets", h("select", { name: "period" }, ["total", "monthly", "daily"].map((x) => h("option", { value: x, selected: (p?.quota_period || "total") === x }, { total: "never (whole package)", monthly: "every month", daily: "every day" }[x])))),
      h("label", { class: "field" }, "Speed after quota (FUP)", h("span", { class: "help" }, "e.g. 1M/1M — empty = cut off when the quota is used"), h("input", { name: "fup", value: p?.fup_rate || "", placeholder: "1M/1M" })),
      h("label", { class: "field" }, "IP pool (PPPoE)", h("span", { class: "help" }, "Optional MikroTik pool name"), h("input", { name: "pool", value: p?.pool || "", placeholder: "pppoe-pool" })),
      h("label", { class: "field" }, "Online time per day", h("span", { class: "help" }, "e.g. 2h — empty = unlimited"), h("input", { name: "daily_time", value: toDur(p?.daily_seconds), placeholder: "2h" })),
      h("label", { class: "field" }, "Speed", h("span", { class: "help" }, "MikroTik rx/tx, e.g. 5M/5M"), h("input", { name: "rate", value: p?.rate || "", placeholder: "5M/5M" })),
      h("label", { class: "field" }, "Devices at once", h("input", { name: "devices", type: "number", min: 1, value: p?.devices || "1" })),
      h("label", { class: "field" }, "Blocking policy", h("span", { class: "help" }, "every voucher / PIN / guest of this plan gets it"),
        h("select", { name: "policy" }, h("option", { value: "" }, "— none —"), meta.policies.map((x) => h("option", { value: x.name, selected: x.name === p?.policy }, `${x.name} — ${x.description}`)))),
      h("label", { class: "field full" }, "Description (printed on vouchers)", h("input", { name: "description", maxlength: 128, value: p?.description || "", placeholder: "1 day, 1 GB, 4 Mbps" })));
    dialog(p ? `Edit plan ${p.name}` : "New plan", f, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!f.reportValidity()) return false;
      if (!(await act(api("POST", "/api/plans", { ...formValues(f), edit: !!p })))) return false;
      route();
    } }]);
  };
  shell("Plans", card(null, null,
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "Packages you sell: price, validity, data, daily time, speed. Each plan is also a RADIUS group."),
      isAdmin() ? h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "New plan") : null),
    table([
      { label: "Plan", render: (p) => h("span", {}, h("b", {}, p.name), p.description ? h("div", { class: "muted" }, p.description) : null) },
      { label: "Price", num: true, render: (p) => money(p.price, currency) },
      { label: "Validity", render: (p) => dur(p.validity_seconds) },
      { label: "Data", render: (p) => Number(p.quota_bytes) ? h("span", {}, `${bytes(p.quota_bytes)} / ${p.quota_period}`, h("div", { class: "muted" }, p.fup_rate ? `then ${p.fup_rate}` : "then cut off")) : "Unlimited" },
      { label: "Per day", render: (p) => dur(p.daily_seconds) },
      { label: "Speed", render: (p) => p.rate || "—" }, { label: "Devices", render: (p) => p.devices || "—" },
      { label: "Policy", render: (p) => p.policy ? badge(p.policy, "info") : h("span", { class: "muted" }, "—") },
      { label: "Active / total", num: true, render: (p) => `${p.active} / ${p.accounts}` },
      { label: "", render: (p) => isAdmin() ? h("div", { class: "row-actions" },
          h("button", { class: "small", onclick: () => edit(p) }, "Edit"),
          h("button", { class: "small primary", onclick: () => { location.hash = `#/vouchers/new/${encodeURIComponent(p.name)}`; } }, "Vouchers"),
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Delete plan", `Delete plan ${p.name}? ${p.accounts} account(s) use it — they keep working without limits.`, "Delete"))
              if (await act(api("DELETE", `/api/plans/${encodeURIComponent(p.name)}?force=1`))) route();
          } }, "Delete")) : null }], plans, "No plans yet — create your first package.")));
};

function voucherDialog(plans, preset) {
  plans = plans.filter((p) => p.name !== "social-free");     // social WiFi's own plan: no cards
  const f = h("form", { class: "form cols", onsubmit: (e) => e.preventDefault() },
    h("label", { class: "field" }, "Plan", h("select", { name: "plan", required: true }, plans.map((p) => h("option", { value: p.name, selected: p.name === preset }, p.name)))),
    h("label", { class: "field" }, "How many", h("input", { name: "count", type: "number", min: 1, max: 1000, value: 20, required: true })),
    h("label", { class: "field" }, "Prefix", h("span", { class: "help" }, "Optional, up to 6 letters, e.g. WF"), h("input", { name: "prefix", maxlength: 6, pattern: "[A-Za-z0-9]{0,6}" })),
    h("label", { class: "field" }, "Note", h("input", { name: "note", maxlength: 128, placeholder: "Shop counter, October" })),
    h("label", { class: "check full" }, h("input", { type: "checkbox", name: "pin" }), "PIN mode: username and password are the same code (easier for customers)"));
  dialog("Create vouchers", f, [{ label: "Cancel" }, { label: "Create", class: "primary", action: async () => {
    if (!f.reportValidity()) return false;
    const r = await act(api("POST", "/api/vouchers", formValues(f)));
    if (!r) return false;
    location.hash = `#/vouchers/${r.batch}`;
  } }]);
}

ROUTES.vouchers = async (id, preset) => {
  if (id && id !== "new") return voucherBatch(id);
  const [{ batches, currency }, { plans }] = await Promise.all([api("GET", "/api/vouchers"), api("GET", "/api/plans")]);
  shell("Vouchers", card(null, null,
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "Pre-paid cards: the package starts at the first login."),
      isAdmin() ? h("button", { class: "primary", disabled: !plans.length, onclick: () => voucherDialog(plans) }, icon("plus"), "Create vouchers") : null),
    plans.length ? null : h("div", { class: "note" }, "Create a plan first (Plans page)."),
    table([
      { label: "Batch", render: (b) => h("a", { href: `#/vouchers/${b.id}` }, `#${b.id}`) },
      { label: "Plan", key: "plan" }, { label: "Price", num: true, render: (b) => money(b.price, currency) },
      { label: "Cards", key: "count", num: true },
      { label: "Unused", num: true, render: (b) => badge(String(b.unused), "info") },
      { label: "Active", num: true, render: (b) => badge(String(b.active), "ok") },
      { label: "Expired", num: true, key: "expired" },
      { label: "Sold", num: true, render: (b) => money((Number(b.remaining) - Number(b.unused)) * Number(b.price), currency) },
      { label: "Created", render: (b) => `${String(b.created_at).slice(0, 16)} · ${b.created_by}` },
      { label: "Note", key: "note", wrap: true }], batches, "No vouchers yet.")));
  if (id === "new" && isAdmin() && plans.length) voucherDialog(plans, preset);
};

async function voucherBatch(id) {
  const d = await api("GET", `/api/vouchers/${encodeURIComponent(id)}`);
  const cur = d.settings.currency;
  shell(`Voucher batch #${d.batch.id}`, h("div", { class: "stack" },
    h("div", {}, h("a", { href: "#/vouchers" }, "← Vouchers")),
    h("div", { class: "grid g-tiles" }, tile("Plan", d.batch.plan), tile("Price", money(d.batch.price, cur)),
      tile("Unused", String(d.codes.filter((c) => c.status === "unused").length)), tile("Active", String(d.codes.filter((c) => c.status === "active").length))),
    card(null, null, h("div", { class: "toolbar" },
      h("a", { class: "btn primary", href: `#/print/${d.batch.id}` }, icon("print"), "Print cards"),
      h("a", { class: "btn", href: `#/print/${d.batch.id}/unused` }, "Print unused only"),
      h("span", { class: "grow" }),
      isAdmin() ? h("button", { class: "danger", onclick: async () => {
        if (await confirmDlg("Delete unused vouchers", "Delete all UNUSED vouchers of this batch? Used ones are kept.", "Delete"))
          if (await act(api("DELETE", `/api/vouchers/${d.batch.id}`))) location.hash = "#/vouchers";
      } }, "Delete unused") : null),
    table([{ label: "Username", render: (c) => h("code", {}, c.username) }, { label: "Password", render: (c) => h("code", {}, c.password) },
      { label: "Status", render: (c) => c.status === "unused" ? badge("unused", "info") : c.status === "active" ? badge("active", "ok") : badge("expired") },
      { label: "First login", render: (c) => c.first_login ? String(c.first_login).slice(0, 16) : "—" },
      { label: "Expires", render: (c) => c.expires_at ? String(c.expires_at).slice(0, 16) : "—" },
      { label: "", render: (c) => h("a", { href: `#/users/${encodeURIComponent(c.username)}` }, "details") }], d.codes))));
}

// printable cards: no app shell, A4 grid, print button hidden when printing
ROUTES.print = async (id, which) => {
  const d = await api("GET", `/api/vouchers/${encodeURIComponent(id)}`);
  const st = d.settings, p = d.plan || {};
  const codes = which === "unused" ? d.codes.filter((c) => c.status === "unused") : d.codes;
  const facts = [p.validity_seconds && Number(p.validity_seconds) ? dur(p.validity_seconds) : null,
    Number(p.quota_bytes) ? bytes(p.quota_bytes) : "Unlimited data",
    Number(p.daily_seconds) ? `${dur(p.daily_seconds)}/day` : null, p.rate ? p.rate.split(" ")[0].split("/")[0] + "bps" : null].filter(Boolean);
  $app.className = "print-page";
  $app.replaceChildren(
    h("div", { class: "print-bar" }, h("a", { href: `#/vouchers/${id}` }, "← Back"), h("span", { class: "muted" }, `${codes.length} cards · batch #${id}`),
      h("button", { class: "primary", onclick: () => window.print() }, icon("print"), "Print")),
    h("div", { class: "cards" }, codes.map((c) => h("div", { class: "vcard" },
      h("div", { class: "vcard-head" }, h("b", {}, st.brand), h("span", { class: "vprice" }, money(d.batch.price, st.currency))),
      h("div", { class: "vplan" }, p.description || d.batch.plan),
      h("div", { class: "vfacts" }, facts.join(" · ")),
      d.batch && c.username === c.password
        ? h("div", { class: "vcode" }, h("span", {}, "PIN"), h("b", {}, c.username))
        : h("div", { class: "vcode two" }, h("span", {}, "User"), h("b", {}, c.username), h("span", {}, "Pass"), h("b", {}, c.password)),
      h("div", { class: "vfoot" }, `Wi-Fi: ${st.hotspot_ssid} · ${st.hotspot_url}`),
      st.card_footer ? h("div", { class: "vfoot muted" }, st.card_footer) : null))));
};

ROUTES.sales = async () => {
  const d = await api("GET", "/api/sales?days=30");
  const cur = d.currency;
  const total = d.per_day.reduce((a, r) => a + Number(r.amount), 0);
  const points = d.per_day.map((r) => ({ label: String(r.day).slice(5), down: Number(r.amount), up: 0 }));
  shell("Sales", h("div", { class: "stack" },
    h("div", { class: "grid g-tiles" }, tile("Last 30 days", money(total, cur)), tile("Sales", num(d.per_day.reduce((a, r) => a + Number(r.n), 0))),
      tile("Vouchers used", num(d.per_day.reduce((a, r) => a + Number(r.vouchers), 0))), tile("Renewals", num(d.per_day.reduce((a, r) => a + Number(r.renewals), 0)))),
    h("div", { class: "grid g-3" },
      card("Per day", cur, points.length ? moneyChart(points, cur) : h("div", { class: "empty" }, "No sales yet.")),
      card("Per plan", "30 days", table([{ label: "Plan", key: "plan" }, { label: "Sales", key: "n", num: true }, { label: "Amount", num: true, render: (r) => money(r.amount, cur) }], d.per_plan, "No sales yet."))),
    card("Recent", null, table([{ label: "When", render: (r) => String(r.at).slice(0, 16) },
      { label: "User", render: (r) => h("a", { href: `#/users/${encodeURIComponent(r.username)}` }, r.username) },
      { label: "Plan", key: "plan" }, { label: "Type", render: (r) => badge(r.kind, r.kind === "voucher" ? "info" : r.kind === "renew" ? "ok" : "") },
      { label: "Amount", num: true, render: (r) => money(r.amount, cur) }], d.recent, "No sales yet."))));
};

function moneyChart(points, cur) {   // reuse the column chart with currency labels
  const el = columnChart(points);
  el.querySelectorAll("text.axis").forEach((t) => { if (/B$/.test(t.textContent)) t.textContent = ""; });
  el.querySelectorAll("rect.bar-down title").forEach((t, i) => { t.textContent = `${points[i].label}: ${money(points[i].down, cur)}`; });
  return el;
}

// per-user top sites (Data usage tab)
async function userSites(holder, days) {
  const { users } = await api("GET", `/api/traffic/user-sites?days=${days}&top=50&per_user=6`);
  if (!users.length) return holder.replaceChildren(h("div", { class: "card" }, h("div", { class: "empty" }, "No data yet (traffic collector + router traffic-flow).")));
  holder.replaceChildren(h("div", { class: "grid g-2" }, users.map((u) => card(
    u.username ? h("a", { href: `#/users/${encodeURIComponent(u.username)}` }, u.who) : `${u.who} (no login)`,
    `${bytes(Number(u.down) + Number(u.up))} · ${u.site_count} sites`,
    hbars(u.sites.map((x) => ({ ...x })), "site"),
    table([{ label: "Site", key: "site" }, { label: "Download", num: true, render: (x) => bytes(x.down) }, { label: "Upload", num: true, render: (x) => bytes(x.up) }], u.sites)))));
}

// ------------------------------------------------------------------ CDN detective
ROUTES.cdn = async (initial) => {
  const input = h("input", { type: "search", placeholder: "scontent.xx.fbcdn.net  or  157.240.1.35", size: 40, value: initial || "" });
  const out = h("div", { class: "stack" });
  const conf = { high: "ok", medium: "info", low: "warn", none: "" };
  const check = async (q) => {
    q = (q || input.value).trim();
    if (!q) return;
    input.value = q;
    history.replaceState(null, "", `#/cdn/${encodeURIComponent(q)}`);
    out.replaceChildren(h("div", { class: "empty" }, "Investigating…"));
    let r;
    try { r = await api("GET", `/api/cdn?q=${encodeURIComponent(q)}`); }
    catch (e) { out.replaceChildren(h("div", { class: "note" }, e.message)); return; }
    const v = r.verdict, ev = r.evidence;
    out.replaceChildren(
      h("div", { class: "card" },
        h("div", { class: "muted" }, r.type === "ip" ? "IP address" : "Hostname", " ", h("code", {}, r.query)),
        h("div", { class: "tile" }, h("div", { class: "value" }, v.app || "unknown", v.site && v.site !== v.app ? h("span", { class: "muted" }, `  ${v.site}`) : null)),
        h("div", { class: "toolbar" }, badge(`confidence: ${v.confidence}`, conf[v.confidence]), v.category ? badge(v.category, "info") : null),
        h("p", {}, v.reason),
        h("dl", { class: "kv" },
          r.name_match ? [h("dt", {}, "Name"), h("dd", {}, `${r.name_match.matched} → ${r.name_match.app}${r.name_match.generic ? " (shared CDN)" : ""}`)] : null,
          r.ip_owner ? [h("dt", {}, "IP owner"), h("dd", {}, `${r.ip_owner.owner} ${r.ip_owner.network || ""}`)] : null,
          ev.answers.length ? [h("dt", {}, "Resolved to"), h("dd", {}, ev.answers.slice(0, 10).map((ip) => [h("a", { href: `#/cdn/${ip}` }, ip), " "]))] : null,
          ev.context.length ? [h("dt", {}, "Opened just before"), h("dd", {}, ev.context.map((c) => `${c.site} (${c.count}×)`).join(", "))] : null)),
      card("DNS evidence", "what devices asked for before getting this answer",
        table([{ label: "Asked for", key: "name" }, { label: "Site", key: "site" }, { label: "Times", key: "count", num: true },
          { label: "Last", key: "last" }, { label: "Devices", render: (o) => o.clients.join(", "), wrap: true }], ev.origins,
          "No DNS evidence in the log (needs the DNS logger; try again after users browse).")));
  };
  const unknown = h("div");
  const loadUnknown = async () => {
    const { rows } = await api("GET", "/api/cdn/unknown?days=1");
    unknown.replaceChildren(table([
      { label: "Destination", render: (r) => h("code", {}, r.site) }, { label: "Kind", render: (r) => badge(r.kind) },
      { label: "Owner", render: (r) => r.owner || "—" }, { label: "Data", num: true, render: (r) => bytes(Number(r.down) + Number(r.up)) },
      { label: "Devices", key: "devices", num: true },
      { label: "", render: (r) => h("button", { class: "small", onclick: () => check(r.site) }, "Investigate") }], rows,
      "Nothing unknown — all of today's traffic has a site name."));
  };
  const appsBox = h("div");
  const loadApps = async () => {
    const d = await api("GET", "/api/cdn/apps");
    const open = new Set([...appsBox.querySelectorAll("details[open]")].map((x) => x.dataset.app));
    appsBox.replaceChildren(
      h("div", { class: "toolbar" }, h("span", { class: "muted grow" },
        `${d.apps.length} apps · ${d.learned} domains learned automatically` + (d.updated ? ` · last run ${d.updated}` : "") + " · learns every hour from the DNS log"),
        isAdmin() ? h("button", { onclick: async () => { await act(api("POST", "/api/cdn/learn", {})); loadApps(); } }, "Learn now") : null),
      (() => {
        const found = d.apps.filter((a) => a.discovered);
        return found.length ? h("div", { class: "note" }, `${found.length} new app(s) discovered automatically — check the names (shown first, marked "new").`) : null;
      })(),
      h("div", { class: "applist" }, [...d.apps].sort((x, y) => (!!y.discovered - !!x.discovered)).map((a) => {
        const nLearned = a.domains.filter((x) => x.source === "learned").length;
        const known = d.apps.filter((x) => !x.discovered).map((x) => x.app);
        const actions = a.discovered && isAdmin() ? [
          h("button", { class: "small", onclick: () => {
            const f = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
              h("label", { class: "field" }, "App name", h("input", { name: "name", value: a.app, required: true, maxlength: 40 })),
              h("label", { class: "field" }, "Category", h("input", { name: "category", value: a.category || "", placeholder: "video, gaming, shopping…" })));
            dialog(`Rename ${a.site}`, f, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
              if (!f.reportValidity()) return false;
              if (!(await act(api("POST", "/api/cdn/app", { id: a.discovered, action: "rename", ...formValues(f) })))) return false;
              loadApps();
            } }]);
          } }, "Rename"),
          h("button", { class: "small", onclick: () => {
            const sel = h("select", { name: "target" }, known.map((k) => h("option", { value: k }, k)));
            dialog(`Merge ${a.app} into…`, h("label", { class: "field" }, "Known app", sel), [{ label: "Cancel" }, { label: "Merge", class: "primary", action: async () => {
              if (!(await act(api("POST", "/api/cdn/app", { id: a.discovered, action: "merge", target: sel.value })))) return false;
              loadApps();
            } }]);
          } }, "Merge into…"),
          h("button", { class: "small danger", onclick: async () => {
            if (await confirmDlg("Not an app", `Drop "${a.app}"? Its domains will not be discovered again.`, "Drop"))
              if (await act(api("POST", "/api/cdn/app", { id: a.discovered, action: "drop" }))) loadApps();
          } }, "Drop")] : null;
        const det = h("details", { dataset: { app: a.app }, open: open.has(a.app) || undefined },
          h("summary", {}, h("b", {}, a.app), " ", a.discovered ? badge(a.renamed ? "discovered" : "new", "warn") : null, " ",
            h("span", { class: "muted" }, `${a.domains.length} domains`), nLearned ? [" ", badge(`+${nLearned} learned`, "ok")] : null, " ", a.category ? badge(a.category) : null),
          a.discovered ? h("div", { class: "muted" }, `Found ${a.first_seen} · ${a.devices} devices · name from ${a.name_from === "website" ? `the website title "${a.title}"` : "the domain"}`) : null,
          h("div", { class: "toolbar" }, h("a", { class: "btn small", href: `/api/cdn/rsc?app=${encodeURIComponent(a.app)}` }, "⬇ RouterOS block script"), actions),
          table([{ label: "Domain", render: (x) => h("code", {}, x.domain) },
            { label: "Source", render: (x) => x.source === "learned" ? badge("learned", "ok") : x.source === "local" ? badge("local", "info") : x.source === "discovered" ? badge("discovered", "warn") : badge("built-in") },
            { label: "Evidence", render: (x) => x.source === "learned" ? `${x.why} · ${x.devices} devices · since ${x.first_seen}` : "—", wrap: true },
            { label: "", render: (x) => x.source === "learned" && isAdmin() ? h("button", { class: "small danger", onclick: async () => {
                if (await confirmDlg("Reject learned domain", `${x.domain} is not ${a.app}? It will be removed and never learned again.`, "Reject"))
                  if (await act(api("POST", "/api/cdn/reject", { domain: x.domain }))) loadApps();
              } }, "Reject") : null }], a.domains));
        return det;
      })));
  };
  shell("CDN detective", h("div", { class: "stack" },
    card(null, null, h("form", { class: "toolbar", onsubmit: (e) => { e.preventDefault(); check(); } }, input, h("button", { class: "primary", type: "submit" }, icon("search"), "Investigate")),
      h("div", { class: "muted" }, "Which app is behind a CDN name or IP? Uses the name catalog (YouTube, Facebook, TikTok, Netflix…), the DNS logger's CNAME evidence, IP owner lists and what the device opened just before.")),
    out,
    card("Heavy traffic without a site name", "today — click Investigate", unknown),
    card("App domain lists", "built-in + learned automatically", appsBox)));
  loadUnknown().catch(() => unknown.replaceChildren(h("div", { class: "empty" }, "No traffic data.")));
  loadApps().catch((e) => appsBox.replaceChildren(h("div", { class: "note" }, e.message)));
  if (initial) await check(initial);
};

// ------------------------------------------------------------------ blocking: policies (what is blocked, for whom) + router sync
const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
function timeSpec(t) {             // {from, to, days} -> RouterOS time= value
  const f = Number(t.from), e = Number(t.to);    // e.g. 22 -> 6 crosses midnight: the server splits it in two
  return `${f ? f + "h" : "0s"}-${e >= 24 || e === 0 ? "23h59m59s" : e + "h"},${t.days.join(",")}`;
}
function parseTime(s) {            // "9h-17h,mon,tue" | "0s-6h,..." | "8h-23h59m59s,..." -> {from, to, days}
  const m = /^(\d+)[hs]-(\d+)h(59m59s)?,([a-z,]+)$/.exec(s || "");
  return m ? { from: Number(m[1]), to: m[3] ? 24 : Number(m[2]), days: m[4].split(",") } : null;
}
function ruleLabel(r) {
  const t = r.time ? ` (${r.time.replace(/,.*$/, "").replace("0s", "0h").replace("23h59m59s", "24h")})` : "";
  switch (r.kind) {
    case "block": return badge(`${r.value === "keywords" ? "adult words" : r.value}${t}`, "bad");
    case "block-app": return badge(`app: ${r.value}${t}`, "bad");
    case "block-vpn": return badge(`VPN blocked${t}`, "bad");
    case "block-site": return badge(`site: ${r.value}${t}`, "bad");
    case "block-word": return badge(`word: ${r.value.replace(/^\^/, "")}${r.value.startsWith("^") ? " (start)" : ""}${t}`, "bad");
    case "allow-site": return badge(`always open: ${r.value}`, "ok");
    case "allow-web": return badge(`always open: ${r.value} (+ what it needs)`, "ok");
    case "allow-app": return badge(`app always open: ${r.value}`, "ok");
    case "allow-only": return badge(`ONLY ${r.value}`, "warn");
    case "block-all": return badge(`no internet${t}`, "bad");
    case "dns": return badge(`DNS: ${r.value}`, "info");
    case "strict-ech": return badge("ECH blocked", "info");
    default: return badge(`${r.kind} ${r.value}`);
  }
}

const OFFICE_TIME = "9h-17h,mon,tue,wed,thu,fri,sat";
function timePicker(spec, onChange) {      // one "when" per rule: always / office hours / custom / as in the file
  const p = parseTime(spec);
  const raw = spec && spec !== OFFICE_TIME && !p;
  const sel = h("select", { class: "tp-sel" },
    h("option", { value: "", selected: !spec }, "Always"),
    h("option", { value: OFFICE_TIME, selected: spec === OFFICE_TIME }, "Office hours (9–17, Mon–Sat)"),
    raw ? h("option", { value: "raw", selected: true }, `As set: ${spec}`) : null,
    h("option", { value: "custom", selected: !!p && spec !== OFFICE_TIME }, "Custom…"));
  const t = p || { from: 9, to: 17, days: DAY_NAMES.slice(0, 5) };
  let touched = false;                       // untouched: give back the file's own text (same order of days …)
  const hours = (v) => Array.from({ length: 25 }, (_, i) => h("option", { value: i, selected: i === v }, `${String(i).padStart(2, "0")}:00`));
  const from = h("select", {}, hours(t.from)), to = h("select", {}, hours(t.to));
  const days = DAY_NAMES.map((d) => { const cb = h("input", { type: "checkbox", checked: t.days.includes(d) }); cb.addEventListener("change", () => { touched = true; onChange(); }); return h("label", { class: "chip small" }, cb, d); });
  const custom = h("div", { class: "tp-custom" }, from, "→", to, h("div", { class: "chips" }, days));
  const el = h("div", { class: "tp" }, sel, custom);
  const sync = () => { custom.hidden = sel.value !== "custom"; };
  [sel, from, to].forEach((x) => x.addEventListener("change", () => { touched = true; sync(); onChange(); }));
  sync();
  el.value = () => {
    if (sel.value === "raw" || (!touched && spec && sel.value === "custom")) return spec;
    if (sel.value !== "custom") return sel.value;
    const ds = days.filter((d) => d.querySelector("input").checked).map((d) => d.textContent);
    return timeSpec({ from: from.value, to: to.value, days: ds.length ? ds : DAY_NAMES });
  };
  return el;
}

function policyEditor(meta, pol) {
  const rules = pol ? pol.rules : [];
  const tm = (spec) => (spec ? ` time=${spec}` : "");
  // what the editor shows; every other line of the file is kept as it is ("other rules")
  const used = new Set(), first = (pred) => { const i = rules.findIndex((r, n) => !used.has(n) && pred(r)); if (i >= 0) used.add(i); return i >= 0 ? rules[i] : null; };
  const name = h("input", { name: "name", required: true, pattern: "[a-z0-9\\-]{1,40}", placeholder: "e.g. kids", value: pol?.name || "", disabled: !!pol });
  const desc = h("input", { placeholder: "e.g. Kids: no TikTok, no YouTube videos", value: pol?.description || "" });
  const onlyRules = []; let o;
  while ((o = first((r) => r.kind === "allow-only"))) onlyRules.push(o);
  const onlyRule = onlyRules[0] || null;
  const noneRule = onlyRule ? null : first((r) => r.kind === "block-all" && !r.time);
  const mode = onlyRule ? "only" : noneRule ? "none" : "block";
  const modeSel = h("select", {}, [["block", "Block what I choose (the rest works)"], ["only", "ONLY the apps I choose (everything else blocked)"], ["none", "No internet at all"]]
    .map(([v, l]) => h("option", { value: v, selected: v === mode }, l)));
  const onlyChosen = new Set(onlyRules.map((r) => r.value));
  if (!onlyChosen.size) onlyChosen.add("whatsapp");
  const onlyBoxes = h("div", { class: "chips" }, (meta.allow_only || []).map((a) => {
    const cb = h("input", { type: "checkbox", checked: onlyChosen.has(a) });
    const chip = h("label", { class: "chip" + (onlyChosen.has(a) ? " on" : "") }, cb, a);
    cb.addEventListener("change", () => { cb.checked ? onlyChosen.add(a) : onlyChosen.delete(a); chip.classList.toggle("on", cb.checked); preview(); });
    return chip;
  }));
  const row = (title, help, rule) => {        // a tick + its own time
    const cb = h("input", { type: "checkbox", checked: !!rule });
    const label = h("label", { class: "check" + (rule ? " on" : "") }, cb, h("div", {}, h("b", {}, title), help ? h("span", {}, help) : null));
    const tp = timePicker(rule?.time || "", () => preview());
    const el = h("div", { class: "rule-row" }, label, tp);
    const sync = () => { label.classList.toggle("on", cb.checked); tp.hidden = !cb.checked; };
    cb.addEventListener("change", () => { sync(); preview(); });
    sync();
    el.cb = cb; el.tp = tp; return el;
  };
  const cats = meta.categories.map((c) => Object.assign(row(c.name === "keywords" ? "Adult words" : c.name, c.description, first((r) => r.kind === "block" && r.value === c.name)), { value: c.name }));
  const vpn = row("Block VPN", "VPN apps and websites, the VPN servers seen on your network (list grows by itself), OpenVPN / WireGuard / IPsec / PPTP / Tor. Every try is logged → VPN watch.", first((r) => r.kind === "block-vpn"));
  const offRule = mode === "block" ? first((r) => r.kind === "block-all") : null;
  const off = row("Internet off completely", "At the time you choose (e.g. night 22:00 → 06:00). \"Always\" = no internet at all.", offRule);
  // single apps: each with its own time
  const appRows = new Map();
  const appSearch = h("input", { type: "search", placeholder: "Search apps: pubg, tiktok, snapchat, netflix …" });
  const appBox = h("div", { class: "applist-scroll" });
  const chosenBox = h("div", { class: "stack tight" });
  const addApp = (app, spec) => {
    if (appRows.has(app)) return;
    const tp = timePicker(spec || "", () => preview());
    const el = h("div", { class: "rule-row item" }, badge(app, "bad"), tp,
      h("button", { type: "button", class: "chip-x", title: "remove", onclick: () => { appRows.delete(app); drawApps(); drawChosen(); preview(); } }, "×"));
    appRows.set(app, { el, tp });
  };
  rules.forEach((r, n) => { if (!used.has(n) && r.kind === "block-app" && !appRows.has(r.value)) { used.add(n); addApp(r.value, r.time); } });
  const drawApps = () => {
    const qy = appSearch.value.trim().toLowerCase();
    const groups = new Map();
    meta.apps.filter((a) => !qy || a.app.toLowerCase().includes(qy) || a.category.includes(qy)).forEach((a) => {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category).push(a);
    });
    appBox.replaceChildren(...[...groups].map(([cat, list]) => [h("h4", {}, cat), h("div", { class: "chips" }, list.map((a) => {
      const on = appRows.has(a.app);
      const cb = h("input", { type: "checkbox", checked: on });
      const chip = h("label", { class: "chip" + (on ? " on" : "") }, cb, a.app, a.discovered ? h("small", {}, "new") : null);
      cb.addEventListener("change", () => { cb.checked ? addApp(a.app, "") : appRows.delete(a.app); chip.classList.toggle("on", cb.checked); drawChosen(); preview(); });
      return chip;
    }))]).flat());
    if (!appBox.children.length) appBox.append(h("div", { class: "muted" }, "No app with that name."));
  };
  const drawChosen = () => chosenBox.replaceChildren(...(appRows.size ? [...appRows.values()].map((x) => x.el) : [h("span", { class: "muted" }, "No single apps chosen.")]));
  appSearch.addEventListener("input", drawApps);
  // single websites: each with its own time
  const siteRows = [];
  const siteBox = h("div", { class: "stack tight" });
  const addSite = (site, spec) => {
    const inp = h("input", { value: site || "", placeholder: "example-bet.com", spellcheck: "false", class: "grow" });
    const tp = timePicker(spec || "", () => preview());
    const r = { inp, tp };
    r.el = h("div", { class: "rule-row item" }, inp, tp, h("button", { type: "button", class: "chip-x", title: "remove", onclick: () => { siteRows.splice(siteRows.indexOf(r), 1); r.el.remove(); preview(); } }, "×"));
    inp.addEventListener("input", preview);
    siteRows.push(r); siteBox.append(r.el);
    return inp;
  };
  rules.forEach((r, n) => { if (!used.has(n) && r.kind === "block-site") { used.add(n); addSite(r.value, r.time); } });
  const addSiteBtn = h("button", { type: "button", class: "small", onclick: () => { addSite("", "").focus(); } }, icon("plus"), "Add a site");
  // single words in site names (block-word): anywhere, or only at the start of a name part
  const IMPORTANT = ["google.com", "googlevideo.com", "gstatic.com", "googleapis.com", "youtube.com", "ytimg.com", "gmail.com", "android.com",
    "facebook.com", "fbcdn.net", "whatsapp.net", "whatsapp.com", "instagram.com", "cdninstagram.com", "microsoft.com", "windowsupdate.com",
    "live.com", "office.com", "apple.com", "icloud.com", "cloudflare.com", "akamaized.net", "amazonaws.com", "cloudfront.net", "netflix.com",
    "nflxvideo.net", "zoom.us", "tiktokcdn.com", "linkedin.com", "x.com", "telegram.org", "wikipedia.org", "bing.com", "yahoo.com",
    "jazz.com.pk", "easypaisa.com.pk", "daraz.pk", "hbl.com", "mozilla.org"];
  const wordHits = (w, start) => IMPORTANT.filter((d) => start ? d.startsWith(w) || d.includes("." + w) || d.includes("-" + w) : d.includes(w));
  const wordRows = [];
  const wordBox = h("div", { class: "stack tight" });
  const addWord = (value, spec) => {
    const start = (value || "").startsWith("^");
    const inp = h("input", { value: (value || "").replace(/^\^/, ""), placeholder: "casino", spellcheck: "false", class: "grow", "aria-label": "word" });
    const where = h("select", { "aria-label": "where in the name" }, [["any", "anywhere in the name"], ["start", "start of a name part"]].map(([v, l]) => h("option", { value: v, selected: (v === "start") === start }, l)));
    const tp = timePicker(spec || "", () => preview());
    const warn = h("div", { class: "muted small", hidden: true });
    const r = { inp, where, tp };
    const check = () => {
      const w = inp.value.trim().toLowerCase(), st = where.value === "start";
      const bad = w && !(st ? /^[a-z0-9]{2,32}$/ : /^[a-z0-9]{3,32}$/).test(w);
      const hits = !bad && w ? wordHits(w, st) : [];
      warn.hidden = !bad && !hits.length;
      warn.className = "small " + (bad || hits.length ? "word-warn" : "muted");
      warn.textContent = bad ? (st ? "2–32 letters or digits" : "3–32 letters or digits (shorter: choose 'start of a name part')")
        : hits.length ? `Careful: this also blocks ${hits.slice(0, 4).join(", ")}${hits.length > 4 ? " …" : ""} — try 'start of a name part' or a longer word` : "";
    };
    r.el = h("div", { class: "stack tight" }, h("div", { class: "rule-row item" }, inp, where, tp,
      h("button", { type: "button", class: "chip-x", title: "remove", onclick: () => { wordRows.splice(wordRows.indexOf(r), 1); r.el.remove(); preview(); } }, "×")), warn);
    inp.addEventListener("input", () => { check(); preview(); }); where.addEventListener("change", () => { check(); preview(); });
    check(); wordRows.push(r); wordBox.append(r.el);
    return inp;
  };
  rules.forEach((r, n) => { if (!used.has(n) && r.kind === "block-word") { used.add(n); addWord(r.value, r.time); } });
  const addWordBtn = h("button", { type: "button", class: "small", onclick: () => { addWord("", "").focus(); } }, icon("plus"), "Add a word");
  const cleanSite = (x) => x.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#:].*$/, "").replace(/^\*\./, "").replace(/^www\./, "");
  const okSite = (x) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(x);
  const dnsRule = first((r) => r.kind === "dns");
  const dnsSel = h("select", {}, [["router", "Router DNS (normal)"], ["family", "Cloudflare Family (no adult)"], ["adguard-family", "AdGuard Family"], ["cleanbrowsing-family", "CleanBrowsing Family"], ["cleanbrowsing-adult", "CleanBrowsing Adult filter"]]
    .map(([v, l]) => h("option", { value: v, selected: (dnsRule?.value || "router") === v }, l)));
  const echRule = first((r) => r.kind === "strict-ech");
  const echCb = h("input", { type: "checkbox", checked: !!echRule });
  const ech = h("label", { class: "check" + (echRule ? " on" : "") }, echCb, h("div", {}, h("b", {}, "Block hidden site names (ECH)"), h("span", {}, "Stops browsers from hiding the site name; a few Cloudflare sites may not open.")));
  echCb.addEventListener("change", () => { ech.classList.toggle("on", echCb.checked); preview(); });
  const allowList = [];
  const plainSites = new Set();       // old "allow-site" lines stay as they are; new sites are "allow-web" (automatic)
  rules.forEach((r, n) => { if (!used.has(n) && (r.kind === "allow-site" || r.kind === "allow-web")) { used.add(n); const v = r.kind === "allow-site" ? r.value : r.value.replace(/^www\./, ""); if (r.kind === "allow-site") plainSites.add(v); allowList.push(v); } });
  const allowApps = new Set();
  rules.forEach((r, n) => { if (!used.has(n) && r.kind === "allow-app") { used.add(n); allowApps.add(r.value); } });
  const allowAppIn = h("input", { type: "search", placeholder: "Add an app: instagram, zoom, teams …", list: "pe-apps" });
  const allowAppBox = h("div", { class: "chips" });
  const drawAllowApps = () => allowAppBox.replaceChildren(...[...allowApps].map((a) => h("span", { class: "chip on" }, a,
    h("button", { type: "button", class: "chip-x", title: "remove", onclick: () => { allowApps.delete(a); drawAllowApps(); preview(); } }, "×"))));
  allowAppIn.addEventListener("change", () => {
    const v = allowAppIn.value.trim(), hit = meta.apps.find((a) => a.app.toLowerCase() === v.toLowerCase());
    if (hit) { allowApps.add(hit.app); allowAppIn.value = ""; drawAllowApps(); preview(); } else if (v) toast("Not in the app catalog — use App profiles → Learn an app", true);
  });
  const allowSites = h("textarea", { rows: 3, placeholder: "linkedin.com\nschool.edu.pk", spellcheck: "false" }, allowList.join("\n"));
  allowSites.addEventListener("input", () => preview());
  // anything the editor does not show (a second line for the same category, hand-written rules …) is kept as it is
  const extras = rules.map((r, n) => (used.has(n) ? null : `${r.kind}${r.value ? " " + r.value : ""}${tm(r.time)}`)).filter(Boolean);
  const extraBox = extras.length ? h("div", { class: "note" }, h("b", {}, "Other rules (kept as they are): "), h("code", {}, extras.join(" · "))) : null;
  const out = h("pre", { class: "code-box" });
  const blockSection = h("div", { class: "stack" },
    h("div", { class: "pe-section stack" }, h("h3", {}, "What to block"),
      h("div", { class: "muted small" }, "Every rule has its own time: e.g. social media only in office hours, games always, internet off at night."),
      h("label", { class: "field" }, "Categories", h("span", { class: "help" }, "Whole groups of sites and apps. Lists are kept up to date on the server."), h("div", { class: "rule-list" }, cats)),
      vpn, off),
    h("div", { class: "pe-section stack" }, h("h3", {}, "Single apps and websites"),
      h("label", { class: "field" }, "Single apps", h("span", { class: "help" }, "Every known domain of the app is blocked, the ones learned on your network too. \"new\" = discovered automatically."), appSearch, appBox, chosenBox),
      h("div", { class: "field" }, h("span", {}, "Single websites to block"), h("span", { class: "help" }, "like example.com — its subdomains too"), siteBox, h("div", {}, addSiteBtn)),
      h("div", { class: "field" }, h("span", {}, "Words in site names"), h("span", { class: "help" }, "one word blocks every site whose NAME has it: casino → bestcasino.net, casino-x.org. 'Start of a name part': bet → bet365.com, best-bets.org but not alphabet.com. Only the site name is seen, not the page text (HTTPS)."), wordBox, h("div", {}, addWordBtn))),
    h("details", { class: "pe-section", open: !!(dnsRule || echRule || extraBox) }, h("summary", {}, "Advanced: DNS, hidden site names, other rules"),
      h("div", { class: "stack" }, h("label", { class: "field" }, "DNS for these users", dnsSel), ech, extraBox)));
  function text() {
    const lines = [`# ${desc.value.trim() || name.value || "policy"}`];
    if (modeSel.value === "only") [...onlyChosen].sort().forEach((a) => lines.push(`allow-only ${a}`));
    else if (modeSel.value === "none") lines.push("block-all");
    else {
      cats.filter((c) => c.cb.checked).forEach((c) => lines.push(`block ${c.value}${tm(c.tp.value())}`));
      [...appRows].forEach(([a, x]) => lines.push(`block-app ${a}${tm(x.tp.value())}`));
      if (vpn.cb.checked) lines.push(`block-vpn${tm(vpn.tp.value())}`);
      const seen = new Set();
      siteRows.forEach((r) => { const d = cleanSite(r.inp.value); if (okSite(d) && !seen.has(d)) { seen.add(d); lines.push(`block-site ${d}${tm(r.tp.value())}`); } });
      wordRows.forEach((r) => { const w = r.inp.value.trim().toLowerCase(), st = r.where.value === "start";
        if ((st ? /^[a-z0-9]{2,32}$/ : /^[a-z0-9]{3,32}$/).test(w) && !seen.has("w:" + (st ? "^" : "") + w)) { seen.add("w:" + (st ? "^" : "") + w); lines.push(`block-word ${st ? "^" : ""}${w}${tm(r.tp.value())}`); } });
      if (off.cb.checked) lines.push(`block-all${tm(off.tp.value())}`);
      if (dnsSel.value !== "router") lines.push(`dns ${dnsSel.value}`);
      if (echCb.checked) lines.push("strict-ech");
      lines.push(...extras);
    }
    [...new Set(allowSites.value.split(/[\s,]+/).map(cleanSite).filter(okSite))].forEach((d) => lines.push(`${plainSites.has(d) ? "allow-site" : "allow-web"} ${d}`));
    [...allowApps].forEach((a) => lines.push(`allow-app ${a}`));
    return lines.join("\n") + "\n";
  }
  function preview() {
    blockSection.hidden = modeSel.value !== "block";
    out.textContent = text();
  }
  [modeSel, dnsSel].forEach((el) => el.addEventListener("change", preview));
  [desc, name].forEach((el) => el.addEventListener("input", preview));
  drawApps(); drawChosen(); drawAllowApps(); preview();
  const onlyNote = h("div", { class: "stack", hidden: modeSel.value !== "only" },
    h("div", { class: "field" }, h("b", {}, "Apps that work"), h("div", { class: "help" }, "Tick one or more. Everything else is blocked. Make or change an app: Blocking → App profiles."), onlyBoxes),
    h("div", { class: "muted small" }, "whatsapp: chat, calls, photos and status (Facebook / Instagram stay blocked). hikconnect: Hik-Connect cloud + an NVR / DVR in this network (add one at another place in App profiles)."));
  const form = h("form", { class: "form policy-editor", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "form cols" }, h("label", { class: "field" }, "Policy name", h("span", { class: "help" }, "small letters, digits, -"), name),
      h("label", { class: "field" }, "Description", h("span", { class: "help" }, "shown when you pick a policy"), desc)),
    h("label", { class: "field" }, "What should these users get?", modeSel),
    onlyNote,
    blockSection,
    h("div", { class: "pe-section" }, h("h3", {}, "Always open (exceptions)")),
    h("label", { class: "field" }, "Websites always open", h("span", { class: "help" }, `one per line, like example.com. The server reads the whole site (sitemap, up to 150 pages, JavaScript files) and opens what it needs too (fonts, CDNs, image hosts — no ads / trackers), reads it again every day and learns more while it is used (Blocking → Allowed websites & apps). Also with "no internet" or "only apps".`), allowSites),
    h("div", { class: "field" }, h("b", {}, "Apps always open"), h("div", { class: "help" }, "Every server of the app from the app catalog (kept up to date), plus helpers learned while it is used."), allowAppIn, allowAppBox,
      h("datalist", { id: "pe-apps" }, meta.apps.map((a) => h("option", { value: a.app })))),
    h("details", { class: "pe-section" }, h("summary", {}, "Policy file (what the server stores)"), out));
  modeSel.addEventListener("change", () => { onlyNote.hidden = modeSel.value !== "only"; });
  return { form, text, name: () => name.value.trim() };
}

ROUTES.blocking = async (tab = "overview", ...rest) => {
  if (tab === "logs") return blockingLogs();
  if (tab === "parental") return parentalPage();
  if (tab === "why") return whyBlocked(...rest);
  if (tab === "requests") return unblockRequests();
  if (tab === "apps") return appProfiles();
  if (tab === "web") return allowedWebsites();
  if (tab === "policies") return blockingPolicies(rest[0], rest[1]);
  if (tab === "guide") return blockingGuide();
  return blockingOverview();
};

// the policy editor in a dialog; saved -> page drawn again
function openPolicyEditor(meta, pol) {
  const ed = policyEditor(meta, pol);
  dialog(pol ? `Edit policy · ${pol.name}` : "New blocking policy", ed.form, [{ label: "Cancel" }, { label: "Save policy", class: "primary", action: async () => {
    if (!ed.form.reportValidity()) return false;
    const res = await act(api("POST", "/api/policies", { name: ed.name(), text: ed.text() }));
    if (!res) return false;
    blSummary = null; route();
  } }]);
}

// give a policy to a user or a whole group, in one dialog
function givePolicyDialog(meta, users, preset) {
  let who = "user";
  const seg = h("div", { class: "seg" });
  const userIn = h("input", { list: "bl-users", placeholder: "User name", autocomplete: "off", name: "user" });
  const groupSel = h("select", { name: "group" }, h("option", { value: "" }, "— choose a group —"));
  api("GET", "/api/groups").then((g) => g.groups.forEach((x) => groupSel.append(h("option", { value: x.name }, x.name)))).catch(() => {});
  const polSel = h("select", { id: "bl-pol", name: "policy" }, meta.policies.map((p) => h("option", { value: p.name, selected: p.name === (preset && preset.policy || preset) }, `${p.name} — ${p.description}`)));
  const userField = h("label", { class: "field" }, "User", userIn, h("datalist", { id: "bl-users" }, users.map((u) => h("option", { value: u.username }))));
  const groupField = h("label", { class: "field", hidden: true }, "Group", groupSel, h("span", { class: "help" }, "every user of the group gets it, unless the user has an own policy"));
  const netIn = h("input", { name: "target", placeholder: "192.168.88.0/24  or  192.168.88.100-192.168.88.150  or  192.168.88.23", autocomplete: "off" });
  const netNote = h("input", { name: "comment", placeholder: "e.g. Office LAN, Guest Wi-Fi, Ahmed's PC", maxlength: 100 });
  const netField = h("div", { hidden: true, class: "stack" }, h("label", { class: "field" }, "Network, IP range or one IP", netIn,
    h("span", { class: "help" }, "No login needed: every device with such an address gets the policy (the whole LAN, a VLAN, a range, one PC). A logged-in user's own policy comes on top.")),
    h("label", { class: "field" }, "Name (optional)", netNote));
  const note = h("div", { class: "muted small" });
  const draw = () => { seg.replaceChildren(...[["user", "One user"], ["group", "A whole group"], ["net", "Network / IP"]].map(([k, l]) => h("button", { type: "button", class: k === who ? "on" : "", onclick: () => { who = k; draw(); } }, l)));
    userField.hidden = who !== "user"; groupField.hidden = who !== "group"; netField.hidden = who !== "net";
    note.textContent = who === "net" ? "Routers get it within 15 minutes." : "A user who is online is disconnected once and gets the policy at the next login."; };
  if (preset && preset.who) who = preset.who;
  draw();
  const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() }, seg, userField, groupField, netField, h("label", { class: "field" }, "Policy", polSel), note);
  dialog("Give a policy", form, [{ label: "Cancel" }, { label: "Apply", class: "primary", action: async () => {
    if (who === "net") {
      if (!netIn.value.trim()) { toast("Type a network, range or IP", true); return false; }
      if (!await act(api("POST", "/api/policies/net", { policy: polSel.value, target: netIn.value.trim(), comment: netNote.value.trim() }))) return false;
    } else if (who === "user") {
      if (!userIn.value.trim()) { toast("Type a user name", true); return false; }
      if (!await act(api("POST", `/api/users/${encodeURIComponent(userIn.value.trim())}/policy`, { policy: polSel.value }))) return false;
    } else {
      if (!groupSel.value) { toast("Choose a group", true); return false; }
      if (!await act(api("POST", "/api/groups", { name: groupSel.value, policy: polSel.value, edit: true }))) return false;
    }
    blSummary = null; route();
  } }]);
}

const routerSyncCard = (r) => {
  const ipIn = h("input", { placeholder: "server IP as the router sees it", value: /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : "" });
  return card("Router auto-sync", r.version ? `built ${r.built} · ${num(r.vpn_servers)} VPN servers` : "not built yet",
    h("div", { class: "muted small" }, "Import the script on the router once (Files → upload → Terminal: /import mikrotiklover-autosync.rsc). After that every change here reaches the router by itself within 15 minutes."),
    isAdmin() ? h("div", { class: "toolbar" }, ipIn,
      h("button", { onclick: () => { if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipIn.value.trim())) return toast("Type the server's IP address", true); location.href = `/api/router/autosync.rsc?ip=${encodeURIComponent(ipIn.value.trim())}`; } }, "⬇ Download router script"),
      h("button", { onclick: async () => { await act(api("POST", "/api/router/build")); route(); } }, icon("refresh"), "Rebuild now")) : null,
    h("details", { class: "small" }, h("summary", { class: "muted" }, "Technical details"), h("pre", { class: "code-box" }, `server ${r.url}\nversion ${r.version || "—"}\nbuilt ${r.built || "—"}`)));
};

// Windows Update for everyone: allowed / off in office hours / off (per policy: category windows-update)
function winUpdateCard(sum) {
  const mode = sum.winupdate || "on";
  const MODES = [["on", "Allowed"], ["office", "Off in office hours"], ["off", "Off always"]];
  const seg = h("div", { class: "seg wu-seg" }, MODES.map(([k, l]) => h("button", { type: "button", class: k === mode ? "on" : "", disabled: !isAdmin(),
    onclick: async () => { if (k === mode) return; if (await act(api("POST", "/api/winupdate", { mode: k }))) { blSummary = null; route(); } } }, l)));
  const text = { on: "Windows PCs update as usual.", office: "No Windows updates 9:00–17:00 Mon–Sat (internet stays fast in office hours); updates come in the evening and on Sunday.",
    off: "No Windows updates for anyone (users in web-filter-exempt keep them). Turn it on now and then — PCs without updates get unsafe." }[mode];
  return card("Windows Update", `${num(sum.windows_devices || 0)} Windows PC(s) seen this week`,
    h("div", { class: "toolbar" }, seg, badge(mode === "on" ? "updates allowed" : mode === "office" ? "off 9–17" : "updates OFF", mode === "on" ? "ok" : "warn")),
    h("div", { class: "muted small" }, text, " Only the update service is stopped — Office, Outlook, Teams, OneDrive and the Store keep working. For some users only: Policy → Edit → Categories → windows-update (with its own time)."));
}

async function blockingOverview() {
  const [sum, logs] = await Promise.all([blockingSummary(true), api("GET", "/api/blocked?days=1&n=300").catch(() => ({ summary: [], rows: [] }))]);
  const attn = [];
  const item = (n, kind, title, sub, href) => attn.push(h("a", { href }, h("span", { class: "n " + kind }, String(n)), h("span", { class: "t" }, title, h("small", {}, sub))));
  if (sum.requests) item(sum.requests, "", `${sum.requests === 1 ? "A user asks" : "Users ask"} to open a blocked site`, "Allow for 1 hour, today, always — or refuse", "#/blocking/requests");
  if (sum.suggestions) item(sum.suggestions, "info", "Allowed websites / apps may need more", "Names or connections seen right after them — Allow or Ignore", "#/blocking/web");
  if (sum.reading) item(sum.reading, "info", "Website being read", "The server reads the whole site in the background", "#/blocking/web");
  if (!sum.router.version) item("!", "", "Router rules not built yet", "Press Rebuild now below, then import the script on the router", "#/blocking/overview");
  const topBlocked = (logs.summary || []).slice(0, 6);
  const pauseBtn = (on) => h("button", { class: on ? "small danger" : "primary", onclick: async () => {
    if (on && !(await confirmDlg("Pause all blocking", "Nothing is blocked anywhere until you resume (the routers drop every policy rule within 15 minutes). Use it when blocking causes a problem.", "Pause"))) return;
    if (await act(api("POST", "/api/blocking/pause", { on }))) { blSummary = null; route(); } } }, on ? "Pause all blocking" : "Resume blocking");
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("overview"),
    sum.paused ? h("div", { class: "card health-hero fail" }, h("div", { class: "hh-mark" }, "!"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, "All blocking is PAUSED"), h("div", { class: "muted" }, "Nothing is blocked for anyone. Resume when the problem is solved.")),
      isAdmin() ? pauseBtn(false) : null) : null,
    h("div", { class: "grid g-tiles" },
      tile("Policies", num(sum.policies), sum.off ? `${num(sum.off)} turned off` : "ready-made + your own"),
      tile("Users with a policy", num(sum.users), `${num(sum.groups)} group(s), ${num(sum.nets || 0)} network(s)`),
      tile("Requests waiting", num(sum.requests), sum.exceptions ? `${num(sum.exceptions)} site(s) open for a while` : "from the block page"),
      tile("Blocked today", num((logs.rows || []).length), (logs.rows || []).length >= 300 ? "300 or more" : "tries the router logged")),
    h("div", { class: "grid g-2" },
      card("Needs your attention", null, attn.length ? h("div", { class: "attn" }, attn)
        : h("div", { class: "attn" }, h("div", { class: "ok-line" }, h("span", { class: "n ok" }, "✓"), h("span", { class: "t" }, "Nothing waiting", h("small", {}, "No requests, no suggestions to answer."))))),
      card("Quick actions", null, h("div", { class: "quick" },
        isAdmin() ? h("a", { href: "#/blocking/policies/new" }, icon("plus"), h("span", {}, "New policy", h("small", {}, "block categories, apps, sites"))) : null,
        isAdmin() ? h("a", { href: "#/blocking/policies/give" }, icon("users"), h("span", {}, "Give a policy", h("small", {}, "to a user or a group"))) : null,
        h("a", { href: "#/blocking/parental" }, icon("clock"), h("span", {}, "Parental controls", h("small", {}, "homework, bedtime, games"))),
        h("a", { href: "#/blocking/why" }, icon("search"), h("span", {}, "Why is it blocked?", h("small", {}, "a site + a user, or a block code"))),
        h("a", { href: "#/blocking/guide" }, icon("info"), h("span", {}, "Guide", h("small", {}, "which policy does what, how to apply"))),
        h("a", { href: "#/golive" }, icon("flag"), h("span", {}, "Setup steps", h("small", {}, "turn things on one at a time")))),
        isAdmin() && !sum.paused ? h("div", { class: "toolbar quick-pause" }, pauseBtn(true), h("span", { class: "muted small" }, "emergency: no blocking at all")) : null)),
    winUpdateCard(sum),
    card("Blocked today", topBlocked.length ? "most often" : null, table([{ label: "User", render: (r) => r.user !== "-" ? h("a", { href: `#/users/${encodeURIComponent(r.user)}` }, r.user) : h("span", { class: "muted" }, "(no login)") },
      { label: "Policy", render: (r) => badge(r.policy, "info") }, { label: "Blocked by", render: (r) => badge(r.reason, "bad") }, { label: "Times", key: "count", num: true }],
      topBlocked, "Nothing blocked today."), topBlocked.length ? h("div", { class: "toolbar" }, h("a", { class: "btn small", href: "#/blocking/logs" }, "All activity")) : null),
    routerSyncCard(sum.router),
    hint("How blocking works",
      h("ol", {},
        h("li", {}, h("b", {}, "Policy"), " — what is blocked: categories, single apps, sites, VPN, internet off, or only some apps. Each rule can have its own time."),
        h("li", {}, h("b", {}, "Give it"), " to a user or a group. The user gets it at the next login."),
        h("li", {}, h("b", {}, "Router auto-sync"), " — the router gets every change by itself."),
        h("li", {}, h("b", {}, "Users see a block page"), " with a code and can ask to open the site (Requests).")))));
}

// ------------------------------------------------------------------ Blocking guide (Roman Urdu): every policy in words, how to apply
const DAY_UR = { mon: "Pir", tue: "Mangal", wed: "Budh", thu: "Jumeraat", fri: "Jumma", sat: "Hafta", sun: "Itwaar" };
function timeWords(spec) {
  if (!spec) return "hamesha";
  const [range, ...days] = spec.split(",");
  const clock = (x) => { const m = /(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(x) || []; let hh = +(m[1] || 0), mm = +(m[2] || 0); if (m[3] && +m[3] >= 59) mm++; if (mm >= 60) { hh++; mm = 0; } return `${String(hh % 24 === 0 && hh ? 24 : hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`; };
  const [a, b] = range.split("-");
  const all = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  let d = "";
  if (days.length && days.length < 7) d = days.join(",") === "mon,tue,wed,thu,fri,sat" ? ", Pir–Hafta" : days.join(",") === "mon,tue,wed,thu,fri" ? ", Pir–Jumma" : ", " + days.filter((x) => all.includes(x)).map((x) => DAY_UR[x]).join(", ");
  return `${clock(a)} se ${clock(b)} tak${d}`;
}
const DNS_UR = { family: "Cloudflare Family — gandi sites band", "adguard-family": "AdGuard Family — gandi sites + ads band, safe search", "cleanbrowsing-family": "CleanBrowsing Family — gandi sites band, safe search, VPN / proxy sites bhi",
  "cleanbrowsing-adult": "CleanBrowsing Adult — sirf gandi sites band", router: "router ka normal DNS" };
function ruleWords(r, meta) {
  const when = r.time ? h("span", { class: "muted" }, ` — sirf ${timeWords(r.time)}`) : null;
  const cat = (meta.categories.find((c) => c.name === r.value) || {}).description;
  switch (r.kind) {
    case "block": return r.value === "keywords" ? [h("b", {}, "Gande alfaz"), " wali sites band (naam mein sex, xxx, porn …)", when]
      : [h("b", {}, r.value), " band", cat ? h("span", { class: "muted" }, ` (${cat})`) : null, when];
    case "block-app": return [h("b", {}, r.value), " app band — us ke saare domains, network par seekhe hue bhi", when];
    case "block-vpn": return [h("b", {}, "VPN band"), " — VPN apps, VPN websites, VPN servers aur protocols (koshish log hoti hai)", when];
    case "block-site": return ["Website ", h("b", {}, r.value), " band (subdomains bhi)", when];
    case "block-word": return r.value.startsWith("^") ? ["Jis site ke naam ka koi hissa ", h("b", {}, r.value.slice(1)), " se shuru ho, band (", h("i", {}, `${r.value.slice(1)}365.com, best-${r.value.slice(1)}s.org`), ")", when]
      : ["Jis site ke naam mein ", h("b", {}, r.value), " ho, band (", h("i", {}, `best${r.value}.net, ${r.value}-x.org`), ")", when];
    case "block-all": return [h("b", {}, "Internet bilkul band"), r.time ? when : " — hamesha (sirf 'always open' wali cheezein chalti hain)"];
    case "allow-only": return ["Sirf ", h("b", {}, r.value), " chalega (app profile) — baqi sab band"];
    case "allow-web": return [h("b", {}, r.value), " hamesha khuli — server site parh kar us ke fonts / CDN / tasveerein bhi kholta hai"];
    case "allow-app": return [h("b", {}, r.value), " app hamesha khuli — catalog ke saare servers"];
    case "allow-site": return [h("b", {}, r.value), " hamesha khuli (exception, subdomains bhi)"];
    case "dns": return ["DNS: ", h("b", {}, DNS_UR[r.value] || r.value)];
    case "strict-ech": return [h("b", {}, "Chhupe site naam (ECH)"), " band — browser site ka naam chhupa na sake"];
    default: return [h("code", {}, `${r.kind} ${r.value}`)];
  }
}
function policyMode(p) {
  if (p.enabled === false) return ["OFF", "warn", "Ye policy band (off) hai: users ke paas hai lekin kuch block nahi hota. Policies → switch se on karein."];
  const k = new Set(p.rules.map((r) => r.kind));
  if (k.has("allow-only")) return ["Sirf chuni hui apps", "warn", "Sirf neeche likhi apps chalti hain, baqi har cheez band."];
  if (p.rules.some((r) => r.kind === "block-all" && !r.time)) return ["Internet band", "bad", "Internet band hai; sirf 'hamesha khuli' wali cheezein chalti hain."];
  return ["Ye cheezein band", "info", "Neeche likhi cheezein band hain; baqi sab internet chalta hai."];
}

async function blockingGuide() {
  const [meta, ul] = await Promise.all([api("GET", "/api/blocking"), api("GET", "/api/users")]);
  const has = (n) => meta.policies.some((p) => p.name === n);
  const giveBtn = (n) => isAdmin() && has(n) ? h("button", { class: "small", onclick: () => givePolicyDialog(meta, ul.users, n) }, "Give") : null;
  const sec = (id, title, ...kids) => h("div", { class: "card guide-sec", id: `g-${id}` }, h("h2", {}, h("span", {}, title)), ...kids);
  const toc = [["flow", "Kaise kaam karta hai"], ["pick", "Kaun si policy kab"], ["apply", "Apply kaise karein"], ["policies", "Har policy"], ["rules", "Har rule"], ["order", "Tarteeb"], ["limits", "Hadood"]];
  const step = (n, title, text) => h("div", { class: "g-step" }, h("span", { class: "g-n" }, String(n)), h("div", {}, h("b", {}, title), h("div", { class: "muted small" }, text)));
  const RECIPES = [
    ["Bachay: padhai ke waqt social / games band, raat ko internet band", "parental-kids", "Parental controls se banayein (waqt apni marzi ke); ya tayyar 'kids'"],
    ["Bachay: TikTok, PUBG, YouTube videos, VPN hamesha band", "kids", "Baqi internet chalta hai"],
    ["Office staff: duty ke waqt social media / video band", "staff", "9–17 Pir–Hafta; LinkedIn hamesha khula"],
    ["Students / school lab", "students", "Social, video, games, VPN, torrent band + family DNS"],
    ["Mehman / cafe WiFi", "guests", "Sab chalta hai — torrent, VPN aur gandi sites ke ilawa"],
    ["Sirf WhatsApp (calls, photos, status)", "whatsapp-only", "Baqi har app aur website band"],
    ["Sirf WhatsApp + Hik-Connect (cameras)", "whatsapp-hikconnect", "NVR / DVR isi network mein bhi chalta hai"],
    ["Sirf ek website (aur jo us ko chahiye)", "only-minas", "Copy karein, apni site likhein — server baqi khud dhoondta hai"],
    ["Bill nahi diya / saza: internet band", "no-internet", "Kuch nahi chalta"],
    ["Sirf VPN band, baqi sab theek", "no-vpn", "VPN ki har koshish log hoti hai"],
    ["Raat ko internet band", "night-off", "00:00–06:00"],
    ["Windows Update band (internet slow na ho)", "", "Overview → Windows Update: Off in office hours / Off always; sirf kuch users: policy → category windows-update"],
  ];
  const ruleTable = [
    ["block social, gaming …", "Policy → Categories", "Category list ki saari sites / apps band", "HTTPS site ka naam (tls-host) dekh kar connection reset"],
    ["block-app TikTok", "Policy → Single apps", "Us app ke saare domains band (seekhe hue bhi)", "Same — app ke saare naam (tls-host)"],
    ["block-vpn", "Policy → Block VPN", "VPN apps, sites, servers, protocols", "VPN naam + VPN server IPs + protocol ports"],
    ["block-site example.com", "Policy → Single websites", "Ek website aur subdomains", "HTTPS naam (tls-host) se reset"],
    ["block-word casino / ^bet", "Policy → Words in site names", "Naam mein lafz ho to site band (^ = naam ke hisse ke shuru mein)", "HTTPS naam (tls-host) mein lafz dekh kar reset; page ka text nahi"],
    ["block-all", "Policy → Internet off completely / mode 'No internet'", "Poora internet band (waqt ke saath bhi)", "Har naya connection reject"],
    ["allow-only whatsapp", "Mode 'ONLY the apps I choose'", "Sirf ye apps; baqi sab band", "App ke servers ki address list; baqi reject"],
    ["allow-web site.com", "Websites always open", "Site + jo us ko chahiye (fonts, CDN) — hamesha", "Pehle 'return' rule: naam + DNS address list"],
    ["allow-app Instagram", "Apps always open", "App ke saare servers hamesha khule", "Same"],
    ["dns family", "Advanced → DNS", "Is policy ke users ka DNS family wala", "DNS port 53 us server ki taraf"],
    ["strict-ech", "Advanced → hidden site names", "Browser site ka naam chhupa na sake", "ECH wala connection reset"],
    ["… time=9h-17h,mon,…", "Har rule ke saath 'When'", "Rule sirf us waqt chalta hai", "Router ka clock; raat 12 ke paar bhi theek"],
  ];
  const polCards = meta.policies.map((p) => {
    const [mode, kind, modeText] = policyMode(p);
    const used = [...p.users, ...p.groups.map((g) => `${g} (group)`)];
    return h("div", { class: "g-pol", id: `gp-${p.name}` },
      h("div", { class: "g-pol-head" }, h("b", {}, p.name), badge(mode, kind), h("span", { class: "grow" }),
        isAdmin() ? h("button", { class: "small", onclick: () => givePolicyDialog(meta, ul.users, p.name) }, "Give") : null,
        isAdmin() ? h("a", { class: "btn small", href: `#/blocking/policies/edit/${encodeURIComponent(p.name)}` }, "Edit") : null),
      h("div", { class: "muted small" }, p.description),
      h("div", { class: "small" }, modeText),
      h("ul", { class: "g-rules" }, p.rules.map((r) => h("li", {}, ruleWords(r, meta)))),
      h("div", { class: "muted small" }, used.length ? `Kis ko di hai: ${used.join(", ")}` : "Abhi kisi ko nahi di"));
  });
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("guide"),
    h("div", { class: "subtabs g-toc" }, toc.map(([id, t]) => h("a", { href: `#/blocking/guide`, onclick: (e) => { e.preventDefault(); document.getElementById(`g-${id}`).scrollIntoView({ behavior: "smooth", block: "start" }); } }, t))),
    sec("flow", "Kaise kaam karta hai — 4 qadam",
      h("div", { class: "g-steps" },
        step(1, "Policy", "Rules ka set: kya band hai, kya hamesha khula hai, kis waqt. Tayyar policies neeche hain, ya + New policy."),
        step(2, "User ya group ko dein", "Give a policy → user ya poora group. User agle login par policy le leta hai (online ho to ek dafa disconnect hota hai)."),
        step(3, "Router khud le leta hai", "Router auto-sync har 15 minute mein naye rules import karta hai. Darkhwast se khuli site 1 minute mein."),
        step(4, "User ko kya dikhta hai", "Band site nahi khulti. http:// par block page (logo, wajah, code) aur 'khulwane ki darkhwast' button."))),
    sec("pick", "Kaun si policy kab lagayein",
      h("div", { class: "table-wrap" }, h("table", { class: "g-recipes" }, h("thead", {}, h("tr", {}, h("th", {}, "Aap chahte hain"), h("th", {}, "Policy"), h("th", {}, "Note"), h("th", {}, ""))),
        h("tbody", {}, RECIPES.map(([want, pol, note]) => h("tr", {}, h("td", { class: "wrap" }, want),
          h("td", {}, has(pol) ? h("a", { href: `#/blocking/guide`, onclick: (e) => { e.preventDefault(); document.getElementById(`gp-${pol}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); } }, h("code", {}, pol)) : pol ? h("code", {}, pol) : h("a", { href: "#/blocking/overview" }, "Overview → Windows Update")),
          h("td", { class: "wrap muted small" }, note), h("td", {}, giveBtn(pol)))))))),
    sec("apply", "Policy apply kaise karein",
      h("ol", { class: "g-list" },
        h("li", {}, h("b", {}, "Blocking → Policies → Give"), " (ya Overview → Give a policy). ", h("i", {}, "One user"), " ya ", h("i", {}, "A whole group"), " chunein, policy chunein, Apply."),
        h("li", {}, "Doosra tareeqa: ", h("b", {}, "Users → user → Own web-filter policy"), ", ya ", h("b", {}, "Groups → group → policy"), "."),
        h("li", {}, "User online hai to ek dafa disconnect hota hai; dobara login par router use policy ki list (", h("code", {}, "policy-NAME"), ") mein daal deta hai."),
        h("li", {}, h("b", {}, "Pehli dafa"), ": Overview → Router auto-sync → script download karke router par ek dafa import. Uske baad har tabdeeli khud pohanchti hai."),
        h("li", {}, h("b", {}, "Check karein"), ": Activity → Why blocked? → site + user → kaun sa rule, abhi chal raha hai ya nahi. Activity → Blocked tries mein har roki gayi koshish."),
        h("li", {}, h("b", {}, "Policy hatani ho"), ": Give dialog mein doosri policy, ya user ke page par policy khali."),
        h("li", {}, h("b", {}, "Thori der ke liye band karni ho"), ": Policies → policy ke saath wala switch ", h("i", {}, "Off"), ". Policy users ke paas rehti hai, router se us ke rules hat jate hain; ", h("i", {}, "On"), " karte hi wapas (15 minute mein router par)."))),
    sec("policies", `Har policy — aasaan alfaz mein (${meta.policies.length})`, h("div", { class: "g-pols" }, polCards)),
    sec("rules", "Har rule kaise kaam karta hai",
      h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Policy file mein"), h("th", {}, "Dashboard mein"), h("th", {}, "Kya hota hai"), h("th", {}, "Router kaise rokta hai"))),
        h("tbody", {}, ruleTable.map(([code, where, what, how]) => h("tr", {}, h("td", {}, h("code", {}, code)), h("td", { class: "wrap small" }, where), h("td", { class: "wrap" }, what), h("td", { class: "wrap muted small" }, how)))))),
      h("div", { class: "muted small g-after-table" }, "Categories: ", meta.categories.map((c) => `${c.name} = ${c.description}`).join(" · "))),
    sec("order", "Tarteeb — kaun pehle chalta hai",
      h("ul", { class: "g-list" },
        h("li", {}, h("b", {}, "Ek user, ek policy"), ". User ki apni policy group ki policy se upar hai."),
        h("li", {}, h("b", {}, "Hamesha khuli"), " (allow-web / allow-app / allow-site) sab se pehle — 'internet band' wali policy mein bhi khuli rehti hain."),
        h("li", {}, h("b", {}, "Darkhwast se khuli site"), " (Requests) waqt tak sab se upar; waqt khatam to khud band."),
        h("li", {}, "Phir band rules: category, app, site, VPN, internet off — har ek apne waqt par."),
        h("li", {}, h("b", {}, "Sirf chuni hui apps"), " (allow-only): un apps ke ilawa sab band; kai apps ek policy mein ho sakti hain."),
        h("li", {}, "Waqt router ke clock se; 22:00–06:00 jaisa raat 12 ke paar wala waqt bhi theek chalta hai."))),
    sec("limits", "Hadood — kya nahi ho sakta",
      h("ul", { class: "g-list" },
        h("li", {}, "HTTPS site par block page nahi dikh sakta (certificate ke baghair); browser apna error dikhata hai. http:// par dikhta hai."),
        h("li", {}, "Agar device router ka DNS na le (apna DoH / private DNS), naam wali rokawat kamzor; HTTPS naam (tls-host) phir bhi kaam karta hai."),
        h("li", {}, "Naye VPN apps pehli dafa nikal sakte hain; server unhein seekh kar list mein daal deta hai."),
        h("li", {}, "'Sirf chuni hui apps' aur 'hamesha khuli' ke naam wali address lists ke liye RouterOS 7.15+ chahiye."),
        h("li", {}, "Policy user name par lagti hai — device ko login (Hotspot / PPPoE / WPA-Enterprise) se aana zaroori hai."))),
    hint("Sawal ho to: Activity → Why blocked? har site aur user ke liye bata deta hai ke kya, kyun aur kab.")));
}

async function blockingPolicies(action, which) {
  const [meta, ul] = await Promise.all([api("GET", "/api/blocking"), api("GET", "/api/users")]);
  const search = h("input", { type: "search", placeholder: "Search policies, users, rules …" });
  const show = h("select", {}, [["all", "All policies"], ["used", "In use"], ["unused", "Not used"], ["off", "Turned off"]].map(([v, l]) => h("option", { value: v }, l)));
  const MAXR = 5;
  const usedBy = (p) => {
    const all = [...p.users, ...p.groups.map((g) => `${g} (group)`), ...(p.nets || []).map((n) => `${n.target}${n.comment ? " " + n.comment : ""} (network)`)];
    if (!all.length) return h("span", { class: "muted" }, "not used");
    return h("div", { class: "pol-used", title: all.join(", ") }, all.slice(0, 3).join(", "), all.length > 3 ? h("span", { class: "muted" }, ` +${all.length - 3} more`) : null);
  };
  const policySwitch = (p) => {
    const cb = h("input", { type: "checkbox", checked: p.enabled !== false, disabled: !isAdmin(), "aria-label": `policy ${p.name} on` });
    const txt = h("span", {}, p.enabled !== false ? "On" : "Off");
    cb.addEventListener("change", async () => {
      const on = cb.checked;
      if (!on && (p.users.length || p.groups.length || (p.nets || []).length) && !(await confirmDlg("Turn policy off", `Turn "${p.name}" off? Its ${p.users.length + p.groups.length} user(s) / group(s) keep it, but nothing of it is blocked until you turn it on again.`, "Turn off"))) { cb.checked = true; return; }
      cb.disabled = true;
      if (await act(api("POST", `/api/policies/${encodeURIComponent(p.name)}/${on ? "on" : "off"}`, {}))) { blSummary = null; route(); }
      else { cb.checked = !on; cb.disabled = false; }
    });
    return h("label", { class: "switch", title: "On: the routers block what it says. Off: kept and still given, nothing blocked." }, cb, h("span", { class: "track" }), txt);
  };
  const rows = meta.policies.map((p) => {
    const extra = p.rules.length - MAXR;
    const tr = h("tr", { class: "policy-row" + (p.enabled === false ? " off" : ""), "data-name": p.name },
      h("td", { class: "pol-switch" }, policySwitch(p)),
      h("td", { class: "pol-name" }, h("b", {}, p.name, p.enabled === false ? [" ", badge("OFF", "warn")] : null), h("span", {}, p.description)),
      h("td", { class: "pol-rules-td" }, h("div", { class: "pol-rules" }, p.rules.slice(0, MAXR).map(ruleLabel), extra > 0 ? badge(`+${extra} more`) : null)),
      h("td", { class: "pol-used-td" }, usedBy(p)),
      h("td", {}, isAdmin() ? h("div", { class: "pol-actions" },
        h("button", { class: "small", onclick: () => openPolicyEditor(meta, p) }, "Edit"),
        h("button", { class: "small", title: "give this policy to a user or a group", onclick: () => givePolicyDialog(meta, ul.users, p.name) }, "Give"),
        h("button", { class: "small", title: "delete", onclick: async () => { if (await confirmDlg("Delete policy", `Delete policy "${p.name}"?`)) { await act(api("DELETE", `/api/policies/${encodeURIComponent(p.name)}`)); blSummary = null; route(); } } }, "Delete")) : null));
    tr._text = [p.name, p.description, ...p.users, ...p.groups, ...p.rules.map((r) => `${r.kind} ${r.value}`)].join(" ").toLowerCase();
    tr._used = p.users.length + p.groups.length + (p.nets || []).length > 0;
    tr._off = p.enabled === false;
    return tr;
  });
  const empty = h("div", { class: "empty", hidden: true }, "No policy matches.");
  const filter = () => {
    const t = search.value.trim().toLowerCase();
    let n = 0;
    rows.forEach((r) => { r.hidden = (t && !r._text.includes(t)) || (show.value === "used" && !r._used) || (show.value === "unused" && r._used) || (show.value === "off" && !r._off); n += r.hidden ? 0 : 1; });
    empty.hidden = n > 0;
  };
  search.addEventListener("input", filter); show.addEventListener("change", filter);
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("policies"),
    h("div", { class: "page-head" }, search, show, h("span", { class: "grow" }),
      isAdmin() ? h("button", { onclick: () => givePolicyDialog(meta, ul.users) }, icon("users"), "Give a policy") : null,
      isAdmin() ? h("button", { class: "primary", onclick: () => openPolicyEditor(meta, null) }, "+ New policy") : null),
    h("div", { class: "card" }, h("h2", {}, h("span", {}, "Policies"), h("span", { class: "sub" }, `${meta.policies.length} · ${meta.policies.filter((p) => p.users.length || p.groups.length || (p.nets || []).length).length} in use${meta.policies.some((p) => p.enabled === false) ? ` · ${meta.policies.filter((p) => p.enabled === false).length} off` : ""}`)),
      h("div", { class: "table-wrap" }, h("table", { class: "pol-table" },
        h("thead", {}, h("tr", {}, h("th", {}, ""), h("th", {}, "Policy"), h("th", {}, "Rules"), h("th", {}, "Used by"), h("th", {}, ""))),
        h("tbody", {}, rows))), empty),
    netPolicyCard(meta),
    hint("A policy is a set of rules. Give it to users or groups — or to a network / IP range (no login needed). One user has one policy (own, else the group's).")));
  if (action === "new" && isAdmin()) { history.replaceState(null, "", "#/blocking/policies"); openPolicyEditor(meta, null); }
  if (action === "give" && isAdmin()) { history.replaceState(null, "", "#/blocking/policies"); givePolicyDialog(meta, ul.users); }
  if (action === "givenet" && isAdmin()) { history.replaceState(null, "", "#/blocking/policies"); givePolicyDialog(meta, ul.users, { who: "net", policy: which }); }
  const target = meta.policies.find((p) => p.name === which);
  if (action === "edit" && target && isAdmin()) { history.replaceState(null, "", "#/blocking/policies"); openPolicyEditor(meta, target); }
}

// ------------------------------------------------------------------ VPN watch: who tries a VPN + the automatic VPN lists
ROUTES.vpn = async (tab = "users") => {
  const tabs = [["users", "Who tried"], ["attempts", "All attempts"], ["servers", "VPN servers (auto list)"], ["names", "VPN names (auto list)"], ["howto", "How to block"]];
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const user = h("input", { type: "search", placeholder: "User" });
  const holder = h("div", { class: "stack" });
  const src = { dns: ["DNS", "info"], blocked: ["router blocked", "ok"], flow: ["traffic", "warn"] };
  const srcBadges = (s) => h("span", { class: "chips" }, String(s || "").split(",").filter(Boolean).map((x) => badge(...(src[x] || [x]))));
  const who = (r) => h("span", {}, r.username ? h("a", { href: `#/users/${encodeURIComponent(r.username)}` }, r.username) : h("span", { class: "muted" }, "(no login)"), h("div", { class: "muted" }, r.client_ip || r.devices || ""));
  const notVpn = (nm) => isAdmin() ? h("button", { class: "small", title: "e.g. your office VPN — never list or block it", onclick: async () => {
    if (await confirmDlg("Not a VPN", `Remove ${nm} from the VPN lists and never block it?`, "Not a VPN", false)) { await act(api("POST", "/api/vpn/ignore", { name: nm })); load(); }
  } }, "Not a VPN") : null;
  const load = async () => {
    const d = await api("GET", `/api/vpn?${new URLSearchParams({ days: days.value, user: user.value.trim(), top: 500 })}`);
    const t = d.totals;
    const tiles = h("div", { class: "grid g-tiles" }, tile("Users who tried a VPN", num(t.users)), tile("Tries", num(t.tries), `${num(t.blocked)} blocked by the router`),
      tile("VPN servers known", num(t.servers), "grows by itself"), tile("VPN names known", num(t.domains), "apps & websites"));
    let body;
    if (tab === "users") body = table([{ label: "User", render: who }, { label: "VPN", key: "vpns", wrap: true }, { label: "Tries", key: "tries", num: true },
      { label: "Result", render: (r) => Number(r.connected) ? badge("maybe connected", "bad") : Number(r.blocked) ? badge("blocked", "ok") : badge("seen", "warn") },
      { label: "First / last", render: (r) => h("span", {}, String(r.first).slice(5, 16), h("div", { class: "muted" }, String(r.last).slice(5, 16))) }], d.users, "Nobody tried a VPN in this period.");
    else if (tab === "attempts") body = table([{ label: "Last", render: (r) => String(r.last).slice(5, 16) }, { label: "User", render: who }, { label: "VPN", key: "kind" },
      { label: "What", render: (r) => h("code", {}, r.what), wrap: true }, { label: "Seen by", render: (r) => srcBadges(r.sources) }, { label: "Tries", key: "tries", num: true },
      { label: "Data", num: true, render: (r) => Number(r.bytes) ? bytes(r.bytes) : "—" }], d.attempts, "No VPN attempts in this period.");
    else if (tab === "servers") body = [h("div", { class: "note" }, "Every VPN server IP seen on your network: from VPN app names in DNS, VPN protocols in traffic, and connections the router blocked. The router gets this list (address list vpn-servers) through auto-sync; policies with \"Block VPN\" block it. Shared CDN / big-company IPs are never added."),
      table([{ label: "IP", render: (r) => h("code", {}, r.ip) }, { label: "VPN", key: "kind" }, { label: "Found by", key: "why", wrap: true },
        { label: "First / last seen", render: (r) => h("span", {}, String(r.first_seen).slice(0, 16), h("div", { class: "muted" }, String(r.last_seen).slice(0, 16))) }, { label: "", render: (r) => notVpn(r.ip) }], d.servers, "No VPN server seen yet.")];
    else if (tab === "names") body = table([{ label: "Name", render: (r) => h("code", {}, r.domain) }, { label: "VPN", key: "kind" }, { label: "Why", key: "why" },
      { label: "First / last seen", render: (r) => h("span", {}, String(r.first_seen).slice(0, 16), h("div", { class: "muted" }, String(r.last_seen).slice(0, 16))) }, { label: "", render: (r) => notVpn(r.domain) }], d.domains, "No VPN name seen yet.");
    else body = h("div", { class: "steps" },
      h("div", {}, h("span", {}, h("b", {}, "Blocking → policy with \"Block VPN\""), " — the ready-made ", h("code", {}, "no-vpn"), " policy, or tick Block VPN in any policy (students and guests already have it).")),
      h("div", {}, h("span", {}, h("b", {}, "Give it to users or groups"), " — Blocking → \"Give a policy to a user / group\". For everyone: give the policy to every group, or import ", h("code", {}, "webfilter-vpn-protocols.rsc"), " on the router (protocols only).")),
      h("div", {}, h("span", {}, h("b", {}, "Router auto-sync"), " — keeps the router's VPN server list and VPN names up to date every 15 minutes.")),
      h("div", {}, h("span", {}, h("b", {}, "Watch this page"), " — every try is listed here: who, which VPN, and whether the router blocked it. \"maybe connected\" = a VPN connection moved data (no blocking policy on that user yet).")));
    holder.replaceChildren(tiles, h("div", { class: "card" }, body));
  };
  shell("VPN & proxy watch", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/vpn/${k}`, class: k === tab ? "active" : "" }, l))),
    card(null, null, h("div", { class: "toolbar" }, days, user, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"),
      isAdmin() ? h("button", { onclick: async () => { await act(api("POST", "/api/vpn/scan")); load(); } }, "Scan logs now") : null)),
    holder));
  await load();
};

// ------------------------------------------------------------------ blocking logs: which policy blocked which user, and what
// Parental controls: ready-made schedules for children in one click (makes a policy and gives it to them)
const PARENTAL = [
  { k: "homework", t: "📚 Homework time", d: "No social media, video and games", from: "16:00", to: "19:00", days: "mon,tue,wed,thu,fri",
    lines: (tm) => ["social", "social-video", "video-streaming", "gaming"].map((c) => `block ${c} time=${tm}`) },
  { k: "bedtime", t: "🌙 Bedtime", d: "No internet at all", from: "22:00", to: "06:00", days: "sun,mon,tue,wed,thu,fri,sat",
    lines: (tm) => [`block-all time=${tm}`] },
  { k: "school", t: "🏫 School hours", d: "Only study: no games, social, video", from: "08:00", to: "14:00", days: "mon,tue,wed,thu,fri,sat",
    lines: (tm) => ["social", "social-video", "video-streaming", "gaming", "messaging"].map((c) => `block ${c} time=${tm}`) },
  { k: "games", t: "🎮 Games only at the weekend", d: "Games blocked Monday–Friday", from: "00:00", to: "00:00", days: "mon,tue,wed,thu,fri",
    lines: (tm) => [`block gaming time=${tm}`] },
];
const ptime = (from, to, days) => {
  const hm = (x) => { const [a, b] = x.split(":").map(Number); return b ? `${a}h${b}m` : `${a}h`; };
  return `${from === to ? "0s-23h59m59s" : `${hm(from)}-${hm(to)}`},${days}`;
};
async function parentalPage() {
  const [{ users }, gr] = await Promise.all([api("GET", "/api/users"), api("GET", "/api/groups")]);
  const rows = PARENTAL.map((p) => {
    const on = h("input", { type: "checkbox", checked: p.k === "homework" || p.k === "bedtime" });
    const from = h("input", { type: "time", value: p.from, disabled: p.k === "games" }), to = h("input", { type: "time", value: p.to, disabled: p.k === "games" });
    const days = h("div", { class: "day-picks" }, SPEED_DAYS.map(([k, l]) => h("label", { class: "check" }, h("input", { type: "checkbox", value: k, checked: p.days.split(",").includes(k) }), l)));
    const el = h("div", { class: "sub-card" }, h("label", { class: "check" }, on, h("div", {}, h("b", {}, p.t), h("span", {}, p.d))),
      p.k === "games" ? null : h("div", { class: "toolbar" }, "From", from, "to", to, h("span", { class: "muted small" }, "(over midnight is fine)")), days);
    return { p, on, from, to, days, el };
  });
  const safe = h("input", { type: "checkbox", checked: true }), novpn = h("input", { type: "checkbox", checked: true });
  const name = h("input", { value: "kids", pattern: "[a-z0-9-]{1,40}", size: 12 });
  const who = h("input", { placeholder: "users, comma separated", list: "pc-users" });
  const grp = h("select", {}, h("option", { value: "" }, "— or a group —"), gr.groups.map((g) => h("option", { value: g.name }, g.name)));
  const preview = h("pre", { class: "code-box" });
  const build = () => {
    const out = [`# Parental controls (${new Date().toISOString().slice(0, 10)})`];
    rows.forEach((r) => {
      if (!r.on.checked) return;
      const d = [...r.days.querySelectorAll("input:checked")].map((x) => x.value).join(",");
      if (!d) return;
      out.push(...r.p.lines(ptime(r.from.value, r.to.value, d)));
    });
    if (safe.checked) out.push("dns family");
    if (novpn.checked) out.push("block-vpn");
    return out.join("\n");
  };
  const refresh = () => { preview.textContent = build(); };
  [...rows.flatMap((r) => [r.on, r.from, r.to, ...r.days.querySelectorAll("input")]), safe, novpn].forEach((x) => x.addEventListener("change", refresh));
  refresh();
  const apply = async (e) => {
    const pol = `parental-${name.value.trim() || "kids"}`;
    if (!/^[a-z0-9-]{1,48}$/.test(pol)) return toast("Name: small letters, digits and -", true);
    const list = who.value.split(",").map((x) => x.trim()).filter(Boolean);
    if (!list.length && !grp.value) return toast("Choose the children (users) or a group", true);
    if (build().split("\n").length < 2) return toast("Choose at least one rule", true);
    e.target.disabled = true;
    try {
      if (!(await act(api("POST", "/api/policies", { name: pol, text: build() })))) return;
      for (const u of list) await act(api("POST", `/api/users/${encodeURIComponent(u)}/policy`, { policy: pol }));
      if (grp.value) await act(api("POST", "/api/groups", { name: grp.value, policy: pol, edit: true }));
      toast(`Policy ${pol} is active — the router gets it within 15 minutes (auto-sync)`);
    } finally { e.target.disabled = false; }
  };
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("parental"),
    card("Parental controls", "ready-made schedules for children",
      h("div", { class: "muted" }, "Tick what you want, choose the children, press Apply. It becomes a normal policy (Policies tab) that you can change later. Times are the router's clock."),
      h("div", { class: "grid g-2" }, rows.map((r) => r.el)),
      h("div", { class: "checks" },
        h("label", { class: "check" }, safe, h("div", {}, h("b", {}, "🛡 Family-safe internet, always"), h("span", {}, "family DNS: adult sites blocked, safe search on Google / YouTube / Bing"))),
        h("label", { class: "check" }, novpn, h("div", {}, h("b", {}, "🚫 No VPN / proxy"), h("span", {}, "so the rules cannot be skipped with a VPN app")))),
      h("div", { class: "toolbar wrap" }, h("b", {}, "Children:"), who, h("datalist", { id: "pc-users" }, users.map((u) => h("option", { value: u.username }))), grp,
        h("span", {}, "Name:"), name, isAdmin() ? h("button", { class: "primary", onclick: apply }, "Apply") : null),
      h("details", {}, h("summary", {}, "The policy that will be made"), preview)),
    card("For the parents", null, h("div", { class: "muted" }, "Which sites and apps a child used: Users → the child → Top sites (7 days), or Insights for the whole network. A blocked try shows up in Blocking logs."))));
}

// Blocking: six areas, two of them with sub-pages; red numbers = something waits for the admin
const BL_AREAS = [["overview", "Overview", ["overview"]], ["policies", "Policies", ["policies"]], ["parental", "Parental controls", ["parental"]],
  ["requests", "Requests", ["requests"]], ["logs", "Activity", ["logs", "why"]], ["web", "Apps & websites", ["web", "apps"]], ["guide", "Guide", ["guide"]]];
const BL_SUB = { logs: [["logs", "Blocked tries"], ["why", "Why blocked?"]], web: [["web", "Allowed websites & apps"], ["apps", "App profiles"]] };
let blSummary = null, blSummaryAt = 0;
async function blockingSummary(fresh) {
  if (fresh || !blSummary || Date.now() - blSummaryAt > 30000) { blSummary = await api("GET", "/api/blocking/summary"); blSummaryAt = Date.now(); }
  return blSummary;
}
const blockingTabs = (tab) => {
  const area = BL_AREAS.find((a) => a[2].includes(tab)) || BL_AREAS[0];
  const links = BL_AREAS.map(([k, l]) => h("a", { href: `#/blocking/${k}`, class: k === area[0] ? "active" : "", "data-area": k }, l));
  blockingSummary().then((d) => {
    const n = { requests: d.requests, web: d.suggestions };
    links.forEach((a) => { const c = n[a.dataset.area]; if (c) a.append(h("span", { class: "count", title: "waiting for you" }, String(c))); });
  }).catch(() => {});
  const sub = BL_SUB[area[0]];
  return h("div", { class: "stack tight" }, h("div", { class: "tabs" }, links),
    sub ? h("div", {}, h("div", { class: "subtabs" }, sub.map(([k, l]) => h("a", { href: `#/blocking/${k}`, class: k === tab ? "active" : "" }, l)))) : null);
};
// calm help: one line, or a "How it works" that opens
const hint = (text, ...more) => h("div", { class: "bl-hint" }, icon("info"), more.length ? h("details", {}, h("summary", {}, text), ...more) : h("div", {}, text));
// ports of an allowed website / app / profile: what it uses, direct connections it tried (blocked), opened ones
const netLabel = (k) => { const [n, pr, pt] = k.split(" "); return `${n} · ${pr.toUpperCase()} ${pt}`; };
function portParts(x, answer) {
  const sn = Object.entries(x.suggest_net || {}).sort((a, b) => b[1].count - a[1].count), nets = Object.entries(x.nets || {});
  return [
    x.ports && x.ports.length ? h("div", { class: "stack tight" }, h("b", {}, "Ports it uses"),
      h("div", { class: "chips" }, x.ports.map((p) => h("span", { class: "chip", title: p.last ? "last seen " + new Date(p.last * 1000).toLocaleString() : "" }, `${p.proto.toUpperCase()} ${p.port} · ${bytes(p.bytes)}`)))) : null,
    sn.length ? h("div", { class: "stack tight" }, h("b", {}, "Direct connections it tried (no name, blocked)"),
      sn.map(([k, v]) => h("div", { class: "rule-row item" }, h("code", { class: "grow" }, netLabel(k)),
        h("span", { class: "muted small" }, `${v.count}× · ${v.why} · ${v.ips.join(", ")}`),
        isAdmin() ? [h("button", { class: "small primary", onclick: answer(x.site, k, true) }, "Allow"), h("button", { class: "small", onclick: answer(x.site, k, false) }, "Ignore")] : null))) : null,
    nets.length ? h("div", { class: "stack tight" }, h("b", {}, `Open networks + ports (${nets.length})`),
      nets.map(([k, v]) => h("div", { class: "rule-row item" }, h("code", { class: "grow" }, netLabel(k)), badge("by you", ""), h("span", { class: "muted small" }, "only this network and port"),
        isAdmin() ? h("button", { class: "chip-x", title: "close this", onclick: answer(x.site, k, false) }, "×") : null))) : null];
}

async function allowedWebsites() {
  const d = await api("GET", "/api/webscan");
  const FROM = { scan: ["found on the site", "info"], learned: ["learned", "ok"], admin: ["by you", ""] };
  const KIND = { site: "Website", app: "App", ao: "App profile" };
  const answer = (key, name, allow) => async (e) => { e.target.disabled = true; if (await act(api("POST", `/api/webscan/${key}/answer`, { name, allow }))) route(); else e.target.disabled = false; };
  const sig = (sites) => sites.map((x) => `${x.site}:${x.scanning ? x.scanning.pages : "-"}:${x.scanned}`).join(",");
  const cards = d.sites.map((x) => {
    const allowed = Object.entries(x.allowed), sugg = Object.entries(x.suggest).sort((a, b) => b[1].count - a[1].count), skipped = Object.entries(x.skipped);
    const site = x.kind === "site";
    const state = !site ? "learns while it is used"
      : x.scanning ? `reading the whole site … ${x.scanning.pages} of up to ${d.deep_pages} pages`
      : x.scanned ? `read ${ago(new Date(x.scanned * 1000).toISOString())}: ${x.pages_read} page${x.pages_read === 1 ? "" : "s"}${x.deep ? " (whole site)" : ""}` : "not read yet";
    return card(`${x.name}`, `${KIND[x.kind]} · ${x.policies.join(", ")} · ${state}`,
      x.scanning ? h("div", { class: "stack tight" }, meter(Math.round(100 * x.scanning.pages / d.deep_pages), 101, 101),
        h("span", { class: "muted small" }, `Pages, their CSS and JavaScript files are read 4 at a time (at most ${d.deep_minutes} minutes). The routers get the result by themselves.`)) : null,
      site && x.error && !x.scanning ? h("div", { class: "note" }, `Could not read the site: ${x.error}. It is still open; what it needs comes from learning below.`) : null,
      !site ? h("div", { class: "muted small" }, x.kind === "app" ? "Every server the app catalog knows is open; helpers it asks right after are learned."
        : "The profile's lines are open; other names of the same company are learned (Apps & websites → How it works).") : null,
      sugg.length ? h("div", { class: "stack tight" }, h("b", {}, `Does ${site ? "the site" : "it"} need these? (asked right after it, but blocked)`),
        sugg.map(([n, v]) => h("div", { class: "rule-row item" }, h("code", { class: "grow" }, n), h("span", { class: "muted small" }, `${v.count ? v.count + "× · " : ""}${v.why}`),
          isAdmin() ? [h("button", { class: "small primary", onclick: answer(x.site, n, true) }, "Allow"), h("button", { class: "small", onclick: answer(x.site, n, false) }, "Ignore")] : null))) : null,
      h("div", { class: "stack tight" }, h("b", {}, `${site ? "Opened with it" : "Learned"} (${allowed.length})`),
        allowed.length ? allowed.sort().map(([n, v]) => h("div", { class: "rule-row item" }, h("code", { class: "grow" }, n),
          badge(...(FROM[v.from] || [v.from, ""])), h("span", { class: "muted small" }, v.why),
          isAdmin() ? h("button", { class: "chip-x", title: "do not open this", onclick: answer(x.site, n, false) }, "×") : null))
          : h("span", { class: "muted small" }, site ? "Nothing from other places yet." : "Nothing learned yet — it learns while the app is used.")),
      skipped.length ? h("div", { class: "muted small" }, `Left out (ads / trackers): ${skipped.map(([n]) => n).join(", ")}`) : null,
      ...portParts(x, answer),
      site && x.pages && x.pages.length ? h("details", {}, h("summary", { class: "muted small" }, `Pages read (${x.pages_read})`),
        h("div", { class: "mono small" }, x.pages.map((u) => h("div", {}, u)), x.pages_read > x.pages.length ? h("div", { class: "muted" }, "…") : null)) : null,
      site && isAdmin() ? h("div", { class: "toolbar" },
        h("button", { class: "small primary", disabled: !!x.scanning, onclick: async (e) => { e.target.disabled = true; if (await act(api("POST", `/api/webscan/${x.site}/scan`, { deep: true }))) route(); else e.target.disabled = false; } }, icon("search"), "Read the whole site"),
        h("button", { class: "small", disabled: !!x.scanning, onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Reading …"; await act(api("POST", `/api/webscan/${x.site}/scan`, {})); route(); } }, "Quick read")) : null);
  });
  if (d.sites.some((x) => x.scanning)) {
    const was = sig(d.sites);
    every(3000, async () => { try { const n = await api("GET", "/api/webscan"); if (sig(n.sites) !== was) route(); } catch (e) { /* next time */ } });
  }
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("web"),
    hint("How it works", h("div", {}, "Type only a website or an app name in a policy. A new website is read at once, then the whole site in the background: its sitemap, up to " + d.deep_pages + " pages and its JavaScript files. What it loads from elsewhere is opened — fonts, CSS / JS libraries, image CDNs — but no ads or trackers. Every day it is read again, and while people use websites, apps and app profiles the server learns more: well-known helpers (and for app profiles, names of the same company) are opened by themselves, the rest is asked here. Each card also shows the ports it uses, and direct connections to bare addresses (P2P, relays) that were blocked right after it was used — Allow opens only that network and port.")),
    cards.length ? h("div", { class: "stack" }, cards) : card(null, null, h("div", { class: "empty" }, "Nothing yet — add a website or an app in a policy: Blocking → Edit → Websites always open / Apps always open, or an app profile under Only these apps."))));
}

// an app profile in words: "2 whole domains · this office (LAN) · 6 servers · 10 hidden apps refused"
function aoSummary(text) {
  const n = { domain: 0, host: 0, net: 0, "deny-sni": 0, "block-quic": 0 }; let lan = false, meta = false;
  text.split("\n").forEach((l) => { const [k, v] = l.replace(/#.*/, "").trim().split(/\s+/); if (k in n) n[k]++; if (k === "net" && v === "@lan") lan = true; if (k === "net" && v === "@meta") meta = true; });
  const parts = [];
  if (n.domain) parts.push(badge(`${n.domain} whole domain${n.domain > 1 ? "s" : ""}`, "ok"));
  if (n.host) parts.push(badge(`${n.host} server${n.host > 1 ? "s" : ""}`, "ok"));
  if (meta) parts.push(badge("Meta network", "ok"));
  if (lan) parts.push(badge("this office (LAN)", "ok"));
  const nets = n.net - (lan ? 1 : 0) - (meta ? 1 : 0);
  if (nets > 0) parts.push(badge(`${nets} address range${nets > 1 ? "s" : ""}`, "ok"));
  if (n["deny-sni"]) parts.push(badge(`${n["deny-sni"]} look-alike app${n["deny-sni"] > 1 ? "s" : ""} refused`, "bad"));
  if (n["block-quic"]) parts.push(badge("QUIC off", "warn"));
  return h("div", { class: "ao-sum" }, parts.length ? parts : badge("empty"));
}

async function appProfiles() {
  const d = await api("GET", "/api/allowonly");
  const edit = (pr) => {
    const nameIn = h("input", { name: "name", required: true, pattern: "[a-z0-9][a-z0-9\\-]{0,30}", value: pr ? pr.name : "", readonly: !!pr, placeholder: "e.g. hikconnect" });
    const ta = h("textarea", { name: "text", rows: 14, spellcheck: "false", class: "mono" }, pr ? pr.text : "# Profile: My app\ndomain example.com\n");
    const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "Name", nameIn),
      h("label", { class: "field" }, "Lines", h("span", { class: "help" }, "domain NAME (every name under it) · host NAME · net 203.0.113.25 or net @lan (this office) · deny-sni WORD · block-quic"), ta));
    dialog(pr ? `App profile ${pr.name}` : "New app profile", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
      if (!form.reportValidity()) return false;
      if (!(await act(api("POST", "/api/allowonly", { name: nameIn.value.trim(), text: ta.value })))) return false;
      route();
    } }]);
  };
  const cards = d.profiles.map((pr) => card(pr.name, pr.used_by.length ? `used by: ${pr.used_by.join(", ")}` : "not used yet",
    h("div", { class: "muted" }, pr.title),
    aoSummary(pr.text),
    h("details", {}, h("summary", { class: "muted small" }, "Show lines"), h("pre", { class: "code-box small" }, pr.text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).join("\n") || "(empty)")),
    isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "small", onclick: () => edit(pr) }, "Edit"),
      !pr.used_by.length ? h("button", { class: "small danger", onclick: async () => {
        if (await confirmDlg("Delete app profile", `Delete ${pr.name}?`, "Delete")) if (await act(api("DELETE", `/api/allowonly/${pr.name}`))) route();
      } }, "Delete") : null) : null));
  // learn an app from what a phone looked up
  const whoIn = h("input", { type: "search", placeholder: "user or the phone's IP", list: "ao-users" });
  const minSel = h("select", {}, [["10", "last 10 minutes"], ["30", "last 30 minutes"], ["60", "last hour"], ["1440", "last day"]].map(([v, l]) => h("option", { value: v }, l)));
  const out = h("div", { class: "stack" });
  const users = await api("GET", "/api/users").then((r) => (r.users || []).map((u) => u.username)).catch(() => []);
  const show = async () => {
    let r;
    try { r = await api("GET", `/api/allowonly/learn?${new URLSearchParams({ who: whoIn.value.trim(), minutes: minSel.value })}`); }
    catch (e) { out.replaceChildren(h("div", { class: "note" }, e.message)); return; }
    if (!r.sites.length) { out.replaceChildren(h("div", { class: "empty" }, `No names asked by ${r.ip} in that time. Use the app on the phone, then press Show again.`)); return; }
    const ticks = r.sites.map((g) => ({ g, cb: h("input", { type: "checkbox", checked: !g.background, onchange: (e) => e.target.closest("label").classList.toggle("on", e.target.checked) }) }));
    const target = h("input", { placeholder: "profile name, e.g. hikconnect", list: "ao-names", pattern: "[a-z0-9][a-z0-9\\-]{0,30}" });
    out.replaceChildren(
      h("div", { class: "muted" }, `${r.ip}: ${r.sites.length} sites. Ticked = probably the app; the others are what every phone asks in the background.`),
      h("div", { class: "stack tight" }, ticks.map(({ g, cb }) => h("label", { class: "check" + (cb.checked ? " on" : "") }, cb,
        h("div", {}, h("b", {}, g.site), h("span", {}, `${g.count}× · ${g.names.slice(0, 4).join(", ")}${g.names.length > 4 ? " …" : ""}`))))),
      isAdmin() ? h("div", { class: "toolbar wrap" }, target, h("button", { class: "primary", onclick: async () => {
        const name = target.value.trim();
        if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return toast("Profile name: a-z 0-9 -", true);
        const sites = ticks.filter((x) => x.cb.checked).map((x) => x.g.site);
        if (!sites.length) return toast("Tick at least one site", true);
        const old = d.profiles.find((p) => p.name === name);
        const have = new Set((old ? old.text : "").split("\n").map((l) => l.trim()));
        const add = sites.map((x) => `domain ${x}`).filter((l) => !have.has(l));
        const text = (old ? old.text.replace(/\n*$/, "\n") : `# Profile: ${name} (learned from ${r.ip})\n`) + add.join("\n") + "\n";
        if (await act(api("POST", "/api/allowonly", { name, text }))) route();
      } }, "Save as app profile")) : null);
  };
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("apps"),
    hint("How it works", h("div", {}, "An app profile lists what one app needs. In a policy choose \"ONLY the apps I choose\" and tick the profiles — e.g. whatsapp + hikconnect: those two work, everything else is blocked.")),
    isAdmin() ? h("div", { class: "toolbar" }, h("span", { class: "grow" }), h("button", { class: "primary", onclick: () => edit(null) }, icon("plus"), "New app profile")) : null,
    h("div", { class: "grid dept-grid" }, cards),
    card("Learn an app", d.dnslog ? "from the DNS logger" : "needs the DNS logger",
      h("ol", { class: "steps" },
        h("li", {}, "Take a phone that is NOT limited yet (or give its user a normal policy for a moment)."),
        h("li", {}, "On it, open the app and use everything: login, live view, playback …"),
        h("li", {}, "Here: the user or the phone's IP → Show → tick the app's sites → Save as app profile.")),
      h("div", { class: "toolbar wrap" }, whoIn, minSel, h("button", { onclick: show }, icon("search"), "Show"),
        h("datalist", { id: "ao-users" }, users.map((u) => h("option", { value: u }))), h("datalist", { id: "ao-names" }, d.profiles.map((p) => h("option", { value: p.name })))),
      out)));
}

async function unblockRequests() {
  const d = await api("GET", "/api/unblock");
  const who = (r) => h("span", {}, r.username || h("span", { class: "muted" }, "(no login)"), h("div", { class: "muted small" }, r.ip || ""));
  const decide = (r, how) => async (e) => {
    if (how === "always" && !(await confirmDlg("Always open", `${r.host.replace(/^www\./, "")} will never be blocked for policy ${r.policy || "of this user"} — for everyone in it.`, "Always open"))) return;
    e.target.disabled = true;
    if (await act(api("POST", `/api/unblock/${r.id}`, { how }))) route(); else e.target.disabled = false;
  };
  const site = h("input", { type: "search", placeholder: "site, e.g. example.com", class: "grow" });
  const user = h("input", { type: "search", placeholder: "user", list: "req-users" });
  const howSel = h("select", {}, [["1h", "1 hour"], ["2h", "2 hours"], ["4h", "4 hours"], ["today", "Today"]].map(([v, l]) => h("option", { value: v }, l)));
  const users = await api("GET", "/api/users").then((r) => (r.users || []).map((u) => u.username)).catch(() => []);
  const give = h("form", { class: "toolbar wrap", onsubmit: async (e) => {
    e.preventDefault();
    if (await act(api("POST", "/api/unblock/allow", { user: user.value.trim(), site: site.value.trim(), how: howSel.value }))) route();
  } }, user, site, howSel, h("button", { class: "primary", type: "submit", disabled: !isAdmin() }, "Open for this user"), h("datalist", { id: "req-users" }, users.map((u) => h("option", { value: u }))));
  const STATUS = { always: ["always open (policy)", "ok"], allowed: ["was open", ""], ended: ["ended", ""], denied: ["refused", "bad"] };
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("requests"),
    hint("How it works", h("div", {}, "Users ask from the block page (\"Khulwane ki darkhwast\"). You get an alert (Settings → Alerts: Unblock requests). Temporary openings reach the routers within a minute and close by themselves.")),
    card("Waiting for an answer", `${d.pending.length}`, table([
      { label: "When", render: (r) => r.at.slice(5, 16) }, { label: "User", render: who },
      { label: "Site", render: (r) => h("code", {}, r.host), wrap: true }, { label: "Policy", render: (r) => r.policy ? badge(r.policy, "info") : "—" },
      { label: "Note", render: (r) => r.note || h("span", { class: "muted" }, "—"), wrap: true },
      { label: "", render: (r) => h("div", { class: "row-actions wrap" },
          h("a", { class: "btn small", href: `#/blocking/why/${encodeURIComponent(r.host)}/${encodeURIComponent(r.username || r.ip)}/${r.code || ""}` }, "Why?"),
          isAdmin() ? [h("button", { class: "small primary", onclick: decide(r, "1h") }, "1 hour"), h("button", { class: "small", onclick: decide(r, "today") }, "Today"),
            h("button", { class: "small", onclick: decide(r, "always") }, "Always"), h("button", { class: "small danger", onclick: decide(r, "deny") }, "Refuse")] : null) }],
      d.pending, "No requests waiting.")),
    card("Open now (temporary)", `${d.open.length}`, table([
      { label: "User", render: who }, { label: "Site", render: (r) => h("code", {}, r.host), wrap: true },
      { label: "Until", render: (r) => r.until.slice(5, 16) }, { label: "By", key: "decided_by" },
      { label: "", render: (r) => isAdmin() ? h("button", { class: "small danger", onclick: decide(r, "end") }, "End now") : null }],
      d.open, "Nothing is open temporarily."), isAdmin() ? h("div", { class: "stack" }, h("b", {}, "Open a site for a user (without a request)"), give) : null),
    card("Decided", "last 50", table([
      { label: "When", render: (r) => (r.decided_at || r.at).slice(5, 16) }, { label: "User", render: who },
      { label: "Site", render: (r) => h("code", {}, r.host), wrap: true },
      { label: "Answer", render: (r) => { const [l, k] = STATUS[r.status] || [r.status, ""]; return badge(l, k); } }, { label: "By", key: "decided_by" }],
      d.recent, "Nothing yet."))));
}

async function whyBlocked(site = "", who = "", ref = "") {
  const siteIn = h("input", { type: "search", value: site, placeholder: "website, link, or the 6-letter code from the block page", class: "grow" });
  const whoIn = h("input", { type: "search", value: who, placeholder: "user or IP (optional)", list: "why-users" });
  const holder = h("div", { class: "stack" });
  const go = () => { location.hash = `#/blocking/why/${encodeURIComponent(siteIn.value.trim())}/${encodeURIComponent(whoIn.value.trim())}`; };
  const form = h("form", { class: "toolbar wrap", onsubmit: (e) => { e.preventDefault(); go(); } }, siteIn, whoIn, h("button", { class: "primary", type: "submit" }, icon("search"), "Check"));
  const VERDICT = { blocked: ["BLOCKED now", "bad"], "blocked-other-times": ["blocked at other times", "warn"], allowed: ["not blocked by the policy", "ok"], "no-policy": ["no policy", ""] };
  if (/^[A-Za-z0-9]{6}$/.test(site) && !site.includes(".")) {          // reference code from the block page
    try {
      const { event: ev } = await api("GET", `/api/why/ref/${site}`);
      location.replace(`#/blocking/why/${encodeURIComponent(ev.host)}/${encodeURIComponent(ev.username || ev.ip)}/${ev.code}`);
    } catch (e) { holder.replaceChildren(h("div", { class: "note" }, e.message)); }
  } else if (site) {
    try {
      let ev = null;
      if (ref) ev = (await api("GET", `/api/why/ref/${ref}`).catch(() => ({}))).event || null;
      const d = await api("GET", `/api/why?${new URLSearchParams({ site, user: who })}`);
      const [vt, vk] = VERDICT[d.verdict] || [d.verdict, ""];
      holder.replaceChildren(
        ev ? card(`Block page ${ev.code}`, ev.at, h("div", { class: "kv-grid" },
          h("b", {}, "Shown to"), h("span", {}, `${ev.username || "(no login)"} · ${ev.ip}`),
          h("b", {}, "Address"), h("code", {}, `http://${ev.host}${ev.path}`),
          h("b", {}, "Rule then"), h("code", {}, ev.rule || "—"), h("b", {}, "Policy"), h("span", {}, ev.policy || "—"),
          h("b", {}, "Why"), h("span", {}, ev.why || "—"))) : null,
        card(d.host, d.user ? `user ${d.user}${d.ip ? " · " + d.ip : ""} · ${d.at}` : d.at,
          h("div", { class: "why-verdict" }, badge(vt, vk), h("b", {}, d.summary)),
          d.notes.map((n) => h("div", { class: "note" }, n)),
          d.user ? h("div", { class: "muted small" }, d.policy ? `Policy: ${d.policy} (from ${d.list_from})` : `Address list: ${d.list || "none"}`) : null),
        card("Rules of the policy that match", d.policy ? `policy ${d.policy}` : null, table([
          { label: "Rule", render: (r) => h("code", {}, r.rule), wrap: true },
          { label: "Now", render: (r) => r.active ? badge("active", "bad") : badge(`only ${r.time}`, "warn") },
          { label: "Why", key: "why", wrap: true },
          { label: "In the router log", render: (r) => h("code", {}, r.router) },
          { label: "", render: () => d.policy && isAdmin() ? h("a", { class: "btn small", href: `#/blocking/policies/edit/${encodeURIComponent(d.policy)}` }, "Edit policy") : null }],
          d.rules, d.policy ? "No rule of this policy blocks this site." : "No policy for this user — enter a user to check their policy.")),
        card("Lists this site is on", null, table([
          { label: "Kind", render: (h1) => badge(h1.kind, "info") }, { label: "Name", key: "name" },
          { label: "Matched by", render: (h1) => h("code", {}, h1.match) }], d.lists, "On no block list.")),
        card("Recent blocked attempts (router log, 7 days)", null, table([
          { label: "Time", render: (r) => r.time.slice(5) }, { label: "User", render: (r) => `${r.user} (${r.ip})` },
          { label: "Policy", render: (r) => badge(r.policy, "info") }, { label: "Blocked by", render: (r) => badge(r.reason, "bad") },
          { label: "Site", render: (r) => h("code", {}, r.site) }], d.recent, "No logged attempts for this site.")));
    } catch (e) { holder.replaceChildren(h("div", { class: "note" }, e.message)); }
  }
  const users = await api("GET", "/api/users").then((r) => (r.users || []).map((u) => u.username)).catch(() => []);
  const bp = await api("GET", "/api/blockpage").catch(() => ({ on: false, server_ip: "", today: 0 }));
  const frame = h("iframe", { class: "bp-preview", title: "block page preview", sandbox: "" });
  const bpCard = card("Block page for users", bp.on ? `on · shown ${bp.today} time(s) today` : "off",
    h("label", { class: "check" + (bp.on ? " on" : "") }, h("input", { type: "checkbox", checked: bp.on, disabled: !isAdmin(),
      onchange: async (e) => { if (!(await act(api("POST", "/api/blockpage", { on: e.target.checked })))) e.target.checked = !e.target.checked; route(); } }),
      h("div", {}, h("b", {}, "Show a page with the logo, the reason and a code"),
        h("span", {}, "For users with a policy, on blocked http:// sites (routers send port 80 to this server, :8082). HTTPS sites still show the browser's own error — no certificates are installed. The user tells you the code; type it above."))),
    !bp.server_ip ? h("div", { class: "note" }, "First set this server's IP: Security → Protection & lists (or radius-admin security quarantine-server IP).") : null,
    h("details", {}, h("summary", {}, "Preview (logo and colours from the Hotspot page designer)"), h("div", { class: "bp-wrap" }, frame)));
  frame.src = "/api/blockpage/preview";
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("why"),
    hint("How it works", h("div", {}, "A user says a site does not open? Type the site and the user: you see which list it is on, which rule of their policy blocks it, whether that rule is active right now, and the router log lines. Tip: \"Why?\" in Blocking logs fills this in.")),
    card(null, null, form, h("datalist", { id: "why-users" }, users.map((u) => h("option", { value: u })))), holder, bpCard));
  if (!site) siteIn.focus();
}

async function blockingLogs() {
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const user = h("input", { type: "search", placeholder: "User" }), policy = h("input", { type: "search", placeholder: "Policy" });
  const holder = h("div", { class: "stack" });
  const load = async () => {
    const d = await api("GET", `/api/blocked?${new URLSearchParams({ days: days.value, user: user.value.trim(), policy: policy.value.trim(), n: 1000 })}`);
    holder.replaceChildren(
      card("Who is blocked by which policy", `${d.summary.length} rows`, table([{ label: "Policy", render: (r) => badge(r.policy, "info") },
        { label: "User", render: (r) => r.user !== "-" ? h("a", { href: `#/users/${encodeURIComponent(r.user)}` }, r.user) : h("span", { class: "muted" }, "(no login)") },
        { label: "Blocked by", render: (r) => badge(r.reason, "bad") }, { label: "Times", key: "count", num: true }], d.summary, "Nothing blocked in this period.")),
      card("Every blocked attempt", "newest first", table([{ label: "Time", render: (r) => r.time.slice(5) },
        { label: "User", render: (r) => h("span", {}, r.user !== "-" ? r.user : h("span", { class: "muted" }, "(no login)"), h("div", { class: "muted" }, r.ip)) },
        { label: "Policy", render: (r) => badge(r.policy, "info") }, { label: "Blocked by", render: (r) => badge(r.reason, "bad") },
        { label: "Site", render: (r) => r.site ? h("code", {}, r.site) : h("span", { class: "muted" }, "—"), wrap: true }, { label: "Destination", key: "destination" },
        { label: "", render: (r) => r.site ? h("a", { class: "btn small", href: `#/blocking/why/${encodeURIComponent(r.site)}/${encodeURIComponent(r.user !== "-" ? r.user : r.ip)}` }, "Why?") : null }], d.rows, "Nothing blocked in this period.")));
  };
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("logs"),
    hint("How it works", h("div", {}, "Every block the router logged, with the user's policy (own policy, else the group's), what blocked it (category, app, VPN, allow-only …) and the site name the device asked for. Needs webfilter-logging.rsc on the router.")),
    card(null, null, h("div", { class: "toolbar" }, days, user, policy, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
}

// ------------------------------------------------------------------ security detective: virus, hacker attacks, DDoS
ROUTES.security = async (tab = "all") => {
  const tabs = [["all", "All alerts"], ["ips", "Intrusion prevention"], ["inbound", "From outside"], ["ransomware", "Ransomware"], ["virus", "Virus (infected devices)"], ["attack", "Hacker attacks"], ["ddos", "DDoS attacks"], ["setup", "Protection & lists"], ["reports", "Monthly reports"]];
  if (tab === "inbound") return inboundPage(tabs);
  if (tab === "ips") return ipsPage(tabs);
  if (tab === "reports") {
    const { reports } = await api("GET", "/api/security/reports");
    const now = new Date(); const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const ym = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const mon = h("input", { type: "month", value: ym(last), max: ym(now) });
    const make = (send) => async (e) => { e.target.disabled = true; await act(api("POST", "/api/security/reports", { month: mon.value, send })); route(); };
    shell("Security", h("div", { class: "stack" },
      h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/security/${k}`, class: k === tab ? "active" : "" }, l))),
      card("Monthly security report (PDF)", "made by itself on the 1st of every month",
        h("div", { class: "muted" }, "Everything about last month on 2–3 pages: virus, attacks, DDoS, fake routers / ARP spoofing, quarantined devices, VPN attempts, and what to do — in simple words. On the 1st it goes by email (PDF attached), Telegram (PDF) and WhatsApp (summary) — Settings → Alerts → Monthly security report."),
        isAdmin() ? h("div", { class: "toolbar wrap" }, mon, h("button", { class: "primary", onclick: make(false) }, "Make report"), h("button", { onclick: make(true) }, "Make and send")) : null,
        table([{ label: "Month", render: (r) => h("b", {}, r.month) }, { label: "Made", key: "made" }, { label: "Size", num: true, render: (r) => bytes(r.size) },
          { label: "", render: (r) => h("div", { class: "row-actions" }, h("a", { class: "btn small", href: `/api/security/reports/${r.name}`, target: "_blank", rel: "noopener" }, "Open"),
            h("a", { class: "btn small", href: `/api/security/reports/${r.name}?download=1` }, "⬇ Download")) }], reports, "No report yet — press Make report."))));
    return;
  }
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const high = h("label", { class: "chip" }, h("input", { type: "checkbox" }), "only high");
  const holder = h("div", { class: "stack" });
  const sev = (s) => badge(s, s === "high" ? "bad" : s === "medium" ? "warn" : "info");
  const catBadge = (c) => badge({ virus: "VIRUS", attack: "ATTACK", ddos: "DDoS", ransomware: "RANSOMWARE" }[c] || c, c === "virus" ? "warn" : "bad");
  const who = (r) => r.src_ip ? h("span", {}, r.username ? h("a", { href: `#/users/${encodeURIComponent(r.username)}` }, r.username) : null,
    h("div", { class: r.username ? "muted" : "" }, h("code", {}, r.src_ip))) : r.username ? h("span", {}, r.username) : "—";
  const load = async () => {
    const d = await api("GET", `/api/security?${new URLSearchParams({ days: days.value, category: ["virus", "attack", "ddos", "ransomware"].includes(tab) ? tab : "", high: high.querySelector("input").checked ? "1" : "", n: 500 })}`);
    const c = (k) => d.counts[k] || { events: 0, high: 0 };
    const tiles = h("div", { class: "grid g-tiles" },
      tile("Virus alerts", num(c("virus").events), `${num(c("virus").high)} high · infected devices`),
      tile("Hacker attacks", num(c("attack").events), `${num(c("attack").high)} high · scans, password guessing`),
      tile("DDoS attacks", num(c("ddos").events), `${num(c("ddos").high)} high · floods by type`),
      tile("Ransomware risk", num((d.risk || []).filter((r) => r.level === "high").length), `${num((d.risk || []).length)} device(s) with signs (24 h)`),
      tile("Threat lists", num(d.lists.threat_names), `names + ${num(d.lists.threat_networks)} networks · ${d.lists.updated || "not downloaded"}`));
    const qip = h("input", { placeholder: "e.g. 192.168.88.10", value: d.lists.server_ip || "" });
    if (tab === "setup") {
      const toggle = (label, help, on, action) => h("label", { class: "check" + (on ? " on" : "") }, h("input", { type: "checkbox", checked: on, disabled: !isAdmin(),
        onchange: async (e) => { await act(api("POST", `/api/security/${action}`, { on: e.target.checked })); load(); } }), h("div", {}, h("b", {}, label), h("span", {}, help)));
      holder.replaceChildren(tiles, card("Protection", null, h("div", { class: "checks" },
        toggle("Block attackers on the router automatically", "Outside addresses with a high-severity attack or DDoS in the last 24 h go to the router's ml-attackers list (auto-sync) and are dropped for a day. Needs mikrotik/security.rsc.", d.lists.autoblock, "autoblock"),
        toggle("Block malware / phishing / mining names (DNS)", "The DNS logger answers 0.0.0.0 for names on the threat lists. The device still shows up here as infected.", d.lists.dns_block, "dns-block"),
        toggle("Quarantine infected devices automatically", "A device with a HIGH virus alert loses the internet within 5 minutes and only sees a warning page (how to clean it, your contact). Release it on the Virus tab.", d.lists.quarantine_auto, "quarantine-auto")),
        isAdmin() ? h("label", { class: "field" }, "This server's IP as the routers see it (warning page on port 8081)",
          h("div", { class: "toolbar" }, qip, h("button", { onclick: async () => { await act(api("POST", "/api/security/quarantine-server", { ip: qip.value.trim() })); load(); } }, "Save"))) : null,
        isAdmin() ? h("div", { class: "toolbar" }, h("button", { onclick: async () => { await act(api("POST", "/api/security/update")); load(); } }, "Update threat lists now"),
          h("button", { onclick: async () => { await act(api("POST", "/api/security/scan")); load(); } }, "Scan logs now")) : null),
        card("What is checked", null, h("div", { class: "steps" },
          h("div", {}, h("span", {}, h("b", {}, "Virus"), " — malware, phishing and crypto-mining names (URLhaus, ThreatFox, Blackbook, Phishing Army, NoCoin), random names that do not exist (DGA malware), botnet servers (Feodo), spam to many mail servers, scanning the internet (Mirai, WannaCry …) or the LAN, a device flooding someone (DDoS bot).")),
          h("div", {}, h("span", {}, h("b", {}, "Hacker attacks"), " — port scans, network sweeps, password guessing on SSH / RDP / Winbox / API / Telnet / FTP, on the router login, on Wi-Fi / hotspot users and on this dashboard, known attacker networks (Spamhaus DROP, FireHOL).")),
          h("div", {}, h("span", {}, h("b", {}, "DDoS"), " — by type: SYN flood, UDP flood, ICMP flood, HTTP flood, and reflection / amplification by service (DNS, NTP, SSDP, memcached, CLDAP, SNMP, WS-Discovery …). Many sources = DDoS, few = DoS.")),
          h("div", {}, h("span", {}, h("b", {}, "Router"), " — import mikrotik/security.rsc (port-scan, password-guessing and SYN-flood lists + threat lists) and webfilter-logging.rsc (sends the hits and login failures here). Traffic Flow (traffic-flow.rsc) feeds the flow checks.")))));
      return;
    }
    const inQ = new Set(d.quarantine.flatMap((x) => [x.ip, x.username].filter(Boolean)));
    if (tab === "ransomware") { holder.replaceChildren(...ransomwareView(d, inQ, load)); return; }
    const parts = [tiles];
    const quarantineBtn = (r) => !isAdmin() ? null : (inQ.has(r.src_ip) || (r.username && inQ.has(r.username))) ? badge("in quarantine", "bad")
      : h("button", { class: "small", onclick: async () => {
        const target = r.username || r.src_ip;
        if (await confirmDlg("Quarantine", `Cut ${target} off the internet? It will only see a warning page until you release it.`, "Quarantine")) {
          await act(api("POST", "/api/security/quarantine", { target, reason: String(r.types || "").slice(0, 110) })); load();
        } } }, "Quarantine");
    if (tab === "virus" || d.quarantine.length) parts.push(card("Quarantine", `${d.quarantine.length} device(s) · automatic ${d.lists.quarantine_auto ? "on" : "off"}`,
      h("div", { class: "muted" }, "Quarantined devices have no internet; every http:// page they open shows a warning with what to do and your contact number."),
      table([{ label: "Device", render: (x) => h("span", {}, x.username || "", h("div", { class: x.username ? "muted" : "" }, h("code", {}, x.ip || "(any IP of this user)"))) },
        { label: "Why", key: "reason", wrap: true }, { label: "By", render: (x) => badge(Number(x.auto) ? "automatic" : "admin", Number(x.auto) ? "warn" : "info") },
        { label: "Since", render: (x) => String(x.since).slice(5, 16) },
        { label: "", render: (x) => isAdmin() ? h("button", { class: "small", onclick: async () => { await act(api("POST", "/api/security/release", { target: x.username || x.ip })); load(); } }, "Release") : null }],
        d.quarantine, "Nobody in quarantine.")));
    if (tab === "virus" && d.devices.length) parts.push(card("Infected devices", `${d.devices.length}`, table([{ label: "Device", render: (r) => who(r) },
      { label: "Signs", key: "types", wrap: true }, { label: "Hits", key: "hits", num: true }, { label: "Last", render: (r) => String(r.last).slice(5, 16) },
      { label: "", render: quarantineBtn }], d.devices)));
    if (tab !== "all" && d.types.length) parts.push(card("By type", null, table([{ label: "Type", key: "type", wrap: true }, { label: "Alerts", key: "events", num: true },
      tab === "ddos" ? null : { label: "Attackers / devices", key: "sources", num: true }, { label: "Hits", key: "hits", num: true },
      { label: "Last", render: (r) => String(r.last).slice(5, 16) }].filter(Boolean), d.types)));
    parts.push(card("Alerts", "newest first", table([{ label: "Last", render: (r) => String(r.last_seen).slice(5, 16) }, { label: "", render: (r) => catBadge(r.category) },
      { label: "Severity", render: (r) => sev(r.severity) }, { label: "What", render: (r) => h("span", {}, h("b", {}, r.type), h("div", { class: "muted" }, r.detail)), wrap: true },
      { label: "Source", render: who }, { label: "Target", render: (r) => r.dst_ip ? h("code", {}, r.dst_ip) : "—" }, { label: "Hits", key: "hits", num: true }],
      d.events, "No alerts in this period — good.")));
    holder.replaceChildren(...parts);
  };
  high.querySelector("input").addEventListener("change", () => load());
  shell("Security", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/security/${k}`, class: k === tab ? "active" : "" }, l))),
    tab === "setup" ? null : card(null, null, h("div", { class: "toolbar" }, days, high, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
};

// ------------------------------------------------------------------ from outside: open doors + who came in from the internet
async function inboundPage(tabs) {
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const holder = h("div", { class: "stack" });
  const riskBadge = (r) => r.risk ? badge(r.risk, "bad") : null;
  const showDetail = async (r) => {
    const d = await api("GET", `/api/inbound/detail?${new URLSearchParams({ lan: r.lan_ip, port: r.port, days: days.value })}`);
    dialog(`Outside addresses → ${r.lan_ip}:${r.port}`, table([{ label: "Outside address", render: (x) => h("span", {}, h("code", {}, x.remote_ip), x.threat ? h("div", {}, badge(x.threat, "bad")) : null) },
      { label: "Connections", key: "flows", num: true }, { label: "In", num: true, render: (x) => bytes(x.bytes_in) }, { label: "Out", num: true, render: (x) => bytes(x.bytes_out) },
      { label: "First / last", render: (x) => h("span", {}, String(x.first).slice(5, 13), h("div", { class: "muted" }, String(x.last).slice(5, 16))) }], d.rows, "Nobody."), [{ label: "Close" }]);
  };
  const load = async () => {
    const d = await api("GET", `/api/inbound?days=${days.value}`);
    const openDoors = d.doors.filter((x) => !x.disabled), risky = openDoors.filter((x) => x.risk).length + d.services.filter((x) => x.advice).length;
    const badIn = d.remotes.filter((r) => r.threat).length;
    const doorRows = openDoors.concat(d.doors.filter((x) => x.disabled));
    holder.replaceChildren(
      h("div", { class: `card health-hero ${risky || badIn ? (risky ? "fail" : "warn") : "ok"}` }, h("div", { class: "hh-mark" }, risky ? "!" : "✔"),
        h("div", { class: "grow" }, h("div", { class: "hh-title" }, `${openDoors.length} door(s) open to the internet` + (risky ? ` — ${risky} risky` : "")),
          h("div", { class: "muted" }, `${num(d.rows.length)} inside service(s) reached from outside, by ${num(d.remotes.length)} outside address(es)` + (badIn ? ` — ${badIn} of them on threat lists / seen attacking` : "") + ` (last ${d.days} day(s)).`),
          !d.reported ? h("div", { class: "muted small" }, "The routers have not reported their port forwards yet — re-import the auto-sync script (Blocking → Overview) to get this.") : null)),
      card("Open doors on the routers", "port forwards (incl. UPnP) and the router's own services", table([
        { label: "Outside", render: (x) => h("span", {}, h("code", {}, `${x.proto.toUpperCase()} ${x.port || "all"}`), h("div", { class: "muted small" }, x.router)) },
        { label: "→ Inside", render: (x) => h("code", {}, `${x.to || "?"}:${x.to_port || x.port}`) },
        { label: "Open to", render: (x) => x.open_to === "everyone" ? badge("everyone", "warn") : h("code", {}, x.open_to) },
        { label: "", render: (x) => h("span", { class: "chips" }, x.dynamic ? badge("UPnP (opened by a device)", "warn") : null, x.disabled ? badge("disabled") : null, riskBadge(x)) },
        { label: "Note", render: (x) => h("span", { class: "small" }, x.comment ? h("b", {}, x.comment + " ") : null, x.advice), wrap: true }], doorRows, "No port forwards — nothing inside is opened to the internet by the routers."),
        d.services.length ? h("div", { class: "g-after-table" }, h("b", {}, "Router services that are on"), table([{ label: "Service", render: (x) => h("span", {}, h("b", {}, x.name), h("div", { class: "muted small" }, x.router)) },
          { label: "Port", key: "port", num: true }, { label: "Allowed from", render: (x) => x.advice ? badge("any address", "warn") : h("code", {}, x.open_to) },
          { label: "Advice", render: (x) => h("span", { class: "small" }, x.advice || "fine"), wrap: true }], d.services)) : null),
      card("Who came in from outside", "inside address : port ← how many outside addresses", table([
        { label: "Inside", render: (r) => h("span", {}, h("code", {}, `${r.lan_ip}:${r.port}`), r.username ? h("div", { class: "muted small" }, r.username) : null) },
        { label: "Service", render: (r) => h("span", {}, `${r.proto.toUpperCase()} · ${r.service || "?"}`,
          r.via || r.risk ? h("div", { class: "chips" }, r.via ? badge(r.via, "info") : null, riskBadge(r)) : null) },
        { label: "Outside addresses", num: true, render: (r) => h("span", {}, num(r.outside), r.bad_outside ? h("div", {}, badge(`${r.bad_outside} bad`, "bad")) : null) },
        { label: "Connections", num: true, render: (r) => h("span", {}, num(r.flows), h("div", { class: "muted small" }, "last " + String(r.last).slice(5, 16))) },
        { label: "In / out", num: true, render: (r) => `${bytes(r.bytes_in)} / ${bytes(r.bytes_out)}` },
        { label: "", render: (r) => h("button", { class: "small", onclick: () => showDetail(r).catch((e) => toast(e.message, true)) }, "Who?") }],
        d.rows, "Nothing came in from outside in this period (needs the traffic collector).")),
      card("Outside addresses", "most connections first", table([{ label: "Address", render: (r) => h("code", {}, r.remote_ip) },
        { label: "", render: (r) => r.threat ? badge(r.threat, "bad") : null }, { label: "Inside targets", key: "targets", num: true },
        { label: "Connections", key: "flows", num: true }, { label: "Last", render: (r) => String(r.last).slice(5, 16) }], d.remotes, "None.")),
      hint("How to close a door", h("ul", { class: "g-list" },
        h("li", {}, "Port forward you do not need: router → IP → Firewall → NAT → disable / remove it (or ", h("code", {}, "/ip firewall nat disable [find dst-port=3389]"), ")."),
        h("li", {}, "Needed only by you: set its ", h("i", {}, "Src. Address"), " to your office / home address, or reach it through a VPN."),
        h("li", {}, "UPnP doors are opened by devices (games, cameras) by themselves: ", h("code", {}, "/ip upnp set enabled=no"), " if you do not want that."),
        h("li", {}, "Router services: ", h("code", {}, "/ip service set winbox address=192.168.88.0/24"), ", and turn off what you do not use (telnet, ftp, api, www)."))));
    holder.querySelectorAll("table").forEach((t) => t.classList.add("rw-table"));     // cards on a phone
  };
  shell("Security", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/security/${k}`, class: k === "inbound" ? "active" : "" }, l))),
    card(null, null, h("div", { class: "toolbar" }, days, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
}

// ------------------------------------------------------------------ ransomware: risk per device, the stages it went through
const RANSOM_STAGES = [["in", "Got in", "malware / phishing site"], ["contact", "Talks to its owner", "Tor, ransom-note site, botnet, random names"],
  ["spread", "Spreads in the LAN", "SMB / RDP to many PCs"], ["steal", "Steals data", "unusual upload, upload sites, rclone"], ["lock", "Locks files", "mass SMB data with a file server"]];
function ransomwareView(d, inQ, reload) {
  const risk = d.risk || [];
  const level = (r) => badge(r.level === "high" ? "ACT NOW" : r.level === "medium" ? "watch" : "low", r.level === "high" ? "bad" : r.level === "medium" ? "warn" : "info");
  const stages = (r) => h("div", { class: "rw-stages" }, RANSOM_STAGES.map(([k, l]) => h("span", { class: "rw-stage" + (r.stages.includes(k) ? " on" : ""), title: l }, l)));
  const act1 = (r) => !isAdmin() ? null : (r.quarantined ? badge("cut off (quarantine)", "bad") : h("button", { class: r.level === "high" ? "small primary danger-fill" : "small", onclick: async () => {
    const target = r.user || r.ip;
    if (await confirmDlg("Cut off", `Cut ${target} off the network now? It only sees a warning page until you release it (Security → Virus → Quarantine).`, "Cut off")) {
      await act(api("POST", "/api/security/quarantine", { target, reason: `ransomware risk ${r.score}: ${r.signals.slice(0, 2).join("; ")}`.slice(0, 110) })); reload();
    } } }, "Cut off now"));
  const top = risk[0];
  const auto = h("label", { class: "check" + (d.lists.ransomware_auto ? " on" : "") }, h("input", { type: "checkbox", checked: d.lists.ransomware_auto, disabled: !isAdmin(),
    onchange: async (e) => { await act(api("POST", "/api/security/ransomware-auto", { on: e.target.checked })); reload(); } }),
    h("div", {}, h("b", {}, "Cut off a device by itself at risk 70+"), h("span", {}, "Within 5 minutes it loses the network (quarantine, warning page) — before it reaches the file server or the other PCs. You get an alert either way.")));
  const cards = (el) => { const t = el.querySelector && el.querySelector("table"); if (t) t.classList.add("rw-table"); return el; };
  return [
    h("div", { class: `card health-hero ${!risk.length ? "ok" : top.level === "high" ? "fail" : "warn"}` },
      h("div", { class: "hh-mark" }, !risk.length ? "✔" : top.level === "high" ? "✘" : "!"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, !risk.length ? "No ransomware signs (24 h)" : top.level === "high" ? `${risk.filter((r) => r.level === "high").length} device(s) — act now` : `${risk.length} device(s) to watch`),
        h("div", { class: "muted" }, "Ransomware first gets in, talks to its owner, spreads to other PCs, steals data, then locks files. Each step leaves signs on the network — the more steps one device shows, the higher its risk."))),
    card("Devices with signs", "last 24 hours, worst first", cards(table([
      { label: "Device", render: (r) => h("span", {}, r.user ? h("a", { href: `#/users/${encodeURIComponent(r.user)}` }, r.user) : null, h("div", { class: r.user ? "muted" : "" }, h("code", {}, r.ip))) },
      { label: "Risk", render: (r) => h("div", { class: "rw-score" }, h("b", {}, String(r.score)), meter(r.score, 40, 70)) },
      { label: "", render: level }, { label: "Stages", render: stages },
      { label: "Signs", render: (r) => h("span", { class: "small" }, r.signals.join(" · ")), wrap: true },
      { label: "", render: act1 }], risk, "Nothing — no device shows ransomware signs."))),
    card("What to do", null, h("ol", { class: "g-list" },
      h("li", {}, h("b", {}, "Cut it off"), " (button above, or unplug the PC). Do not switch it off — the files it is locking may still be saved by IT."),
      h("li", {}, "Check the file server / NAS: ", h("i", {}, "files with strange endings or a 'READ ME' note"), " = it started. Take the NAS off the network."),
      h("li", {}, "Restore from a backup that was not connected (off-site / USB that was unplugged). Change passwords used on that PC."),
      h("li", {}, "Stolen data (unusual upload): tell the people whose data it was; do not pay — paying does not get the data back from them."))),
    card("Protection", null, h("div", { class: "checks" }, auto),
      h("div", { class: "muted small" }, "Also on: alerts (Settings → Alerts → Security), quarantine warning page, off-site backup (Settings → Off-site copy). Thresholds: SEC_LATERAL_HOSTS, SEC_SMB_BURST_MB, SEC_EXFIL_MB, SEC_EXFIL_HOUR_MB, SEC_EXFIL_FACTOR in radius.conf.")),
    card("Ransomware signs", "newest first", cards(table([{ label: "Last", render: (r) => String(r.last_seen).slice(5, 16) },
      { label: "Severity", render: (r) => badge(r.severity, r.severity === "high" ? "bad" : r.severity === "medium" ? "warn" : "info") },
      { label: "What", render: (r) => h("span", {}, h("b", {}, r.type), h("div", { class: "muted" }, r.detail)), wrap: true },
      { label: "Device", render: (r) => h("span", {}, r.username || "", h("div", { class: r.username ? "muted" : "" }, h("code", {}, r.src_ip || "—"))) },
      { label: "To", render: (r) => r.dst_ip ? h("code", {}, r.dst_ip) : "—" }], d.events, "No ransomware signs in this period."))),
    hint("What it can and cannot see", h("ul", { class: "g-list" },
      h("li", {}, "It sees the network: Tor, ransom-note sites, PCs touching many others on SMB / RDP, much more upload than usual, a sudden mass of file-server traffic."),
      h("li", {}, "It cannot see inside a PC. Two PCs (or a PC and a NAS) on the same switch talk without the router — to see that, put the file server in its own VLAN / subnet, or let the bridge send its traffic through the router (use-ip-firewall)."),
      h("li", {}, "Upload checks need the traffic collector; LAN checks need traffic flow for LAN traffic. It is not a virus scanner — keep antivirus and an unplugged / off-site backup."))),
  ];
}

// ------------------------------------------------------------------ website names: every domain and subdomain ever seen
ROUTES.domains = async () => {
  const search = h("input", { type: "search", placeholder: "Search: youtube, .pk, bank …" });
  const days = h("select", {}, [["1", "Seen today"], ["7", "7 days"], ["30", "30 days"], ["3650", "All time"]].map(([v, l]) => h("option", { value: v, selected: v === "30" }, l)));
  const holder = h("div", { class: "stack" });
  const tree = async (base) => {
    const d = await api("GET", `/api/domains/tree?base=${encodeURIComponent(base)}`);
    dialog(`${base} — ${d.rows.length} names`, table([{ label: "Name", render: (r) => h("span", {}, h("code", {}, r.host), r.app ? h("div", { class: "muted" }, r.app) : null), wrap: true },
      { label: "Lookups", key: "lookups", num: true }, { label: "Devices / day", key: "devices", num: true },
      { label: "First / last seen", render: (r) => h("span", {}, String(r.first_seen).slice(0, 16), h("div", { class: "muted" }, String(r.last_seen).slice(0, 16))) },
      { label: "IPs", render: (r) => h("code", {}, r.ips || "—"), wrap: true }], d.rows), [{ label: "Close" }]);
  };
  const load = async () => {
    const d = await api("GET", `/api/domains?${new URLSearchParams({ search: search.value.trim().toLowerCase(), days: days.value, top: 500 })}`);
    holder.replaceChildren(h("div", { class: "grid g-tiles" }, tile("Website names saved", num(d.totals.hosts), "domains + subdomains, kept for good"),
      tile("Domains", num(d.totals.bases)), tile("New in the last 24 h", num(d.totals.new_today)), tile("Recording since", String(d.totals.since || "—").slice(0, 10))),
      h("div", { class: "card" }, table([{ label: "Domain", render: (r) => h("a", { href: "#", onclick: (e) => { e.preventDefault(); tree(r.base).catch((x) => toast(x.message, true)); } }, r.base) },
        { label: "App", render: (r) => r.app || h("span", { class: "muted" }, "—") }, { label: "Names (subdomains)", key: "subdomains", num: true },
        { label: "First seen", render: (r) => String(r.first_seen).slice(0, 16) }, { label: "Last seen", render: (r) => String(r.last_seen).slice(0, 16) }],
        d.rows, "Nothing yet — the list fills itself every hour from the DNS log (radius-admin dnslog on).")));
  };
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") load(); });
  shell("Website names", h("div", { class: "stack" },
    h("div", { class: "note" }, "Every domain and subdomain any device looked up, saved with first / last seen, lookups, devices per day, app and IP addresses. Click a domain to see all its subdomains."),
    card(null, null, h("div", { class: "toolbar" }, search, days, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"),
      h("a", { class: "btn", href: "/api/domains.csv" }, "⬇ CSV (all)"))),
    holder));
  await load();
};

// ------------------------------------------------------------------ apps on the network (automatic list)
const OS_LABEL = { android: "Android", apple: "iPhone / Apple", windows: "Windows" };
const osBadge = (os) => os ? badge(OS_LABEL[os] || os, os === "android" ? "ok" : "info") : h("span", { class: "muted small" }, "not known");
let appsOs = "";
ROUTES.apps = async (cat = "") => {
  const holder = h("div", { class: "stack" });
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const user = h("input", { type: "search", placeholder: "User" }), ip = h("input", { type: "search", placeholder: "Device IP" });
  const find = h("input", { type: "search", placeholder: "Find an app …" });
  const srcBadge = (r) => r.source === "discovered" ? badge("auto-discovered", "warn") : null;
  const kinds = (r) => h("span", { class: "chips" }, ["android", "apple", "windows"].filter((k) => Number(r[k])).map((k) => badge(`${OS_LABEL[k]} ${r[k]}`, k === "android" ? "ok" : "info")));
  const load = async () => {
    const d = await api("GET", `/api/apps?${new URLSearchParams({ days: days.value, user: user.value.trim(), ip: ip.value.trim(), category: cat, os: appsOs, top: 300 })}`);
    const t = d.totals, dv = d.devices || {};
    const osSeg = h("div", { class: "subtabs" }, [["", "All devices"], ["android", `Android (${dv.android || 0})`], ["apple", `iPhone / Apple (${dv.apple || 0})`], ["windows", `Windows (${dv.windows || 0})`]]
      .map(([k, l]) => h("a", { href: "#", class: k === appsOs ? "active" : "", onclick: (e) => { e.preventDefault(); appsOs = k; load().catch((x) => toast(x.message, true)); } }, l)));
    const rows = d.rows.filter((r) => !find.value.trim() || `${r.app} ${r.site}`.toLowerCase().includes(find.value.trim().toLowerCase()));
    holder.replaceChildren(
      h("div", { class: "grid g-tiles" }, tile("Apps seen (all time)", num(t.apps)), tile("In this period", num(d.rows.length), cat ? `category: ${cat}` : appsOs ? `on ${OS_LABEL[appsOs]} devices` : "all categories"),
        tile("New this week", num(t.new_apps), "first seen in the last 7 days"), tile("Android devices", num(dv.android || 0), "recognised by themselves")),
      osSeg,
      h("div", { class: "tabs" }, h("a", { href: "#/apps", class: cat ? "" : "active" }, "All"),
        d.categories.map((c) => h("a", { href: `#/apps/${c.category}`, class: c.category === cat ? "active" : "" }, `${c.category} (${c.n})`))),
      h("div", { class: "card" }, table([
        { label: "App", render: (r) => h("a", { href: `#/app/${encodeURIComponent(r.site)}`, class: "app-link" }, h("b", {}, r.app), " ", Number(r.is_new) ? badge("NEW", "ok") : null, " ", srcBadge(r), h("div", { class: "muted" }, r.site)) },
        { label: "Category", render: (r) => badge(r.category, "info") },
        { label: "Devices", key: "devices", num: true }, { label: "Kind of devices", render: kinds },
        { label: "Data", num: true, render: (r) => bytes(r.bytes) },
        { label: "First / last seen", render: (r) => h("span", {}, String(r.first_seen).slice(0, 10), h("div", { class: "muted" }, String(r.last_seen).slice(0, 16))) },
        { label: "", render: (r) => h("div", { class: "toolbar" }, h("a", { class: "btn small primary", href: `#/app/${encodeURIComponent(r.site)}` }, "Details"),
          h("a", { class: "btn small", href: `/api/cdn/rsc?app=${encodeURIComponent(r.app)}`, title: "RouterOS script that blocks every known domain of this app" }, "⬇ Block")) },
      ], rows, appsOs ? `No app used by ${OS_LABEL[appsOs]} devices in this period.` : "No apps yet — the list fills itself every hour from the router's DNS log (radius-admin dnslog on).")));
  };
  find.addEventListener("input", () => load().catch(() => {}));
  shell("Apps on network", h("div", { class: "stack" },
    hint("How it works", h("div", {}, "Built by itself every hour from the router's DNS log: every app any device used, its names, server addresses and ports. New apps not in the catalog are found and named from their website. A device's kind (Android, iPhone, Windows) is recognised from the names its system asks by itself (connectivity check, Play Store, updates). Click an app for everything about it.")),
    card(null, null, h("div", { class: "toolbar" }, days, user, ip, find, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
};

// one app: names, server addresses, ports, devices (with their kind)
ROUTES.app = async (site = "") => {
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "30" }, l)));
  const holder = h("div", { class: "stack" });
  const load = async () => {
    const d = await api("GET", `/api/apps/detail?${new URLSearchParams({ site, days: days.value })}`);
    const a = d.app;
    const tcpUdp = d.ports.filter((p) => p.direction === "out");
    const kinds = {}; d.devices.forEach((x) => { kinds[x.os || ""] = (kinds[x.os || ""] || 0) + 1; });
    const portText = (p) => `${p.proto.toUpperCase()} ${p.port}`;
    holder.replaceChildren(
      h("div", { class: "grid g-tiles" }, tile("Names (domains)", num(d.names.length), `${num(d.known.length)} in the catalog`), tile("Server addresses", num(d.servers.length), "from DNS answers"),
        tile("Ports", num(tcpUdp.length), tcpUdp.slice(0, 3).map(portText).join(" · ") || "no traffic data"), tile("Devices", num(d.devices.length), Object.entries(kinds).filter(([k]) => k).map(([k, n]) => `${OS_LABEL[k]} ${n}`).join(" · ") || "kind not known")),
      card("Ports and protocols", "what the traffic collector saw", table([{ label: "Protocol / port", render: (p) => h("code", {}, portText(p)) },
        { label: "Direction", render: (p) => badge(p.direction, p.direction === "out" ? "info" : "warn") }, { label: "Data", num: true, render: (p) => bytes(p.bytes) },
        { label: "Connections", key: "flows", num: true }, { label: "Last seen", render: (p) => String(p.last_seen).slice(0, 16) }], d.ports, "No traffic data for this app yet (traffic collector).")),
      card("Server addresses", `${d.servers.length}`, table([{ label: "Address", render: (x) => h("code", {}, x.ip) }, { label: "Asked as", render: (x) => h("code", {}, x.host), wrap: true },
        { label: "Lookups", key: "lookups", num: true }, { label: "First / last seen", render: (x) => h("span", {}, String(x.first_seen).slice(0, 10), h("div", { class: "muted" }, String(x.last_seen).slice(0, 16))) }],
        d.servers, "No server address yet (fills from the DNS log every hour).")),
      card("Names (domains and subdomains)", `${d.names.length} seen on the network`, table([{ label: "Name", render: (x) => h("code", {}, x.host), wrap: true }, { label: "Domain", key: "base" },
        { label: "Lookups", key: "lookups", num: true }, { label: "Last addresses", render: (x) => h("span", { class: "muted small" }, x.ips || "—"), wrap: true },
        { label: "Last seen", render: (x) => String(x.last_seen).slice(0, 16) }], d.names, "No names seen yet."),
        d.known.length ? h("details", { class: "g-after-table" }, h("summary", { class: "muted small" }, `In the app catalog (${d.known.length})`), h("div", { class: "mono small" }, d.known.join("  "))) : null),
      card("Devices that use it", `last ${d.days} day(s)`, table([{ label: "Device", render: (x) => h("span", {}, x.client_ip, x.username ? h("div", { class: "muted" }, h("a", { href: `#/users/${encodeURIComponent(x.username)}` }, x.username)) : null) },
        { label: "Kind", render: (x) => h("span", { title: x.evidence || "" }, osBadge(x.os)) }, { label: "Lookups", key: "lookups", num: true },
        { label: "Days", render: (x) => x.first_day === x.last_day ? String(x.first_day) : `${x.first_day} → ${x.last_day}` }], d.devices, "Nobody in this period.")));
    return a;
  };
  let a;
  try { a = await load(); } catch (e) { shell("Apps on network", card(null, null, h("div", { class: "empty" }, e.message))); return; }
  shell(a.app, h("div", { class: "stack" },
    h("div", { class: "page-head" }, h("a", { class: "btn small", href: "#/apps" }, "← All apps"), badge(a.category, "info"),
      a.source === "discovered" ? badge("auto-discovered", "warn") : null, h("span", { class: "muted small" }, `${a.site} · first seen ${String(a.first_seen).slice(0, 10)} · last ${String(a.last_seen).slice(0, 16)}`),
      h("span", { class: "grow" }), days,
      h("a", { class: "btn small", href: `/api/cdn/rsc?app=${encodeURIComponent(a.app)}` }, "⬇ Block script"),
      isAdmin() ? h("a", { class: "btn small", href: "#/blocking/policies/new" }, "Block in a policy") : null),
    holder));
  days.addEventListener("change", () => load().catch((e) => toast(e.message, true)));
};

// ------------------------------------------------------------------ ports & protocols
ROUTES.ports = async (by = "port") => {
  const tabs = [["port", "Top ports"], ["app", "App → ports"], ["device", "Devices"], ["in", "Inbound (IN)"], ["profile", "Saved app profiles"]];
  const holder = h("div", { class: "stack" });
  const days = h("select", {}, [["1", "Today (24 h)"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const user = h("input", { type: "search", placeholder: "User" }), ip = h("input", { type: "search", placeholder: "Device IP" }), app = h("input", { type: "search", placeholder: "App/site e.g. whatsapp.com" });
  const dirBadge = (d) => d === "in" ? badge("IN", "bad") : d === "p2p" ? badge("P2P", "warn") : badge("OUT", "info");
  const portCell = (r) => h("span", {}, h("code", {}, `${r.port || "—"}/${r.protocol}`), r.service ? h("div", { class: "muted" }, r.service) : null);
  const load = async () => {
    const qs = new URLSearchParams({ by, days: days.value, user: user.value.trim(), ip: ip.value.trim(), app: app.value.trim(), top: 60 });
    const d = await api("GET", `/api/ports?${qs}`);
    const t = d.totals;
    const tiles = h("div", { class: "grid g-tiles" }, tile("OUT (devices → internet)", bytes(t.out_b)), tile("IN (internet → devices)", bytes(t.in_b), "port-forwards, cameras, servers"),
      tile("P2P (calls, games, torrents)", bytes(t.p2p_b)), tile("Different ports", num(t.ports)));
    let tbl;
    if (by === "port") tbl = table([{ label: "Port / protocol", render: portCell }, { label: "Direction", render: (r) => dirBadge(r.direction) },
      { label: "Download", num: true, render: (r) => bytes(r.down) }, { label: "Upload", num: true, render: (r) => bytes(r.up) },
      { label: "Devices", key: "devices", num: true }, { label: "Apps using it", key: "apps", wrap: true }], d.rows, "No data yet (traffic collector + router traffic-flow).");
    else if (by === "app" || by === "profile") {
      const groups = new Map();
      d.rows.forEach((r) => { if (!groups.has(r.site)) groups.set(r.site, []); groups.get(r.site).push(r); });
      tbl = groups.size ? h("div", { class: "grid g-2" }, [...groups].map(([site, rs]) => card(site, by === "profile" ? `saved since ${String(rs.reduce((m, r) => r.first_seen < m ? r.first_seen : m, rs[0].first_seen)).slice(0, 10)}` : `${rs.length} port(s)`,
        table([{ label: "Port / protocol", render: portCell }, { label: "Dir", render: (r) => dirBadge(r.direction) },
          { label: "Data", num: true, render: (r) => bytes(by === "profile" ? r.bytes : Number(r.down) + Number(r.up)) },
          by === "profile" ? { label: "Last seen", render: (r) => String(r.last_seen).slice(0, 16) } : { label: "Devices", key: "devices", num: true }], rs))))
        : h("div", { class: "card" }, h("div", { class: "empty" }, "No data yet."));
    } else if (by === "device") tbl = table([{ label: "Device", render: (r) => h("span", {}, r.client_ip, r.username ? h("div", { class: "muted" }, r.username) : null) },
      { label: "Port / protocol", render: portCell }, { label: "Direction", render: (r) => dirBadge(r.direction) },
      { label: "Download", num: true, render: (r) => bytes(r.down) }, { label: "Upload", num: true, render: (r) => bytes(r.up) }, { label: "Apps", key: "apps", wrap: true }], d.rows, "No data yet.");
    else tbl = [h("div", { class: "note" }, "Connections started FROM the internet TO a device in your network (port-forwards, DVR/cameras, servers). Anything you don't recognise deserves a look."),
      table([{ label: "LAN device", render: (r) => h("span", {}, r.client_ip, r.username ? h("div", { class: "muted" }, r.username) : null) },
        { label: "Port / protocol", render: portCell }, { label: "Download", num: true, render: (r) => bytes(r.down) }, { label: "Upload", num: true, render: (r) => bytes(r.up) },
        { label: "Flows", key: "flows", num: true }, { label: "First / last", render: (r) => `${String(r.first).slice(5, 16)} → ${String(r.last).slice(5, 16)}` }], d.rows, "No inbound connections — good.")];
    holder.replaceChildren(tiles, by === "port" || by === "device" || by === "in" ? h("div", { class: "card" }, tbl) : tbl);
  };
  shell("Ports & protocols", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/ports/${k}`, class: k === by ? "active" : "" }, l))),
    card(null, null, h("div", { class: "toolbar" }, by !== "profile" ? days : null, by !== "profile" ? [user, ip] : null, by !== "device" && by !== "in" ? app : null,
      h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
};

// ------------------------------------------------------------------ Firewall (FortiGate / Untangle style): objects, policies, port forwards, countries
const FW_TABS = [["overview", "Overview"], ["policies", "Policies"], ["addresses", "Addresses"], ["services", "Services"], ["schedules", "Schedules"],
  ["vips", "Port forwards"], ["countries", "Countries"], ["lookup", "Policy lookup"], ["logs", "Logs"]];
const fwActionBadge = (a, log) => h("span", { class: "chips" }, badge({ allow: "ALLOW", deny: "DENY", reject: "REJECT" }[a] || a, a === "allow" ? "ok" : a === "deny" ? "bad" : "warn"),
  log ? h("span", { class: "fw-log", title: "every hit is logged (Firewall → Logs)" }, "log") : null);
const fwHits = (x) => x && (x[0] || x[1]) ? h("span", {}, num(x[0]), h("div", { class: "muted small" }, bytes(x[1]))) : h("span", { class: "muted" }, "0");
function fwRef(d, ref) {
  if (ref === "all" || ref === "ALL") return h("span", { class: "muted" }, "all");
  if (ref.startsWith("geo:")) { const cc = ref.slice(4); return h("span", { class: "fw-ref geo", title: d.countries[cc] || cc }, cc, " ", h("small", {}, (d.countries[cc] || "").slice(0, 16))); }
  const a = d.addrs.find((x) => x.name === ref), s = d.services.find((x) => x.name === ref);
  return h("span", { class: "fw-ref", title: (a ? a.entries : s ? s.entries : []).join("\n") }, ref);
}
const fwRefs = (d, list) => h("div", { class: "fw-refs" }, list.map((r) => fwRef(d, r)));

// pick several: address objects + countries, or services. Nothing picked = all.
function fwPicker(options, selected, allLabel = "all", allValue = "all") {
  const sel = new Set((selected || []).filter((x) => x !== allValue));
  const allCb = h("input", { type: "checkbox" });
  const chosen = h("div", { class: "chips" }), list = h("div", { class: "chips fw-pick-list" });
  const q = h("input", { type: "search", placeholder: "Search to add (e.g. a country)…", "aria-label": "search" });
  const draw = () => {
    allCb.checked = !sel.size;
    chosen.replaceChildren(...(sel.size ? [...sel].map((v) => {
      const o = options.find((x) => x.value === v) || { label: v };
      return h("span", { class: "chip on" }, o.label, h("button", { type: "button", class: "chip-x", title: "remove", onclick: () => { sel.delete(v); draw(); } }, "×"));
    }) : [h("span", { class: "muted small" }, `${allLabel} — or add from the list below`)]));
    const term = q.value.trim().toLowerCase();
    list.replaceChildren(...options.filter((o) => !sel.has(o.value) && (term ? `${o.value} ${o.label} ${o.sub || ""}`.toLowerCase().includes(term) : o.pop !== false)).slice(0, term ? 60 : 30)
      .map((o) => h("button", { type: "button", class: "chip small", title: o.sub || "", onclick: () => { sel.add(o.value); q.value = ""; draw(); } }, "+ ", o.label)));
  };
  q.addEventListener("input", draw);
  allCb.addEventListener("change", () => { if (allCb.checked) sel.clear(); draw(); });
  draw();
  return { el: h("div", { class: "fw-pick" }, h("div", { class: "toolbar" }, h("label", { class: "chip small" }, allCb, allLabel), chosen), q, list), value: () => (sel.size ? [...sel] : [allValue]) };
}
// countries shown before searching (where most attacks come from + common ones here); the rest by search
const FW_POP = ["PK", "CN", "RU", "KP", "IR", "IN", "US", "BR", "VN", "NL", "DE", "UA", "RO", "AE", "SA", "GB"];
const fwCountryOptions = (d) => [...FW_POP.filter((cc) => d.countries[cc]), ...Object.keys(d.countries).filter((cc) => !FW_POP.includes(cc)).sort((a, b) => d.countries[a].localeCompare(d.countries[b]))]
  .map((cc) => ({ value: `geo:${cc}`, label: `${cc} · ${d.countries[cc]}`, sub: `country ${d.countries[cc]}${d.geo.counts[cc] ? ` — ${d.geo.counts[cc]} networks` : ""}`, pop: FW_POP.includes(cc) }));
const fwAddrOptions = (d) => [...d.addrs.map((a) => ({ value: a.name, label: a.name, sub: a.entries.slice(0, 6).join(", ") })), ...fwCountryOptions(d)];

function fwPolicyDialog(d, r) {
  r = r || { dir: "out", src: ["all"], dst: ["all"], service: ["ALL"], schedule: "always", action: "deny", log: true, enabled: 1 };
  const name = h("input", { name: "name", required: true, maxlength: 48, value: r.name || "", placeholder: "e.g. Block RDP from the internet" });
  const dir = h("select", {}, Object.entries(d.dirs).map(([k, l]) => h("option", { value: k, selected: k === r.dir }, l)));
  const src = fwPicker(fwAddrOptions(d), r.src), dst = fwPicker(fwAddrOptions(d), r.dst);
  const svc = fwPicker(d.services.map((s) => ({ value: s.name, label: s.name, sub: `${s.entries.join(" ")} — ${s.comment}` })), r.service, "every service", "ALL");
  const sched = h("select", {}, d.schedules.map((s) => h("option", { value: s.name, selected: s.name === r.schedule }, `${s.name} — ${s.comment || s.days.join(",") + " " + s.start + "-" + s.end}`)));
  let action = r.action;
  const actSeg = h("div", { class: "seg" });
  const drawAct = () => actSeg.replaceChildren(...Object.entries(d.actions).map(([k, l]) => h("button", { type: "button", class: k === action ? "on" : "", onclick: () => { action = k; drawAct(); } }, l)));
  drawAct();
  const log = h("input", { type: "checkbox", checked: !!r.log }), on = h("input", { type: "checkbox", checked: r.enabled !== 0 });
  const top = h("input", { type: "checkbox" });
  const comment = h("input", { maxlength: 200, value: r.comment || "", placeholder: "why this policy exists (optional)" });
  const form = h("form", { class: "form fw-form" },
    h("label", { class: "field" }, "Name", name),
    h("label", { class: "field" }, "Direction", dir),
    h("div", { class: "field" }, "Source (who starts the connection)", src.el),
    h("div", { class: "field" }, "Destination", dst.el),
    h("div", { class: "field" }, "Service", svc.el),
    h("label", { class: "field" }, "Schedule", sched),
    h("div", { class: "field" }, "Action", actSeg),
    h("div", { class: "toolbar" }, h("label", { class: "chip" }, log, "Log every hit"), h("label", { class: "chip" }, on, "Policy on"), r.id ? null : h("label", { class: "chip" }, top, "Put it first")),
    h("label", { class: "field" }, "Comment", comment),
    hint("How policies work", h("ul", { class: "g-list" }, h("li", {}, "Top to bottom; the first policy that fits a new connection decides."),
      h("li", {}, h("b", {}, "Allow"), " = stop checking firewall policies (the web filter, security and the router's own rules still apply)."),
      h("li", {}, h("b", {}, "Deny"), " drops silently; ", h("b", {}, "Reject"), " tells the app at once (faster error, no waiting)."),
      h("li", {}, "Nothing fits → the router's own rules decide (normally: allowed)."))));
  dialog(r.id ? `Edit policy #${r.id}` : "New firewall policy", form, [{ label: "Cancel" }, { label: "Save policy", class: "primary", action: async () => {
    if (!form.reportValidity()) return false;
    const res = await act(api("POST", "/api/firewall/rule", { id: r.id || "", name: name.value.trim(), dir: dir.value, src: src.value(), dst: dst.value(), service: svc.value(),
      schedule: sched.value, action, log: log.checked, enabled: on.checked, comment: comment.value.trim(), where: top.checked ? "top" : "" }));
    if (!res) return false;
    route();
  } }]);
}

function fwObjectDialog(kind, o) {
  const isSched = kind === "schedule";
  o = o || { name: "", entries: [], comment: "", days: ["mon", "tue", "wed", "thu", "fri", "sat"], start: "09:00", end: "17:00" };
  const name = h("input", { required: true, maxlength: 32, pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{0,31}", value: o.name, readonly: !!o.name, placeholder: kind === "addr" ? "office" : kind === "service" ? "my-app" : "lunch" });
  const comment = h("input", { maxlength: 200, value: o.comment || "" });
  let body, value;
  if (isSched) {
    const days = DAY_NAMES.map((dd) => h("label", { class: "chip small" }, h("input", { type: "checkbox", value: dd, checked: (o.days || []).includes(dd) }), dd));
    const start = h("input", { type: "time", value: o.start || "09:00", required: true }), end = h("input", { type: "time", value: o.end || "17:00", required: true });
    body = [h("div", { class: "field" }, "Days", h("div", { class: "chips" }, days)), h("div", { class: "toolbar" }, h("label", { class: "field" }, "From", start), h("label", { class: "field" }, "To", end)),
      h("div", { class: "muted small" }, "To earlier than From = over midnight (e.g. 22:00 → 06:00).")];
    value = () => ({ days: days.map((l) => l.querySelector("input")).filter((c) => c.checked).map((c) => c.value), start: start.value, end: end.value });
  } else {
    const ta = h("textarea", { rows: 7, required: true, spellcheck: false, placeholder: kind === "addr" ? "192.168.88.0/24\n10.0.0.5\n10.0.0.20-10.0.0.40\nmail.example.com\ngeo:PK" : "tcp/8080,8443\nudp/5000-5100\nicmp" }, (o.entries || []).join("\n"));
    body = [h("label", { class: "field" }, kind === "addr" ? "Entries (one per line)" : "Protocol / ports (one per line)", ta),
      h("div", { class: "muted small" }, kind === "addr" ? "An IP, a network (10.0.0.0/24), a range (a-b), a website name (the router looks it up), or a country (geo:PK)." : "tcp/80,443 · udp/5000-5100 · icmp · gre · esp — up to 15 ports per line.")];
    value = () => ({ entries: ta.value.split("\n").map((x) => x.trim()).filter(Boolean) });
  }
  const form = h("form", { class: "form" }, h("label", { class: "field" }, "Name", name), ...body, h("label", { class: "field" }, "Comment", comment));
  dialog(`${o.name ? "Edit" : "New"} ${kind === "addr" ? "address" : kind}`, form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
    if (!form.reportValidity()) return false;
    if (!(await act(api("POST", `/api/firewall/${kind}`, { name: name.value.trim(), comment: comment.value.trim(), ...value() })))) return false;
    route();
  } }]);
}

function fwVipDialog(d, v) {
  v = v || { proto: "tcp", src: ["all"], enabled: 1 };
  const name = h("input", { required: true, maxlength: 32, pattern: "[A-Za-z0-9][A-Za-z0-9._\\-]{0,31}", value: v.name || "", placeholder: "DVR" });
  const proto = h("select", {}, ["tcp", "udp", "both"].map((p) => h("option", { value: p, selected: p === v.proto }, p.toUpperCase())));
  const port = h("input", { required: true, value: v.port || "", placeholder: "37777 or 5000-5100", pattern: "\\d{1,5}(-\\d{1,5})?" });
  const to = h("input", { required: true, value: v.to_ip || "", placeholder: "192.168.88.20", pattern: "\\d{1,3}(\\.\\d{1,3}){3}" });
  const toPort = h("input", { value: v.to_port || "", placeholder: "same as outside", pattern: "\\d{1,5}(-\\d{1,5})?" });
  const wan = h("input", { value: v.wan || "", placeholder: "empty = every internet side (e.g. ether1)" });
  const src = fwPicker(fwAddrOptions(d), v.src, "the whole internet");
  const on = h("input", { type: "checkbox", checked: v.enabled !== 0 }), comment = h("input", { maxlength: 200, value: v.comment || "" });
  const form = h("form", { class: "form fw-form" }, h("label", { class: "field" }, "Name", name),
    h("div", { class: "toolbar" }, h("label", { class: "field" }, "Protocol", proto), h("label", { class: "field" }, "Outside port", port)),
    h("div", { class: "toolbar" }, h("label", { class: "field" }, "Inside address", to), h("label", { class: "field" }, "Inside port", toPort)),
    h("div", { class: "field" }, "Allowed from", src.el), h("label", { class: "field" }, "Outside interface", wan),
    h("div", { class: "toolbar" }, h("label", { class: "chip" }, on, "On")), h("label", { class: "field" }, "Comment", comment),
    hint("Safer port forwards", h("ul", { class: "g-list" }, h("li", {}, "Open a port only to the addresses or countries that need it (Allowed from)."),
      h("li", {}, "Never forward RDP (3389), SMB (445), Telnet or databases to the whole internet — use a VPN."))));
  dialog(v.id ? `Edit port forward · ${v.name}` : "New port forward", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => {
    if (!form.reportValidity()) return false;
    if (!(await act(api("POST", "/api/firewall/vip", { id: v.id || "", name: name.value.trim(), proto: proto.value, port: port.value.trim(), to: to.value.trim(),
      to_port: toPort.value.trim() || port.value.trim(), src: src.value(), wan: wan.value.trim(), enabled: on.checked, comment: comment.value.trim() })))) return false;
    route();
  } }]);
}

const fwDo = async (path, confirmText) => {
  if (confirmText && !(await confirmDlg("Firewall", confirmText, "Yes"))) return;
  if (await act(api("POST", path, {}))) route();
};
const FW_TEMPLATES = [
  ["Block RDP, SMB, Telnet, VNC from the internet", "the doors ransomware and hackers use", { name: "Block risky doors from the internet", dir: "in", service: ["RDP", "SMB", "TELNET", "VNC"], action: "deny", log: true }],
  ["Router login only from the LAN", "Winbox / SSH / API refused from the internet", { name: "Router login only from LAN", dir: "wan", service: ["WINBOX", "SSH", "TELNET", "MIKROTIK-API"], action: "reject", log: true }],
  ["No torrents in office hours", "BitTorrent default ports, Mon-Sat 9-17", { name: "No torrents in office hours", dir: "out", service: ["TORRENT"], schedule: "office-hours", action: "reject" }],
  ["Everyone uses the router's DNS", "stops DNS bypass (8.8.8.8, DoT) around the web filter", { name: "Only the router's DNS", dir: "out", service: ["DNS", "DOT"], action: "reject", log: true }],
  ["Block outgoing mail servers (spam bots)", "PCs sending mail directly = usually a virus", { name: "No direct mail sending", dir: "out", service: ["SMTP"], action: "reject", log: true }],
];

ROUTES.firewall = async (tab = "overview", ...rest) => {
  const d = await api("GET", "/api/firewall");
  const counts = { policies: d.rules.length, addresses: d.addrs.length, vips: d.vips.length };
  const tabs = h("div", { class: "tabs" }, FW_TABS.map(([k, l]) => h("a", { href: `#/firewall/${k}`, class: k === tab ? "active" : "" }, l,
    k === "overview" && d.warnings.length ? h("span", { class: "count" }, d.warnings.length) : counts[k] ? h("small", { class: "muted" }, ` ${counts[k]}`) : null)));
  const add = (label, fn) => isAdmin() ? h("button", { class: "primary", onclick: fn }, label) : null;
  let body;
  if (tab === "policies") {
    const q = h("input", { type: "search", placeholder: "Search policies…" });
    let dirF = "";
    const dirSeg = h("select", { "aria-label": "direction" }, [["", "Every direction"], ...Object.entries(d.dirs)].map(([k, l]) => h("option", { value: k }, l)));
    dirSeg.addEventListener("change", () => { dirF = dirSeg.value; draw(); });
    const drawSeg = () => {};
    const holder = h("div");
    const sw = (r) => { const cb = h("input", { type: "checkbox", checked: !!r.enabled, disabled: !isAdmin(), "aria-label": `policy ${r.id} on` });
      cb.addEventListener("change", () => fwDo(`/api/firewall/rule/${r.id}/${cb.checked ? "on" : "off"}`)); return h("label", { class: "switch" }, cb, h("span", { class: "track" })); };
    const draw = () => {
      const term = q.value.trim().toLowerCase();
      const rows = d.rules.filter((r) => (!dirF || r.dir === dirF) && (!term || JSON.stringify([r.name, r.src, r.dst, r.service, r.comment, r.id]).toLowerCase().includes(term)));
      holder.replaceChildren(table([
        { label: "", render: sw },
        { label: "#", render: (r) => h("span", { class: "muted" }, r.seq) },
        { label: "Policy", render: (r) => h("div", { class: "fw-name" }, h("b", {}, r.name), h("div", { class: "muted small" }, d.dirs[r.dir], ` · ID ${r.id}`),
          r.comment ? h("div", { class: "muted small" }, r.comment) : null), wrap: true },
        { label: "Source", render: (r) => fwRefs(d, r.src) }, { label: "Destination", render: (r) => fwRefs(d, r.dst) },
        { label: "Service / when", render: (r) => h("div", {}, fwRefs(d, r.service), r.schedule !== "always" ? h("div", { class: "muted small" }, "⏱ ", r.schedule) : null) },
        { label: "Action", render: (r) => fwActionBadge(r.action, r.log) }, { label: "Hits", num: true, render: (r) => fwHits(r.hits) },
        { label: "", render: (r) => isAdmin() ? h("div", { class: "row-actions fw-acts" },
          h("button", { class: "small", title: "move up", "aria-label": "move up", disabled: r.seq === 1, onclick: () => fwDo(`/api/firewall/rule/${r.id}/up`) }, "↑"),
          h("button", { class: "small", title: "move down", "aria-label": "move down", disabled: r.seq === d.rules.length, onclick: () => fwDo(`/api/firewall/rule/${r.id}/down`) }, "↓"),
          h("button", { class: "small", onclick: () => fwPolicyDialog(d, r) }, "Edit"),
          h("button", { class: "small danger", title: "delete", "aria-label": "delete", onclick: () => fwDo(`/api/firewall/rule/${r.id}/del`, `Delete policy #${r.id} "${r.name}"?`) }, "✕")) : null }],
        rows.map((r) => r), "No policies yet — everything goes to the router's own rules. Start with Overview → Quick start."),
      h("div", { class: "fw-implicit" }, h("b", {}, "Implicit"), " — a connection no policy fits: the router's own rules decide (normally allowed). Web filter and security always apply."));
      holder.querySelectorAll("table").forEach((t) => t.classList.add("rw-table"));
      holder.querySelectorAll("tbody tr").forEach((tr, i) => { if (!rows[i].enabled) tr.classList.add("off"); });
    };
    drawSeg(); q.addEventListener("input", draw); draw();
    body = [card("Firewall policies", "top to bottom — the first that fits decides", h("div", { class: "toolbar" }, add("+ New policy", () => fwPolicyDialog(d)), q, dirSeg), holder)];
  } else if (tab === "addresses") {
    body = [card("Address objects", "named groups: IPs, networks, ranges, website names, countries", h("div", { class: "toolbar" }, add("+ New address", () => fwObjectDialog("addr"))),
      table([{ label: "Name", render: (a) => h("b", {}, a.name) }, { label: "Type", render: (a) => h("span", { class: "chips" }, a.kind.map((k) => badge({ net: "IP / network", range: "range", fqdn: "website name", geo: "country" }[k], k === "geo" ? "info" : ""))) },
        { label: "Entries", render: (a) => h("span", { class: "small" }, a.entries.slice(0, 4).join(", "), a.entries.length > 4 ? h("span", { class: "muted" }, ` +${a.entries.length - 4} more`) : null), wrap: true },
        { label: "Used by", render: (a) => a.used.length ? h("span", { class: "small" }, a.used.join(", ")) : h("span", { class: "muted" }, "not used") },
        { label: "", render: (a) => isAdmin() ? h("div", { class: "row-actions" }, h("button", { class: "small", onclick: () => fwObjectDialog("addr", a) }, "Edit"),
          h("button", { class: "small danger", disabled: a.used.length > 0, title: a.used.length ? "used — change those first" : "", onclick: () => fwDo(`/api/firewall/addr/${encodeURIComponent(a.name)}/del`, `Delete address "${a.name}"?`) }, "Delete")) : null }],
      d.addrs, "No address objects yet."))];
  } else if (tab === "services" || tab === "schedules") {
    const kind = tab === "services" ? "service" : "schedule", list = tab === "services" ? d.services : d.schedules;
    body = [card(tab === "services" ? "Services" : "Schedules", tab === "services" ? "protocol + ports; built-in ones cannot change" : "when a policy works",
      h("div", { class: "toolbar" }, add(`+ New ${kind}`, () => fwObjectDialog(kind))),
      table([{ label: "Name", render: (s) => h("span", {}, h("b", {}, s.name), s.builtin ? h("span", {}, " ", badge("built-in")) : null) },
        { label: tab === "services" ? "Protocol / ports" : "When", render: (s) => tab === "services" ? h("code", {}, s.entries.join("  ")) : s.start ? `${s.days.join(",")}  ${s.start}–${s.end}` : "always" },
        { label: "What", render: (s) => h("span", { class: "small muted" }, s.comment || ""), wrap: true },
        { label: "Used by", render: (s) => s.used.length ? h("span", { class: "small" }, s.used.join(", ")) : h("span", { class: "muted" }, "—") },
        { label: "", render: (s) => isAdmin() && !s.builtin ? h("div", { class: "row-actions" }, h("button", { class: "small", onclick: () => fwObjectDialog(kind, s) }, "Edit"),
          h("button", { class: "small danger", disabled: s.used.length > 0, onclick: () => fwDo(`/api/firewall/${kind}/${encodeURIComponent(s.name)}/del`, `Delete ${kind} "${s.name}"?`) }, "Delete")) : null }],
      list))];
  } else if (tab === "vips") {
    const sw = (v) => { const cb = h("input", { type: "checkbox", checked: !!v.enabled, disabled: !isAdmin(), "aria-label": `port forward ${v.name} on` });
      cb.addEventListener("change", () => fwDo(`/api/firewall/vip/${v.id}/${cb.checked ? "on" : "off"}`)); return h("label", { class: "switch" }, cb, h("span", { class: "track" })); };
    body = [card("Port forwards (virtual IPs)", "outside port → a device inside", h("div", { class: "toolbar" }, add("+ New port forward", () => fwVipDialog(d)),
      h("a", { href: "#/security/inbound" }, "Who came in from outside →")),
      table([{ label: "", render: sw }, { label: "Name", render: (v) => h("b", {}, v.name) },
        { label: "Outside", render: (v) => h("code", {}, `${v.proto.toUpperCase()} ${v.port}`) }, { label: "→ Inside", render: (v) => h("code", {}, `${v.to_ip}:${v.to_port}`) },
        { label: "Allowed from", render: (v) => v.open_all ? badge("the whole internet", v.risk ? "bad" : "warn") : fwRefs(d, v.src) },
        { label: "Risk", render: (v) => v.risk ? badge(v.risk, "bad") : h("span", { class: "muted" }, "—") }, { label: "Hits", num: true, render: (v) => fwHits(v.hits) },
        { label: "", render: (v) => isAdmin() ? h("div", { class: "row-actions" }, h("button", { class: "small", onclick: () => fwVipDialog(d, v) }, "Edit"),
          h("button", { class: "small danger", onclick: () => fwDo(`/api/firewall/vip/${v.id}/del`, `Delete port forward "${v.name}"? The device is no longer reachable from outside.`) }, "Delete")) : null }],
      d.vips, "No port forwards made here. (Ones made on the router by hand show in Security → From outside.)"))];
  } else if (tab === "countries") {
    body = await fwCountries(d);
  } else if (tab === "lookup") {
    body = fwLookup(d, rest);
  } else if (tab === "logs") {
    body = await fwLogs(d, rest[0]);
  } else {
    body = await fwOverview(d);
  }
  shell("Firewall", h("div", { class: "stack" }, tabs, ...[].concat(body)));
  document.querySelectorAll(".content table").forEach((t) => t.classList.add("rw-table"));
};

async function fwOverview(d) {
  const on = d.rules.filter((r) => r.enabled), deny = on.filter((r) => r.action !== "allow");
  const hits = d.rules.reduce((s, r) => s + Number(r.hits[0] || 0), 0);
  const openAll = d.vips.filter((v) => v.enabled && v.open_all).length;
  const logs = await api("GET", "/api/firewall/logs?days=1").catch(() => ({ rows: [], by_rule: [], top_sources: [] }));
  const status = d.warnings.length ? "warn" : "ok";
  const busiest = [...d.rules].filter((r) => r.hits[0]).sort((a, b) => b.hits[0] - a.hits[0]).slice(0, 6);
  return [
    h("div", { class: `card health-hero ${status}` }, h("div", { class: "hh-mark" }, d.warnings.length ? "!" : "✔"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, d.warnings.length ? `${d.warnings.length} thing(s) to look at` : on.length ? "Firewall is working" : "No firewall policies yet"),
        h("div", { class: "muted" }, `${on.length} of ${d.rules.length} policies on (${deny.length} blocking) · ${d.vips.length} port forward(s) · ${d.geo.used.length} countries in use · routers took the rules ${d.built || "—"}`))),
    h("div", { class: "grid g-tiles" }, tile("Policies on", `${on.length} / ${d.rules.length}`, `${deny.length} deny / reject`),
      tile("Hits", num(hits), d.routers.length ? `${d.routers.length} router(s) reporting` : "routers not reporting yet (auto-sync script)"),
      tile("Blocked today (logged)", num(logs.rows.length), logs.top_sources[0] ? `most: ${logs.top_sources[0].ip} ${logs.top_sources[0].country || ""}` : "nothing logged"),
      tile("Port forwards", num(d.vips.length), openAll ? `${openAll} open to the whole internet` : "none open to everyone"),
      tile("Countries", num(d.geo.used.length), d.geo.updated ? `lists from ${d.geo.updated.slice(0, 10)}` : "lists not downloaded")),
    d.warnings.length ? card("Needs attention", null, h("ul", { class: "g-list" }, d.warnings.map((w) => h("li", {}, w.text, " ",
      h("a", { href: w.kind === "geo" ? "#/firewall/countries" : "#/firewall/vips" }, "Open →"))))) : null,
    h("div", { class: "grid g-2" },
      card("Quick start", "common policies — check, then save", h("div", { class: "stack" }, FW_TEMPLATES.map(([t, sub, preset]) => h("div", { class: "fw-tpl" },
        h("div", {}, h("b", {}, t), h("div", { class: "muted small" }, sub)),
        isAdmin() ? h("button", { class: "small", onclick: () => fwPolicyDialog(d, { src: ["all"], dst: ["all"], schedule: "always", enabled: 1, ...preset }) }, "Set up") : null)),
        h("div", { class: "fw-tpl" }, h("div", {}, h("b", {}, "Block whole countries"), h("div", { class: "muted small" }, "attacks from abroad, or LAN to some countries")), h("button", { class: "small", onclick: () => { location.hash = "#/firewall/countries"; } }, "Open")))),
      card("Busiest policies", "hits since the routers last took new rules", busiest.length ? h("div", { class: "fw-bars" }, busiest.map((r) => {
        const bar = h("i"); bar.style.width = `${Math.max(2, (r.hits[0] / busiest[0].hits[0]) * 100)}%`;
        return h("a", { class: "fw-bar", href: "#/firewall/policies" }, h("span", { class: "fw-bar-name" }, `#${r.id} ${r.name}`), h("span", { class: "fw-bar-track" }, bar),
          h("span", { class: "fw-bar-n" }, num(r.hits[0]), " ", fwActionBadge(r.action)));
      })) : h("div", { class: "empty" }, "No hits reported yet."))),
    card("Last blocked (logged)", h("a", { href: "#/firewall/logs" }, "all logs →"), table([{ label: "Time", render: (r) => r.time.slice(5) }, { label: "Policy", render: (r) => `#${r.rule} ${r.policy}` },
      { label: "From", render: (r) => h("span", {}, h("code", {}, r.src), r.country ? h("span", { class: "muted" }, ` ${r.country}`) : null) },
      { label: "To", render: (r) => h("code", {}, `${r.dst}${r.port ? ":" + r.port : ""}`) }, { label: "Proto", key: "proto" }], logs.rows.slice(0, 8), "Nothing logged today (turn on 'Log every hit' in a policy).")),
  ];
}

async function fwCountries(d) {
  const find = (n) => d.rules.find((r) => r.name === n);
  const inRule = find("Country block (in)"), outRule = find("Country block (out)");
  const pick = (r, key) => fwPicker(fwCountryOptions(d), r ? r[key] : [], "none");
  const pIn = pick(inRule, "src"), pOut = pick(outRule, "dst");
  const save = async (name, rule, p, dir, key) => {
    const v = p.value().filter((x) => x !== "all");
    if (!v.length) { if (rule) await fwDo(`/api/firewall/rule/${rule.id}/del`); else toast("Pick at least one country"); return; }
    if (await act(api("POST", "/api/firewall/rule", { id: rule ? rule.id : "", name, dir, src: key === "src" ? v : ["all"], dst: key === "dst" ? v : ["all"], service: ["ALL"],
      schedule: "always", action: "deny", log: true, enabled: true, where: "top" }))) route();
  };
  const total = Object.values(d.geo.counts).reduce((a, b) => a + b, 0);
  return [
    card("Country lists (Geo-IP)", d.geo.updated ? `updated ${d.geo.updated}` : "not downloaded yet",
      h("div", { class: "toolbar" }, h("span", {}, d.geo.updated ? `${Object.keys(d.geo.counts).length} countries, ${num(total)} networks — ${d.geo.source}` : "Download the lists once; they refresh every week by themselves."),
        isAdmin() ? h("button", { class: d.geo.updated ? "small" : "primary", onclick: async (e) => { e.target.disabled = true; e.target.textContent = "Downloading… (1-2 min)";
          if (await act(api("POST", "/api/firewall/geo-update", {}))) route(); else { e.target.disabled = false; e.target.textContent = "Download now"; } } }, "Download now") : null),
      h("div", { class: "muted small" }, "From the five regional internet registries (who gives each country its addresses). Routers get only the countries you use, and only when they change.")),
    h("div", { class: "grid g-2" },
      card("Block FROM these countries", "internet → your LAN and the routers (attacks, scans, logins)", pIn.el,
        isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => save("Country block (in)", inRule, pIn, "wan", "src") }, "Save"), inRule ? h("span", { class: "muted small" }, `policy #${inRule.id}, first in the list`) : null) : null),
      card("Block TO these countries", "your LAN → websites / servers in these countries", pOut.el,
        isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => save("Country block (out)", outRule, pOut, "out", "dst") }, "Save"), outRule ? h("span", { class: "muted small" }, `policy #${outRule.id}`) : null) : null)),
    card("Countries in use", "by policies, address objects and port forwards", table([{ label: "Country", render: (cc) => h("span", {}, h("b", {}, cc), ` ${d.countries[cc]}`) },
      { label: "Networks", num: true, render: (cc) => d.geo.counts[cc] ? num(d.geo.counts[cc]) : badge("no list yet", "warn") }], d.geo.used, "No country used yet.")),
    hint("Good to know", h("ul", { class: "g-list" }, h("li", {}, "A big country (US, CN) is thousands of networks: the router takes a minute to load it the first time."),
      h("li", {}, "Allow your own country in a port forward: Port forwards → Allowed from → PK."), h("li", {}, "VPN users abroad come from their VPN's country, not where they are."))),
  ];
}

function fwLookup(d, pre) {
  const dir = h("select", {}, Object.entries(d.lookup_dirs).map(([k, l]) => h("option", { value: k, selected: k === (pre[0] || "in") }, l)));
  const src = h("input", { required: true, placeholder: "e.g. 1.2.3.4", value: pre[1] || "", pattern: "\\d{1,3}(\\.\\d{1,3}){3}" });
  const dst = h("input", { required: true, placeholder: "e.g. 192.168.88.20", value: pre[2] || "", pattern: "\\d{1,3}(\\.\\d{1,3}){3}" });
  const proto = h("select", {}, ["tcp", "udp", "icmp"].map((p) => h("option", { value: p }, p.toUpperCase())));
  const port = h("input", { type: "number", min: 0, max: 65535, placeholder: "443", value: pre[3] || "" });
  const out = h("div");
  const form = h("form", { class: "toolbar fw-lookup", onsubmit: async (e) => {
    e.preventDefault();
    try {
      const r = await api("GET", `/api/firewall/lookup?${new URLSearchParams({ dir: dir.value, src: src.value.trim(), dst: dst.value.trim(), proto: proto.value, port: port.value || 0 })}`);
      const v = r.verdict;
      out.replaceChildren(h("div", { class: `card health-hero ${v === "allow" ? "ok" : v === "no-policy" ? "" : "fail"}` }, h("div", { class: "hh-mark" }, v === "allow" ? "✔" : v === "no-policy" ? "–" : "✘"),
        h("div", { class: "grow" }, h("div", { class: "hh-title" }, v === "no-policy" ? "No firewall policy fits" : `${v.toUpperCase()} by policy #${r.rule} "${r.name}"`),
          h("div", { class: "muted" }, `from ${src.value} (${r.countries[0] || "?"}) to ${dst.value} (${r.countries[1] || "?"})`, v === "no-policy" ? " — the router's own rules decide (normally allowed)." : ""))),
        card("Checked in order", null, table([{ label: "#", render: (x) => `#${x.id}` }, { label: "Policy", key: "name" },
          { label: "", render: (x) => x.match ? badge("FITS", "ok") : h("span", { class: "muted" }, "—") }, { label: "Why", key: "why", wrap: true }], r.steps, "No policies.")));
    } catch (err) { toast(err.message, true); }
  } }, h("label", { class: "field" }, "Direction", dir), h("label", { class: "field" }, "Source IP", src), h("label", { class: "field" }, "Destination IP", dst),
    h("label", { class: "field" }, "Protocol", proto), h("label", { class: "field" }, "Port", port), h("button", { class: "primary", type: "submit" }, "Check"));
  return [card("Policy lookup", "which policy takes a connection — test before you change", form,
    h("div", { class: "muted small" }, "Uses the saved policies and country lists; website names in address objects are not looked up here.")), out];
}

async function fwLogs(d, rule = "") {
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const pol = h("select", {}, h("option", { value: "" }, "All policies"), d.rules.map((r) => h("option", { value: r.id, selected: String(r.id) === String(rule) }, `#${r.id} ${r.name}`)));
  const holder = h("div", { class: "stack" });
  const load = async () => {
    const r = await api("GET", `/api/firewall/logs?${new URLSearchParams({ days: days.value, rule: pol.value })}`);
    holder.replaceChildren(
      h("div", { class: "grid g-2" },
        card("By policy", null, table([{ label: "Policy", render: (x) => `#${x.rule} ${x.policy}` }, { label: "Hits", key: "count", num: true }], r.by_rule, "Nothing.")),
        card("Top sources", null, table([{ label: "Address", render: (x) => h("code", {}, x.ip) }, { label: "Country", render: (x) => x.country ? `${x.country} ${d.countries[x.country] || ""}` : "—" },
          { label: "Hits", key: "count", num: true }], r.top_sources, "Nothing."))),
      card("Log", `${r.rows.length} newest`, table([{ label: "Time", key: "time" }, { label: "Policy", render: (x) => `#${x.rule} ${x.policy}` },
        { label: "Action", render: (x) => fwActionBadge(x.action) }, { label: "Proto", key: "proto" },
        { label: "From", render: (x) => h("span", {}, h("code", {}, x.src), x.country ? h("span", { class: "muted" }, ` ${x.country}`) : null) },
        { label: "To", render: (x) => h("code", {}, `${x.dst}${x.port ? ":" + x.port : ""}`) }, { label: "Router", key: "router" }], r.rows,
        "Nothing logged. Only policies with 'Log every hit' write here.")));
    holder.querySelectorAll("table").forEach((t) => t.classList.add("rw-table"));
  };
  days.addEventListener("change", load); pol.addEventListener("change", load);
  await load();
  return [card(null, null, h("div", { class: "toolbar" }, days, pol)), holder];
}

// ------------------------------------------------------------------ intrusion prevention (Suricata on the routers' traffic copy)
async function ipsPage(tabs) {
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"]].map(([v, l]) => h("option", { value: v }, l)));
  const holder = h("div", { class: "stack" });
  const sevBadge = (s) => badge(s === "high" ? "HIGH" : s === "medium" ? "medium" : "low", s === "high" ? "bad" : s === "medium" ? "warn" : "");
  const doIt = async (action, data, confirmText) => {
    if (confirmText && !(await confirmDlg("Intrusion prevention", confirmText, "Yes", false))) return;
    if (await act(api("POST", `/api/ips/${action}`, data || {}))) load();
  };
  const where = (ip, cc, d) => h("span", {}, h("code", {}, ip), cc && cc !== "LAN" ? h("span", { class: "muted small" }, ` ${cc}`) : cc === "LAN" ? h("span", { class: "muted small" }, " LAN") : null);
  const load = async () => {
    const d = await api("GET", `/api/ips?days=${days.value}`);
    const st = d.status || {}, cp = st.copy || {}, se = d.settings;
    const high = (d.counts.high || {}).hits || 0, med = (d.counts.medium || {}).hits || 0;
    let state, title, sub;
    if (!st.installed) { state = "warn"; title = "Suricata is not installed"; sub = "Install it once (button below or: sudo radius-admin ips install). 4 GB RAM or more is best."; }
    else if (!se.on) { state = "warn"; title = "Intrusion prevention is off"; sub = "Turn it on: the routers start sending a copy of internet traffic to this server."; }
    else if (!st.running) { state = "fail"; title = "Suricata is not running"; sub = "Restart it below; if it stops again see /var/log/suricata/suricata.log."; }
    else if (!cp.receiving) { state = "warn"; title = "Waiting for the routers' traffic copy"; sub = `Routers send it after the next auto-sync (15 min). Needs the server IP (${se.server_ip || "not set"}) and UDP 37008 open to this server.`; }
    else { state = high ? "fail" : "ok"; title = high ? `${num(high)} high-level attack(s) seen` : "Watching — no high-level attack"; sub = `${num(st.rules)} signatures · copy from ${cp.routers.join(", ")} · ${num(d.blocks.length)} address(es) blocked now`; }
    const sw = (label, help, on, action, extra) => h("label", { class: "check" + (on ? " on" : "") }, h("input", { type: "checkbox", checked: on, disabled: !isAdmin(),
      onchange: (e) => doIt(action, { on: e.target.checked, ...(extra || {}) }) }), h("div", {}, h("b", {}, label), h("span", {}, help)));
    const lvl = h("select", { disabled: !isAdmin(), onchange: (e) => doIt("level", { level: e.target.value }) }, [["high", "high only"], ["medium", "high + medium"]].map(([v, l]) => h("option", { value: v, selected: v === se.level }, l)));
    const hrs = h("select", { disabled: !isAdmin(), onchange: (e) => doIt("hours", { hours: e.target.value }) }, [1, 6, 24, 72, 168, 720].map((v) => h("option", { value: v, selected: v === se.hours }, v < 24 ? `${v} h` : `${v / 24} day(s)`)));
    const mir = h("select", { disabled: !isAdmin(), onchange: (e) => doIt("mirror", { mirror: e.target.value }) }, [["first", "first 256 KB of each connection (light)"], ["all", "all internet traffic (heavy)"]].map(([v, l]) => h("option", { value: v, selected: v === se.mirror }, l)));
    holder.replaceChildren(
      h("div", { class: `card health-hero ${state}` }, h("div", { class: "hh-mark" }, state === "ok" ? "✔" : "!"),
        h("div", { class: "grow" }, h("div", { class: "hh-title" }, title), h("div", { class: "muted" }, sub)),
        isAdmin() ? h("div", { class: "toolbar" },
          !st.installed ? h("button", { class: "primary", onclick: (e) => { e.target.disabled = true; e.target.textContent = "Installing… (a few minutes)"; doIt("install"); } }, "Install Suricata")
          : !se.on ? h("button", { class: "primary", onclick: () => doIt("on") }, "Turn on")
          : h("button", { class: "small", onclick: () => doIt("off", {}, "Turn intrusion prevention off? Blocked addresses run out by themselves.") }, "Turn off"),
          st.installed && se.on && !st.running ? h("button", { class: "small", onclick: () => doIt("restart") }, "Restart") : null) : null),
      h("div", { class: "grid g-tiles" }, tile("High level", num(high), `${num((d.counts.high || {}).sources || 0)} source(s)`), tile("Medium", num(med), "watch"),
        tile("Blocked now", num(d.blocks.length), se.autoblock ? `auto: ${se.level === "high" ? "high" : "high + medium"}, ${se.hours < 24 ? se.hours + " h" : se.hours / 24 + " day(s)"}` : "auto-block off"),
        tile("Signatures", num(st.rules || 0), st.rules_updated ? `updated ${st.rules_updated.slice(0, 10)}` : "not downloaded"),
        tile("Traffic copy", cp.receiving ? "receiving" : "—", cp.packets ? `${num(cp.packets)} packets` : "nothing yet")),
      card("Protection", null, h("div", { class: "checks" },
        sw("Block attackers by itself", "An outside address that attacks is dropped on every router within a minute; for an infected device inside, the server it talks to.", se.autoblock, "autoblock")),
        h("div", { class: "toolbar ips-opts" }, h("label", { class: "field" }, "Block level", lvl), h("label", { class: "field" }, "Block for", hrs), h("label", { class: "field" }, "Routers copy", mir),
          isAdmin() ? h("button", { class: "small", onclick: (e) => { e.target.disabled = true; doIt("update"); } }, "Update signatures now") : null)),
      (() => {
        const md = st.mode || { mode: "copy" }, il = st.inline || {}, inline = md.mode === "inline";
        const ifs = d.ifaces || [];
        const opt = (sel) => ifs.map((i) => h("option", { value: i.name, selected: i.name === sel, disabled: i.default },
          `${i.name}${i.ip ? " — " + i.ip : ""}${i.default ? " (server's own link)" : ""}${i.up ? "" : " (no cable)"}`));
        const wan = h("select", { disabled: !isAdmin() || inline }, opt(md.wan)), lan = h("select", { disabled: !isAdmin() || inline }, opt(md.lan || (ifs[1] || {}).name));
        const state = !inline ? null : il.bypass ? badge(il.manual ? "BYPASS (by hand) — traffic NOT checked" : `BYPASS — ${il.reason || "Suricata not passing traffic"}`, "bad")
          : badge(md.drop ? "inline: attacks STOPPED" : "inline: alert only (test)", md.drop ? "ok" : "warn");
        return card("Mode", inline ? "Suricata is in the traffic path" : "the routers send a copy", h("div", { class: "stack" },
          h("div", { class: "grid g-2 ips-modes" },
            h("div", { class: "ips-mode" + (inline ? "" : " on") }, h("b", {}, "Copy (safe, default)"),
              h("div", { class: "muted small" }, "Routers send a copy; attackers are blocked ~0.25 s – 1 min later. The first packets of an attack get through. Nothing can stop your internet.")),
            h("div", { class: "ips-mode" + (inline ? " on" : "") }, h("b", {}, "Inline (like Fortinet)"),
              h("div", { class: "muted small" }, "Cable: MikroTik → server card 1, server card 2 → LAN switch. Suricata passes every packet and stops an attack at its first packet. If Suricata stops or sticks, the server joins the two cards by itself within ~3 s (bypass), so the internet keeps working."))),
          inline ? h("div", { class: "toolbar" }, state, h("span", { class: "muted small" }, `${md.wan} (MikroTik side) ⇄ ${md.lan} (LAN side)`),
            il.held ? badge("3 failures in 10 min: staying on bypass", "bad") : null) : null,
          isAdmin() ? (inline
            ? h("div", { class: "toolbar" },
                h("div", { class: "seg" }, h("button", { type: "button", class: md.drop ? "" : "on", onclick: () => !md.drop || doIt("inline", { what: "alert" }) }, "Alert only (test)"),
                  h("button", { type: "button", class: md.drop ? "on" : "", onclick: () => md.drop || doIt("inline", { what: "drop" }, "Stop attacks now? Traffic matching a high-level signature is dropped at once — watch Alerts for a few days in test mode first.") }, "Stop attacks")),
                h("button", { class: "small", onclick: () => doIt("bypass", { on: !il.manual }, il.manual ? null : "Let all traffic pass unchecked (bypass) until you turn it off?") }, il.manual ? "Bypass off" : "Bypass on (maintenance)"),
                h("button", { class: "small danger", onclick: () => doIt("inline", { what: "off" }, "Back to copy mode? Turn bypass on first and move the cable back (LAN switch → MikroTik), or the LAN loses the internet.") }, "Back to copy mode"))
            : h("div", { class: "toolbar ips-opts" }, h("label", { class: "field" }, "Card to the MikroTik", wan), h("label", { class: "field" }, "Card to the LAN switch", lan),
                h("button", { class: "primary", disabled: ifs.length < 2, onclick: () => doIt("inline", { what: "on", wan: wan.value, lan: lan.value, drop: false },
                  `Go inline between ${wan.value} and ${lan.value}? Plug the cables first. It starts in alert-only test mode.`) }, "Go inline (test mode)"),
                ifs.length < 2 ? h("span", { class: "muted small" }, "needs two network cards (a third one for managing the server is best)") : null)) : null));
      })(),
      (() => {
        const routers = d.api_routers || [];
        const addOne = async () => {
          const ip = h("input", { placeholder: "router IP, e.g. 192.168.88.1", required: true, pattern: "\\d{1,3}(\\.\\d{1,3}){3}" });
          const plain = h("input", { type: "checkbox" });
          const form = h("form", { class: "form" }, h("label", { class: "field" }, "Router address (as this server reaches it)", ip),
            h("label", { class: "chip" }, plain, "without TLS (port 8728) — only on a trusted LAN"));
          dialog("Instant blocks on a router", form, [{ label: "Cancel" }, { label: "Make the router script", class: "primary", action: async () => {
            if (!form.reportValidity()) return false;
            const r = await act(api("POST", "/api/ips/api-add", { router: ip.value.trim(), plain: plain.checked }));
            if (!r) return false;
            const box = h("pre", { class: "code-box" }, r.script);
            dialog(`Paste on the router ${ip.value.trim()} (Terminal)`, h("div", { class: "stack" },
              h("div", { class: "muted small" }, "A user that may only use the API, only from this server; the API (TLS) only for this server. Then press Test."), box),
              [{ label: "Copy", action: async () => { try { await navigator.clipboard.writeText(r.script); toast("Copied"); } catch { toast("Select the text and copy it", true); } return false; } },
               { label: "Done", class: "primary", action: () => { load(); } }]);
          } }]);
        };
        return card("Instant blocks (router API)", "~1 second instead of up to 2 minutes", h("div", { class: "stack" },
          table([{ label: "Router", render: (r) => h("code", {}, r.ip) }, { label: "How", render: (r) => r.plain ? badge("API 8728 (no TLS)", "warn") : `API-SSL ${r.port}` },
            { label: "Status", render: (r) => r.status === "ok" ? badge("working", "ok") : r.status && r.status.startsWith("failed") ? h("span", { class: "small" }, badge("failed", "bad"), " ", r.status.slice(8)) : h("span", { class: "muted small" }, r.status || "—"), wrap: true },
            { label: "Last", render: (r) => (r.last || "").slice(5, 16) || "—" },
            { label: "", render: (r) => isAdmin() ? h("div", { class: "row-actions" }, h("button", { class: "small", onclick: () => doIt("api-test", { router: r.ip }) }, "Test"),
              h("button", { class: "small danger", onclick: () => doIt("api-del", { router: r.ip }, `Stop instant blocks on ${r.ip}? The 1-minute list keeps working.`) }, "Remove")) : null }],
            routers, "No router yet — blocks reach the routers through the 1-minute list."),
          isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: addOne }, "+ Add a router"),
            h("span", { class: "muted small" }, "The server puts a blocked attacker straight into the router's list the moment Suricata sees it.")) : null));
      })(),
      card("What it saw", "by signature — switch one off if it is a false alarm", table([
        { label: "Level", render: (r) => sevBadge(r.severity) }, { label: "What", render: (r) => h("span", {}, h("b", {}, r.words), h("div", { class: "muted small" }, r.signature)), wrap: true },
        { label: "Hits", key: "hits", num: true }, { label: "Sources", key: "sources", num: true }, { label: "Last", render: (r) => String(r.last).slice(5, 16) },
        { label: "", render: (r) => isAdmin() ? h("button", { class: "small", onclick: () => doIt("rule", { sid: r.sid, on: r.off }, r.off ? null : `Switch signature ${r.sid} off? It will not alert or block any more.`) }, r.off ? "Switch on" : "Switch off") : null }],
        d.top, "Nothing seen in this period.")),
      card("Alerts", `${d.rows.length} newest`, table([
        { label: "Time", render: (r) => String(r.last).slice(5, 16) }, { label: "Level", render: (r) => sevBadge(r.severity) },
        { label: "What", render: (r) => h("span", {}, h("b", {}, r.words), h("div", { class: "muted small" }, r.signature)), wrap: true },
        { label: "From", render: (r) => where(r.src_ip, r.src_cc) }, { label: "To", render: (r) => h("span", {}, where(r.dst_ip, r.dst_cc), r.dst_port ? h("span", { class: "muted small" }, ` :${r.dst_port}`) : null, r.user ? h("div", { class: "muted small" }, r.user) : null) },
        { label: "Hits", key: "hits", num: true }, { label: "", render: (r) => r.blocked ? badge("blocked", "ok") : null }], d.rows, "No alerts.")),
      h("div", { class: "stack" },
        card("Blocked now", "dropped on every router", table([{ label: "Address", render: (r) => where(r.ip, r.cc) }, { label: "Why", render: (r) => h("span", { class: "small" }, r.reason), wrap: true },
          { label: "Until", render: (r) => String(r.until).slice(5, 16) }, { label: "", render: (r) => isAdmin() ? h("div", { class: "row-actions" },
            h("button", { class: "small", onclick: () => doIt("unblock", { ip: r.ip }) }, "Unblock"),
            h("button", { class: "small", title: "never block this address", onclick: () => doIt("allow", { ip: r.ip, reason: "false alarm" }, `Never block ${r.ip} again?`) }, "Never block")) : null }], d.blocks, "Nothing blocked.")),
        card("Never blocked", "your partners, monitoring, own servers", h("div", { class: "stack" },
          table([{ label: "Address", render: (r) => h("code", {}, r.ip) }, { label: "Note", key: "comment" },
            { label: "", render: (r) => isAdmin() ? h("button", { class: "small", onclick: () => doIt("disallow", { ip: r.ip }) }, "Remove") : null }], d.allow, "None — routers and this server are never blocked anyway."),
          isAdmin() ? (() => { const ip = h("input", { placeholder: "IP address", "aria-label": "IP" }); return h("div", { class: "toolbar" }, ip,
            h("button", { class: "small", onclick: () => ip.value.trim() && doIt("allow", { ip: ip.value.trim(), reason: "added in the dashboard" }) }, "Add"),
            h("button", { class: "small danger", onclick: () => ip.value.trim() && doIt("block", { ip: ip.value.trim() }, `Block ${ip.value.trim()} on every router for 30 days?`) }, "Block it")); })() : null))),
      hint("How it works", h("ul", { class: "g-list" },
        h("li", {}, "The routers send a copy of internet traffic (TZSP) to this server; Suricata checks it against tens of thousands of attack signatures (Emerging Threats, updated daily) and our own rules."),
        h("li", {}, "It sees the copy, so the first packets of an attack get through; the attacker is blocked a few seconds to a minute later on every router."),
        h("li", {}, "It cannot read inside HTTPS, but still knows bad servers, scans, password guessing, exploits and infected devices by their behaviour."),
        h("li", {}, "Infected devices inside also show under Virus and can be cut off by quarantine."))));
    holder.querySelectorAll("table").forEach((t) => t.classList.add("rw-table"));
  };
  days.addEventListener("change", load);
  shell("Security", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/security/${k}`, class: k === "ips" ? "active" : "" }, l))),
    card(null, null, h("div", { class: "toolbar" }, days)), holder));
  await load();
}

// ------------------------------------------------------------------ mail server on the LAN (MDaemon …): checks + protection
ROUTES.mail = async () => {
  const d = await api("GET", "/api/mail?days=7");
  const se = d.settings, res = d.result || { checks: [] };
  const doIt = async (action, data) => { if (await act(api("POST", `/api/mail/${action}`, data || {}))) route(); };
  const settingsForm = () => {
    const f = (name, label, value, ph, help) => h("label", { class: "field" }, label, h("input", { name, value: value || "", placeholder: ph }), help ? h("small", { class: "muted" }, help) : null);
    const form = h("form", { class: "form mail-form", onsubmit: async (e) => { e.preventDefault(); const b = e.target.querySelector("button[type=submit]"); b.disabled = true; b.textContent = "Saving and checking…";
      if (await act(api("POST", "/api/mail/settings", formValues(form)))) route(); else { b.disabled = false; b.textContent = "Save and check"; } } },
      h("div", { class: "grid g-2" }, f("ip", "Mail server's LAN address", se.ip, "192.168.88.30", "the MDaemon machine inside your network"),
        f("domain", "Your mail domain", se.domain, "example.com"), f("host", "Mail server name (MX)", se.host, "mail.example.com", "empty = mail.DOMAIN"),
        f("public", "Public IP (optional)", se.public_ip, "found from DNS", "the internet address your mail comes from"),
        f("dkim", "DKIM selector", se.dkim, "MDaemon", "MDaemon: Security → Sender Authentication → DKIM"),
        f("webmail", "Webmail port inside", String(se.webmail || 3000), "3000", "MDaemon Webmail (WorldClient) default 3000")),
      h("div", { class: "toolbar" }, h("button", { class: "primary", type: "submit", disabled: !isAdmin() }, "Save and check")));
    return form;
  };
  if (!se.ip || !se.domain) {
    shell("Mail server", h("div", { class: "stack" }, card("Your mail server", "MDaemon, Exchange, Zimbra … on the LAN behind the MikroTik", settingsForm(),
      hint("What you get", h("ul", { class: "g-list" }, h("li", {}, "Safe doors: only the mail ports open (25, 587, 465, 993, 995, webmail over HTTPS); never the admin port 1000."),
        h("li", {}, "Password guessing stopped on the routers; only the mail server may send mail out (spam bots on PCs cannot)."),
        h("li", {}, "Every hour: MX, SPF, DMARC, DKIM, reverse DNS, 8 blacklists, certificates, unusual outgoing mail — with what to do."))))));
    return;
  }
  const checks = res.checks || [], bad = checks.filter((c) => c.status === "fail"), warn = checks.filter((c) => c.status === "warn");
  const state = bad.length ? "fail" : warn.length ? "warn" : "ok";
  const groups = [...new Set(checks.map((c) => c.group))];
  const mark = (s) => h("span", { class: "health-mark" }, s === "ok" ? "✔" : s === "warn" ? "!" : "✘");
  const sw = (label, help, on, action) => h("label", { class: "check" + (on ? " on" : "") }, h("input", { type: "checkbox", checked: on, disabled: !isAdmin(),
    onchange: (e) => doIt(action, { on: e.target.checked }) }), h("div", {}, h("b", {}, label), h("span", {}, help)));
  const rate = h("select", { disabled: !isAdmin(), onchange: (e) => doIt("rate", { rate: e.target.value }) }, [10, 20, 30, 60, 120].map((v) => h("option", { value: v, selected: v === se.rate }, `${v} a minute`)));
  const trusted = h("select", { disabled: !isAdmin(), onchange: (e) => doIt("trusted", { name: e.target.value }) }, h("option", { value: "" }, "none"),
    d.addrs.map((n) => h("option", { value: n, selected: n === se.trusted }, n)));
  shell("Mail server", h("div", { class: "stack" },
    h("div", { class: `card health-hero ${state}` }, h("div", { class: "hh-mark" }, state === "ok" ? "✔" : "!"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, bad.length ? `${bad.length} problem(s) to fix` : warn.length ? `${warn.length} thing(s) to look at` : "Mail server looks safe"),
        h("div", { class: "muted" }, `${se.host} (${se.ip}) · public ${res.public_ip || "?"} · checked ${res.at || "never"} — checks run every hour`)),
      isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "small", onclick: (e) => { e.target.disabled = true; e.target.textContent = "Checking…"; doIt("check"); } }, "Check now")) : null),
    (() => {
      const row = (c) => h("div", { class: `health-row ${c.status}` }, mark(c.status),
        h("div", { class: "grow" }, h("b", {}, c.name, h("span", { class: "muted small" }, ` · ${c.group}`)), h("div", { class: "muted small" }, c.detail), c.fix ? h("div", { class: "health-fix" }, "→ ", c.fix) : null));
      const todo = [...bad, ...warn], fine = checks.filter((c) => c.status === "ok");
      if (!checks.length) return card("Checks", null, h("div", { class: "empty" }, "Not checked yet — press Check now."));
      return card("Checks", "problems first — every hour by itself", h("div", { class: "stack" },
        todo.length ? h("div", { class: "mail-group" }, todo.map(row)) : h("div", { class: "empty" }, "Nothing to fix."),
        fine.length ? h("details", {}, h("summary", {}, `${fine.length} checks fine`), h("div", { class: "stack" }, groups.map((g) => fine.some((c) => c.group === g)
          ? h("div", { class: "mail-group" }, h("h3", {}, g), fine.filter((c) => c.group === g).map(row)) : null))) : null));
    })(),
    h("div", { class: "stack" },
      card("Doors to the mail server", "port forwards from the internet", h("div", { class: "stack" },
        table([{ label: "Port", render: (p) => h("b", {}, p.port) }, { label: "Service", key: "name" },
          { label: "Internet", render: (p) => (res.open_ports || []).includes(p.port) ? badge(p.open ? "open" : "OPEN — close it", p.open ? "ok" : "bad") : h("span", { class: "muted" }, p.open ? "closed" : "closed (good)") },
          { label: "Why", render: (p) => h("span", { class: "small muted" }, p.why), wrap: true }], d.ports),
        isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => doIt("doors", { webmail: true }) }, "Set up the doors"),
          h("span", { class: "muted small" }, "opens 25, 587, 465, 993, 995 and webmail 443 (Firewall → Port forwards)")) : null)),
      card("Protection on the routers", null, h("div", { class: "checks" },
        sw("Stop password guessing", "Too many new logins a minute from one address (IMAP, POP3, SMTP AUTH, webmail) → that address is blocked for 1 hour on every router.", se.guard, "guard"),
        sw("Only the mail server sends mail out", "Port 25 out is refused for every other device: a virus on a PC cannot send spam and get your IP blacklisted.", se.smtp_out, "smtp-out")),
        h("div", { class: "toolbar ips-opts" }, h("label", { class: "field" }, "Block above", rate), h("label", { class: "field" }, "Never block (address object)", trusted)))),
    h("div", { class: "grid g-2" },
      card("Password guessers blocked", "last 7 days", table([{ label: "Address", render: (x) => h("span", {}, h("code", {}, x.ip), x.cc ? h("span", { class: "muted small" }, ` ${x.cc}`) : null) },
        { label: "Times", key: "count", num: true }, { label: "Last", render: (x) => x.last.slice(5, 16) }], d.brute, "None.")),
      card("Devices that tried to send mail directly", "spam bots? — refused", table([{ label: "Device", render: (x) => h("span", {}, h("code", {}, x.ip), x.user ? h("div", { class: "muted small" }, x.user) : null) },
        { label: "Times", key: "count", num: true }, { label: "Last", render: (x) => x.last.slice(5, 16) }], d.bots, "None — good."))),
    card("MDaemon checklist", "settings only you can change in MDaemon — tick when done", h("div", { class: "checks" }, d.checklist.map((c) => h("label", { class: "check" + (c.done ? " on" : "") },
      h("input", { type: "checkbox", checked: c.done, disabled: !isAdmin(), onchange: (e) => doIt("checklist", { key: c.key, done: e.target.checked }) }), h("div", {}, h("span", {}, c.text)))))),
    h("details", { class: "card" }, h("summary", {}, "Mail server settings"), settingsForm()),
    hint("Good to know", h("ul", { class: "g-list" }, h("li", {}, "The IPS (Security → Intrusion prevention) also watches mail: password guessing, MDaemon admin port probes, devices sending spam."),
      h("li", {}, "Blacklist checks through public DNS are often refused by Spamhaus — then it says 'unknown'; your own DNS server fixes that."),
      h("li", {}, "Port 25 must stay open to everyone: other mail servers deliver your mail there.")))));
  document.querySelectorAll(".content table").forEach((t) => t.classList.add("rw-table"));
};

// networks / IP ranges / IPs that have a policy without logging in
function netPolicyCard(meta) {
  const nets = meta.policies.flatMap((p) => (p.nets || []).map((n) => ({ ...n, enabled: p.enabled !== false })));
  return card("Networks and IPs with a policy", "no login needed", table([
    { label: "Network / IP", render: (n) => h("code", {}, n.target) }, { label: "Name", render: (n) => n.comment || h("span", { class: "muted" }, "—") },
    { label: "Policy", render: (n) => h("span", {}, badge(n.policy, "info"), n.enabled ? null : h("span", { class: "muted small" }, " (policy off)")) },
    { label: "Note", render: (n) => n.overlaps.length ? h("span", { class: "small" }, badge("overlaps", "warn"), ` also in ${n.overlaps.join(", ")} — both policies apply there`) : h("span", { class: "muted" }, "—"), wrap: true },
    { label: "", render: (n) => isAdmin() ? h("button", { class: "small danger", onclick: async () => {
      if (await confirmDlg("Remove", `Remove policy ${n.policy} from ${n.target}?`, "Remove") && await act(api("POST", `/api/policies/net/${n.id}/del`, {}))) { blSummary = null; route(); } } }, "Remove") : null }],
    nets, "None — e.g. give 'staff' to the whole office LAN: Give a policy → Network / IP."));
}

// ------------------------------------------------------------------ devices through SNMP (switch, UPS, printer, MikroTik, server, camera)
const DEV_KIND = { switch: "Switch", ups: "UPS", printer: "Printer", mikrotik: "MikroTik", server: "Server", camera: "Camera / NVR", other: "Other" };
const devStatus = (d) => !d.enabled ? badge("off", "") : d.status === "up" ? (d.info && d.info.ups && d.info.ups.source === "battery" ? badge("ON BATTERY", "bad") : badge("answers", "ok"))
  : d.status === "down" ? badge("NO ANSWER", "bad") : badge("checking…", "info");
const tonerMeter = (pct) => { const bar = h("i", {}); bar.style.width = `${Math.min(100, Math.max(0, pct))}%`; return h("div", { class: "meter " + (pct <= 10 ? "bad" : pct <= 25 ? "warn" : "ok") }, bar); };
const tsEpoch = (t) => new Date(t.replace(" ", "T")).getTime() / 1000;

function valueChart(series, unit, top = null) {      // series: [[t, v]] -> one line
  const W = 720, H = 180, P = { l: 52, r: 10, t: 10, b: 24 };
  const vals = series.map((p) => p[1]);
  const max = top || Math.max(...vals, 1) * 1.15;
  const n = Math.max(series.length - 1, 1);
  const x = (i) => P.l + (i / n) * (W - P.l - P.r), y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const kids = [];
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    kids.push(svg("line", { class: "grid-line", x1: P.l, x2: W - P.r, y1: y(v), y2: y(v) }), svg("text", { class: "axis", x: P.l - 6, y: y(v) + 4, "text-anchor": "end" }, `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}${unit}`));
  }
  const every = Math.ceil(series.length / 7);
  series.forEach((p, i) => { if (i % every === 0) kids.push(svg("text", { class: "axis", x: x(i), y: H - 6, "text-anchor": "middle" }, p[0].slice(11, 16))); });
  if (series.length) {
    const d = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[1]).toFixed(1)}`).join("");
    kids.push(svg("path", { class: "area-down", d: `${d}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z` }), svg("path", { class: "line-down", d }));
  }
  const tip = h("div", { class: "chart-tip" }); tip.style.display = "none";
  const hover = svg("g", { class: "hover" });
  const box = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img" }, kids, hover);
  box.addEventListener("mousemove", (e) => {
    const r = box.getBoundingClientRect(), i = Math.max(0, Math.min(series.length - 1, Math.round((((e.clientX - r.left) / r.width) * W - P.l) / (W - P.l - P.r) * n)));
    const p = series[i]; if (!p) return;
    hover.replaceChildren(svg("line", { class: "hover-line", x1: x(i), x2: x(i), y1: P.t, y2: H - P.b }));
    tip.textContent = `${p[0]} — ${p[1]}${unit}`; tip.style.display = "";
  });
  box.addEventListener("mouseleave", () => { hover.replaceChildren(); tip.style.display = "none"; });
  return h("div", { class: "chart-wrap" }, box, tip);
}

function snmpSecretFields(pre = {}) {
  const ver = h("select", { name: "version" }, [["2c", "v2c (community)"], ["1", "v1 (old devices)"], ["3", "v3 (user + password, encrypted)"]].map(([v, l]) => h("option", { value: v, selected: v === (pre.version || "2c") }, l)));
  const v12 = h("div", { class: "stack" }, h("label", { class: "field" }, "Community", h("input", { name: "community", placeholder: "public", autocomplete: "off", maxlength: 64 }),
    h("span", { class: "help" }, "the device's read-only SNMP password (often 'public' — better change it on the device)")));
  const v3 = h("div", { class: "stack", hidden: true },
    h("div", { class: "grid g-2" }, h("label", { class: "field" }, "User", h("input", { name: "user", autocomplete: "off", maxlength: 32 })),
      h("label", { class: "field" }, "Login check", h("select", { name: "auth" }, ["SHA", "SHA-256", "MD5"].map((v) => h("option", { value: v }, v))))),
    h("div", { class: "grid g-2" }, h("label", { class: "field" }, "Login password", h("input", { name: "authpass", type: "password", autocomplete: "new-password", maxlength: 64 })),
      h("label", { class: "field" }, "Encryption", h("select", { name: "priv" }, ["AES", "AES-256", "DES"].map((v) => h("option", { value: v }, v))))),
    h("label", { class: "field" }, "Encryption password", h("input", { name: "privpass", type: "password", autocomplete: "new-password", maxlength: 64 }),
      h("span", { class: "help" }, "8-64 characters each; leave the encryption password empty for 'auth, no encryption'")));
  const sync = () => { v12.hidden = ver.value === "3"; v3.hidden = ver.value !== "3"; };
  ver.addEventListener("change", sync); sync();
  return [h("label", { class: "field" }, "SNMP version", ver), v12, v3];
}

function deviceAddDialog(kinds, pre = {}) {
  const out = h("div", { class: "muted small" });
  const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "grid g-2" }, h("label", { class: "field" }, "IP address", h("input", { name: "ip", value: pre.ip || "", placeholder: "192.168.88.5", required: true })),
      h("label", { class: "field" }, "Name (optional)", h("input", { name: "name", value: pre.name || "", placeholder: "UPS server room", maxlength: 64 }))),
    h("label", { class: "field" }, "Kind", h("select", { name: "kind" }, h("option", { value: "" }, "find out by itself"), kinds.map((k) => h("option", { value: k, selected: k === pre.kind }, DEV_KIND[k])))),
    ...snmpSecretFields(pre),
    h("label", { class: "check" }, h("input", { type: "checkbox", name: "nocheck" }), h("div", {}, h("b", {}, "Add even if it does not answer now"), h("span", {}, "e.g. SNMP not switched on yet"))),
    out);
  const vals = () => { const v = formValues(form); v.nocheck = form.querySelector("[name=nocheck]").checked; if (pre.community && !v.community) v.community = pre.community; return v; };
  dialog("Add a device", form, [{ label: "Cancel" },
    { label: "Test", action: async () => {
      out.textContent = "asking the device…";
      try { const r = await api("POST", "/api/devices/test", vals()); if (!r.ok) throw new Error(r.error); out.replaceChildren(badge("answers", "ok"), ` ${r.info.sys.name || r.info.ip}: ${DEV_KIND[r.info.kind]} — ${r.info.line} (${r.info.rtt} ms)`); }
      catch (e) { out.replaceChildren(badge("no answer", "bad"), " ", e.message); }
      return false; } },
    { label: "Add", class: "primary", action: async () => { if (!(await act(api("POST", "/api/devices/add", vals()), "Device added"))) return false; route(); } }]);
}

function deviceFindDialog(kinds, have) {
  const res = h("div", { class: "stack" });
  const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "grid g-2" }, h("label", { class: "field" }, "Network", h("input", { name: "net", value: "192.168.88.0/24", placeholder: "192.168.88.0/24" }),
      h("span", { class: "help" }, "/22 to /32 (up to 1024 addresses); takes a few seconds")),
      h("label", { class: "field" }, "Community", h("input", { name: "community", placeholder: "public", maxlength: 64 }))), res);
  dialog("Find devices that answer SNMP", form, [{ label: "Close" }, { label: "Search", class: "primary", action: async () => {
    res.replaceChildren(h("div", { class: "muted" }, "searching…"));
    try {
      const v = formValues(form);
      const r = await api("POST", "/api/devices/find", v);
      res.replaceChildren(r.found.length ? table([{ label: "IP", render: (x) => h("code", {}, x.ip) }, { label: "Name", key: "name" }, { label: "Kind", render: (x) => DEV_KIND[x.kind] },
        { label: "What it says", render: (x) => h("span", { class: "small muted" }, x.descr.slice(0, 70)), wrap: true },
        { label: "", render: (x) => x.added ? badge("in the list", "ok") : h("button", { class: "small", type: "button", onclick: () => { document.querySelector("dialog[open]").close(); deviceAddDialog(kinds, { ip: x.ip, name: x.name, kind: x.kind, community: v.community }); } }, "Add") }],
        r.found) : h("div", { class: "empty" }, "Nothing answered. SNMP off on the devices, another community, or a firewall in between?"));
    } catch (e) { res.replaceChildren(h("div", { class: "empty" }, e.message)); }
    return false; } }]);
}

const devTabs = (tab) => h("div", { class: "tabs" }, [["", "Devices"], ["traps", "Traps"], ["settings", "Settings"]].map(([k, l]) => h("a", { href: `#/devices${k ? "/" + k : ""}`, class: k === tab ? "active" : "" }, l)));

ROUTES.devices = async (sub = "", ...rest) => {
  if (/^\d+$/.test(sub)) return deviceDetail(sub, rest[0]);
  const d = await api("GET", "/api/devices");
  if (sub === "traps") return devicesTraps(d);
  if (sub === "settings") return devicesSettings(d);
  const on = d.devices.filter((x) => x.enabled), down = on.filter((x) => x.status === "down");
  const battery = on.filter((x) => x.status === "up" && x.info.ups && x.info.ups.source === "battery");
  const printers = on.filter((x) => x.kind === "printer" && x.info.printer && ((x.info.printer.errors || []).length || (x.info.supplies || []).some((s) => s.pct !== null && s.pct <= d.settings.limits.toner)));
  let state = "ok", title = `All ${on.length} device(s) answer`, text = d.poll_age === null ? "first check within a minute" : `checked every minute (last ${d.poll_age < 120 ? "just now" : Math.round(d.poll_age / 60) + " min ago"})`;
  if (!on.length) { state = "warn"; title = "No devices yet"; text = "Add a switch, UPS, printer, server … or let the server find them (Find devices). MikroTik routers: Add my MikroTik routers."; }
  else if (battery.length) { state = "fail"; title = `UPS on battery: ${battery.map((x) => x.name).join(", ")}`; text = "Mains power is gone — " + battery.map((x) => x.line).join(" | "); }
  else if (down.length) { state = "fail"; title = `${down.length} device(s) do not answer`; text = down.map((x) => `${x.name} (${x.ip})`).join(", "); }
  if (d.poll_age !== null && d.poll_age > 300 && on.length) { state = "fail"; title = "Device checks are not running"; text = "cron runs 'radius-admin snmp poll' every minute — Health check shows why."; }
  const notAdded = d.routers.filter((r) => !r.added);
  const bar = isAdmin() ? h("div", { class: "toolbar" },
    h("button", { class: "primary", onclick: () => deviceAddDialog(d.kinds) }, "+ Add device"),
    h("button", { onclick: () => deviceFindDialog(d.kinds) }, icon("search"), "Find devices"),
    notAdded.length ? h("button", { onclick: async () => { if (await act(api("POST", "/api/devices/routers", {}))) route(); } }, icon("router"), `Add my MikroTik routers (${notAdded.length})`) : null) : null;
  const icons = { switch: "ports", ups: "pulse", printer: "reports", mikrotik: "router", server: "data", camera: "online", other: "device" };
  shell("Devices", h("div", { class: "stack" }, devTabs(""),
    h("div", { class: `card health-hero ${state}` }, h("div", { class: "hh-mark" }, state === "ok" ? "✔" : "!"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, title), h("div", { class: "muted" }, text)), bar),
    on.length ? h("div", { class: "grid g-tiles" }, tile("Devices", num(on.length), `${num(d.devices.length - on.length)} switched off`),
      tile("Not answering", num(down.length), down.length ? down.slice(0, 3).map((x) => x.name).join(", ") : "none"),
      tile("UPS", num(on.filter((x) => x.kind === "ups").length), battery.length ? "ON BATTERY" : "on mains"),
      tile("Printers to look at", num(printers.length), printers.length ? printers.map((x) => x.name).join(", ") : "fine"),
      tile("Traps today", num(d.traps_day.n), d.settings.trapd_running ? `${num(d.traps_day.high)} high` : "receiver off (Settings)")) : null,
    card("Devices", "click a device for its ports, graphs and history", table([
      { label: "Device", render: (x) => h("a", { href: `#/devices/${x.id}`, class: "dev-name" }, icon(icons[x.kind] || "device"), h("span", {}, h("b", {}, x.name), h("div", { class: "muted small" }, DEV_KIND[x.kind] || x.kind))) },
      { label: "IP", render: (x) => h("code", {}, x.ip) }, { label: "Status", render: devStatus },
      { label: "Now", render: (x) => x.status === "down" ? h("span", { class: "small muted" }, x.last_error) : h("span", { class: "small" }, x.line || "—"), wrap: true },
      { label: "Up for", render: (x) => x.status === "up" && x.uptime ? duration(x.uptime) : "—" },
      { label: "Last answer", render: (x) => x.last_ok ? ago(x.last_ok) : "never" }], d.devices,
      "No devices yet — + Add device, or Find devices to look through your network.")),
    d.events.length ? card("What happened", "newest first", h("div", { class: "stack" }, d.events.slice(0, 15).map((e) => h("div", { class: "dev-ev" },
      badge(e.severity === "high" ? "HIGH" : e.severity, e.severity === "high" ? "bad" : e.severity === "medium" ? "warn" : ""), h("span", { class: "muted small" }, e.ts.slice(5, 16)), h("span", {}, e.text))))) : null,
    hint("How it works", h("ul", { class: "g-list" },
      h("li", {}, "The server asks every device once a minute (SNMP, read only): does it answer, CPU, memory, disks, temperature, ports and traffic; a UPS: mains or battery, charge, minutes left; a printer: toner / ink, paper jam."),
      h("li", {}, "Alerts (Telegram / WhatsApp / email) at once: no answer for 2 minutes, UPS on battery / battery low / power back, printer jam or toner low, CPU high for 5 minutes, disk full, too hot, a watched port down."),
      h("li", {}, "Traps: the device tells the server itself (Settings → Trap receiver). A port is only alerted if you watch it (device → Ports → Watch)."),
      h("li", {}, "On the device: switch SNMP on, read only, allow only this server's IP. MikroTik: Router setup → SNMP does it.")))));
};

async function deviceDetail(id, hours = "24") {
  const d = await api("GET", `/api/devices/${id}?hours=${hours}`);
  const x = d.device, inf = x.info || {};
  const doIt = async (action, data, msg) => { if (await act(api("POST", `/api/devices/${id}/${action}`, data || {}), msg)) route(); };
  const ranges = h("div", { class: "seg" }, [["6", "6 h"], ["24", "24 h"], ["168", "7 days"], ["720", "30 days"]].map(([v, l]) => h("button", { type: "button", class: v === String(d.hours) ? "on" : "", onclick: () => { location.hash = `#/devices/${id}/${v}`; } }, l)));
  const tiles = [];
  if (inf.ups) {
    const u = inf.ups;
    tiles.push(tile("Power", u.source === "battery" ? "ON BATTERY" : u.source, u.battery !== "unknown" ? `battery ${u.battery}` : ""), tile("Charge", u.charge != null ? `${u.charge}%` : "—", u.runtime != null ? `${u.runtime} min left` : ""),
      tile("Load", u.load != null ? `${u.load}%` : "—", u.in_volt != null ? `input ${u.in_volt} V` : ""));
    if (u.replace) tiles.push(tile("Battery", "REPLACE", "the UPS asks for a new battery"));
  }
  if (inf.printer) tiles.push(tile("Printer", (inf.printer.errors || []).join(", ") || inf.printer.status, inf.printer.pages != null ? `${num(inf.printer.pages)} pages printed` : ""));
  if (inf.cpu != null) tiles.push(tile("CPU", `${inf.cpu.toFixed(0)}%`, ""));
  if (inf.mem != null) tiles.push(tile("Memory", `${inf.mem.toFixed(0)}%`, ""));
  (inf.sensors || []).filter((s) => s.unit === "°C").slice(0, 3).forEach((s) => tiles.push(tile(s.name, `${s.value}°C`, "")));
  if (inf.rtt != null) tiles.push(tile("Answer time", `${inf.rtt} ms`, ""));
  const GR = { cpu: ["CPU", "%", 100], mem: ["Memory", "%", 100], temp: ["Temperature", "°C", null], charge: ["UPS charge", "%", 100], runtime: ["Minutes left on battery", " min", null], load: ["UPS load", "%", 100], rtt: ["Answer time", " ms", null] };
  const graphs = Object.entries(GR).filter(([k]) => (d.graphs[k] || []).length > 1).map(([k, [t, u, top]]) => card(t, null, valueChart(d.graphs[k], u, top)));
  const ifGraph = h("div", {});
  const showIf = async (i) => {
    const g = await api("GET", `/api/devices/${id}?hours=${d.hours}&k=if:${i.ifindex}:in,if:${i.ifindex}:out`);
    const inn = g.graphs[`if:${i.ifindex}:in`] || [], out = Object.fromEntries((g.graphs[`if:${i.ifindex}:out`] || []).map((p) => [p[0], p[1]]));
    ifGraph.replaceChildren(card(`Port ${i.name}${i.alias ? " — " + i.alias : ""}`, "traffic (every 5 minutes)",
      inn.length > 1 ? lineChart(inn.map((p) => ({ t: tsEpoch(p[0]), rx_bps: p[1], tx_bps: out[p[0]] || 0 })), 300, ["In", "Out"]) : h("div", { class: "empty" }, "No traffic numbers yet (every 5 minutes, ports that are up)."),
      h("div", { class: "legend" }, h("span", {}, h("i", { class: "down" }), "In"), h("span", {}, h("i", { class: "up" }), "Out"))));
    ifGraph.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  const sup = (inf.supplies || []);
  shell("Devices", h("div", { class: "stack" }, devTabs(""),
    (() => {
      const bad = x.status === "down" || (inf.ups && (inf.ups.source === "battery" || inf.ups.battery === "low"));
      const look = (inf.printer && (inf.printer.errors || []).length) || (inf.ups && inf.ups.replace) || sup.some((s) => s.pct !== null && s.pct <= 10);
      const st = bad ? "fail" : x.status !== "up" || look ? "warn" : "ok";
      return h("div", { class: "card health-hero " + st }, h("div", { class: "hh-mark" }, st === "ok" ? "✔" : "!"),
      h("div", { class: "grow" }, h("div", { class: "hh-title" }, `${x.name} `, devStatus(x)),
        h("div", { class: "muted" }, `${DEV_KIND[x.kind] || x.kind} · ${x.ip}${x.port !== 161 ? ":" + x.port : ""} · SNMP v${x.version}${x.location ? " · " + x.location : ""}`),
        h("div", { class: "muted small" }, x.status === "down" ? `Last error: ${x.last_error}` : x.sysdescr.slice(0, 160)),
        x.status === "up" ? h("div", { class: "small" }, x.line, x.uptime ? ` · up ${duration(x.uptime)}` : "") : null),
      h("div", { class: "toolbar" }, ranges, isAdmin() ? h("button", { class: "small", onclick: () => doIt("poll", {}, "Checked") }, icon("refresh"), "Check now") : null)); })(),
    tiles.length ? h("div", { class: "grid g-tiles" }, tiles) : null,
    sup.length ? card("Toner / ink / drums", null, h("div", { class: "stack" }, sup.map((s) => h("div", { class: "dev-sup" }, h("span", { class: "grow" }, s.name),
      s.pct === null ? h("span", { class: "muted small" }, s.level === -3 ? "some left" : "not told") : tonerMeter(s.pct), s.pct !== null ? h("b", { class: s.pct <= 10 ? "bad-text" : "" }, `${s.pct}%`) : null)))) : null,
    graphs.length ? h("div", { class: graphs.length > 1 ? "grid g-2" : "stack" }, graphs) : null,
    d.ifs.length ? card("Ports", `${d.ifs.filter((i) => i.oper === "up").length} of ${d.ifs.length} up · Watch = alert when it goes down`, table([
      { label: "Port", render: (i) => h("button", { type: "button", class: "dev-port", title: "show its traffic", onclick: () => showIf(i) }, h("b", {}, i.name), i.alias ? h("div", { class: "muted small" }, i.alias) : null) },
      { label: "State", render: (i) => i.admin === "down" ? badge("switched off", "") : i.oper === "up" ? badge("up", "ok") : badge(i.oper, "warn") },
      { label: "Speed", render: (i) => i.speed ? (i.speed >= 1000 ? `${i.speed / 1000} G` : `${i.speed} M`) : "—" },
      { label: "In now", render: (i) => bps(i.in_bps), num: true }, { label: "Out now", render: (i) => bps(i.out_bps), num: true },
      { label: "Errors", render: (i) => (i.in_err + i.out_err) ? h("span", { class: "small" }, num(i.in_err + i.out_err)) : "0", num: true },
      { label: "Changed", render: (i) => i.changed ? ago(i.changed) : "—" },
      { label: "Watch", render: (i) => h("input", { type: "checkbox", checked: !!i.watch, disabled: !isAdmin(), title: "alert when this port goes down",
        onchange: (e) => doIt("watch", { ifindex: String(i.ifindex), on: e.target.checked }, e.target.checked ? `Watching ${i.name}` : `Not watching ${i.name}`) }) }], d.ifs)) : null,
    ifGraph,
    h("div", { class: "grid g-2" },
      card("What happened", null, d.events.length ? h("div", { class: "stack" }, d.events.slice(0, 20).map((e) => h("div", { class: "dev-ev" },
        badge(e.severity === "high" ? "HIGH" : e.severity, e.severity === "high" ? "bad" : e.severity === "medium" ? "warn" : ""), h("span", { class: "muted small" }, e.ts.slice(5, 16)), h("span", {}, e.text))))
        : h("div", { class: "empty" }, "Nothing yet.")),
      card("Traps from it", null, d.traps.length ? h("div", { class: "stack" }, d.traps.slice(0, 20).map((t) => h("div", { class: "dev-ev" },
        badge(t.severity === "high" ? "HIGH" : t.severity, t.severity === "high" ? "bad" : t.severity === "medium" ? "warn" : ""), h("span", { class: "muted small" }, t.ts.slice(5, 16)), h("span", {}, t.words))))
        : h("div", { class: "empty" }, "No traps yet (Settings → Trap receiver)."))),
    isAdmin() ? card("Settings", null, h("div", { class: "toolbar wrap" },
      h("label", { class: "field" }, "Name", h("input", { value: x.name, maxlength: 64, onchange: (e) => doIt("name", { name: e.target.value.trim() }, "Name saved") })),
      h("label", { class: "field" }, "Kind", h("select", { onchange: (e) => doIt("kind", { kind: e.target.value }, "Kind saved") },
        h("option", { value: "auto" }, "find out by itself"), d.kinds.map((k) => h("option", { value: k, selected: !x.kind_auto && k === x.kind }, DEV_KIND[k])))),
      h("label", { class: "check" + (x.alerts ? " on" : "") }, h("input", { type: "checkbox", checked: !!x.alerts, onchange: (e) => doIt("alerts", { on: e.target.checked }) }), h("div", {}, h("b", {}, "Alerts"), h("span", {}, "Telegram / WhatsApp / email"))),
      h("label", { class: "check" + (x.enabled ? " on" : "") }, h("input", { type: "checkbox", checked: !!x.enabled, onchange: (e) => doIt("enabled", { on: e.target.checked }) }), h("div", {}, h("b", {}, "Check it"), h("span", {}, "off = kept, not asked"))),
      h("button", { class: "small", onclick: () => {
        const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() }, ...snmpSecretFields({ version: x.version }));
        dialog("Community / SNMP user", form, [{ label: "Cancel" }, { label: "Save", class: "primary", action: async () => { if (!(await act(api("POST", `/api/devices/${id}/secret`, formValues(form)), "Saved"))) return false; route(); } }]);
      } }, "Change community / user"),
      h("button", { class: "small danger", onclick: async () => { if (await confirmDlg("Remove device", `Remove ${x.name} (${x.ip})? Its history goes too.`, "Remove") && await act(api("POST", `/api/devices/${id}/del`, {}))) location.hash = "#/devices"; } }, "Remove"))) : null));
}

async function devicesTraps(dd) {
  const days = location.hash.split("/")[3] || "7";
  const d = await api("GET", `/api/devices/traps?days=${days}`);
  const sel = h("select", { onchange: (e) => { location.hash = `#/devices/traps/${e.target.value}`; } }, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === String(d.days) }, l)));
  shell("Devices", h("div", { class: "stack" }, devTabs("traps"),
    !dd.settings.trapd_running ? h("div", { class: "card health-hero warn" }, h("div", { class: "hh-mark" }, "!"), h("div", { class: "grow" }, h("div", { class: "hh-title" }, "The trap receiver is off"),
      h("div", { class: "muted" }, "Devices → Settings → Trap receiver: on. Then point the devices' traps to this server (UDP 162)."))) : null,
    card("Traps", "what the devices told the server by themselves", h("div", { class: "toolbar" }, sel, h("span", { class: "muted small" }, `${num(d.traps.length)} trap(s)`)),
      table([{ label: "When", render: (t) => h("span", { class: "small" }, t.ts.slice(5, 16)) },
        { label: "Device", render: (t) => t.device_id ? h("a", { href: `#/devices/${t.device_id}` }, t.name) : h("span", {}, h("code", {}, t.src_ip), h("div", { class: "muted small" }, "not in the list")) },
        { label: "Level", render: (t) => badge(t.severity === "high" ? "HIGH" : t.severity, t.severity === "high" ? "bad" : t.severity === "medium" ? "warn" : "") },
        { label: "What", render: (t) => h("details", { class: "small" }, h("summary", {}, t.words, t.alerted ? h("span", { class: "muted" }, " · alert sent") : null),
          h("pre", { class: "code-box" }, `${t.trap_oid}  (v${t.version})\n` + t.vars.map((v) => `${v.oid} = ${v.value}`).join("\n"))), wrap: true }], d.traps,
        "No traps in this time."))));
}

function devicesSettings(d) {
  const s = d.settings;
  const doIt = async (action, data, msg) => { if (await act(api("POST", `/api/devices/${action}`, data), msg)) route(); };
  const lim = (k, label, unit) => h("label", { class: "field" }, label, h("input", { type: "number", min: 1, max: 150, value: s.limits[k], disabled: !isAdmin(), onchange: (e) => doIt("limit", { key: k, value: e.target.value }, "Saved") }), h("span", { class: "help" }, unit));
  const comm = h("input", { placeholder: "new trap community", maxlength: 64, autocomplete: "off" });
  shell("Devices", h("div", { class: "stack" }, devTabs("settings"),
    card("Trap receiver", s.trapd_running ? "running on UDP 162" : "off", h("div", { class: "stack" },
      h("label", { class: "check" + (s.trapd ? " on" : "") }, h("input", { type: "checkbox", checked: s.trapd, disabled: !isAdmin(), onchange: (e) => doIt("trapd", { on: e.target.checked }) }),
        h("div", {}, h("b", {}, "Receive traps"), h("span", {}, "Devices tell the server at once: UPS on battery, port down, printer jam, restart. Only from the community below or a device's own community."))),
      s.trapd && !s.trapd_running ? h("div", {}, badge("not running", "bad"), " port 162 used by another program (snmptrapd)? Health check shows it.") : null,
      isAdmin() ? h("div", { class: "toolbar" }, comm, h("button", { class: "small", onclick: () => comm.value.trim() && doIt("trap-community", { community: comm.value.trim() }, "Trap community saved") }, "Set trap community")) : null,
      h("div", { class: "muted small" }, `On each device: trap / notification receiver = ${s.server_ip || "this server's IP"}, port 162, v2c, the same community. A device not in the list is shown as 'not in the list' without alerts.`))),
    card("When to alert", "for all devices", h("div", { class: "grid g-tiles" }, lim("toner", "Toner / ink low at", "%"), lim("cpu", "CPU high at (5 min)", "%"), lim("disk", "Disk full at", "%"),
      lim("temp", "Too hot at", "°C"), lim("ups-load", "UPS load too high at", "%"))),
    card("Setting up the devices", null, h("ul", { class: "g-list" },
      h("li", {}, h("b", {}, "MikroTik: "), "Router setup → tick SNMP → the router gets a secret read-only community for this server only, and sends traps here. Or: Devices → Add my MikroTik routers."),
      h("li", {}, h("b", {}, "Switch (TP-Link, D-Link, Cisco, HP …): "), "web page → SNMP → on, community (read only), allowed host = this server; Trap = this server."),
      h("li", {}, h("b", {}, "UPS (APC, Eaton …): "), "needs a network card (APC AP9630 / NMC, Eaton Network-M2 …) → SNMP v1/v3 on, access for this server, trap receiver = this server."),
      h("li", {}, h("b", {}, "Printer: "), "printer web page → Networking → SNMP on (often v1/v2 'public' read only)."),
      h("li", {}, h("b", {}, "Windows server: "), "Settings → Optional features → SNMP Service; Services → SNMP Service → Security: community, accept from this server. Linux: apt install snmpd."),
      h("li", {}, h("b", {}, "Safer: "), "v3 with user + password + encryption where the device has it; never 'public' with write access.")))));
}

// ------------------------------------------------------------------ step-by-step setup: one part at a time, each checked
ROUTES.golive = async () => {
  const d = await api("GET", "/api/golive");
  const mark = (c) => h("span", { class: "health-mark" }, c.ok ? "✔" : "!");
  const line = (c) => h("div", { class: `health-row ${c.ok ? "ok" : c.text.endsWith("(optional)") ? "" : "warn"}` }, mark(c),
    h("div", { class: "grow" }, h("b", {}, c.text), c.how ? h("div", { class: "health-fix" }, "→ ", c.how) : null));
  const DO = {
    blocking: [["Make the router script for this step", "#/setup/blocking", "only: blocking base, router logs, DNS logger, auto-sync — no hotspot, no security yet"],
      ["Choose a policy (or make one)", "#/blocking/policies", "e.g. staff: social & video off in office hours"],
      ["Give it to the office network", "#/blocking/policies/givenet/staff", "Network / IP: 192.168.88.0/24 (no login needed)"],
      ["Test it", "#/blocking/why", "open a blocked site from a PC; Why blocked? shows the rule"]],
    hotspot: [["Make a plan or turn on Social WiFi", "#/plans", "vouchers / plans, or phone-number login (Social WiFi)"],
      ["Make the router script for this step", "#/setup/hotspot", "only: the hotspot (the blocking base is already there)"],
      ["Design the login page (optional)", "#/hotspot", "logo, colours"], ["Test with one phone", "#/online", "it must show up in Online now"]],
    usage: [["Make the router script for this step", "#/setup/usage", "only: traffic flow to this server"], ["Look at it after 10 minutes", "#/data", "Data usage, Traffic graphs"]],
    security: [["Make the router script for this step", "#/setup/security", "only: security rules + LAN guard"], ["Watch it for a day", "#/security", "Security → All alerts"]],
    advanced: [["Firewall: start with Quick start", "#/firewall", "one policy at a time"], ["IPS in copy mode first", "#/security/ips", "Install → Turn on; inline only later, at a quiet time"],
      ["Mail server protection", "#/mail", "your MDaemon's LAN address"]],
  };
  const cards = d.steps.map((s) => {
    const state = s.done ? badge(`done ${s.done.slice(5)}`, "ok") : s.n === d.current ? badge("NOW", "info") : s.n < d.current ? badge("skipped", "") : badge("later", "");
    const open = s.n === d.current;
    const body = h("div", { class: "stack" },
      h("div", { class: "grid g-2" },
        h("div", { class: "stack" }, h("h3", { class: "gl-h" }, "Before you start"), ...s.before.map(line)),
        h("div", { class: "stack" }, h("h3", { class: "gl-h" }, "Do it"), h("ol", { class: "gl-do" }, (DO[s.key] || []).map(([t, href, sub]) =>
          h("li", {}, h("a", { href }, t), h("div", { class: "muted small" }, sub)))))),
      h("h3", { class: "gl-h" }, "Check it works"), ...s.check.map(line),
      h("details", {}, h("summary", {}, "If something goes wrong"), h("div", { class: "stack" }, h("div", {}, s.undo),
        s.key === "blocking" && isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: d.paused ? "primary" : "small danger", onclick: async () => {
          if (await act(api("POST", "/api/blocking/pause", { on: !d.paused }))) route(); } }, d.paused ? "Resume blocking" : "Pause all blocking")) : null,
        s.router_undo ? h("div", {}, h("div", { class: "muted small" }, "Router Terminal (removes only this step's part):"), h("pre", { class: "code-box" }, s.router_undo)) : null)),
      isAdmin() ? h("div", { class: "toolbar" }, s.done
        ? h("button", { class: "small", onclick: async () => { if (await act(api("POST", "/api/golive/done", { step: s.key, done: false }))) route(); } }, "Open this step again")
        : h("button", { class: s.works ? "primary" : "", onclick: async () => {
            if (!s.works && !(await confirmDlg("Not all checks pass", "Mark it done anyway? Better: fix the checks first — one working step at a time.", "Mark done", false))) return;
            if (await act(api("POST", "/api/golive/done", { step: s.key, done: true }))) route(); } }, s.works ? "✔ Works — mark done, next step" : "Mark done"),
        h("span", { class: "muted small" }, s.works ? "all checks pass" : "some checks do not pass yet")) : null);
    return h("details", { class: "card gl-step" + (s.done ? " done" : ""), open },
      h("summary", {}, h("span", { class: "gl-n" }, s.n), h("b", {}, s.title), state), body);
  });
  shell("Setup steps", h("div", { class: "stack" },
    d.paused ? h("div", { class: "card health-hero fail" }, h("div", { class: "hh-mark" }, "!"), h("div", { class: "grow" }, h("div", { class: "hh-title" }, "All blocking is PAUSED"),
      h("div", { class: "muted" }, "Nothing is blocked. Step 1 → If something goes wrong → Resume blocking."))) : null,
    hint("One part at a time", h("ul", { class: "g-list" }, h("li", {}, "Turn on one step, check it, use it for a day or two, then the next. If something breaks you know what it was."),
      h("li", {}, "Every step has its own small router script (only that part) and a way back."),
      h("li", {}, "Best time for router changes: when few people work (evening)."))),
    ...cards));
};
