import { api } from '../core/api.js';
import { t, fmtDate } from '../core/i18n.js';
import { can } from '../core/session.js';
import { esc, spinner, errorState, toast, formDialog, field } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { printDocument } from '../core/print.js';

/** Read-only voucher with Print / Edit / Cancel (#/v/<key>/<id>, ?print=1 opens the print dialog). */
export function voucherViewView(key, def) {
  return {
    title: () => t(def.title),
    render(main, params, query) {
      main.innerHTML = spinner();

      const docFor = (v) => ({
        title: t(def.title),
        number: v.voucher_no,
        date: fmtDate(`${v.voucher_date}${v.voucher_time ? ` ${v.voucher_time}` : ''}`, !!v.voucher_time),
        status: v.status,
        cancelReason: v.cancel_reason,
        fields: def.view.fields(v),
        columns: def.view.columns(),
        lines: v.lines,
        totals: def.view.totals(v),
        remarks: v.remarks,
        signatures: def.view.signatures(),
        meta: `${t('voucher.printed_at')} ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'short', timeStyle: 'short' }).format(new Date())}`,
      });

      async function load() {
        let v;
        try {
          v = await api.get(`${def.api}/${params.id}`);
        } catch (err) {
          main.innerHTML = errorState(err.message);
          return;
        }
        const posted = v.status === 'posted';
        const doc = docFor(v);
        main.innerHTML = `
          <div class="voucher-bar">
            <a class="btn btn-ghost btn-sm" href="#/v/${key}">${icon('history', { size: 18 })}<span>${esc(t('voucher.all'))}</span></a>
            <span class="spacer"></span>
            <button type="button" class="btn btn-ghost btn-sm" data-print>${icon('printer', { size: 18 })}<span>${esc(t('voucher.print'))}</span></button>
            ${posted && can(`${def.perm}.edit`) ? `<a class="btn btn-ghost btn-sm" href="#/v/${key}/${v.id}/edit">${icon('edit', { size: 18 })}<span>${esc(t('common.edit'))}</span></a>` : ''}
            ${posted && can(`${def.perm}.cancel`) ? `<button type="button" class="btn btn-ghost btn-sm danger-text" data-cancel>${icon('close', { size: 18 })}<span>${esc(t('voucher.cancel'))}</span></button>` : ''}
            ${can(`${def.perm}.create`) ? `<a class="btn btn-primary btn-sm" href="#/v/${key}/new">${icon('plus', { size: 18 })}<span>${esc(t('common.new'))}</span></a>` : ''}
          </div>
          <article class="card voucher-doc">
            <header class="vd-head">
              <div><h2 dir="ltr">${esc(v.voucher_no)}</h2><p class="muted" dir="ltr">${esc(doc.date)}</p></div>
              <span class="pill ${posted ? 'pill-ok' : 'pill-off'}">${esc(t(`voucher.status.${v.status}`))}</span>
            </header>
            ${!posted ? `<div class="notice notice-warn">${icon('alert', { size: 20 })}<span>${esc(t('voucher.cancelled_note', { reason: v.cancel_reason || '' }))}</span></div>` : ''}
            <dl class="vd-fields">${doc.fields.filter(([, val]) => val).map(([k, val]) => `<div><dt>${esc(k)}</dt><dd>${esc(val)}</dd></div>`).join('')}</dl>
            <div class="table-scroll"><table class="vd-lines">
              <thead><tr><th>#</th>${doc.columns.map((c) => `<th class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
              <tbody>${v.lines.map((l, i) => `<tr><td>${i + 1}</td>${doc.columns.map((c) => `<td class="${c.num ? 'num' : ''}" ${c.num ? 'dir="ltr"' : ''}>${esc((c.format ? c.format(l) : l[c.key]) ?? '')}</td>`).join('')}</tr>`).join('')}</tbody>
              <tfoot><tr><td></td>${doc.columns.map((c, i) => `<td class="${c.num ? 'num' : ''}" dir="${c.num ? 'ltr' : 'auto'}"><strong>${esc(i === 0 ? t('grid.total') : doc.totals[c.key] ?? '')}</strong></td>`).join('')}</tr></tfoot>
            </table></div>
            ${v.remarks ? `<p class="vd-remarks"><strong>${esc(t('f.remarks'))}:</strong> ${esc(v.remarks)}</p>` : ''}
          </article>`;

        main.querySelector('[data-print]').addEventListener('click', () => printDocument(docFor(v)));
        main.querySelector('[data-cancel]')?.addEventListener('click', async () => {
          const res = await formDialog({
            title: `${t('voucher.cancel')} — ${v.voucher_no}`,
            fieldsHtml: `<p class="muted">${esc(t('voucher.cancel_help'))}</p>${field({ label: t('voucher.cancel_reason'), required: true, control: '<input name="reason" required maxlength="255">' })}`,
            saveText: t('voucher.cancel'),
            successMessage: t('voucher.cancelled_no', { no: v.voucher_no }),
            onSave: (data) => api.post(`${def.api}/${v.id}/cancel`, data),
          });
          if (res) load();
        });
        if (query.print === '1') {
          query.print = '0';
          history.replaceState(null, '', `#/v/${key}/${v.id}`);
          printDocument(doc);
        }
      }
      load().catch((err) => toast(err.message, 'error'));
    },
  };
}
