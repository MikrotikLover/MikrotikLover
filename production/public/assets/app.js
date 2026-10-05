// Production app SPA. Vanilla ES module, hash routing (#/page?query), no build step.
// All names coming from the server are inserted with textContent (via h()), never as HTML.

const $app = document.getElementById('app');
const S = { me: null, csrf: '', perms: [], lookups: null, company: '' };

// ---------------------------------------------------------------- DOM helpers
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const can = (p) => S.perms.includes(p);

// ---------------------------------------------------------------- formatting
const nf = (d) => new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const NF0 = nf(0), NF1 = nf(1), NF2 = nf(2);
const fmt = {
  n0: (v) => (v === null || v === undefined || v === '') ? '' : NF0.format(+v),
  n1: (v) => (v === null || v === undefined || v === '') ? '' : NF1.format(+v),
  n2: (v) => (v === null || v === undefined || v === '') ? '' : NF2.format(+v),
  ink: (v) => (v === null || v === undefined || v === '') ? '' : String(+(+v).toFixed(3)),
  rs: (v) => (v === null || v === undefined) ? '' : 'Rs ' + NF0.format(+v),
  short: (v) => {
    v = +v; const a = Math.abs(v);
    if (a >= 1e7) return NF2.format(v / 1e7) + ' Cr';
    if (a >= 1e5) return NF2.format(v / 1e5) + ' Lac';
    return NF0.format(v);
  },
  date: (d) => {
    if (!d) return '';
    const [y, m, dd] = d.slice(0, 10).split('-');
    return `${dd}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1]}-${y.slice(2)}`;
  },
  month: (k) => { const [y, m] = k.split('-'); return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1] + ' ' + y; },
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => iso(new Date());

// ---------------------------------------------------------------- API
class ApiError extends Error {
  constructor(msg, status, errors) { super(msg); this.status = status; this.errors = errors || {}; }
}
async function api(method, path, body) {
  const opts = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['X-CSRF-Token'] = S.csrf;
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let res, json;
  try { res = await fetch('api' + path, opts); } catch { throw new ApiError('Cannot reach the server. Check the connection.', 0); }
  try { json = await res.json(); } catch { throw new ApiError(`Server error (${res.status}).`, res.status); }
  if (!json.ok) {
    if (res.status === 401 && path !== '/auth/login') { S.me = null; renderLogin(json.error); }
    throw new ApiError(json.error || 'Request failed.', res.status, json.errors);
  }
  return json.data;
}
const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? '?' + s : '';
};

// ---------------------------------------------------------------- UI bits
function msg(el, text, kind = 'error') {
  el.replaceChildren(text ? h('div', { class: 'msg ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text) : '');
}
function field(label, input, opts = {}) {
  const wrap = h('label', { class: 'field' + (opts.wide ? ' wide' : ''), style: opts.style }, h('span', {}, label), input, h('small', { class: 'err' }));
  if (input.name) wrap.dataset.field = input.name;
  return wrap;
}
function showErrors(form, err, box) {
  form.querySelectorAll('.field.invalid').forEach((f) => { f.classList.remove('invalid'); f.querySelector('.err').textContent = ''; });
  let first = null;
  for (const [name, text] of Object.entries(err.errors || {})) {
    const f = form.querySelector(`.field[data-field="${CSS.escape(name)}"]`);
    if (f) { f.classList.add('invalid'); f.querySelector('.err').textContent = text; first = first || f.querySelector('input,select'); }
  }
  if (box) msg(box, err.message);
  first?.focus();
}
function datalist(id, rows, activeOnly = true) {
  return h('datalist', { id }, rows.filter((r) => !activeOnly || +r.is_active).map((r) => h('option', { value: r.name })));
}
function select(name, options, value, attrs = {}) {
  return h('select', { name, ...attrs }, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}
function dialog(title, body, buttons) {
  const d = h('dialog', {}, h('h3', {}, title), body, h('div', { class: 'actions' }, buttons));
  d.addEventListener('close', () => d.remove());
  document.body.append(d);
  d.showModal();
  return d;
}
function confirmBox(text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    const d = dialog('Please confirm', h('p', {}, text), [
      h('button', { class: 'btn ' + (danger ? 'primary' : 'primary'), onclick: () => { ok = true; d.close(); } }, okLabel),
      h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel'),
    ]);
    d.addEventListener('close', () => resolve(ok));
  });
}
async function loadLookups(force = false) {
  if (!S.lookups || force) S.lookups = await api('GET', '/lookups');
  return S.lookups;
}
const idByName = (list, name) => {
  const k = (name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  if (!k) return '';
  const r = list.find((x) => x.name.toLowerCase() === k);
  return r ? r.id : -1; // -1: unknown name -> filter matches nothing
};
const nameById = (list, id) => (list.find((x) => String(x.id) === String(id)) || {}).name || '';

// ---------------------------------------------------------------- routing
const ROUTES = {
  dashboard: { title: 'Dashboard', render: pageDashboard },
  entries: { title: 'Production Entries', render: pageEntries },
  entry: { title: 'Production Entry', render: pageEntry, perm: 'entries.add' },
  reports: { title: 'Reports', render: pageReports },
  import: { title: 'Import Excel', render: pageImport, perm: 'import' },
  check: { title: 'Data Check', render: pageCheck },
  machines: { title: 'Machines & Ink Rates', render: pageMachines },
  lists: { title: 'Lists', render: pageLists },
  users: { title: 'Users', render: pageUsers, perm: 'users' },
  settings: { title: 'Settings', render: pageSettings },
  audit: { title: 'Audit Log', render: pageAudit, perm: 'audit' },
  password: { title: 'Change Password', render: pagePassword },
};
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  return { name: parts[0] || 'dashboard', arg: parts[1] || '', q: Object.fromEntries(new URLSearchParams(query)) };
}
function go(name, q = {}, arg = '') { location.hash = '#/' + name + (arg ? '/' + arg : '') + qs(q); }
function setQuery(q) {
  const r = parseHash();
  history.replaceState(null, '', '#/' + r.name + (r.arg ? '/' + r.arg : '') + qs(q));
}

let mainEl, titleEl;
async function route() {
  if (!S.me) return;
  const r = parseHash();
  if (S.me.must_change_password && r.name !== 'password') return go('password');
  const def = ROUTES[r.name] || ROUTES.dashboard;
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === r.name));
  document.querySelector('.shell')?.classList.remove('nav-open');
  titleEl.textContent = def.title;
  document.title = def.title + ' · ' + (window.APP_NAME || 'Production');
  mainEl.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  if (def.perm && !can(def.perm)) { mainEl.replaceChildren(h('div', { class: 'msg error' }, 'You do not have permission for this page.')); return; }
  try {
    const node = await def.render(r);
    if (parseHash().name === r.name) mainEl.replaceChildren(node);
  } catch (e) {
    if (e.status !== 401) mainEl.replaceChildren(h('div', { class: 'msg error', role: 'alert' }, e.message));
  }
  mainEl.scrollTop = 0;
}
window.addEventListener('hashchange', route);

// ---------------------------------------------------------------- shell & login
function renderShell() {
  const link = (name, label) => h('a', { href: '#/' + name, dataset: { route: name } }, label);
  const shell = h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, window.APP_NAME || 'Production', h('small', {}, S.company)),
      h('nav', { class: 'nav' },
        h('h4', {}, 'Production'),
        link('dashboard', 'Dashboard'),
        can('entries.add') && link('entry', 'New Entry'),
        link('entries', 'Entries'),
        link('reports', 'Reports'),
        link('check', 'Data Check'),
        can('import') && link('import', 'Import Excel'),
        h('h4', {}, 'Setup'),
        link('machines', 'Machines & Ink Rates'),
        link('lists', 'Parties, Operators…'),
        can('users') && link('users', 'Users'),
        can('settings') && link('settings', 'Settings'),
        can('audit') && link('audit', 'Audit Log'),
      )),
    h('header', { class: 'top' },
      h('button', { class: 'btn small menu-btn', 'aria-label': 'Menu', onclick: () => shell.classList.toggle('nav-open') }, '☰'),
      titleEl = h('h1', {}, ''),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, S.me.full_name || S.me.username, ' · ', S.me.role),
      h('a', { class: 'btn small', href: '#/password' }, 'Password'),
      h('button', { class: 'btn small', onclick: logout }, 'Log out')),
    mainEl = h('main', { id: 'main' }));
  $app.replaceChildren(shell);
}
function applySession(d) {
  S.me = d.user; S.csrf = d.csrf; S.perms = d.permissions || []; S.company = d.company || '';
  if (d.app_name) window.APP_NAME = d.app_name;
}
function renderLogin(notice) {
  const box = h('div');
  const form = h('form', { class: 'panel login', onsubmit: async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      applySession(await api('POST', '/auth/login', { username: form.username.value, password: form.password.value }));
      S.lookups = null;
      renderShell(); route();
    } catch (err) { msg(box, err.message); btn.disabled = false; form.password.select(); }
  } },
  h('h2', {}, window.APP_NAME || 'Production'),
  h('p', { class: 'muted' }, 'Sign in to continue'),
  box,
  field('Username', h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true })),
  h('div', { style: 'height:8px' }),
  field('Password', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
  h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Sign in')));
  if (notice) msg(box, notice, 'warn');
  $app.replaceChildren(form);
  form.username.focus();
}
async function logout() {
  try { const d = await api('POST', '/auth/logout'); S.csrf = d.csrf; } catch { /* ignore */ }
  S.me = null; renderLogin();
}

// ---------------------------------------------------------------- shared filter bar
// Builds the filter row used by Entries and Reports. Returns { el, values() }.
function filterBar(L, q, extra = []) {
  const f = {
    from: h('input', { type: 'date', name: 'from', value: q.from || '' }),
    to: h('input', { type: 'date', name: 'to', value: q.to || '' }),
    machine_id: select('machine_id', [['', 'All machines'], ...L.machines.map((m) => [m.id, m.name])], q.machine_id),
    shift: select('shift', [['', 'All'], ['A', 'A'], ['B', 'B'], ['C', 'C']], q.shift),
    party: h('input', { name: 'party', list: 'dl-party', value: nameById(L.party, q.party_id), placeholder: 'Any party', style: 'width:180px' }),
    operator: h('input', { name: 'operator', list: 'dl-operator', value: nameById(L.operator, q.operator_id), placeholder: 'Any operator', style: 'width:150px' }),
    quality: h('input', { name: 'quality', list: 'dl-quality', value: nameById(L.quality, q.quality_id), placeholder: 'Any quality', style: 'width:140px' }),
    article: h('input', { name: 'article', list: 'dl-article', value: nameById(L.article, q.article_id), placeholder: 'Any article', style: 'width:120px' }),
    lot: h('input', { name: 'lot', value: q.lot || '', placeholder: 'Lot #', style: 'width:90px' }),
  };
  const presets = h('select', { 'aria-label': 'Quick range', onchange: (e) => {
    const v = e.target.value; const d = new Date(); let a, b = today();
    if (v === 'month') a = iso(new Date(d.getFullYear(), d.getMonth(), 1));
    if (v === 'last') { a = iso(new Date(d.getFullYear(), d.getMonth() - 1, 1)); b = iso(new Date(d.getFullYear(), d.getMonth(), 0)); }
    if (v === '7') a = iso(new Date(Date.now() - 6 * 864e5));
    if (v === '30') a = iso(new Date(Date.now() - 29 * 864e5));
    if (v === 'year') a = iso(new Date(d.getFullYear(), 0, 1));
    if (v === 'all') { a = ''; b = ''; }
    if (v) { f.from.value = a; f.to.value = b; }
    e.target.value = '';
  } }, [['', 'Quick range…'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['all', 'All dates']].map(([v, l]) => h('option', { value: v }, l)));
  const el = h('div', { class: 'row' },
    field('From', f.from), field('To', f.to), field('Range', presets), field('Machine', f.machine_id), field('Shift', f.shift),
    field('Party', f.party), field('Operator', f.operator), field('Quality', f.quality), field('Article', f.article), field('Lot', f.lot),
    extra,
    ['party', 'operator', 'quality', 'article'].map((k) => datalist('dl-' + k, L[k], false)));
  return {
    el,
    values: () => ({
      from: f.from.value, to: f.to.value, machine_id: f.machine_id.value, shift: f.shift.value,
      party_id: idByName(L.party, f.party.value), operator_id: idByName(L.operator, f.operator.value),
      quality_id: idByName(L.quality, f.quality.value), article_id: idByName(L.article, f.article.value), lot: f.lot.value.trim(),
      all: f.from.value || f.to.value ? '' : '1', // keeps "all dates" from falling back to the default range
    }),
  };
}

// ---------------------------------------------------------------- charts
// Single-series vertical bar chart with hover/focus tooltip. points: [{label, tip, value}]
function barChart(points, valueFmt, ariaLabel) {
  const W = 800, H = 220, padL = 52, padB = 26, padT = 8, padR = 4;
  const wrap = h('div', { class: 'chart' });
  if (!points.length) { wrap.append(h('p', { class: 'muted' }, 'No data for this range.')); return wrap; }
  const max = Math.max(...points.map((p) => p.value), 1);
  const step = niceStep(max / 4);
  const top = Math.ceil(max / step) * step;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const bw = plotW / points.length, gap = Math.min(2, bw * 0.3);
  const y = (v) => padT + plotH - (v / top) * plotH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel });
  for (let v = 0; v <= top + 1e-9; v += step) {
    svg.append(s('line', { class: 'gridline', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    svg.append(s('text', { class: 'axis', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt.short(v)));
  }
  const tip = h('div', { class: 'tip hidden' });
  const labelEvery = Math.ceil(points.length / 12);
  points.forEach((p, i) => {
    const x = padL + i * bw + gap / 2, w = Math.max(1, bw - gap), yy = y(p.value), bh = padT + plotH - yy;
    const r = Math.min(4, w / 2, bh);
    const d = bh <= 0 ? '' : `M${x},${padT + plotH} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + w - r} Q${x + w},${yy} ${x + w},${yy + r} V${padT + plotH} Z`;
    const hit = s('rect', { class: 'bar-hit', x: padL + i * bw, y: padT, width: bw, height: plotH, tabindex: 0, 'aria-label': `${p.tip}: ${valueFmt(p.value)}` });
    const show = (ev) => {
      tip.replaceChildren(h('strong', {}, valueFmt(p.value)), h('span', {}, p.tip));
      tip.classList.remove('hidden');
      const box = wrap.getBoundingClientRect();
      const cx = ev && ev.clientX ? ev.clientX - box.left : ((x + w / 2) / W) * box.width;
      tip.style.left = Math.min(Math.max(cx + 10, 0), box.width - tip.offsetWidth) + 'px';
      tip.style.top = Math.max(0, ((yy / H) * box.height) - 44) + 'px';
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', () => show());
    hit.addEventListener('pointerleave', () => tip.classList.add('hidden'));
    hit.addEventListener('blur', () => tip.classList.add('hidden'));
    svg.append(hit, s('path', { class: 'bar', d }));
    if (i % labelEvery === 0) svg.append(s('text', { class: 'axis', x: x + w / 2, y: H - 8, 'text-anchor': 'middle' }, p.label));
  });
  wrap.append(svg, tip);
  return wrap;
}
function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}
// Ranked horizontal bars with the value as text (identity by label, never by colour alone).
function hbars(rows, key, valueKey, valueFmt, onClick) {
  if (!rows.length) return h('p', { class: 'muted' }, 'No data.');
  const max = Math.max(...rows.map((r) => r[valueKey]), 1);
  return h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: 'hbar' },
    h('div', { class: 'hbar-head' },
      onClick ? h('a', { class: 'name', href: '#', title: r[key], onclick: (e) => { e.preventDefault(); onClick(r); } }, r[key]) : h('span', { class: 'name', title: r[key] }, r[key]),
      h('span', { class: 'val' }, valueFmt(r[valueKey], r))),
    h('div', { class: 'fill', style: `width:${(r[valueKey] / max) * 100}%` }))));
}

// ---------------------------------------------------------------- Dashboard
async function pageDashboard(r) {
  const L = await loadLookups();
  const q = { from: r.q.from || iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), to: r.q.to || today(), machine_id: r.q.machine_id || '' };
  const d = await api('GET', '/dashboard' + qs(q));
  const fromI = h('input', { type: 'date', value: d.from }), toI = h('input', { type: 'date', value: d.to });
  const mach = select('machine_id', [['', 'All machines'], ...L.machines.map((m) => [m.id, m.name])], q.machine_id);
  const apply = (a = fromI.value, b = toI.value) => go('dashboard', { from: a, to: b, machine_id: mach.value });
  const dt = new Date();
  const preset = (label, a, b) => h('button', { class: 'btn small', type: 'button', onclick: () => apply(a, b) }, label);
  const T = d.totals, P = d.previous;
  const delta = (cur, prev, better = 'up') => {
    if (!prev) return 'No data in previous period';
    const pct = ((cur - prev) / prev) * 100;
    const arrow = pct >= 0 ? '▲' : '▼';
    return `${arrow} ${NF1.format(Math.abs(pct))}% vs ${fmt.date(d.prev_from)} – ${fmt.date(d.prev_to)}`;
  };
  const tile = (label, value, sub, title) => h('div', { class: 'tile', title }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'delta' }, sub));
  const toEntries = (extra) => go('entries', { from: d.from, to: d.to, machine_id: q.machine_id, ...extra });

  // Daily series; long ranges are shown per month.
  const days = (new Date(d.to) - new Date(d.from)) / 864e5 + 1;
  let pts;
  if (days > 62) {
    const m = new Map();
    for (const x of d.daily) { const k = x.k.slice(0, 7); m.set(k, (m.get(k) || 0) + x.meters); }
    pts = [...m].map(([k, v]) => ({ label: fmt.month(k).slice(0, 3), tip: fmt.month(k), value: v }));
  } else {
    // Every day of the range, so days without production show as gaps instead of disappearing
    const byDay = new Map(d.daily.map((x) => [x.k, x.meters]));
    pts = [];
    for (let t = new Date(d.from + 'T00:00:00'); iso(t) <= d.to; t.setDate(t.getDate() + 1)) {
      const k = iso(t);
      pts.push({ label: k.slice(8, 10), tip: fmt.date(k), value: byDay.get(k) || 0 });
    }
  }
  const tableView = h('div', { class: 'table-wrap hidden', style: 'max-height:260px;margin-top:8px' },
    h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, days > 62 ? 'Month' : 'Date'), h('th', { class: 'num' }, 'Printed Mtr'))),
      h('tbody', {}, pts.map((p) => h('tr', {}, h('td', {}, p.tip), h('td', { class: 'num' }, fmt.n0(p.value)))))));
  const panel = (title, body, extra) => h('section', { class: 'panel' }, h('div', { class: 'row', style: 'margin-bottom:10px;align-items:center' }, h('h3', { style: 'margin:0' }, title), h('span', { class: 'grow' }), extra), body);

  return h('div', {},
    h('div', { class: 'panel no-print' }, h('div', { class: 'row' },
      field('From', fromI), field('To', toI), field('Machine', mach),
      h('button', { class: 'btn primary', onclick: () => apply() }, 'Show'),
      preset('This month', iso(new Date(dt.getFullYear(), dt.getMonth(), 1)), today()),
      preset('Last month', iso(new Date(dt.getFullYear(), dt.getMonth() - 1, 1)), iso(new Date(dt.getFullYear(), dt.getMonth(), 0))),
      preset('This year', iso(new Date(dt.getFullYear(), 0, 1)), today()),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted' }, d.last_entry ? 'Last entry: ' + fmt.date(d.last_entry) : 'No entries yet'))),
    T.entries === 0 ? h('div', { class: 'msg warn' }, 'No production in this date range.', can('import') ? [' ', h('a', { href: '#/import' }, 'Import the Excel sheet')] : '') : '',
    h('div', { class: 'tiles' },
      tile('Printed metres', fmt.n0(T.meters), delta(T.meters, P.meters)),
      tile('Ink used', fmt.n0(T.ink_litres) + ' L', delta(T.ink_litres, P.ink_litres)),
      tile('Ink cost', 'Rs ' + fmt.short(T.ink_cost), delta(T.ink_cost, P.ink_cost), fmt.rs(T.ink_cost)),
      tile('Avg ink', T.avg_ml === null ? '–' : fmt.n2(T.avg_ml) + ' ml/m', P.avg_ml ? 'Previous: ' + fmt.n2(P.avg_ml) + ' ml/m' : ''),
      tile('Ink cost per metre', T.cost_per_mtr === null ? '–' : 'Rs ' + fmt.n2(T.cost_per_mtr), P.cost_per_mtr ? 'Previous: Rs ' + fmt.n2(P.cost_per_mtr) : ''),
      tile('Entries / Lots', fmt.n0(T.entries) + ' / ' + fmt.n0(T.lots), fmt.n0(T.meters / Math.max(1, days)) + ' m per day')),
    panel((days > 62 ? 'Printed metres per month' : 'Printed metres per day'),
      h('div', {}, barChart(pts, (v) => fmt.n0(v) + ' m', 'Printed metres over time'), tableView),
      h('button', { class: 'btn small no-print', onclick: (e) => { tableView.classList.toggle('hidden'); e.target.textContent = tableView.classList.contains('hidden') ? 'Show table' : 'Hide table'; } }, 'Show table')),
    h('div', { class: 'cols' },
      panel('By machine', hbars(d.machines.map((x) => ({ ...x, k: x.k })), 'k', 'meters',
        (v, x) => `${fmt.n0(v)} m · ${x.avg_ml === null ? '–' : fmt.n1(x.avg_ml)} ml/m · Rs ${fmt.short(x.ink_cost)}`,
        (x) => toEntries({ machine_id: (L.machines.find((m) => m.name === x.k) || {}).id }))),
      panel('By shift', hbars(d.shifts.map((x) => ({ ...x, k: 'Shift ' + x.k })), 'k', 'meters',
        (v, x) => `${fmt.n0(v)} m · ${x.avg_ml === null ? '–' : fmt.n1(x.avg_ml)} ml/m`)),
      panel('Top operators', hbars(d.operators, 'k', 'meters', (v, x) => `${fmt.n0(v)} m · ${x.avg_ml === null ? '–' : fmt.n1(x.avg_ml)} ml/m`,
        (x) => toEntries({ operator_id: idByName(L.operator, x.k) }))),
      panel('Top parties', hbars(d.parties, 'k', 'meters', (v, x) => `${fmt.n0(v)} m · Rs ${fmt.short(x.ink_cost)}`,
        (x) => toEntries({ party_id: idByName(L.party, x.k) }))),
      panel('By article', hbars(d.articles, 'k', 'meters', (v) => `${fmt.n0(v)} m`)),
    ));
}

// ---------------------------------------------------------------- Entries list
async function pageEntries(r) {
  const L = await loadLookups();
  const q = { ...r.q };
  if (!Object.keys(q).length) q.from = iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)); // default: this month
  const search = h('input', { name: 'search', value: q.search || '', placeholder: 'Lot, design, party…', style: 'width:170px' });
  const sort = select('sort', [['', 'Newest first'], ['oldest', 'Oldest first'], ['mtr', 'Most metres'], ['ink', 'Highest ink']], q.sort);
  const fb = filterBar(L, q, [field('Search', search), field('Sort', sort)]);
  const box = h('div');
  const values = () => ({ ...fb.values(), search: search.value.trim(), sort: sort.value, flag: q.flag || '', batch_id: q.batch_id || '' });
  const apply = (e) => { e?.preventDefault(); go('entries', values()); };
  const data = await api('GET', '/entries' + qs({ ...q, page: q.page || 1 }));
  const T = data.totals;
  const highInk = +(await settingsCache()).ink_high_ml || 60;
  const notes = [];
  if (q.flag) notes.push(h('span', { class: 'badge warn' }, 'Data check: ' + FLAG_LABELS[q.flag]));
  if (q.batch_id) notes.push(h('span', { class: 'badge' }, 'Import batch #' + q.batch_id));
  const rows = data.rows.map((e) => h('tr', { class: can('entries.edit') ? 'clickable' : '', onclick: can('entries.edit') ? () => go('entry', {}, e.id) : null },
    h('td', { class: 'nowrap' }, fmt.date(e.entry_date)), h('td', {}, e.lot_no), h('td', {}, e.quality), h('td', {}, e.party), h('td', {}, e.design),
    h('td', { class: 'num' }, fmt.n0(e.printed_mtr)), h('td', {}, e.calibration),
    h('td', { class: 'num' + (e.ink_ml_per_mtr === null || +e.ink_ml_per_mtr > highInk ? ' flag' : '') }, e.ink_ml_per_mtr === null ? '—' : fmt.ink(e.ink_ml_per_mtr)),
    h('td', {}, e.article), h('td', { class: 'nowrap' }, e.machine), h('td', {}, e.shift), h('td', {}, e.operator),
    h('td', { class: 'num' }, e.ink_ml === null ? '' : fmt.n1(e.ink_ml / 1000)), h('td', { class: 'num' }, fmt.n0(e.ink_cost))));
  const pager = h('div', { class: 'pager' },
    h('button', { class: 'btn small', disabled: data.page <= 1, onclick: () => go('entries', { ...q, page: data.page - 1 }) }, '‹ Prev'),
    h('span', {}, `Page ${data.page} of ${data.pages} · ${fmt.n0(T.entries)} entries`),
    h('button', { class: 'btn small', disabled: data.page >= data.pages, onclick: () => go('entries', { ...q, page: data.page + 1 }) }, 'Next ›'));
  const bulkDelete = async () => {
    if (!(await confirmBox(`Delete all ${fmt.n0(T.entries)} entries matching these filters? This cannot be undone.`, 'Delete', true))) return;
    try { const res = await api('POST', '/entries/bulk-delete', q); msg(box, `${fmt.n0(res.deleted)} entries deleted.`, 'ok'); setTimeout(() => route(), 800); }
    catch (err) { msg(box, err.message); }
  };
  return h('div', {},
    h('form', { class: 'panel no-print', onsubmit: apply }, fb.el,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Show'),
        h('button', { class: 'btn', type: 'button', onclick: () => go('entries') }, 'Clear'),
        notes,
        h('span', { class: 'grow' }),
        can('entries.add') && h('a', { class: 'btn', href: '#/entry' }, '+ New entry'),
        h('a', { class: 'btn', href: 'api/entries.csv' + qs(q) }, 'Export CSV'),
        h('button', { class: 'btn', type: 'button', onclick: () => print() }, 'Print'),
        can('import') && T.entries > 0 && (q.from || q.batch_id) && h('button', { class: 'btn danger', type: 'button', onclick: bulkDelete }, 'Delete all shown…'))),
    box,
    h('div', { class: 'print-head' }, h('strong', {}, S.company), ' — Production entries ', q.from ? fmt.date(q.from) : '', ' to ', q.to ? fmt.date(q.to) : ''),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Date', 'Lot #', 'Quality', 'Party', 'Design'].map((t) => h('th', {}, t)), h('th', { class: 'num' }, 'Printed Mtr'), h('th', {}, 'Calibration'),
        h('th', { class: 'num' }, 'Ink ml/m'), h('th', {}, 'Article'), h('th', {}, 'Machine'), h('th', {}, 'Shift'), h('th', {}, 'Operator'), h('th', { class: 'num' }, 'Ink L'), h('th', { class: 'num' }, 'Cost Rs'))),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 14, class: 'muted' }, 'No entries match these filters.'))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: 5 }, `Total (${fmt.n0(T.entries)} entries, ${fmt.n0(T.lots)} lots)`), h('td', { class: 'num' }, fmt.n0(T.meters)), h('td'),
        h('td', { class: 'num' }, T.avg_ml === null ? '' : fmt.n2(T.avg_ml)), h('td', { colspan: 4 }), h('td', { class: 'num' }, fmt.n0(T.ink_litres)), h('td', { class: 'num' }, fmt.n0(T.ink_cost)))))),
    pager);
}
const FLAG_LABELS = {
  no_ink: 'Ink use missing', high_ink: 'Ink use too high', high_mtr: 'Printed metres too high',
  no_operator: 'Operator missing', no_party: 'Party missing', no_article: 'Article missing', no_quality: 'Quality missing',
};
let settingsPromise = null;
function settingsCache() { return settingsPromise ||= api('GET', '/settings').catch(() => ({})); }

// ---------------------------------------------------------------- Entry form
async function pageEntry(r) {
  const L = await loadLookups();
  const id = r.arg;
  let e = null;
  if (id) e = await api('GET', '/entries/' + encodeURIComponent(id));
  if (id && !can('entries.edit')) throw new ApiError('You do not have permission to edit entries.', 403);
  const last = !id ? await api('GET', '/entries/last').catch(() => null) : null;
  const src = e || (last ? { entry_date: last.entry_date, machine_id: last.machine_id, shift: last.shift, operator: last.operator, calibration: last.calibration } : { entry_date: today(), shift: 'A' });
  const box = h('div');
  const machines = L.machines.filter((m) => +m.is_active || (e && String(m.id) === String(e.machine_id)));
  const inp = (name, attrs = {}) => h('input', { name, value: src[name] ?? '', autocomplete: 'off', ...attrs });
  const form = h('form', { class: 'panel', onsubmit: (ev) => { ev.preventDefault(); save(false); } },
    box,
    h('div', { class: 'form-grid' },
      field('Date', inp('entry_date', { type: 'date', required: true, max: today() })),
      field('Lot #', inp('lot_no', { maxlength: 40 })),
      field('Party name', inp('party', { list: 'f-party', maxlength: 120 })),
      field('Quality', inp('quality', { list: 'f-quality', maxlength: 120 })),
      field('Design', inp('design', { maxlength: 80 })),
      field('Printed Mtr', inp('printed_mtr', { type: 'number', step: '0.01', min: '0', required: true, inputmode: 'decimal' })),
      field('Ink use (ml per metre)', inp('ink_ml_per_mtr', { type: 'number', step: '0.001', min: '0', inputmode: 'decimal' })),
      field('Calibration', inp('calibration', { list: 'f-calibration', maxlength: 120 })),
      field('Article', inp('article', { list: 'f-article', maxlength: 120 })),
      field('Machine', select('machine_id', [['', 'Choose…'], ...machines.map((m) => [m.id, m.name])], src.machine_id, { required: true })),
      field('Shift', select('shift', [['A', 'A'], ['B', 'B'], ['C', 'C']], src.shift || 'A')),
      field('Operator', inp('operator', { list: 'f-operator', maxlength: 120 })),
      field('Remarks', inp('remarks', { maxlength: 255 }), { wide: true })),
    ['party', 'quality', 'calibration', 'article', 'operator'].map((k) => datalist('f-' + k, L[k])),
    h('p', { class: 'muted', id: 'calc' }),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, id ? 'Save' : 'Save & next'),
      !id && h('span', { class: 'muted' }, 'Ctrl+S saves. Date, machine, shift, operator, party, lot and quality stay for the next entry.'),
      h('span', { class: 'grow' }),
      id && can('entries.delete') && h('button', { class: 'btn danger', type: 'button', onclick: del }, 'Delete'),
      h('a', { class: 'btn', href: '#/entries' }, 'Back to list')),
    e ? h('p', { class: 'muted' }, `Source: ${e.source}. Ink rate on this date: Rs ${fmt.n2(e.ink_rate)}/L. Created ${e.created_at}${e.updated_at ? ', changed ' + e.updated_at : ''}.`) : '');
  const calc = form.querySelector('#calc');
  const recalc = () => {
    const m = +form.printed_mtr.value, ink = +form.ink_ml_per_mtr.value;
    calc.textContent = m && ink ? `Total ink: ${fmt.n2((m * ink) / 1000)} L` : '';
  };
  form.addEventListener('input', recalc); recalc();
  // Enter moves to the next field like the Excel sheet; Ctrl+S saves.
  form.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(false); }
    if (ev.key === 'Enter' && ev.target.matches('input,select') && !ev.ctrlKey) {
      ev.preventDefault();
      const els = [...form.querySelectorAll('input,select')];
      const i = els.indexOf(ev.target);
      if (i === els.length - 1) save(false); else els[i + 1].focus();
    }
  });
  async function save() {
    const body = Object.fromEntries(new FormData(form));
    try {
      const saved = await api(id ? 'PUT' : 'POST', id ? '/entries/' + id : '/entries', body);
      S.lookups = null; // new names may have been added
      if (id) { msg(box, 'Saved.', 'ok'); return; }
      const L2 = await loadLookups();
      ['party', 'quality', 'calibration', 'article', 'operator'].forEach((k) => form.querySelector('#f-' + k).replaceWith(datalist('f-' + k, L2[k])));
      for (const k of ['design', 'printed_mtr', 'ink_ml_per_mtr', 'remarks']) form[k].value = '';
      form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
      msg(box, `Saved: ${fmt.date(saved.entry_date)} · lot ${saved.lot_no || '-'} · design ${saved.design || '-'} · ${fmt.n0(saved.printed_mtr)} m.`, 'ok');
      recalc();
      form.design.focus();
    } catch (err) { showErrors(form, err, box); }
  }
  async function del() {
    if (!(await confirmBox('Delete this entry?', 'Delete', true))) return;
    try { await api('DELETE', '/entries/' + id); go('entries'); } catch (err) { msg(box, err.message); }
  }
  setTimeout(() => (id ? form.entry_date : (form.lot_no.value ? form.design : form.lot_no)).focus(), 0);
  return form;
}

// ---------------------------------------------------------------- Reports
const DIMS = [['party', 'Party'], ['customer', 'Customer (party without Vol)'], ['lot', 'Lot #'], ['machine', 'Machine'], ['operator', 'Operator'], ['shift', 'Shift'], ['date', 'Date'], ['month', 'Month'],
  ['quality', 'Quality'], ['article', 'Article'], ['calibration', 'Calibration'], ['design', 'Design']];
async function pageReports(r) {
  const L = await loadLookups();
  const q = Object.keys(r.q).length ? { group: 'machine', ...r.q } : { group: 'machine', from: iso(new Date(new Date().getFullYear(), new Date().getMonth(), 1)) };
  const g1 = select('group', DIMS, q.group), g2 = select('group2', [['', '— none —'], ...DIMS], q.group2);
  const sort = select('sort', [['key', 'By name / date'], ['meters', 'Most metres'], ['cost', 'Highest cost'], ['avg', 'Highest ink ml/m']], q.sort);
  const fb = filterBar(L, q, [field('Group by', g1), field('Then by', g2), field('Order', sort)]);
  const run = (e) => { e?.preventDefault(); go('reports', { ...fb.values(), group: g1.value, group2: g2.value, sort: sort.value }); };
  const d = await api('GET', '/reports/summary' + qs(q));
  const lab = d.labels;
  const keyCell = (dim, v) => dim === 'date' ? fmt.date(v) : dim === 'month' ? fmt.month(v) : dim === 'shift' ? 'Shift ' + v : (v === '' ? '(blank)' : v);
  const metricCells = (x) => [h('td', { class: 'num' }, fmt.n0(x.entries)), h('td', { class: 'num' }, fmt.n0(x.lots)), h('td', { class: 'num' }, fmt.n0(x.meters)),
    h('td', { class: 'num' }, fmt.n1(x.ink_litres)), h('td', { class: 'num' }, x.avg_ml === null ? '' : fmt.n2(x.avg_ml)), h('td', { class: 'num' }, fmt.n0(x.ink_cost)),
    h('td', { class: 'num' }, x.cost_per_mtr === null ? '' : fmt.n2(x.cost_per_mtr))];
  const body = [];
  let prev = null;
  for (const x of d.rows) {
    if (d.group2 && x.k1 !== prev) {
      const sub = d.subtotals[String(x.k1)];
      body.push(h('tr', { class: 'sub' }, h('td', { colspan: 2 }, keyCell(d.group1, x.k1)), metricCells(sub)));
      prev = x.k1;
    }
    body.push(h('tr', {}, d.group2 ? [h('td'), h('td', {}, keyCell(d.group2, x.k2))] : h('td', {}, keyCell(d.group1, x.k1)), metricCells(x)));
  }
  const cols = d.group2 ? 2 : 1;
  return h('div', {},
    h('form', { class: 'panel no-print', onsubmit: run }, fb.el,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Show report'), h('span', { class: 'grow' }),
        h('a', { class: 'btn', href: 'api/reports/summary.csv' + qs(q) }, 'Export CSV'), h('button', { class: 'btn', type: 'button', onclick: () => print() }, 'Print'))),
    d.truncated ? h('div', { class: 'msg warn' }, 'Only the first 20,000 rows are shown. Narrow the filters.') : '',
    h('div', { class: 'print-head' }, h('strong', {}, S.company), ` — Production by ${lab[0]}${lab[1] ? ' and ' + lab[1] : ''}, `, q.from ? fmt.date(q.from) : 'start', ' to ', q.to ? fmt.date(q.to) : 'today'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, lab[0]), d.group2 && h('th', {}, lab[1]), ['Entries', 'Lots', 'Printed Mtr', 'Ink (L)', 'Avg ml/m', 'Ink Cost Rs', 'Rs per Mtr'].map((t) => h('th', { class: 'num' }, t)))),
      h('tbody', {}, body.length ? body : h('tr', {}, h('td', { colspan: cols + 7, class: 'muted' }, 'No data.'))),
      h('tfoot', {}, h('tr', {}, h('td', { colspan: cols }, 'Total'), metricCells(d.totals))))));
}

// ---------------------------------------------------------------- Import
async function pageImport() {
  const box = h('div');
  const result = h('div');
  const fileI = h('input', { type: 'file', name: 'file', accept: '.xlsx,.csv', required: true });
  const progress = h('progress', { max: 100, value: 0, class: 'hidden', style: 'width:200px' });
  const form = h('form', { class: 'panel', onsubmit: (e) => { e.preventDefault(); upload(); } },
    h('h3', {}, '1. Choose the Excel file'),
    h('p', { class: 'muted' }, 'Use the "Production Summary" sheet as it is: headings Date, Lot #, Quality, Party Name, Design, Printed Mtr, CALIBRATION, Ink use, Article, Machine, Shift, Operator. The sheet is found automatically. Ink use is ml per metre.'),
    box,
    h('div', { class: 'row' }, field('File (.xlsx or .csv)', fileI), h('button', { class: 'btn primary', type: 'submit' }, 'Upload & check'), progress));
  function upload() {
    if (!fileI.files[0]) return;
    const fd = new FormData(); fd.append('file', fileI.files[0]);
    // XHR for upload progress (the workbook can be ~10 MB)
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'api/import/upload');
    xhr.setRequestHeader('X-CSRF-Token', S.csrf);
    progress.classList.remove('hidden'); progress.value = 0;
    msg(box, 'Uploading…', 'warn');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { progress.value = (e.loaded / e.total) * 100; if (e.loaded === e.total) msg(box, 'Reading the workbook… (about 10–20 seconds for a large file)', 'warn'); } };
    xhr.onload = () => {
      progress.classList.add('hidden');
      let j; try { j = JSON.parse(xhr.responseText); } catch { return msg(box, `Server error (${xhr.status}). The file may be larger than the server allows.`); }
      if (!j.ok) return msg(box, (j.errors && j.errors.file) || j.error);
      msg(box, '');
      showPreview(j.data);
    };
    xhr.onerror = () => { progress.classList.add('hidden'); msg(box, 'Upload failed. Check the connection.'); };
    xhr.send(fd);
  }
  function showPreview(p) {
    const cbox = h('div');
    const mode = (v) => h('label', { style: 'display:flex;gap:6px;align-items:flex-start;margin:6px 0' }, h('input', { type: 'radio', name: 'mode', value: v, checked: v === 'append' }),
      v === 'append'
        ? h('span', {}, h('strong', {}, `Add new rows only (${fmt.n0(p.append_adds)} rows)`), h('br'), h('span', { class: 'muted' }, `Rows already imported earlier are skipped (${fmt.n0(p.already_imported)}). Use this every day with the same growing workbook.`))
        : h('span', {}, h('strong', {}, `Replace imported rows from ${fmt.date(p.date_from)} to ${fmt.date(p.date_to)}`), h('br'),
          h('span', { class: 'muted' }, `Removes ${fmt.n0(p.replace_removes)} previously imported rows in this date range (including edits made to them in the app), then adds all ${fmt.n0(p.rows_valid)} rows. Entries typed in the app are kept. Use after correcting old rows in Excel.`)));
    const sheetSel = p.sheets.length > 1 ? select('sheet', p.sheets.map((x) => [x, x]), p.sheet) : null;
    const commit = async (btn) => {
      const m = result.querySelector('input[name=mode]:checked').value;
      if (m === 'replace' && !(await confirmBox(`Remove ${fmt.n0(p.replace_removes)} imported rows and import ${fmt.n0(p.rows_valid)} rows again?`, 'Replace'))) return;
      btn.disabled = true; msg(cbox, 'Importing…', 'warn');
      try {
        const res = await api('POST', '/import/commit', { token: p.token, mode: m });
        S.lookups = null;
        result.replaceChildren(h('div', { class: 'msg ok' }, `Imported ${fmt.n0(res.added)} rows (${fmt.date(res.date_from)} – ${fmt.date(res.date_to)}).`,
          res.skipped ? ` ${fmt.n0(res.skipped)} already imported rows skipped.` : '', res.removed ? ` ${fmt.n0(res.removed)} old rows replaced.` : '', ' ',
          h('a', { href: '#/entries' + qs({ batch_id: res.batch_id }) }, 'View them'), ' · ', h('a', { href: '#/check' }, 'Run the data check')));
        history.replaceChildren(await batchTable());
      } catch (err) { btn.disabled = false; msg(cbox, err.message); }
    };
    result.replaceChildren(h('div', { class: 'panel' },
      h('h3', {}, '2. Check what will be imported'),
      h('table', { class: 'grid', style: 'max-width:640px' }, h('tbody', {},
        [['File', p.file_name], ['Sheet', sheetSel ? h('span', {}, sheetSel, ' ', h('button', { class: 'btn small', onclick: async () => {
          try { msg(cbox, 'Reading…', 'warn'); showPreview(await api('POST', '/import/preview', { token: p.token, sheet: sheetSel.value })); } catch (err) { msg(cbox, err.message); }
        } }, 'Read this sheet')) : p.sheet || 'CSV'],
        ['Valid rows', fmt.n0(p.rows_valid)], ['Rows with problems (not imported)', fmt.n0(p.rows_failed)],
        ['Dates', `${fmt.date(p.date_from)} to ${fmt.date(p.date_to)}`], ['Printed metres', fmt.n0(p.meters)],
        ['Rows with missing or very high ink use', fmt.n0(p.ink_warnings) + ' (imported; listed later in Data Check)'],
        ['Already imported earlier', fmt.n0(p.already_imported)]].map(([k, v]) => h('tr', {}, h('th', { style: 'position:static' }, k), h('td', {}, v))))),
      Object.keys(p.new_names).length ? h('details', { style: 'margin-top:10px' }, h('summary', {}, 'New names that will be added: ',
        Object.entries(p.new_names).map(([k, v]) => `${v.length} ${k}`).join(', ')),
        Object.entries(p.new_names).map(([k, v]) => h('p', {}, h('strong', {}, k + ': '), v.join(' · ')))) : '',
      p.errors.length ? h('details', { style: 'margin-top:10px', open: true }, h('summary', {}, `Problems (${fmt.n0(p.rows_failed)}) — fix these in Excel and import again`),
        h('div', { class: 'table-wrap', style: 'max-height:300px' }, h('table', { class: 'grid' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Excel row'), h('th', {}, 'Problem'), h('th', {}, 'Values'))),
          h('tbody', {}, p.errors.map((e) => h('tr', {}, h('td', {}, e.row), h('td', {}, e.error), h('td', { class: 'muted' }, Object.values(e.values).filter((v) => v !== null).join(' | ')))))))) : '',
      h('h3', { style: 'margin-top:16px' }, '3. Import'),
      mode('append'), mode('replace'),
      cbox,
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: (e) => commit(e.target) }, 'Import now'))));
  }
  const history = h('div', {}, await batchTable());
  return h('div', {}, form, result, h('section', { class: 'panel' }, h('h3', {}, 'Import history'), history));
}
async function batchTable() {
  const rows = await api('GET', '/import/batches');
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing imported yet.');
  return h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, ['#', 'When', 'By', 'File', 'Mode', 'Dates'].map((t) => h('th', {}, t)), ['Read', 'Added', 'Skipped', 'Replaced', 'Still in app'].map((t) => h('th', { class: 'num' }, t)))),
    h('tbody', {}, rows.map((b) => h('tr', {}, h('td', {}, b.id), h('td', { class: 'nowrap' }, b.created_at), h('td', {}, b.username), h('td', {}, b.file_name), h('td', {}, b.mode),
      h('td', { class: 'nowrap' }, `${fmt.date(b.date_from)} – ${fmt.date(b.date_to)}`),
      h('td', { class: 'num' }, fmt.n0(b.rows_read)), h('td', { class: 'num' }, fmt.n0(b.rows_added)), h('td', { class: 'num' }, fmt.n0(b.rows_skipped)),
      h('td', { class: 'num' }, fmt.n0(b.rows_removed)), h('td', { class: 'num' }, +b.rows_now ? h('a', { href: '#/entries' + qs({ batch_id: b.id }) }, fmt.n0(b.rows_now)) : '0'))))));
}

// ---------------------------------------------------------------- Data check
async function pageCheck(r) {
  const q = { from: r.q.from || '', to: r.q.to || '' };
  const d = await api('GET', '/reports/checks' + qs(q));
  const st = await settingsCache();
  const fromI = h('input', { type: 'date', value: q.from }), toI = h('input', { type: 'date', value: q.to });
  const hint = { high_ink: `above ${st.ink_high_ml} ml/m`, high_mtr: `above ${fmt.n0(st.mtr_high)} m in one row` };
  const box = h('div');
  const KIND_LABEL = { party: 'Parties', quality: 'Qualities', article: 'Articles', calibration: 'Calibrations', operator: 'Operators' };
  const simPanels = Object.entries(d.similar).filter(([, v]) => v.length).map(([kind, pairs]) => h('section', { class: 'panel' },
    h('h3', {}, `${KIND_LABEL[kind]}: possible spelling variants (${pairs.length})`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Merge this'), h('th', { class: 'num' }, 'Entries'), h('th', {}, 'into'), h('th', { class: 'num' }, 'Entries'), h('th'))),
      h('tbody', {}, pairs.map((p) => h('tr', {}, h('td', {}, p.merge.name), h('td', { class: 'num' }, fmt.n0(p.merge.entries)), h('td', {}, p.keep.name), h('td', { class: 'num' }, fmt.n0(p.keep.entries)),
        h('td', {}, can('masters.edit') ? [
          h('button', { class: 'btn small', onclick: () => doMerge(p.merge, p.keep) }, 'Merge'), ' ',
          h('button', { class: 'btn small', title: 'Keep the other name instead', onclick: () => doMerge(p.keep, p.merge) }, '⇄ Other way')] : ''))))))));
  async function doMerge(src, dst) {
    if (!(await confirmBox(`Merge "${src.name}" into "${dst.name}"? All ${fmt.n0(src.entries)} entries will use "${dst.name}".`, 'Merge'))) return;
    try { const res = await api('POST', `/master/${src.id}/merge`, { target_id: dst.id }); S.lookups = null; msg(box, `${fmt.n0(res.moved)} entries moved.`, 'ok'); setTimeout(route, 600); }
    catch (err) { msg(box, err.message); }
  }
  return h('div', {},
    h('div', { class: 'panel no-print' }, h('div', { class: 'row' }, field('From', fromI), field('To', toI),
      h('button', { class: 'btn primary', onclick: () => go('check', { from: fromI.value, to: toI.value }) }, 'Check'),
      h('span', { class: 'muted' }, 'Leave dates empty to check everything.'))),
    box,
    h('section', { class: 'panel' }, h('h3', {}, 'Entries to review'),
      h('table', { class: 'grid', style: 'max-width:560px' }, h('tbody', {}, Object.entries(d.counts).map(([flag, n]) => h('tr', {},
        h('td', {}, FLAG_LABELS[flag], hint[flag] ? h('span', { class: 'muted' }, ' (' + hint[flag] + ')') : ''),
        h('td', { class: 'num' + (n ? ' flag' : '') }, fmt.n0(n)),
        h('td', {}, n ? h('a', { href: '#/entries' + qs({ ...q, from: q.from || '', flag, sort: flag === 'high_ink' ? 'ink' : flag === 'high_mtr' ? 'mtr' : '' }) }, 'Show') : '✓'))))),
      h('p', { class: 'muted' }, 'Very high ink use usually means the total ink was typed in the "Ink use" column instead of ml per metre. Thresholds are in Settings.')),
    simPanels.length ? simPanels : h('div', { class: 'msg ok' }, 'No similar names found in the lists.'));
}

// ---------------------------------------------------------------- Machines & rates
async function pageMachines() {
  const rows = await api('GET', '/machines');
  const box = h('div');
  const edit = can('masters.edit'), rates = can('rates.edit');
  const refresh = () => { S.lookups = null; route(); };
  const add = async () => {
    const st = await settingsCache();
    const f = h('form', {}, h('div', { class: 'form-grid' }, field('Name', h('input', { name: 'name', required: true, maxlength: 60 })),
      field('Ink rate (Rs per litre)', h('input', { name: 'rate_per_litre', type: 'number', step: '0.01', min: 0, value: st.default_ink_rate ?? '', required: true }))), h('div', { class: 'err-box' }));
    const d = dialog('Add machine', f, [h('button', { class: 'btn primary', onclick: async () => {
      try { await api('POST', '/machines', Object.fromEntries(new FormData(f))); d.close(); refresh(); } catch (err) { showErrors(f, err, f.querySelector('.err-box')); }
    } }, 'Save'), h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')]);
  };
  const card = (m) => {
    const rf = h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      try { await api('POST', `/machines/${m.id}/rates`, Object.fromEntries(new FormData(rf))); msg(box, `Rate saved for ${m.name}; its entries were re-priced.`, 'ok'); refresh(); }
      catch (err) { showErrors(rf, err, box); }
    } },
    field('New rate from date', h('input', { type: 'date', name: 'effective_from', value: today(), required: true })),
    field('Rs per litre', h('input', { type: 'number', name: 'rate_per_litre', step: '0.01', min: 0, required: true, style: 'width:120px' })),
    field('Note', h('input', { name: 'note', maxlength: 150, placeholder: 'e.g. new ink supplier' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add rate'));
    return h('section', { class: 'panel' },
      h('div', { class: 'row', style: 'align-items:center;margin-bottom:8px' },
        h('h3', { style: 'margin:0' }, m.name), +m.is_active ? '' : h('span', { class: 'badge off' }, 'inactive'),
        h('span', { class: 'muted' }, `${fmt.n0(m.entries)} entries · ${fmt.n0(m.meters)} m · current rate Rs ${fmt.n2(m.current_rate)}/L`),
        h('span', { class: 'grow' }),
        edit && h('button', { class: 'btn small', onclick: () => renameDialog(m.name, (name) => api('PUT', '/machines/' + m.id, { name }), refresh) }, 'Rename'),
        edit && h('button', { class: 'btn small', onclick: async () => { await api('PUT', '/machines/' + m.id, { is_active: +m.is_active ? 0 : 1 }); refresh(); } }, +m.is_active ? 'Deactivate' : 'Activate'),
        edit && rows.length > 1 && h('button', { class: 'btn small', onclick: () => mergeDialog(m, rows.filter((x) => x.id !== m.id), (t) => api('POST', `/machines/${m.id}/merge`, { target_id: t }), refresh) }, 'Merge…'),
        edit && +m.entries === 0 && h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox(`Delete machine ${m.name}?`, 'Delete')) { try { await api('DELETE', '/machines/' + m.id); refresh(); } catch (err) { msg(box, err.message); } } } }, 'Delete')),
      h('table', { class: 'grid', style: 'max-width:640px' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Effective from'), h('th', { class: 'num' }, 'Rs per litre'), h('th', {}, 'Note'), h('th'))),
        h('tbody', {}, m.rates.map((rt) => h('tr', {}, h('td', {}, rt.effective_from === '2000-01-01' ? 'Start' : fmt.date(rt.effective_from)), h('td', { class: 'num' }, fmt.n2(rt.rate_per_litre)), h('td', {}, rt.note),
          h('td', {}, rates && m.rates.length > 1 && h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmBox(`Delete the rate from ${rt.effective_from}? Entries will be re-priced.`, 'Delete'))) return;
            try { await api('DELETE', `/machines/${m.id}/rates/${rt.id}`); refresh(); } catch (err) { msg(box, err.message); }
          } }, 'Delete')))))),
      rates && h('div', { style: 'margin-top:10px' }, rf));
  };
  return h('div', {},
    h('div', { class: 'msg warn' }, 'Ink cost = Printed Mtr × Ink use (ml/m) ÷ 1000 × machine rate (Rs/L) on the entry date. Changing a rate re-prices that machine\'s entries from that date on.'),
    box,
    edit && h('div', { class: 'actions', style: 'margin:0 0 12px' }, h('button', { class: 'btn primary', onclick: add }, '+ Add machine')),
    rows.map(card));
}
function renameDialog(current, saveFn, done) {
  const input = h('input', { name: 'name', value: current, maxlength: 120, style: 'width:100%' });
  const f = h('form', { onsubmit: (e) => { e.preventDefault(); go2(); } }, field('New name', input), h('div', { class: 'err-box' }));
  const go2 = async () => { try { await saveFn(input.value); d.close(); done(); } catch (err) { showErrors(f, err, f.querySelector('.err-box')); } };
  const d = dialog('Rename', f, [h('button', { class: 'btn primary', onclick: go2 }, 'Save'), h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')]);
  input.select();
}
function mergeDialog(src, targets, mergeFn, done) {
  const input = h('input', { list: 'merge-dl', style: 'width:100%', placeholder: 'Type to search…' });
  const err = h('div');
  const go2 = async () => {
    const t = targets.find((x) => x.name.toLowerCase() === input.value.trim().toLowerCase());
    if (!t) return msg(err, 'Choose a name from the list.');
    try { const res = await mergeFn(t.id); d.close(); done(res); } catch (e) { msg(err, e.message); }
  };
  const d = dialog(`Merge "${src.name}"`, h('div', {},
    h('p', {}, `All ${fmt.n0(src.entries)} entries of "${src.name}" will move to the name you choose, and "${src.name}" will be removed.`),
    field('Merge into', input), datalist('merge-dl', targets, false), err),
  [h('button', { class: 'btn primary', onclick: go2 }, 'Merge'), h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')]);
  input.focus();
}

// ---------------------------------------------------------------- Lists (masters)
const KINDS = [['party', 'Parties'], ['operator', 'Operators'], ['quality', 'Qualities'], ['article', 'Articles'], ['calibration', 'Calibrations']];
async function pageLists(r) {
  const kind = KINDS.some(([k]) => k === r.arg) ? r.arg : 'party';
  const d = await api('GET', '/masters/' + kind);
  const edit = can('masters.edit');
  const box = h('div');
  const refresh = () => { S.lookups = null; route(); };
  const filter = h('input', { type: 'search', placeholder: 'Filter…', value: r.q.f || '', style: 'width:220px' });
  const tbody = h('tbody');
  const COL = { party: 'party_id', operator: 'operator_id', quality: 'quality_id', article: 'article_id', calibration: 'calibration_id' }[kind];
  const draw = () => {
    const f = filter.value.trim().toLowerCase();
    const rows = d.rows.filter((x) => !f || x.name.toLowerCase().includes(f));
    tbody.replaceChildren(...rows.slice(0, 1000).map((x) => h('tr', {},
      h('td', {}, x.name, ' ', +x.is_active ? '' : h('span', { class: 'badge off' }, 'inactive')),
      h('td', { class: 'num' }, +x.entries ? h('a', { href: '#/entries' + qs({ [COL]: x.id }) }, fmt.n0(x.entries)) : '0'),
      h('td', { class: 'num' }, fmt.n0(x.meters)), h('td', { class: 'nowrap' }, fmt.date(x.last_used)),
      h('td', { class: 'nowrap' }, edit && [
        h('button', { class: 'btn small', onclick: () => renameDialog(x.name, (name) => api('PUT', '/master/' + x.id, { name }), refresh) }, 'Rename'), ' ',
        h('button', { class: 'btn small', onclick: () => mergeDialog(x, d.rows.filter((y) => y.id !== x.id), (t) => api('POST', `/master/${x.id}/merge`, { target_id: t }), refresh) }, 'Merge…'), ' ',
        h('button', { class: 'btn small', onclick: async () => { await api('PUT', '/master/' + x.id, { is_active: +x.is_active ? 0 : 1 }); refresh(); } }, +x.is_active ? 'Hide' : 'Show'), ' ',
        +x.entries === 0 && h('button', { class: 'btn small danger', onclick: async () => { try { await api('DELETE', '/master/' + x.id); refresh(); } catch (err) { msg(box, err.message); } } }, 'Delete')]))));
    if (rows.length > 1000) tbody.append(h('tr', {}, h('td', { colspan: 5, class: 'muted' }, `${rows.length - 1000} more — type in the filter.`)));
  };
  filter.addEventListener('input', () => { setQuery({ f: filter.value }); draw(); });
  draw();
  const addI = h('input', { placeholder: 'New name', maxlength: 120 });
  return h('div', {},
    h('div', { class: 'actions', style: 'margin:0 0 12px' }, KINDS.map(([k, l]) => h('a', { class: 'btn' + (k === kind ? ' primary' : ''), href: '#/lists/' + k }, l))),
    d.similar.length ? h('div', { class: 'msg warn' }, `${d.similar.length} possible spelling variants in this list. `, h('a', { href: '#/check' }, 'Review in Data Check')) : '',
    box,
    h('div', { class: 'panel' }, h('div', { class: 'row' }, filter, h('span', { class: 'muted' }, `${fmt.n0(d.rows.length)} names. Hidden names stay on old entries but are not suggested in the entry form.`),
      h('span', { class: 'grow' }),
      edit && [addI, h('button', { class: 'btn', onclick: async () => { try { await api('POST', '/masters/' + kind, { name: addI.value }); refresh(); } catch (err) { msg(box, err.message); } } }, 'Add')])),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', { class: 'num' }, 'Entries'), h('th', { class: 'num' }, 'Printed Mtr'), h('th', {}, 'Last used'), h('th'))), tbody)));
}

// ---------------------------------------------------------------- Users
async function pageUsers() {
  const rows = await api('GET', '/users');
  const ROLE_HELP = { admin: 'Everything, incl. users & settings', manager: 'Entries, import, lists, ink rates', entry: 'Add & edit entries', viewer: 'View & reports only' };
  const open = (u) => {
    const f = h('form', {}, h('div', { class: 'form-grid' },
      field('Username', h('input', { name: 'username', value: u?.username || '', required: true })),
      field('Full name', h('input', { name: 'full_name', value: u?.full_name || '' })),
      field('Role', select('role', Object.entries(ROLE_HELP).map(([k, v]) => [k, `${k} — ${v}`]), u?.role || 'entry')),
      field(u ? 'New password (leave empty to keep)' : 'Password', h('input', { name: 'password', type: 'password', autocomplete: 'new-password' })),
      h('label', { class: 'field' }, h('span', {}, 'Active'), h('input', { type: 'checkbox', name: 'is_active', checked: u ? +u.is_active : true }))),
    h('p', { class: 'muted' }, 'A new or reset password must be changed by the user at the next login.'), h('div', { class: 'err-box' }));
    const d = dialog(u ? 'Edit user' : 'Add user', f, [h('button', { class: 'btn primary', onclick: async () => {
      const body = Object.fromEntries(new FormData(f)); body.is_active = f.is_active.checked ? 1 : 0;
      try { await api(u ? 'PUT' : 'POST', u ? '/users/' + u.id : '/users', body); d.close(); route(); } catch (err) { showErrors(f, err, f.querySelector('.err-box')); }
    } }, 'Save'), h('button', { class: 'btn', onclick: () => d.close() }, 'Cancel')]);
  };
  return h('div', {},
    h('div', { class: 'actions', style: 'margin:0 0 12px' }, h('button', { class: 'btn primary', onclick: () => open(null) }, '+ Add user')),
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['Username', 'Name', 'Role', 'Status', 'Last login'].map((t) => h('th', {}, t)))),
      h('tbody', {}, rows.map((u) => h('tr', { class: 'clickable', onclick: () => open(u) }, h('td', {}, u.username), h('td', {}, u.full_name), h('td', {}, u.role),
        h('td', {}, +u.is_active ? (+u.must_change_password ? h('span', { class: 'badge warn' }, 'must change password') : 'active') : h('span', { class: 'badge off' }, 'disabled')),
        h('td', {}, u.last_login_at || '—')))))));
}

// ---------------------------------------------------------------- Settings
async function pageSettings() {
  settingsPromise = null;
  const st = await settingsCache();
  const box = h('div');
  const ro = !can('settings');
  const f = h('form', { class: 'panel', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('PUT', '/settings', Object.fromEntries(new FormData(f))); settingsPromise = null; msg(box, 'Settings saved.', 'ok'); S.company = f.company_name.value; }
    catch (err) { showErrors(f, err, box); }
  } }, box, h('div', { class: 'form-grid' },
    field('Company name', h('input', { name: 'company_name', value: st.company_name ?? '', disabled: ro }), { wide: true }),
    field('Default ink rate for new machines (Rs/L)', h('input', { name: 'default_ink_rate', type: 'number', step: '0.01', value: st.default_ink_rate ?? '', disabled: ro })),
    field('Data check: ink use above (ml/m)', h('input', { name: 'ink_high_ml', type: 'number', step: '0.1', value: st.ink_high_ml ?? '', disabled: ro })),
    field('Data check: printed metres above', h('input', { name: 'mtr_high', type: 'number', step: '1', value: st.mtr_high ?? '', disabled: ro }))),
  !ro && h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save')),
  h('p', { class: 'muted' }, 'Ink rates per machine are set under Machines & Ink Rates.'));
  return f;
}

// ---------------------------------------------------------------- Audit
async function pageAudit(r) {
  const d = await api('GET', '/audit' + qs({ page: r.q.page || 1 }));
  const short = (j) => { if (!j) return ''; try { return Object.entries(JSON.parse(j)).map(([k, v]) => `${k}: ${v}`).join(', ').slice(0, 300); } catch { return j; } };
  return h('div', {},
    h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', {}, h('tr', {}, ['When', 'User', 'Action', 'Record', 'Before', 'After'].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.rows.map((a) => h('tr', {}, h('td', { class: 'nowrap' }, a.created_at), h('td', {}, a.username || '—'), h('td', {}, a.action),
        h('td', { class: 'nowrap' }, a.entity, a.entity_id ? ' #' + a.entity_id : ''), h('td', { class: 'muted' }, short(a.old_values)), h('td', {}, short(a.new_values))))))),
    h('div', { class: 'pager' },
      h('button', { class: 'btn small', disabled: d.page <= 1, onclick: () => go('audit', { page: d.page - 1 }) }, '‹ Newer'),
      h('span', {}, `Page ${d.page} of ${d.pages}`),
      h('button', { class: 'btn small', disabled: d.page >= d.pages, onclick: () => go('audit', { page: d.page + 1 }) }, 'Older ›')));
}

// ---------------------------------------------------------------- Password
async function pagePassword() {
  const box = h('div');
  const f = h('form', { class: 'panel', style: 'max-width:420px', onsubmit: async (e) => {
    e.preventDefault();
    if (f.password.value !== f.password2.value) return showErrors(f, new ApiError('Passwords do not match.', 422, { password2: 'Passwords do not match.' }), box);
    try {
      applySession(await api('POST', '/auth/password', { current: f.current.value, password: f.password.value }));
      renderShell(); go('dashboard'); route();
    } catch (err) { showErrors(f, err, box); }
  } },
  S.me.must_change_password ? h('div', { class: 'msg warn' }, 'Please choose your own password before continuing.') : '',
  box,
  field('Current password', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })), h('div', { style: 'height:8px' }),
  field('New password (8+ characters, letters and numbers)', h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true })), h('div', { style: 'height:8px' }),
  field('Repeat new password', h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: true })),
  h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'submit' }, 'Change password')));
  return f;
}

// ---------------------------------------------------------------- boot
(async function boot() {
  try {
    const d = await api('GET', '/auth/me');
    applySession(d);
    if (!S.me) return renderLogin();
    renderShell();
    route();
  } catch (e) {
    $app.replaceChildren(h('div', { class: 'msg error', style: 'margin:40px' }, e.message));
  }
})();
