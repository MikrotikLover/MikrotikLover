// Reports launcher. Each report opens as print-ready HTML in a new tab (Print / Save as PDF / Excel-CSV).
// Only the reports the user may print are shown.
import { get } from '../core/api.js';
import { h, openReport, today, TYPES } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { can, lookups, opt } from '../core/store.js';

const month = () => today().slice(0, 7);
const firstOfMonth = () => today().slice(0, 8) + '01';
const dept = (span = 3) => ({ name: 'department_id', label: 'Department', type: 'select', span, options: () => opt.departments(true), blankLabel: 'All' });
const empType = (span = 3) => ({ name: 'emp_type', label: 'Type', type: 'select', span, blankLabel: 'All', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) });
const range = [{ name: 'from', label: 'From', type: 'date', span: 3 }, { name: 'to', label: 'To', type: 'date', span: 3 }];
const STATUSES = [['P', 'Present'], ['A', 'Absent'], ['L', 'Leave'], ['LW', 'Leave w/o pay'], ['HD', 'Half day'], ['R', 'Rest'], ['H', 'Holiday'], ['none', 'Not marked']];

const REPORTS = [
  { group: 'Employees', key: 'employee_list', title: 'Employee List', perm: ['employees', 'print'], csv: true,
    desc: 'A4 landscape, grouped by department with counts and salary totals.',
    fields: [dept(), { name: 'designation_id', label: 'Designation', type: 'select', span: 3, options: () => opt.designations(true), blankLabel: 'All' }, empType(),
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] }],
    defaults: { status: 'active' } },
  { group: 'Employees', key: 'id_cards', title: 'Employee ID Cards', perm: ['employees', 'print'], button: 'Print ID Cards',
    desc: 'CR80 (85.6 × 54 mm). Back side carries a Code-128 barcode of the employee code for the barcode kiosk. Use "Save as PDF" for a PDF batch.',
    fields: [dept(), empType(), { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
      { name: 'issue_date', label: 'Issue date', type: 'date', span: 3 },
      { name: 'ids', label: 'Employee IDs (optional, comma separated Auto IDs)', span: 6, placeholder: 'e.g. 1,4,9 — blank = filters' },
      { name: 'layout', label: 'Layout', type: 'select', required: true, span: 6, options: [{ value: 'sheet', label: 'A4 sheet (10 per page, duplex backs)' }, { value: 'cr80', label: 'Card printer (one card per page)' }] }],
    defaults: () => ({ status: 'active', layout: 'sheet', issue_date: today() }) },
  { group: 'Attendance', key: 'daily_attendance', title: 'Daily Attendance Report', perm: ['attendance', 'print'], csv: true,
    desc: 'All employees for a date with shift, time in/out, hours, late, early, OT and status, grouped by department.',
    fields: [{ name: 'date', label: 'Date', type: 'date', required: true, span: 3 }, dept(), empType(),
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: STATUSES.map(([value, label]) => ({ value, label })) }],
    defaults: () => ({ date: today() }) },
  { group: 'Attendance', key: 'monthly_attendance', title: 'Monthly Attendance Sheet', perm: ['attendance', 'print'], csv: true,
    desc: 'Employees × days 1–31 with weekday headers, status codes, totals per employee and daily present count per department (A4 landscape).',
    fields: [{ name: 'month', label: 'Month', type: 'month', required: true, span: 3 }, dept(), empType(),
      { name: 'include_inactive', label: 'Include inactive without leaving date', type: 'checkbox', span: 3 }],
    defaults: () => ({ month: month() }) },
  { group: 'Attendance', key: 'employee_attendance', title: 'Employee-wise Monthly Attendance', perm: ['attendance', 'print'], csv: true,
    desc: 'Vr#, date, time in, time out, hours, approved OT, status and description per day. Enter an employee code, or pick a department for all its employees (one per page).',
    fields: [{ name: 'code', label: 'Employee code', span: 3 }, dept(), { name: 'month', label: 'Month', type: 'month', required: true, span: 3 }],
    defaults: () => ({ month: month() }) },
  { group: 'Attendance', key: 'shift_attendance', title: 'Shift-wise Attendance', perm: ['attendance', 'print'], csv: true,
    desc: 'Employees grouped by the shift they worked, with hours and late time.',
    fields: [...range, { name: 'shift_id', label: 'Shift', type: 'select', span: 3, options: () => opt.shifts(true), blankLabel: 'All' }, dept()],
    defaults: () => ({ from: today(), to: today() }) },
  { group: 'Attendance', key: 'late_comers', title: 'Late-comers Report', perm: ['attendance', 'print'], csv: true,
    desc: 'Late arrivals beyond the shift grace time, with count and total late time per employee.',
    fields: [...range, dept(), { name: 'min_late', label: 'Late at least (min)', type: 'number', span: 3, min: 1 }],
    defaults: () => ({ from: firstOfMonth(), to: today() }) },
  { group: 'Attendance', key: 'overtime', title: 'Overtime Report', perm: ['overtime', 'print'], csv: true,
    desc: 'Computed vs approved overtime per day (detail) or per employee (summary), grouped by department.',
    fields: [...range, dept(), { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All',
      options: [{ value: 'approved', label: 'Approved' }, { value: 'pending', label: 'Pending' }, { value: 'rejected', label: 'Rejected' }] },
      { name: 'mode', label: 'Layout', type: 'select', required: true, span: 3, options: [{ value: 'detail', label: 'Detail (per day)' }, { value: 'summary', label: 'Summary (per employee)' }] }],
    defaults: () => ({ from: firstOfMonth(), to: today(), status: 'approved', mode: 'detail' }) },
  { group: 'Attendance', key: 'leave_register', title: 'Leave Register', perm: ['leave', 'print'], csv: true,
    desc: 'Leave applications for a year by department.',
    fields: [{ name: 'year', label: 'Year', type: 'number', required: true, span: 3, min: 2000, max: 2100 }, dept(),
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: ['approved', 'pending', 'rejected', 'cancelled'].map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) }],
    defaults: () => ({ year: Number(today().slice(0, 4)), status: 'approved' }) },
  { group: 'Accounts', key: 'vouchers', title: 'Advance / Incentive / Penalty / Overtime Vouchers', perm: ['vouchers', 'print'], csv: true,
    desc: 'Vouchers grouped by department with totals. Pick the salary month, or leave it empty and use the date range.',
    fields: [{ name: 'type', label: 'Voucher', type: 'select', required: true, span: 3,
      options: [{ value: 'ADV', label: 'Advance salary' }, { value: 'INC', label: 'Incentive' }, { value: 'PEN', label: 'Penalty' }, { value: 'OT', label: 'Overtime voucher' }] },
      { name: 'month', label: 'Salary month', type: 'month', span: 3 }, ...range.map((f) => ({ ...f, span: 3 })), dept(),
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'posted', label: 'Posted' }, { value: 'draft', label: 'Draft' }] }],
    defaults: () => ({ type: 'ADV', month: month(), status: 'posted', from: firstOfMonth(), to: today() }) },
  { group: 'Accounts', key: 'loans', title: 'Loan Report (outstanding balances)', perm: ['loans', 'print'], csv: true,
    desc: 'Posted loans with amount, installment, deducted, balance, next due month; optional installment schedule per loan.',
    fields: [{ name: 'status', label: 'Loans', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'active', label: 'Active (outstanding)' }, { value: 'closed', label: 'Closed' }] }, dept(),
      { name: 'detail', label: 'Show installment schedule', type: 'checkbox', span: 3 }],
    defaults: { status: 'active' } },
  { group: 'Accounts', key: 'journal', title: 'Journal Voucher Report', perm: ['journal', 'print'], csv: true,
    desc: 'Journal vouchers with their debit / credit lines and totals.',
    fields: [...range, { name: 'account_id', label: 'Account', type: 'select', span: 3, blankLabel: 'All', options: () => lookups.accounts.map((a) => ({ value: a.id, label: `${a.code} - ${a.name}` })) },
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'posted', label: 'Posted' }, { value: 'draft', label: 'Draft' }] }],
    defaults: () => ({ from: firstOfMonth(), to: today(), status: 'posted' }) },
  { group: 'Accounts', key: 'daybook', title: 'Day Book', perm: ['vouchers', 'print'], csv: true,
    desc: 'Every voucher by date: journal lines for advances, loans and JVs; salary adjustments for incentives, penalties and overtime.',
    fields: [...range, { name: 'include_drafts', label: 'Include drafts', type: 'checkbox', span: 3 }],
    defaults: () => ({ from: firstOfMonth(), to: today() }) },
  ...[['salary_sheet', 'Salary Sheet', 'A4 landscape, grouped by department with sub-totals, grand total, paid date and signature column.', true],
    ['payslips', 'Payslips (English / Urdu)', 'Two payslips per A4 page with attendance, earnings, deductions and net salary in words. Pick a department or print all.', false],
    ['salary_bank', 'Bank Transfer List', 'Employees paid by bank: CNIC, bank, account number and net salary. CSV for the bank portal.', true],
    ['salary_departments', 'Department Salary Summary', 'Head count, gross, each deduction and net salary per department; cash / bank split.', true],
  ].map(([key, title, desc, csv]) => ({
    group: 'Payroll', key, title, desc, csv, perm: ['salary', 'print'],
    fields: [{ name: 'id', label: 'Salary sheet', type: 'select', required: true, span: 6, numeric: true, blankLabel: '— choose —',
      options: () => salarySheets.map((x) => ({ value: x.id, label: `${new Date(x.salary_month + 'T12:00:00').toLocaleString('en-GB', { month: 'long', year: 'numeric' })} — ${x.sheet_type === 'daily_wages' ? 'Daily Wages' : 'Permanent'} (${x.status})` })) },
    ...(key === 'salary_bank' ? [] : [dept()])],
    defaults: () => ({ id: salarySheets[0]?.id || '' }),
  })),
];

export function canAnyReport() {
  return REPORTS.some((r) => can(...r.perm) || (can('reports', 'print') && can(r.perm[0], 'view')));
}

let salarySheets = [];

export default {
  async mount(root) {
    if (can('salary', 'view')) salarySheets = await get('salary/sheets').catch(() => []);
    const visible = REPORTS.filter((r) => can(...r.perm) || (can('reports', 'print') && can(r.perm[0], 'view')));
    let first = null;
    let group = null;
    for (const r of visible) {
      if (r.group !== group) {
        group = r.group;
        root.append(h('h3', { style: 'margin:14px 0 8px;font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)' }, group));
      }
      const form = new Form(r.fields);
      form.values = typeof r.defaults === 'function' ? r.defaults() : (r.defaults || {});
      const params = () => {
        const v = form.values;
        for (const k of ['include_inactive', 'include_drafts', 'detail']) if (v[k] === 0) delete v[k];
        return v;
      };
      const show = () => openReport(r.key, params());
      first ||= show;
      form.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) show(); });
      root.append(h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, r.title),
          h('button', { class: 'btn primary', type: 'button', onclick: show }, r.button || 'Show / Print'),
          r.csv ? h('button', { class: 'btn', type: 'button', onclick: () => openReport(r.key, { ...params(), format: 'csv' }) }, 'Excel / CSV') : null),
        h('div', { class: 'panel-body' }, form.el, h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' }, r.desc))));
    }
    if (!visible.length) root.append(h('div', { class: 'panel panel-body' }, 'You do not have permission to print any report.'));
    setKeys({ print: () => first?.() });
  },
};
