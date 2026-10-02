/** Small DOM/UI helpers shared by all views. */
import { t } from './i18n.js';
import { icon } from './icons.js';
import EnterNav from './enterNav.js';

/** Escape text for safe insertion into HTML. */
export function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Parse an HTML string into a single element. */
export function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/* ---------------------------------------------------------------- toasts */

export function toast(message, type = 'info', ms = 3500) {
  const host = document.getElementById('toasts');
  if (!host || !message) return;
  const node = el(`<div class="toast toast-${esc(type)}" role="${type === 'error' ? 'alert' : 'status'}">
    ${icon(type === 'error' ? 'alert' : 'check', { size: 20 })}<span>${esc(message)}</span></div>`);
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 300);
  }, type === 'error' ? ms + 2000 : ms);
}

/* --------------------------------------------------------------- dialogs */

function dialogShell(title, bodyHtml, footerHtml) {
  const dlg = el(`<dialog class="dialog">
    <div class="dialog-head"><h2>${esc(title)}</h2>
      <button type="button" class="icon-btn" data-close aria-label="${esc(t('common.close'))}">${icon('close', { size: 20 })}</button></div>
    <div class="dialog-body">${bodyHtml}</div>
    ${footerHtml ? `<div class="dialog-foot">${footerHtml}</div>` : ''}
  </dialog>`);
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close('cancel')));
  return dlg;
}

/** Yes/No confirmation. Resolves true when confirmed. */
export function confirmDialog({ title = t('common.confirm'), message = '', confirmText = t('common.confirm'), danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = dialogShell(title, `<p>${esc(message)}</p>`,
      `<button type="button" class="btn btn-ghost" data-close>${esc(t('common.cancel'))}</button>
       <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${esc(confirmText)}</button>`);
    dlg.querySelector('[data-ok]').addEventListener('click', () => dlg.close('ok'));
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'));
    dlg.showModal();
    dlg.querySelector('[data-ok]').focus();
  });
}

/**
 * Modal containing a form wired to EnterNav.
 * onSave(data) must return a promise; the dialog closes on success.
 */
export function formDialog({ title, fieldsHtml, saveText = t('common.save'), onSave, successMessage = null }) {
  return new Promise((resolve) => {
    const dlg = dialogShell(title, `<form class="form" autocomplete="off">${fieldsHtml}
      <div class="form-actions"><button type="button" class="btn btn-ghost" data-close>${esc(t('common.cancel'))}</button>
      <button type="submit" class="btn btn-primary">${esc(saveText)}</button></div></form>`, '');
    let result = null;
    EnterNav.attach(dlg.querySelector('form'), {
      onSave: async (data) => { result = await onSave(data); return result; },
      resetAfterSave: false,
      successMessage,
      onSaved: () => dlg.close('ok'),
    });
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? result ?? true : null));
    dlg.showModal();
  });
}

/* ------------------------------------------------------------- fragments */

export function spinner() {
  return `<div class="loading" role="status"><span class="spinner"></span><span>${esc(t('app.loading'))}</span></div>`;
}

export function emptyState(message = t('common.no_records')) {
  return `<div class="empty">${esc(message)}</div>`;
}

export function errorState(message) {
  return `<div class="empty empty-error">${icon('alert')}<p>${esc(message)}</p></div>`;
}

/** Field wrapper used by every form: label + control + error slot. */
export function field({ label, control, hint = '', required = false, cls = '' }) {
  return `<div class="field ${cls}">
    <label class="field-label">${esc(label)}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
    ${control}
    ${hint ? `<div class="field-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

/** Pager: calls onPage(n). */
export function pager({ page, per_page: perPage, total }, onPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const node = el(`<nav class="pager" aria-label="pagination">
    <button type="button" class="btn btn-ghost btn-sm" data-p="${page - 1}" ${page <= 1 ? 'disabled' : ''}>${esc(t('common.prev'))}</button>
    <span>${esc(t('common.page', { page, pages }))} · ${esc(t('common.total', { n: total }))}</span>
    <button type="button" class="btn btn-ghost btn-sm" data-p="${page + 1}" ${page >= pages ? 'disabled' : ''}>${esc(t('common.next'))}</button>
  </nav>`);
  node.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (b && !b.disabled) onPage(Number(b.dataset.p));
  });
  return node;
}

export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
