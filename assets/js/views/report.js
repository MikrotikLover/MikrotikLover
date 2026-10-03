/**
 * #/r/<key>?date_from=…&… — one report: filters on top, result table below,
 * Excel / CSV / PDF from the same filters. The URL keeps the filters, so a
 * report can be bookmarked or opened from the home accordion.
 */
import { t } from '../core/i18n.js';
import { esc, spinner, emptyState, errorState } from '../core/ui.js';
import { loadLookups } from '../core/lookups.js';
import { REPORT_LOOKUPS } from './reports/defs.js';
import { mountReportForm } from './reports/form.js';
import { fetchReport, columnsOf, cellText, describe, reportTitle } from './reports/runner.js';

function table(def, data) {
  const cols = columnsOf(data);
  if (!data.rows.length) return emptyState(t('rpt.empty'));
  const td = (c, v) => `<td class="${c.num ? 'num' : ''}" ${c.num ? 'dir="ltr"' : ''}>${esc(cellText(c, v))}</td>`;
  return `
    <div class="report-table-wrap" tabindex="0" role="region" aria-label="${esc(t(`rpt.${def.key}`))}">
      <table class="report-table">
        <thead><tr>${cols.map((c) => `<th scope="col" class="${c.num ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${data.rows.map((r) => `<tr>${cols.map((c) => td(c, r[c.key])).join('')}</tr>`).join('')}</tbody>
        ${data.totals ? `<tfoot><tr>${cols.map((c, i) => (c.key in data.totals ? td(c, data.totals[c.key])
          : `<td>${i === 0 ? esc(t('grid.total')) : ''}</td>`)).join('')}</tr></tfoot>` : ''}
      </table>
    </div>`;
}

export function reportView(def) {
  return {
    title: () => t(`rpt.${def.key}`),
    render(main, _params, query) {
      let rf = null;
      let seq = 0;
      main.classList.add('view-wide'); // report tables need the full width on desktop
      main.innerHTML = spinner();
      loadLookups(REPORT_LOOKUPS).then((lk) => {
        main.innerHTML = `
          <section class="card report-filters" data-filters></section>
          <section class="card report-result" data-result aria-live="polite"></section>`;
        const result = main.querySelector('[data-result]');

        const run = async (q) => {
          const mine = ++seq;
          // Keep the filters in the URL without re-rendering the page.
          const qs = new URLSearchParams(q).toString();
          history.replaceState(null, '', `#/r/${def.key}${qs ? `?${qs}` : ''}`);
          result.innerHTML = spinner();
          try {
            const data = await fetchReport(def, q);
            if (mine !== seq) return true;
            result.innerHTML = `
              <header class="report-head">
                <div><h2>${esc(reportTitle(def, data))}</h2>
                  <p class="muted">${describe(def, q, lk, rf.fields).map(esc).join(' · ')}</p></div>
                <span class="badge" data-count>${esc(t('rpt.rows', { n: data.rows.length }))}</span>
              </header>
              ${data.truncated ? `<div class="notice notice-warn">${esc(t('rpt.truncated', { n: data.rows.length }))}</div>` : ''}
              ${table(def, data)}`;
          } catch (err) {
            if (mine !== seq) return true;
            result.innerHTML = errorState(err.message);
            throw err; // field errors are shown beside the filters by enterNav
          }
          return true;
        };

        rf = mountReportForm(main.querySelector('[data-filters]'), def, lk, {
          initial: Object.keys(query || {}).length ? query : null,
          onView: run,
        });
        rf.nav.save();
      }).catch((err) => { main.innerHTML = errorState(err.message); });
      return () => rf?.destroy();
    },
  };
}
