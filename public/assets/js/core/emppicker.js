// Employee search dialog + keyboard picker (type code + Enter, or F2 / 🔍 to search by name).
import { get } from './api.js';
import { h, modal, debounce } from './dom.js';
import { DataGrid } from './grid.js';

/** Opens the find-employee dialog; resolves to the chosen list row or null. */
export function searchEmployee({ title = 'Find employee', status = '' } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Code, name, CNIC, cell, machine ID…' });
    const grid = new DataGrid({
      columns: [
        { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'name_ur', label: 'نام', urdu: true },
        { key: 'department', label: 'Department' }, { key: 'designation', label: 'Designation' }, { key: 'status', label: 'Status' },
      ],
      maxHeight: '50vh',
      onOpen: (r) => { chosen = r; m.close(); },
    });
    const run = debounce(async () => grid.setRows((await get('employees', { q: input.value.trim(), per_page: 100, status })).rows), 200);
    input.addEventListener('input', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); grid.focus(); }
      if (e.key === 'Enter') { e.preventDefault(); if (grid.rows.length) grid.o.onOpen(grid.rows[0]); }
    });
    const m = modal({ title, body: h('div', null, input, h('div', { style: 'margin-top:8px' }, grid.el)), wide: true, onClose: () => resolve(chosen) });
    run();
  });
}

/**
 * Employee picker field: code input + name label. Enter / blur looks the code up, F2 or the button searches.
 * picker.value -> employee id (or null); picker.employee -> row; picker.set(row); onChange(row)
 */
export class EmployeePicker {
  constructor({ label = 'Employee', onChange, required = false, span = 6 } = {}) {
    this.employee = null;
    this.onChange = onChange;
    this.code = h('input', { class: 'input', placeholder: 'Code', style: 'width:110px;flex:none', autocomplete: 'off' });
    this.nameEl = h('div', { class: 'input', style: 'flex:1;display:flex;align-items:center;background:#f3f4f6;overflow:hidden;white-space:nowrap' });
    this.btn = h('button', { class: 'btn icon', type: 'button', title: 'Search (F2)', onclick: () => this.search() }, '🔍');
    this.msg = h('div', { class: 'msg hidden' });
    this.el = h('div', { class: `fld s${span}${required ? ' req' : ''}` },
      h('label', null, label), h('div', { style: 'display:flex;gap:4px' }, this.code, this.nameEl, this.btn), this.msg);
    this.code.addEventListener('keydown', (e) => {
      if (e.key === 'F2') { e.preventDefault(); this.search(); }
      if (e.key === 'Enter' && this.code.value.trim() && this.code.value.trim() !== this.employee?.code) {
        e.preventDefault();
        e.stopPropagation();
        this.lookup();
      }
    });
    this.code.addEventListener('change', () => this.lookup());
  }

  async lookup() {
    const code = this.code.value.trim();
    if (!code) { this.set(null); return; }
    if (code === this.employee?.code) return;
    const row = await get('employees/lookup', { code });
    if (!row) {
      this.employee = null;
      this.nameEl.textContent = '';
      this.error(`No employee with code "${code}".`);
      this.onChange?.(null);
      return;
    }
    this.set(row, true);
  }

  async search() {
    const row = await searchEmployee();
    if (row) this.set(row, true);
    this.code.focus();
  }

  set(row, notify = false) {
    this.employee = row || null;
    this.code.value = row?.code || '';
    this.nameEl.textContent = row ? `${row.name}${row.department ? ' · ' + row.department : ''}` : '';
    this.error('');
    if (notify) this.onChange?.(this.employee);
  }

  error(msg) {
    this.el.classList.toggle('err', !!msg);
    this.msg.textContent = msg;
    this.msg.classList.toggle('hidden', !msg);
  }

  get value() { return this.employee?.id ?? null; }
  focus() { this.code.focus(); this.code.select(); }
  setReadonly(ro) { this.code.readOnly = ro; this.btn.disabled = ro; }
}
