// Loan Voucher: amount, monthly installment, first deduction month -> schedule. Installments can be
// skipped or adjusted (balance re-spread over later months). Outstanding balance per loan.
import { get, post, put, del } from '../core/api.js';
import { h, toast, modal, confirmDialog, money, fdate, openReport, debounce, today } from '../core/dom.js';
import { EmployeePicker } from '../core/emppicker.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups } from '../core/store.js';
import { payAccounts } from './vouchers.js';

const ym = (d) => (d ? new Date(d.slice(0, 7) + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) : '');
const BADGE = { scheduled: '', deducted: 'ok', skipped: 'warn', adjusted: 'info' };

export default {
  async mount(root) {
    const st = { current: null };

    // ---------- list
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search code / name (F1)', style: 'flex:1;min-width:150px' });
    const statusF = h('select', { class: 'input', style: 'width:120px' }, h('option', { value: 'active' }, 'Active'), h('option', { value: 'closed' }, 'Closed'), h('option', { value: '' }, 'All'));
    const total = h('span');
    const grid = new DataGrid({
      columns: [
        { key: 'number', label: 'Vr#' }, { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' },
        { key: 'amount', label: 'Loan', align: 'right', render: (r) => money(r.amount) },
        { key: 'balance', label: 'Balance', align: 'right', render: (r) => h('b', null, money(r.balance)) },
        { key: 'next_month', label: 'Next', render: (r) => ym(r.next_month) },
        { key: 'voucher_status', label: 'Vr', render: (r) => h('span', { class: 'badge ' + (r.voucher_status === 'posted' ? 'ok' : 'warn') }, r.voucher_status) },
      ],
      onSelect: (r) => open(r.voucher_id),
      emptyText: 'No loans.',
    });
    async function loadList(keep) {
      const rows = await get('loans', { q: q.value.trim(), status: statusF.value });
      grid.setRows(rows.map((r) => ({ ...r, id: r.voucher_id })));
      total.textContent = `${rows.length} loan(s) · outstanding Rs ${money(rows.reduce((a, r) => a + (r.voucher_status === 'posted' ? Number(r.balance) : 0), 0))}`;
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    q.addEventListener('input', debounce(() => loadList(), 250));
    statusF.addEventListener('change', () => loadList());

    // ---------- form
    const picker = new EmployeePicker({ label: 'Employee', required: true, span: 12 });
    const form = new Form([
      { name: 'number', label: 'Vr#', type: 'static', span: 3 },
      { name: 'status_view', label: 'Status', type: 'static', span: 3 },
      { name: 'vr_date', label: 'Date', type: 'date', required: true, span: 3 },
      { name: 'start_month', label: 'First deduction month', type: 'month', required: true, span: 3 },
      { name: 'amount', label: 'Loan amount (Rs)', type: 'number', required: true, span: 3, min: 1, step: 1 },
      { name: 'installment', label: 'Monthly installment', type: 'number', required: true, span: 3, min: 1, step: 1 },
      { name: 'preview', label: 'Repayment', type: 'static', span: 6 },
      { name: 'pay_account_id', label: 'Paid from', type: 'select', numeric: true, required: true, span: 6, options: payAccounts },
      { name: 'remarks', label: 'Remarks', span: 6, maxlength: 255 },
    ], { onChange: () => preview() });
    form.el.addEventListener('input', () => preview());
    function preview() {
      const v = form.values;
      if (!v.amount || !v.installment || v.installment > v.amount) { form.inputs.preview.textContent = ''; return; }
      const n = Math.ceil(v.amount / v.installment);
      const last = v.amount - v.installment * (n - 1);
      form.inputs.preview.textContent = `${n} installment(s)${last !== v.installment ? `, last Rs ${money(last)}` : ''}`;
    }
    const summary = h('div', { class: 'stat-cards' });
    const sched = h('tbody');
    const schedBox = h('div', { style: 'margin-top:12px' },
      h('div', { class: 'form-section', style: 'margin-bottom:6px' }, 'Installment schedule'),
      h('table', { class: 'grid' }, h('thead', null, h('tr', null, ['Month', 'Planned', 'Deducted', 'Status', 'Remarks', ''].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'num' : '' }, t)))), sched),
      h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'Skip moves the installment to the end; Adjust changes one month and re-spreads the balance. Deducted months are locked.'));
    const journalBox = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
    const recLabel = h('span', { class: 'rec' });
    const B = (label, cls, fn, key) => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label, key ? h('kbd', null, key) : null);
    const btnSave = B('Save ', 'primary', () => save(false), 'F10');
    const btnSavePost = B('Save & Post', '', () => save(true));
    const btnPost = B('✔ Post', '', () => action('post'));
    const btnUnpost = B('Unpost', '', () => action('unpost'));
    const btnDel = B('Delete ', 'danger', () => remove(), 'F12');
    const btnPrint = B('Print ', '', () => st.current && openReport('voucher', { id: st.current.id }), 'F9');

    function renderSchedule(v) {
      const canEdit = can('loans', 'edit');
      sched.replaceChildren(...(v?.installments || []).map((i) => h('tr', null,
        h('td', null, ym(i.due_month)),
        h('td', { class: 'num' }, i.status === 'skipped' ? '—' : money(i.scheduled_amount)),
        h('td', { class: 'num' }, Number(i.deducted_amount) ? money(i.deducted_amount) : ''),
        h('td', null, h('span', { class: 'badge ' + BADGE[i.status] }, i.status)),
        h('td', { class: 'muted' }, i.remarks || ''),
        h('td', { style: 'text-align:right;white-space:nowrap' }, i.locked || !canEdit || v.status === 'draft' ? (i.locked ? '🔒' : '') : [
          i.status !== 'skipped' ? h('button', { class: 'btn sm', type: 'button', onclick: () => inst(i, 'skip') }, 'Skip') : null,
          h('button', { class: 'btn sm', type: 'button', onclick: () => adjust(i) }, 'Adjust'),
          i.status !== 'scheduled' ? h('button', { class: 'btn sm', type: 'button', onclick: () => inst(i, 'reset') }, 'Reset') : null,
        ]))));
      if (!v?.installments?.length) sched.append(h('tr', null, h('td', { colspan: 6, class: 'muted' }, 'The schedule is created when the loan is saved.')));
    }

    function setRecord(v) {
      st.current = v;
      const draft = !v || v.status === 'draft';
      picker.set(v ? { id: v.employee_id, code: v.code, name: v.name, department: v.department } : null);
      const cash = lookups.accounts.find((a) => a.system_key === 'cash')?.id;
      form.values = v
        ? { ...v, amount: Number(v.amount), installment: Number(v.loan.installment), start_month: v.loan.start_month.slice(0, 7),
          status_view: v.status === 'posted' ? (v.loan.status === 'closed' ? 'Posted · fully repaid' : 'Posted · active') : 'Draft' }
        : { number: '(new)', status_view: 'Draft', vr_date: today(), start_month: today().slice(0, 7), pay_account_id: cash };
      preview();
      const editable = draft && can('loans', v ? 'edit' : 'add');
      form.setReadonly(!editable);
      picker.setReadonly(!editable);
      btnSave.disabled = !editable;
      btnSavePost.disabled = !editable || !can('loans', 'post');
      btnPost.disabled = !v || !draft || !can('loans', 'post');
      btnUnpost.disabled = !v || draft || !!v.locked_reason || !can('loans', 'post');
      btnDel.disabled = !v || !can('loans', 'delete') || (!draft && !!v.locked_reason);
      btnPrint.disabled = !v;
      recLabel.textContent = v ? `${v.number} · ${v.code} ${v.name}` : 'New loan';
      const s = v?.loan;
      const card = (val, l) => h('div', { class: 'card' }, h('div', { class: 'v' }, val), h('div', { class: 'l' }, l));
      summary.replaceChildren(...(s ? [card(money(s.amount), 'Loan'), card(money(s.deducted), 'Deducted'), card(money(s.balance), 'Balance'),
        card(s.remaining_installments, 'Installments left'), card(ym(s.next_month) || '—', 'Next deduction')] : []));
      renderSchedule(v);
      journalBox.textContent = v?.journal?.length ? 'Posted entry: ' + v.journal.map((l) => `${Number(l.debit) ? 'Dr' : 'Cr'} ${l.account} ${money(Number(l.debit) || Number(l.credit))}`).join(' / ')
        : (v ? (v.locked_reason ? `Locked: ${v.locked_reason}` : 'Draft — the schedule is not used by payroll until posted.') : '');
    }

    async function open(id) {
      if (st.current?.id === id) return;
      if (form.dirty && !(await confirmDialog('Discard unsaved changes?', { ok: 'Discard', danger: true }))) return;
      setRecord(await get(`loans/${id}`));
    }
    async function save(andPost) {
      if (btnSave.disabled) return;
      if (!picker.value) { picker.error('Select an employee.'); picker.focus(); return; }
      const v = form.values;
      const body = { vr_date: v.vr_date, employee_id: picker.value, amount: v.amount, installment: v.installment, start_month: v.start_month,
        pay_account_id: v.pay_account_id, remarks: v.remarks, post: andPost };
      try {
        const r = st.current ? await put(`loans/${st.current.id}`, body) : await post('loans', body);
        toast(`${r.number} ${andPost ? 'saved and posted' : 'saved as draft'}.`);
        form.dirty = false;
        setRecord(r);
        await loadList(r.id);
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); }
    }
    async function action(kind) {
      if (!st.current) return;
      if (kind === 'unpost' && !(await confirmDialog(`Unpost ${st.current.number}?`, { ok: 'Unpost' }))) return;
      try { await post(`voucher-actions/${st.current.id}/${kind}`); toast(kind === 'post' ? 'Posted.' : 'Unposted.'); setRecord(await get(`loans/${st.current.id}`)); await loadList(st.current.id); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function remove() {
      if (!st.current || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete loan ${st.current.number}?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`voucher-actions/${st.current.id}`); toast('Deleted.'); setRecord(null); await loadList(); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function inst(i, kind, amount) {
      try { setRecord(await post(`loans/${st.current.id}/installments/${i.id}`, { action: kind, amount })); toast(`Installment ${{ skip: 'skipped', adjust: 'adjusted', reset: 'reset' }[kind]}.`); await loadList(st.current.id); }
      catch (e) { toast(e.message, 'err', 6000); return false; }
      return true;
    }
    function adjust(i) {
      const f = new Form([{ name: 'amount', label: `Installment for ${ym(i.due_month)} (Rs)`, type: 'number', required: true, span: 12, min: 1, step: 1 }]);
      f.values = { amount: Number(i.scheduled_amount) || Number(st.current.loan.installment) };
      modal({ title: 'Adjust installment', body: f.el, buttons: [{ label: 'Cancel' }, { label: 'Apply (F10)', class: 'primary', onClick: () => inst(i, 'adjust', f.get('amount')) }] });
    }
    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); picker.focus(); };
    setKeys({ new: newRec, save: () => save(false), del: remove, search: () => q.focus(), load: () => loadList(st.current?.id),
      print: () => (st.current ? openReport('voucher', { id: st.current.id }) : openReport('loans', { status: statusF.value })) });

    root.append(
      h('div', { class: 'toolbar' }, B('New ', '', newRec, 'F5'), btnSave, btnSavePost, btnPost, btnUnpost, btnDel, h('span', { class: 'sep' }),
        btnPrint, B('Loan report', '', () => openReport('loans', { status: statusF.value, detail: 1 })), h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md' },
        h('div', null, h('div', { class: 'filters' }, q, statusF), grid.el, h('div', { class: 'grid-foot' }, total)),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Loan voucher')),
          h('div', { class: 'panel-body' }, h('div', { class: 'form-grid', style: 'margin-bottom:8px' }, picker.el), form.el, summary, schedBox, journalBox))),
    );
    setRecord(null);
    await loadList();
    picker.focus();
    return { canLeave: () => !form.dirty };
  },
};
