import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { loadLookups, invalidate } from '../core/lookups.js';
import { esc, spinner, errorState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { renderFields, mountFields } from '../core/formKit.js';
import { navigate } from '../app.js';

/**
 * Generic create/edit form for a master definition.
 * New record: after save the form clears and focuses the first field (fast entry).
 * Edit: after save, back to the list.
 */
export function masterFormView(key, cfg) {
  return {
    title: (params) => `${t(cfg.title)} · ${t(params.id ? 'common.edit' : 'common.new')}`,
    render(main, params) {
      const isEdit = !!params.id;
      let nav = null;
      main.innerHTML = spinner();

      Promise.all([
        loadLookups(cfg.lookups || []),
        isEdit ? api.get(`${cfg.api}/${params.id}`) : Promise.resolve(null),
      ]).then(([lookups, record]) => {
        main.innerHTML = `
          <form class="card form form-grid" autocomplete="off">
            ${renderFields(cfg.fields)}
            <div class="form-actions span-all">
              <a class="btn btn-ghost" href="#/m/${key}">${esc(t('common.cancel'))}</a>
              <button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button>
            </div>
            <p class="kb-hint span-all">${icon('keyboard', { size: 16 })}${esc(t('kb.hint'))}</p>
          </form>`;
        const form = main.querySelector('form');
        const ctx = mountFields(form, cfg.fields, lookups);
        if (record) ctx.setValues(record);
        else ctx.setDefaults();
        ctx.snapshot();

        nav = EnterNav.attach(form, {
          resetAfterSave: !isEdit,
          collect: () => ({ ...ctx.collect(), ...(cfg.fixed || {}) }),
          onSave: async (data) => {
            const res = isEdit ? await api.put(`${cfg.api}/${params.id}`, data) : await api.post(cfg.api, data);
            invalidate(cfg.lookupSet || key);
            return res;
          },
          onSaved: () => { if (isEdit) navigate(`/m/${key}`); },
        });
      }).catch((err) => { main.innerHTML = errorState(err.message); });

      return () => nav?.destroy();
    },
  };
}
