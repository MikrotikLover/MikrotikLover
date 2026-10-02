// Manual Attendance Voucher: pick date + department, F7 loads the employees, mark status / times,
// "Auto Attendance" marks everyone Present, F10 saves. Enter moves to the next cell.
import { get, post, del } from '../core/api.js';
import { h, toast, confirmDialog, modal, fdate, fdatetime, openReport, today } from '../core/dom.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups, opt } from '../core/store.js';

export const STATUSES = [
  ['P', 'P - Present'], ['A', 'A - Absent'], ['L', 'L - Leave (paid)'], ['LW', 'LW - Leave w/o pay'], ['S', 'S - Shift start / joined'],
  ['R', 'R - Rest day'], ['H', 'H - Holiday'], ['HD', 'HD - Half day'], ['O', 'O - Off / not joined'],
];
const TIMED = ['P', 'HD', 'S', 'R', 'H'];
const toMin = (t) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
export const hm = (m) => (m || m === 0 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : '');

export default {
  async mount(root) {
    const canSave = can('attendance', 'add') || can('attendance', 'edit');
    const canDel = can('attendance', 'delete');
    const st = { data: null, rows: [], deleted: new Set(), dirty: false };

    const date = h('input', { type: 'date', class: 'input', value: today(), max: today() });
    const dept = h('select', { class: 'input' }, h('option', { value: '' }, '— select department —'),
      opt.departments().map((o) => h('option', { value: o.value }, o.label)));
    const auto = h('input', { type: 'checkbox', id: 'auto_att' });
    const remarks = h('input', { class: 'input', maxlength: 255, placeholder: 'Voucher remarks' });
    const dayInfo = h('div', { class: 'muted', style: 'font-size:12px' });
    const vrLabel = h('span', { class: 'rec' });
    const counts = h('span');
    const tbody = h('tbody');
    const table = h('table', { class: 'egrid att' },
      h('thead', null, h('tr', null, ['Sr', 'Code', 'Name', 'Designation', 'Shift', 'Status', 'Time In', 'Time Out', 'Hours', 'Remarks', '']
        .map((t, i) => h('th', { style: ['width:36px', 'width:70px', '', '', 'width:120px', 'width:150px', 'width:96px', 'width:96px', 'width:60px', '', 'width:34px'][i] }, t)))),
      tbody);
    const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save(), disabled: !canSave }, 'Save ', h('kbd', null, 'F10'));
    const btnDel = h('button', { class: 'btn danger', type: 'button', onclick: () => removeVoucher(), disabled: true }, 'Delete Vr ', h('kbd', null, 'F12'));

    const shiftById = (id) => lookups.shifts.find((s) => s.id === Number(id));

    // Same rule as the server: hours from In/Out, shift break deducted when the stay exceeds half the shift span.
    function rowHours(r) {
      if (!r.dirty && r.saved && r.work_minutes && r.time_in && r.time_out) return hm(r.work_minutes);
      const a = toMin(r.time_in), b = toMin(r.time_out);
      if (a === null || b === null) return '';
      const sh = shiftById(r.shift_id);
      let d = b - a;
      if (d <= 0) {
        if (Number(sh?.is_overnight)) d += 1440;
        else return '!';
      }
      if (sh) {
        const s = toMin(sh.start_time), e = toMin(sh.end_time);
        const span = e > s ? e - s : 1440 - s + e;
        if (d > span / 2) d = Math.max(0, d - Number(sh.break_minutes || 0));
      }
      return hm(d);
    }

    function markDirty(r, tr) {
      r.dirty = true;
      st.dirty = true;
      paint(r, tr);
      updateCounts();
    }

    function paint(r, tr) {
      tr.className = `st-${r.status || 'none'}${r.dirty ? ' dirty' : ''}${r.locked ? ' locked' : ''}`;
      const timed = TIMED.includes(r.status);
      tr.querySelectorAll('input.t').forEach((x) => { x.disabled = r.locked || !timed || !canSave; if (!timed) x.value = ''; });
      if (!timed) { r.time_in = null; r.time_out = null; }
      tr.querySelector('td.hrs').textContent = rowHours(r);
      tr.querySelector('td.hrs').classList.toggle('bad', rowHours(r) === '!');
    }

    function renderRows() {
      tbody.replaceChildren(...st.rows.map((r, i) => {
        const shiftSel = h('select', { disabled: r.locked || !canSave },
          h('option', { value: '' }, '—'), lookups.shifts.map((s) => h('option', { value: s.id }, `${s.code} ${s.start_time.slice(0, 5)}`)));
        shiftSel.value = r.shift_id ?? '';
        const statusSel = h('select', { class: 'status', disabled: r.locked || !canSave },
          h('option', { value: '' }, ''), STATUSES.map(([v, l]) => h('option', { value: v }, l)));
        statusSel.value = r.status ?? '';
        const tin = h('input', { type: 'time', class: 't', value: r.time_in || '' });
        const tout = h('input', { type: 'time', class: 't', value: r.time_out || '' });
        const rem = h('input', { value: r.remarks || '', maxlength: 255, disabled: r.locked || !canSave });
        const tr = h('tr', null,
          h('td', { class: 'sr' }, i + 1),
          h('td', null, r.code),
          h('td', { title: r.flag_reason || '' }, r.name, r.source && r.source !== 'manual' ? h('span', { class: 'badge info', style: 'margin-left:6px' }, r.source) : null),
          h('td', null, r.designation),
          h('td', null, shiftSel), h('td', null, statusSel), h('td', null, tin), h('td', null, tout),
          h('td', { class: 'hrs num' }), h('td', null, rem),
          h('td', { class: 'act' }, h('button', { class: 'rm', type: 'button', title: 'Remove from voucher (delete this attendance)', disabled: r.locked || !canDel,
            onclick: () => removeRow(r, tr) }, '×')));
        shiftSel.addEventListener('change', () => { r.shift_id = shiftSel.value ? Number(shiftSel.value) : null; markDirty(r, tr); });
        statusSel.addEventListener('change', () => { r.status = statusSel.value || null; r.auto = false; markDirty(r, tr); });
        tin.addEventListener('change', () => { r.time_in = tin.value || null; markDirty(r, tr); });
        tout.addEventListener('change', () => { r.time_out = tout.value || null; markDirty(r, tr); });
        rem.addEventListener('change', () => { r.remarks = rem.value; markDirty(r, tr); });
        r.tr = tr;
        paint(r, tr);
        return tr;
      }));
      if (!st.rows.length) tbody.append(h('tr', null, h('td', { colspan: 11, class: 'muted', style: 'padding:20px;text-align:center' },
        st.data ? 'No employees in this department on this date.' : 'Select date and department, then press Show (F7).')));
      updateCounts();
    }

    function updateCounts() {
      const c = {};
      st.rows.forEach((r) => { c[r.status || '—'] = (c[r.status || '—'] || 0) + 1; });
      counts.textContent = Object.entries(c).map(([k, v]) => `${k}: ${v}`).join('  ·  ') + (st.rows.length ? `  ·  Total: ${st.rows.length}` : '');
    }

    async function removeRow(r, tr) {
      if (r.saved && !(await confirmDialog(`Delete the attendance of ${r.code} ${r.name} for ${fdate(date.value)}?`, { ok: 'Delete', danger: true }))) return;
      if (r.saved) st.deleted.add(r.employee_id);
      st.rows.splice(st.rows.indexOf(r), 1);
      st.dirty = true;
      tr.remove();
      [...tbody.children].forEach((x, i) => { if (x.firstChild?.classList?.contains('sr')) x.firstChild.textContent = i + 1; });
      updateCounts();
    }

    function applyAuto() {
      for (const r of st.rows) {
        if (r.locked) continue;
        if (auto.checked && !r.status) { r.status = 'P'; r.auto = true; r.dirty = true; }
        else if (!auto.checked && r.auto) { r.status = null; r.auto = false; }
        if (r.tr) { r.tr.querySelector('select.status').value = r.status ?? ''; paint(r, r.tr); }
      }
      st.dirty = true;
      updateCounts();
    }
    auto.addEventListener('change', applyAuto);

    async function confirmDiscard() {
      if (!st.dirty) return true;
      return confirmDialog('Discard unsaved attendance changes?', { ok: 'Discard', danger: true });
    }

    async function load() {
      if (!date.value || !dept.value) { toast('Select date and department.', 'warn'); (date.value ? dept : date).focus(); return; }
      if (!(await confirmDiscard())) return;
      try {
        setData(await get('attendance/vouchers/load', { date: date.value, department_id: dept.value }));
        tbody.querySelector('select.status:not(:disabled)')?.focus();
      } catch (e) { toast(e.message, 'err', 6000); }
    }

    function setData(d) {
      st.data = d;
      st.rows = d.rows.map((r) => ({ ...r, dirty: false, auto: false }));
      st.deleted = new Set();
      st.dirty = false;
      auto.checked = false;
      remarks.value = d.voucher?.remarks || '';
      vrLabel.textContent = d.voucher ? `Vr# ${d.voucher.vr_no} · saved by ${d.voucher.created_by_name || '-'} ${fdatetime(d.voucher.created_at)}` : 'New voucher';
      btnDel.disabled = !d.voucher || !canDel;
      dayInfo.textContent = `${d.day}${d.holiday ? ' · Holiday: ' + d.holiday.name : ''}` +
        (d.rows.some((r) => r.locked) ? ' · Some rows are in a posted salary month (locked)' : '');
      renderRows();
    }

    async function save() {
      if (!st.data || btnSave.disabled) return;
      const rows = st.rows.filter((r) => !r.locked && r.status && (r.dirty || !r.saved))
        .map((r) => ({ employee_id: r.employee_id, status: r.status, shift_id: r.shift_id, time_in: r.time_in, time_out: r.time_out, remarks: r.remarks }));
      const unmarked = st.rows.filter((r) => !r.status && !r.locked).length;
      if (!rows.length && !st.deleted.size) { toast(unmarked ? 'Mark a status for the employees first (or tick Auto Attendance).' : 'No changes to save.', 'warn'); return; }
      if (unmarked && !(await confirmDialog(`${unmarked} employee(s) have no status and will not be saved. Continue?`, { ok: 'Save' }))) return;
      try {
        const d = await post('attendance/vouchers', {
          vr_date: st.data.date, department_id: Number(dept.value), remarks: remarks.value, rows, delete_ids: [...st.deleted],
        });
        setData(d);
        toast(`Saved Vr# ${d.voucher?.vr_no}: ${d.saved.rows} row(s)${d.saved.deleted ? `, ${d.saved.deleted} deleted` : ''}.`);
      } catch (e) {
        toast(e.message, 'err', 8000);
        const i = Number(e.errors?.row);
        if (!Number.isNaN(i) && rows[i]) {
          const r = st.rows.find((x) => x.employee_id === rows[i].employee_id);
          r?.tr?.classList.add('error');
          r?.tr?.querySelector('select.status')?.focus();
        }
      }
    }

    async function removeVoucher() {
      const v = st.data?.voucher;
      if (!v || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete attendance voucher #${v.vr_no} and all attendance it entered?`, { ok: 'Delete', danger: true }))) return;
      try {
        const r = await del(`attendance/vouchers/${v.id}`);
        toast(`Voucher deleted (${r.rows} attendance rows removed).`);
        st.dirty = false;
        await load();
      } catch (e) { toast(e.message, 'err', 6000); }
    }

    async function shiftDate(n) {
      if (!(await confirmDiscard())) return;
      const d = new Date(date.value + 'T12:00:00');
      d.setDate(d.getDate() + n);
      const v = d.toISOString().slice(0, 10);
      if (v > today()) return;
      date.value = v;
      st.dirty = false;
      if (dept.value) load();
    }

    async function vouchers() {
      const list = await get('attendance/vouchers', { from: date.value.slice(0, 8) + '01', to: today() });
      const grid = new DataGrid({
        columns: [
          { key: 'vr_no', label: 'Vr#', align: 'right' }, { key: 'vr_date', label: 'Date', render: (r) => fdate(r.vr_date) },
          { key: 'department', label: 'Department' }, { key: 'rows_count', label: 'Rows', align: 'right' },
          { key: 'created_by_name', label: 'Entered by' }, { key: 'remarks', label: 'Remarks' },
        ],
        maxHeight: '55vh',
        onOpen: async (r) => { m.close(); date.value = r.vr_date; dept.value = r.department_id; await load(); },
      });
      grid.setRows(list);
      const m = modal({ title: 'Attendance vouchers this month', body: grid.el, wide: true });
      setTimeout(() => grid.focus(), 50);
    }

    // Enter = next cell in the grid (row by row)
    tbody.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const cells = [...tbody.querySelectorAll('select:not(:disabled), input:not(:disabled)')];
      const i = cells.indexOf(e.target);
      if (i < 0) return;
      e.preventDefault();
      e.target.dispatchEvent(new Event('change', { bubbles: true }));
      cells[i + (e.shiftKey ? -1 : 1)]?.focus();
    });
    [date, dept].forEach((x) => x.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (x === date) dept.focus(); else load(); } }));

    async function newVoucher() {
      if (!(await confirmDiscard())) return;
      st.data = null;
      st.rows = [];
      st.dirty = false;
      date.value = today();
      vrLabel.textContent = '';
      btnDel.disabled = true;
      renderRows();
      date.focus();
    }

    setKeys({
      load, save, del: removeVoucher, search: vouchers,
      new: newVoucher,
      print: () => openReport('daily_attendance', { date: date.value, department_id: dept.value }),
      prev: () => shiftDate(-1), next: () => shiftDate(1),
    });

    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', onclick: newVoucher }, 'New ', h('kbd', null, 'F5')),
        h('button', { class: 'btn', type: 'button', onclick: load }, 'Show ', h('kbd', null, 'F7')),
        btnSave, btnDel,
        h('span', { class: 'sep' }),
        h('button', { class: 'btn', type: 'button', onclick: vouchers }, h('span', { class: 'lbl' }, 'Vouchers '), h('kbd', null, 'F1')),
        h('button', { class: 'btn', type: 'button', onclick: () => openReport('daily_attendance', { date: date.value, department_id: dept.value }) }, h('span', { class: 'lbl' }, 'Print '), h('kbd', null, 'F9')),
        h('button', { class: 'btn icon', type: 'button', title: 'Previous day (PgUp)', onclick: () => shiftDate(-1) }, '◀'),
        h('button', { class: 'btn icon', type: 'button', title: 'Next day (PgDn)', onclick: () => shiftDate(1) }, '▶'),
        h('span', { class: 'spacer' }), vrLabel),
      h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-body form-grid' },
        h('div', { class: 'fld s2 req' }, h('label', null, 'Date'), date, dayInfo),
        h('div', { class: 'fld s3 req' }, h('label', null, 'Department'), dept),
        h('div', { class: 'fld check s2' }, auto, h('label', { for: 'auto_att' }, 'Auto Attendance (all Present)')),
        h('div', { class: 'fld s5' }, h('label', null, 'Remarks'), remarks))),
      h('div', { style: 'overflow-x:auto;background:#fff;border:1px solid var(--line);border-radius:6px' }, table),
      h('div', { class: 'grid-foot' }, counts, h('span', { class: 'spacer' }),
        'Enter = next cell · type the first letter to pick a status · times are optional · hours are calculated from In/Out'),
    );
    renderRows();
    date.focus();
    return { canLeave: () => !st.dirty };
  },
};
