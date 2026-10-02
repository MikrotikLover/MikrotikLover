/**
 * enterNav.js — keyboard-first data entry for every form in the app.
 *
 *   import EnterNav from './core/enterNav.js';
 *   const nav = EnterNav.attach(formEl, {
 *     onSave: async (data, form, nav) => api.post('users', data),  // throw ApiError for 422
 *     successMessage: 'Saved',
 *   });
 *
 * Behaviour
 *  - ENTER moves to the next field (never submits the form); SHIFT+ENTER goes back.
 *  - Disabled, readonly, hidden, tabindex=-1 and [data-enter-skip] fields are skipped.
 *  - Searchable selects: an element may define `el.enterNavHook(event)` that is
 *    called first; returning 'stay' keeps focus (e.g. the list is open with
 *    nothing to pick), anything else lets the focus move. searchSelect.js uses
 *    this so the first ENTER picks the highlighted option and moves on.
 *  - Line-item grids ([data-enter-grid] containing rows [data-row]):
 *      ENTER on the last field of the last row adds a new row and focuses its
 *      first field. ENTER on an empty last row jumps to the first field after
 *      the grid (Remarks), or saves if there is none.
 *      A row is "empty" when all its [data-row-key] inputs are empty (or, when
 *      none are marked, all of its editable inputs).
 *      Rows are added by `gridEl.enterNavAddRow()` if defined, otherwise by
 *      cloning <template data-row-template> into [data-rows] (or the tbody).
 *  - ENTER on the last field of the form saves. CTRL+S (⌘+S) saves from anywhere.
 *  - Validation: native constraints + options.validate(); the first invalid field
 *    is focused and the message shown beside it. Server errors
 *    ({errors: {field: message}}) are shown the same way.
 *  - Save button(s) are disabled while saving (no double save).
 *  - After a successful save: toast, form reset, focus the first field.
 *  - ENTER while composing text with an IME (Urdu keyboards) is ignored.
 *  - textarea[data-enter-newline] keeps ENTER for new lines.
 */

const FIELD_SELECTOR = 'input, select, textarea, [contenteditable="true"], [data-enter-focusable]';
const BUTTON_TYPES = new Set(['button', 'submit', 'reset', 'image']);
const TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number', '']);

const globalConfig = {
  /** Translator for built-in messages: (key, fallback) => string */
  t: (key, fallback) => fallback,
  /** Toast function: (message, type) => void */
  toast: null,
};

const controllers = new Set();
let lastActive = null;
let globalListenerInstalled = false;
let uid = 0;

/* ------------------------------------------------------------------ helpers */

function isVisible(el) {
  if (el.closest('[hidden], [inert]')) return false;
  if (!el.getClientRects().length) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function isNavigable(el) {
  if (el.matches('input') && BUTTON_TYPES.has(el.type)) return false;
  if (el.type === 'hidden') return false;
  if (el.disabled || el.closest('fieldset[disabled]')) return false;
  if (el.readOnly && !el.hasAttribute('data-enter-include')) return false;
  if (el.hasAttribute('data-enter-skip') || el.closest('[data-enter-skip]')) return false;
  if (el.getAttribute('tabindex') === '-1') return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.type === 'radio' && el.name) {
    // One stop per radio group: the checked radio, or the first one.
    const group = [...(el.form || document).querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)]
      .filter((r) => !r.disabled);
    const target = group.find((r) => r.checked) || group[0];
    if (target !== el) return false;
  }
  return isVisible(el);
}

function isTextLike(el) {
  return (el.tagName === 'INPUT' && TEXT_TYPES.has(el.type)) || el.tagName === 'TEXTAREA';
}

function isEmptyValue(el) {
  if (el.type === 'checkbox' || el.type === 'radio') return !el.checked;
  return String(el.value ?? '').trim() === '';
}

function defaultMessage(el) {
  const t = globalConfig.t;
  const v = el.validity;
  if (v.customError) return el.validationMessage;
  if (v.valueMissing) return t('validation.required', 'This field is required.');
  if (v.typeMismatch && el.type === 'email') return t('validation.email', 'Enter a valid email address.');
  if (v.typeMismatch) return t('validation.format', 'Invalid format.');
  if (v.patternMismatch) return el.dataset.patternMessage || t('validation.format', 'Invalid format.');
  if (v.tooShort) return t('validation.min_length', 'Too short (minimum {n}).').replace('{n}', el.minLength);
  if (v.tooLong) return t('validation.max_length', 'Too long (maximum {n}).').replace('{n}', el.maxLength);
  if (v.rangeUnderflow) return t('validation.min_value', 'Must be at least {n}.').replace('{n}', el.min);
  if (v.rangeOverflow) return t('validation.max_value', 'Must be at most {n}.').replace('{n}', el.max);
  if (v.stepMismatch) return t('validation.step', 'Invalid value.');
  if (v.badInput) return t('validation.number', 'Enter a valid number.');
  return el.validationMessage || t('validation.invalid', 'Invalid value.');
}

/** The visible element that represents a field name (maps hidden combobox inputs to their text input). */
function visibleFor(el) {
  if (!el) return null;
  if (el.type === 'hidden') {
    const combo = el.closest('[data-combobox]');
    return combo ? combo.querySelector('input:not([type="hidden"])') : null;
  }
  return el;
}

function focusEl(el) {
  if (!el) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  // Select existing text so typing replaces it (fast correction during data entry).
  if (isTextLike(el) && typeof el.select === 'function') {
    try { el.select(); } catch { /* some input types do not support selection */ }
  }
}

function installGlobalListener() {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || (e.key !== 's' && e.key !== 'S')) return;
    // Clean up controllers whose forms were removed by navigation.
    for (const c of controllers) if (!c.form.isConnected) controllers.delete(c);
    let target = null;
    for (const c of controllers) if (c.form.contains(document.activeElement)) target = c;
    if (!target && lastActive && controllers.has(lastActive) && isVisible(lastActive.form)) target = lastActive;
    if (!target) {
      const visible = [...controllers].filter((c) => isVisible(c.form));
      if (visible.length === 1) target = visible[0];
    }
    if (!target) return;
    e.preventDefault();
    target.save();
  }, true);
}

/* --------------------------------------------------------------- controller */

class EnterNavController {
  constructor(form, options) {
    this.form = form;
    this.opts = {
      onSave: null,             // async (data, form, nav) => result; throw {errors} for field errors
      onSaved: null,            // (result, nav) => void, after success
      validate: null,           // (form, nav) => {fieldName|element: message} | null
      collect: null,            // (form) => data; default collects named fields
      onReset: null,            // (form, nav) => void, after form.reset()
      resetAfterSave: true,
      autofocus: true,
      successMessage: null,     // string or (result) => string; null = t('saved')
      gridSelector: '[data-enter-grid]',
      rowSelector: '[data-row]',
      ...options,
    };
    this.saving = false;
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onSubmit = this._onSubmit.bind(this);
    this._onFocusIn = this._onFocusIn.bind(this);
    this._onInput = this._onInput.bind(this);

    form.setAttribute('novalidate', '');
    form.addEventListener('keydown', this._onKeyDown, true);
    form.addEventListener('submit', this._onSubmit);
    form.addEventListener('focusin', this._onFocusIn);
    form.addEventListener('input', this._onInput);
    form.addEventListener('change', this._onInput);
    form.enterNav = this;
    controllers.add(this);
    installGlobalListener();
    if (this.opts.autofocus) requestAnimationFrame(() => this.focusFirst());
  }

  /* ----------------------------------------------------------- navigation */

  fields(root = this.form) {
    return [...root.querySelectorAll(FIELD_SELECTOR)].filter((el) => this.form.contains(el) && isNavigable(el));
  }

  focusFirst() {
    if (!this.form.isConnected) return;
    focusEl(this.fields()[0]);
  }

  /** Field after `el` in document order (works even if `el` itself is not navigable). */
  _following(el, list = this.fields()) {
    const idx = list.indexOf(el);
    if (idx !== -1) return list[idx + 1] || null;
    return list.find((f) => el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
  }

  next(el) {
    const nextField = this._following(el);
    if (nextField) focusEl(nextField);
    else this.save();
  }

  prev(el) {
    const list = this.fields();
    const idx = list.indexOf(el);
    let target;
    if (idx > 0) target = list[idx - 1];
    else if (idx === -1) target = [...list].reverse().find((f) => el.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_PRECEDING);
    if (target) focusEl(target);
  }

  _onFocusIn(e) {
    lastActive = this;
    const el = e.target;
    if (!(el instanceof HTMLElement) || !el.matches(FIELD_SELECTOR)) return;
    // Mobile keyboards: show "Next" on every field and "Done" on the last.
    const list = this.fields();
    el.enterKeyHint = list[list.length - 1] === el ? 'done' : 'next';
  }

  _onKeyDown(e) {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target;
    if (!(el instanceof HTMLElement) || !this.form.contains(el)) return;

    // Buttons, links and <summary> keep their native ENTER activation.
    if (el.matches('button, a[href], summary, input[type="button"], input[type="submit"], input[type="reset"], input[type="image"]')) return;
    if (el.matches('textarea[data-enter-newline]') && !e.shiftKey) return;
    if (!el.matches(FIELD_SELECTOR)) return;

    e.preventDefault(); // never let ENTER submit the form implicitly

    if (e.shiftKey) {
      this.prev(el);
      return;
    }

    if (typeof el.enterNavHook === 'function' && el.enterNavHook(e) === 'stay') return;

    const grid = el.closest(this.opts.gridSelector);
    if (grid && this.form.contains(grid) && this._handleGridEnter(el, grid)) return;

    this.next(el);
  }

  /* ----------------------------------------------------------------- grid */

  _rows(grid) {
    return [...grid.querySelectorAll(this.opts.rowSelector)].filter((r) => r.closest(this.opts.gridSelector) === grid && isVisible(r));
  }

  rowIsEmpty(row) {
    const keys = [...row.querySelectorAll('[data-row-key]')];
    const inputs = keys.length
      ? keys
      : [...row.querySelectorAll('input, select, textarea')].filter(
        (i) => i.type !== 'hidden' && !i.readOnly && !i.disabled && !BUTTON_TYPES.has(i.type),
      );
    return inputs.every(isEmptyValue);
  }

  addRow(grid) {
    let row = null;
    if (typeof grid.enterNavAddRow === 'function') {
      row = grid.enterNavAddRow();
    } else {
      const tpl = grid.querySelector('template[data-row-template]');
      if (!tpl) return null;
      const host = grid.querySelector('[data-rows]') || grid.querySelector('tbody') || grid;
      const frag = tpl.content.cloneNode(true);
      row = frag.querySelector(this.opts.rowSelector) || frag.firstElementChild;
      host.appendChild(frag);
    }
    if (row) grid.dispatchEvent(new CustomEvent('enternav:rowadded', { bubbles: true, detail: { row } }));
    return row;
  }

  /** Returns true if the grid logic handled the key. */
  _handleGridEnter(el, grid) {
    const row = el.closest(this.opts.rowSelector);
    if (!row || !grid.contains(row)) return false;
    const rows = this._rows(grid);
    const isLastRow = rows[rows.length - 1] === row;

    // Empty last row → leave the grid (Remarks / Save section).
    if (isLastRow && this.rowIsEmpty(row)) {
      const all = this.fields();
      const after = all.find((f) => !grid.contains(f) && (grid.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (after) focusEl(after);
      else this.save();
      return true;
    }

    const rowFields = this.fields(row);
    if (isLastRow && rowFields[rowFields.length - 1] === el) {
      const newRow = this.addRow(grid);
      if (newRow) {
        // Components inside the row may render asynchronously; focus on next frame.
        requestAnimationFrame(() => focusEl(this.fields(newRow)[0]));
        return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------ validation */

  clearErrors() {
    this.form.querySelectorAll('.field-error[data-enter-nav]').forEach((n) => n.remove());
    this.form.querySelectorAll('[aria-invalid="true"]').forEach((el) => {
      el.removeAttribute('aria-invalid');
      el.classList.remove('is-invalid');
    });
    this.form.querySelector('.form-error[data-enter-nav]')?.remove();
  }

  clearError(el) {
    if (!el || el.getAttribute('aria-invalid') !== 'true') return;
    el.removeAttribute('aria-invalid');
    el.classList.remove('is-invalid');
    const id = el.dataset.enterErrorId;
    if (id) document.getElementById(id)?.remove();
  }

  setError(el, message) {
    el = visibleFor(el) || el;
    el.setAttribute('aria-invalid', 'true');
    el.classList.add('is-invalid');
    const host = el.closest('[data-error-host], .field, td') || el.parentElement;
    if (!el.dataset.enterErrorId) el.dataset.enterErrorId = `en-err-${++uid}`;
    let node = document.getElementById(el.dataset.enterErrorId);
    if (!node) {
      node = document.createElement('div');
      node.className = 'field-error';
      node.id = el.dataset.enterErrorId;
      node.setAttribute('role', 'alert');
      node.dataset.enterNav = '';
      host.appendChild(node);
    }
    node.textContent = message;
    const described = new Set((el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    described.add(node.id);
    el.setAttribute('aria-describedby', [...described].join(' '));
  }

  /** Form-level message (errors that do not belong to a visible field). */
  setFormError(message) {
    let node = this.form.querySelector('.form-error[data-enter-nav]');
    if (!node) {
      node = document.createElement('div');
      node.className = 'form-error';
      node.setAttribute('role', 'alert');
      node.dataset.enterNav = '';
      this.form.prepend(node);
    }
    node.textContent = message;
  }

  /** Find the element for a server field key: "qty", "lines.0.qty" or "lines[0][qty]". */
  findField(key) {
    const f = this.form;
    const esc = CSS.escape;
    let el = f.querySelector(`[name="${esc(key)}"]`) || f.querySelector(`[data-field="${esc(key)}"]`);
    if (!el && key.includes('.')) {
      const parts = key.split('.');
      const bracket = parts[0] + parts.slice(1).map((p) => `[${p}]`).join('');
      el = f.querySelector(`[name="${esc(bracket)}"]`);
      if (!el && /^\d+$/.test(parts[1] || '')) {
        // grid convention "<grid>.<row>.<column>": grid by data-grid-name (else the first grid)
        const grid = f.querySelector(`${this.opts.gridSelector}[data-grid-name="${esc(parts[0])}"]`) || f.querySelector(this.opts.gridSelector);
        const row = grid ? this._rows(grid)[Number(parts[1])] : null;
        if (row && parts[2]) el = row.querySelector(`[name="${esc(parts[2])}"], [data-col="${esc(parts[2])}"]`);
      }
    }
    return visibleFor(el) || el;
  }

  /**
   * Show errors and focus the first invalid field.
   * @param {Object<string,string>|Array<[Element,string]>} errors
   */
  showErrors(errors, formMessage = null) {
    const pairs = [];
    const unmatched = [];
    const entries = Array.isArray(errors) ? errors : Object.entries(errors || {});
    for (const [key, message] of entries) {
      const el = key instanceof Element ? visibleFor(key) || key : this.findField(String(key));
      if (el) pairs.push([el, String(message)]);
      else unmatched.push(String(message));
    }
    pairs.forEach(([el, msg]) => this.setError(el, msg));
    if (unmatched.length || (formMessage && !pairs.length)) {
      this.setFormError([formMessage, ...unmatched].filter(Boolean).join(' '));
    }
    const first = pairs
      .map(([el]) => el)
      .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))[0];
    if (first) focusEl(first);
    return pairs.length + unmatched.length;
  }

  validate() {
    const errors = [];
    const seen = new Set();
    for (const el of this.form.querySelectorAll('input, select, textarea')) {
      if (!el.willValidate || el.validity.valid) continue;
      const target = visibleFor(el) || el;
      if (seen.has(target) || !isVisible(target)) continue;
      seen.add(target);
      errors.push([target, defaultMessage(el)]);
    }
    if (typeof this.opts.validate === 'function') {
      const custom = this.opts.validate(this.form, this) || {};
      const entries = Array.isArray(custom) ? custom : Object.entries(custom);
      for (const [key, msg] of entries) {
        if (!msg) continue;
        const el = key instanceof Element ? key : this.findField(key);
        if (el && seen.has(visibleFor(el) || el)) continue;
        errors.push([el || key, msg]);
      }
    }
    return errors;
  }

  _onInput(e) {
    // Text fields clear their error while typing ('input'). Their deferred 'change'
    // (fired when focus leaves) must not wipe an error that was just shown.
    if (e.type === 'change' && isTextLike(e.target)) return;
    const el = visibleFor(e.target) || e.target;
    this.clearError(el);
  }

  /* ------------------------------------------------------------------ save */

  collect() {
    if (typeof this.opts.collect === 'function') return this.opts.collect(this.form, this);
    const data = {};
    for (const el of this.form.elements) {
      if (!el.name || el.disabled || BUTTON_TYPES.has(el.type)) continue;
      if (el.closest('[data-enter-grid]')) continue; // grids are collected by their own component
      if (el.type === 'checkbox') data[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) data[el.name] = el.value; }
      else if (el.tagName === 'SELECT' && el.multiple) data[el.name] = [...el.selectedOptions].map((o) => o.value);
      else data[el.name] = el.value;
    }
    return data;
  }

  _setBusy(busy) {
    this.form.toggleAttribute('aria-busy', busy);
    this.form.classList.toggle('is-saving', busy);
    this.form.querySelectorAll('[type="submit"], [data-save]').forEach((b) => {
      if (busy) {
        b.dataset.enterWasDisabled = b.disabled ? '1' : '';
        b.disabled = true;
        b.classList.add('is-busy');
      } else {
        b.disabled = b.dataset.enterWasDisabled === '1';
        delete b.dataset.enterWasDisabled;
        b.classList.remove('is-busy');
      }
    });
  }

  async save() {
    if (this.saving) return false;
    this.clearErrors();
    const errors = this.validate();
    if (errors.length) {
      this.showErrors(errors);
      return false;
    }
    if (typeof this.opts.onSave !== 'function') return true;

    this.saving = true;
    this._setBusy(true);
    try {
      const result = await this.opts.onSave(this.collect(), this.form, this);
      if (result === false) return false;
      const msg = typeof this.opts.successMessage === 'function'
        ? this.opts.successMessage(result)
        : this.opts.successMessage ?? globalConfig.t('saved', 'Saved successfully.');
      if (msg) globalConfig.toast?.(msg, 'success');
      if (this.opts.resetAfterSave) this.reset();
      if (typeof this.opts.onSaved === 'function') this.opts.onSaved(result, this);
      if (this.opts.resetAfterSave) this.focusFirst();
      return true;
    } catch (err) {
      const fieldErrors = err && typeof err === 'object' ? err.errors : null;
      if (fieldErrors && Object.keys(fieldErrors).length) {
        this.showErrors(fieldErrors);
      } else {
        const message = err?.message || globalConfig.t('error.generic', 'Something went wrong.');
        this.setFormError(message);
        globalConfig.toast?.(message, 'error');
      }
      return false;
    } finally {
      this.saving = false;
      if (this.form.isConnected) this._setBusy(false);
    }
  }

  _onSubmit(e) {
    e.preventDefault();
    this.save();
  }

  reset() {
    this.form.reset();
    this.clearErrors();
    if (typeof this.opts.onReset === 'function') this.opts.onReset(this.form, this);
  }

  destroy() {
    this.form.removeEventListener('keydown', this._onKeyDown, true);
    this.form.removeEventListener('submit', this._onSubmit);
    this.form.removeEventListener('focusin', this._onFocusIn);
    this.form.removeEventListener('input', this._onInput);
    this.form.removeEventListener('change', this._onInput);
    delete this.form.enterNav;
    controllers.delete(this);
    if (lastActive === this) lastActive = null;
  }
}

/* ------------------------------------------------------------------- public */

function attach(form, options = {}) {
  if (!(form instanceof HTMLFormElement)) throw new TypeError('EnterNav.attach expects a <form> element');
  if (form.enterNav) form.enterNav.destroy();
  return new EnterNavController(form, options);
}

function configure(config) {
  Object.assign(globalConfig, config);
}

const EnterNav = { attach, configure, isNavigable };
export default EnterNav;
export { attach, configure, isNavigable };
