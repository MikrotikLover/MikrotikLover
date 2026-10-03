// Daily Attendance Post: convert raw punches into daily attendance for a date range (re-runnable),
// then review and fix exceptions (missing punches, flagged, absent).
import { get, post, put, del } from '../core/api.js';
import { h, toast, modal, confirmDialog, fdate, ftime, today } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups, opt, session } from '../core/store.js';
import { STATUSES, hm, statusCode } from './attendance-voucher.js';

const yesterday = () => { const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); };

export default {
  async mount(root) {
    const form = new Form([
      { name: 'from', label: 'From date', type: 'date', required: true, span: 3 },
      { name: 'to', label: 'To date', type: 'date', required: true, span: 3 },
      { name: 'department_id', label: 'Department', type: 'select', span: 3, numeric: true, options: () => opt.departments(), blankLabel: 'All departments' },
      { name: 'overwrite_manual', label: 'Also overwrite manual entries', type: 'checkbox', span: 3 },
    ]);
    form.values = { from: yesterday(), to: yesterday() };
    const result = h('div');
    const pendingBox = h('div');
    const btnPost = h('button', { class: 'btn primary', type: 'button', disabled: !can('attendance_post', 'post'), onclick: () => run() }, 'Post Attendance ', h('kbd', null, 'F10'));

    async function run() {
      if (btnPost.disabled) return;
      const v = form.values;
      if (v.overwrite_manual && !(await confirmDialog('Manual voucher entries in this range will be replaced by machine data. Continue?', { ok: 'Overwrite', danger: true }))) return;
      btnPost.disabled = true;
      btnPost.firstChild.textContent = 'Posting… ';
      try {
        const s = await post('attendance/post', v);
        const card = (val, l) => h('div', { class: 'card' }, h('div', { class: 'v' }, val), h('div', { class: 'l' }, l));
        result.replaceChildren(h('div', { class: 'stat-cards' },
          card(s.posted, 'Rows posted'), card(s.present, 'Present (with punches)'), card(s.absent, 'Absent'),
          card(s.kept_manual, 'Manual kept'), card(s.flagged, 'Flagged'), card(s.ot_candidates, 'OT candidates'),
          card(s.locked, 'Locked (salary posted)'), card(s.remapped, 'Punches re-mapped')),
          h('div', { class: 'muted', style: 'font-size:12px' }, `Posted ${fdate(s.from)} to ${fdate(s.to)} for ${s.employees} employee(s). Re-running is safe.`));
        toast('Attendance posted.');
        await Promise.all([loadPending(), loadExceptions()]);
      } catch (e) {
        form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message);
      } finally {
        btnPost.disabled = !can('attendance_post', 'post');
        btnPost.firstChild.textContent = 'Post Attendance ';
      }
    }

    async function loadPending() {
      const s = await get('attendance/punch-status');
      pendingBox.replaceChildren(...[
        h('div', { class: 'form-section', style: 'margin-bottom:6px' }, 'Punches waiting to be posted'),
        s.pending.length
          ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, s.pending.map((p) => h('button', {
            class: 'btn sm', type: 'button', title: 'Set this date', onclick: () => { form.set('from', p.punch_date); form.set('to', p.punch_date); },
          }, `${fdate(p.punch_date)} (${p.punches})`)))
          : h('div', { class: 'muted' }, 'None — all punches are posted.'),
        h('div', { class: 'form-section', style: 'margin:12px 0 6px' }, 'Unknown machine IDs (not linked to any employee)'),
        s.unmapped.length
          ? h('table', { class: 'grid' }, h('thead', null, h('tr', null, h('th', null, 'Machine ID'), h('th', { class: 'num' }, 'Punches'), h('th', null, 'First'), h('th', null, 'Last'), h('th', null, 'Device'))),
            h('tbody', null, s.unmapped.map((u) => h('tr', null, h('td', null, u.machine_id), h('td', { class: 'num' }, u.punches),
              h('td', null, fdate(u.first_punch)), h('td', null, fdate(u.last_punch)), h('td', null, u.devices || '')))))
          : h('div', { class: 'muted' }, 'None.'),
        s.unmapped.length ? h('div', { class: 'muted', style: 'font-size:12px;margin-top:4px' }, 'Enter the Machine ID on the employee record; the punches are linked on the next post.') : null,
      ].filter(Boolean));
    }

    // ---------- exceptions
    const filter = h('select', { class: 'input', style: 'width:200px' },
      [['exceptions', 'Exceptions (missing / flagged / absent)'], ['flagged', 'Flagged only'], ['late', 'Late comers'], ['absent', 'Absent'], ['all', 'All rows']]
        .map(([v, l]) => h('option', { value: v }, l)));
    const grid = new DataGrid({
      columns: [
        { key: 'att_date', label: 'Date', render: (r) => fdate(r.att_date) },
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'department', label: 'Department' },
        { key: 'shift_code', label: 'Shift' },
        { key: 'time_in', label: 'In', render: (r) => ftime(r.time_in?.slice(11)) },
        { key: 'time_out', label: 'Out', render: (r) => (r.time_out ? ftime(r.time_out.slice(11)) + (r.time_out.slice(0, 10) !== r.att_date ? ' +1' : '') : '') },
        { key: 'work_minutes', label: 'Hours', align: 'right', render: (r) => (r.work_minutes ? hm(r.work_minutes) : '') },
        { key: 'late_minutes', label: 'Late', align: 'right', render: (r) => (r.late_minutes ? hm(r.late_minutes) : '') },
        { key: 'status', label: 'Status', render: (r) => h('b', null, statusCode(r.status)) },
        { key: 'flag_reason', label: 'Flag / remarks', render: (r) => h('span', { style: r.is_flagged ? 'color:var(--danger)' : '' }, [r.flag_reason, r.remarks].filter(Boolean).join(' · ')) },
        { key: 'source', label: 'Source', render: (r) => (r.vr_no ? `Vr# ${r.vr_no}` : r.source) },
      ],
      onOpen: (r) => editRow(r),
      emptyText: 'No rows for this filter.',
    });
    const count = h('span');
    async function loadExceptions() {
      const v = form.values;
      const rows = await get('attendance/daily', { from: v.from, to: v.to, department_id: v.department_id, filter: filter.value });
      grid.setRows(rows);
      count.textContent = `${rows.length} row(s)`;
    }
    filter.addEventListener('change', loadExceptions);

    async function editRow(r) {
      const f = new Form([
        { name: 'status', label: 'Status', type: 'select', required: true, span: 4, options: STATUSES.map(([v, l]) => ({ value: v, label: l })) },
        { name: 'shift_id', label: 'Shift', type: 'select', span: 4, numeric: true, options: () => opt.shifts(true) },
        { name: 'time_in', label: 'Time In', type: 'time', span: 2 },
        { name: 'time_out', label: 'Time Out', type: 'time', span: 2 },
        { name: 'remarks', label: 'Remarks', span: 12, maxlength: 255 },
      ]);
      f.values = { ...r, time_in: r.time_in?.slice(11, 16), time_out: r.time_out?.slice(11, 16) };
      const punches = await get('attendance/punches', { employee_id: r.employee_id, date: r.att_date });
      const plist = h('div', { class: 'muted', style: 'font-size:12px;margin-top:10px' }, 'Raw punches (day before → day after): ',
        punches.length ? punches.map((p) => `${fdate(p.punch_time)} ${p.punch_time.slice(11, 16)} (${p.source})`).join(' · ') : 'none');
      const canEdit = can('attendance', 'edit');
      if (!canEdit) f.setReadonly(true);
      modal({
        title: `${r.code} ${r.name} — ${fdate(r.att_date)}`,
        wide: true,
        body: h('div', null, f.el, plist, h('div', { class: 'muted', style: 'font-size:12px;margin-top:6px' },
          'Saving makes this a manual entry (kept by future posts). Hours, late and OT are recalculated. An overnight shift may end the next day.')),
        buttons: [
          ...(can('attendance', 'delete') ? [{ label: 'Delete row', class: 'danger', onClick: async () => {
            if (!(await confirmDialog('Delete this attendance row?', { ok: 'Delete', danger: true }))) return false;
            try { await del(`attendance/daily/${r.id}`); toast('Deleted.'); await loadExceptions(); return true; } catch (e) { toast(e.message, 'err', 6000); return false; }
          } }] : []),
          { label: 'Cancel' },
          ...(canEdit ? [{ label: 'Save (F10)', class: 'primary', onClick: async () => {
            try { await put(`attendance/daily/${r.id}`, f.values); toast('Attendance updated.'); await loadExceptions(); return true; } catch (e) {
              f.showErrors(Object.fromEntries(Object.entries(e.errors || {}).map(([k, m]) => [k, m])), Object.keys(e.errors || {}).length ? '' : e.message);
              return false;
            }
          } }] : []),
        ],
      });
    }

    // ---------- verify & lock dates (admin): a posted date cannot be changed until an admin unposts it
    const isAdmin = Number(session.user?.is_admin) === 1;
    const lockBox = h('div');
    async function loadLocks() {
      const v = form.values;
      const from = (v.from || today()).slice(0, 8) + '01';
      const rows = await get('attendance/day-posts', { from, to: today() });
      const btnLock = h('button', { class: 'btn primary', type: 'button', disabled: !isAdmin, title: isAdmin ? '' : 'Administrator only', onclick: async () => {
        const f = form.values;
        if (!(await confirmDialog(`Post (lock) attendance from ${fdate(f.from)} to ${fdate(f.to)}?\nLocked dates cannot be edited until an administrator unposts them.`, { ok: 'Post & Lock' }))) return;
        try {
          const r = await post('attendance/day-posts', { from: f.from, to: f.to });
          toast(r.posted.length ? `${r.posted.length} date(s) posted and locked.` : 'Those dates were already posted.');
          loadLocks();
        } catch (e) { toast(e.message, 'err', 9000); }
      } }, '🔒 Post & lock From–To');
      lockBox.replaceChildren(
        h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px' }, btnLock,
          h('span', { class: 'muted', style: 'font-size:12px' }, 'Lock the From–To dates once verified. Rows with a missing time out must be corrected first.')),
        rows.length
          ? h('div', { style: 'display:flex;flex-wrap:wrap;gap:6px' }, rows.map((r) => h('span', { class: 'badge ok', title: `Posted by ${r.posted_by_name || '?'} on ${r.posted_at}` },
            '🔒 ' + fdate(r.att_date), isAdmin ? h('button', { class: 'btn sm', type: 'button', style: 'margin-left:4px;padding:0 6px', title: 'Unpost (admin)', onclick: async () => {
              const reason = window.prompt(`Reason for unposting ${fdate(r.att_date)} (required, audit-logged):`);
              if (!reason || !reason.trim()) return;
              try { await post('attendance/day-posts/unpost', { date: r.att_date, reason: reason.trim() }); toast('Date unposted.'); loadLocks(); } catch (e) { toast(e.message, 'err', 8000); }
            } }, '✕') : null)))
          : h('div', { class: 'muted' }, 'No posted dates this month yet.'),
      );
    }

    setKeys({ save: run, load: loadExceptions, print: () => import('../core/dom.js').then((m) => m.openReport('daily_attendance', { date: form.get('from'), department_id: form.get('department_id') })) });

    root.append(
      h('div', { class: 'md', style: 'grid-template-columns:minmax(380px,1.3fr) minmax(300px,1fr)' },
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Post punches to daily attendance'), btnPost),
          h('div', { class: 'panel-body' }, form.el, result,
            h('ul', { class: 'muted', style: 'font-size:12px;margin:10px 0 0;padding-left:18px' },
              h('li', null, 'First punch = Time In, last punch = Time Out within the shift window (overnight shifts end the next morning).'),
              h('li', null, 'No punch on a working day = A; approved leave = L / LW; rest day = R; holiday = H.'),
              h('li', null, 'Manual voucher entries are kept unless "overwrite" is ticked. Posted salary months are never changed.'),
              h('li', null, 'Overtime candidates go to Overtime Approval.')))),
        h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, pendingBox))),
      h('div', { class: 'panel', style: 'margin-top:12px' }, h('div', { class: 'panel-head' }, h('h2', null, 'Verify & lock dates (Daily Attendance Post)')),
        h('div', { class: 'panel-body' }, lockBox)),
      h('div', { class: 'panel', style: 'margin-top:12px' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Review & fix'), filter,
          h('button', { class: 'btn', type: 'button', onclick: loadExceptions }, 'Show ', h('kbd', null, 'F7'))),
        h('div', { class: 'panel-body' }, grid.el, h('div', { class: 'grid-foot' }, count, h('span', { class: 'spacer' }), 'Double-click / Enter a row to correct it'))),
    );
    void lookups;
    await Promise.all([loadPending(), loadExceptions(), loadLocks()]);
  },
};
