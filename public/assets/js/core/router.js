// Hash router: '#/employees/12' -> page module mount(container, params).
import { clearKeys } from './keys.js';
import { confirmDialog } from './dom.js';

const routes = [];
let current = null; // {cleanup, canLeave}
let container = null;
let onNavigate = null;
let lastHash = '';
let suppress = false;

/** pattern like '/employees/:id' ; load = () => import('...') ; meta = {title, perm:[module, action], nav} */
export function route(pattern, load, meta = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ pattern, re, keys, load, meta });
}

export function start(el, navigateCb) {
  container = el;
  onNavigate = navigateCb;
  window.addEventListener('hashchange', handle);
  return handle();
}

export function go(path, { replace = false } = {}) {
  const hash = '#' + path;
  if (location.hash === hash) return handle();
  if (replace) {
    history.replaceState(null, '', hash);
    return handle();
  }
  location.hash = hash;
}

/** Update the URL without re-mounting the page (e.g. after saving a new record). */
export function setPath(path) {
  suppress = true;
  history.replaceState(null, '', '#' + path);
  lastHash = location.hash;
  suppress = false;
}

export function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

async function handle() {
  if (suppress) return;
  const path = currentPath();
  if (current?.canLeave && location.hash !== lastHash) {
    const ok = current.canLeave() || (await confirmDialog('You have unsaved changes. Leave this screen and discard them?', { ok: 'Discard', danger: true }));
    if (!ok) {
      suppress = true;
      history.replaceState(null, '', lastHash || '#/');
      suppress = false;
      return;
    }
  }
  lastHash = location.hash;
  let match = null;
  for (const r of routes) {
    const m = path.match(r.re);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      match = { r, params };
      break;
    }
  }
  if (!match) {
    container.replaceChildren(Object.assign(document.createElement('div'), { className: 'panel panel-body', textContent: 'Page not found.' }));
    return;
  }
  const allowed = onNavigate?.(match.r, path);
  if (allowed === false) return;
  current?.cleanup?.();
  clearKeys();
  current = null;
  const target = match.r.meta.container || container; // onNavigate may pick the container (shell main / root)
  target.replaceChildren();
  const mod = await match.r.load();
  // mount() returns a cleanup function or {cleanup, canLeave}
  const res = await mod.default.mount(target, match.params, match.r.meta);
  current = typeof res === 'function' ? { cleanup: res } : { cleanup: res?.cleanup, canLeave: res?.canLeave };
}
