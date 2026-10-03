// Salary Sheet (Permanent / Daily Wages): F7 Show computes the grid from attendance, overtime,
// vouchers and loans -> review (enter fines / remarks) -> F10 Save (draft) -> Post (locks the month,
// generates the salary JV). Posted sheets are read only.
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, fdate, money, today, openReport } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { can, lookups } from '../core/store.js';


/** Previous calendar month as [from, to]. */
function previousMonth() {
  const d = new Date(today() + 'T12:00:00');
  const first = new Date(d.getFullYear(), d.getMonth() - 1, 1, 12);
  const last = new Date(d.getFullYear(), d.getMonth(), 0, 12);
  const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return [iso(first), iso(last)];
}
const days = (v) => { const n = Number(v); return n ? String(Math.round(n * 100) / 100) : ''; };
const amt = (v) => (Number(v) ? money(v) : '');

export default {
  async mount(root, params, meta) {
    const type = meta?.kind === 'daily_wages' ? 'daily_wages' : 'permanent';
    const daily = type === 'daily_wages';
    const ss = lookups.settings?.social_security || 'PESSI';
    const [from, to] = previousMonth();

    const form = new Form([
      { name: 'period_from', label: 'From', type: 'date', required: true, span: 2 },
      { name: 'period_to', label: 'To', type: 'date', required: true, span: 2 },
      { name: 'paid_date', label: 'Paid Date', type: 'date', span: 2 },
      { name: 'remarks', label: 'Remarks', span: 6, maxlength: 255 },
    ]);
    form.values = { period_from: from, period_to: to, paid_date: '' };

    let data = null;      // last preview / stored sheet
    let dirtyLines = false;
    const status = h('span', { class: 'badge' }, 'not shown');
    const info = h('span', { class: 'rec' });
    const B = (label, cls, fn, key, perm = true) => h('button', { class: 'btn ' + cls, type: 'button', disabled: !perm, onclick: fn }, label, key ? h('kbd', null, key) : null);
    const btnShow = B('Show ', '', () => show(), 'F7');
    const btnSave = B('Save ', 'primary', () => save(), 'F10', can('salary', 'add'));
    const btnPost = B('Post & Lock', 'ok', () => postSheet(), '', can('salary', 'post'));
    const btnDel = B('Delete Draft ', 'danger', () => removeDraft(), 'F12', can('salary', 'delete'));
    const btnPrint = B('Salary Sheet ', '', () => report('salary_sheet'), 'F9');
    const btnSlips = B('Payslips', '', () => report('payslips'));
    const btnBank = B('Bank List', '', () => report('salary_bank'));
    const btnDept = B('Dept. Summary', '', () => report('salary_departments'));

    const sheetId = () => data?.sheet?.id || null;
    const posted = () => data?.status === 'posted';

    function refreshButtons() {
      const id = sheetId();
      btnSave.disabled = !can('salary', 'add') || !data || posted();
      btnPost.disabled = !can('salary', 'post') || !id || posted();
      btnDel.disabled = !can('salary', 'delete') || !id || posted();
      for (const b of [btnPrint, btnSlips, btnBank, btnDept]) b.disabled = !id;
      const st = data ? data.status : 'none';
      status.className = 'badge ' + ({ posted: 'ok', draft: 'warn', new: 'info' }[st] || '');
      status.textContent = { posted: 'Posted — locked', draft: dirtyLines ? 'Draft (unsaved changes)' : 'Draft saved', new: 'Not saved' }[st] || 'not shown';
      form.setReadonly(posted());
      // the paid date may still be set on a posted sheet
      const pd = form.el.querySelector('[name=paid_date]');
      if (pd) pd.readOnly = false;
    }

    function report(name) {
      const id = sheetId();
      if (!id) { toast('Save the sheet first, then print.', 'warn'); return; }
      if (dirtyLines && !posted()) toast('Printing the last saved version. Save to include your changes.', 'warn', 5000);
      openReport(name, { id });
    }

    // ---------- grid
    const COLS = [
      ['sr', 'Sr'], ['department', 'Department'], ['name', 'Name'], ['designation', 'Designation'],
      ['basic', daily ? 'Rate/Day' : 'Basic', 'm'], ['fine', 'Fine', 'in'], ['absent_days', 'Absent', 'd'], ['leave_wp_days', 'Leave WP', 'd'],
      ['leave_wop_days', 'Leave WOP', 'd'], ['rest_days', 'Rest Days', 'd'], ['work_days', 'Work Days', 'd'], ['paid_days', 'Paid Days', 'd'],
      ['pay', 'Work Pay', 'm'], ['ot_hours', 'OT Hours', 'd'], ['ot_rate', 'OT Rate', 'r'], ['ot_amount', 'OT Amount', 'm'], ['gross', 'Gross', 'm'],
      ['advance', 'Advance', 'm'], ['loan_deduction', 'Loan Ded.', 'm'], ['loan_balance', 'Loan Bal.', 'm'], ['incentive', 'Incentive', 'm'],
      ['penalty', 'Penalty', 'm'], ['eobi', 'EOBI', 'm'], ['pessi', ss, 'm'], ['income_tax', 'Income Tax', 'm'], ['net_salary', 'Net Salary', 'm'],
      ['remarks', 'Remarks', 'txt'], ['warn', '⚠'],
    ];
    const val = (l, k) => (k === 'basic' ? (daily ? l.daily_rate : l.basic_salary) : k === 'pay' ? Number(l.work_pay) + Number(l.allowance_pay) : l[k]);
    const table = h('table', { class: 'grid salgrid' });
    const wrap = h('div', { class: 'grid-wrap' }, table);
    const foot = h('div', { class: 'grid-foot' });

    function render() {
      const lines = data?.lines || [];
      const head = h('tr', null, COLS.map(([, l, t]) => h('th', { class: ['m', 'd', 'r', 'in'].includes(t) ? 'num' : '' }, l)));
      const body = h('tbody');
      if (!lines.length) {
        body.append(h('tr', { class: 'empty' }, h('td', { colspan: COLS.length }, data ? 'No employees for this period.' : 'Choose the period and press Show (F7).')));
      }
      let dept = null;
      lines.forEach((l, i) => {
        if (l.department !== dept) {
          dept = l.department;
          body.append(h('tr', { class: 'grp' }, h('td', { colspan: COLS.length }, dept)));
        }
        const tr = h('tr', { class: Number(l.net_salary) < 0 ? 'neg' : '' });
        for (const [k, , t] of COLS) {
          if (k === 'sr') tr.append(h('td', { class: 'num' }, i + 1));
          else if (k === 'name') tr.append(h('td', null, h('b', null, l.code), ' ', l.name));
          else if ((t === 'in' || t === 'txt') && (posted() || !can('salary', 'add'))) {
            tr.append(h('td', { class: t === 'in' ? 'num' : '' }, t === 'in' ? amt(l.fine) : (l.remarks || '')));
          } else if (t === 'in' || t === 'txt') {
            const inp = h('input', {
              class: 'input cell' + (t === 'in' ? ' num' : ''), value: t === 'in' ? (Number(l.fine) || '') : (l.remarks || ''),
              type: t === 'in' ? 'number' : 'text', min: t === 'in' ? 0 : null, step: t === 'in' ? 1 : null, maxlength: t === 'txt' ? 255 : null,
              'data-col': k, 'data-row': i,
            });
            inp.addEventListener('change', () => {
              if (t === 'in') l.fine = Math.max(0, Number(inp.value) || 0); else l.remarks = inp.value;
              dirtyLines = true;
              if (t === 'in') recalcLocal(l, tr);
              refreshButtons();
            });
            tr.append(h('td', { class: t === 'in' ? 'num' : '' }, inp));
          } else if (k === 'warn') {
            const w = l.warnings || [];
            tr.append(h('td', { class: 'warn-cell', title: w.join('\n') }, w.length ? h('span', { class: 'badge warn' }, '⚠ ' + w.length) : ''));
          } else if (t === 'm') tr.append(h('td', { class: 'num' + (k === 'net_salary' ? ' net' : ''), 'data-k': k }, amt(val(l, k))));
          else if (t === 'd') tr.append(h('td', { class: 'num' }, days(val(l, k))));
          else if (t === 'r') tr.append(h('td', { class: 'num' }, Number(l.ot_rate) ? Number(l.ot_rate).toFixed(2) : ''));
          else tr.append(h('td', null, val(l, k) ?? ''));
        }
        body.append(tr);
      });
      if (lines.length) body.append(totalRow(lines));
      table.replaceChildren(h('thead', null, head), body);
      const t = data?.totals || {};
      const warned = lines.filter((l) => (l.warnings || []).length).length;
      foot.replaceChildren(
        h('span', null, `${lines.length} employee(s)`),
        data ? h('span', null, `Days in month: ${data.days} (${data.basis})`) : '',
        data ? h('span', null, `Cash ${money(t.cash)} · Bank ${money(t.bank)}`) : '',
        warned ? h('span', { class: 'badge warn' }, `${warned} with warnings — hover ⚠`) : '',
        h('span', { class: 'spacer' }),
        'Enter moves to the next row · Fine and Remarks are editable until posting',
      );
      info.textContent = data ? `${fdate(data.from)} – ${fdate(data.to)}` : '';
    }

    function totalRow(lines) {
      const tr = h('tr', { class: 'total' });
      for (const [k, , t] of COLS) {
        if (k === 'sr') tr.append(h('td', { colspan: 4 }, 'Grand Total'));
        else if (['department', 'name', 'designation'].includes(k)) continue;
        else if ((t === 'm' && k !== 'basic') || t === 'in') tr.append(h('td', { class: 'num' }, amt(lines.reduce((s, l) => s + Number(val(l, k) || 0), 0))));
        else if (k === 'ot_hours' || k === 'paid_days' || k === 'work_days') tr.append(h('td', { class: 'num' }, days(lines.reduce((s, l) => s + Number(l[k] || 0), 0))));
        else tr.append(h('td'));
      }
      return tr;
    }

    // A changed fine changes the net immediately (the server recalculates on Save and again on Post).
    function recalcLocal(l, tr) {
      l.net_salary = l._netBase - Number(l.fine);
      tr.classList.toggle('neg', l.net_salary < 0);
      tr.querySelector('[data-k=net_salary]').textContent = amt(l.net_salary);
      table.querySelector('tr.total')?.replaceWith(totalRow(data.lines));
    }

    // Enter / arrow keys move between the fine / remarks cells of consecutive rows
    table.addEventListener('keydown', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !t.dataset.col) return;
      const step = e.key === 'Enter' || e.key === 'ArrowDown' ? (e.shiftKey ? -1 : 1) : e.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      t.dispatchEvent(new Event('change'));
      table.querySelector(`input[data-col="${t.dataset.col}"][data-row="${Number(t.dataset.row) + step}"]`)?.focus();
    });

    function setData(d) {
      data = d;
      dirtyLines = false;
      for (const l of data.lines) l._netBase = Number(l.net_salary) + (Number(l.fine) || 0);
      if (d.sheet) form.values = { period_from: d.from, period_to: d.to, paid_date: d.sheet.paid_date || '', remarks: d.sheet.remarks || '' };
      render();
      refreshButtons();
    }

    function showErr(e) {
      form.showErrors(e.errors || {}, Object.keys(e.errors || {}).length ? '' : e.message);
      if (!Object.keys(e.errors || {}).length) toast(e.message, 'err', 7000);
    }

    async function show() {
      if (dirtyLines && !(await confirmDialog('Discard unsaved fines / remarks and recalculate?', { ok: 'Recalculate' }))) return;
      const v = form.values;
      form.clearErrors();
      btnShow.disabled = true;
      try {
        setData(await get('salary/preview', { type, from: v.period_from, to: v.period_to }));
        if (data.status === 'posted') toast('This month is posted and locked — showing the stored sheet.', 'warn', 5000);
      } catch (e) { showErr(e); } finally { btnShow.disabled = false; }
    }

    async function save() {
      if (btnSave.disabled) return;
      const v = form.values;
      form.clearErrors();
      btnSave.disabled = true;
      try {
        const d = await post('salary/sheets', {
          sheet_type: type, period_from: v.period_from, period_to: v.period_to, paid_date: v.paid_date || null, remarks: v.remarks || null,
          lines: data.lines.map((l) => ({ employee_id: l.employee_id, fine: Number(l.fine) || 0, remarks: l.remarks || '' })),
        });
        setData(d);
        toast('Salary sheet saved (draft).');
        loadList();
      } catch (e) { showErr(e); refreshButtons(); }
    }

    async function postSheet() {
      if (btnPost.disabled) return;
      if (dirtyLines) { toast('Save your changes first (F10), then post.', 'warn', 5000); return; }
      const t = data.totals;
      const ok = await confirmDialog(
        `Post the ${daily ? 'Daily Wages' : 'Permanent'} salary for ${fdate(data.from)} – ${fdate(data.to)}?\n\n`
        + `${t.employees} employees · Net Rs. ${money(t.net_salary)}\n\n`
        + 'Posting locks attendance, vouchers and loan installments of this period and creates the salary journal voucher. It cannot be undone.',
        { title: 'Post salary sheet', ok: 'Post & Lock', danger: true });
      if (!ok) return;
      try {
        const d = await post(`salary/sheets/${sheetId()}/post`, { paid_date: form.get('paid_date') || null });
        setData(d);
        toast('Salary posted and locked. Journal voucher created.');
        loadList();
      } catch (e) { showErr(e); }
    }

    async function removeDraft() {
      if (btnDel.disabled) return;
      if (!(await confirmDialog('Delete this draft salary sheet? Nothing is posted yet; you can Show and Save again.', { ok: 'Delete', danger: true }))) return;
      try {
        await del(`salary/sheets/${sheetId()}`);
        toast('Draft deleted.');
        data = null;
        render();
        refreshButtons();
        loadList();
      } catch (e) { showErr(e); }
    }

    // paid date on a posted sheet is saved on change
    form.el.querySelector('[name=paid_date]')?.addEventListener('change', async (e) => {
      if (!posted() || !can('salary', 'edit')) return;
      try { await put(`salary/sheets/${sheetId()}/paid-date`, { paid_date: e.target.value || null }); data.sheet.paid_date = e.target.value; toast('Paid date updated.'); } catch (err) { showErr(err); }
    });

    // ---------- previous sheets
    const listBox = h('div', { class: 'sal-list' });
    async function loadList() {
      const rows = await get('salary/sheets', { type });
      listBox.replaceChildren(...(rows.length ? rows.slice(0, 12).map((s) => h('button', {
        class: 'btn sm', type: 'button', title: `${s.employees} employees · Net ${money(s.net_salary)}`,
        onclick: () => { form.values = { ...form.values, period_from: s.period_from, period_to: s.period_to }; show(); },
      }, `${new Date(s.salary_month + 'T12:00:00').toLocaleString('en-GB', { month: 'short', year: 'numeric' })} `,
      h('span', { class: 'badge ' + (s.status === 'posted' ? 'ok' : 'warn') }, s.status))) : [h('span', { class: 'muted' }, 'No salary sheets yet.')]));
    }

    setKeys({ load: show, save, del: removeDraft, print: () => report('salary_sheet') });

    root.append(
      h('div', { class: 'toolbar' }, btnShow, btnSave, btnPost, btnDel, h('span', { class: 'sep' }), btnPrint, btnSlips, btnBank, btnDept,
        h('span', { class: 'spacer' }), info, status),
      h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, form.el,
        h('div', { style: 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px' }, h('span', { class: 'muted', style: 'font-size:12px' }, 'Sheets:'), listBox))),
      h('div', { class: 'panel', style: 'margin-top:10px' }, h('div', { class: 'panel-body' }, wrap, foot,
        h('ul', { class: 'muted', style: 'font-size:12px;margin:8px 0 0;padding-left:18px' },
          h('li', null, daily
            ? 'Pay = Daily Rate × Present (work) days + OT. Half / short days count by actual hours worked.'
            : 'Paid Days = Work + Rest + Paid Leave · Work Pay = Basic ÷ Days in Month × Paid Days (allowances prorated the same way and included).'),
          h('li', null, 'OT = Hours × Rate (Basic ÷ days ÷ shift hours × multiplier, or the employee\'s fixed OT rate). Gross = Work Pay + OT.'),
          h('li', null, `Net = Gross + Incentive − Advance − Loan − Penalty − Fine − EOBI − ${ss} − Income Tax. A short salary reduces the loan installment (carried forward).`),
          h('li', null, 'Post re-checks the data; if attendance or vouchers changed since saving, press Show and Save again.')))),
    );
    render();
    refreshButtons();
    await loadList();
    await show();
  },
};
