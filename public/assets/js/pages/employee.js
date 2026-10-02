// Employee Info: tabbed form (Info + photo, Salary Info with effective-dated history, Qualification,
// Experience, List of Employees). Desktop keys: F1 search, F5 new, F7 reload, F9 ID card, F10 save, F12 delete.
import { get, post, put, del, api } from '../core/api.js';
import { h, toast, modal, confirmDialog, money, fdate, fdatetime, openReport, debounce, TYPES } from '../core/dom.js';
import { cropImage } from '../core/cropper.js';
import { Form } from '../core/form.js';
import { DataGrid, EditGrid } from '../core/grid.js';
import { setKeys } from '../core/keys.js';
import { go, setPath } from '../core/router.js';
import { can, lookups } from '../core/store.js';

const withUrdu = (list) => () => list().filter((x) => x.is_active || x.__keep).map((x) => ({ value: x.id, label: x.name_ur ? `${x.name}  —  ${x.name_ur}` : x.name }));

const MAIN_FIELDS = [
  { type: 'section', label: 'Personal' },
  { name: 'id', label: 'Auto ID', type: 'static', span: 2 },
  { name: 'code', label: 'Code', required: true, span: 2, maxlength: 20, help: 'Printed on ID card / barcode' },
  { name: 'name', label: 'Name', required: true, span: 4, maxlength: 100 },
  { name: 'name_ur', label: 'نام (Urdu)', urdu: true, span: 4, maxlength: 100 },
  { name: 'relation', label: 'S/W/D/O', type: 'select', required: true, span: 2,
    options: [{ value: 'S/O', label: 'S/O' }, { value: 'W/O', label: 'W/O' }, { value: 'D/O', label: 'D/O' }] },
  { name: 'father_name', label: 'Father / Husband Name', span: 4, maxlength: 100 },
  { name: 'father_name_ur', label: 'ولدیت (Urdu)', urdu: true, span: 4, maxlength: 100 },
  { name: 'gender', label: 'Gender', type: 'select', required: true, span: 2, options: [{ value: 'M', label: 'Male' }, { value: 'F', label: 'Female' }] },
  { name: 'cnic', label: 'CNIC', type: 'cnic', span: 3 },
  { name: 'dob', label: 'Date of Birth', type: 'date', span: 3 },
  { name: 'cell', label: 'Cell #', type: 'tel', span: 3, placeholder: '03XX-XXXXXXX', maxlength: 20 },
  { name: 'phone_res', label: 'Ph. Res', type: 'tel', span: 3, maxlength: 20 },
  { name: 'address', label: 'Address', span: 6, maxlength: 255 },
  { name: 'city', label: 'City', span: 3, maxlength: 60 },
  { name: 'email', label: 'Email', type: 'email', span: 3, maxlength: 120 },
  { name: 'qualification', label: 'Qualification', span: 6, maxlength: 100 },
  { name: 'reference', label: 'Reference', span: 6, maxlength: 100 },
  { type: 'section', label: 'Employment' },
  { name: 'department_id', label: 'Department', type: 'select', required: true, blank: true, numeric: true, span: 3, options: withUrdu(() => lookups.departments) },
  { name: 'designation_id', label: 'Designation', type: 'select', required: true, blank: true, numeric: true, span: 3, options: withUrdu(() => lookups.designations) },
  { name: 'emp_type', label: 'Type', type: 'select', required: true, span: 3, options: Object.entries(TYPES).map(([value, label]) => ({ value, label })) },
  { name: 'status', label: 'Status', type: 'select', required: true, span: 3, options: [{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }] },
  { name: 'joining_date', label: 'Joining Date', type: 'date', required: true, span: 3 },
  { name: 'leaving_date', label: 'Leaving Date', type: 'date', span: 3 },
  { name: 'shift_group_id', label: 'Shift Group', type: 'select', numeric: true, span: 3,
    options: () => lookups.shift_groups.filter((s) => s.is_active || s.__keep).map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` })) },
  { name: 'shift_date', label: 'Shift Date', type: 'date', span: 3, help: 'Rotation start (default = joining date)' },
  { name: 'machine_id', label: 'Machine ID', type: 'number', span: 3, min: 1, help: 'Biometric enrollment no.' },
  { name: 'remarks', label: 'Remarks', span: 9, maxlength: 255 },
];

const SALARY_FIELDS = [
  { name: 'effective_from', label: 'Effective From', type: 'date', required: true, span: 3 },
  { name: 'basic_salary', label: 'Basic Salary (monthly)', type: 'number', span: 3, min: 0 },
  { name: 'daily_rate', label: 'Daily Rate (daily wages)', type: 'number', span: 3, min: 0 },
  { name: 'allowances', label: 'Allowances (monthly)', type: 'number', span: 3, min: 0 },
  { name: 'ot_applicable', label: 'Overtime applicable', type: 'checkbox', span: 3 },
  { name: 'ot_rate', label: 'OT Rate / hour', type: 'number', span: 3, min: 0, help: 'Blank = auto (basic ÷ days ÷ shift hrs × multiplier)' },
  { name: 'payment_mode', label: 'Payment', type: 'select', required: true, span: 3, options: [{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank transfer' }] },
  { name: 'reason', label: 'Reason', span: 3, maxlength: 100, placeholder: 'Appointment / Increment…' },
  { name: 'eobi_applicable', label: 'EOBI', type: 'checkbox', span: 3 },
  { name: 'pessi_applicable', label: 'PESSI / SESSI', type: 'checkbox', span: 3 },
  { name: 'tax_applicable', label: 'Income tax', type: 'checkbox', span: 3 },
  { name: 'bank_name', label: 'Bank Name', span: 3, maxlength: 100 },
  { name: 'bank_account', label: 'Bank Account # / IBAN', span: 4, maxlength: 40 },
  { name: 'remarks', label: 'Remarks', span: 8, maxlength: 255 },
];

const SALARY_DEFAULTS = { basic_salary: 0, daily_rate: 0, allowances: 0, ot_applicable: 1, payment_mode: 'cash', eobi_applicable: 0, pessi_applicable: 0, tax_applicable: 0 };

const NEW_DEFAULTS = { relation: 'S/O', gender: 'M', emp_type: 'permanent', status: 'active' };

export default {
  async mount(root, params) {
    const canAdd = can('employees', 'add');
    const canEdit = can('employees', 'edit');
    const canDel = can('employees', 'delete');
    const canPrint = can('employees', 'print');
    const st = { emp: null, pendingPhoto: null, photoUrl: null, childDirty: false };

    // ---------- forms & grids
    const form = new Form(MAIN_FIELDS, {
      onChange: (name) => {
        if (name === 'joining_date' && !st.emp) salaryForm.set('effective_from', form.get('joining_date'));
        if (name === 'emp_type') hintSalary();
      },
    });
    const salaryForm = new Form(SALARY_FIELDS, { prefix: 'salary.' });
    const quals = new EditGrid({
      columns: [
        { key: 'degree', label: 'Degree / Certificate' },
        { key: 'institute', label: 'Institute / Board' },
        { key: 'passing_year', label: 'Year', type: 'number', width: '90px' },
        { key: 'grade', label: 'Grade / Div', width: '110px' },
        { key: 'remarks', label: 'Remarks' },
      ],
      onChange: () => { st.childDirty = true; },
    });
    const exps = new EditGrid({
      columns: [
        { key: 'organization', label: 'Organization' },
        { key: 'designation', label: 'Designation' },
        { key: 'from_date', label: 'From', type: 'date', width: '150px' },
        { key: 'to_date', label: 'To', type: 'date', width: '150px' },
        { key: 'reason_left', label: 'Reason of leaving' },
        { key: 'remarks', label: 'Remarks' },
      ],
      onChange: () => { st.childDirty = true; },
    });
    const salaryGrid = new DataGrid({
      columns: [
        { key: 'effective_from', label: 'Effective', render: (r) => fdate(r.effective_from) },
        { key: 'basic_salary', label: 'Basic', align: 'right', render: (r) => money(r.basic_salary) },
        { key: 'daily_rate', label: 'Daily', align: 'right', render: (r) => money(r.daily_rate) },
        { key: 'allowances', label: 'Allow.', align: 'right', render: (r) => money(r.allowances) },
        { key: 'ot_rate', label: 'OT Rate', align: 'right', render: (r) => (Number(r.ot_applicable) ? (r.ot_rate === null ? 'Auto' : money(r.ot_rate)) : 'No OT') },
        { key: 'flags', label: 'Statutory', render: (r) => [Number(r.eobi_applicable) && 'EOBI', Number(r.pessi_applicable) && 'SS', Number(r.tax_applicable) && 'Tax'].filter(Boolean).join(', ') || '—' },
        { key: 'payment_mode', label: 'Payment', render: (r) => (r.payment_mode === 'bank' ? `Bank ${r.bank_account || ''}` : 'Cash') },
        { key: 'reason', label: 'Reason' },
        { key: 'state', label: '', render: (r) => h('span', null,
          r.is_current ? h('span', { class: 'badge ok' }, 'Current') : null, ' ',
          r.is_locked ? h('span', { class: 'badge warn', title: 'Used by a posted salary sheet' }, 'Locked') : null) },
      ],
      onOpen: (r) => editSalary(r),
      emptyText: 'No salary records yet. Click "Add salary record".',
      maxHeight: '320px',
    });

    // ---------- photo
    const photoBox = h('div', { class: 'ph' }, 'No photo');
    const fileInput = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
    const btnPhoto = h('button', { class: 'btn sm', type: 'button', onclick: () => fileInput.click() }, 'Upload…');
    const btnCam = h('button', { class: 'btn sm', type: 'button', title: 'Camera (mobile)', onclick: () => { fileInput.setAttribute('capture', 'user'); fileInput.click(); fileInput.removeAttribute('capture'); } }, 'Camera');
    const btnNoPhoto = h('button', { class: 'btn sm danger', type: 'button', onclick: () => removePhoto() }, 'Remove');
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      const blob = await cropImage(f);
      if (!blob) return;
      if (st.emp) await uploadPhoto(st.emp.id, blob);
      else { st.pendingPhoto = blob; showPhoto(URL.createObjectURL(blob)); }
    });
    function showPhoto(url) {
      st.photoUrl = url;
      photoBox.replaceChildren(url ? h('img', { src: url, alt: 'Employee photo' }) : 'No photo');
      btnNoPhoto.disabled = !url || !(st.emp ? canEdit : canAdd);
    }
    async function uploadPhoto(id, blob) {
      const fd = new FormData();
      fd.append('photo', blob, 'photo.jpg');
      try {
        const r = await api('POST', `employees/${id}/photo`, fd);
        showPhoto(r.photo_url);
        if (st.emp) st.emp.photo_url = r.photo_url;
        toast('Photo saved.');
      } catch (e) { toast(e.message, 'err', 6000); }
    }
    async function removePhoto() {
      if (!st.emp) { st.pendingPhoto = null; showPhoto(null); return; }
      if (!(await confirmDialog('Remove this employee\'s photo?', { ok: 'Remove', danger: true }))) return;
      try { await del(`employees/${st.emp.id}/photo`); showPhoto(null); toast('Photo removed.'); } catch (e) { toast(e.message, 'err'); }
    }

    // ---------- tabs
    const tabNames = ['Employee Info', 'Salary Info', 'Qualification', 'Experience', 'List of Employees'];
    const tabBtns = tabNames.map((n, i) => h('button', { type: 'button', onclick: () => showTab(i) }, n));
    const metaLine = h('div', { class: 'meta-line' });
    const salaryNewBox = h('div', null, h('p', { class: 'muted', style: 'margin-top:0' }, 'Initial salary — saved together with the employee (effective from the joining date).'), salaryForm.el);
    const salaryHistBtns = h('div', { style: 'display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap' },
      h('button', { class: 'btn', type: 'button', onclick: () => editSalary(null) }, '+ Add salary record / increment'),
      h('button', { class: 'btn', type: 'button', onclick: () => salaryGrid.current() && editSalary(salaryGrid.current()) }, 'Edit selected'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => deleteSalary() }, 'Delete selected'),
      h('span', { class: 'muted', style: 'align-self:center;font-size:12px' }, 'Increments add a new effective-dated record; history is kept.'));
    const salaryHistBox = h('div', null, salaryHistBtns, salaryGrid.el);
    const salaryHint = h('div', { class: 'help', style: 'margin-top:8px' });

    // List tab
    const listSearch = h('input', { class: 'input', type: 'search', placeholder: 'Search code / name / CNIC / cell…', style: 'max-width:380px' });
    const listGrid = new DataGrid({
      columns: [
        { key: 'id', label: 'ID', align: 'right' },
        { key: 'code', label: 'Code' },
        { key: 'name', label: 'Name' },
        { key: 'name_ur', label: 'نام', urdu: true },
        { key: 'department', label: 'Department' },
        { key: 'designation', label: 'Designation' },
        { key: 'emp_type', label: 'Type', render: (r) => TYPES[r.emp_type] },
        { key: 'status', label: 'Status', render: (r) => h('span', { class: 'badge ' + (r.status === 'active' ? 'ok' : 'off') }, r.status) },
      ],
      onOpen: (r) => openEmployee(r.id).then(() => showTab(0)),
      rowClass: (r) => (r.status === 'inactive' ? 'dim' : ''),
    });
    const loadListTab = async () => {
      const d = await get('employees', { q: listSearch.value.trim(), per_page: 500, sort: 'code' });
      listGrid.setRows(d.rows);
      if (st.emp) listGrid.selectBy((r) => r.id === st.emp.id, false);
    };
    listSearch.addEventListener('input', debounce(loadListTab, 250));
    listSearch.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); listGrid.focus(); } });

    const panes = [
      h('div', { class: 'emp-top' }, h('div', null, form.el, metaLine),
        h('div', { class: 'photo-box' }, photoBox, h('div', { class: 'btns' }, btnPhoto, btnCam, btnNoPhoto), fileInput,
          h('div', { class: 'muted', style: 'font-size:11px;text-align:center' }, 'Photo is cropped to 3:4 for the ID card'))),
      h('div', null, salaryNewBox, salaryHistBox, salaryHint),
      quals.el,
      exps.el,
      h('div', null, h('div', { class: 'filters' }, listSearch, h('span', { class: 'muted', style: 'font-size:12px;align-self:center' }, 'Double-click or Enter opens the employee')), listGrid.el),
    ];
    const tabBody = h('div', { class: 'tab-body' }, panes);
    let tab = 0;
    function showTab(i) {
      tab = i;
      tabBtns.forEach((b, j) => b.classList.toggle('active', i === j));
      panes.forEach((p, j) => p.classList.toggle('hidden', i !== j));
      if (i === 4) loadListTab().then(() => listSearch.focus());
    }

    function hintSalary() {
      const t = form.get('emp_type');
      salaryHint.textContent = t === 'daily_wages'
        ? 'Daily wages: pay = daily rate × present days + overtime. Basic salary may be left 0.'
        : 'Monthly: work pay = basic salary ÷ days in month × paid days.';
    }

    // ---------- toolbar
    const recLabel = h('span', { class: 'rec' });
    const btnSave = h('button', { class: 'btn primary', type: 'button', onclick: () => save() }, 'Save ', h('kbd', null, 'F10'));
    const btnDel = h('button', { class: 'btn danger', type: 'button', onclick: () => remove() }, 'Delete ', h('kbd', null, 'F12'));
    const btnCard = h('button', { class: 'btn', type: 'button', onclick: () => printCard() }, h('span', { class: 'lbl' }, 'ID Card '), h('kbd', null, 'F9'));

    function isDirty() {
      return form.dirty || st.childDirty || (!st.emp && (salaryForm.dirty || !!st.pendingPhoto));
    }

    function fill(emp) {
      st.emp = emp;
      st.pendingPhoto = null;
      st.childDirty = false;
      // keep inactive masters selectable when the employee already uses them
      for (const [list, key] of [[lookups.departments, 'department_id'], [lookups.designations, 'designation_id'], [lookups.shift_groups, 'shift_group_id']]) {
        list.forEach((x) => { x.__keep = emp && x.id === emp[key]; });
      }
      form.refreshOptions();
      form.values = emp ? { ...emp, id: emp.id } : { ...NEW_DEFAULTS, id: '(new)' };
      quals.setRows(emp?.qualifications || []);
      exps.setRows(emp?.experiences || []);
      salaryNewBox.classList.toggle('hidden', !!emp);
      salaryHistBox.classList.toggle('hidden', !emp);
      if (emp) salaryGrid.setRows(emp.salary_history || []);
      else salaryForm.values = { ...SALARY_DEFAULTS };
      showPhoto(emp?.photo_url || null);
      const ro = emp ? !canEdit : !canAdd;
      form.setReadonly(ro);
      quals.setReadonly(ro);
      exps.setReadonly(ro);
      salaryHistBtns.querySelectorAll('button').forEach((b) => { b.disabled = !canEdit; });
      btnPhoto.disabled = btnCam.disabled = ro;
      btnSave.disabled = ro;
      btnDel.disabled = !emp || !canDel;
      btnCard.disabled = !emp || !canPrint;
      recLabel.textContent = emp ? `Auto ID ${emp.id} · ${emp.code} — ${emp.name}` : 'New employee';
      metaLine.textContent = emp
        ? `Created ${fdatetime(emp.created_at)}${emp.created_by_name ? ' by ' + emp.created_by_name : ''}`
          + (emp.updated_at ? ` · Updated ${fdatetime(emp.updated_at)}${emp.updated_by_name ? ' by ' + emp.updated_by_name : ''}` : '')
        : '';
      hintSalary();
    }

    async function confirmDiscard() {
      if (!isDirty()) return true;
      return confirmDialog('Discard unsaved changes to this employee?', { ok: 'Discard', danger: true });
    }

    async function openEmployee(id) {
      if (!(await confirmDiscard())) return false;
      try {
        const emp = await get(`employees/${id}`);
        fill(emp);
        setPath(`/employees/${emp.id}`);
        return true;
      } catch (e) {
        toast(e.message, 'err');
        return false;
      }
    }

    async function newEmployee() {
      if (!canAdd) return;
      if (!(await confirmDiscard())) return;
      fill(null);
      setPath('/employees/new');
      showTab(0);
      try { form.set('code', (await get('employees/next-code')).code); } catch { /* optional */ }
      form.dirty = false;
      form.focus('name');
    }

    async function save() {
      if (btnSave.disabled) return;
      const body = { ...form.values, qualifications: quals.rows, experiences: exps.rows };
      delete body.id;
      if (!st.emp) body.salary = { ...salaryForm.values, effective_from: salaryForm.values.effective_from || body.joining_date };
      try {
        const emp = st.emp ? await put(`employees/${st.emp.id}`, body) : await post('employees', body);
        const wasNew = !st.emp;
        const pending = st.pendingPhoto;
        form.dirty = false;
        fill(emp);
        setPath(`/employees/${emp.id}`);
        if (wasNew && pending) await uploadPhoto(emp.id, pending);
        toast(wasNew ? `Employee ${emp.code} created.` : 'Employee saved.');
      } catch (e) {
        const errs = e.errors || {};
        const keys = Object.keys(errs);
        form.showErrors(errs, keys.length ? '' : e.message);
        salaryForm.showErrors(Object.fromEntries(keys.filter((k) => k.startsWith('salary.')).map((k) => [k, errs[k]])));
        if (keys.some((k) => k.startsWith('salary.'))) showTab(1);
        else if (errs.qualifications) { showTab(2); toast(errs.qualifications, 'err', 6000); }
        else if (errs.experiences) { showTab(3); toast(errs.experiences, 'err', 6000); }
        else if (keys.length) showTab(0);
        else toast(e.message, 'err', 6000);
      }
    }

    async function remove() {
      if (!st.emp || btnDel.disabled) return;
      if (!(await confirmDialog(`Delete employee ${st.emp.code} — ${st.emp.name}?\nThis cannot be undone.`, { ok: 'Delete', danger: true }))) return;
      try {
        await del(`employees/${st.emp.id}`);
        toast('Employee deleted.');
        form.dirty = false;
        st.childDirty = false;
        await newEmployee();
      } catch (e) { toast(e.message, 'err', 8000); }
    }

    async function step(dir) {
      if (!(await confirmDiscard())) return;
      try {
        const emp = await get(`employees/${st.emp?.id || 0}/neighbor`, { dir: dir < 0 ? 'prev' : 'next' });
        if (!emp) { toast(dir < 0 ? 'This is the first record.' : 'This is the last record.', 'warn'); return; }
        form.dirty = false; st.childDirty = false; st.pendingPhoto = null;
        fill(emp);
        setPath(`/employees/${emp.id}`);
      } catch (e) { toast(e.message, 'err'); }
    }

    async function reload() {
      if (!st.emp) return;
      if (!(await confirmDiscard())) return;
      form.dirty = false; st.childDirty = false;
      fill(await get(`employees/${st.emp.id}`));
      toast('Reloaded.');
    }

    function printCard() {
      if (!st.emp || btnCard.disabled) return;
      openReport('id_cards', { ids: st.emp.id });
    }

    // ---------- F1 search dialog
    function searchDialog() {
      const input = h('input', { class: 'input', type: 'search', placeholder: 'Code, name, CNIC, cell, machine ID…' });
      const grid = new DataGrid({
        columns: [
          { key: 'code', label: 'Code' }, { key: 'name', label: 'Name' }, { key: 'name_ur', label: 'نام', urdu: true },
          { key: 'department', label: 'Department' }, { key: 'cnic', label: 'CNIC' },
          { key: 'status', label: 'Status' },
        ],
        maxHeight: '50vh',
        onOpen: async (r) => { m.close(); await openEmployee(r.id); showTab(0); },
      });
      const run = debounce(async () => grid.setRows((await get('employees', { q: input.value.trim(), per_page: 100 })).rows), 200);
      input.addEventListener('input', run);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); grid.focus(); }
        if (e.key === 'Enter') { e.preventDefault(); if (grid.rows.length) grid.o.onOpen(grid.rows[0]); }
      });
      const m = modal({ title: 'Find employee (F1)', body: h('div', null, input, h('div', { style: 'margin-top:8px' }, grid.el)), wide: true });
      run();
    }

    // ---------- salary history dialog (existing employee)
    function editSalary(row) {
      if (!st.emp || !canEdit) return;
      const f = new Form(SALARY_FIELDS);
      const cur = st.emp.salary_history?.find((r) => r.is_current) || st.emp.salary_history?.[0];
      f.values = row || { ...SALARY_DEFAULTS, ...(cur ? { ...cur, effective_from: null, reason: 'Increment', remarks: null } : {}) };
      if (row?.is_locked) f.setReadonly(true);
      modal({
        title: row ? `Salary record effective ${fdate(row.effective_from)}` : 'New salary record / increment',
        body: h('div', null, row?.is_locked ? h('div', { class: 'form-error' }, 'This record is used by a posted salary sheet and cannot be changed.') : null, f.el),
        wide: true,
        buttons: [
          { label: 'Cancel' },
          ...(row?.is_locked ? [] : [{ label: 'Save (F10)', class: 'primary', onClick: async () => {
            try {
              const r = row ? await put(`employees/${st.emp.id}/salary/${row.id}`, f.values) : await post(`employees/${st.emp.id}/salary`, f.values);
              st.emp.salary_history = r.rows;
              salaryGrid.setRows(r.rows);
              toast('Salary record saved.');
              return true;
            } catch (e) { f.showErrors(e.errors, Object.keys(e.errors || {}).length ? '' : e.message); return false; }
          } }]),
        ],
      });
    }

    async function deleteSalary() {
      const row = salaryGrid.current();
      if (!row) { toast('Select a salary record first.', 'warn'); return; }
      if (!(await confirmDialog(`Delete salary record effective ${fdate(row.effective_from)}?`, { ok: 'Delete', danger: true }))) return;
      try {
        const r = await del(`employees/${st.emp.id}/salary/${row.id}`);
        st.emp.salary_history = r.rows;
        salaryGrid.setRows(r.rows);
        toast('Salary record deleted.');
      } catch (e) { toast(e.message, 'err', 6000); }
    }

    setKeys({
      new: newEmployee, save, del: remove, print: printCard, load: reload, search: searchDialog,
      prev: () => step(-1), next: () => step(1),
    });

    root.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', disabled: !canAdd, onclick: newEmployee }, 'New ', h('kbd', null, 'F5')),
        btnSave, btnDel,
        h('span', { class: 'sep' }),
        h('button', { class: 'btn', type: 'button', onclick: searchDialog }, h('span', { class: 'lbl' }, 'Search '), h('kbd', null, 'F1')),
        h('button', { class: 'btn', type: 'button', onclick: reload }, h('span', { class: 'lbl' }, 'Show '), h('kbd', null, 'F7')),
        btnCard,
        h('span', { class: 'sep' }),
        h('button', { class: 'btn icon', type: 'button', title: 'Previous record (PgUp)', onclick: () => step(-1) }, '◀'),
        h('button', { class: 'btn icon', type: 'button', title: 'Next record (PgDn)', onclick: () => step(1) }, '▶'),
        h('span', { class: 'spacer' }), recLabel,
        h('button', { class: 'btn sm', type: 'button', onclick: () => go('/employees') }, 'List')),
      h('div', { class: 'tabs' }, tabBtns),
      tabBody,
    );

    showTab(0);
    if (params.id && /^\d+$/.test(params.id)) {
      try { fill(await get(`employees/${params.id}`)); } catch (e) { toast(e.message, 'err'); await newEmployee(); }
    } else {
      await newEmployee();
    }
    form.focus('name');

    return { canLeave: () => !isDirty() };
  },
};
