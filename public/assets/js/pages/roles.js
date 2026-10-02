// Roles & permission matrix (module x view/add/edit/delete/post/print).
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, loadLookups } from '../core/store.js';

export default {
  async mount(root) {
    const { modules, actions } = await get('roles/modules');
    const st = { current: null, dirty: false };
    const form = new Form([
      { name: 'name', label: 'Role Name', required: true, span: 4, maxlength: 60 },
      { name: 'description', label: 'Description', span: 8, maxlength: 255 },
    ]);
    const boxes = {};
    const matrixBody = h('tbody');
    let lastGroup = null;
    for (const m of modules) {
      if (m.group !== lastGroup) {
        matrixBody.append(h('tr', { class: 'grp' }, h('td', { colspan: actions.length + 2 }, m.group)));
        lastGroup = m.group;
      }
      const rowBoxes = [];
      const cells = actions.map((a) => {
        if (!m.actions.includes(a)) return h('td', { class: 'muted' }, '—');
        const cb = h('input', { type: 'checkbox', onchange: () => { st.dirty = true; } });
        boxes[`${m.key}.${a}`] = cb;
        rowBoxes.push(cb);
        return h('td', null, cb);
      });
      const all = h('input', { type: 'checkbox', title: 'All', onchange: () => { rowBoxes.forEach((c) => { if (!c.disabled) c.checked = all.checked; }); st.dirty = true; } });
      matrixBody.append(h('tr', null, h('td', null, m.label), ...cells, h('td', null, all)));
    }
    const matrix = h('table', { class: 'matrix' },
      h('thead', null, h('tr', null, h('th', null, 'Module'), actions.map((a) => h('th', null, a[0].toUpperCase() + a.slice(1))), h('th', null, 'All'))),
      matrixBody);
    const adminNote = h('div', { class: 'form-error hidden' }, 'The Admin role always has full access; its permissions cannot be changed.');

    const grid = new DataGrid({
      columns: [
        { key: 'name', label: 'Role' },
        { key: 'description', label: 'Description' },
        { key: 'user_count', label: 'Users', align: 'right' },
      ],
      onSelect: async (r) => setRecord(await get(`roles/${r.id}`)),
    });
    const recLabel = h('span', { class: 'rec' });
    const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save ', h('kbd', null, 'F10'));
    const btnDel = h('button', { class: 'btn danger', type: 'button', onclick: () => remove() }, 'Delete ', h('kbd', null, 'F12'));

    function setRecord(r) {
      st.current = r;
      st.dirty = false;
      form.values = r || {};
      const perms = r?.permissions || {};
      const isAdmin = !!Number(r?.is_admin);
      for (const [k, cb] of Object.entries(boxes)) {
        const [m, a] = k.split('.');
        cb.checked = (perms[m] || []).includes(a);
        cb.disabled = isAdmin || !can('users', r ? 'edit' : 'add');
      }
      adminNote.classList.toggle('hidden', !isAdmin);
      recLabel.textContent = r ? `Editing: ${r.name}` : 'New role';
      btnSave.disabled = r ? !can('users', 'edit') : !can('users', 'add');
      btnDel.disabled = !r || isAdmin || !can('users', 'delete');
    }
    async function load(keep) {
      grid.setRows(await get('roles'));
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    async function save() {
      if (btnSave.disabled) return;
      const permissions = {};
      for (const [k, cb] of Object.entries(boxes)) {
        if (!cb.checked) continue;
        const [m, a] = k.split('.');
        (permissions[m] ||= []).push(a);
      }
      try {
        const body = { ...form.values, permissions };
        const r = st.current ? await put(`roles/${st.current.id}`, body) : await post('roles', body);
        toast('Role saved. Users get the new permissions on their next request.');
        setRecord(r);
        await Promise.all([load(r.id), loadLookups()]);
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); }
    }
    async function remove() {
      if (!st.current || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete role "${st.current.name}"?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`roles/${st.current.id}`); toast('Role deleted.'); setRecord(null); await Promise.all([load(), loadLookups()]); } catch (e) { toast(e.message, 'err', 6000); }
    }
    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); form.focus(); };
    setKeys({ new: newRec, save, del: remove, load: () => load(st.current?.id) });

    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !can('users', 'add'), onclick: newRec }, 'New ', h('kbd', null, 'F5')),
        btnSave, btnDel, h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md', style: 'grid-template-columns:minmax(260px,.7fr) minmax(420px,1.5fr)' }, grid.el,
        h('div', { class: 'panel' }, h('div', { class: 'panel-body' }, form.el, h('div', { style: 'margin-top:12px' }, adminNote, h('div', { style: 'overflow-x:auto' }, matrix))))),
    );
    setRecord(null);
    await load();
    return { canLeave: () => !form.dirty && !st.dirty };
  },
};
