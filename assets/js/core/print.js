/**
 * Print layouts for vouchers. Renders an A4 document into #print-root and
 * calls window.print(); the app UI is hidden by print CSS while printing.
 *
 *   printDocument({
 *     title: 'Inward Gate Pass', number: 'IGP-2627-00001', date: '02-10-2026 10:15 AM',
 *     status: 'posted' | 'cancelled',
 *     fields: [[label, value], ...],
 *     columns: [{ label, key, num, format }], lines: [...], totals: { key: text },
 *     remarks: '...', signatures: ['Prepared by', 'Store keeper', 'Driver'],
 *   });
 */
import { t, getLang } from './i18n.js';
import { session } from './session.js';
import { esc } from './ui.js';

export function printDocument(doc) {
  document.getElementById('print-root')?.remove();
  const app = session.app;
  const company = getLang() === 'ur' && app.name_ur ? app.name_ur : app.name;
  const root = document.createElement('div');
  root.id = 'print-root';
  root.setAttribute('dir', document.documentElement.dir);
  root.innerHTML = `
    <div class="pdoc ${doc.status === 'cancelled' ? 'is-cancelled' : ''}">
      <header class="pdoc-head">
        <div>
          <h1>${esc(company || '')}</h1>
          ${app.address ? `<p>${esc(app.address)}</p>` : ''}
          <p>${app.phone ? `${esc(t('f.phone'))}: <span dir="ltr">${esc(app.phone)}</span>` : ''}${app.ntn ? ` &nbsp; NTN: <span dir="ltr">${esc(app.ntn)}</span>` : ''}</p>
        </div>
        <div class="pdoc-title">
          <h2>${esc(doc.title)}</h2>
          <p class="pdoc-no" dir="ltr">${esc(doc.number || '')}</p>
          <p dir="ltr">${esc(doc.date || '')}</p>
        </div>
      </header>
      ${doc.status === 'cancelled' ? `<div class="pdoc-stamp">${esc(t('voucher.status.cancelled'))}${doc.cancelReason ? ` — ${esc(doc.cancelReason)}` : ''}</div>` : ''}
      <dl class="pdoc-fields">${(doc.fields || []).filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
      <table class="pdoc-lines">
        <thead><tr><th>#</th>${doc.columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${doc.lines.map((l, i) => `<tr><td>${i + 1}</td>${doc.columns.map((c) => {
          const v = c.format ? c.format(l) : l[c.key];
          return `<td class="${c.num ? 'num' : ''}" ${c.num ? 'dir="ltr"' : ''}>${esc(v ?? '')}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
        ${doc.totals ? `<tfoot><tr><td></td>${doc.columns.map((c, i) => `<td class="${c.num ? 'num' : ''}" ${c.num ? 'dir="ltr"' : ''}>${
          i === 0 ? esc(t('grid.total')) : esc(doc.totals[c.key] ?? '')}</td>`).join('')}</tr></tfoot>` : ''}
      </table>
      ${doc.remarks ? `<p class="pdoc-remarks"><strong>${esc(t('f.remarks'))}:</strong> ${esc(doc.remarks)}</p>` : ''}
      <footer class="pdoc-signs">${(doc.signatures || []).map((s) => `<div><span></span>${esc(s)}</div>`).join('')}</footer>
      <p class="pdoc-meta">${esc(doc.meta || '')}</p>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add('printing');
  const done = () => {
    document.body.classList.remove('printing');
    root.remove();
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  // Let the browser lay the document out before opening the dialog.
  setTimeout(() => window.print(), 50);
}
