// DataGrid (read-only list with keyboard navigation, sorting, checkboxes) and
// EditGrid (spreadsheet-like repeatable rows with Enter-to-next-cell).
import { h } from './dom.js';

/**
 * new DataGrid({columns:[{key,label,align,render(row),sortable,urdu,width}], onOpen(row), onSelect(row),
 *               checkable, rowClass(row), sort:{key,dir}, onSort(key,dir), emptyText})
 */
export class DataGrid {
  constructor(opts) {
    this.o = opts;
    this.rows = [];
    this.index = -1;
    this.checked = new Set();
    this.sort = opts.sort || null;
    this.thead = h('thead');
    this.tbody = h('tbody');
    this.table = h('table', { class: 'grid' }, this.thead, this.tbody);
    this.el = h('div', { class: 'grid-wrap', tabindex: 0 }, this.table);
    if (opts.maxHeight) this.el.style.maxHeight = opts.maxHeight;
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    this.renderHead();
  }

  renderHead() {
    const cells = [];
    if (this.o.checkable) {
      this.allBox = h('input', { type: 'checkbox', title: 'Select all', onchange: () => this.checkAll(this.allBox.checked) });
      cells.push(h('th', { class: 'chk' }, this.allBox));
    }
    for (const c of this.o.columns) {
      const th = h('th', {
        class: [c.align === 'right' ? 'num' : '', c.sortable ? 'sortable' : '', c.urdu ? 'urdu' : '',
          this.sort?.key === c.key ? 'sorted-' + this.sort.dir : ''].join(' '),
        style: c.width ? `width:${c.width}` : null,
      }, c.label);
      if (c.sortable) {
        th.addEventListener('click', () => {
          const dir = this.sort?.key === c.key && this.sort.dir === 'asc' ? 'desc' : 'asc';
          this.sort = { key: c.key, dir };
          this.renderHead();
          if (this.o.onSort) this.o.onSort(c.key, dir);
          else this.localSort();
        });
      }
      cells.push(th);
    }
    this.thead.replaceChildren(h('tr', null, cells));
  }

  localSort() {
    const { key, dir } = this.sort;
    const m = dir === 'asc' ? 1 : -1;
    this.rows.sort((a, b) => {
      const x = a[key] ?? '', y = b[key] ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * m;
    });
    this.render();
  }

  setRows(rows, keepSelection = false) {
    const selId = keepSelection ? this.current()?.id : null;
    this.rows = rows || [];
    if (!keepSelection) this.checked.clear();
    this.render();
    if (selId) this.selectBy((r) => r.id === selId, false);
    else this.index = -1;
  }

  render() {
    const cols = this.o.columns.length + (this.o.checkable ? 1 : 0);
    if (!this.rows.length) {
      this.tbody.replaceChildren(h('tr', { class: 'empty' }, h('td', { colspan: cols }, this.o.emptyText || 'No records found.')));
      return;
    }
    const frag = document.createDocumentFragment();
    this.rows.forEach((row, i) => {
      const tr = h('tr', { class: this.o.rowClass?.(row) || '', dataset: { i } });
      if (this.o.checkable) {
        const cb = h('input', { type: 'checkbox', checked: this.checked.has(row.id) });
        cb.addEventListener('change', () => { cb.checked ? this.checked.add(row.id) : this.checked.delete(row.id); this.o.onCheck?.(this.checked); });
        cb.addEventListener('click', (e) => e.stopPropagation());
        tr.append(h('td', { class: 'chk' }, cb));
      }
      for (const c of this.o.columns) {
        const v = c.render ? c.render(row, i) : row[c.key];
        tr.append(h('td', { class: [c.align === 'right' ? 'num' : '', c.urdu ? 'urdu' : ''].join(' ') }, v instanceof Node ? v : (v ?? '')));
      }
      tr.addEventListener('click', () => this.select(i));
      tr.addEventListener('dblclick', () => this.o.onOpen?.(row));
      frag.append(tr);
    });
    this.tbody.replaceChildren(frag);
    if (this.allBox) this.allBox.checked = false;
  }

  select(i, notify = true) {
    if (i < 0 || i >= this.rows.length) return;
    this.tbody.querySelector('tr.sel')?.classList.remove('sel');
    const tr = this.tbody.children[i];
    tr?.classList.add('sel');
    tr?.scrollIntoView({ block: 'nearest' });
    this.index = i;
    if (notify) this.o.onSelect?.(this.rows[i]);
  }

  selectBy(pred, notify = true) {
    const i = this.rows.findIndex(pred);
    if (i >= 0) this.select(i, notify);
    else { this.tbody.querySelector('tr.sel')?.classList.remove('sel'); this.index = -1; }
  }

  current() { return this.rows[this.index] || null; }

  checkAll(on) {
    this.checked = new Set(on ? this.rows.map((r) => r.id) : []);
    this.tbody.querySelectorAll('td.chk input').forEach((cb) => { cb.checked = on; });
    this.o.onCheck?.(this.checked);
  }

  onKey(e) {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); this.select(Math.min(this.index + 1, this.rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); this.select(Math.max(this.index - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); this.select(0); }
    else if (e.key === 'End') { e.preventDefault(); this.select(this.rows.length - 1); }
    else if (e.key === 'Enter' && this.current()) { e.preventDefault(); this.o.onOpen?.(this.current()); }
    else if (e.key === ' ' && this.o.checkable && this.current()) {
      e.preventDefault();
      const id = this.current().id;
      this.checked.has(id) ? this.checked.delete(id) : this.checked.add(id);
      this.tbody.children[this.index].querySelector('td.chk input').checked = this.checked.has(id);
      this.o.onCheck?.(this.checked);
    }
  }

  focus() { this.el.focus(); if (this.index < 0 && this.rows.length) this.select(0, false); }
}

/**
 * new EditGrid({columns:[{key,label,type:'text|number|date|select',options,width,placeholder}], minRows})
 * .rows (getter) returns non-empty rows; .setRows(array)
 * Enter -> next cell; Enter on last cell of last row -> new row; Ctrl+Delete removes row.
 */
export class EditGrid {
  constructor({ columns, minRows = 1, onChange }) {
    this.columns = columns;
    this.minRows = minRows;
    this.onChange = onChange;
    this.tbody = h('tbody');
    this.el = h('div', null,
      h('div', { style: 'overflow-x:auto' }, h('table', { class: 'egrid' },
        h('thead', null, h('tr', null, h('th', null, 'Sr'), columns.map((c) => h('th', { style: c.width ? `width:${c.width}` : null }, c.label)), h('th', null, ''))),
        this.tbody)),
      h('div', { style: 'margin-top:6px' }, h('button', { class: 'btn sm', type: 'button', onclick: () => this.addRow(null, true) }, '+ Add row'),
        h('span', { class: 'muted', style: 'margin-left:10px;font-size:12px' }, 'Enter = next cell · Ctrl+Del = remove row')));
    this.tbody.addEventListener('keydown', (e) => this.onKey(e));
    this.tbody.addEventListener('change', () => this.onChange?.());
    this.setRows([]);
  }

  cell(c, value) {
    let input;
    if (c.type === 'select') {
      const opts = typeof c.options === 'function' ? c.options() : c.options;
      input = h('select', { name: c.key }, h('option', { value: '' }, ''), opts.map((o) => h('option', { value: String(o.value) }, o.label)));
      input.value = value ?? '';
    } else {
      input = h('input', { name: c.key, type: c.type || 'text', placeholder: c.placeholder || '', step: c.type === 'number' ? 'any' : undefined, min: c.min });
      input.value = value ?? '';
      if (c.type === 'number') input.classList.add('num');
    }
    return h('td', null, input);
  }

  addRow(data = null, focus = false) {
    const tr = h('tr', null, h('td', { class: 'sr' }),
      this.columns.map((c) => this.cell(c, data?.[c.key])),
      h('td', { class: 'act' }, h('button', { class: 'rm', type: 'button', title: 'Remove row', onclick: () => this.removeRow(tr) }, '×')));
    this.tbody.append(tr);
    this.renumber();
    if (focus) tr.querySelector('input,select')?.focus();
    return tr;
  }

  removeRow(tr) {
    const next = tr.nextElementSibling || tr.previousElementSibling;
    tr.remove();
    if (this.tbody.children.length < this.minRows) this.addRow();
    this.renumber();
    next?.querySelector('input,select')?.focus();
    this.onChange?.();
  }

  renumber() { [...this.tbody.children].forEach((tr, i) => { tr.firstChild.textContent = i + 1; }); }

  setRows(rows) {
    this.tbody.replaceChildren();
    (rows || []).forEach((r) => this.addRow(r));
    while (this.tbody.children.length < this.minRows) this.addRow();
  }

  get rows() {
    return [...this.tbody.children].map((tr) => {
      const o = {};
      this.columns.forEach((c, i) => {
        const el = tr.children[i + 1].firstChild;
        let v = el.value.trim();
        o[c.key] = v === '' ? null : (c.type === 'number' || c.numeric ? Number(v) : v);
      });
      return o;
    }).filter((o) => Object.values(o).some((v) => v !== null));
  }

  onKey(e) {
    const el = e.target;
    const tr = el.closest('tr');
    if (e.key === 'Delete' && e.ctrlKey) { e.preventDefault(); this.removeRow(tr); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const cells = [...tr.querySelectorAll('input,select')];
    const i = cells.indexOf(el);
    if (i < cells.length - 1) { cells[i + 1].focus(); cells[i + 1].select?.(); return; }
    const nextTr = tr.nextElementSibling || this.addRow();
    nextTr.querySelector('input,select')?.focus();
  }

  setReadonly(ro) {
    this.el.querySelectorAll('input,select,button').forEach((x) => { x.disabled = ro; });
  }
}
