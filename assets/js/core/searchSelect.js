/**
 * searchSelect.js — accessible searchable dropdown (combobox) for vanilla forms.
 *
 *   const ss = searchSelect({
 *     name: 'role_id', required: true, value: 3,
 *     options: [{ value: 1, label: 'Admin', sub: 'admin' }, ...],
 *     // or async: load: async (query) => [{value,label,sub}],
 *     onChange: (value, option) => {},
 *   });
 *   fieldEl.appendChild(ss.el);
 *
 * Renders a visible text input (role="combobox") + a hidden input carrying the
 * value under `name`. Keyboard: type to filter, ↑/↓ to move, ESC to close.
 * Integrates with enterNav.js via `input.enterNavHook`: ENTER picks the
 * highlighted option and focus moves to the next field in the same keystroke.
 */
import { t } from './i18n.js';

let seq = 0;

const norm = (s) => String(s ?? '').toLocaleLowerCase().normalize('NFKD');

export function searchSelect({
  name,
  options = [],
  value = '',
  placeholder = '',
  required = false,
  disabled = false,
  load = null,
  minChars = 0,
  maxResults = 50,
  rowKey = false,
  id = null,
  onChange = null,
} = {}) {
  const uid = ++seq;
  const listId = `ss-list-${uid}`;
  const wrap = document.createElement('div');
  wrap.className = 'ss';
  wrap.dataset.combobox = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ss-input';
  input.id = id || `ss-${uid}`;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = placeholder || t('common.search_select');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', listId);
  input.disabled = disabled;

  const hidden = document.createElement('input');
  hidden.type = 'hidden';
  hidden.name = name;
  if (rowKey) hidden.dataset.rowKey = '';

  const caret = document.createElement('span');
  caret.className = 'ss-caret';
  caret.setAttribute('aria-hidden', 'true');

  const list = document.createElement('ul');
  list.className = 'ss-list';
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.hidden = true;

  wrap.append(input, caret, hidden, list);

  let allOptions = normalise(options);
  let shown = [];
  let active = -1;
  let selected = null;
  let initial = value;
  let loadTimer = null;
  let loadToken = 0;

  function normalise(opts) {
    return (opts || []).map((o) => ({ ...o, value: String(o.value), label: String(o.label ?? o.value), sub: o.sub ?? '' }));
  }

  function isOpen() {
    return !list.hidden;
  }

  function updateValidity() {
    input.setCustomValidity(required && !hidden.value ? t('validation.required') : '');
  }

  function render() {
    list.innerHTML = '';
    if (!shown.length) {
      const li = document.createElement('li');
      li.className = 'ss-empty';
      li.textContent = t('common.no_matches');
      list.appendChild(li);
      return;
    }
    shown.forEach((o, i) => {
      const li = document.createElement('li');
      li.id = `${listId}-${i}`;
      li.className = 'ss-option';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', i === active ? 'true' : 'false');
      if (selected && o.value === selected.value) li.classList.add('is-selected');
      const label = document.createElement('span');
      label.className = 'ss-label';
      label.textContent = o.label;
      li.appendChild(label);
      if (o.sub) {
        const sub = document.createElement('span');
        sub.className = 'ss-sub';
        sub.textContent = o.sub;
        li.appendChild(sub);
      }
      li.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in input
      li.addEventListener('click', () => {
        commit(o);
        close();
      });
      list.appendChild(li);
    });
    paint();
  }

  /** Move the highlight (arrow keys) — clamped to the list. */
  function highlight(i) {
    active = shown.length ? Math.max(0, Math.min(i, shown.length - 1)) : -1;
    paint();
  }

  /** Reflect `active` in the DOM (-1 = nothing highlighted). */
  function paint() {
    [...list.querySelectorAll('.ss-option')].forEach((li, idx) => li.setAttribute('aria-selected', idx === active ? 'true' : 'false'));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${listId}-${active}`);
      list.children[active]?.scrollIntoView?.({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function filterLocal(q) {
    const nq = norm(q);
    const res = nq ? allOptions.filter((o) => norm(o.label).includes(nq) || norm(o.sub).includes(nq)) : allOptions;
    return res.slice(0, maxResults);
  }

  function search(q, typed) {
    if (load) {
      clearTimeout(loadTimer);
      if (q.length < minChars) {
        shown = [];
        active = -1;
        render();
        return;
      }
      const token = ++loadToken;
      loadTimer = setTimeout(async () => {
        wrap.classList.add('is-loading');
        try {
          const res = normalise(await load(q));
          if (token !== loadToken) return;
          allOptions = mergeKnown(res);
          shown = res.slice(0, maxResults);
          active = shown.length ? 0 : -1;
          render();
        } catch {
          shown = [];
          render();
        } finally {
          wrap.classList.remove('is-loading');
        }
      }, 200);
      return;
    }
    shown = filterLocal(q);
    const selIdx = selected ? shown.findIndex((o) => o.value === selected.value) : -1;
    // Typing highlights the first match; just opening highlights the current
    // value only, so ENTER on an untouched optional field never picks by accident.
    active = typed ? (shown.length ? 0 : -1) : selIdx;
    render();
  }

  function mergeKnown(res) {
    const map = new Map(allOptions.map((o) => [o.value, o]));
    res.forEach((o) => map.set(o.value, o));
    return [...map.values()];
  }

  function open(typed = false) {
    if (input.disabled || input.readOnly) return;
    list.hidden = false;
    wrap.classList.add('is-open');
    input.setAttribute('aria-expanded', 'true');
    search(typed ? input.value : '', typed);
  }

  function close() {
    list.hidden = true;
    wrap.classList.remove('is-open');
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  }

  function commit(option, silent = false) {
    const prev = hidden.value;
    selected = option || null;
    hidden.value = option ? option.value : '';
    input.value = option ? option.label : '';
    updateValidity();
    if (!silent && prev !== hidden.value) {
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
      onChange?.(hidden.value, selected);
    }
  }

  function revert() {
    input.value = selected ? selected.label : '';
  }

  function setValue(v, silent = true) {
    const sv = v === null || v === undefined ? '' : String(v);
    const opt = sv === '' ? null : allOptions.find((o) => o.value === sv) || null;
    if (sv !== '' && !opt && load) {
      // Unknown option for an async list: keep the value, label will come from setOptions/withLabel.
      hidden.value = sv;
      selected = { value: sv, label: sv };
      input.value = sv;
      updateValidity();
      return;
    }
    commit(opt, silent);
  }

  /* --------------------------------------------------------------- events */

  // Open on focus with the current value highlighted, so ENTER confirms it and moves on.
  input.addEventListener('focus', () => {
    if (input.readOnly) return;
    input.select();
    if (!isOpen()) open(false);
  });
  input.addEventListener('click', () => (isOpen() ? null : open(false)));
  input.addEventListener('input', () => {
    if (input.value === '') commit(null);
    if (!isOpen()) open(true);
    else search(input.value, true);
  });
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen()) open(false);
        else highlight(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (isOpen()) highlight(active - 1);
        break;
      case 'PageDown':
        if (isOpen()) { e.preventDefault(); highlight(active + 8); }
        break;
      case 'PageUp':
        if (isOpen()) { e.preventDefault(); highlight(active - 8); }
        break;
      case 'Escape':
        if (isOpen()) {
          e.preventDefault();
          e.stopPropagation();
          close();
          revert();
        }
        break;
      case 'Tab':
        if (isOpen() && active >= 0) commit(shown[active]);
        close();
        break;
      case 'Enter':
        // Standalone use (no enterNav on the form): pick and stay.
        if (!e.defaultPrevented && isOpen()) {
          e.preventDefault();
          if (active >= 0) commit(shown[active]);
          close();
        }
        break;
      default:
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (wrap.contains(document.activeElement)) return;
      if (isOpen()) {
        const exact = shown.find((o) => norm(o.label) === norm(input.value));
        if (exact) commit(exact);
        close();
      }
      revert();
    }, 0);
  });

  /** Called by enterNav before moving focus. */
  input.enterNavHook = () => {
    if (isOpen()) {
      if (active >= 0 && shown[active]) {
        commit(shown[active]);
        close();
        return 'move';
      }
      close();
      revert();
    }
    // A required, still-empty dropdown keeps focus and opens the list.
    if (required && !hidden.value) {
      open(false);
      return 'stay';
    }
    return 'move';
  };

  // Restore the initial value on form.reset() (hidden inputs are not reset by the browser).
  const bindReset = () => {
    const form = wrap.closest('form');
    if (form && !wrap.dataset.resetBound) {
      wrap.dataset.resetBound = '1';
      form.addEventListener('reset', () => setTimeout(() => { setValue(initial); close(); }, 0));
    }
  };
  requestAnimationFrame(bindReset);

  setValue(value);

  return {
    el: wrap,
    input,
    hidden,
    getValue: () => hidden.value,
    getOption: () => selected,
    setValue: (v, silent = true) => setValue(v, silent),
    setInitial: (v) => { initial = v; },
    setOptions: (opts, keepValue = true) => {
      allOptions = normalise(opts);
      if (keepValue) setValue(hidden.value);
      if (isOpen()) search(input.value, false);
    },
    withLabel: (v, label) => {
      const opt = { value: String(v), label: String(label) };
      allOptions = mergeKnown([opt]);
      setValue(v);
    },
    setDisabled: (d) => { input.disabled = d; if (d) close(); },
    setRequired: (r) => { required = r; updateValidity(); },
    focus: () => input.focus(),
    open,
    close,
  };
}

export default searchSelect;
