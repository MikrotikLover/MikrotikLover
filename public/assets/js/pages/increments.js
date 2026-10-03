// Salary increments. Two screens:
//   #/increments[/:employeeId]  single increment: employee, type, value, effective date -> live preview -> Save (F10)
//   #/increments/bulk           bulk increment for a department / shift group: Preview (F7) -> untick exclusions -> Apply (F10)
// The server calculates and decides every figure; this screen only shows its preview.
// Only admins can add / apply / delete; everyone with employees.view sees the history.
import { get, post, del } from '../core/api.js';
import { h, toast, confirmDialog, money, fdate, fdatetime, today, openReport, debounce, TYPES } from '../core/dom.js';
import { EmployeePicker } from '../core/emppicker.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { go, setPath } from '../core/router.js';
import { opt } from '../core/store.js';

const TYPE_LABELS = { joining: 'Joining', percentage: 'Percentage', fixed: 'Fixed amount', new_salary: 'New salary' };
const amt = (v) => (v === null || v === undefined ? '' : money(v));

/** "10%", "+5,000", "= 50,000" */
export function valueLabel(r) {
  if (r.increment_type === 'percentage') return `${Number(r.increment_value)}%`;
  if (r.increment_type === 'fixed') return `+${money(r.increment_value)}`;
  if (r.increment_type === 'new_salary') return `= ${money(r.increment_value)}`;
  return '';
}

/** Change as "+4,000 (10.00%)" from decimal strings (display only). */
function change(oldS, newS) {
  const o = Math.round(Number(oldS) * 100);
  const n = Math.round(Number(newS) * 100);
  const d = (n - o) / 100;
  const pct = o > 0 ? ` (${((n - o) / o * 100).toFixed(2)}%)` : '';
  return `${d >= 0 ? '+' : '−'}${money(Math.abs(d))}${pct}`;
}

const statusBadge = (s) => h('span', { class: 'badge ' + (s === 'applied' ? 'ok' : 'info') }, s === 'applied' ? 'Applied' : 'Scheduled');

/**
 * Increment history grid (employee profile tab and the single-increment screen).
 * onDelete(row) is offered on the latest deletable row when the user may manage increments.
 */
export function incrementHistory({ onDelete = null, maxHeight = '360px' } = {}) {
  const grid = new DataGrid({
    columns: [
      { key: 'effective_date', label: 'Date', render: (r) => fdate(r.effective_date) },
      { key: 'increment_type', label: 'Type', render: (r) => TYPE_LABELS[r.increment_type] || r.increment_type },
      { key: 'increment_value', label: 'Value', align: 'right', render: (r) => valueLabel(r) },
      { key: 'old_salary', label: 'Old Salary', align: 'right', render: (r) => (r.increment_type === 'joining' ? '' : amt(r.old_salary)) },
      { key: 'new_salary', label: 'New Salary', align: 'right', render: (r) => h('b', null, amt(r.new_salary)) },
      { key: 'reason', label: 'Reason' },
      { key: 'approved_by_name', label: 'Approved by' },
      { key: 'created_by_name', label: 'Created by', render: (r) => h('span', { title: fdatetime(r.created_at) }, r.created_by_name || '') },
      { key: 'status', label: 'Status', render: (r) => h('span', null, statusBadge(r.status), r.locked ? h('span', { class: 'badge warn', title: 'A posted salary sheet covers this month or later', style: 'margin-left:4px' }, 'Posted') : null) },
      { key: 'act', label: '', render: (r) => (onDelete && r.can_delete
        ? h('button', { class: 'btn sm danger', type: 'button', title: 'Delete this increment (latest only)', onclick: (e) => { e.stopPropagation(); onDelete(r); } }, 'Delete')
        : '') },
    ],
    emptyText: 'No salary records.',
    maxHeight,
  });
  return grid;
}

/** Shared delete flow; resolves to the refreshed history ({employee, rows}) or null. */
export async function deleteIncrement(row) {
  const msg = `Delete the ${TYPE_LABELS[row.increment_type].toLowerCase()} increment effective ${fdate(row.effective_date)}?\n`
    + `Salary goes back to ${money(row.old_salary)}. To correct an increment, delete it and add it again.`;
  if (!(await confirmDialog(msg, { ok: 'Delete', danger: true }))) return null;
  try {
    const r = await del(`increments/${row.id}`);
    toast('Increment deleted.');
    return r;
  } catch (e) {
    toast(e.message, 'err', 8000);
    return null;
  }
}

async function loadMeta() {
  return get('increments/meta');
}

// ------------------------------------------------------------------ single increment

async function mountSingle(root, params) {
  const meta = await loadMeta();
  const admin = meta.can_manage;
  const st = { emp: null, history: null, preview: null, seq: 0 };

  const picker = new EmployeePicker({ label: 'Employee', required: true, span: 6, onChange: (row) => openEmployee(row?.id) });
  const form = new Form([
    { name: 'increment_type', label: 'Increment type', type: 'select', required: true, span: 3,
      options: [{ value: 'percentage', label: 'Percentage (%)' }, { value: 'fixed', label: 'Fixed amount (+ Rs)' }, { value: 'new_salary', label: 'New salary (direct)' }] },
    { name: 'increment_value', label: 'Value', required: true, span: 3, placeholder: 'e.g. 10 or 5000', help: 'Must be greater than 0' },
    { name: 'effective_date', label: 'Effective date', type: 'date', required: true, span: 3, help: 'Future date = scheduled' },
    { name: 'approved_by', label: 'Approved by', type: 'select', numeric: true, span: 3, blankLabel: '—',
      options: meta.approvers.map((u) => ({ value: u.id, label: u.full_name })) },
    { name: 'reason', label: 'Reason', span: 12, maxlength: 255, placeholder: 'Annual increment / promotion / performance…' },
  ], { onChange: () => schedulePreview() });
  form.el.addEventListener('input', () => schedulePreview());
  const defaults = () => ({ increment_type: 'percentage', increment_value: '', effective_date: today(), approved_by: '', reason: '' });
  form.values = defaults();
  // send the value as typed (string) so the server parses it exactly, never through float
  const values = () => ({ ...form.values, increment_value: form.inputs.increment_value.value.trim() });

  const empBox = h('div', { class: 'muted', style: 'font-size:13px' }, 'Pick an employee (type the code and press Enter, or 🔍 / F2 to search).');
  const pvOld = h('div', { class: 'v' }, '—');
  const pvNew = h('div', { class: 'v' }, '—');
  const pvDiff = h('div', { class: 'v' }, '—');
  const pvStatus = h('div', { class: 'v' }, '—');
  const pvErr = h('div', { class: 'form-error hidden' });
  const card = (label, v, sub = null) => h('div', { class: 'card' }, h('div', { class: 'muted', style: 'font-size:11px;text-transform:uppercase' }, label), v, sub);
  const pvOldSub = h('div', { class: 'muted', style: 'font-size:11px' });
  const previewBox = h('div', null, h('div', { class: 'stat-cards' },
    card('Old salary', pvOld, pvOldSub), card('New salary', pvNew), card('Change', pvDiff), card('Status', pvStatus)), pvErr);

  const history = incrementHistory({ onDelete: admin ? async (r) => { const res = await deleteIncrement(r); if (res) showHistory(res); } : null });
  const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save(), disabled: !admin }, 'Save Increment ', h('kbd', null, 'F10'));
  const btnPrint = h('button', { class: 'btn', type: 'button', onclick: () => st.emp && openReport('employee_increments', { employee_id: st.emp.id }) }, 'Print history ', h('kbd', null, 'F9'));

  function showHistory(res) {
    st.history = res;
    st.emp = res.employee;
    const e = res.employee;
    const unit = e.emp_type === 'daily_wages' ? ' per day (daily wages)' : ' per month';
    const scheduled = res.rows.filter((r) => r.status === 'scheduled');
    empBox.replaceChildren(
      h('b', null, `${e.code} — ${e.name}`), ` · ${e.department} / ${e.designation} · ${TYPES[e.emp_type]} · joined ${fdate(e.joining_date)}`,
      h('br'), 'Current salary: ', h('b', null, money(e.current_salary)), unit,
      scheduled.length ? h('span', null, ' · ', h('span', { class: 'badge info' }, `Scheduled: ${scheduled.map((s) => `${money(s.new_salary)} from ${fdate(s.effective_date)}`).join(', ')}`)) : '',
    );
    history.setRows(res.rows);
    schedulePreview();
  }

  async function openEmployee(id) {
    if (!id) { st.emp = null; history.setRows([]); return; }
    try {
      showHistory(await get(`employees/${id}/increments`));
      setPath(`/increments/${id}`);
      form.focus('increment_value');
    } catch (e) { toast(e.message, 'err'); }
  }

  function clearPreview(msg = '—') {
    pvOld.textContent = pvNew.textContent = pvDiff.textContent = pvStatus.textContent = msg;
    pvOldSub.textContent = '';
    pvErr.classList.add('hidden');
  }

  const runPreview = debounce(async () => {
    const v = values();
    if (!st.emp || !admin || !v.increment_value || !v.effective_date) { clearPreview(); return; }
    const seq = ++st.seq;
    try {
      const p = await get('increments/preview', { employee_id: st.emp.id, increment_type: v.increment_type, increment_value: v.increment_value, effective_date: v.effective_date });
      if (seq !== st.seq) return; // a newer keystroke is on its way
      st.preview = p;
      pvOld.textContent = money(p.old_salary);
      pvOldSub.textContent = `effective on ${fdate(v.effective_date)} − 1 day`;
      pvNew.textContent = p.new_salary === null ? '—' : money(p.new_salary);
      pvDiff.textContent = p.new_salary === null ? '—' : change(p.old_salary, p.new_salary);
      pvStatus.replaceChildren(statusBadge(p.status));
      pvErr.textContent = p.error || '';
      pvErr.classList.toggle('hidden', !p.error);
    } catch (e) {
      if (seq !== st.seq) return;
      clearPreview();
      pvErr.textContent = Object.values(e.errors || {}).join(' ') || e.message;
      pvErr.classList.remove('hidden');
    }
  }, 250);
  function schedulePreview() { runPreview(); }

  async function save() {
    if (!admin) return;
    if (!st.emp) { picker.error('Choose an employee.'); picker.focus(); return; }
    const v = values();
    if (st.preview?.new_salary && Number(st.preview.new_salary) < Number(st.preview.old_salary)
      && !(await confirmDialog(`The new salary ${money(st.preview.new_salary)} is LOWER than the current ${money(st.preview.old_salary)}. Save anyway?`, { ok: 'Save' }))) return;
    try {
      const res = await post('increments', { ...v, employee_id: st.emp.id });
      toast(`Increment saved: ${st.emp.code} → ${money(res.rows[0].new_salary)} from ${fdate(res.rows[0].effective_date)}${res.rows[0].status === 'scheduled' ? ' (scheduled)' : ''}.`, 'ok', 5000);
      form.values = defaults();
      showHistory(res);
    } catch (e) {
      form.showErrors(e.errors || {}, Object.keys(e.errors || {}).length ? '' : e.message);
    }
  }

  setKeys({ save, print: () => btnPrint.click(), search: () => picker.search(), new: () => { form.values = defaults(); picker.set(null); st.emp = null; history.setRows([]); clearPreview(); picker.focus(); } });
  form.setReadonly(!admin);

  root.append(
    h('div', { class: 'toolbar' }, btnSave, btnPrint,
      admin ? h('button', { class: 'btn', type: 'button', onclick: () => go('/increments/bulk') }, 'Bulk increment…') : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'rec' }, admin ? 'Every increment is entered manually. No arrears for past months.' : 'View only — increments are added by an administrator.')),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' },
      h('div', { class: 'form-grid' }, picker.el), h('div', { style: 'margin:6px 0 10px' }, empBox),
      admin ? form.el : null, admin ? previewBox : null)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Increment History')), h('div', { class: 'panel-body' }, history.el)),
  );

  if (params.id && /^\d+$/.test(params.id)) {
    try {
      const res = await get(`employees/${params.id}/increments`);
      picker.set({ id: res.employee.id, code: res.employee.code, name: res.employee.name, department: res.employee.department });
      showHistory(res);
    } catch (e) { toast(e.message, 'err'); }
  }
  picker.focus();
}

// ------------------------------------------------------------------ bulk increment

async function mountBulk(root) {
  const meta = await loadMeta();
  if (!meta.can_manage) {
    root.append(h('div', { class: 'panel panel-body' }, 'Only an administrator can apply bulk increments.'));
    return;
  }
  let scopeKind = 'department';
  const form = new Form([
    { name: 'scope', label: 'Apply to', type: 'select', required: true, span: 2, options: [{ value: 'department', label: 'Department' }, { value: 'shift_group', label: 'Shift group' }] },
    { name: 'scope_id', label: 'Department / Shift group', type: 'select', required: true, numeric: true, span: 4, blank: true,
      options: () => (scopeKind === 'shift_group' ? opt.shiftGroups(true) : opt.departments(true)) },
    { name: 'emp_group', label: 'Employees', type: 'select', span: 2, blankLabel: 'All types',
      options: [{ value: 'monthly', label: 'Monthly (permanent / contract)' }, { value: 'daily', label: 'Daily wages' }] },
    { name: 'increment_type', label: 'Increment type', type: 'select', required: true, span: 2,
      options: [{ value: 'percentage', label: 'Percentage (%)' }, { value: 'fixed', label: 'Fixed amount (+ Rs)' }] },
    { name: 'increment_value', label: 'Value', required: true, span: 2, placeholder: 'e.g. 10 or 3000' },
    { name: 'effective_date', label: 'Effective date', type: 'date', required: true, span: 3 },
    { name: 'approved_by', label: 'Approved by', type: 'select', numeric: true, span: 3, blankLabel: '—', options: meta.approvers.map((u) => ({ value: u.id, label: u.full_name })) },
    { name: 'reason', label: 'Reason', span: 6, maxlength: 255, placeholder: 'Annual increment 2026…' },
  ], { onChange: (name) => { if (name === 'scope') { scopeKind = form.get('scope'); form.refreshOptions('scope_id'); } invalidate(); } });
  form.el.addEventListener('input', () => invalidate());
  form.values = { scope: 'department', emp_group: 'monthly', increment_type: 'percentage', effective_date: today() };
  form.refreshOptions('scope_id');
  const values = () => ({ ...form.values, increment_value: form.inputs.increment_value.value.trim() });

  let preview = null;   // last preview response
  let sentFor = null;   // the inputs that preview was made for
  const table = h('table', { class: 'grid' });
  const wrap = h('div', { class: 'grid-wrap', style: 'max-height:60vh' }, table);
  const foot = h('div', { class: 'grid-foot' });
  const btnPreview = h('button', { class: 'btn', type: 'button', onclick: () => runPreview() }, 'Preview ', h('kbd', null, 'F7'));
  const btnApply = h('button', { class: 'btn primary', type: 'button', disabled: true, onclick: () => apply() }, 'Confirm & Apply ', h('kbd', null, 'F10'));

  function invalidate() {
    if (!preview) return;
    preview = null;
    btnApply.disabled = true;
    render();
    foot.replaceChildren(h('span', { class: 'badge warn' }, 'Inputs changed — press Preview again.'));
  }

  function ticked() {
    return [...table.querySelectorAll('input[data-emp]:checked')].map((c) => Number(c.dataset.emp));
  }

  function summary() {
    if (!preview) return;
    const ids = new Set(ticked());
    let o = 0, n = 0;
    for (const r of preview.rows) {
      if (ids.has(r.employee_id)) { o += Math.round(Number(r.old_salary) * 100); n += Math.round(Number(r.new_salary) * 100); }
    }
    const blocked = preview.rows.filter((r) => r.error).length;
    foot.replaceChildren(
      h('span', null, `${ids.size} of ${preview.rows.length} employee(s) ticked`),
      blocked ? h('span', { class: 'badge warn' }, `${blocked} cannot be included (see reason)`) : '',
      h('span', null, `Old total ${money(o / 100)} → New total ${money(n / 100)} (${change(o / 100, n / 100)})`),
      h('span', { class: 'spacer' }), statusBadge(preview.status),
    );
    btnApply.disabled = ids.size === 0;
  }

  function render() {
    const rows = preview?.rows || [];
    const all = h('input', { type: 'checkbox', title: 'Tick / untick all', checked: true, onchange: () => {
      table.querySelectorAll('input[data-emp]:not(:disabled)').forEach((c) => { c.checked = all.checked; });
      summary();
    } });
    table.replaceChildren(
      h('thead', null, h('tr', null, h('th', { class: 'chk' }, all), h('th', null, 'Code'), h('th', null, 'Employee'), h('th', null, 'Department'),
        h('th', null, 'Type'), h('th', { class: 'num' }, 'Old Salary'), h('th', { class: 'num' }, 'New Salary'), h('th', { class: 'num' }, 'Change'), h('th', null, 'Note'))),
      h('tbody', null, rows.length ? rows.map((r) => h('tr', { class: r.error ? 'dim' : '' },
        h('td', { class: 'chk' }, h('input', { type: 'checkbox', checked: !r.error, disabled: !!r.error, dataset: { emp: r.employee_id }, onchange: summary })),
        h('td', null, r.code), h('td', null, r.name, h('small', { class: 'muted' }, ' · ' + r.designation)), h('td', null, r.department),
        h('td', null, TYPES[r.emp_type] + (r.emp_type === 'daily_wages' ? ' (/day)' : '')),
        h('td', { class: 'num' }, amt(r.old_salary)), h('td', { class: 'num' }, h('b', null, amt(r.new_salary))),
        h('td', { class: 'num' }, r.new_salary === null ? '' : change(r.old_salary, r.new_salary)),
        h('td', { style: 'color:var(--danger);font-size:12px;white-space:normal' }, r.error || '')))
        : h('tr', { class: 'empty' }, h('td', { colspan: 9 }, preview ? 'No active employees in this group.' : 'Choose the group and increment, then press Preview (F7). Untick employees to exclude them.'))),
    );
  }

  async function runPreview() {
    form.clearErrors();
    const v = values();
    try {
      preview = await post('increments/bulk/preview', v);
      sentFor = JSON.stringify(v);
      render();
      summary();
    } catch (e) {
      preview = null;
      render();
      form.showErrors(e.errors || {}, Object.keys(e.errors || {}).length ? '' : e.message);
    }
  }

  async function apply() {
    const v = values();
    if (!preview || JSON.stringify(v) !== sentFor) { toast('Inputs changed — press Preview again.', 'warn'); return; }
    const ids = ticked();
    if (!ids.length) return;
    const excluded = preview.rows.length - ids.length;
    const label = v.increment_type === 'percentage' ? `${v.increment_value}%` : `Rs ${money(v.increment_value)}`;
    if (!(await confirmDialog(`Apply a ${label} increment effective ${fdate(v.effective_date)} to ${ids.length} employee(s)`
      + (excluded ? ` (${excluded} excluded)` : '') + '?\nAll are saved together, or none if any one fails a rule.', { ok: 'Apply' }))) return;
    try {
      const r = await post('increments/bulk', { ...v, employee_ids: ids });
      toast(`${r.saved} increment(s) saved. New total ${money(r.totals.new)} (was ${money(r.totals.old)}).`, 'ok', 6000);
      await runPreview(); // now shows each employee's new rule state (duplicate date)
      btnApply.disabled = true;
    } catch (e) {
      toast(e.message, 'err', 10000);
    }
  }

  setKeys({ load: runPreview, save: () => !btnApply.disabled && apply() });
  render();
  root.append(
    h('div', { class: 'toolbar' }, btnPreview, btnApply, h('button', { class: 'btn', type: 'button', onclick: () => go('/increments') }, 'Single increment'),
      h('span', { class: 'spacer' }), h('span', { class: 'rec' }, 'Same date rules as a single increment · saved in one transaction')),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, form.el)),
    h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, wrap, foot)),
  );
  form.focus('scope_id');
}

export default {
  async mount(root, params, meta) {
    if (meta?.kind === 'bulk') return mountBulk(root);
    return mountSingle(root, params);
  },
};
