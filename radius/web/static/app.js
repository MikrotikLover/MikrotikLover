// MikrotikLover RADIUS dashboard — vanilla JS, no build step, no external requests.
// All data is rendered with textContent (never innerHTML) so names from the network cannot inject HTML.

const $app = document.getElementById("app");
let me = null;            // {user, role, csrf}
let timers = [];          // page refresh timers, cleared on navigation

// ------------------------------------------------------------------ DOM helper
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
  plan: "M4 4h16v16H4zM8 9h8M8 13h8M8 17h5",
  voucher: "M3 7h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM14 7v12",
  money: "M3 6h18v12H3zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M6 9v.01M18 15v.01",
  print: "M6 9V3h12v6M6 18H4v-7h16v7h-2M7 14h10v7H7z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14m10 3-5.2-5.2",
  block: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M5.6 5.6l12.8 12.8",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM12 8v5m0 3h.01",
  pulse: "M3 12h4l2-6 4 12 2-6h6",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 7v5l3 2",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9s1.3-6.5 3.8-9",
  vpn: "M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM9 12l2 2 4-4",
  apps: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z",
  ports: "M7 7h10v10H7zM3 9h4M3 15h4M17 9h4M17 15h4M9 3v4M15 3v4M9 17v4M15 17v4",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7",
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
      return h("td", { class: (c.num ? "num " : "") + (c.wrap ? "wrap" : "") }, v ?? "—");
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
  ["dashboard", "Dashboard", "home"], ["users", "Users", "users"], ["groups", "Groups & policies", "groups"],
  ["macs", "MAC devices", "mac"], ["routers", "Routers", "router"], "-",
  ["plans", "Plans", "plan"], ["vouchers", "Vouchers", "voucher"], ["sales", "Sales", "money"], ["speed", "Speed schedule", "clock"], "-",
  ["online", "Online now", "online"], ["live", "Live log", "live"], ["reports", "Reports", "reports"], ["cdn", "CDN detective", "search"],
  ["data", "Data usage", "data"], ["apps", "Apps on network", "apps"], ["ports", "Ports & protocols", "ports"], "-",
  ["blocking", "Blocking", "block"], ["vpn", "VPN & proxy watch", "vpn"], ["security", "Security", "shield"], ["domains", "Website names", "globe"], "-", ["health", "Health check", "pulse"], ["settings", "Settings", "settings"],
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
async function route() {
  timers.forEach(clearInterval); timers = [];
  if (!me) return renderLogin();
  const [, page = "dashboard", ...rest] = location.hash.split("/");
  const fn = ROUTES[page] || ROUTES.dashboard;
  try { await fn(...rest.map(decodeURIComponent)); }
  catch (e) { if (e.message !== "login required") shell("Error", card(null, null, h("div", { class: "note" }, e.message))); }
}
window.addEventListener("hashchange", route);
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
  const [{ macs }, { groups }] = await Promise.all([api("GET", "/api/macs"), api("GET", "/api/groups")]);
  const add = () => {
    const form = h("form", { class: "form policy-editor", onsubmit: (e) => e.preventDefault() },
      h("label", { class: "field" }, "MAC address", h("span", { class: "help" }, "Any format: aa:bb:cc:dd:ee:ff, AABB.CCDD.EEFF"), h("input", { name: "mac", required: true, placeholder: "aa:bb:cc:dd:ee:ff" })),
      h("label", { class: "field" }, "Description", h("input", { name: "description", maxlength: 128, placeholder: "Reception printer" })),
      h("label", { class: "field" }, "Group", h("select", { name: "group" }, h("option", { value: "" }, "— none —"), groups.map((g) => h("option", { value: g.name }, g.name)))));
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
      { label: "Status", render: (m) => m.disabled ? badge("disabled", "bad") : m.online ? badge("online", "ok") : badge("offline") },
      { label: "Last seen", render: (m) => ago(m.last_seen) },
      { label: "", render: (m) => isAdmin() ? h("div", { class: "row-actions" },
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
  shell("Routers", card(null, null,
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
          } }, "Remove")) : null }], nas, "No routers yet — add your MikroTik first.")));
};

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
ROUTES.health = async () => {
  shell("Health check", h("div", { class: "empty" }, "Checking every part of the server …"));
  const r = await api("GET", "/api/health");
  const n = { ok: 0, warn: 0, fail: 0 };
  r.checks.forEach((c) => n[c.status]++);
  const mark = { ok: "✔", warn: "!", fail: "✘" };
  const groups = [...new Set(r.checks.map((c) => c.group))];
  const head = h("div", { class: "grid g-tiles" },
    tile("Overall", h("span", { class: `health-dot ${r.status}` }, { ok: "All good", warn: "Needs a look", fail: "Problem" }[r.status]), `checked ${r.checked.slice(11, 16)} on ${r.host}`),
    tile("OK", String(n.ok), "green"), tile("Warnings", String(n.warn), "yellow"), tile("Problems", String(n.fail), "red"));
  const body = groups.map((g) => card(g, null, h("div", { class: "health-list" }, r.checks.filter((c) => c.group === g).map((c) =>
    h("div", { class: `health-row ${c.status}` }, h("span", { class: "health-mark", "aria-label": c.status }, mark[c.status]),
      h("div", { class: "grow" }, h("b", {}, c.name), h("div", { class: "muted" }, c.detail),
        c.fix ? h("div", { class: "health-fix" }, "How to fix: ", h("code", {}, c.fix)) : null))))));
  shell("Health check", h("div", { class: "stack" }, head,
    h("div", { class: "toolbar" }, h("span", { class: "muted grow" }, "Green = working · yellow = check when you can · red = fix now. Same on the server: sudo radius-admin doctor"),
      h("button", { onclick: () => route() }, "Check again")),
    h("div", { class: "grid g-2" }, body)));
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
  ["expiring", "Users expiring", "subscription ends within 24 hours"], ["summary", "Daily summary", "users, data, sales, security"]];
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

ROUTES.plans = async () => {
  const { plans, currency } = await api("GET", "/api/plans");
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
    case "allow-only": return badge(`ONLY ${r.value}`, "warn");
    case "block-all": return badge(`no internet${t}`, "bad");
    case "dns": return badge(`DNS: ${r.value}`, "info");
    case "strict-ech": return badge("ECH blocked", "info");
    default: return badge(`${r.kind} ${r.value}`);
  }
}

function policyEditor(meta, pol) {
  const rules = pol ? pol.rules : [];
  const has = (kind, value) => rules.some((r) => r.kind === kind && (value === undefined || r.value === value));
  const firstTime = rules.find((r) => r.time)?.time || "";
  const t0 = parseTime(firstTime) || { from: 9, to: 17, days: DAY_NAMES.slice(0, 6) };
  const name = h("input", { name: "name", required: true, pattern: "[a-z0-9\\-]{1,40}", placeholder: "e.g. kids", value: pol?.name || "", disabled: !!pol });
  const desc = h("input", { placeholder: "e.g. Kids: no TikTok, no YouTube videos", value: pol?.description || "" });
  const mode = has("allow-only") ? "only" : has("block-all") && !firstTime ? "none" : "block";
  const modeSel = h("select", {}, [["block", "Block what I choose (the rest works)"], ["only", "WhatsApp ONLY (everything else blocked)"], ["none", "No internet at all"]]
    .map(([v, l]) => h("option", { value: v, selected: v === mode }, l)));
  const check = (title, help, on) => {
    const cb = h("input", { type: "checkbox", checked: on });
    const el = h("label", { class: "check" + (on ? " on" : "") }, cb, h("div", {}, h("b", {}, title), h("span", {}, help)));
    cb.addEventListener("change", () => { el.classList.toggle("on", cb.checked); preview(); });
    el.cb = cb; return el;
  };
  const cats = meta.categories.map((c) => Object.assign(check(c.name === "keywords" ? "Adult words" : c.name, c.description, has("block", c.name)), { value: c.name }));
  const vpn = check("Block VPN", "VPN apps and websites, the VPN servers seen on your network (list grows by itself), OpenVPN / WireGuard / IPsec / PPTP / Tor. Every try is logged → VPN watch.", has("block-vpn"));
  const appChosen = new Set(rules.filter((r) => r.kind === "block-app").map((r) => r.value));
  const appSearch = h("input", { type: "search", placeholder: "Search apps: pubg, tiktok, snapchat, netflix …" });
  const appBox = h("div", { class: "applist-scroll" });
  const chosenBox = h("div", { class: "chips" });
  const drawApps = () => {
    const qy = appSearch.value.trim().toLowerCase();
    const groups = new Map();
    meta.apps.filter((a) => !qy || a.app.toLowerCase().includes(qy) || a.category.includes(qy)).forEach((a) => {
      if (!groups.has(a.category)) groups.set(a.category, []);
      groups.get(a.category).push(a);
    });
    appBox.replaceChildren(...[...groups].map(([cat, list]) => [h("h4", {}, cat), h("div", { class: "chips" }, list.map((a) => {
      const cb = h("input", { type: "checkbox", checked: appChosen.has(a.app) });
      const chip = h("label", { class: "chip" + (appChosen.has(a.app) ? " on" : "") }, cb, a.app, a.discovered ? h("small", {}, "new") : null);
      cb.addEventListener("change", () => { cb.checked ? appChosen.add(a.app) : appChosen.delete(a.app); chip.classList.toggle("on", cb.checked); drawChosen(); preview(); });
      return chip;
    }))]).flat());
    if (!appBox.children.length) appBox.append(h("div", { class: "muted" }, "No app with that name."));
  };
  const drawChosen = () => chosenBox.replaceChildren(...(appChosen.size ? [...appChosen].map((a) => badge(a, "bad")) : [h("span", { class: "muted" }, "No single apps chosen.")]));
  appSearch.addEventListener("input", drawApps);
  const whenSel = h("select", {}, h("option", { value: "always", selected: !firstTime }, "Always"), h("option", { value: "time", selected: !!firstTime }, "Only at these times"));
  const hours = (v) => Array.from({ length: 25 }, (_, i) => h("option", { value: i, selected: i === v }, `${String(i).padStart(2, "0")}:00`));
  const from = h("select", {}, hours(t0.from)), to = h("select", {}, hours(t0.to));
  const days = DAY_NAMES.map((d) => { const cb = h("input", { type: "checkbox", checked: t0.days.includes(d) }); cb.addEventListener("change", preview); return h("label", { class: "chip" }, cb, d); });
  const timeRow = h("div", { class: "toolbar" }, from, "→", to, h("div", { class: "chips" }, days));
  const dnsSel = h("select", {}, [["router", "Router DNS (normal)"], ["family", "Cloudflare Family (no adult)"], ["adguard-family", "AdGuard Family"], ["cleanbrowsing-family", "CleanBrowsing Family"], ["cleanbrowsing-adult", "CleanBrowsing Adult filter"]]
    .map(([v, l]) => h("option", { value: v, selected: (rules.find((r) => r.kind === "dns")?.value || "router") === v }, l)));
  const ech = check("Block hidden site names (ECH)", "Stops browsers from hiding the site name; a few Cloudflare sites may not open.", has("strict-ech"));
  const out = h("pre", { class: "code-box" });
  const blockSection = h("div", { class: "stack" },
    h("label", { class: "field" }, "Categories", h("span", { class: "help" }, "Whole groups of sites and apps. Lists are kept up to date on the server."), h("div", { class: "checks" }, cats)),
    vpn,
    h("label", { class: "field" }, "Single apps", h("span", { class: "help" }, "Every known domain of the app is blocked, the ones learned on your network too. \"new\" = discovered automatically."), appSearch, appBox, chosenBox),
    h("label", { class: "field" }, "When", whenSel, timeRow),
    h("label", { class: "field" }, "DNS for these users", dnsSel), ech);
  function text() {
    const tm = whenSel.value === "time" ? ` time=${timeSpec({ from: from.value, to: to.value, days: days.filter((d) => d.querySelector("input").checked).map((d) => d.textContent) })}` : "";
    const lines = [`# ${desc.value.trim() || name.value || "policy"}`];
    if (modeSel.value === "only") lines.push("allow-only whatsapp");
    else if (modeSel.value === "none") lines.push("block-all");
    else {
      cats.filter((c) => c.cb.checked).forEach((c) => lines.push(`block ${c.value}${tm}`));
      [...appChosen].forEach((a) => lines.push(`block-app ${a}${tm}`));
      if (vpn.cb.checked) lines.push(`block-vpn${tm}`);
      if (dnsSel.value !== "router") lines.push(`dns ${dnsSel.value}`);
      if (ech.cb.checked) lines.push("strict-ech");
    }
    return lines.join("\n") + "\n";
  }
  function preview() {
    blockSection.hidden = modeSel.value !== "block";
    timeRow.hidden = whenSel.value !== "time";
    out.textContent = text();
  }
  [modeSel, whenSel, from, to, dnsSel].forEach((el) => el.addEventListener("change", preview));
  [desc, name].forEach((el) => el.addEventListener("input", preview));
  drawApps(); drawChosen(); preview();
  const onlyNote = h("div", { class: "note", hidden: modeSel.value !== "only" }, "WhatsApp only: chat, voice/video calls, photos and status work. Facebook, Instagram, YouTube, browsers and every other app are blocked.");
  const form = h("form", { class: "form policy-editor", onsubmit: (e) => e.preventDefault() },
    h("div", { class: "form cols" }, h("label", { class: "field" }, "Policy name", h("span", { class: "help" }, "small letters, digits, -"), name),
      h("label", { class: "field" }, "Description", h("span", { class: "help" }, "shown when you pick a policy"), desc)),
    h("label", { class: "field" }, "What should these users get?", modeSel),
    onlyNote,
    blockSection,
    h("label", { class: "field" }, "Policy file (what the server stores)", out));
  modeSel.addEventListener("change", () => { onlyNote.hidden = modeSel.value !== "only"; });
  return { form, text, name: () => name.value.trim() };
}

ROUTES.blocking = async (tab = "policies") => {
  if (tab === "logs") return blockingLogs();
  const [meta, ul] = await Promise.all([api("GET", "/api/blocking"), api("GET", "/api/users")]);
  const r = meta.router;
  const openEditor = (pol) => {
    const ed = policyEditor(meta, pol);
    dialog(pol ? `Edit policy ${pol.name}` : "New blocking policy", ed.form, [{ label: "Cancel" }, { label: "Save policy", class: "primary", action: async () => {
      if (!ed.form.reportValidity()) return false;
      const res = await act(api("POST", "/api/policies", { name: ed.name(), text: ed.text() }));
      if (!res) return false;
      route();
    } }]);
  };
  const policySel = (id) => h("select", { id }, meta.policies.map((p) => h("option", { value: p.name }, `${p.name} — ${p.description}`)));
  const userIn = h("input", { list: "bl-users", placeholder: "User name", autocomplete: "off" });
  const userPol = policySel("bl-upol"), groupPol = policySel("bl-gpol");
  const groupSel = h("select", {}, h("option", { value: "" }, "— group —"));
  api("GET", "/api/groups").then((g) => g.groups.forEach((x) => groupSel.append(h("option", { value: x.name }, x.name)))).catch(() => {});
  const cards = meta.policies.map((p) => h("div", { class: "card policy-card" },
    h("h2", {}, h("span", {}, p.name), h("span", { class: "sub" }, `${p.users.length} user(s), ${p.groups.length} group(s)`)),
    h("div", { class: "muted" }, p.description),
    h("div", { class: "rules" }, p.rules.map(ruleLabel)),
    p.users.length || p.groups.length ? h("div", { class: "muted" }, "Used by: ", [...p.users, ...p.groups.map((g) => `${g} (group)`)].join(", ")) : null,
    isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "small", onclick: () => openEditor(p) }, "Edit"),
      h("button", { class: "small", onclick: async () => { if (await confirmDlg("Delete policy", `Delete policy "${p.name}"?`)) { await act(api("DELETE", `/api/policies/${encodeURIComponent(p.name)}`)); route(); } } }, "Delete")) : null));
  const script = h("pre", { class: "code-box" }, `# Router auto-sync (every 15 min, only when something changed)
# Dashboard → "Download router script", then on the router:
#   Files → upload mikrotiklover-autosync.rsc   →   Terminal:  /import mikrotiklover-autosync.rsc
# Server: ${r.url}   version ${r.version || "—"}   built ${r.built || "—"}`);
  const ipIn = h("input", { placeholder: "server IP as the router sees it", value: /^\d+\.\d+\.\d+\.\d+$/.test(location.hostname) ? location.hostname : "" });
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("policies"),
    card("How to block apps or websites for a user", null, h("div", { class: "steps" },
      h("div", {}, h("span", {}, h("b", {}, "Make a policy"), " — tick categories, single apps (TikTok, PUBG …), Block VPN, or choose WhatsApp ONLY. Ready-made ones are below.")),
      h("div", {}, h("span", {}, h("b", {}, "Give it to a user or a group"), " — box below, or Users → user → Own web-filter policy. The user is disconnected once and gets it at the next login.")),
      h("div", {}, h("span", {}, h("b", {}, "Router auto-sync"), " — import the router script once; afterwards every change reaches the router by itself within 15 minutes.")))),
    isAdmin() ? h("div", { class: "grid g-2" },
      card("Give a policy to a user", null, h("div", { class: "toolbar" }, userIn, h("datalist", { id: "bl-users" }, ul.users.map((u) => h("option", { value: u.username }))), userPol,
        h("button", { class: "primary", onclick: async () => {
          if (!userIn.value.trim()) return toast("Type a user name", true);
          await act(api("POST", `/api/users/${encodeURIComponent(userIn.value.trim())}/policy`, { policy: userPol.value })); route();
        } }, "Apply"))),
      card("Give a policy to a whole group", null, h("div", { class: "toolbar" }, groupSel, groupPol,
        h("button", { class: "primary", onclick: async () => {
          if (!groupSel.value) return toast("Choose a group", true);
          await act(api("POST", "/api/groups", { name: groupSel.value, policy: groupPol.value, edit: true })); route();
        } }, "Apply")))) : null,
    card("Policies", `${meta.policies.length}`, isAdmin() ? h("div", { class: "toolbar" }, h("button", { class: "primary", onclick: () => openEditor(null) }, "+ New policy")) : null),
    h("div", { class: "grid g-2" }, cards),
    card("Router auto-sync", r.version ? `version ${r.version} · built ${r.built} · ${num(r.vpn_servers)} VPN servers` : "not built yet",
      script,
      isAdmin() ? h("div", { class: "toolbar" }, ipIn,
        h("button", { onclick: () => { if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipIn.value.trim())) return toast("Type the server's IP address", true); location.href = `/api/router/autosync.rsc?ip=${encodeURIComponent(ipIn.value.trim())}`; } }, "⬇ Download router script"),
        h("button", { onclick: async () => { await act(api("POST", "/api/router/build")); route(); } }, "Rebuild now")) : null),
  ));
};

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
const blockingTabs = (tab) => h("div", { class: "tabs" }, [["policies", "Policies"], ["logs", "Blocking logs"]]
  .map(([k, l]) => h("a", { href: `#/blocking/${k}`, class: k === tab ? "active" : "" }, l)));
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
        { label: "Site", render: (r) => r.site ? h("code", {}, r.site) : h("span", { class: "muted" }, "—"), wrap: true }, { label: "Destination", key: "destination" }], d.rows, "Nothing blocked in this period.")));
  };
  shell("Blocking", h("div", { class: "stack" }, blockingTabs("logs"),
    h("div", { class: "note" }, "Every block the router logged, with the user's policy (own policy, else the group's), what blocked it (category, app, VPN, allow-only …) and the site name the device asked for. Needs webfilter-logging.rsc on the router."),
    card(null, null, h("div", { class: "toolbar" }, days, user, policy, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
}

// ------------------------------------------------------------------ security detective: virus, hacker attacks, DDoS
ROUTES.security = async (tab = "all") => {
  const tabs = [["all", "All alerts"], ["virus", "Virus (infected devices)"], ["attack", "Hacker attacks"], ["ddos", "DDoS attacks"], ["setup", "Protection & lists"]];
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const high = h("label", { class: "chip" }, h("input", { type: "checkbox" }), "only high");
  const holder = h("div", { class: "stack" });
  const sev = (s) => badge(s, s === "high" ? "bad" : s === "medium" ? "warn" : "info");
  const catBadge = (c) => badge({ virus: "VIRUS", attack: "ATTACK", ddos: "DDoS" }[c] || c, c === "virus" ? "warn" : "bad");
  const who = (r) => r.src_ip ? h("span", {}, r.username ? h("a", { href: `#/users/${encodeURIComponent(r.username)}` }, r.username) : null,
    h("div", { class: r.username ? "muted" : "" }, h("code", {}, r.src_ip))) : r.username ? h("span", {}, r.username) : "—";
  const load = async () => {
    const d = await api("GET", `/api/security?${new URLSearchParams({ days: days.value, category: ["virus", "attack", "ddos"].includes(tab) ? tab : "", high: high.querySelector("input").checked ? "1" : "", n: 500 })}`);
    const c = (k) => d.counts[k] || { events: 0, high: 0 };
    const tiles = h("div", { class: "grid g-tiles" },
      tile("Virus alerts", num(c("virus").events), `${num(c("virus").high)} high · infected devices`),
      tile("Hacker attacks", num(c("attack").events), `${num(c("attack").high)} high · scans, password guessing`),
      tile("DDoS attacks", num(c("ddos").events), `${num(c("ddos").high)} high · floods by type`),
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
    const parts = [tiles];
    const inQ = new Set(d.quarantine.flatMap((x) => [x.ip, x.username].filter(Boolean)));
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
ROUTES.apps = async (cat = "") => {
  const holder = h("div", { class: "stack" });
  const days = h("select", {}, [["1", "Today"], ["7", "7 days"], ["30", "30 days"], ["90", "90 days"]].map(([v, l]) => h("option", { value: v, selected: v === "7" }, l)));
  const user = h("input", { type: "search", placeholder: "User" }), ip = h("input", { type: "search", placeholder: "Device IP" });
  const srcBadge = (r) => r.source === "discovered" ? badge("auto-discovered", "warn") : null;
  const showUsers = async (r) => {
    const d = await api("GET", `/api/apps/users?${new URLSearchParams({ site: r.site, days: days.value })}`);
    dialog(`${r.app} — who uses it`, table([{ label: "Device", render: (x) => h("span", {}, x.client_ip, x.username ? h("div", { class: "muted" }, x.username) : null) },
      { label: "Lookups", key: "lookups", num: true }, { label: "Data", num: true, render: (x) => bytes(x.bytes) },
      { label: "Days", render: (x) => x.first_day === x.last_day ? String(x.first_day) : `${x.first_day} → ${x.last_day}` }], d.rows, "Nobody in this period."), [{ label: "Close" }]);
  };
  const load = async () => {
    const d = await api("GET", `/api/apps?${new URLSearchParams({ days: days.value, user: user.value.trim(), ip: ip.value.trim(), category: cat, top: 300 })}`);
    const t = d.totals;
    holder.replaceChildren(
      h("div", { class: "grid g-tiles" }, tile("Apps seen (all time)", num(t.apps)), tile("In this period", num(d.rows.length), cat ? `category: ${cat}` : "all categories"),
        tile("New this week", num(t.new_apps), "first seen in the last 7 days"), tile("Found automatically", num(t.discovered), "new apps, named from their website")),
      h("div", { class: "tabs" }, h("a", { href: "#/apps", class: cat ? "" : "active" }, "All"),
        d.categories.map((c) => h("a", { href: `#/apps/${c.category}`, class: c.category === cat ? "active" : "" }, `${c.category} (${c.n})`))),
      h("div", { class: "card" }, table([
        { label: "App", render: (r) => h("span", {}, h("b", {}, r.app), " ", Number(r.is_new) ? badge("NEW", "ok") : null, " ", srcBadge(r), h("div", { class: "muted" }, r.site)) },
        { label: "Category", render: (r) => badge(r.category, "info") },
        { label: "Devices", key: "devices", num: true }, { label: "Users", key: "users", num: true }, { label: "Lookups", key: "lookups", num: true },
        { label: "Data", num: true, render: (r) => bytes(r.bytes) },
        { label: "First / last seen", render: (r) => h("span", {}, String(r.first_seen).slice(0, 10), h("div", { class: "muted" }, String(r.last_seen).slice(0, 16))) },
        { label: "", render: (r) => h("div", { class: "toolbar" }, h("button", { class: "small", onclick: () => showUsers(r).catch((e) => toast(e.message, true)) }, "Users"),
          h("a", { class: "btn small", href: `#/cdn` }, "Domains"),
          h("a", { class: "btn small", href: `/api/cdn/rsc?app=${encodeURIComponent(r.app)}`, title: "RouterOS script that blocks every known domain of this app" }, "⬇ Block")) },
      ], d.rows, "No apps yet — the list fills itself every hour from the router's DNS log (radius-admin dnslog on).")));
  };
  shell("Apps on network", h("div", { class: "stack" },
    h("div", { class: "note" }, "Built automatically every hour: every app any device used, with category, devices, users and data. New apps that are not in the catalog are discovered and named from their website."),
    card(null, null, h("div", { class: "toolbar" }, days, user, ip, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))),
    holder));
  await load();
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
