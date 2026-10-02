import { api } from '../core/api.js';
import { t, fmtDate, todayPK } from '../core/i18n.js';
import { can } from '../core/session.js';
import { esc, spinner, emptyState, errorState, pager, debounce } from '../core/ui.js';
import { icon } from '../core/icons.js';

/** Voucher register: date range, status and text search; tap a row to open it. */
export function voucherListView(key, def) {
  return {
    title: () => t(def.title),
    render(main) {
      const today = todayPK();
      const state = { date_from: `${today.slice(0, 8)}01`, date_to: today, status: '', q: '', page: 1 };

      main.innerHTML = `
        <div class="toolbar voucher-toolbar">
          <label class="search-box">${icon('search', { size: 20 })}
            <input type="search" name="q" placeholder="${esc(t('voucher.search'))}" aria-label="${esc(t('common.search'))}"></label>
          <input type="date" name="date_from" value="${state.date_from}" aria-label="${esc(t('filter.date_from'))}">
          <input type="date" name="date_to" value="${state.date_to}" aria-label="${esc(t('filter.date_to'))}">
          <select name="status" aria-label="${esc(t('common.status'))}">
            <option value="">${esc(t('common.status'))}: ${esc(t('common.all'))}</option>
            <option value="posted">${esc(t('voucher.status.posted'))}</option>
            <option value="cancelled">${esc(t('voucher.status.cancelled'))}</option>
          </select>
          ${can(`${def.perm}.create`) ? `<a class="btn btn-primary" href="#/v/${key}/new">${icon('plus', { size: 20 })}<span>${esc(t('common.new'))}</span></a>` : ''}
        </div>
        <div class="card list-card" data-list>${spinner()}</div>`;

      const listEl = main.querySelector('[data-list]');
      async function load() {
        listEl.innerHTML = spinner();
        try {
          const data = await api.get(def.api, { ...state, per_page: 25 });
          if (!data.items.length) {
            listEl.innerHTML = emptyState();
            return;
          }
          listEl.innerHTML = `<ul class="rows">${data.items.map((v) => `
            <li class="row-item ${v.status === 'cancelled' ? 'is-muted' : ''}">
              <span class="tile-icon">${icon(def.icon, { size: 20 })}</span>
              <a class="row-main row-link" href="#/v/${key}/${v.id}">
                <div class="row-title"><span dir="ltr">${esc(v.voucher_no)}</span> <span class="muted" dir="ltr">${esc(fmtDate(v.voucher_date))}</span></div>
                <div class="row-meta">${v.status === 'cancelled' ? `<span class="pill pill-off">${esc(t('voucher.status.cancelled'))}</span>` : ''}${def.list(v)}</div>
              </a>
              <a class="icon-btn" href="#/v/${key}/${v.id}?print=1" aria-label="${esc(t('voucher.print'))}" title="${esc(t('voucher.print'))}">${icon('printer', { size: 20 })}</a>
            </li>`).join('')}</ul>`;
          listEl.appendChild(pager(data, (p) => { state.page = p; load(); }));
        } catch (err) {
          listEl.innerHTML = errorState(err.message);
        }
      }

      const reload = () => { state.page = 1; load(); };
      const onSearch = debounce(reload, 300);
      main.querySelector('[name=q]').addEventListener('input', (e) => { state.q = e.target.value.trim(); onSearch(); });
      ['date_from', 'date_to', 'status'].forEach((k) => main.querySelector(`[name=${k}]`).addEventListener('change', (e) => { state[k] = e.target.value; reload(); }));
      load();
    },
  };
}
