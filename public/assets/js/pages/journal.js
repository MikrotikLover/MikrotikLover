// Journal Voucher: double-entry lines (account, employee, debit or credit, narration). Debit must equal credit.
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, money, fdate, openReport, debounce, today } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid, EditGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups } from '../core/store.js';
import { statusBadge } from './vouchers.js';

const fmt2 = (n) => Number(n || 0).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default {
  async mount(root) {
    const st = { current: null };
    const from = h('input', { class: 'input', type: 'date', value: today().slice(0, 8) + '01', style: 'width:150px' });
    const to = h('input', { class: 'input', type: 'date', value: today(), style: 'width:150px' });
    const q = h('input', { class: 'input', type: 'search', placeholder: 'Search narration / Vr# (F1)', style: 'flex:1;min-width:140px' });
    const grid = new DataGrid({
      columns: [
        { key: 'number', label: 'Vr#' }, { key: 'vr_date', label: 'Date', render: (r) => fdate(r.vr_date) },
        { key: 'remarks', label: 'Narration' },
        { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) },
        { key: 'status', label: 'Status', render: (r) => (Number(r.is_system) ? h('span', { class: 'badge info' }, 'system') : statusBadge(r)) },
      ],
      onSelect: (r) => open(r.id),
      emptyText: 'No journal vouchers in this period.',
    });
    async function loadList(keep) {
      grid.setRows(await get('journal', { from: from.value, to: to.value, q: q.value.trim() }));
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    [from, to].forEach((x) => x.addEventListener('change', () => loadList()));
    q.addEventListener('input', debounce(() => loadList(), 250));

    const form = new Form([
      { name: 'number', label: 'Vr#', type: 'static', span: 3 },
      { name: 'status_view', label: 'Status', type: 'static', span: 3 },
      { name: 'vr_date', label: 'Date', type: 'date', required: true, span: 3 },
      { name: 'remarks', label: 'Narration', span: 12, maxlength: 255 },
    ]);
    const accountOpts = () => lookups.accounts.filter((a) => Number(a.is_active)).map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` }));
    const totals = h('div', { style: 'display:flex;gap:18px;justify-content:flex-end;margin-top:6px;font-weight:600' });
    const lines = new EditGrid({
      minRows: 2,
      columns: [
        { key: 'account_id', label: 'Account', type: 'select', options: accountOpts, numeric: true, width: '34%' },
        { key: 'employee_code', label: 'Emp. code', width: '90px', placeholder: 'optional' },
        { key: 'debit', label: 'Debit', type: 'number', width: '120px', min: 0 },
        { key: 'credit', label: 'Credit', type: 'number', width: '120px', min: 0 },
        { key: 'narration', label: 'Narration' },
      ],
      onChange: () => { form.markDirty(); sum(); },
    });
    lines.el.addEventListener('input', () => sum());
    function sum() {
      const rows = lines.rows;
      const dr = rows.reduce((a, r) => a + Number(r.debit || 0), 0);
      const cr = rows.reduce((a, r) => a + Number(r.credit || 0), 0);
      const diff = Math.round((dr - cr) * 100) / 100;
      totals.replaceChildren(h('span', null, 'Debit ', fmt2(dr)), h('span', null, 'Credit ', fmt2(cr)),
        h('span', { style: `color:${diff ? 'var(--danger)' : 'var(--ok)'}` }, diff ? `Difference ${fmt2(Math.abs(diff))} ${diff > 0 ? 'Dr' : 'Cr'}` : '✔ Balanced'));
    }
    const recLabel = h('span', { class: 'rec' });
    const info = h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px' });
    const B = (label, cls, fn, key) => h('button', { class: 'btn ' + cls, type: 'button', onclick: fn }, label, key ? h('kbd', null, key) : null);
    const btnSave = B('Save ', 'primary', () => save(false), 'F10');
    const btnSavePost = B('Save & Post', '', () => save(true));
    const btnPost = B('✔ Post', '', () => action('post'));
    const btnUnpost = B('Unpost', '', () => action('unpost'));
    const btnDel = B('Delete ', 'danger', () => remove(), 'F12');
    const btnPrint = B('Print ', '', () => st.current && openReport('voucher', { id: st.current.id }), 'F9');

    function setRecord(v) {
      st.current = v;
      const draft = !v || v.status === 'draft';
      const editable = draft && !Number(v?.is_system) && can('journal', v ? 'edit' : 'add');
      form.values = v ? { ...v, status_view: Number(v.is_system) ? 'System (salary)' : v.status === 'posted' ? 'Posted' : 'Draft' } : { number: '(new)', status_view: 'Draft', vr_date: today() };
      lines.setRows(v ? v.lines.map((l) => ({ ...l, debit: Number(l.debit) || null, credit: Number(l.credit) || null })) : []);
      form.setReadonly(!editable);
      lines.setReadonly(!editable);
      btnSave.disabled = !editable;
      btnSavePost.disabled = !editable || !can('journal', 'post');
      btnPost.disabled = !v || !draft || !can('journal', 'post');
      btnUnpost.disabled = !v || draft || !!v.locked_reason || Number(v.is_system) || !can('journal', 'post');
      btnDel.disabled = !v || Number(v.is_system) || !can('journal', 'delete');
      btnPrint.disabled = !v;
      recLabel.textContent = v ? `${v.number} · ${fdate(v.vr_date)}` : 'New journal voucher';
      info.textContent = v ? (Number(v.is_system) ? 'Created automatically by salary posting; cannot be changed here.' : v.status === 'posted' ? `Posted by ${v.posted_by_name || '-'}.` : 'Draft.') : 'Each line takes either a debit or a credit. Total debit must equal total credit.';
      sum();
    }
    async function open(id) {
      if (st.current?.id === id) return;
      if (form.dirty && !(await confirmDialog('Discard unsaved changes?', { ok: 'Discard', danger: true }))) return;
      setRecord(await get(`journal/${id}`));
    }
    async function save(andPost) {
      if (btnSave.disabled) return;
      const v = form.values;
      const rows = lines.rows;
      // resolve employee codes
      const codes = [...new Set(rows.map((r) => r.employee_code).filter(Boolean))];
      const map = {};
      for (const c of codes) {
        const e = await get('employees/lookup', { code: c });
        if (!e) { toast(`No employee with code "${c}".`, 'err'); return; }
        map[c] = e.id;
      }
      const body = { vr_date: v.vr_date, remarks: v.remarks, post: andPost,
        lines: rows.map((r) => ({ account_id: r.account_id, employee_id: r.employee_code ? map[r.employee_code] : null, debit: r.debit || 0, credit: r.credit || 0, narration: r.narration })) };
      try {
        const r = st.current ? await put(`journal/${st.current.id}`, body) : await post('journal', body);
        toast(`${r.number} ${andPost ? 'saved and posted' : 'saved as draft'}.`);
        form.dirty = false;
        setRecord(r);
        await loadList(r.id);
      } catch (e) {
        if (e.errors?.lines) toast(e.errors.lines, 'err', 7000);
        form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message);
      }
    }
    async function action(kind) {
      if (!st.current) return;
      try { await post(`voucher-actions/${st.current.id}/${kind}`); toast(kind === 'post' ? 'Posted.' : 'Unposted.'); setRecord(await get(`journal/${st.current.id}`)); await loadList(st.current.id); } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function remove() {
      if (!st.current || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete ${st.current.number}?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`voucher-actions/${st.current.id}`); toast('Deleted.'); setRecord(null); await loadList(); } catch (e) { toast(e.message, 'err', 6000); }
    }
    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); form.focus('vr_date'); };
    setKeys({ new: newRec, save: () => save(false), del: remove, search: () => q.focus(), load: () => loadList(st.current?.id),
      print: () => (st.current ? openReport('voucher', { id: st.current.id }) : openReport('journal', { from: from.value, to: to.value })) });

    root.append(
      h('div', { class: 'toolbar' }, B('New ', '', newRec, 'F5'), btnSave, btnSavePost, btnPost, btnUnpost, btnDel, h('span', { class: 'sep' }),
        btnPrint, B('JV report', '', () => openReport('journal', { from: from.value, to: to.value })), h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md', style: 'grid-template-columns:minmax(300px,.8fr) minmax(480px,1.6fr)' },
        h('div', null, h('div', { class: 'filters' }, from, to, q), grid.el),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Journal voucher')),
          h('div', { class: 'panel-body' }, form.el, h('div', { style: 'margin-top:10px' }, lines.el), totals, info))),
    );
    setRecord(null);
    await loadList();
    return { canLeave: () => !form.dirty };
  },
};
