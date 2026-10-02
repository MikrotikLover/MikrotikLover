/**
 * formKit.js — builds forms from field definitions (used by master forms and
 * the design form) so every form behaves the same with enterNav.js.
 *
 * Field definition:
 *   { key, label (i18n key), type: 'text'|'textarea'|'number'|'select'|'lookup'|'checkbox'|'color',
 *     required, max, min, step, pattern, hint (i18n key), dir, span: true (full width),
 *     options: [{value, label}] (select; label is an i18n key) ,
 *     set: 'parties' + filter: (opt, values) => bool   (lookup),
 *     when: (values) => bool  (shown only when true; hidden fields are skipped and sent as null),
 *     default }
 */
import { t } from './i18n.js';
import { esc } from './ui.js';
import { searchSelect } from './searchSelect.js';
import { toOptions } from './lookups.js';

function control(f) {
  const req = f.required ? 'required' : '';
  const name = esc(f.key);
  switch (f.type) {
    case 'textarea':
      return `<textarea name="${name}" rows="2" ${f.max ? `maxlength="${f.max}"` : ''} ${req}></textarea>`;
    case 'number':
      return `<input type="number" name="${name}" inputmode="decimal" dir="ltr" step="${esc(f.step || 'any')}"
        ${f.min !== undefined ? `min="${esc(f.min)}"` : ''} ${f.maxValue !== undefined ? `max="${esc(f.maxValue)}"` : ''} ${req}>`;
    case 'select':
      return `<select name="${name}" ${req}>${f.placeholder !== false && !f.required ? '<option value=""></option>' : ''}${(f.options || [])
        .map((o) => `<option value="${esc(o.value)}">${esc(t(o.label))}</option>`).join('')}</select>`;
    case 'lookup':
      return `<div data-lookup="${name}"></div>`;
    case 'color':
      return `<input type="color" name="${name}" ${req}>`;
    case 'checkbox':
      return '';
    default:
      return `<input type="${esc(f.inputType || 'text')}" name="${name}" ${f.max ? `maxlength="${f.max}"` : ''}
        ${f.pattern ? `pattern="${esc(f.pattern)}"` : ''} ${f.dir ? `dir="${esc(f.dir)}"` : ''} ${f.upper ? 'data-upper' : ''}
        ${f.placeholder ? `placeholder="${esc(t(f.placeholder))}"` : ''} autocomplete="off" ${req}>`;
  }
}

export function renderFields(fields) {
  return fields.map((f) => {
    if (f.type === 'checkbox') {
      return `<div class="field field-check ${f.span ? 'span-all' : ''}" data-wrap="${esc(f.key)}">
        <label class="check"><input type="checkbox" name="${esc(f.key)}"> <span>${esc(t(f.label))}</span></label>
        ${f.hint ? `<div class="field-hint">${esc(t(f.hint))}</div>` : ''}</div>`;
    }
    return `<div class="field ${f.span || f.type === 'textarea' ? 'span-all' : ''}" data-wrap="${esc(f.key)}">
      <label class="field-label">${esc(t(f.label))}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ''}</label>
      ${control(f)}
      ${f.hint ? `<div class="field-hint">${esc(t(f.hint))}</div>` : ''}
    </div>`;
  }).join('');
}

/**
 * Wires rendered fields: mounts searchable selects, visibility rules and
 * value helpers. `lookups` is the object returned by loadLookups().
 */
export function mountFields(form, fields, lookups = {}) {
  const combos = {};
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));

  for (const f of fields.filter((x) => x.type === 'lookup')) {
    const ss = searchSelect({
      name: f.key,
      required: !!f.required,
      options: [],
      onChange: () => ctx.refresh(),
    });
    form.querySelector(`[data-lookup="${CSS.escape(f.key)}"]`).replaceWith(ss.el);
    combos[f.key] = ss;
  }

  const el = (key) => form.querySelector(`[name="${CSS.escape(key)}"]`);

  const ctx = {
    combos,
    /** All current values (hidden fields included) — used by `when` and filters. */
    values() {
      const v = {};
      for (const f of fields) {
        if (f.type === 'lookup') v[f.key] = combos[f.key].getValue();
        else if (f.type === 'checkbox') v[f.key] = el(f.key).checked;
        else v[f.key] = el(f.key).value;
      }
      return v;
    },
    /** Values to send: hidden fields → null, empty lookups → null, upper-case where asked. */
    collect() {
      const all = ctx.values();
      const out = {};
      for (const f of fields) {
        const visible = !f.when || f.when(all);
        let v = all[f.key];
        if (!visible) v = f.type === 'checkbox' ? false : null;
        else if (f.type === 'lookup') v = v === '' ? null : Number(v);
        else if (f.upper && typeof v === 'string') v = v.toUpperCase();
        out[f.key] = v;
      }
      return out;
    },
    setValues(rec) {
      for (const f of fields) {
        if (!(f.key in rec)) continue;
        const v = rec[f.key];
        if (f.type === 'lookup') combos[f.key].setValue(v ?? '');
        else if (f.type === 'checkbox') el(f.key).checked = !!Number(v) || v === true;
        else el(f.key).value = v ?? '';
      }
      ctx.refresh();
    },
    setDefaults() {
      const rec = {};
      fields.forEach((f) => { if (f.default !== undefined) rec[f.key] = typeof f.default === 'function' ? f.default() : f.default; });
      ctx.setValues(rec);
    },
    /** Re-apply visibility rules and dependent lookup filters. */
    refresh() {
      const v = ctx.values();
      for (const f of fields) {
        if (f.type === 'lookup') {
          const list = lookups[f.set] || [];
          const before = combos[f.key].getValue();
          combos[f.key].setOptions(toOptions(list, f.filter ? (o) => f.filter(o, v) : null));
          if (before !== combos[f.key].getValue()) return ctx.refresh(); // a filtered-out value was cleared
        }
        if (f.when) form.querySelector(`[data-wrap="${CSS.escape(f.key)}"]`).hidden = !f.when(v);
      }
      return undefined;
    },
    /** Make the current values the state that form.reset() returns to. */
    snapshot() {
      for (const f of fields) {
        if (f.type === 'lookup') { combos[f.key].setInitial(combos[f.key].getValue()); continue; }
        const e = el(f.key);
        if (f.type === 'checkbox') e.defaultChecked = e.checked;
        else if (e.tagName === 'SELECT') [...e.options].forEach((o) => { o.defaultSelected = o.selected; });
        else e.defaultValue = e.value;
      }
    },
    field: (key) => byKey[key],
  };

  // Plain inputs/selects that drive `when` rules or lookup filters.
  form.addEventListener('change', (e) => { if (byKey[e.target.name] && byKey[e.target.name].type !== 'lookup') ctx.refresh(); });
  // After form.reset(): searchSelects restore on a 0ms timer, so refresh after them.
  form.addEventListener('reset', () => setTimeout(() => ctx.refresh(), 5));
  ctx.refresh();
  return ctx;
}
