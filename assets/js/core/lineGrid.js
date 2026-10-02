/**
 * lineGrid.js — reusable line-item grid for vouchers and detail tables.
 * Plugs into enterNav.js: ENTER on the last column adds a row, ENTER on an
 * empty last row leaves the grid, server errors "<name>.<row>.<col>" land in
 * the right cell.
 *
 *   const g = lineGrid({
 *     name: 'inks',
 *     columns: [
 *       { key: 'ink_colour_id', label: 'Colour', type: 'lookup', rowKey: true, required: true,
 *         options: (row) => [...], onChange: (row, value, option) => {} },
 *       { key: 'coverage_pct', label: 'Coverage %', type: 'number', step: '0.01', min: 0, max: 100 },
 *       { key: 'is_manual', label: 'Manual', type: 'checkbox' },
 *       { key: 'ml_per_meter', type: 'number', readonly: (row) => !row.get('is_manual') },
 *       { key: 'cost', label: 'Cost/m', type: 'display', format: (row) => '…' },
 *     ],
 *     onChange: () => recalcTotals(),
 *   });
 *   container.appendChild(g.el);
 *   g.setRows(record.inks); const lines = g.getRows();
 *
 * Column types: lookup | number | text | checkbox | display.
 * Values: number/text → string, checkbox → boolean, lookup → string ('' when empty).
 */
import { t } from './i18n.js';
import { esc } from './ui.js';
import { icon } from './icons.js';
import { searchSelect } from './searchSelect.js';

export function lineGrid({ name, columns, minRows = 1, onChange = null, addLabel = null, removable = true, cls = '' }) {
  const wrap = document.createElement('div');
  wrap.className = `grid-wrap ${cls}`;
  wrap.dataset.enterGrid = '';
  wrap.dataset.gridName = name;
  wrap.innerHTML = `
    <table class="line-grid">
      <thead><tr><th class="ln">#</th>${columns.map((c) => `<th class="col-${esc(c.key)} ${c.type === 'number' || c.type === 'display' ? 'num' : ''}">${esc(c.label || '')}</th>`).join('')}${removable ? '<th class="act"></th>' : ''}</tr></thead>
      <tbody data-rows></tbody>
      <tfoot hidden><tr></tr></tfoot>
    </table>
    <button type="button" class="btn btn-ghost btn-sm grid-add" data-add>${icon('plus', { size: 18 })}<span>${esc(addLabel || t('grid.add_row'))}</span></button>`;
  const tbody = wrap.querySelector('[data-rows]');
  const rows = [];

  function changed() {
    rows.forEach((r) => r.refresh());
    onChange?.(api);
  }

  function makeRow(data = {}) {
    const tr = document.createElement('tr');
    tr.dataset.row = '';
    const combos = {};
    const row = {
      tr,
      combos,
      index: () => rows.indexOf(row),
      input: (key) => tr.querySelector(`[data-col="${CSS.escape(key)}"]`),
      combo: (key) => combos[key],
      get(key) {
        const col = columns.find((c) => c.key === key);
        if (!col) return undefined;
        if (col.type === 'lookup') return combos[key].getValue();
        if (col.type === 'display') return undefined;
        const el = row.input(key);
        return col.type === 'checkbox' ? el.checked : el.value;
      },
      option: (key) => combos[key]?.getOption() || null,
      set(key, value) {
        const col = columns.find((c) => c.key === key);
        if (!col || col.type === 'display') return;
        if (col.type === 'lookup') combos[key].setValue(value ?? '');
        else if (col.type === 'checkbox') row.input(key).checked = !!Number(value) || value === true;
        else row.input(key).value = value ?? '';
      },
      isEmpty() {
        const keys = columns.filter((c) => c.rowKey);
        const check = keys.length ? keys : columns.filter((c) => c.type !== 'display' && c.type !== 'checkbox');
        return check.every((c) => String(row.get(c.key) ?? '').trim() === '');
      },
      values() {
        const out = {};
        columns.forEach((c) => { if (c.type !== 'display') out[c.key] = row.get(c.key); });
        return out;
      },
      refresh() {
        columns.forEach((c) => {
          if (c.type === 'display') {
            const out = row.input(c.key);
            if (out) out.textContent = c.format ? c.format(row) ?? '' : '';
          }
          if (c.datalist) {
            const dl = tr.querySelector(`[data-col="${CSS.escape(c.key)}"] + datalist`);
            const opts = c.datalist(row) || [];
            const html = opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label || '')}</option>`).join('');
            if (dl && dl.innerHTML !== html) dl.innerHTML = html;
          }
          if (typeof c.readonly === 'function' && c.type !== 'lookup' && c.type !== 'display') {
            const el = row.input(c.key);
            const ro = !!c.readonly(row);
            if (c.type === 'checkbox') el.disabled = ro;
            else el.readOnly = ro;
          }
        });
      },
    };

    tr.innerHTML = `<td class="ln"></td>${columns.map((c) => `<td class="col-${esc(c.key)} ${c.type === 'number' || c.type === 'display' ? 'num' : ''}" data-label="${esc(c.label || '')}"></td>`).join('')}${removable ? `<td class="act"><button type="button" class="icon-btn" data-remove aria-label="${esc(t('grid.remove_row'))}" title="${esc(t('grid.remove_row'))}">${icon('close', { size: 18 })}</button></td>` : ''}`;
    const cells = tr.querySelectorAll('td[data-label]');
    columns.forEach((c, i) => {
      const td = cells[i];
      if (c.type === 'lookup') {
        const ss = searchSelect({
          name: c.key,
          rowKey: !!c.rowKey,
          required: !!c.required,
          placeholder: c.placeholder || '',
          options: typeof c.options === 'function' ? c.options(row) : c.options || [],
          onChange: (value, option) => { c.onChange?.(row, value, option); changed(); },
        });
        ss.input.dataset.col = c.key;
        ss.input.setAttribute('aria-label', c.label || c.key);
        combos[c.key] = ss;
        td.appendChild(ss.el);
      } else if (c.type === 'display') {
        td.innerHTML = `<output data-col="${esc(c.key)}" dir="ltr"></output>`;
      } else if (c.type === 'checkbox') {
        td.innerHTML = `<input type="checkbox" name="${esc(c.key)}" data-col="${esc(c.key)}" aria-label="${esc(c.label || c.key)}">`;
      } else {
        const num = c.type === 'number';
        const listId = c.datalist ? `dl-${name}-${c.key}-${++dlSeq}` : '';
        td.innerHTML = `<input ${num ? `type="number" inputmode="decimal" step="${esc(c.step || 'any')}"` : 'type="text"'} ${listId ? `list="${listId}" autocomplete="off"` : ''}
          ${c.min !== undefined ? `min="${esc(c.min)}"` : ''} ${c.max !== undefined ? `max="${esc(c.max)}"` : ''}
          ${c.maxlength ? `maxlength="${esc(c.maxlength)}"` : ''} ${c.required ? 'required' : ''}
          name="${esc(c.key)}" data-col="${esc(c.key)}" aria-label="${esc(c.label || c.key)}" ${num || c.ltr ? 'dir="ltr"' : ''}>${listId ? `<datalist id="${listId}"></datalist>` : ''}`;
      }
    });
    columns.forEach((c) => { if (data[c.key] !== undefined && data[c.key] !== null) row.set(c.key, data[c.key]); });
    tr.addEventListener('input', (e) => {
      const col = columns.find((c) => c.key === e.target.dataset.col);
      if (col && col.type !== 'lookup') col.onChange?.(row, row.get(col.key));
      changed();
    });
    tr.addEventListener('change', (e) => {
      if (e.target.type === 'checkbox') {
        const col = columns.find((c) => c.key === e.target.dataset.col);
        col?.onChange?.(row, e.target.checked);
        changed();
      }
    });
    return row;
  }

  let dlSeq = 0;

  function renumber() {
    rows.forEach((r, i) => { r.tr.querySelector('.ln').textContent = String(i + 1); });
  }

  function addRow(data = {}) {
    const row = makeRow(data);
    rows.push(row);
    tbody.appendChild(row.tr);
    renumber();
    row.refresh();
    return row;
  }

  function removeRow(row) {
    if (rows.length <= minRows) {
      // Keep the minimum number of rows: clear instead of removing.
      columns.forEach((c) => row.set(c.key, c.type === 'checkbox' ? false : ''));
    } else {
      rows.splice(rows.indexOf(row), 1);
      row.tr.remove();
      renumber();
    }
    changed();
  }

  function clear() {
    rows.splice(0).forEach((r) => r.tr.remove());
    for (let i = 0; i < minRows; i++) addRow();
    changed();
  }

  function setRows(list = []) {
    rows.splice(0).forEach((r) => r.tr.remove());
    list.forEach((d) => addRow(d));
    while (rows.length < minRows) addRow();
    changed();
  }

  /** Non-empty rows as plain objects; `_row` = grid row index (server errors use it). */
  function getRows() {
    return rows.map((r, i) => ({ r, i })).filter(({ r }) => !r.isEmpty()).map(({ r, i }) => ({ ...r.values(), _row: i }));
  }

  /** Rebuild lookup options (e.g. after a header filter changed). */
  function refreshOptions() {
    rows.forEach((r) => columns.forEach((c) => {
      if (c.type === 'lookup' && typeof c.options === 'function') r.combos[c.key].setOptions(c.options(r));
    }));
  }

  /** Footer totals: cells = {columnKey: text}; first cell label. */
  function setFooter(label, cells) {
    const tfoot = wrap.querySelector('tfoot');
    tfoot.hidden = false;
    tfoot.querySelector('tr').innerHTML = `<td class="ln"></td>${columns.map((c, i) => {
      const v = i === 0 ? label : cells[c.key] ?? '';
      return `<td class="${c.type === 'number' || c.type === 'display' ? 'num' : ''}" ${i > 0 && v !== '' ? `data-label="${esc(c.label || '')}"` : ''}><strong dir="${i === 0 ? 'auto' : 'ltr'}">${esc(v)}</strong></td>`;
    }).join('')}${removable ? '<td class="act"></td>' : ''}`;
  }

  wrap.addEventListener('click', (e) => {
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const row = rows.find((r) => r.tr.contains(rm));
      if (row) removeRow(row);
      return;
    }
    if (e.target.closest('[data-add]')) {
      const row = addRow();
      changed();
      requestAnimationFrame(() => (row.tr.querySelector('input:not([type=hidden]):not([readonly])') || {}).focus?.());
    }
  });

  // enterNav hook: ENTER on the last column of the last row.
  wrap.enterNavAddRow = () => {
    const row = addRow();
    changed();
    return row.tr;
  };

  const api = { el: wrap, name, rows: () => rows.slice(), addRow, removeRow, setRows, getRows, clear, refreshOptions, setFooter, refresh: changed };
  for (let i = 0; i < minRows; i++) addRow();
  return api;
}

export default lineGrid;
