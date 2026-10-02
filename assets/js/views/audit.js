import { api } from '../core/api.js';
import { t, fmtDate } from '../core/i18n.js';
import { esc, el, spinner, emptyState, errorState, pager, field } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';

function valuesTable(obj) {
  if (!obj || typeof obj !== 'object' || !Object.keys(obj).length) return '<span class="muted">—</span>';
  return `<dl class="kv">${Object.entries(obj).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(typeof v === 'object' && v !== null ? JSON.stringify(v) : v ?? '—')}</dd>`).join('')}</dl>`;
}

export default {
  title: () => t('audit.title'),
  render(main) {
    const state = { page: 1, filters: {} };
    main.innerHTML = `
      <form class="card form filter-form" autocomplete="off">
        ${field({ label: t('audit.date_from'), control: '<input type="date" name="date_from">' })}
        ${field({ label: t('audit.date_to'), control: '<input type="date" name="date_to">' })}
        ${field({ label: t('audit.entity'), control: `<select name="entity"><option value="">${esc(t('common.all'))}</option></select>` })}
        ${field({ label: t('audit.action'), control: `<select name="action"><option value="">${esc(t('common.all'))}</option></select>` })}
        ${field({ label: t('audit.search'), control: '<input type="search" name="q" maxlength="60">' })}
        <div class="form-actions"><button type="reset" class="btn btn-ghost">${esc(t('common.clear'))}</button>
          <button type="submit" class="btn btn-primary">${icon('search', { size: 20 })}<span>${esc(t('common.apply'))}</span></button></div>
      </form>
      <div class="card list-card" data-list>${spinner()}</div>`;

    const form = main.querySelector('form');
    const listEl = main.querySelector('[data-list]');
    let optionsLoaded = false;

    async function load() {
      listEl.innerHTML = spinner();
      try {
        const data = await api.get('audit', { ...state.filters, page: state.page, per_page: 50 });
        if (!optionsLoaded) {
          optionsLoaded = true;
          data.entities.forEach((v) => form.elements.entity.appendChild(el(`<option value="${esc(v)}">${esc(v)}</option>`)));
          data.actions.forEach((v) => {
            const key = `audit.action.${v}`;
            const text = t(key) === key ? v : t(key);
            form.elements.action.appendChild(el(`<option value="${esc(v)}">${esc(text)}</option>`));
          });
        }
        if (!data.items.length) {
          listEl.innerHTML = emptyState();
          return;
        }
        listEl.innerHTML = `<ul class="rows">${data.items.map((a) => {
          const key = `audit.action.${a.action}`;
          const actionText = t(key) === key ? a.action : t(key);
          const hasDetails = a.old_values || a.new_values;
          return `<li class="row-item audit-row">
            <span class="tile-icon">${icon(a.action.startsWith('log') ? 'user' : a.action === 'delete' ? 'trash' : 'history', { size: 20 })}</span>
            <div class="row-main">
              <div class="row-title">${esc(actionText)} · ${esc(a.entity)}${a.reference ? ` <span class="muted">${esc(a.reference)}</span>` : ''}</div>
              <div class="row-meta"><span dir="ltr">${esc(fmtDate(a.created_at, true))}</span><span>${esc(a.username || '—')}</span><span dir="ltr">${esc(a.ip || '')}</span></div>
              ${hasDetails ? `<details class="audit-details"><summary>${esc(t('audit.details'))}</summary>
                <div class="audit-diff"><div><h4>${esc(t('audit.before'))}</h4>${valuesTable(a.old_values)}</div>
                <div><h4>${esc(t('audit.after'))}</h4>${valuesTable(a.new_values)}</div></div></details>` : ''}
            </div></li>`;
        }).join('')}</ul>`;
        listEl.appendChild(pager(data, (p) => { state.page = p; load(); }));
      } catch (err) {
        listEl.innerHTML = errorState(err.message);
      }
    }

    const nav = EnterNav.attach(form, {
      autofocus: false,
      resetAfterSave: false,
      successMessage: '',
      onSave: (data) => {
        state.filters = data;
        state.page = 1;
        return load();
      },
    });
    form.addEventListener('reset', () => setTimeout(() => { state.filters = {}; state.page = 1; load(); }));
    load();
    return () => nav.destroy();
  },
};
