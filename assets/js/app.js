/**
 * SPA entry: boot, hash router, app chrome (top bar, WhatsApp button).
 *
 * A view module exports { title(params) → string, bare?: bool,
 * render(container, params, query) → optional cleanup function }.
 */
import { api, onApiEvent, setCsrf } from './core/api.js';
import { t, has, getLang, setLang, applyDocumentLang } from './core/i18n.js';
import { session, setUser, clearUser, can } from './core/session.js';
import { esc, toast, errorState, spinner } from './core/ui.js';
import { icon } from './core/icons.js';
import EnterNav from './core/enterNav.js';

import loginView from './views/login.js';
import setupView from './views/setup.js';
import homeView from './views/home.js';
import usersView from './views/users.js';
import userFormView from './views/userForm.js';
import rolesView from './views/roles.js';
import auditView from './views/audit.js';
import profileView from './views/profile.js';
import designsView from './views/designs.js';
import designFormView from './views/designForm.js';
import settingsView from './views/settings.js';
import { MASTERS } from './views/masters/config.js';
import { masterListView } from './views/masterList.js';
import { masterFormView } from './views/masterForm.js';
import { VOUCHERS } from './views/vouchers/defs.js';
import { voucherListView } from './views/voucherList.js';
import { voucherFormView } from './views/voucherForm.js';
import { voucherViewView } from './views/voucherView.js';

const routes = [
  { path: '/login', view: loginView, public: true },
  { path: '/setup', view: setupView, public: true },
  { path: '/', view: homeView },
  { path: '/users', view: usersView, perm: 'users.view' },
  { path: '/users/new', view: userFormView, perm: 'users.manage' },
  { path: '/users/:id', view: userFormView, perm: 'users.manage' },
  { path: '/roles', view: rolesView, perm: 'roles.manage' },
  { path: '/audit', view: auditView, perm: 'audit.view' },
  { path: '/profile', view: profileView },
  { path: '/designs', view: designsView, perm: 'designs.view' },
  { path: '/designs/new', view: designFormView, perm: 'designs.manage' },
  { path: '/designs/:id', view: designFormView, perm: 'designs.view' },
  { path: '/settings', view: settingsView, perm: 'settings.manage' },
  // Master data: #/m/<key>, #/m/<key>/new, #/m/<key>/<id>
  ...Object.entries(MASTERS).flatMap(([key, cfg]) => [
    { path: `/m/${key}`, view: masterListView(key, cfg), perm: cfg.perm.view },
    { path: `/m/${key}/new`, view: masterFormView(key, cfg), perm: cfg.perm.manage },
    { path: `/m/${key}/:id`, view: masterFormView(key, cfg), perm: cfg.perm.manage },
  ]),
  // Vouchers: #/v/<key> (list), /new, /<id> (view + print), /<id>/edit
  ...Object.entries(VOUCHERS).flatMap(([key, def]) => [
    { path: `/v/${key}`, view: voucherListView(key, def), perm: `${def.perm}.view` },
    { path: `/v/${key}/new`, view: voucherFormView(key, def), perm: `${def.perm}.create` },
    { path: `/v/${key}/:id`, view: voucherViewView(key, def), perm: `${def.perm}.view` },
    { path: `/v/${key}/:id/edit`, view: voucherFormView(key, def), perm: `${def.perm}.edit` },
  ]),
];

const appEl = document.getElementById('app');
let cleanup = null;
let afterLogin = '/';

/* --------------------------------------------------------------- routing */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(qs)) };
}

function match(path) {
  for (const route of routes) {
    const names = [];
    const re = new RegExp('^' + route.path.replace(/:(\w+)/g, (_, n) => { names.push(n); return '(\\d+)'; }) + '$');
    const m = path.match(re);
    if (m) return { route, params: Object.fromEntries(names.map((n, i) => [n, Number(m[i + 1])])) };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  const target = '#' + path;
  if (location.hash === target) {
    render();
  } else if (replace) {
    history.replaceState(null, '', target);
    render();
  } else {
    location.hash = target;
  }
}

function guard(path) {
  if (session.needsSetup) return path === '/setup' ? null : '/setup';
  if (path === '/setup') return session.user ? '/' : '/login';
  if (!session.user) {
    if (path !== '/login') afterLogin = path;
    return path === '/login' ? null : '/login';
  }
  if (path === '/login') return '/';
  if (session.user.must_change_password && path !== '/profile') return '/profile';
  return null;
}

function render() {
  const { path, query } = parseHash();
  const redirect = guard(path);
  if (redirect) {
    navigate(redirect, { replace: true });
    return;
  }
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch { /* ignore */ }
  }
  cleanup = null;

  const found = match(path);
  const view = found?.route.view;
  const bare = !!view?.bare;
  const main = mountChrome({ bare, title: view ? view.title(found.params) : t('error.not_found'), isHome: path === '/' });

  if (!found) {
    main.innerHTML = errorState(t('error.not_found'));
    return;
  }
  if (found.route.perm && !can(found.route.perm)) {
    main.innerHTML = errorState(t('error.forbidden'));
    return;
  }
  cleanup = view.render(main, found.params, query) || null;
  window.scrollTo(0, 0);
}

/* ---------------------------------------------------------------- chrome */

function mountChrome({ bare, title, isHome }) {
  document.title = `${title} · ${appName()}`;
  if (bare) {
    appEl.innerHTML = `<main id="view" class="view view-bare"></main>${langFab()}`;
    appEl.querySelector('[data-lang]').addEventListener('click', toggleLang);
    return appEl.querySelector('#view');
  }
  const u = session.user;
  appEl.innerHTML = `
    <header class="topbar">
      ${isHome
        ? `<a href="#/" class="brand" aria-label="${esc(t('nav.home'))}"><span class="brand-mark">${icon('printer', { size: 22 })}</span></a>`
        : `<button type="button" class="icon-btn back-btn" data-back aria-label="${esc(t('nav.back'))}">${icon('back')}</button>`}
      <h1 class="topbar-title">${esc(isHome ? appName() : title)}</h1>
      <button type="button" class="chip-btn" data-lang aria-label="${esc(t('lang.switch'))}">${icon('globe', { size: 18 })}<span>${esc(t('lang.switch'))}</span></button>
      <div class="menu">
        <button type="button" class="icon-btn" data-menu aria-haspopup="true" aria-expanded="false" aria-label="${esc(t('nav.menu'))}">
          <span class="avatar">${esc((u?.full_name || '?').trim().charAt(0).toUpperCase())}</span></button>
        <div class="menu-pop" hidden>
          <div class="menu-user"><strong>${esc(u?.full_name || '')}</strong><span>${esc(getLang() === 'ur' ? u?.role_name_ur || u?.role_name : u?.role_name)}</span></div>
          <a href="#/profile" class="menu-item">${icon('user', { size: 20 })}${esc(t('nav.profile'))}</a>
          <button type="button" class="menu-item" data-logout>${icon('logout', { size: 20 })}${esc(t('nav.logout'))}</button>
        </div>
      </div>
    </header>
    <main id="view" class="view"></main>
    ${whatsappFab()}`;

  appEl.querySelector('[data-back]')?.addEventListener('click', () => {
    if (history.length > 1) history.back();
    else navigate('/');
  });
  appEl.querySelector('[data-lang]').addEventListener('click', toggleLang);
  const menuBtn = appEl.querySelector('[data-menu]');
  const pop = appEl.querySelector('.menu-pop');
  const closeMenu = () => {
    pop.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
  };
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    menuBtn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
  });
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); } });
  appEl.querySelector('[data-logout]').addEventListener('click', logout);
  return appEl.querySelector('#view');
}

function appName() {
  if (getLang() === 'ur' && session.app.name_ur) return session.app.name_ur;
  return session.app.name || t('app.name');
}

function langFab() {
  return `<button type="button" class="chip-btn lang-fab" data-lang>${icon('globe', { size: 18 })}<span>${esc(t('lang.switch'))}</span></button>`;
}

function whatsappFab() {
  const n = session.app.whatsapp;
  if (!n) return '';
  const href = `https://wa.me/${encodeURIComponent(n)}?text=${encodeURIComponent(t('whatsapp.message'))}`;
  return `<a class="wa-fab" href="${esc(href)}" target="_blank" rel="noopener" aria-label="${esc(t('whatsapp.support'))}" title="${esc(t('whatsapp.support'))}">${icon('whatsapp', { size: 28 })}</a>`;
}

async function toggleLang() {
  const next = getLang() === 'ur' ? 'en' : 'ur';
  setLang(next);
  if (session.user) api.post('auth/lang', { lang: next }).catch(() => {});
}

async function logout() {
  try {
    await api.post('auth/logout');
  } catch { /* session may already be gone */ }
  clearUser();
  afterLogin = '/';
  navigate('/login');
}

/* ------------------------------------------------------------------ boot */

/** Called by login/setup views after a successful sign-in. */
export function signedIn(data) {
  setUser(data.user, data.permissions);
  session.needsSetup = false;
  if (data.user?.lang && data.user.lang !== getLang()) setLang(data.user.lang);
  const target = data.user?.must_change_password ? '/profile' : afterLogin || '/';
  afterLogin = '/';
  navigate(target, { replace: true });
}

async function boot() {
  applyDocumentLang();
  EnterNav.configure({ t: (key, fallback) => (has(key) ? t(key) : fallback), toast });
  appEl.innerHTML = spinner();

  onApiEvent('unauthorized', (message) => {
    if (!session.user) return;
    clearUser();
    toast(message || t('login.expired'), 'error');
    afterLogin = parseHash().path;
    navigate('/login');
  });
  onApiEvent('passwordChange', () => {
    if (session.user) session.user.must_change_password = 1;
    navigate('/profile');
  });

  let data;
  try {
    data = await api.get('auth/bootstrap');
  } catch (err) {
    appEl.innerHTML = `<main class="view view-bare"><div class="card boot-error">
      <h1>${esc(t('app.config_error'))}</h1>${errorState(err.message)}
      <button type="button" class="btn btn-primary" data-retry>${esc(t('common.retry'))}</button></div></main>`;
    appEl.querySelector('[data-retry]').addEventListener('click', boot);
    return;
  }
  setCsrf(data.csrf);
  Object.assign(session.app, data.app || {});
  session.needsSetup = !!data.needs_setup;
  session.setupKeyRequired = !!data.setup_key_required;
  setUser(data.user, data.permissions);
  if (data.user?.lang && data.user.lang !== getLang()) setLang(data.user.lang);
  if (data.expired) toast(t('login.expired'), 'error');

  window.addEventListener('hashchange', render);
  window.addEventListener('langchange', render);
  window.addEventListener('offline', () => toast(t('app.offline'), 'error'));
  render();
}

boot();
