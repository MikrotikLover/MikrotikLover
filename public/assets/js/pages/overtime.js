// Overtime Approval: review OT candidates from attendance, edit approved hours, approve / reject in bulk.
import { get, post, del } from '../core/api.js';
import { h, toast, modal, confirmDialog, fdate, openReport, today } from '../core/dom.js';
import { EmployeePicker } from '../core/emppicker.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { can, opt, session } from '../core/store.js';
import { hm } from './attendance-voucher.js';

const parseHm = (s) => {
  s = String(s ?? '').trim();
  if (s === '') return 0;
  if (/^\d+:\d{1,2}$/.test(s)) { const [a, b] = s.split(':').map(Number); return b < 60 ? a * 60 + b : NaN; }
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 60); // decimal hours
  return NaN;
};

export default {
  async mount(root) {
    const canDecide = can('overtime', 'post');
    const st = { rows: [], dirty: new Set() };
    const filters = new Form([
      { name: 'from', label: 'From', type: 'date', span: 2 },
      { name: 'to', label: 'To', type: 'date', span: 2 },
      { name: 'department_id', label: 'Department', type: 'select', span: 3, numeric: true, options: () => opt.departments(true), blankLabel: 'All' },
      { name: 'status', label: 'Status', type: 'select', span: 2, blankLabel: 'All',
        options: [{ value: 'pending', label: 'Pending' }, { value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }] },
    ]);
    filters.values = { from: today().slice(0, 8) + '01', to: today(), status: 'pending' };
    const all = h('input', { type: 'checkbox', title: 'Select all', onchange: () => tbody.querySelectorAll('input.sel:not(:disabled)').forEach((c) => { c.checked = all.checked; }) });
    const tbody = h('tbody');
    const totals = h('span');

    function render() {
      tbody.replaceChildren(...st.rows.map((r) => {
        const locked = !!r.salary_sheet_id || !canDecide;
        const sel = h('input', { type: 'checkbox', class: 'sel', disabled: locked });
        const status = h('select', { disabled: locked }, ['pending', 'approved', 'rejected'].map((s) => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
        status.value = r.status;
        const appr = h('input', { value: hm(r.approved_minutes), class: 'num', style: 'width:70px', disabled: locked, title: 'h:mm or decimal hours' });
        const rem = h('input', { value: r.remarks || '', disabled: locked, maxlength: 255 });
        const tr = h('tr', { class: `ot-${r.status}` },
          h('td', { class: 'act' }, sel),
          h('td', null, fdate(r.ot_date)), h('td', null, r.code), h('td', null, r.name), h('td', null, r.department),
          h('td', null, r.shift_code || ''),
          h('td', null, r.time_in ? r.time_in.slice(11, 16) : ''), h('td', null, r.time_out ? r.time_out.slice(11, 16) + (r.time_out.slice(0, 10) !== r.ot_date ? ' +1' : '') : ''),
          h('td', null, r.att_status || ''),
          h('td', { class: 'num' }, Number(r.is_manual) ? h('span', { class: 'badge', title: 'Manual entry: ' + (r.remarks || '') }, 'manual ' + hm(r.computed_minutes)) : hm(r.computed_minutes)),
          h('td', null, appr), h('td', null, status), h('td', null, rem),
          h('td', { class: 'muted', style: 'font-size:11px' }, r.salary_sheet_id ? 'Paid' : (r.approved_by_name || '')),
          h('td', { class: 'act' }, !r.salary_sheet_id && Number(r.is_manual) && can('overtime', 'delete')
            ? h('button', { class: 'rm', type: 'button', title: 'Delete manual entry', onclick: () => remove(r) }, '×') : ''));
        const mark = () => { st.dirty.add(r.id); tr.classList.add('dirty'); };
        appr.addEventListener('change', () => {
          const m = parseHm(appr.value);
          if (Number.isNaN(m) || m > 960) { toast('Enter hours as h:mm or decimal (max 16 h).', 'err'); appr.value = hm(r.approved_minutes); return; }
          if (m > Number(r.computed_minutes)) { toast(`Approved time can only be lowered (max ${hm(r.computed_minutes)}).`, 'err'); appr.value = hm(r.approved_minutes); return; }
          r.approved_minutes = m; appr.value = hm(m); mark();
        });
        status.addEventListener('change', () => { r.status = status.value; tr.className = `ot-${r.status} dirty`; mark(); });
        rem.addEventListener('change', () => { r.remarks = rem.value; mark(); });
        r.el = { sel, status, tr };
        return tr;
      }));
      if (!st.rows.length) tbody.append(h('tr', null, h('td', { colspan: 15, class: 'muted', style: 'padding:20px;text-align:center' }, 'No overtime for these filters.')));
      const sum = (k, f = () => true) => st.rows.filter(f).reduce((a, r) => a + Number(r[k] || 0), 0);
      totals.textContent = `${st.rows.length} row(s) · computed ${hm(sum('computed_minutes'))} h · approved ${hm(sum('approved_minutes', (r) => r.status === 'approved'))} h`;
      all.checked = false;
    }

    async function load() {
      if (st.dirty.size && !(await confirmDialog('Discard unsaved overtime changes?', { ok: 'Discard', danger: true }))) return;
      st.rows = await get('overtime', filters.values);
      st.dirty.clear();
      render();
    }

    async function send(items, msg) {
      if (!items.length) { toast('Nothing to save.', 'warn'); return; }
      try {
        const r = await post('overtime/decide', { items });
        toast(`${msg} (${r.updated} row(s)).`);
        st.dirty.clear();
        await load();
      } catch (e) { toast(e.message, 'err', 8000); }
    }
    const item = (r, status) => ({ id: r.id, status: status ?? r.status, approved_minutes: status === 'rejected' ? 0 : r.approved_minutes, remarks: r.remarks || null });
    const save = () => send(st.rows.filter((r) => st.dirty.has(r.id)).map((r) => item(r)), 'Overtime saved');
    const bulk = (status) => {
      const rows = st.rows.filter((r) => r.el?.sel.checked);
      if (!rows.length) { toast('Tick the rows first (or use the header box to select all).', 'warn'); return; }
      send(rows.map((r) => item(r, status)), status === 'approved' ? 'Approved' : 'Rejected');
    };

    async function remove(r) {
      if (!(await confirmDialog(`Delete manual overtime of ${r.code} on ${fdate(r.ot_date)}?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`overtime/${r.id}`); toast('Deleted.'); st.dirty.delete(r.id); await load(); } catch (e) { toast(e.message, 'err', 6000); }
    }

    function addManual() {
      const picker = new EmployeePicker({ label: 'Employee', required: true, span: 12 });
      const f = new Form([
        { name: 'ot_date', label: 'Date', type: 'date', required: true, span: 4 },
        { name: 'hours', label: 'OT hours (h:mm)', required: true, span: 4, placeholder: '2:30' },
        { name: 'remarks', label: 'Reason', required: true, span: 12, maxlength: 255 },
      ]);
      f.values = { ot_date: today() };
      modal({
        title: 'Manual overtime entry', wide: false,
        body: h('div', null, h('div', { class: 'form-grid', style: 'margin-bottom:8px' }, picker.el), f.el,
          h('p', { class: 'muted', style: 'font-size:12px' }, 'Administrator only. Only for days the employee was present; a reason is required. It is created as Pending and can only be approved for these hours or less.')),
        buttons: [{ label: 'Cancel' }, { label: 'Add (F10)', class: 'primary', onClick: async () => {
          const v = f.values;
          const m = parseHm(v.hours);
          if (!picker.value) { picker.error('Select an employee.'); return false; }
          if (Number.isNaN(m) || m <= 0) { f.showErrors({ hours: 'Enter hours as h:mm.' }); return false; }
          try {
            await post('overtime', { employee_id: picker.value, ot_date: v.ot_date, approved_minutes: m, remarks: v.remarks });
            toast('Overtime added.'); await load(); return true;
          } catch (e) { f.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); return false; }
        } }],
      });
      setTimeout(() => picker.focus(), 50);
    }

    const print = () => openReport('overtime', { ...filters.values, mode: 'detail' });
    const isAdmin = Number(session.user?.is_admin) === 1;
    setKeys({ load, save, print, new: () => isAdmin && addManual() });

    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Show ', h('kbd', null, 'F7')),
        h('button', { class: 'btn primary', type: 'button', disabled: !canDecide, onclick: save }, 'Save changes ', h('kbd', null, 'F10')),
        h('span', { class: 'sep' }),
        h('button', { class: 'btn', type: 'button', disabled: !canDecide, onclick: () => bulk('approved') }, '✔ Approve selected'),
        h('button', { class: 'btn danger', type: 'button', disabled: !canDecide, onclick: () => bulk('rejected') }, '✖ Reject selected'),
        h('span', { class: 'sep' }),
        h('button', { class: 'btn', type: 'button', disabled: !isAdmin, title: isAdmin ? '' : 'Administrator only', onclick: addManual }, 'Manual OT ', h('kbd', null, 'F5')),
        h('button', { class: 'btn', type: 'button', onclick: print }, 'Print ', h('kbd', null, 'F9')),
        h('span', { class: 'spacer' }), totals),
      h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-body' }, filters.el)),
      h('div', { style: 'overflow:auto;background:#fff;border:1px solid var(--line);border-radius:6px;max-height:calc(100vh - 300px)' },
        h('table', { class: 'egrid att ot' },
          h('thead', null, h('tr', null, h('th', null, all), ...['Date', 'Code', 'Name', 'Department', 'Shift', 'In', 'Out', 'Att.', 'Computed', 'Approved', 'Status', 'Remarks', 'By', ''].map((t) => h('th', null, t)))),
          tbody)),
      h('div', { class: 'grid-foot' }, 'Approved hours accept h:mm (2:30) or decimals (2.5). Only approved OT is paid in the salary sheet. Paid rows are locked.'),
    );
    filters.el.addEventListener('change', load);
    await load();
    return { canLeave: () => st.dirty.size === 0 };
  },
};
