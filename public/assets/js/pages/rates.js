// Statutory rates (EOBI / PESSI / SESSI) and income tax slabs. Effective-dated: a new notification is a
// new row / slab set. Rows already used by posted salary are locked by the server (add a new row instead).
import { get, post, put, del } from '../core/api.js';
import { h, toast, modal, confirmDialog, fdate, money } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { can } from '../core/store.js';

const METHODS = { percent_of_min_wage: '% of minimum wage', percent_of_wage: '% of wages (up to ceiling)', fixed: 'Fixed amount' };
const num = (v, d = 2) => (v === null || v === '' || v === undefined ? '' : Number(v).toLocaleString('en-US', { maximumFractionDigits: d }));

export default {
  async mount(root) {
    const canEdit = can('settings', 'edit');
    const statBox = h('div');
    const taxBox = h('div');
    const lockNote = h('div', { class: 'lock-note' });
    let data = null;

    async function load() {
      data = await get('rates');
      lockNote.textContent = data.locked_until
        ? `Salary is posted up to ${fdate(data.locked_until)}. Rows used by posted salary are locked — add a new row with its effective date instead.`
        : 'No salary posted yet: every row can be edited.';
      renderStatutory();
      renderTax();
    }

    function renderStatutory() {
      statBox.replaceChildren(h('div', { class: 'rates-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['Scheme', 'Effective from', 'Method', 'Employee share', 'Employer share', 'Minimum wage', 'Wage ceiling', 'Remarks', '']
          .map((l, i) => h('th', { class: i >= 3 && i <= 6 ? 'num' : '' }, l)))),
        h('tbody', null, data.statutory.map((r) => h('tr', { ondblclick: () => editStatutory(r) },
          h('td', null, h('b', null, r.code)), h('td', null, fdate(r.effective_from)), h('td', null, METHODS[r.calc_method]),
          h('td', { class: 'num' }, r.calc_method === 'fixed' ? money(r.employee_share) : num(r.employee_share, 4) + '%'),
          h('td', { class: 'num' }, r.calc_method === 'fixed' ? money(r.employer_share) : num(r.employer_share, 4) + '%'),
          h('td', { class: 'num' }, money(r.min_wage)), h('td', { class: 'num' }, r.wage_ceiling ? money(r.wage_ceiling) : '—'),
          h('td', null, r.remarks || ''),
          h('td', null, canEdit ? h('button', { class: 'btn sm', type: 'button', onclick: () => editStatutory(r) }, 'Edit') : null)))))));
    }

    function editStatutory(r) {
      if (!canEdit) return;
      const f = new Form([
        { name: 'code', label: 'Scheme', type: 'select', required: true, span: 4, options: ['EOBI', 'PESSI', 'SESSI'].map((v) => ({ value: v, label: v })) },
        { name: 'effective_from', label: 'Effective from', type: 'date', required: true, span: 4 },
        { name: 'calc_method', label: 'Method', type: 'select', required: true, span: 4, options: Object.entries(METHODS).map(([value, label]) => ({ value, label })) },
        { name: 'employee_share', label: 'Employee share (% or Rs)', type: 'number', required: true, span: 3, min: 0, step: 0.0001 },
        { name: 'employer_share', label: 'Employer share (% or Rs)', type: 'number', required: true, span: 3, min: 0, step: 0.0001 },
        { name: 'min_wage', label: 'Minimum wage', type: 'number', span: 3, min: 0, help: 'Base for "% of minimum wage"' },
        { name: 'wage_ceiling', label: 'Wage ceiling', type: 'number', span: 3, min: 0, help: 'Empty = no cap' },
        { name: 'remarks', label: 'Remarks / notification', span: 12, maxlength: 255 },
      ]);
      f.values = r || { code: 'EOBI', calc_method: 'percent_of_min_wage', employee_share: 1, employer_share: 5 };
      modal({
        title: r ? `${r.code} rate from ${fdate(r.effective_from)}` : 'New statutory rate',
        wide: true,
        body: h('div', null, f.el, h('p', { class: 'lock-note' }, 'Payroll deducts only the employee share. The rate effective on the last day of a salary period is used.')),
        buttons: [
          ...(r ? [{ label: 'Delete', class: 'danger', onClick: async () => {
            if (!(await confirmDialog(`Delete the ${r.code} rate effective ${fdate(r.effective_from)}?`, { ok: 'Delete', danger: true }))) return false;
            try { await del(`rates/statutory/${r.id}`); toast('Rate deleted.'); await load(); return true; } catch (e) { toast(e.message, 'err', 7000); return false; }
          } }] : []),
          { label: 'Cancel' },
          { label: 'Save (F10)', class: 'primary', onClick: async () => {
            try {
              await (r ? put(`rates/statutory/${r.id}`, f.values) : post('rates/statutory', f.values));
              toast('Rate saved.'); await load(); return true;
            } catch (e) { f.showErrors(e.errors || {}, Object.keys(e.errors || {}).length ? '' : e.message); return false; }
          } },
        ],
      });
    }

    function renderTax() {
      taxBox.replaceChildren(...(data.tax_sets.length ? data.tax_sets.map((set) => h('div', { class: 'panel', style: 'margin-bottom:10px' },
        h('div', { class: 'panel-head' }, h('h2', null, `Tax year ${set.tax_year} — effective from ${fdate(set.effective_from)}`),
          canEdit ? h('button', { class: 'btn sm', type: 'button', onclick: () => editTax(set) }, 'Edit') : null,
          canEdit ? h('button', { class: 'btn sm', type: 'button', onclick: () => editTax({ ...set, effective_from: '', tax_year: '' }, true) }, 'Copy as new year') : null),
        h('div', { class: 'panel-body' }, h('table', { class: 'grid' },
          h('thead', null, h('tr', null, h('th', { class: 'num' }, 'Annual income from'), h('th', { class: 'num' }, 'to'), h('th', { class: 'num' }, 'Fixed tax'), h('th', { class: 'num' }, 'Rate on excess'))),
          h('tbody', null, set.slabs.map((s) => h('tr', null, h('td', { class: 'num' }, money(s.income_from)), h('td', { class: 'num' }, s.income_to === null ? 'and above' : money(s.income_to)),
            h('td', { class: 'num' }, money(s.fixed_amount)), h('td', { class: 'num' }, num(s.rate_percent, 3) + '%')))))))) : [h('div', { class: 'muted' }, 'No tax slabs. Income tax is not deducted until slabs are entered.')]));
    }

    function editTax(set, copy = false) {
      if (!canEdit) return;
      const head = new Form([
        { name: 'tax_year', label: 'Tax year (e.g. 2026-27)', required: true, span: 4, maxlength: 9 },
        { name: 'effective_from', label: 'Effective from', type: 'date', required: true, span: 4, help: 'Usually 1 July' },
      ]);
      head.values = { tax_year: set?.tax_year || '', effective_from: set?.effective_from || '' };
      const rows = (set?.slabs || [{ income_from: 0, income_to: '', fixed_amount: 0, rate_percent: 0 }]).map((s) => ({ ...s }));
      const tbody = h('tbody');
      const cell = (r, k, attrs = {}) => {
        const i = h('input', { class: 'input', type: 'number', min: 0, step: k === 'rate_percent' ? 0.001 : 1, value: r[k] ?? '', style: 'width:100%;text-align:right', ...attrs });
        i.addEventListener('input', () => { r[k] = i.value; });
        return h('td', null, i);
      };
      const draw = () => tbody.replaceChildren(...rows.map((r, idx) => h('tr', null,
        cell(r, 'income_from'), cell(r, 'income_to', { placeholder: idx === rows.length - 1 ? 'and above' : '' }), cell(r, 'fixed_amount'), cell(r, 'rate_percent'),
        h('td', null, h('button', { class: 'btn sm danger', type: 'button', disabled: rows.length === 1, onclick: () => { rows.splice(idx, 1); draw(); } }, '✕')))));
      draw();
      const addRow = h('button', { class: 'btn sm', type: 'button', onclick: () => {
        const prev = rows[rows.length - 1];
        rows.push({ income_from: prev?.income_to || '', income_to: '', fixed_amount: '', rate_percent: '' });
        draw();
        tbody.lastChild?.querySelector('input')?.focus();
      } }, '+ Add slab');
      const err = h('div', { class: 'form-error hidden' });
      modal({
        title: copy ? 'New tax year (copied)' : set ? `Tax slabs ${set.tax_year}` : 'New tax slab set',
        wide: true,
        body: h('div', null, head.el,
          h('table', { class: 'grid', style: 'margin-top:8px' }, h('thead', null, h('tr', null, h('th', null, 'Annual income from'), h('th', null, 'to (empty = and above)'),
            h('th', null, 'Fixed tax'), h('th', null, 'Rate % on excess'), h('th'))), tbody),
          h('div', { style: 'display:flex;gap:8px;align-items:center;margin-top:6px' }, addRow,
            h('span', { class: 'lock-note' }, 'Tax = fixed tax + rate × (annual income − "from"). Slabs must start at 0 and be continuous.')), err),
        buttons: [
          ...(set && !copy ? [{ label: 'Delete set', class: 'danger', onClick: async () => {
            if (!(await confirmDialog(`Delete the ${set.tax_year} slabs?`, { ok: 'Delete', danger: true }))) return false;
            try { await del(`rates/tax-slabs?effective_from=${set.effective_from}`); toast('Slab set deleted.'); await load(); return true; } catch (e) { toast(e.message, 'err', 7000); return false; }
          } }] : []),
          { label: 'Cancel' },
          { label: 'Save (F10)', class: 'primary', onClick: async () => {
            err.classList.add('hidden');
            try {
              await put('rates/tax-slabs', { ...head.values, original_effective_from: set && !copy ? set.effective_from : null,
                slabs: rows.map((r) => ({ income_from: r.income_from, income_to: r.income_to === '' ? null : r.income_to, fixed_amount: r.fixed_amount, rate_percent: r.rate_percent })) });
              toast('Tax slabs saved.'); await load(); return true;
            } catch (e) {
              head.showErrors(e.errors || {}, '');
              err.textContent = e.errors?.slabs || (Object.keys(e.errors || {}).length ? '' : e.message);
              err.classList.toggle('hidden', !err.textContent);
              return false;
            }
          } },
        ],
      });
    }

    setKeys({ load, new: () => editStatutory(null) });
    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !canEdit, onclick: () => editStatutory(null) }, 'New rate ', h('kbd', null, 'F5')),
        h('button', { class: 'btn', type: 'button', disabled: !canEdit, onclick: () => editTax(null) }, 'New tax year'),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Reload ', h('kbd', null, 'F7')),
        h('span', { class: 'spacer' }), lockNote),
      h('div', { class: 'panel', style: 'margin-bottom:12px' }, h('div', { class: 'panel-head' }, h('h2', null, 'EOBI / PESSI / SESSI'),
        h('span', { class: 'lock-note' }, 'Which social security scheme applies is set in Company Settings.')), h('div', { class: 'panel-body' }, statBox)),
      h('h3', { style: 'margin:14px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)' }, 'Income tax slabs (salaried)'),
      taxBox,
    );
    await load();
  },
};
