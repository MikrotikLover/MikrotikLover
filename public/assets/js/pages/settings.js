// Company settings: name/address (English + Urdu), logo, payroll basis (day basis, rounding, OT), rest days, ID card options.
// Statutory rates and tax slabs have their own screen (rates.js).
import { get, put, del, api } from '../core/api.js';
import { h, toast, confirmDialog, WEEKDAYS } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { can, loadLookups, session } from '../core/store.js';

export default {
  async mount(root) {
    const canEdit = can('settings', 'edit');
    const form = new Form([
      { type: 'section', label: 'Company' },
      { name: 'company_name', label: 'Company Name', required: true, span: 6, maxlength: 150 },
      { name: 'company_name_ur', label: 'کمپنی کا نام (Urdu)', urdu: true, span: 6, maxlength: 150 },
      { name: 'company_address', label: 'Address', span: 6, maxlength: 255 },
      { name: 'company_address_ur', label: 'پتہ (Urdu)', urdu: true, span: 6, maxlength: 255 },
      { name: 'company_phone', label: 'Phone', span: 4, maxlength: 60 },
      { name: 'company_email', label: 'Email', type: 'email', span: 4, maxlength: 120 },
      { name: 'company_ntn', label: 'NTN', span: 4, maxlength: 30 },
      { type: 'section', label: 'Payroll & attendance basis' },
      { name: 'salary_day_basis', label: 'Salary month day basis', type: 'select', required: true, span: 4,
        options: [{ value: 'calendar', label: 'Actual days in month (28–31)' }, { value: 'fixed30', label: 'Fixed 30 days' }, { value: 'fixed26', label: 'Fixed 26 days' }],
        help: 'Work pay = basic ÷ days × paid days' },
      { name: 'social_security', label: 'Social security scheme', type: 'select', required: true, span: 4,
        options: [{ value: 'PESSI', label: 'PESSI (Punjab)' }, { value: 'SESSI', label: 'SESSI (Sindh)' }] },
      { name: 'max_daily_hours', label: 'Flag attendance above (hours/day)', type: 'number', required: true, span: 4, min: 1, max: 24 },
      { name: 'rounding_rule', label: 'Salary rounding (whole rupees)', type: 'select', required: true, span: 4,
        options: [{ value: 'half_up', label: 'Nearest rupee (half up)' }, { value: 'up', label: 'Always up' }, { value: 'down', label: 'Always down' }] },
      { name: 'ot_multiplier', label: 'Overtime multiplier', type: 'number', required: true, span: 4, min: 1, max: 5, step: 0.25,
        help: 'OT rate = salary on the OT date ÷ (days × shift hours) × multiplier (1, 1.5, 2…)' },
      { name: 'default_shift_hours', label: 'Default shift hours (for OT rate)', type: 'number', required: true, span: 4, min: 1, max: 24, step: 0.5,
        help: 'Used when an employee has no shift' },
      { name: 'late_grace_minutes', label: 'Late grace (minutes)', type: 'number', required: true, span: 4, min: 0, max: 240,
        help: 'Late only beyond this; a shift\'s own grace overrides it' },
      { name: 'scan_repeat_seconds', label: 'Barcode repeat scan ignored within (seconds)', type: 'number', required: true, span: 4, min: 10, max: 3600,
        help: '120 = 2 minutes' },
      { name: 'weekly_rest_days', label: 'Weekly rest days', type: 'checks', span: 12, options: WEEKDAYS.map((d, i) => ({ value: i, label: d })) },
      { type: 'section', label: 'ID card' },
      { name: 'id_card_valid_months', label: 'Card validity (months)', type: 'number', required: true, span: 3, min: 1, max: 120 },
      { name: 'id_card_back_note', label: 'Back side note', span: 9, maxlength: 255 },
    ]);
    const logoBox = h('div', { style: 'width:220px;height:110px;border:1px dashed #9ca3af;border-radius:6px;display:grid;place-items:center;background:#f9fafb;overflow:hidden' });
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden' });
    const showLogo = (url) => logoBox.replaceChildren(url ? h('img', { src: url, style: 'max-width:100%;max-height:100%' }) : h('span', { class: 'muted' }, 'No logo'));

    async function load() {
      const d = await get('settings/company');
      form.values = d;
      showLogo(d.logo_url);
    }
    async function save() {
      if (!canEdit) return;
      try {
        const d = await put('settings/company', form.values);
        form.values = d;
        session.company = { name: d.company_name, name_ur: d.company_name_ur };
        window.APP.company = session.company;
        await loadLookups();
        toast('Settings saved.');
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); }
    }
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      const fd = new FormData();
      fd.append('logo', f);
      try { showLogo((await api('POST', 'settings/logo', fd)).logo_url); toast('Logo uploaded.'); } catch (e) { toast(e.message, 'err', 6000); }
    });

    setKeys({ save, load });
    form.setReadonly(!canEdit);
    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn primary', type: 'button', disabled: !canEdit, onclick: save }, 'Save ', h('kbd', null, 'F10')),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Reload ', h('kbd', null, 'F7'))),
      h('div', { class: 'md' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, form.el)),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Company logo')),
          h('div', { class: 'panel-body', style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, logoBox,
            h('div', { style: 'display:flex;flex-direction:column;gap:6px' },
              h('button', { class: 'btn', type: 'button', disabled: !canEdit, onclick: () => fileInput.click() }, 'Upload logo…'),
              h('button', { class: 'btn danger', type: 'button', disabled: !canEdit, onclick: async () => {
                if (!(await confirmDialog('Remove the company logo?', { ok: 'Remove', danger: true }))) return;
                try { showLogo((await del('settings/logo')).logo_url); } catch (e) { toast(e.message, 'err'); }
              } }, 'Remove'),
              h('span', { class: 'muted', style: 'font-size:12px' }, 'PNG with transparent background works best. Shown on reports and ID cards.')),
            fileInput))),
    );
    await load();
    return { canLeave: () => !form.dirty };
  },
};
