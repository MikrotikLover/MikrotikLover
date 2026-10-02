// Application bootstrap: session check, shell (menu / title / footer), routes, idle session handling.
import { get, post, on, setCsrf } from './core/api.js';
import { h, toast } from './core/dom.js';
import { LEGEND } from './core/keys.js';
import { route, start, go, currentPath } from './core/router.js';
import { session, can, loadLookups } from './core/store.js';

const NAV = [
  { group: 'General', items: [
    { path: '/', label: 'Dashboard', ico: '◧', perm: ['dashboard', 'view'] },
  ] },
  { group: 'Setup', items: [
    { path: '/employees/new', label: 'Employee Info', ico: '✎', perm: ['employees', 'view'] },
    { path: '/employees', label: 'List of Employees', ico: '☰', perm: ['employees', 'view'] },
    { path: '/departments', label: 'Departments', ico: '▦', perm: ['departments', 'view'] },
    { path: '/designations', label: 'Designations', ico: '◈', perm: ['designations', 'view'] },
    { path: '/shifts', label: 'Shifts', ico: '◷', perm: ['shifts', 'view'] },
    { path: '/shift-groups', label: 'Shift Groups', ico: '⟳', perm: ['shift_groups', 'view'] },
    { path: '/holidays', label: 'Holidays & Rest Days', ico: '☀', perm: ['holidays', 'view'] },
    { path: '/settings/company', label: 'Company Settings', ico: '⚙', perm: ['settings', 'view'] },
  ] },
  { group: 'Attendance', items: [
    { path: '/attendance/voucher', label: 'Attendance Voucher', ico: '✓', perm: ['attendance', 'view'] },
    { path: '/attendance/post', label: 'Daily Attendance Post', ico: '⇪', perm: ['attendance_post', 'view'] },
    { path: '/overtime', label: 'Overtime Approval', ico: '⏱', perm: ['overtime', 'view'] },
    { path: '/leaves', label: 'Leave Register', ico: '✈', perm: ['leave', 'view'] },
    { path: '/leave-types', label: 'Leave Types', ico: '≡', perm: ['leave', 'view'] },
    { path: '/attendance/import', label: 'Machine Log Import', ico: '⇩', perm: ['attendance', 'add'] },
    { path: '/devices', label: 'Devices, Kiosk & TV', ico: '⌁', perm: ['devices', 'view'] },
  ] },
  { group: 'Reports', items: [
    { path: '/reports', label: 'Reports & ID Cards', ico: '⎙', perm: ['reports', 'view'] },
  ] },
  { group: 'Administration', items: [
    { path: '/users', label: 'Users', ico: '☺', perm: ['users', 'view'] },
    { path: '/roles', label: 'Roles & Permissions', ico: '⚿', perm: ['users', 'view'] },
  ] },
];

const page = (file) => () => import(`./pages/${file}.js`);
route('/', page('dashboard'), { title: 'Dashboard', perm: ['dashboard', 'view'] });
route('/login', page('login'), { title: 'Login', public: true });
route('/password', page('password'), { title: 'Change Password' });
route('/employees', page('employee-list'), { title: 'List of Employees', perm: ['employees', 'view'] });
route('/employees/new', page('employee'), { title: 'Employee Info', perm: ['employees', 'view'] });
route('/employees/:id', page('employee'), { title: 'Employee Info', perm: ['employees', 'view'] });
route('/departments', page('masters'), { title: 'Department Info', perm: ['departments', 'view'], kind: 'departments' });
route('/designations', page('masters'), { title: 'Designations', perm: ['designations', 'view'], kind: 'designations' });
route('/shifts', page('masters'), { title: 'Shift Info', perm: ['shifts', 'view'], kind: 'shifts' });
route('/shift-groups', page('masters'), { title: 'Shift Groups', perm: ['shift_groups', 'view'], kind: 'shift_groups' });
route('/holidays', page('masters'), { title: 'Holidays & Weekly Rest Days', perm: ['holidays', 'view'], kind: 'holidays' });
route('/settings/company', page('settings'), { title: 'Company Settings', perm: ['settings', 'view'] });
route('/reports', page('reports'), { title: 'Reports & ID Cards', perm: ['reports', 'view'] });
route('/attendance/voucher', page('attendance-voucher'), { title: 'Manual Attendance Voucher', perm: ['attendance', 'view'] });
route('/attendance/post', page('attendance-post'), { title: 'Daily Attendance Post', perm: ['attendance_post', 'view'] });
route('/attendance/import', page('attendance-import'), { title: 'Machine Log Import (CSV / Excel)', perm: ['attendance', 'add'] });
route('/overtime', page('overtime'), { title: 'Overtime Approval', perm: ['overtime', 'view'] });
route('/leaves', page('leave'), { title: 'Employee Leave Register', perm: ['leave', 'view'] });
route('/leave-types', page('masters'), { title: 'Leave Types', perm: ['leave', 'view'], kind: 'leave_types' });
route('/devices', page('masters'), { title: 'Attendance Devices, Kiosk & TV', perm: ['devices', 'view'], kind: 'devices' });
route('/users', page('users'), { title: 'Users', perm: ['users', 'view'] });
route('/roles', page('roles'), { title: 'Roles & Permissions', perm: ['users', 'view'] });

const root = document.getElementById('app');
let shell = null;
let returnTo = null;

function buildShell() {
  const nav = h('nav', { class: 'nav' });
  const title = h('h1');
  const main = h('main', { class: 'main', id: 'main' });
  const clock = h('span');
  const userBox = h('span', { class: 'user' });
  const el = h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'P'),
        h('div', null, session.company.name || window.APP.name, h('small', null, window.APP.name))),
      nav),
    h('header', { class: 'top' },
      h('button', { class: 'btn icon menu-btn', type: 'button', 'aria-label': 'Menu', onclick: () => document.body.classList.toggle('nav-open') }, '☰'),
      title,
      h('a', { class: 'btn sm', href: '#/password', title: 'Change password' }, 'Password'),
      h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Logout')),
    main,
    h('footer', { class: 'foot' }, userBox, clock, h('span', { class: 'keys' }, LEGEND)));
  root.replaceChildren(el);
  shell = { el, nav, title, main, clock, userBox };
  renderNav();
  userBox.replaceChildren('User: ', h('b', null, session.user.full_name), ` (${session.user.role})`);
  const tick = () => {
    clock.textContent = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 30000);
}

function renderNav() {
  const path = currentPath();
  shell.nav.replaceChildren(...NAV.map((g) => {
    const items = g.items.filter((i) => can(...i.perm));
    if (!items.length) return null;
    return h('div', { class: 'nav-group' }, h('div', null, g.group), items.map((i) =>
      h('a', { href: '#' + i.path, class: path === i.path ? 'active' : '', onclick: () => document.body.classList.remove('nav-open') },
        h('span', { class: 'ico' }, i.ico), i.label)));
  }).filter(Boolean));
}

function onNavigate(r, path) {
  if (r.meta.public) {
    shell = null;
    r.meta.container = root;
    return true;
  }
  if (!session.user) {
    returnTo = path;
    go('/login', { replace: true });
    return false;
  }
  if (session.user.must_change_password && path !== '/password') {
    go('/password', { replace: true });
    return false;
  }
  if (!shell) buildShell();
  if (r.meta.perm && !can(...r.meta.perm)) {
    shell.main.replaceChildren(h('div', { class: 'panel panel-body' }, 'You do not have permission to open this screen.'));
    shell.title.textContent = r.meta.title;
    return false;
  }
  shell.title.textContent = r.meta.title || '';
  document.title = `${r.meta.title} · ${window.APP.name}`;
  // render into main instead of root
  r.meta.container = shell.main;
  renderNav();
  return true;
}

async function logout() {
  try {
    const d = await post('auth/logout');
    setCsrf(d.csrf);
  } catch { /* ignore */ }
  session.user = null;
  session.permissions = {};
  shell = null;
  go('/login');
}

/** Called by the login page after successful authentication. */
export async function afterLogin(data) {
  setCsrf(data.csrf);
  session.user = data.user;
  session.permissions = data.permissions || {};
  window.APP.user = data.user;
  await loadLookups();
  const target = session.user.must_change_password ? '/password' : (returnTo && returnTo !== '/login' ? returnTo : '/');
  returnTo = null;
  go(target, { replace: true });
}

export function markPasswordChanged() {
  session.user.must_change_password = false;
}

// ---------- idle session handling ----------
let lastActivity = Date.now();
let lastPing = Date.now();
['keydown', 'mousedown', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(async () => {
  if (!session.user) return;
  const idle = (Date.now() - lastActivity) / 1000;
  if (idle >= session.timeout) {
    session.user = null;
    shell = null;
    toast('Session timed out due to inactivity. Please log in again.', 'warn', 6000);
    returnTo = currentPath();
    go('/login');
    return;
  }
  // Keep the server session alive while the operator is active.
  if (lastActivity > lastPing && Date.now() - lastPing > 4 * 60 * 1000) {
    lastPing = Date.now();
    try { await get('auth/ping'); } catch { /* 401 handled below */ }
  }
}, 20000);

on('unauthorized', () => {
  if (!session.user) return;
  session.user = null;
  shell = null;
  returnTo = currentPath();
  toast('Your session has expired. Please log in again.', 'warn', 6000);
  go('/login');
});

// ---------- boot ----------
(async function boot() {
  try {
    const me = await get('auth/me');
    setCsrf(me.csrf);
    session.timeout = me.timeout_seconds || 1800;
    session.company = me.company || {};
    window.APP.company = session.company;
    if (me.user) {
      session.user = me.user;
      session.permissions = me.permissions || {};
      window.APP.user = me.user;
      await loadLookups();
    }
  } catch (e) {
    root.replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: 'login' }, h('h1', null, 'Cannot reach the server'), h('p', null, e.message))));
    return;
  }
  start(root, onNavigate);
})();
