// Declarative form builder: fields -> 12-column grid with labels, validation messages, dirty tracking.
import { h } from './dom.js';
import { enterToNext } from './keys.js';

/**
 * Field: {name, label, type, span, required, options, placeholder, urdu, help, readonly, min, max, step, maxlength}
 * types: text number date time email tel cnic select textarea checkbox checks section static password
 * options: [{value,label}] or () => [{value,label}] (call form.refreshOptions())
 */
export class Form {
  constructor(fields, { onChange, prefix = '' } = {}) {
    this.fields = fields;
    this.inputs = {};
    this.wraps = {};
    this.dirty = false;
    this.onChange = onChange;
    this.prefix = prefix;
    this.errorBox = h('div', { class: 'form-error hidden', role: 'alert' });
    this.grid = h('div', { class: 'form-grid' });
    this.el = h('div', { class: 'form' }, this.errorBox, this.grid);
    for (const f of fields) this.grid.append(this.build(f));
    enterToNext(this.el);
    this.el.addEventListener('input', () => this.markDirty());
    this.el.addEventListener('change', (e) => { this.markDirty(); this.onChange?.(e.target.name, this.values, e); });
  }

  markDirty() { this.dirty = true; }

  build(f) {
    if (f.type === 'section') return h('div', { class: 'form-section' }, f.label);
    const id = 'f_' + this.prefix + f.name.replace(/\W/g, '_') + '_' + Math.random().toString(36).slice(2, 7);
    let input;
    const common = { id, name: f.name, placeholder: f.placeholder, readonly: f.readonly, maxlength: f.maxlength };
    switch (f.type) {
      case 'select':
        input = h('select', common);
        this.fillOptions(input, f);
        break;
      case 'textarea':
        input = h('textarea', { ...common, rows: f.rows || 2, class: f.urdu ? 'urdu' : null, dir: f.urdu ? 'rtl' : null });
        break;
      case 'checkbox':
        input = h('input', { id, name: f.name, type: 'checkbox' });
        this.inputs[f.name] = input;
        this.wraps[f.name] = h('div', { class: `fld check s${f.span || 3}` }, input, h('label', { for: id }, f.label));
        return this.wraps[f.name];
      case 'checks': {
        const box = h('div', { class: 'checks', id });
        input = box;
        this.fillOptions(box, f);
        break;
      }
      case 'static':
        input = h('div', { id, class: 'input', style: 'display:flex;align-items:center;background:#f3f4f6' });
        break;
      case 'cnic':
        input = h('input', { ...common, type: 'text', inputmode: 'numeric', maxlength: 15, placeholder: f.placeholder || '00000-0000000-0' });
        input.addEventListener('input', () => {
          const d = input.value.replace(/\D/g, '').slice(0, 13);
          input.value = d.length > 12 ? `${d.slice(0, 5)}-${d.slice(5, 12)}-${d.slice(12)}`
            : d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
        });
        break;
      default:
        input = h('input', {
          ...common,
          type: f.type || 'text',
          min: f.min, max: f.max, step: f.step ?? (f.type === 'number' ? 'any' : undefined),
          class: f.urdu ? 'urdu' : null, dir: f.urdu ? 'rtl' : null, lang: f.urdu ? 'ur' : null,
          autocomplete: f.autocomplete || 'off',
        });
        if (f.type === 'number') input.classList.add('num');
    }
    this.inputs[f.name] = input;
    const wrap = h('div', { class: `fld s${f.span || 3}${f.required ? ' req' : ''}` },
      h('label', { for: id }, f.label, f.urdu && f.label ? '' : null),
      input,
      f.help ? h('div', { class: 'help' }, f.help) : null);
    this.wraps[f.name] = wrap;
    return wrap;
  }

  fillOptions(input, f) {
    const opts = typeof f.options === 'function' ? f.options() : (f.options || []);
    if (f.type === 'checks') {
      input.replaceChildren(...opts.map((o) => h('label', null,
        h('input', { type: 'checkbox', value: String(o.value), dataset: { num: typeof o.value === 'number' ? '1' : '' } }), o.label)));
      return;
    }
    const cur = input.value;
    input.replaceChildren(
      ...(f.required && !f.blank ? [] : [h('option', { value: '' }, f.blankLabel || '')]),
      ...opts.map((o) => h('option', { value: String(o.value), class: o.urdu ? 'urdu' : null, disabled: o.disabled }, o.label)),
    );
    if (cur) input.value = cur;
  }

  refreshOptions(name) {
    for (const f of this.fields) {
      if ((name === undefined || f.name === name) && (f.type === 'select' || f.type === 'checks') && typeof f.options === 'function') {
        this.fillOptions(this.inputs[f.name], f);
      }
    }
  }

  get values() {
    const out = {};
    for (const f of this.fields) {
      if (f.type === 'section' || f.type === 'static') continue;
      const el = this.inputs[f.name];
      let v;
      if (f.type === 'checkbox') v = el.checked ? 1 : 0;
      else if (f.type === 'checks') {
        v = [...el.querySelectorAll('input:checked')].map((c) => (c.dataset.num ? Number(c.value) : c.value));
      } else {
        v = el.value.trim();
        if (v === '') v = null;
        else if (f.type === 'number') v = Number(v);
        else if (f.type === 'select' && f.numeric) v = Number(v);
      }
      out[f.name] = v;
    }
    return out;
  }

  set values(data) {
    for (const f of this.fields) {
      if (f.type === 'section') continue;
      const el = this.inputs[f.name];
      const v = data?.[f.name];
      if (f.type === 'checkbox') el.checked = v === true || v === 1 || v === '1';
      else if (f.type === 'checks') {
        const set = new Set((v || []).map(String));
        el.querySelectorAll('input').forEach((c) => { c.checked = set.has(c.value); });
      } else if (f.type === 'static') el.textContent = v ?? '';
      else if (f.type === 'time') el.value = v ? String(v).slice(0, 5) : '';
      else if (f.type === 'number' && v !== null && v !== undefined && v !== '') el.value = Number(v);
      else el.value = v ?? '';
    }
    this.clearErrors();
    this.dirty = false;
  }

  set(name, value) {
    const el = this.inputs[name];
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value; else el.value = value ?? '';
  }

  get(name) { return this.values[name]; }

  clearErrors() {
    this.errorBox.classList.add('hidden');
    for (const w of Object.values(this.wraps)) {
      w.classList.remove('err');
      w.querySelector('.msg')?.remove();
    }
  }

  /** errors: {field: message}; keys with a prefix ("salary.x") are matched on the part after the prefix. */
  showErrors(errors = {}, message = '') {
    this.clearErrors();
    let first = null;
    const unknown = [];
    for (const [k, msg] of Object.entries(errors)) {
      const name = this.prefix && k.startsWith(this.prefix) ? k.slice(this.prefix.length) : k;
      const wrap = this.wraps[name];
      if (!wrap) { unknown.push(msg); continue; }
      wrap.classList.add('err');
      wrap.append(h('div', { class: 'msg' }, msg));
      first ||= this.inputs[name];
    }
    const text = [message, ...unknown].filter(Boolean).join(' ');
    if (text) {
      this.errorBox.textContent = text;
      this.errorBox.classList.remove('hidden');
    }
    if (first?.focus) first.focus();
    return first !== null || unknown.length > 0;
  }

  focus(name) {
    const el = name ? this.inputs[name] : this.el.querySelector('input:not([readonly]),select,textarea');
    el?.focus();
    if (el?.select && el.tagName === 'INPUT') el.select();
  }

  setReadonly(ro) {
    for (const [name, el] of Object.entries(this.inputs)) {
      const f = this.fields.find((x) => x.name === name);
      if (f?.readonly) continue;
      if (el.tagName === 'SELECT' || el.type === 'checkbox') el.disabled = ro;
      else if (el.classList.contains('checks')) el.querySelectorAll('input').forEach((c) => { c.disabled = ro; });
      else el.readOnly = ro;
    }
  }
}
