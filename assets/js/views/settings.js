import { api } from '../core/api.js';
import { t } from '../core/i18n.js';
import { session } from '../core/session.js';
import { invalidate } from '../core/lookups.js';
import { esc, spinner, errorState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import EnterNav from '../core/enterNav.js';
import { renderFields, mountFields } from '../core/formKit.js';

const COMPANY = [
  { key: 'company_name', label: 'settings.company_name', type: 'text', max: 120, required: true },
  { key: 'company_name_ur', label: 'settings.company_name_ur', type: 'text', max: 120, dir: 'rtl' },
  { key: 'company_address', label: 'settings.company_address', type: 'text', max: 255, span: true },
  { key: 'company_phone', label: 'settings.company_phone', type: 'text', max: 60, dir: 'ltr' },
  { key: 'company_ntn', label: 'settings.company_ntn', type: 'text', max: 30, dir: 'ltr' },
  { key: 'whatsapp_support', label: 'settings.whatsapp', type: 'text', inputType: 'tel', max: 20, dir: 'ltr', pattern: '\\+?[0-9]{10,15}', hint: 'settings.whatsapp_hint' },
];
const PRINT = [
  { key: 'chalan_copies', label: 'settings.chalan_copies', type: 'select', required: true,
    options: [{ value: '1', label: 'settings.copies_1' }, { value: '2', label: 'settings.copies_2' }, { value: '3', label: 'settings.copies_3' }] },
  { key: 'chalan_terms', label: 'settings.chalan_terms', type: 'textarea', max: 500, hint: 'settings.chalan_terms_hint' },
];
const INK = [
  { key: 'ink_ml_per_sqm_full', label: 'settings.ink_ml', type: 'number', min: 0.01, step: '0.01', required: true, hint: 'settings.ink_ml_hint' },
  { key: 'ink_reference_gsm', label: 'settings.ink_ref_gsm', type: 'number', min: 1, step: '0.01', required: true },
  { key: 'default_wastage_pct', label: 'settings.wastage', type: 'number', min: 0, maxValue: 100, step: '0.01', required: true },
];

export default {
  title: () => t('setup.settings'),
  render(main) {
    let nav = null;
    main.innerHTML = spinner();
    api.get('settings').then((data) => {
      main.innerHTML = `
        <form class="settings-form" autocomplete="off">
          <section class="card form"><h2>${esc(t('settings.company'))}</h2><div class="form-grid">${renderFields(COMPANY)}</div></section>
          <section class="card form"><h2>${esc(t('settings.print'))}</h2><div class="form-grid">${renderFields(PRINT)}</div></section>
          <section class="card form"><h2>${esc(t('settings.ink'))}</h2>
            <p class="field-hint">${esc(t('settings.ink_formula'))}</p>
            <div class="form-grid">${renderFields(INK)}</div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">${icon('check', { size: 20 })}<span>${esc(t('common.save'))}</span></button></div>
          </section>
        </form>`;
      const form = main.querySelector('form');
      const ctx = mountFields(form, [...COMPANY, ...PRINT, ...INK]);
      ctx.setValues(data);
      ctx.snapshot();
      nav = EnterNav.attach(form, {
        resetAfterSave: false,
        collect: () => ctx.collect(),
        onSave: async (body) => {
          const res = await api.put('settings', body);
          invalidate('ink_params');
          session.app.name = res.company_name;
          session.app.name_ur = res.company_name_ur;
          session.app.whatsapp = res.whatsapp_support;
          Object.assign(session.app, {
            address: res.company_address, phone: res.company_phone, ntn: res.company_ntn,
            chalan_copies: Number(res.chalan_copies), chalan_terms: res.chalan_terms,
          });
          ctx.snapshot();
          return res;
        },
      });
    }).catch((err) => { main.innerHTML = errorState(err.message); });
    return () => nav?.destroy();
  },
};
