// Reports & ID cards launcher. Each report opens as print-ready HTML in a new tab (Print / Save as PDF / CSV).
import { h, openReport, today, TYPES } from '../core/dom.js';
import { Form } from '../core/form.js';
import { setKeys } from '../core/keys.js';
import { opt } from '../core/store.js';

export default {
  mount(root) {
    const filterFields = () => [
      { name: 'department_id', label: 'Department', type: 'select', span: 3, options: () => opt.departments(true), blankLabel: 'All' },
      { name: 'designation_id', label: 'Designation', type: 'select', span: 3, options: () => opt.designations(true), blankLabel: 'All' },
      { name: 'emp_type', label: 'Type', type: 'select', span: 3, blankLabel: 'All', options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
      { name: 'status', label: 'Status', type: 'select', span: 3, blankLabel: 'All', options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
    ];

    const listForm = new Form(filterFields());
    listForm.values = { status: 'active' };
    const cardForm = new Form([
      ...filterFields(),
      { name: 'ids', label: 'Employee IDs (optional, comma separated Auto IDs)', span: 6, placeholder: 'e.g. 1,4,9 — blank = filters above' },
      { name: 'layout', label: 'Layout', type: 'select', required: true, span: 3,
        options: [{ value: 'sheet', label: 'A4 sheet (10 per page)' }, { value: 'cr80', label: 'Card printer (CR80)' }] },
      { name: 'issue_date', label: 'Issue date', type: 'date', span: 3 },
    ]);
    cardForm.values = { status: 'active', layout: 'sheet', issue_date: today() };

    const printList = () => openReport('employee_list', listForm.values);
    setKeys({ print: printList });

    root.append(
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Employee List Report'),
          h('button', { class: 'btn primary', type: 'button', onclick: printList }, 'Show / Print ', h('kbd', null, 'F9')),
          h('button', { class: 'btn', type: 'button', onclick: () => openReport('employee_list', { ...listForm.values, format: 'csv' }) }, 'Excel / CSV')),
        h('div', { class: 'panel-body' }, listForm.el,
          h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' }, 'A4 landscape, grouped by department with counts and salary totals.'))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Employee ID Cards'),
          h('button', { class: 'btn primary', type: 'button', onclick: () => openReport('id_cards', cardForm.values) }, 'Print ID Cards')),
        h('div', { class: 'panel-body' }, cardForm.el,
          h('p', { class: 'muted', style: 'margin:8px 0 0;font-size:12px' },
            'CR80 cards (85.6 × 54 mm). Front: company, photo, code, name, S/W/D/O, department, designation, type. ',
            'Back: address, CNIC, company address and a Code-128 barcode of the employee code (used by the barcode attendance kiosk). ',
            'Use "Save as PDF" in the print dialog for a PDF batch.'))),
    );
  },
};
