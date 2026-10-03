import { t, fmtDate, todayPK, getLang } from '../core/i18n.js';
import { session, can } from '../core/session.js';
import { esc, spinner, errorState } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { loadLookups } from '../core/lookups.js';
import { REPORTS, REPORT_LOOKUPS, toQuery } from './reports/defs.js';
import { mountReportForm } from './reports/form.js';
import { renderDashboard } from './dashboard.js';
import { navigate } from '../app.js';

/**
 * Home: "Transactions" vertical card list, "Reporting" accordion, "Setup" list.
 * Reports open into their filter form; "View" goes to #/r/<key>, Excel / CSV /
 * PDF download straight from here. The dashboard sits on top (dashboard.view).
 */
const TRANSACTIONS = [
  { key: 'igp', icon: 'gate_in', perm: 'igp.view' },
  { key: 'transfer', icon: 'transfer', perm: 'transfer.view' },
  { key: 'consumption', icon: 'beaker', perm: 'consumption.view' },
  { key: 'ink_load', icon: 'drop', perm: 'ink_load.view' },
  { key: 'estimation', icon: 'calculator', perm: 'estimation.view' },
  { key: 'bom_production', icon: 'layers', perm: 'bom_production.view' },
  { key: 'manual_production', icon: 'wrench', perm: 'manual_production.view' },
  { key: 'chalan', icon: 'truck', perm: 'chalan.view' },
];

const SETUP = [
  { key: 'parties', icon: 'briefcase', perm: 'parties.view', href: '#/m/parties' },
  { key: 'items', icon: 'box', perm: 'items.view', href: '#/m/items' },
  { key: 'designs', icon: 'image', perm: 'designs.view', href: '#/designs' },
  { key: 'inks', icon: 'drop', perm: ['inks.view', 'items.view'], href: '#/m/inks' },
  { key: 'ink_colours', icon: 'drop', perm: 'inks.view', href: '#/m/ink_colours' },
  { key: 'machines', icon: 'printer', perm: 'machines.view', href: '#/m/machines' },
  { key: 'warehouses', icon: 'warehouse', perm: 'warehouses.view', href: '#/m/warehouses' },
  { key: 'units', icon: 'ruler', perm: 'units.view', href: '#/m/units' },
  { key: 'users', icon: 'users', perm: 'users.view', href: '#/users' },
  { key: 'roles', icon: 'shield', perm: 'roles.manage', href: '#/roles' },
  { key: 'settings', icon: 'wrench', perm: 'settings.manage', href: '#/settings' },
  { key: 'audit', icon: 'history', perm: 'audit.view', href: '#/audit' },
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

      ${can('dashboard.view') ? `
      <section class="section" aria-labelledby="h-dash">
        <h2 class="section-title" id="h-dash">${esc(t('home.dashboard'))}</h2>
        <div class="dashboard" data-dashboard>${spinner()}</div>
      </section>` : ''}

      ${tx.length ? `
      <section class="section" aria-labelledby="h-tx">
        <h2 class="section-title" id="h-tx">${esc(t('home.transactions'))}</h2>
        <ul class="tile-list card">
          ${tx.map((x) => card({
            // Data-entry users land straight on a new voucher; view-only users on the register.
            href: can(x.perm.replace('.view', '.create')) ? `#/v/${x.key}/new` : `#/v/${x.key}`,
            iconName: x.icon, title: t(`tx.${x.key}`), desc: t(`tx.${x.key}.desc`), batch: x.batch,
          })).join('')}
        </ul>
      </section>` : ''}

      ${reports.length ? `
      <section class="section" aria-labelledby="h-rpt">
        <h2 class="section-title" id="h-rpt">${esc(t('home.reporting'))}</h2>
        <div class="accordion card">
          ${reports.map((r) => `
            <details class="acc-item" data-report="${esc(r.key)}">
              <summary><span class="tile-icon">${icon(r.icon || 'chart')}</span><span class="tile-title">${esc(t(`rpt.${r.key}`))}</span>
                <span class="acc-caret">${icon('chevron_down', { size: 20 })}</span></summary>
              <div class="acc-body" data-report-body></div>
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

    const dash = main.querySelector('[data-dashboard]');
    if (dash) renderDashboard(dash).catch((err) => { dash.innerHTML = errorState(err.message); });

    // Each report's filter form is built the first time it is opened.
    const forms = new Map();
    const items = [...main.querySelectorAll('.acc-item')];
    items.forEach((d) => d.addEventListener('toggle', async () => {
      if (!d.open) return;
      // Only one report open at a time keeps the list tidy on phones.
      items.forEach((o) => { if (o !== d) o.open = false; });
      const def = REPORTS.find((x) => x.key === d.dataset.report);
      const body = d.querySelector('[data-report-body]');
      if (!forms.has(def.key)) {
        body.innerHTML = spinner();
        try {
          const lk = await loadLookups(REPORT_LOOKUPS);
          forms.set(def.key, mountReportForm(body, def, lk, {
            onView: (q) => { navigate(`/r/${def.key}?${new URLSearchParams(toQuery(q))}`); return true; },
          }));
        } catch (err) {
          body.innerHTML = errorState(err.message);
          return;
        }
      }
      forms.get(def.key).nav.focusFirst();
    }));
    return () => forms.forEach((f) => f.destroy());
  },
};
