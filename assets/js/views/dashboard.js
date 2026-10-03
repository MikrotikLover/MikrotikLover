/**
 * Home dashboard (GET dashboard): today's KPIs, production by machine,
 * ink & paper below reorder level, pending deliveries, top customers.
 * Headline numbers are stat tiles; the only chart is a single-series bar list
 * (one hue, values labelled in text, so nothing depends on colour alone).
 */
import { api } from '../core/api.js';
import { t, fmtNumber, todayPK } from '../core/i18n.js';
import { can } from '../core/session.js';
import { esc } from '../core/ui.js';
import { icon } from '../core/icons.js';

const m = (v) => fmtNumber(v, Number(v) % 1 ? 1 : 0);
const day = () => todayPK();
const link = (key, extra = '') => (can(`reports.${key}`) ? `#/r/${key}?date_from=${day()}&date_to=${day()}${extra}` : null);

function kpi({ label, value, unit, href, iconName }) {
  const inner = `<span class="kpi-icon">${icon(iconName, { size: 20 })}</span>
    <span class="kpi-label">${esc(label)}</span>
    <strong class="kpi-value" dir="ltr">${esc(value)}<small>${esc(unit)}</small></strong>`;
  return href ? `<a class="kpi" href="${esc(href)}">${inner}</a>` : `<div class="kpi">${inner}</div>`;
}

function machineBars(rows) {
  const max = Math.max(1, ...rows.map((r) => Number(r.week_qty) || 0));
  if (!rows.length) return `<p class="muted dash-empty">${esc(t('dash.no_machines'))}</p>`;
  return `<ul class="bar-list" aria-label="${esc(t('dash.production_by_machine'))}">${rows.map((r) => {
    const w = Math.round(((Number(r.week_qty) || 0) / max) * 1000) / 10;
    const tip = `${r.machine}: ${m(r.week_qty)} m ${t('dash.last_7_days')} · ${m(r.today_qty)} m ${t('dash.today')}`;
    return `<li class="bar-row" title="${esc(tip)}">
      <span class="bar-name">${esc(r.machine)}</span>
      <span class="bar-track"><span class="bar-fill" style="inline-size:${w}%"></span></span>
      <span class="bar-val" dir="ltr">${esc(m(r.week_qty))} m</span>
      <span class="bar-sub">${esc(t('dash.today'))}: <span dir="ltr">${esc(m(r.today_qty))} m</span></span>
    </li>`;
  }).join('')}</ul>`;
}

function list(rows, emptyKey, render) {
  return rows.length ? `<ul class="dash-list">${rows.map(render).join('')}</ul>` : `<p class="muted dash-empty">${esc(t(emptyKey))}</p>`;
}

export async function renderDashboard(host) {
  const d = await api.get('dashboard');
  const td = d.today;
  host.innerHTML = `
    <div class="kpi-grid">
      ${kpi({ label: t('dash.inward'), value: m(td.inward_qty), unit: ' m', href: link('inward'), iconName: 'gate_in' })}
      ${kpi({ label: t('dash.outward'), value: m(td.outward_qty), unit: ' m', href: link('delivery'), iconName: 'truck' })}
      ${kpi({ label: t('dash.produced'), value: m(td.produced_qty), unit: ' m', href: link('production'), iconName: 'layers' })}
      ${kpi({ label: t('dash.ink_loaded'), value: fmtNumber(td.ink_ml, 0), unit: ' ml', href: link('ink', '&view=machine'), iconName: 'drop' })}
    </div>
    <div class="dash-grid">
      <section class="card dash-card">
        <h3>${esc(t('dash.production_by_machine'))} <span class="muted">· ${esc(t('dash.last_7_days'))}</span></h3>
        ${machineBars(d.production_by_machine)}
      </section>
      <section class="card dash-card" data-low-stock>
        <h3>${esc(t('dash.low_stock'))}</h3>
        ${list(d.low_stock, 'dash.no_low_stock', (r) => `<li>
          <span class="status-warn" title="${esc(t('dash.below_reorder'))}">${icon('alert', { size: 18 })}</span>
          <span class="dash-main">${r.colour_hex ? `<span class="dot" style="background:${esc(r.colour_hex)}"></span>` : ''}${esc(r.item)}
            <small class="muted">${esc(t(`item_type.${r.item_type}`))} · ${esc(t('dash.below_reorder'))}</small></span>
          <span class="dash-num" dir="ltr">${esc(fmtNumber(r.stock_qty, 2))} / ${esc(fmtNumber(r.reorder_level, 2))} ${esc(r.unit)}</span></li>`)}
        ${can('reports.stock') ? `<a class="dash-more" href="#/r/stock?view=reorder&item_type=all&date_from=${day()}&date_to=${day()}">${esc(t('dash.see_all'))}</a>` : ''}
      </section>
      <section class="card dash-card" data-pending>
        <h3>${esc(t('dash.pending_deliveries'))}</h3>
        ${list(d.pending_deliveries, 'dash.no_pending', (r) => `<li>
          <span class="dash-main">${esc(r.party)}<small class="muted">${esc(t('dash.ready'))}: <span dir="ltr">${esc(m(r.ready_qty))} m</span></small></span>
          <span class="dash-num" dir="ltr">${esc(m(r.pending_qty))} m</span></li>`)}
        ${can('reports.delivery') ? `<a class="dash-more" href="#/r/delivery?view=party&date_from=${day().slice(0, 8)}01&date_to=${day()}">${esc(t('dash.see_all'))}</a>` : ''}
      </section>
      <section class="card dash-card" data-top>
        <h3>${esc(t('dash.top_customers'))} <span class="muted">· ${esc(t('dash.last_30_days'))}</span></h3>
        ${list(d.top_customers, 'dash.no_customers', (r, i) => `<li>
          <span class="dash-rank" dir="ltr">${i + 1}</span>
          <span class="dash-main">${esc(r.party)}<small class="muted">${esc(t('dash.chalans', { n: r.chalans }))}</small></span>
          <span class="dash-num" dir="ltr">${esc(m(r.delivered_qty))} m</span></li>`)}
      </section>
    </div>`;
}
