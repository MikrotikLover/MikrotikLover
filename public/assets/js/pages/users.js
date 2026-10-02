// Users: list + form (role, active, password reset).
import { get, post, put, del } from '../core/api.js';
import { h, toast, confirmDialog, fdatetime } from '../core/dom.js';
import { Form } from '../core/form.js';
import { DataGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { can, opt, session } from '../core/store.js';

export default {
  async mount(root) {
    const st = { rows: [], current: null };
    const form = new Form([
      { name: 'username', label: 'Username', required: true, span: 6, maxlength: 50, autocomplete: 'off' },
      { name: 'full_name', label: 'Full Name', required: true, span: 6, maxlength: 100 },
      { name: 'email', label: 'Email', type: 'email', span: 6, maxlength: 120 },
      { name: 'role_id', label: 'Role', type: 'select', required: true, blank: true, numeric: true, span: 6, options: opt.roles },
      { name: 'password', label: 'Password', type: 'password', span: 6, autocomplete: 'new-password', help: 'Required for new users. Leave blank to keep the current password.' },
      { name: 'is_active', label: 'Active', type: 'checkbox', span: 3 },
      { name: 'must_change_password', label: 'Must change password at next login', type: 'checkbox', span: 3 },
    ]);
    const grid = new DataGrid({
      columns: [
        { key: 'username', label: 'Username', sortable: true },
        { key: 'full_name', label: 'Name', sortable: true },
        { key: 'role', label: 'Role', sortable: true },
        { key: 'is_active', label: 'Status', render: (r) => h('span', { class: 'badge ' + (Number(r.is_active) ? 'ok' : 'off') }, Number(r.is_active) ? 'Active' : 'Disabled') },
        { key: 'last_login_at', label: 'Last login', render: (r) => fdatetime(r.last_login_at) },
      ],
      onSelect: (r) => setRecord(r),
      onOpen: () => form.focus(),
    });
    const recLabel = h('span', { class: 'rec' });
    const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save ', h('kbd', null, 'F10'));
    const btnDel = h('button', { class: 'btn danger', type: 'button', onclick: () => remove() }, 'Delete ', h('kbd', null, 'F12'));

    function setRecord(r) {
      st.current = r;
      form.values = r ? { ...r, password: '' } : { is_active: 1, must_change_password: 1 };
      recLabel.textContent = r ? `Editing: ${r.username}` : 'New user';
      btnSave.disabled = r ? !can('users', 'edit') : !can('users', 'add');
      btnDel.disabled = !r || !can('users', 'delete') || r.id === session.user.id;
    }
    async function load(keep) {
      st.rows = await get('users');
      grid.setRows(st.rows);
      if (keep) grid.selectBy((r) => r.id === keep, false);
    }
    async function save() {
      if (btnSave.disabled) return;
      try {
        const v = form.values;
        if (!v.password) delete v.password;
        const r = st.current ? await put(`users/${st.current.id}`, v) : await post('users', v);
        toast('User saved.');
        await load(r.id);
        setRecord(r);
      } catch (e) { form.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); }
    }
    async function remove() {
      if (!st.current || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete user "${st.current.username}"?`, { ok: 'Delete', danger: true }))) return;
      try { await del(`users/${st.current.id}`); toast('User deleted.'); setRecord(null); await load(); } catch (e) { toast(e.message, 'err', 6000); }
    }
    const newRec = () => { grid.selectBy(() => false, false); setRecord(null); form.focus(); };
    setKeys({ new: newRec, save, del: remove, load: () => load(st.current?.id) });

    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !can('users', 'add'), onclick: newRec }, 'New ', h('kbd', null, 'F5')),
        btnSave, btnDel, h('span', { class: 'spacer' }), recLabel),
      h('div', { class: 'md' }, grid.el,
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'User details')), h('div', { class: 'panel-body' }, form.el))),
    );
    setRecord(null);
    await load();
    return { canLeave: () => !form.dirty };
  },
};
