// System health: database backup download, deployment checks (PHP, extensions, HTTPS, debug, storage, time zone, migrations) and table sizes.
import { get } from '../core/api.js';
import { h } from '../core/dom.js';
import { setKeys } from '../core/keys.js';

const ICON = { ok: ['ok', '✓ OK'], warn: ['warn', '! Check'], fail: ['off', '✕ Fix'] };

export default {
  async mount(root) {
    const box = h('div');
    async function load() {
      const d = await get('system/status');
      const [cls, label] = ICON[d.overall];
      box.replaceChildren(
        h('div', { class: 'panel', style: 'margin-bottom:12px' }, h('div', { class: 'panel-head' }, h('h2', null, 'Deployment checks'),
          h('span', { class: 'badge ' + cls }, d.overall === 'ok' ? '✓ All checks passed' : label), h('span', { class: 'muted', style: 'font-size:12px' }, 'Server time ' + d.server_time)),
          h('div', { class: 'panel-body checks' }, d.checks.map((c) => h('div', { class: 'check' },
            h('span', { class: 'badge ' + ICON[c.status][0] }, ICON[c.status][1]), h('b', null, c.name), h('span', null, c.detail))))),
        h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Largest tables')),
          h('div', { class: 'panel-body' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, h('th', null, 'Table'), h('th', { class: 'num' }, 'Rows (approx.)'), h('th', { class: 'num' }, 'Size (MB)'))),
            h('tbody', null, d.tables.map((t) => h('tr', null, h('td', null, t.name), h('td', { class: 'num' }, Number(t.rows_approx || 0).toLocaleString()), h('td', { class: 'num' }, t.mb))))))),
      );
    }
    setKeys({ load });
    root.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn', type: 'button', onclick: load }, 'Re-check ', h('kbd', null, 'F7')),
      h('a', { class: 'btn primary', href: 'backup.php', title: 'Full database as .sql.gz (restore with phpMyAdmin → Import)' }, '⇩ Download database backup'),
      h('span', { class: 'muted', style: 'font-size:12px' }, 'See DEPLOY.md for how to fix each item on Hostinger.')), box);
    await load();
  },
};
