// Master data screens (Department, Designation, Shift, Shift Group, Holidays & weekly rest days):
// list on the left, entry form on the right, desktop function keys.
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, printTable, fdate, fdatetime, debounce, WEEKDAYS, today } from '../core/dom.js';
import { Form } from '../core/form.js';
import { EditGrid, DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, lookups, loadLookups, opt } from '../core/store.js';

const yesNo = (v) => h('span', { class: 'badge ' + (Number(v) ? 'ok' : 'off') }, Number(v) ? 'Active' : 'Inactive');
const weekdayOpts = WEEKDAYS.map((d, i) => ({ value: i, label: d }));
const hm = (min) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

const KINDS = {
  departments: {
    endpoint: 'departments', module: 'departments', singular: 'Department',
    columns: [
      { key: 'code', label: 'Code', sortable: true },
      { key: 'name', label: 'Name', sortable: true },
      { key: 'name_ur', label: 'اردو نام', urdu: true },
      { key: 'employee_count', label: 'Emp.', align: 'right', sortable: true },
      { key: 'is_active', label: 'Status', render: (r) => yesNo(r.is_active), print: (r) => (Number(r.is_active) ? 'Active' : 'Inactive') },
    ],
    fields: [
      { name: 'code', label: 'Code', required: true, span: 3, maxlength: 20 },
      { name: 'name', label: 'Department Name', required: true, span: 5, maxlength: 100 },
      { name: 'name_ur', label: 'اردو نام (Urdu)', urdu: true, span: 4, maxlength: 100 },
      { name: 'remarks', label: 'Remarks', span: 9, maxlength: 255 },
      { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
    ],
    defaults: { is_active: 1 },
  },
  designations: {
    endpoint: 'designations', module: 'designations', singular: 'Designation',
    columns: null, // same as departments
    fields: [
      { name: 'code', label: 'Code', required: true, span: 3, maxlength: 20 },
      { name: 'name', label: 'Designation', required: true, span: 5, maxlength: 100 },
      { name: 'name_ur', label: 'اردو نام (Urdu)', urdu: true, span: 4, maxlength: 100 },
      { name: 'remarks', label: 'Remarks', span: 9, maxlength: 255 },
      { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
    ],
    defaults: { is_active: 1 },
  },
  shifts: {
    endpoint: 'shifts', module: 'shifts', singular: 'Shift',
    columns: [
      { key: 'code', label: 'Code', sortable: true },
      { key: 'name', label: 'Name', sortable: true },
      { key: 'start_time', label: 'Start', render: (r) => r.start_time.slice(0, 5) },
      { key: 'end_time', label: 'End', render: (r) => r.end_time.slice(0, 5) + (Number(r.is_overnight) ? ' (+1)' : '') },
      { key: 'duration_minutes', label: 'Net', align: 'right', render: (r) => hm(r.duration_minutes) },
      { key: 'grace_minutes', label: 'Grace', align: 'right' },
      { key: 'is_active', label: 'Status', render: (r) => yesNo(r.is_active), print: (r) => (Number(r.is_active) ? 'Active' : 'Inactive') },
    ],
    fields: [
      { name: 'code', label: 'Code', required: true, span: 3, maxlength: 20 },
      { name: 'name', label: 'Shift Name', required: true, span: 6, maxlength: 60 },
      { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
      { name: 'start_time', label: 'Start Time', type: 'time', required: true, span: 3 },
      { name: 'end_time', label: 'End Time', type: 'time', required: true, span: 3, help: 'Earlier than start = overnight shift' },
      { name: 'break_minutes', label: 'Break (min)', type: 'number', required: true, span: 3, min: 0 },
      { name: 'grace_minutes', label: 'Grace (min)', type: 'number', required: true, span: 3, min: 0, help: 'Late allowed before marking late' },
      { name: 'half_day_minutes', label: 'Half-day below (min worked)', type: 'number', required: true, span: 4, min: 0, help: '0 = disabled' },
      { name: 'min_ot_minutes', label: 'Min. OT (min)', type: 'number', required: true, span: 3, min: 0, help: 'Extra time below this is not OT' },
      { name: 'summary', label: 'Computed', type: 'static', span: 5 },
      { name: 'remarks', label: 'Remarks', span: 12, maxlength: 255 },
    ],
    defaults: { is_active: 1, break_minutes: 60, grace_minutes: 10, half_day_minutes: 240, min_ot_minutes: 30 },
    onChange(form) {
      const v = form.values;
      if (!v.start_time || !v.end_time) { form.inputs.summary.textContent = ''; return; }
      const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const s = toMin(v.start_time), e = toMin(v.end_time);
      const span = e > s ? e - s : 1440 - s + e;
      const net = span - (v.break_minutes || 0);
      form.inputs.summary.textContent = `Span ${hm(span)} · Net ${hm(Math.max(0, net))}${e <= s ? ' · Overnight' : ''}`;
    },
  },
  shift_groups: {
    endpoint: 'shift-groups', module: 'shift_groups', singular: 'Shift group',
    columns: [
      { key: 'code', label: 'Code', sortable: true },
      { key: 'name', label: 'Name', sortable: true },
      { key: 'rotation', label: 'Rotation' },
      { key: 'employee_count', label: 'Emp.', align: 'right' },
      { key: 'is_active', label: 'Status', render: (r) => yesNo(r.is_active), print: (r) => (Number(r.is_active) ? 'Active' : 'Inactive') },
    ],
    fields: [
      { name: 'code', label: 'Code', required: true, span: 3, maxlength: 20 },
      { name: 'name', label: 'Group Name', required: true, span: 6, maxlength: 60 },
      { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
      { name: 'rest_days', label: 'Weekly rest days (empty = company default)', type: 'checks', options: weekdayOpts, span: 12 },
      { name: 'remarks', label: 'Remarks', span: 12, maxlength: 255 },
    ],
    defaults: { is_active: 1, rest_days: [] },
    extra(page) {
      page.steps = new EditGrid({
        columns: [
          { key: 'shift_id', label: 'Shift', type: 'select', options: () => opt.shifts(true), numeric: true },
          { key: 'days', label: 'Days', type: 'number', width: '90px', min: 1 },
        ],
        onChange: () => { page.form.markDirty(); },
      });
      return h('div', { style: 'margin-top:12px' },
        h('div', { class: 'form-section', style: 'margin-bottom:6px' }, 'Rotation (in order) — employee\'s "Shift Date" is day 1 of the first row'),
        page.steps.el);
    },
    load(page, rec) { page.steps.setRows(rec?.steps?.length ? rec.steps : [{ shift_id: null, days: 7 }]); },
    collect(page, values) { return { ...values, steps: page.steps.rows }; },
  },
  holidays: {
    endpoint: 'holidays', module: 'holidays', singular: 'Holiday', yearFilter: true,
    columns: [
      { key: 'holiday_date', label: 'Date', sortable: true, render: (r) => fdate(r.holiday_date), print: (r) => fdate(r.holiday_date) },
      { key: 'day', label: 'Day', render: (r) => WEEKDAYS[new Date(r.holiday_date + 'T00:00:00').getDay()], print: (r) => WEEKDAYS[new Date(r.holiday_date + 'T00:00:00').getDay()] },
      { key: 'name', label: 'Holiday', sortable: true },
      { key: 'name_ur', label: 'اردو', urdu: true },
      { key: 'holiday_type', label: 'Type', render: (r) => r.holiday_type[0].toUpperCase() + r.holiday_type.slice(1) },
      { key: 'is_paid', label: 'Paid', render: (r) => (Number(r.is_paid) ? 'Yes' : 'No'), print: (r) => (Number(r.is_paid) ? 'Yes' : 'No') },
    ],
    fields: [
      { name: 'holiday_date', label: 'Date', type: 'date', required: true, span: 4 },
      { name: 'holiday_type', label: 'Type', type: 'select', required: true, span: 4,
        options: [{ value: 'gazetted', label: 'Gazetted (public)' }, { value: 'company', label: 'Company' }, { value: 'other', label: 'Other' }] },
      { name: 'is_paid', label: 'Paid holiday', type: 'checkbox', span: 4 },
      { name: 'name', label: 'Holiday Name', required: true, span: 6, maxlength: 100 },
      { name: 'name_ur', label: 'اردو نام (Urdu)', urdu: true, span: 6, maxlength: 100 },
    ],
    defaults: { holiday_type: 'gazetted', is_paid: 1 },
    top(page) {
      const restForm = new Form([{ name: 'weekly_rest_days', label: 'Weekly rest days (company default)', type: 'checks', options: weekdayOpts, span: 9 }]);
      restForm.values = { weekly_rest_days: lookups.settings.weekly_rest_days || [] };
      const btn = h('button', { class: 'btn', type: 'button', disabled: !can('holidays', 'edit'), onclick: async () => {
        try {
          await put('settings/rest-days', restForm.values);
          await loadLookups();
          restForm.dirty = false;
          toast('Weekly rest days saved.');
        } catch (e) { restForm.showErrors(e.errors, e.message); }
      } }, 'Save rest days');
      page.restForm = restForm;
      return h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-body', style: 'display:flex;gap:12px;align-items:end;flex-wrap:wrap' },
        h('div', { style: 'flex:1;min-width:260px' }, restForm.el), btn,
        h('div', { class: 'muted', style: 'font-size:12px;flex-basis:100%' }, 'Shift groups can override these days. Rest days are marked "R" in attendance.')));
    },
  },
};
KINDS.designations.columns = KINDS.departments.columns;
KINDS.leave_types = {
  endpoint: 'leave-types', module: 'leave', singular: 'Leave type',
  columns: [
    { key: 'code', label: 'Code', sortable: true },
    { key: 'name', label: 'Leave type', sortable: true },
    { key: 'name_ur', label: 'اردو', urdu: true },
    { key: 'yearly_quota', label: 'Quota / year', align: 'right', render: (r) => Number(r.yearly_quota) || '—', print: (r) => Number(r.yearly_quota) || '' },
    { key: 'is_paid', label: 'Paid', render: (r) => (Number(r.is_paid) ? 'Yes (L)' : 'No (LW)'), print: (r) => (Number(r.is_paid) ? 'Yes' : 'No') },
    { key: 'is_active', label: 'Status', render: (r) => yesNo(r.is_active), print: (r) => (Number(r.is_active) ? 'Active' : 'Inactive') },
  ],
  fields: [
    { name: 'code', label: 'Code', required: true, span: 3, maxlength: 10 },
    { name: 'name', label: 'Leave type', required: true, span: 5, maxlength: 60 },
    { name: 'name_ur', label: 'اردو نام (Urdu)', urdu: true, span: 4, maxlength: 60 },
    { name: 'yearly_quota', label: 'Yearly quota (days)', type: 'number', required: true, span: 4, min: 0, help: '0 = no limit' },
    { name: 'is_paid', label: 'Paid leave (marks L, else LW)', type: 'checkbox', span: 5 },
    { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
  ],
  defaults: { is_active: 1, is_paid: 1, yearly_quota: 0 },
};
KINDS.devices = {
  endpoint: 'devices', module: 'devices', singular: 'Device',
  columns: [
    { key: 'serial_no', label: 'Serial no.', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'location', label: 'Location' },
    { key: 'last_seen_at', label: 'Last seen', render: (r) => fdatetime(r.last_seen_at), print: (r) => fdatetime(r.last_seen_at) },
    { key: 'punch_count', label: 'Punches', align: 'right' },
    { key: 'is_active', label: 'Status', render: (r) => yesNo(r.is_active), print: (r) => (Number(r.is_active) ? 'Active' : 'Inactive') },
  ],
  fields: [
    { name: 'serial_no', label: 'Serial number (SN)', required: true, span: 5, maxlength: 50, help: 'Menu → System Info → Device Info on the ZKTeco device' },
    { name: 'name', label: 'Name', required: true, span: 4, maxlength: 60 },
    { name: 'is_active', label: 'Active (accept punches)', type: 'checkbox', span: 3 },
    { name: 'location', label: 'Location', span: 12, maxlength: 100 },
  ],
  defaults: { is_active: 1 },
  top() {
    const box = h('div', { class: 'panel-body' }, 'Loading…');
    const render = (s) => {
      const abs = (u) => new URL(u, location.href).href;
      const link = (label, url, which) => h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px' },
        h('b', { style: 'width:150px' }, label),
        h('input', { class: 'input', readonly: true, value: abs(url), style: 'flex:1;min-width:260px', onclick: (e) => e.target.select() }),
        h('a', { class: 'btn sm', href: abs(url), target: '_blank' }, 'Open'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => navigator.clipboard?.writeText(abs(url)).then(() => toast('Link copied.')) }, 'Copy'),
        can('devices', 'edit') ? h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
          if (!(await confirmDialog(`Create a new ${label} link? The old link stops working immediately.`, { ok: 'Regenerate', danger: true }))) return;
          render(await post('attendance/screens/regenerate', { which }));
          toast('New link created.');
        } }, 'Regenerate') : null);
      box.replaceChildren(
        link('Barcode kiosk', s.kiosk_url, 'kiosk'),
        link('Live TV screen', s.tv_url, 'tv'),
        h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px;line-height:1.6' },
          h('b', null, 'ZKTeco push (ADMS) setup: '), 'on the device open Comm. → Cloud Server Setting: Server address = ',
          h('code', null, location.hostname), ', port 80 (443 only if the model supports HTTPS), Domain name mode on, proxy off. ',
          'The device calls ', h('code', null, abs('iclock/cdata')), '. A new device appears below as inactive — tick Active to accept its punches. ',
          'Enter each employee\'s enrollment number as Machine ID on the employee record. Set the device clock / timezone to Pakistan (UTC+5).'));
    };
    get('attendance/screens').then(render).catch((e) => { box.textContent = e.message; });
    return h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-head' }, h('h2', null, 'Kiosk, TV screen & machine push')), box);
  },
};


export default {
  async mount(root, params, meta) {
    const cfg = KINDS[meta.kind];
    const page = { cfg, rows: [], current: null };
    const canAdd = can(cfg.module, 'add');
    const canEdit = can(cfg.module, 'edit');
    const canDel = can(cfg.module, 'delete');

    page.form = new Form(cfg.fields, { onChange: () => cfg.onChange?.(page.form) });
    const extra = cfg.extra?.(page);

    // ---- list
    const search = h('input', { class: 'input', type: 'search', placeholder: 'Search (F1)…', style: 'flex:1' });
    const year = cfg.yearFilter ? h('select', { class: 'input', style: 'width:110px' },
      Array.from({ length: 6 }, (_, i) => Number(today().slice(0, 4)) - 2 + i).map((y) => h('option', { value: y }, y))) : null;
    if (year) year.value = today().slice(0, 4);
    const activeOnly = cfg.yearFilter ? null : h('label', { class: 'nowrap', style: 'font-size:12px' }, h('input', { type: 'checkbox' }), ' Active only');
    const grid = new DataGrid({
      columns: cfg.columns,
      onSelect: (r) => open(r.id),
      onOpen: () => page.form.focus(),
      rowClass: (r) => (r.is_active !== undefined && !Number(r.is_active) ? 'dim' : ''),
    });
    const count = h('span');

    async function loadList(keepId) {
      page.rows = await get(cfg.endpoint, {
        q: search.value.trim(), year: year?.value, active: activeOnly?.querySelector('input').checked ? 1 : '',
      });
      grid.setRows(page.rows);
      count.textContent = `${page.rows.length} record(s)`;
      if (keepId) grid.selectBy((r) => r.id === keepId, false);
    }
    search.addEventListener('input', debounce(() => loadList(page.current?.id), 250));
    year?.addEventListener('change', () => loadList());
    activeOnly?.addEventListener('change', () => loadList(page.current?.id));

    // ---- form actions
    const recLabel = h('span', { class: 'rec' });
    const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save ', h('kbd', null, 'F10'));
    const btnDel = h('button', { class: 'btn danger', type: 'button', onclick: () => remove() }, 'Delete ', h('kbd', null, 'F12'));

    function setRecord(rec) {
      page.current = rec;
      page.form.values = rec || cfg.defaults || {};
      cfg.load?.(page, rec);
      cfg.onChange?.(page.form);
      recLabel.textContent = rec ? `Editing: ${rec.code || rec.serial_no || fdate(rec.holiday_date)} — ${rec.name}` : `New ${cfg.singular.toLowerCase()}`;
      btnSave.disabled = rec ? !canEdit : !canAdd;
      btnDel.disabled = !rec || !canDel;
      page.form.setReadonly(rec ? !canEdit : !canAdd);
    }

    async function confirmDiscard() {
      if (!page.form.dirty) return true;
      return confirmDialog('Discard unsaved changes?', { ok: 'Discard', danger: true });
    }

    async function open(id) {
      if (page.current?.id === id) return;
      if (!(await confirmDiscard())) { grid.selectBy((r) => r.id === page.current?.id, false); return; }
      setRecord(await get(`${cfg.endpoint}/${id}`));
    }

    async function newRecord() {
      if (!(await confirmDiscard())) return;
      grid.selectBy(() => false, false);
      setRecord(null);
      page.form.focus();
    }

    async function save() {
      if (btnSave.disabled) return;
      let body = page.form.values;
      if (cfg.collect) body = cfg.collect(page, body);
      try {
        const rec = page.current ? await put(`${cfg.endpoint}/${page.current.id}`, body) : await post(cfg.endpoint, body);
        toast(`${cfg.singular} saved.`);
        setRecord(rec);
        await Promise.all([loadList(rec.id), loadLookups()]);
      } catch (e) {
        page.form.showErrors(e.errors, e.errors && Object.keys(e.errors).length ? '' : e.message);
      }
    }

    async function remove() {
      if (!page.current || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete ${cfg.singular.toLowerCase()} "${page.current.name}"?`, { ok: 'Delete', danger: true }))) return;
      try {
        await del(`${cfg.endpoint}/${page.current.id}`);
        toast(`${cfg.singular} deleted.`);
        page.form.dirty = false;
        setRecord(null);
        await Promise.all([loadList(), loadLookups()]);
      } catch (e) { toast(e.message, 'err', 6000); }
    }

    async function step(dir) {
      if (!page.rows.length) return;
      const i = grid.index < 0 ? (dir > 0 ? 0 : page.rows.length - 1) : grid.index + dir;
      if (i < 0 || i >= page.rows.length) return;
      grid.select(i);
    }

    const print = () => printTable(meta.title, [{ key: '#', label: 'Sr', align: 'right' }, ...cfg.columns], page.rows,
      year ? `Year ${year.value}` : '');

    setKeys({
      new: newRecord, save, del: remove, print, load: () => loadList(page.current?.id),
      search: () => search.focus(), prev: () => step(-1), next: () => step(1),
    });

    root.append(
      cfg.top?.(page) || '',
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !canAdd, onclick: newRecord }, 'New ', h('kbd', null, 'F5')),
        btnSave, btnDel,
        h('span', { class: 'sep' }),
        h('button', { class: 'btn icon', type: 'button', title: 'Previous (PgUp)', onclick: () => step(-1) }, '◀'),
        h('button', { class: 'btn icon', type: 'button', title: 'Next (PgDn)', onclick: () => step(1) }, '▶'),
        h('button', { class: 'btn', type: 'button', onclick: () => loadList(page.current?.id) }, h('span', { class: 'lbl' }, 'Refresh '), h('kbd', null, 'F7')),
        h('button', { class: 'btn', type: 'button', onclick: print }, h('span', { class: 'lbl' }, 'Print '), h('kbd', null, 'F9')),
        h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md' },
        h('div', null,
          h('div', { class: 'filters' }, search, year, activeOnly),
          grid.el,
          h('div', { class: 'grid-foot' }, count, h('span', { class: 'spacer' }), '↑↓ select · Enter edit')),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, `${cfg.singular} details`)),
          h('div', { class: 'panel-body' }, page.form.el, extra || ''))),
    );

    setRecord(null);
    await loadList();
    page.form.focus();
    return {
      canLeave: () => !page.form.dirty && !page.restForm?.dirty,
    };
  },
};
