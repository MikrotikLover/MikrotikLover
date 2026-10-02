import { api } from '../core/api.js';
import { t, fmtNumber } from '../core/i18n.js';
import { can } from '../core/session.js';
import { loadLookups, optLabel, invalidate } from '../core/lookups.js';
import { esc, toast, spinner, emptyState, errorState, pager, debounce, confirmDialog } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { nm } from './masters/config.js';

/** Design library: thumbnail gallery with search / party / process filters. */
export default {
  title: () => t('setup.designs'),
  render(main) {
    const manage = can('designs.manage');
    const state = { q: '', party_id: '', process_type: '', status: '', page: 1 };

    main.innerHTML = `
      <div class="toolbar toolbar-wide">
        <label class="search-box">${icon('search', { size: 20 })}
          <input type="search" name="q" placeholder="${esc(t('design.search'))}" aria-label="${esc(t('common.search'))}"></label>
        <select name="party_id" aria-label="${esc(t('filter.party'))}"><option value="">${esc(t('filter.party'))}: ${esc(t('common.all'))}</option></select>
        <select name="process_type" aria-label="${esc(t('f.process_type'))}">
          <option value="">${esc(t('f.process_type'))}: ${esc(t('common.all'))}</option>
          ${['sublimation', 'reactive', 'pigment'].map((p) => `<option value="${p}">${esc(t(`process.${p}`))}</option>`).join('')}
        </select>
        <select name="status" aria-label="${esc(t('common.status'))}">
          <option value="">${esc(t('common.status'))}: ${esc(t('common.all'))}</option>
          <option value="active">${esc(t('common.active'))}</option><option value="inactive">${esc(t('common.inactive'))}</option>
        </select>
        ${manage ? `<a class="btn btn-primary" href="#/designs/new">${icon('plus', { size: 20 })}<span>${esc(t('design.new'))}</span></a>` : ''}
      </div>
      <div data-list>${spinner()}</div>`;

    const listEl = main.querySelector('[data-list]');

    async function load() {
      listEl.innerHTML = spinner();
      try {
        const data = await api.get('designs', { q: state.q, party_id: state.party_id, process_type: state.process_type, status: state.status, page: state.page, per_page: 24 });
        if (!data.items.length) {
          listEl.innerHTML = `<div class="card">${emptyState()}</div>`;
          return;
        }
        listEl.innerHTML = `<ul class="gallery">${data.items.map((d) => `
          <li class="card design-card ${d.is_active ? '' : 'is-muted'}">
            <a href="#/designs/${d.id}" class="design-thumb" aria-label="${esc(d.design_code)}">
              ${d.thumb_url ? `<img src="${esc(d.thumb_url)}" alt="" loading="lazy">` : `<span class="thumb-empty">${icon('image', { size: 36 })}</span>`}
            </a>
            <div class="design-body">
              <div class="row-title"><span dir="ltr">${esc(d.design_code)}</span> · ${esc(d.name)}</div>
              <div class="row-meta">
                ${d.party_name ? `<span>${esc(nm(d, 'party_name'))}</span>` : ''}
                <span class="pill">${esc(t(`process.${d.process_type}`))}</span>
                <span>${esc(t('design.colours_n', { n: d.colour_count }))}</span>
                <span dir="ltr">${esc(fmtNumber(d.ink_coverage_pct, 0))}%</span>
                ${d.is_active ? '' : `<span class="pill pill-off">${esc(t('common.inactive'))}</span>`}
              </div>
            </div>
            ${manage ? `<button type="button" class="icon-btn danger design-del" data-delete="${d.id}" data-name="${esc(d.design_code)}" aria-label="${esc(t('common.delete'))}">${icon('trash', { size: 18 })}</button>` : ''}
          </li>`).join('')}</ul>`;
        const wrap = document.createElement('div');
        wrap.className = 'card';
        wrap.appendChild(pager(data, (p) => { state.page = p; load(); }));
        listEl.appendChild(wrap);
      } catch (err) {
        listEl.innerHTML = errorState(err.message);
      }
    }

    listEl.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-delete]');
      if (!del) return;
      if (!(await confirmDialog({ message: t('master.delete_confirm', { name: del.dataset.name }), confirmText: t('common.delete'), danger: true }))) return;
      try {
        await api.del(`designs/${del.dataset.delete}`);
        invalidate('designs');
        toast(t('deleted'), 'success');
        load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    const onSearch = debounce(() => { state.page = 1; load(); }, 300);
    main.querySelector('[name=q]').addEventListener('input', (e) => { state.q = e.target.value.trim(); onSearch(); });
    ['party_id', 'process_type', 'status'].forEach((k) => main.querySelector(`[name=${k}]`).addEventListener('change', (e) => {
      state[k] = e.target.value;
      state.page = 1;
      load();
    }));
    loadLookups(['parties']).then(({ parties }) => {
      const sel = main.querySelector('[name=party_id]');
      parties.filter((p) => p.is_customer || p.is_fabric_owner).forEach((p) => {
        const o = document.createElement('option');
        o.value = p.value;
        o.textContent = optLabel(p);
        sel.appendChild(o);
      });
    }).catch(() => {});
    load();
  },
};
