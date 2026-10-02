import { api } from '../core/api.js';
import { t, fmtDate, getLang } from '../core/i18n.js';
import { can } from '../core/session.js';
import { esc, el, toast, spinner, emptyState, errorState, pager, debounce, confirmDialog, formDialog, field } from '../core/ui.js';
import { icon } from '../core/icons.js';

export default {
  title: () => t('users.title'),
  render(main, params, query) {
    const state = { q: query.q || '', role_id: query.role_id || '', status: query.status || '', page: Number(query.page) || 1 };
    const manage = can('users.manage');
    let roles = [];

    main.innerHTML = `
      <div class="toolbar">
        <label class="search-box">${icon('search', { size: 20 })}
          <input type="search" name="q" value="${esc(state.q)}" placeholder="${esc(t('users.search'))}" aria-label="${esc(t('common.search'))}"></label>
        <select name="role_id" aria-label="${esc(t('user.role'))}"><option value="">${esc(t('user.role'))}: ${esc(t('common.all'))}</option></select>
        <select name="status" aria-label="${esc(t('common.status'))}">
          <option value="">${esc(t('common.status'))}: ${esc(t('common.all'))}</option>
          <option value="active" ${state.status === 'active' ? 'selected' : ''}>${esc(t('common.active'))}</option>
          <option value="inactive" ${state.status === 'inactive' ? 'selected' : ''}>${esc(t('common.inactive'))}</option>
        </select>
        ${manage ? `<a class="btn btn-primary" href="#/users/new">${icon('plus', { size: 20 })}<span>${esc(t('users.new'))}</span></a>` : ''}
      </div>
      <div class="card list-card" data-list>${spinner()}</div>`;

    const listEl = main.querySelector('[data-list]');
    const roleSel = main.querySelector('[name="role_id"]');

    async function load() {
      listEl.innerHTML = spinner();
      try {
        const data = await api.get('users', { q: state.q, role_id: state.role_id, status: state.status, page: state.page, per_page: 25 });
        renderList(data);
      } catch (err) {
        listEl.innerHTML = errorState(err.message);
      }
    }

    function renderList(data) {
      if (!data.items.length) {
        listEl.innerHTML = emptyState();
        return;
      }
      const ur = getLang() === 'ur';
      listEl.innerHTML = `<ul class="rows">${data.items.map((u) => `
        <li class="row-item ${u.is_active ? '' : 'is-muted'}">
          <span class="avatar">${esc(u.full_name.charAt(0).toUpperCase())}</span>
          <div class="row-main">
            <div class="row-title">${esc(u.full_name)} <span class="muted">@${esc(u.username)}</span></div>
            <div class="row-meta">
              <span class="pill">${esc(ur ? u.role_name_ur || u.role_name : u.role_name)}</span>
              <span class="pill ${u.is_active ? 'pill-ok' : 'pill-off'}">${esc(t(u.is_active ? 'common.active' : 'common.inactive'))}</span>
              ${u.must_change_password ? `<span class="pill pill-warn">${esc(t('users.pending_change'))}</span>` : ''}
              <span>${esc(t('user.last_login'))}: <span dir="ltr">${esc(u.last_login_at ? fmtDate(u.last_login_at, true) : t('common.never'))}</span></span>
              ${u.phone ? `<span dir="ltr">${esc(u.phone)}</span>` : ''}
            </div>
          </div>
          ${manage ? `<div class="row-actions">
            <a class="icon-btn" href="#/users/${u.id}" aria-label="${esc(t('common.edit'))}" title="${esc(t('common.edit'))}">${icon('edit', { size: 20 })}</a>
            <button type="button" class="icon-btn" data-reset="${u.id}" data-name="${esc(u.full_name)}" aria-label="${esc(t('users.reset_password'))}" title="${esc(t('users.reset_password'))}">${icon('key', { size: 20 })}</button>
            <button type="button" class="icon-btn danger" data-delete="${u.id}" data-name="${esc(u.full_name)}" aria-label="${esc(t('common.delete'))}" title="${esc(t('common.delete'))}">${icon('trash', { size: 20 })}</button>
          </div>` : ''}
        </li>`).join('')}</ul>`;
      listEl.appendChild(pager(data, (p) => { state.page = p; load(); }));
    }

    listEl.addEventListener('click', async (e) => {
      const reset = e.target.closest('[data-reset]');
      const del = e.target.closest('[data-delete]');
      if (reset) {
        const id = reset.dataset.reset;
        const done = await formDialog({
          title: `${t('users.reset_password')} — ${reset.dataset.name}`,
          fieldsHtml: field({ label: t('user.new_password'), required: true, hint: t('validation.password'),
            control: '<input name="new_password" type="password" required minlength="8" maxlength="72" autocomplete="new-password">' }),
          successMessage: t('users.reset_done'),
          onSave: (data) => api.post(`users/${id}/password`, data),
        });
        if (done) load();
      }
      if (del) {
        const ok = await confirmDialog({ message: t('users.delete_confirm', { name: del.dataset.name }), confirmText: t('common.delete'), danger: true });
        if (!ok) return;
        try {
          await api.del(`users/${del.dataset.delete}`);
          toast(t('deleted'), 'success');
          load();
        } catch (err) {
          toast(err.errors ? Object.values(err.errors).join(' ') : err.message, 'error');
        }
      }
    });

    const onSearch = debounce(() => { state.page = 1; load(); }, 300);
    main.querySelector('[name="q"]').addEventListener('input', (e) => { state.q = e.target.value.trim(); onSearch(); });
    roleSel.addEventListener('change', () => { state.role_id = roleSel.value; state.page = 1; load(); });
    main.querySelector('[name="status"]').addEventListener('change', (e) => { state.status = e.target.value; state.page = 1; load(); });

    api.get('roles').then((list) => {
      roles = list;
      const ur = getLang() === 'ur';
      roles.forEach((r) => roleSel.appendChild(el(`<option value="${r.id}" ${String(state.role_id) === String(r.id) ? 'selected' : ''}>${esc(ur ? r.name_ur || r.name : r.name)}</option>`)));
    }).catch(() => {});
    load();
  },
};
