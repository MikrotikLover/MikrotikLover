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
  ["online", "Online now", "online"], ["live", "Live log", "live"], ["reports", "Reports", "reports"],
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
        tile("Blocked today", num(c.blocked_today), "web-filter hits")),
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
  const search = h("input", { type: "search", placeholder: "Search users…", oninput: () => draw() });
  const holder = h("div");
  const draw = () => {
    const s = search.value.toLowerCase();
    holder.replaceChildren(table([
      { label: "User", render: (u) => h("a", { href: `#/users/${encodeURIComponent(u.username)}` }, u.username) },
      { label: "Group", render: (u) => u.grp || "—" },
      { label: "Policy", render: (u) => u.policy ? h("span", {}, u.policy, " ", u.policy_source === "group" ? h("span", { class: "muted" }, "(group)") : null) : "—" },
      { label: "Status", render: (u) => u.disabled ? badge("disabled", "bad") : u.online ? badge("online", "ok") : badge("offline") },
      { label: "Last login", render: (u) => ago(u.last_login) },
      { label: "", render: (u) => isAdmin() ? h("div", { class: "row-actions" },
          u.online ? h("button", { class: "small", onclick: () => act(api("POST", `/api/users/${encodeURIComponent(u.username)}/kick`, {})).then(route) }, "Kick") : null,
          h("button", { class: "small", onclick: () => act(api("POST", `/api/users/${encodeURIComponent(u.username)}/${u.disabled ? "enable" : "disable"}`, {})).then(route) }, u.disabled ? "Enable" : "Disable")) : null },
    ], list.filter((u) => !s || u.username.toLowerCase().includes(s) || (u.grp || "").toLowerCase().includes(s)), "No users yet — add the first one."));
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
  shell("Users", card(null, null, h("div", { class: "toolbar" }, search, h("span", { class: "grow" }), h("span", { class: "muted" }, `${list.length} users`),
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

  shell(name, h("div", { class: "stack" },
    h("div", {}, h("a", { href: "#/users" }, "← Users")),
    h("div", { class: "grid g-tiles" },
      tile("Status", disabled ? "Disabled" : online.length ? "Online" : "Offline", online[0] ? `${online[0].framedipaddress || ""} since ${ago(online[0].acctstarttime)}` : null),
      tile("Group", d.group || "—"),
      tile("Policy", ownPolicy || "group"),
      tile("Data 30 days", bytes(days.reduce((a, x) => a + x.down + x.up, 0)))),
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
        `/radius add address=<this-server-ip> secret=${r.secret} service=wireless,hotspot,login timeout=3s\n/radius incoming set accept=yes`,
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
  const tabs = [["site", "Per website"], ["ip", "Per IP"], ["user", "Per user"], ["day", "Per day"], ["now", "Live now"]];
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
        { label, render: (r) => by === "user" && r.k !== "(no login)" ? h("a", { href: `#/users/${encodeURIComponent(r.k)}` }, r.k) : String(r.k).slice(0, by === "day" ? 10 : 80) },
        { label: "Download", num: true, render: (r) => bytes(r.down) }, { label: "Upload", num: true, render: (r) => bytes(r.up) },
        { label: "Total", num: true, render: (r) => bytes(Number(r.down) + Number(r.up)) },
        by === "site" || by === "day" ? { label: "Devices", key: "devices", num: true } : { label: "Sites", key: "sites", num: true },
        by === "site" || by === "ip" ? { label: "Users", key: "users", wrap: true } : null].filter(Boolean), rows, "No data yet (traffic collector + router traffic-flow).")));
  };
  shell("Data usage", h("div", { class: "stack" },
    h("div", { class: "tabs" }, tabs.map(([k, l]) => h("a", { href: `#/data/${k}`, class: k === by ? "active" : "" }, l))),
    by !== "now" ? card(null, null, h("div", { class: "toolbar" }, days, user, ip, site, h("button", { class: "primary", onclick: () => load().catch((e) => toast(e.message, true)) }, "Show"))) : null,
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
