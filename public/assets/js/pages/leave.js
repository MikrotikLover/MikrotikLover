// Employee Leave Register: apply (pending) -> approve / reject / cancel, with yearly balance per leave type.
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, fdate, openReport, debounce, today } from '../core/dom.js';
import { EmployeePicker } from '../core/emppicker.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can } from '../core/store.js';

const BADGE = { pending: 'warn', approved: 'ok', rejected: 'off', cancelled: '' };

export default {
  async mount(root) {
    const st = { current: null, types: [] };
    st.types = await get('leave-types', { active: 1 });

    // ---------- list
    const year = h('select', { class: 'input', style: 'width:100px' },
      Array.from({ length: 5 }, (_, i) => Number(today().slice(0, 4)) - 2 + i).map((y) => h('option', { value: y }, y)));
    year.value = today().slice(0, 4);
    const statusF = h('select', { class: 'input', style: 'width:130px' }, h('option', { value: '' }, 'All status'),
      ['pending', 'approved', 'rejected', 'cancelled'].map((s) => h('option', { value: s }, s[0].toUpperCase() + s.slice(1))));
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search code / name (F1)', style: 'flex:1;min-width:160px' });
    const grid = new DataGrid({
      columns: [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
        { key: 'type_code', label: 'Type' },
        { key: 'from_date', label: 'From', render: (r) => fdate(r.from_date) },
        { key: 'to_date', label: 'To', render: (r) => fdate(r.to_date) },
        { key: 'days', label: 'Days', align: 'right', render: (r) => Number(r.days) },
        { key: 'status', label: 'Status', render: (r) => h('span', { class: 'badge ' + BADGE[r.status] }, r.status) },
      ],
      onSelect: (r) => setRecord(r),
      onOpen: () => typeSel.focus(),
      emptyText: 'No leave applications.',
    });
    async function loadList(keep) {
      const rows = await get('leaves', { year: year.value, status: statusF.value, q: q.value.trim() });
      grid.setRows(rows);
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    [year, statusF].forEach((x) => x.addEventListener('change', () => loadList()));
    q.addEventListener('input', debounce(() => loadList(), 250));

    // ---------- form
    const picker = new EmployeePicker({ label: 'Employee', required: true, span: 12, onChange: (e) => loadBalance(e?.id) });
    const form = new Form([
      { name: 'leave_type_id', label: 'Leave type', type: 'select', required: true, blank: true, numeric: true, span: 6,
        options: () => st.types.map((t) => ({ value: t.id, label: `${t.code} - ${t.name}${Number(t.is_paid) ? '' : ' (unpaid)'}` })) },
      { name: 'status_view', label: 'Status', type: 'static', span: 6 },
      { name: 'from_date', label: 'From', type: 'date', required: true, span: 6 },
      { name: 'to_date', label: 'To', type: 'date', required: true, span: 6 },
      { name: 'reason', label: 'Reason', span: 12, maxlength: 255 },
    ]);
    const typeSel = form.inputs.leave_type_id;
    form.inputs.from_date.addEventListener('change', () => { if (!form.get('to_date') || form.get('to_date') < form.get('from_date')) form.set('to_date', form.get('from_date')); });
    const balanceBox = h('div');
    const recLabel = h('span', { class: 'rec' });
    const info = h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' });

    async function loadBalance(empId) {
      if (!empId) { balanceBox.replaceChildren(); return; }
      const rows = await get('leaves/balance', { employee_id: empId, year: (form.get('from_date') || today()).slice(0, 4) });
      balanceBox.replaceChildren(h('table', { class: 'grid', style: 'margin-top:10px' },
        h('thead', null, h('tr', null, ['Type', 'Quota', 'Used', 'Pending', 'Balance'].map((t, i) => h('th', { class: i ? 'num' : '' }, t)))),
        h('tbody', null, rows.map((r) => {
          const quota = Number(r.yearly_quota);
          return h('tr', null, h('td', null, `${r.code} - ${r.name}`), h('td', { class: 'num' }, Number(r.is_paid) && quota ? quota : '—'),
            h('td', { class: 'num' }, Number(r.used)), h('td', { class: 'num' }, Number(r.pending)),
            h('td', { class: 'num' }, Number(r.is_paid) && quota ? h('b', null, quota - Number(r.used) - Number(r.pending)) : '—'));
        }))));
    }

    const btn = (label, cls, fn, key) => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label, key ? h('kbd', null, key) : null);
    const btnSave = btn('Save ', 'primary', () => save(), 'F10');
    const btnDel = btn('Delete ', 'danger', () => remove(), 'F12');
    const btnApprove = btn('✔ Approve', '', () => setStatus('approved'));
    const btnReject = btn('✖ Reject', 'danger', () => setStatus('rejected'));
    const btnCancel = btn('Cancel leave', '', () => setStatus('cancelled'));

    function setRecord(r) {
      st.current = r;
      picker.set(r ? { id: r.employee_id, code: r.code, name: r.name, department: r.department } : null);
      form.values = r ? { ...r, status_view: r.status[0].toUpperCase() + r.status.slice(1) } : { from_date: today(), to_date: today(), status_view: 'New' };
      const pending = !r || r.status === 'pending';
      const editable = pending && can('leave', r ? 'edit' : 'add');
      form.setReadonly(!editable);
      picker.setReadonly(!editable || !!r);
      btnSave.disabled = !editable;
      btnDel.disabled = !r || r.status === 'approved' || !can('leave', 'delete');
      btnApprove.disabled = btnReject.disabled = !r || r.status !== 'pending' || !can('leave', 'post');
      btnCancel.disabled = !r || !['pending', 'approved'].includes(r.status) || !can('leave', 'post');
      recLabel.textContent = r ? `${r.code} ${r.name} · ${r.type_name}` : 'New application';
      info.textContent = r ? `${Number(r.days)} working day(s)${r.approved_by_name ? ' · decided by ' + r.approved_by_name : ''}` : 'Days are counted on working days only (rest days and holidays are excluded).';
      loadBalance(r?.employee_id);
    }

    async function save(approve = false) {
      if (btnSave.disabled) return;
      if (!picker.value) { picker.error('Select an employee.'); picker.focus(); return; }
      const v = form.values;
      const body = { employee_id: picker.value, leave_type_id: v.leave_type_id, from_date: v.from_date, to_date: v.to_date, reason: v.reason, approve };
      try {
        const r = st.current ? await put(`leaves/${st.current.id}`, body) : await post('leaves', body);
        toast(`Leave saved (${Number(r.days)} day(s), ${r.status}).`);
        await loadList(r.id);
        setRecord({ ...r, ...(grid.current() || {}) });
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); }
    }

    async function setStatus(s) {
      const r = st.current;
      if (!r) return;
      const words = { approved: 'Approve', rejected: 'Reject', cancelled: 'Cancel' };
      if (!(await confirmDialog(`${words[s]} ${r.type_name} of ${r.code} ${r.name} (${fdate(r.from_date)} – ${fdate(r.to_date)})?${s === 'approved' ? '\nAttendance on these working days will be marked ' + (Number(r.is_paid) ? 'L' : 'LW') + '.' : ''}`, { ok: words[s], danger: s !== 'approved' }))) return;
      try {
        await post(`leaves/${r.id}/status`, { status: s });
        toast(`Leave ${s}.`);
        await loadList(r.id);
        setRecord(grid.current());
      } catch (e) { toast(e.message, 'err', 8000); }
    }

    async function remove() {
      if (!st.current || btnDel.disabled) return;
      if (!(await confirmDialog('Delete this leave application?', { ok: 'Delete', danger: true }))) return;
      try { await del(`leaves/${st.current.id}`); toast('Deleted.'); setRecord(null); await loadList(); } catch (e) { toast(e.message, 'err', 6000); }
    }

    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); picker.focus(); };
    setKeys({
      new: newRec, save: () => save(false), del: remove, search: () => q.focus(), load: () => loadList(st.current?.id),
      print: () => openReport('leave_register', { year: year.value, status: statusF.value }),
    });

    root.append(
      h('div', { class: 'toolbar' },
        btn('New ', '', newRec, 'F5'), btnSave, btnDel, h('span', { class: 'sep' }), btnApprove, btnReject, btnCancel,
        h('span', { class: 'sep' }), btn('Print ', '', () => openReport('leave_register', { year: year.value, status: statusF.value }), 'F9'),
        h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md' },
        h('div', null, h('div', { class: 'filters' }, q, year, statusF), grid.el),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Leave application')),
          h('div', { class: 'panel-body' }, h('div', { class: 'form-grid', style: 'margin-bottom:8px' }, picker.el), form.el, info,
            can('leave', 'add') && can('leave', 'post') ? h('div', { style: 'margin-top:8px' }, h('button', { class: 'btn', type: 'button', onclick: () => save(true) }, 'Save & approve')) : null,
            balanceBox))),
    );
    setRecord(null);
    await loadList();
    return { canLeave: () => !form.dirty };
  },
};
