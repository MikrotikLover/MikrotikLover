import { t, fmtDate, todayPK, getLang } from '../core/i18n.js';
import { session, can } from '../core/session.js';
import { esc } from '../core/ui.js';
import { icon } from '../core/icons.js';

/**
 * Home: "Transactions" vertical card list, "Reporting" accordion, "Setup" list.
 * `batch` marks modules that are delivered in a later batch; they are shown
 * (so the layout is complete) but not clickable until their batch lands.
 */
const TRANSACTIONS = [
  { key: 'igp', icon: 'gate_in', perm: 'igp.view', batch: 3 },
  { key: 'transfer', icon: 'transfer', perm: 'transfer.view', batch: 3 },
  { key: 'consumption', icon: 'beaker', perm: 'consumption.view', batch: 3 },
  { key: 'ink_load', icon: 'drop', perm: 'ink_load.view', batch: 3 },
  { key: 'estimation', icon: 'calculator', perm: 'estimation.view', batch: 4 },
  { key: 'bom_production', icon: 'layers', perm: 'bom_production.view', batch: 4 },
  { key: 'manual_production', icon: 'wrench', perm: 'manual_production.view', batch: 4 },
  { key: 'chalan', icon: 'truck', perm: 'chalan.view', batch: 5 },
];

const REPORTS = [
  { key: 'inward', perm: 'reports.inward', filters: ['date_from', 'date_to', 'party', 'item', 'warehouse'] },
  { key: 'transfer', perm: 'reports.transfer', filters: ['date_from', 'date_to', 'item', 'warehouse'] },
  { key: 'consumption', perm: 'reports.consumption', filters: ['date_from', 'date_to', 'item', 'machine', 'design'] },
  { key: 'production', perm: 'reports.production', filters: ['date_from', 'date_to', 'party', 'design', 'machine'] },
  { key: 'delivery', perm: 'reports.delivery', filters: ['date_from', 'date_to', 'party', 'item'] },
  { key: 'ink', perm: 'reports.ink', filters: ['date_from', 'date_to', 'colour', 'machine', 'design'] },
  { key: 'stock', perm: 'reports.stock', filters: ['date_from', 'date_to', 'item', 'warehouse'] },
  { key: 'jobwork', perm: 'reports.jobwork', filters: ['date_from', 'date_to', 'party'] },
];

const SETUP = [
  { key: 'users', icon: 'users', perm: 'users.view', href: '#/users' },
  { key: 'roles', icon: 'shield', perm: 'roles.manage', href: '#/roles' },
  { key: 'audit', icon: 'history', perm: 'audit.view', href: '#/audit' },
  { key: 'parties', icon: 'briefcase', perm: 'parties.view', batch: 2 },
  { key: 'warehouses', icon: 'warehouse', perm: 'warehouses.view', batch: 2 },
  { key: 'items', icon: 'box', perm: 'items.view', batch: 2 },
  { key: 'units', icon: 'ruler', perm: 'units.view', batch: 2 },
  { key: 'designs', icon: 'image', perm: 'designs.view', batch: 2 },
  { key: 'machines', icon: 'printer', perm: 'machines.view', batch: 2 },
  { key: 'inks', icon: 'drop', perm: 'inks.view', batch: 2 },
];

function card({ href, iconName, title, desc, batch }) {
  const inner = `
    <span class="tile-icon">${icon(iconName)}</span>
    <span class="tile-text"><span class="tile-title">${esc(title)}</span>${desc ? `<span class="tile-desc">${esc(desc)}</span>` : ''}</span>
    ${batch ? `<span class="badge">${esc(t('common.coming', { n: batch }))}</span>` : `<span class="tile-go">${icon('chevron_end', { size: 20 })}</span>`}`;
  return batch || !href
    ? `<li><div class="tile is-disabled" aria-disabled="true" title="${esc(t('common.coming_note', { n: batch }))}">${inner}</div></li>`
    : `<li><a class="tile" href="${esc(href)}">${inner}</a></li>`;
}

export default {
  title: () => t('nav.home'),
  render(main) {
    const u = session.user;
    const tx = TRANSACTIONS.filter((x) => can(x.perm));
    const reports = REPORTS.filter((x) => can(x.perm));
    const setup = SETUP.filter((x) => can(x.perm));

    main.innerHTML = `
      <section class="hello card">
        <div>
          <h2>${esc(t('home.greeting', { name: u.full_name }))}</h2>
          <p>${esc(getLang() === 'ur' ? u.role_name_ur || u.role_name : u.role_name)} · <span dir="ltr">${esc(fmtDate(todayPK()))}</span></p>
        </div>
      </section>

      ${tx.length ? `
      <section class="section" aria-labelledby="h-tx">
        <h2 class="section-title" id="h-tx">${esc(t('home.transactions'))}</h2>
        <ul class="tile-list card">
          ${tx.map((x) => card({ href: `#/${x.key}`, iconName: x.icon, title: t(`tx.${x.key}`), desc: t(`tx.${x.key}.desc`), batch: x.batch })).join('')}
        </ul>
      </section>` : ''}

      ${reports.length ? `
      <section class="section" aria-labelledby="h-rpt">
        <h2 class="section-title" id="h-rpt">${esc(t('home.reporting'))}</h2>
        <div class="accordion card">
          ${reports.map((r) => `
            <details class="acc-item">
              <summary><span class="tile-icon">${icon('chart')}</span><span class="tile-title">${esc(t(`rpt.${r.key}`))}</span>
                <span class="badge">${esc(t('common.coming', { n: 6 }))}</span><span class="acc-caret">${icon('chevron_down', { size: 20 })}</span></summary>
              <div class="acc-body">
                <p class="muted">${esc(t('home.report_filters'))}:</p>
                <div class="chips">${r.filters.map((f) => `<span class="chip">${esc(t(`filter.${f}`))}</span>`).join('')}</div>
                <p class="note">${esc(t('common.coming_note', { n: 6 }))}</p>
              </div>
            </details>`).join('')}
        </div>
      </section>` : ''}

      ${setup.length ? `
      <section class="section" aria-labelledby="h-setup">
        <h2 class="section-title" id="h-setup">${esc(t('home.setup'))}</h2>
        <ul class="tile-list card">
          ${setup.map((x) => card({ href: x.href, iconName: x.icon, title: t(`setup.${x.key}`), batch: x.batch })).join('')}
        </ul>
      </section>` : ''}`;

    // Only one report open at a time keeps the list tidy on phones.
    const items = [...main.querySelectorAll('.acc-item')];
    items.forEach((d) => d.addEventListener('toggle', () => {
      if (d.open) items.forEach((o) => { if (o !== d) o.open = false; });
    }));
  },
};
