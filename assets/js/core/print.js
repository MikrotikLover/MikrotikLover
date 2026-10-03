/**
 * Print layouts for vouchers. Renders the document into #print-root and calls
 * window.print(); the app UI is hidden by print CSS while printing.
 *
 *   printDocument({
 *     title: 'Inward Gate Pass', number: 'IGP-2627-00001', date: '02-10-2026 10:15 AM',
 *     status: 'posted' | 'cancelled', cancelReason,
 *     party: { label, name, lines: ['address', 'phone · NTN'] },    // optional "To / From" box
 *     fields: [[label, value], ...],
 *     columns: [{ label, key, num, format }], lines: [...], totals: { key: text },
 *     remarks: '...',
 *     declaration: 'Goods received in good condition…',             // optional
 *     receiver: true, receiverName: 'Waqas',                        // Name / CNIC / Signature / Date block
 *     signatures: ['Prepared by', 'Store keeper', 'Driver'],
 *     copies: ['Party copy', 'Office copy'],                        // one page per copy (default: one)
 *     variant: 'gatepass',                                          // compact half-page layout
 *   });
 */
import { t, getLang } from './i18n.js';
import { session } from './session.js';
import { esc } from './ui.js';

function page(doc, copyLabel) {
  const app = session.app;
  const company = getLang() === 'ur' && app.name_ur ? app.name_ur : app.name;
  const fields = (doc.fields || []).filter(([, v]) => v !== null && v !== undefined && v !== '');
  return `
    <div class="pdoc ${doc.variant ? `pdoc-${esc(doc.variant)}` : ''} ${doc.status === 'cancelled' ? 'is-cancelled' : ''}">
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
          ${copyLabel ? `<p class="pdoc-copy">${esc(copyLabel)}</p>` : ''}
        </div>
      </header>
      ${doc.status === 'cancelled' ? `<div class="pdoc-stamp">${esc(t('voucher.status.cancelled'))}${doc.cancelReason ? ` — ${esc(doc.cancelReason)}` : ''}</div>` : ''}
      ${doc.party ? `<div class="pdoc-party"><span class="pdoc-party-label">${esc(doc.party.label)}</span>
        <strong>${esc(doc.party.name)}</strong>${(doc.party.lines || []).filter(Boolean).map((l) => `<span>${esc(l)}</span>`).join('')}</div>` : ''}
      ${fields.length ? `<dl class="pdoc-fields">${fields.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
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
      ${doc.declaration ? `<p class="pdoc-declaration">${esc(doc.declaration)}</p>` : ''}
      ${doc.receiver ? `<div class="pdoc-receiver">
        ${['print.receiver_name', 'print.cnic', 'print.signature', 'print.date_time'].map((k, i) => `<div><span>${esc(t(k))}</span><i>${i === 0 && doc.receiverName ? esc(doc.receiverName) : ''}</i></div>`).join('')}
      </div>` : ''}
      <footer class="pdoc-signs">${(doc.signatures || []).map((s) => `<div><span></span>${esc(s)}</div>`).join('')}</footer>
      <p class="pdoc-meta">${esc(doc.meta || '')}</p>
    </div>`;
}

export function printDocument(doc) {
  document.getElementById('print-root')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  root.setAttribute('dir', document.documentElement.dir);
  const copies = doc.copies && doc.copies.length ? doc.copies : [null];
  root.innerHTML = copies.map((c) => page(doc, c)).join('');
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
