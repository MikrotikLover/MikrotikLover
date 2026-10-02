import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { can } from '../core/session.js';
import { invalidate } from '../core/lookups.js';
import { esc, toast, spinner, emptyState, errorState, pager, debounce, confirmDialog } from '../core/ui.js';
import { icon } from '../core/icons.js';

/** Generic searchable, paged list for a master definition (views/masters/config.js). */
export function masterListView(key, cfg) {
  return {
    title: () => t(cfg.title),
    render(main, params, query) {
      const manage = can(cfg.perm.manage);
      const state = { q: query.q || '', status: query.status || '', page: 1, filters: {} };

      main.innerHTML = `
        <div class="toolbar">
          <label class="search-box">${icon('search', { size: 20 })}
            <input type="search" name="q" value="${esc(state.q)}" placeholder="${esc(t('common.search'))}" aria-label="${esc(t('common.search'))}"></label>
          ${(cfg.filters || []).map((f) => `<select data-filter="${esc(f.key)}" aria-label="${esc(t(f.label))}">
              <option value="">${esc(t(f.label))}: ${esc(t('common.all'))}</option>
              ${f.options.map((o) => `<option value="${esc(o.value)}">${esc(t(o.label))}</option>`).join('')}</select>`).join('')}
          <select name="status" aria-label="${esc(t('common.status'))}">
            <option value="">${esc(t('common.status'))}: ${esc(t('common.all'))}</option>
            <option value="active">${esc(t('common.active'))}</option>
            <option value="inactive">${esc(t('common.inactive'))}</option>
          </select>
          ${manage ? `<a class="btn btn-primary" href="#/m/${key}/new">${icon('plus', { size: 20 })}<span>${esc(t('common.new'))}</span></a>` : ''}
        </div>
        ${(cfg.links || []).filter((l) => can(l.perm)).map((l) => `<a class="link-chip" href="${esc(l.href)}">${esc(t(l.label))} ${icon('chevron_end', { size: 16 })}</a>`).join('')}
        <div class="card list-card" data-list>${spinner()}</div>`;

      const listEl = main.querySelector('[data-list]');

      async function load() {
        listEl.innerHTML = spinner();
        try {
          const data = await api.get(cfg.api, { ...(cfg.listQuery || {}), ...state.filters, q: state.q, status: state.status, page: state.page, per_page: 25 });
          if (!data.items.length) {
            listEl.innerHTML = emptyState();
            return;
          }
          listEl.innerHTML = `<ul class="rows">${data.items.map((r) => {
            const lead = cfg.list.lead?.(r);
            return `<li class="row-item ${r.is_active ? '' : 'is-muted'}">
              ${lead ?? `<span class="tile-icon">${icon(cfg.icon, { size: 20 })}</span>`}
              <div class="row-main">
                <div class="row-title">${cfg.list.title(r)} <span class="muted">${cfg.list.sub(r)}</span></div>
                <div class="row-meta">${r.is_active ? '' : `<span class="pill pill-off">${esc(t('common.inactive'))}</span>`}${cfg.list.meta(r)}</div>
              </div>
              ${manage ? `<div class="row-actions">
                <a class="icon-btn" href="#/m/${key}/${r.id}" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">${icon('edit', { size: 20 })}</a>
                <button type="button" class="icon-btn danger" data-delete="${r.id}" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}">${icon('trash', { size: 20 })}</button>
              </div>` : ''}
            </li>`;
          }).join('')}</ul>`;
          listEl.appendChild(pager(data, (p) => { state.page = p; load(); }));
        } catch (err) {
          listEl.innerHTML = errorState(err.message);
        }
      }

      listEl.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-delete]');
        if (!del) return;
        const name = del.closest('.row-item').querySelector('.row-title').firstChild.textContent.trim();
        if (!(await confirmDialog({ message: t('master.delete_confirm', { name }), confirmText: t('common.delete'), danger: true }))) return;
        try {
          await api.del(`${cfg.api}/${del.dataset.delete}`);
          invalidate(cfg.lookupSet || key);
          toast(t('deleted'), 'success');
          load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      const onSearch = debounce(() => { state.page = 1; load(); }, 300);
      main.querySelector('[name="q"]').addEventListener('input', (e) => { state.q = e.target.value.trim(); onSearch(); });
      main.querySelector('[name="status"]').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });
      main.querySelectorAll('[data-filter]').forEach((s) => s.addEventListener('change', () => {
        state.filters[s.dataset.filter] = s.value;
        state.page = 1;
        load();
      }));
      load();
    },
  };
}
