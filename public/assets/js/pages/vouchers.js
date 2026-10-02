// Employee vouchers: Advance (ADV), Incentive (INC), Penalty (PEN), Overtime (OT).
// List on the left, voucher form on the right. Draft -> Post (locked) -> Unpost while not used in a salary.
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, money, fdate, openReport, debounce, today } from '../core/dom.js';
import { EmployeePicker } from '../core/emppicker.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups } from '../core/store.js';

export const CFG = {
  adv: { type: 'ADV', title: 'Employee Advance', monthLabel: 'Deduct from salary of', help: 'Deducted in full from this month\'s salary.', report: 'Advance Salary Report' },
  inc: { type: 'INC', title: 'Incentive', monthLabel: 'Pay with salary of', help: 'Added to this month\'s salary.', report: 'Incentive Report' },
  pen: { type: 'PEN', title: 'Penalty', monthLabel: 'Deduct from salary of', help: 'Deducted from this month\'s salary.', report: 'Penalty Report' },
  ot: { type: 'OT', title: 'Overtime Voucher', monthLabel: 'Pay with salary of', help: 'Hours are paid at the employee\'s OT rate; or enter a fixed amount.', report: 'Overtime Voucher Report' },
};

export const statusBadge = (r) => h('span', { class: 'badge ' + (r.salary_sheet_id ? 'info' : r.status === 'posted' ? 'ok' : 'warn') },
  r.salary_sheet_id ? 'in salary' : r.status);

/** Cash / bank accounts an advance or loan can be paid from. */
export const payAccounts = () => lookups.accounts
  .filter((a) => a.account_type === 'asset' && Number(a.is_active) && !['employee_advances', 'employee_loans'].includes(a.system_key))
  .map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }));

export default {
  async mount(root, params) {
    const cfg = CFG[params.type];
    if (!cfg) { root.append(h('div', { class: 'panel panel-body' }, 'Unknown voucher type.')); return; }
    const heading = document.querySelector('.top h1');
    if (heading) heading.textContent = cfg.type === 'OT' ? cfg.title : `${cfg.title} Voucher`;
    document.title = `${heading?.textContent || cfg.title} · ${window.APP.name}`;
    const ep = `vouchers/${params.type}`;
    const st = { current: null, rows: [] };
    const isOT = cfg.type === 'OT';

    // ---------- list
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search code / name / Vr# (F1)', style: 'flex:1;min-width:150px' });
    const monthF = h('input', { class: 'input', type: 'month', value: today().slice(0, 7), style: 'width:150px', title: 'Salary month' });
    const statusF = h('select', { class: 'input', style: 'width:110px' }, h('option', { value: '' }, 'All'), h('option', { value: 'draft' }, 'Draft'), h('option', { value: 'posted' }, 'Posted'));
    const total = h('span');
    const grid = new DataGrid({
      columns: [
        { key: 'number', label: 'Vr#' },
        { key: 'vr_date', label: 'Date', render: (r) => fdate(r.vr_date) },
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
        ...(isOT ? [{ key: 'ot_hours', label: 'Hours', align: 'right', render: (r) => (Number(r.ot_hours) ? Number(r.ot_hours) : '') }] : []),
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
        { key: 'status', label: 'Status', render: statusBadge },
      ],
      onSelect: (r) => open(r.id),
      onOpen: () => form.focus('amount'),
      emptyText: 'No vouchers for this month.',
    });
    async function loadList(keep) {
      st.rows = await get(ep, { q: q.value.trim(), month: monthF.value, status: statusF.value });
      grid.setRows(st.rows);
      total.textContent = `${st.rows.length} voucher(s) · Rs ${money(st.rows.reduce((a, r) => a + Number(r.amount), 0))}`;
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    q.addEventListener('input', debounce(() => loadList(), 250));
    [monthF, statusF].forEach((x) => x.addEventListener('change', () => loadList()));

    // ---------- form
    const picker = new EmployeePicker({ label: 'Employee', required: true, span: 12 });
    const fields = [
      { name: 'number', label: 'Vr#', type: 'static', span: 3 },
      { name: 'status_view', label: 'Status', type: 'static', span: 3 },
      { name: 'vr_date', label: 'Date', type: 'date', required: true, span: 3 },
      { name: 'deduct_month', label: cfg.monthLabel, type: 'month', required: true, span: 3, help: cfg.help },
      ...(isOT ? [{ name: 'ot_hours', label: 'OT hours', type: 'number', span: 3, min: 0, step: '0.25' }] : []),
      { name: 'amount', label: isOT ? 'Fixed amount (optional)' : 'Amount (Rs)', type: 'number', required: !isOT, span: 3, min: isOT ? 0 : 1, step: 1 },
      ...(cfg.type === 'ADV' ? [{ name: 'pay_account_id', label: 'Paid from', type: 'select', numeric: true, required: true, span: 4, options: payAccounts }] : []),
      { name: 'remarks', label: 'Remarks', span: 12, maxlength: 255 },
    ];
    const form = new Form(fields);
    const lockInfo = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
    const recLabel = h('span', { class: 'rec' });
    const B = (label, cls, fn, key) => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label, key ? h('kbd', null, key) : null);
    const btnSave = B('Save ', 'primary', () => save(false), 'F10');
    const btnSavePost = B('Save & Post', '', () => save(true));
    const btnPost = B('✔ Post', '', () => postIt());
    const btnUnpost = B('Unpost', '', () => unpostIt());
    const btnDel = B('Delete ', 'danger', () => remove(), 'F12');
    const btnPrint = B('Print ', '', () => st.current && openReport('voucher', { id: st.current.id }), 'F9');

    function setRecord(v) {
      st.current = v;
      const draft = !v || v.status === 'draft';
      picker.set(v ? { id: v.employee_id, code: v.code, name: v.name, department: v.department } : null);
      const cash = lookups.accounts.find((a) => a.system_key === 'cash')?.id;
      form.values = v
        ? { ...v, deduct_month: v.deduct_month?.slice(0, 7), status_view: v.salary_sheet_id ? 'Used in salary' : v.status === 'posted' ? 'Posted' : 'Draft', amount: Number(v.amount), ot_hours: v.ot_hours === null ? null : Number(v.ot_hours) }
        : { number: '(new)', status_view: 'Draft', vr_date: today(), deduct_month: monthF.value || today().slice(0, 7), pay_account_id: cash, amount: isOT ? 0 : null };
      const editable = draft && can('vouchers', v ? 'edit' : 'add');
      form.setReadonly(!editable);
      picker.setReadonly(!editable);
      btnSave.disabled = !editable;
      btnSavePost.disabled = !editable || !can('vouchers', 'post');
      btnPost.disabled = !v || !draft || !can('vouchers', 'post');
      btnUnpost.disabled = !v || draft || !!v.locked_reason || !can('vouchers', 'post');
      btnDel.disabled = !v || !can('vouchers', 'delete') || (!draft && !!v.locked_reason);
      btnPrint.disabled = !v;
      recLabel.textContent = v ? `${v.number} · ${v.code} ${v.name}` : `New ${cfg.title.toLowerCase()}`;
      lockInfo.textContent = v
        ? (v.status === 'posted' ? `Posted by ${v.posted_by_name || '-'} on ${fdate(v.posted_at)}.` + (v.locked_reason ? ` Locked: ${v.locked_reason}` : ' Unpost to edit.') : `Draft — not yet considered by payroll. Created by ${v.created_by_name || '-'}.`)
        : 'Save as draft, then Post. Only posted vouchers are picked up by the salary sheet.';
    }

    async function open(id) {
      if (st.current?.id === id) return;
      if (form.dirty && !(await confirmDialog('Discard unsaved changes?', { ok: 'Discard', danger: true }))) { grid.selectBy((r) => r.id === st.current?.id, false); return; }
      setRecord(await get(`${ep}/${id}`));
    }

    async function save(andPost) {
      if (btnSave.disabled) return;
      if (!picker.value) { picker.error('Select an employee.'); picker.focus(); return; }
      const v = form.values;
      const body = { vr_date: v.vr_date, employee_id: picker.value, deduct_month: v.deduct_month, amount: v.amount ?? 0, remarks: v.remarks, post: andPost };
      if (isOT) body.ot_hours = v.ot_hours ?? 0;
      if (cfg.type === 'ADV') body.pay_account_id = v.pay_account_id;
      try {
        const r = st.current ? await put(`${ep}/${st.current.id}`, body) : await post(ep, body);
        toast(`${r.number} ${andPost ? 'saved and posted' : 'saved as draft'}.`);
        form.dirty = false;
        setRecord(r);
        await loadList(r.id);
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); if (e.errors?.employee_id) picker.error(e.errors.employee_id); }
    }
    async function postIt() {
      if (!st.current || btnPost.disabled) return;
      try { setRecord(await post(`voucher-actions/${st.current.id}/post`)); toast('Posted.'); await loadList(st.current.id); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function unpostIt() {
      if (!st.current || btnUnpost.disabled) return;
      if (!(await confirmDialog(`Unpost ${st.current.number}? It becomes a draft again.`, { ok: 'Unpost' }))) return;
      try { setRecord(await post(`voucher-actions/${st.current.id}/unpost`)); toast('Unposted.'); await loadList(st.current.id); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function remove() {
      if (!st.current || btnDel.disabled) return;
      const posted = st.current.status === 'posted';
      if (!(await confirmDialog(`Delete ${st.current.number}?${posted ? '\nPosted vouchers are kept in the audit trail (soft delete).' : ''}`, { ok: 'Delete', danger: true }))) return;
      try { await del(`voucher-actions/${st.current.id}`); toast('Deleted.'); setRecord(null); await loadList(); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function step(dir) {
      const v = await get(`voucher-nav/${cfg.type}`, { vr_no: st.current?.vr_no || 0, dir: dir < 0 ? 'prev' : 'next' });
      if (!v) { toast(dir < 0 ? 'First voucher.' : 'Last voucher.', 'warn'); return; }
      form.dirty = false;
      setRecord(v);
      grid.selectBy((r) => r.id === v.id, false);
    }
    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); picker.focus(); };
    const printList = () => openReport('vouchers', { type: cfg.type, month: monthF.value, status: statusF.value });

    setKeys({ new: newRec, save: () => save(false), del: remove, print: () => (st.current ? openReport('voucher', { id: st.current.id }) : printList()),
      search: () => q.focus(), load: () => loadList(st.current?.id), prev: () => step(-1), next: () => step(1) });

    root.append(
      h('div', { class: 'toolbar' },
        B('New ', '', newRec, 'F5'), btnSave, btnSavePost, btnPost, btnUnpost, btnDel, h('span', { class: 'sep' }),
        B('◀', 'icon', () => step(-1)), B('▶', 'icon', () => step(1)), btnPrint, B('List report', '', printList),
        h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md' },
        h('div', null, h('div', { class: 'filters' }, q, monthF, statusF), grid.el, h('div', { class: 'grid-foot' }, total)),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, cfg.title + ' voucher')),
          h('div', { class: 'panel-body' }, h('div', { class: 'form-grid', style: 'margin-bottom:8px' }, picker.el), form.el, lockInfo))),
    );
    setRecord(null);
    await loadList();
    picker.focus();
    return { canLeave: () => !form.dirty };
  },
};
