import { api } from '../core/api.js';
import { t, getLang } from '../core/i18n.js';
import { esc, spinner, errorState, toast } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';

/** Role → permission matrix editor. One form per role (Admin is read-only). */
export default {
  title: () => t('roles.title'),
  render(main) {
    const navs = [];
    main.innerHTML = spinner();

    api.get('roles/matrix').then(({ roles, modules }) => {
      const ur = getLang() === 'ur';
      const label = (key, fallback) => {
        const s = t(key);
        return s === key ? fallback : s;
      };

      main.innerHTML = `<p class="muted intro">${esc(t('roles.intro'))}</p>
        <div class="role-tabs" role="tablist">${roles.map((r, i) => `
          <button type="button" role="tab" class="tab ${i === 0 ? 'is-active' : ''}" data-tab="${r.id}" aria-selected="${i === 0}">
            ${esc(ur ? r.name_ur || r.name : r.name)} <span class="muted">${esc(t('roles.users', { n: r.user_count }))}</span></button>`).join('')}
        </div>
        ${roles.map((r, i) => {
          const locked = r.code === 'admin';
          const granted = new Set(r.permissions);
          return `<form class="card form role-form" data-role="${r.id}" ${i === 0 ? '' : 'hidden'}>
            <fieldset ${locked ? 'disabled' : ''} class="perm-grid">
              ${Object.entries(modules).map(([mod, perms]) => `
                <div class="perm-module">
                  <div class="perm-head"><strong>${esc(label(`module.${mod}`, mod))}</strong>
                    ${locked ? '' : `<label class="check check-sm"><input type="checkbox" data-all="${esc(mod)}" data-enter-skip> <span>${esc(t('roles.select_all'))}</span></label>`}</div>
                  <div class="perm-list">${perms.map((p) => `
                    <label class="check" title="${esc(p.description)}"><input type="checkbox" name="codes" value="${esc(p.code)}" data-mod="${esc(mod)}" ${granted.has(p.code) ? 'checked' : ''}>
                      <span>${esc(label(`action.${p.action}`, p.action))}</span></label>`).join('')}</div>
                </div>`).join('')}
            </fieldset>
            ${locked ? '' : `<div class="form-actions"><button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button></div>`}
          </form>`;
        }).join('')}`;

      const syncAll = (form) => form.querySelectorAll('[data-all]').forEach((all) => {
        const boxes = [...form.querySelectorAll(`[data-mod="${CSS.escape(all.dataset.all)}"]`)];
        all.checked = boxes.every((b) => b.checked);
        all.indeterminate = !all.checked && boxes.some((b) => b.checked);
      });

      main.querySelectorAll('.role-form').forEach((form) => {
        const role = roles.find((r) => String(r.id) === form.dataset.role);
        syncAll(form);
        form.addEventListener('change', (e) => {
          if (e.target.dataset.all) {
            form.querySelectorAll(`[data-mod="${CSS.escape(e.target.dataset.all)}"]`).forEach((b) => { b.checked = e.target.checked; });
          }
          syncAll(form);
        });
        if (role.code === 'admin') return;
        navs.push(EnterNav.attach(form, {
          autofocus: false,
          resetAfterSave: false,
          successMessage: () => t('roles.saved', { role: ur ? role.name_ur || role.name : role.name }),
          collect: (f) => ({ codes: [...f.querySelectorAll('input[name="codes"]:checked')].map((b) => b.value) }),
          onSave: (data) => api.put(`roles/${role.id}/permissions`, data),
        }));
      });

      main.querySelector('.role-tabs').addEventListener('click', (e) => {
        const tab = e.target.closest('[data-tab]');
        if (!tab) return;
        main.querySelectorAll('[data-tab]').forEach((b) => {
          const on = b === tab;
          b.classList.toggle('is-active', on);
          b.setAttribute('aria-selected', String(on));
        });
        main.querySelectorAll('.role-form').forEach((f) => { f.hidden = f.dataset.role !== tab.dataset.tab; });
      });
    }).catch((err) => {
      main.innerHTML = errorState(err.message);
      toast(err.message, 'error');
    });

    return () => navs.forEach((n) => n.destroy());
  },
};
