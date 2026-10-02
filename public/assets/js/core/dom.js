// DOM helpers, formatting, toasts and modal dialogs.

/**
 * h('div', {class: 'x', onclick: fn}, 'text', childNode, [more])
 * Attributes: class, style (string|object), dataset (object), on* handlers, boolean props.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- formatting (PKR whole rupees, dd-mm-yyyy) ----------
const nf = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 0 });
export const money = (v) => (v === null || v === undefined || v === '' ? '' : nf.format(Math.round(Number(v))));
export function fdate(d) {
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return `${day}-${m}-${y}`;
}
export function fdatetime(d) {
  if (!d) return '';
  return fdate(d) + ' ' + String(d).slice(11, 16);
}
export const ftime = (t) => (t ? String(t).slice(0, 5) : '');
export function today() {
  // Asia/Karachi date regardless of the browser's timezone
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
}
export const TYPES = { permanent: 'Permanent', daily_wages: 'Daily Wages', contract: 'Contract' };
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------- toasts ----------
let toastBox;
export function toast(msg, type = 'ok', ms = 3200) {
  if (!toastBox) {
    toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastBox);
  }
  const t = h('div', { class: 'toast ' + type }, msg);
  toastBox.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- modal ----------
const modalStack = [];
export function isModalOpen() { return modalStack.length > 0; }

/**
 * modal({title, body: Node, buttons: [{label, class, onClick(close) -> false keeps open}], wide, onClose})
 * returns {close, el}
 */
export function modal({ title, body, buttons = [], wide = false, onClose } = {}) {
  const prevFocus = document.activeElement;
  const back = h('div', { class: 'modal-back' });
  const close = () => {
    back.remove();
    modalStack.splice(modalStack.indexOf(api), 1);
    onClose?.();
    prevFocus?.focus?.();
  };
  const foot = h('div', { class: 'modal-foot' }, buttons.map((b) => h('button', {
    class: 'btn ' + (b.class || ''), type: 'button',
    onclick: async () => { if ((await b.onClick?.(close)) !== false) close(); },
  }, b.label)));
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-head' }, h('h3', null, title || ''), h('button', { class: 'x', type: 'button', onclick: close, 'aria-label': 'Close' }, '×')),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? foot : null);
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.body.append(back);
  const api = { close, el: box };
  modalStack.push(api);
  setTimeout(() => (box.querySelector('input,select,textarea,button.primary') || box.querySelector('button'))?.focus(), 30);
  return api;
}

export function closeTopModal() {
  modalStack[modalStack.length - 1]?.close();
}

export function confirmDialog(message, { title = 'Please confirm', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('p', { style: 'margin:0;white-space:pre-line' }, message),
      buttons: [
        { label: 'Cancel', onClick: () => { result = false; } },
        { label: ok, class: danger ? 'danger' : 'primary', onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

/** Open a report page (print-ready HTML) in a new tab. */
export function openReport(name, params = {}) {
  const p = new URLSearchParams({ r: name });
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== null && v !== undefined) p.append(k, v);
  window.open('report.php?' + p.toString(), '_blank');
}

/** Client-side print of a simple table (for master lists). */
export function printTable(title, columns, rows, subtitle = '') {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow pop-ups to print.', 'warn'); return; }
  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => '<tr>' + columns.map((c) => {
    const v = c.print ? c.print(r, i) : (c.key === '#' ? i + 1 : r[c.key]);
    return `<td class="${c.urdu ? 'urdu' : ''} ${c.align === 'right' ? 'num' : ''}">${esc(v)}</td>`;
  }).join('') + '</tr>').join('');
  const company = esc(window.APP?.company?.name || '');
  const companyUr = esc(window.APP?.company?.name_ur || '');
  const user = esc(window.APP?.user?.full_name || '');
  const printed = `Printed by ${user} on ${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Karachi' })}`;
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/report.css">
<style>@page{size:A4 portrait;margin:10mm 8mm 13mm;@bottom-left{content:"${printed.replace(/"/g, '')}";font:7.5pt Arial}@bottom-right{content:"Page " counter(page) " of " counter(pages);font:7.5pt Arial}}</style>
</head><body class="portrait"><div class="rpt-toolbar no-print"><button class="btn primary" onclick="print()">Print / PDF</button><button class="btn" onclick="close()">Close</button></div>
<main class="rpt"><header class="rpt-head"><div class="rpt-head-text"><div class="rpt-company">${company}</div>${companyUr ? `<div class="rpt-company-ur urdu">${companyUr}</div>` : ''}
<h1 class="rpt-title">${esc(title)}</h1>${subtitle ? `<div class="rpt-sub">${esc(subtitle)}</div>` : ''}</div></header>
<table class="rpt-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
<div class="rpt-printed screen-only">${esc(printed)}</div></main>
<script>addEventListener('keydown',e=>{if(e.key==='F9'){e.preventDefault();print()}if(e.key==='Escape')close()})<\/script></body></html>`);
  w.document.close();
}
