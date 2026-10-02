// Import device logs (CSV / Excel .xlsx / attlog.dat) when the machine cannot push over the network.
import { api } from '../core/api.js';
import { h, toast, fdate } from '../core/dom.js';
import { setKeys } from '../core/keys.js';
import { go } from '../core/router.js';

export default {
  mount(root) {
    const file = h('input', { type: 'file', accept: '.csv,.txt,.dat,.xlsx', class: 'input', style: 'height:auto;padding:6px' });
    const fmt = h('select', { class: 'input', style: 'width:260px' },
      h('option', { value: 'auto' }, 'Auto (YYYY-MM-DD or DD/MM/YYYY)'),
      h('option', { value: 'dmy' }, 'DD/MM/YYYY (day first)'),
      h('option', { value: 'mdy' }, 'MM/DD/YYYY (month first)'));
    const result = h('div');
    const btn = h('button', { class: 'btn primary', type: 'button', onclick: () => run() }, 'Import ', h('kbd', null, 'F10'));

    async function run() {
      if (!file.files[0]) { toast('Choose a file first.', 'warn'); file.focus(); return; }
      const fd = new FormData();
      fd.append('file', file.files[0]);
      fd.append('date_format', fmt.value);
      btn.disabled = true;
      try {
        const r = await api('POST', 'attendance/import', fd);
        const card = (v, l) => h('div', { class: 'card' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));
        result.replaceChildren(...[
          h('div', { class: 'stat-cards' }, card(r.rows, 'Rows read'), card(r.inserted, 'New punches'), card(r.duplicates, 'Already imported'),
            card(r.unmapped.length, 'Unknown IDs'), card(r.errors.length, 'Errors')),
          r.from ? h('p', null, `Punch dates: ${fdate(r.from)} to ${fdate(r.to)}. `,
            h('button', { class: 'btn sm primary', type: 'button', onclick: () => go('/attendance/post') }, 'Go to Daily Attendance Post →')) : null,
          r.unmapped.length ? h('div', { class: 'form-error' }, 'Not linked to any employee (set Machine ID / check code): ' + r.unmapped.join(', ')) : null,
          r.errors.length ? h('div', { class: 'form-error' }, h('b', null, 'Rows skipped:'), h('ul', null, r.errors.map((e) => h('li', null, e)))) : null,
        ].filter(Boolean));
        toast(`${r.inserted} punch(es) imported.`);
      } catch (e) {
        result.replaceChildren(h('div', { class: 'form-error' }, e.errors?.file || e.message));
      } finally {
        btn.disabled = false;
      }
    }
    setKeys({ save: run });

    root.append(h('div', { class: 'panel', style: 'max-width:900px' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Import machine attendance log'), btn),
      h('div', { class: 'panel-body' },
        h('div', { class: 'form-grid' },
          h('div', { class: 'fld s8 req' }, h('label', null, 'File (.csv, .xlsx, .dat, .txt)'), file),
          h('div', { class: 'fld s4' }, h('label', null, 'Date format in file'), fmt)),
        h('ul', { class: 'muted', style: 'font-size:12.5px;line-height:1.7;margin:12px 0' },
          h('li', null, 'ZKTeco USB export ', h('code', null, 'attlog.dat'), ' (PIN, date-time, state …) is read directly.'),
          h('li', null, 'CSV / Excel with a header row: an ID column (AC-No, PIN, Enroll No, User ID, Machine ID — or Code for employee code) and Date Time (or separate Date and Time).'),
          h('li', null, 'Duplicates are ignored, so the same file can be imported again safely. Unknown machine IDs are kept and linked once the ID is entered on the employee.'),
          h('li', null, 'After importing, run Daily Attendance Post for the dates shown.')),
        result)));
  },
};
