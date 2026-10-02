// Desktop-style function keys, shared by every form:
//   F1 Search  F5 New  F7 Show/Load  F9 Print  F10 Save  F12 Delete  PgUp/PgDn Prev/Next record  Esc close dialog
import { closeTopModal, isModalOpen } from './dom.js';

const KEYMAP = { F1: 'search', F5: 'new', F7: 'load', F9: 'print', F10: 'save', F12: 'del' };
let handlers = {};

/** Pages call setKeys({save: fn, new: fn, ...}) on mount; cleared on route change. */
export function setKeys(h) { handlers = h || {}; }
export function clearKeys() { handlers = {}; }
export function trigger(action) {
  const fn = handlers[action];
  if (fn) { fn(); return true; }
  return false;
}

export const LEGEND = 'F1 Search · F5 New · F7 Show · F9 Print · F10 Save · F12 Delete · PgUp/PgDn Prev/Next';

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isModalOpen()) {
    e.preventDefault();
    closeTopModal();
    return;
  }
  const action = KEYMAP[e.key];
  if (action) {
    // Always swallow function keys so the browser does not refresh (F5) / open help (F1) etc.
    e.preventDefault();
    if (isModalOpen()) {
      // Inside a dialog only Save is meaningful: click its primary button.
      if (action === 'save') document.querySelector('.modal-back:last-child .modal-foot .btn.primary')?.click();
      return;
    }
    // Forms read input values directly, so the focused field's pending edit is always included.
    trigger(action);
    return;
  }
  if ((e.key === 'PageUp' || e.key === 'PageDown') && !isModalOpen()) {
    const t = e.target;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (handlers.prev || handlers.next) {
      e.preventDefault();
      trigger(e.key === 'PageUp' ? 'prev' : 'next');
    }
  }
});

/**
 * Enter moves to the next field (desktop data-entry habit). Applied to a container.
 * Textareas keep Enter; buttons keep Enter; Shift+Enter goes back.
 */
export function enterToNext(container) {
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (!(t instanceof HTMLElement) || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.closest('.egrid')) return;
    if (!['INPUT', 'SELECT'].includes(t.tagName)) return;
    e.preventDefault();
    const items = [...container.querySelectorAll('input:not([type=hidden]):not([disabled]):not([readonly]), select:not([disabled]), textarea:not([disabled])')]
      .filter((el) => el.offsetParent !== null);
    const i = items.indexOf(t);
    const next = items[i + (e.shiftKey ? -1 : 1)];
    if (next) {
      next.focus();
      if (next.select && next.tagName === 'INPUT') next.select();
    }
  });
}
