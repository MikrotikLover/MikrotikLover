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
  ["plans", "Plans", "plan"], ["vouchers", "Vouchers", "voucher"], ["sales", "Sales", "money"], "-",
  ["online", "Online now", "online"], ["live", "Live log", "live"], ["reports", "Reports", "reports"], ["cdn", "CDN detective", "search"],
  ["data", "Data usage", "data"], "-", ["settings", "Settings", "settings"],
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
    const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
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
    const form = h("form", { class: "form", onsubmit: (e) => e.preventDefault() },
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
        { label: "Category", render: (r) => badge(r.category, "bad") }, { label: "Destination", key: "destination" }, { label: "Router", key: "router" }], rows, "No blocked attempts found."));
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
  if (isAdmin()) {
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
  shell("Settings", h("div", { class: "grid g-2" }, parts));
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
