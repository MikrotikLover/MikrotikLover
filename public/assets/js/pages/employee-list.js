// List of Employees: filters, server-side search/sort/paging, select rows -> ID cards, Employee List report.
import { get } from '../core/api.js';
import { h, money, fdate, openReport, debounce, toast, TYPES } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { go } from '../core/router.js';
import { can, opt } from '../core/store.js';

export default {
  async mount(root) {
    const st = { page: 1, perPage: 100, total: 0, sort: { key: 'code', dir: 'asc' } };
    const filters = new Form([
      { name: 'q', label: 'Search (F1)', span: 4, placeholder: 'Code, name, CNIC, cell, machine ID…' },
      { name: 'department_id', label: 'Department', type: 'select', span: 2, options: () => opt.departments(true), blankLabel: 'All' },
      { name: 'designation_id', label: 'Designation', type: 'select', span: 2, options: () => opt.designations(true), blankLabel: 'All' },
      { name: 'emp_type', label: 'Type', type: 'select', span: 2, blankLabel: 'All', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
      { name: 'status', label: 'Status', type: 'select', span: 2, blankLabel: 'All', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ]);
    filters.values = { status: 'active' };

    const selInfo = h('span');
    const grid = new DataGrid({
      checkable: true,
      sort: st.sort,
      columns: [
        { key: 'id', label: 'ID', align: 'right', sortable: true },
        { key: 'code', label: 'Code', sortable: true },
        { key: 'name', label: 'Name', sortable: true },
        { key: 'name_ur', label: 'نام', urdu: true },
        { key: 'father_name', label: 'S/W/D/O', render: (r) => (r.father_name ? `${r.relation} ${r.father_name}` : '') },
        { key: 'department', label: 'Department', sortable: true },
        { key: 'designation', label: 'Designation', sortable: true },
        { key: 'emp_type', label: 'Type', render: (r) => TYPES[r.emp_type] },
        { key: 'cnic', label: 'CNIC' },
        { key: 'cell', label: 'Cell' },
        { key: 'joining_date', label: 'Joining', sortable: true, render: (r) => fdate(r.joining_date) },
        { key: 'shift_group', label: 'Shift Grp' },
        { key: 'salary', label: 'Salary / Rate', align: 'right', render: (r) => money(r.emp_type === 'daily_wages' ? r.daily_rate : r.basic_salary) },
        { key: 'status', label: 'Status', render: (r) => h('span', { class: 'badge ' + (r.status === 'active' ? 'ok' : 'off') }, r.status === 'active' ? 'Active' : 'Inactive') },
      ],
      rowClass: (r) => (r.status === 'inactive' ? 'dim' : ''),
      onOpen: (r) => go(`/employees/${r.id}`),
      onSort: (key, dir) => { st.sort = { key, dir }; st.page = 1; load(); },
      onCheck: (set) => { selInfo.textContent = set.size ? `${set.size} selected` : ''; },
      emptyText: 'No employees match the filters.',
    });

    const info = h('span');
    const btnPrev = h('button', { class: 'btn sm', type: 'button', onclick: () => { st.page--; load(); } }, '‹ Prev');
    const btnNext = h('button', { class: 'btn sm', type: 'button', onclick: () => { st.page++; load(); } }, 'Next ›');

    async function load() {
      const f = filters.values;
      const d = await get('employees', { ...f, page: st.page, per_page: st.perPage, sort: st.sort.key, dir: st.sort.dir });
      st.total = d.total;
      grid.setRows(d.rows);
      const from = d.total ? (st.page - 1) * st.perPage + 1 : 0;
      info.textContent = `${from}–${Math.min(st.page * st.perPage, d.total)} of ${d.total}`;
      btnPrev.disabled = st.page <= 1;
      btnNext.disabled = st.page * st.perPage >= d.total;
      selInfo.textContent = '';
    }
    const reload = debounce(() => { st.page = 1; load(); }, 250);
    filters.el.addEventListener('input', reload);
    filters.el.addEventListener('change', reload);

    const reportParams = () => {
      const f = filters.values;
      return { q: f.q, department_id: f.department_id, designation_id: f.designation_id, emp_type: f.emp_type, status: f.status };
    };
    const printList = () => openReport('employee_list', reportParams());
    const exportCsv = () => openReport('employee_list', { ...reportParams(), format: 'csv' });
    const printCards = (layout = 'sheet') => {
      const ids = [...grid.checked];
      if (!ids.length && !st.total) { toast('No employees to print.', 'warn'); return; }
      if (!ids.length && st.total > 200) { toast('Select employees (tick boxes) or narrow the filters to 200 or fewer for ID cards.', 'warn', 6000); return; }
      openReport('id_cards', ids.length ? { ids: ids.join(','), layout } : { ...reportParams(), layout });
    };

    setKeys({
      new: () => can('employees', 'add') && go('/employees/new'),
      search: () => filters.focus('q'),
      load,
      print: printList,
      prev: () => !btnPrev.disabled && btnPrev.click(),
      next: () => !btnNext.disabled && btnNext.click(),
    });

    const canPrint = can('employees', 'print');
    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !can('employees', 'add'), onclick: () => go('/employees/new') }, 'New ', h('kbd', null, 'F5')),
        h('button', { class: 'btn', type: 'button', onclick: () => grid.current() && go(`/employees/${grid.current().id}`) }, 'Open'),
        h('button', { class: 'btn', type: 'button', onclick: load }, h('span', { class: 'lbl' }, 'Show '), h('kbd', null, 'F7')),
        h('span', { class: 'sep' }),
        h('button', { class: 'btn', type: 'button', disabled: !canPrint, onclick: printList }, 'Print List ', h('kbd', null, 'F9')),
        h('button', { class: 'btn', type: 'button', disabled: !canPrint, onclick: exportCsv }, 'Excel / CSV'),
        h('button', { class: 'btn', type: 'button', disabled: !canPrint, onclick: () => printCards('sheet') }, 'ID Cards (A4)'),
        h('button', { class: 'btn', type: 'button', disabled: !canPrint, onclick: () => printCards('cr80') }, 'ID Cards (card printer)'),
        h('span', { class: 'spacer' }), selInfo),
      h('div', { class: 'panel', style: 'margin-bottom:10px' }, h('div', { class: 'panel-body' }, filters.el)),
      grid.el,
      h('div', { class: 'grid-foot' }, info, h('span', { class: 'spacer' }),
        'Space = tick · Enter = open · ID cards print ticked rows (or all filtered rows)', btnPrev, btnNext),
    );
    filters.inputs.q.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); grid.focus(); } });
    await load();
    filters.focus('q');
  },
};
