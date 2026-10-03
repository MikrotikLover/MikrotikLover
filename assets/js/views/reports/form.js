/**
 * Report filter form (home accordion + report page). Keyboard rules come from
 * enterNav.js: ENTER walks the filters, ENTER on the last one (or Ctrl+S)
 * runs "View". Excel / CSV / PDF buttons need the reports.export permission.
 */
import EnterNav from '../../core/enterNav.js';
import { t } from '../../core/i18n.js';
import { can } from '../../core/session.js';
import { esc, toast } from '../../core/ui.js';
import { icon } from '../../core/icons.js';
import { renderFields, mountFields } from '../../core/formKit.js';
import { reportFields, toQuery } from './defs.js';
import { fetchReport, exportReport, describe } from './runner.js';

const FORMATS = [['xlsx', 'rpt.excel', 'sheet'], ['csv', 'rpt.csv', 'download'], ['pdf', 'rpt.pdf', 'printer']];

/**
 * mountReportForm(host, def, lk, { initial, onView(query), viewLabel })
 * Returns { nav, ctx, query(), destroy() }.
 */
export function mountReportForm(host, def, lk, { initial = null, onView, viewLabel = 'rpt.view' }) {
  const fields = reportFields(def);
  host.innerHTML = `
    <form class="report-form" data-report-form="${esc(def.key)}" autocomplete="off">
      <div class="report-grid">${renderFields(fields)}</div>
      <div class="report-actions">
        <button type="submit" class="btn btn-primary btn-sm" data-view>${icon('eye', { size: 18 })}<span>${esc(t(viewLabel))}</span></button>
        ${can('reports.export') ? FORMATS.map(([f, label, ic]) =>
          `<button type="button" class="btn btn-ghost btn-sm" data-export="${f}">${icon(ic, { size: 18 })}<span>${esc(t(label))}</span></button>`).join('') : ''}
      </div>
    </form>`;
  const form = host.querySelector('form');
  const ctx = mountFields(form, fields, lk);
  ctx.setDefaults();
  if (def.views) ctx.setValues({ view: def.views[0].value });
  if (initial) ctx.setValues(initial);

  const query = () => toQuery(ctx.collect());
  const validate = () => {
    const q = query();
    const errs = {};
    if (q.date_from && q.date_to && q.date_from > q.date_to) errs.date_to = t('rpt.date_order');
    for (const k of def.needs?.[q.view] || []) if (!q[k]) errs[k] = t('rpt.required', { field: t(`filter.${k.replace(/_id$/, '')}`) });
    return Object.keys(errs).length ? errs : null;
  };

  const nav = EnterNav.attach(form, {
    autofocus: false,
    resetAfterSave: false,
    successMessage: '',
    validate,
    collect: query,
    onSave: async (q) => onView(q),
  });

  form.querySelectorAll('[data-export]').forEach((btn) => btn.addEventListener('click', async () => {
    nav.clearErrors();
    const errs = nav.validate();
    if (errs.length) { nav.showErrors(errs); return; }
    const q = query();
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const data = await fetchReport(def, q);
      if (!data.rows.length) toast(t('rpt.empty'), 'info');
      else exportReport(btn.dataset.export, def, data, describe(def, q, lk, fields));
    } catch (err) {
      if (err.errors) nav.showErrors(err.errors);
      else toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }));

  return { nav, ctx, form, fields, query, destroy: () => nav.destroy() };
}
