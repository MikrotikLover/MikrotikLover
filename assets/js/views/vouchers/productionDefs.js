/**
 * Batch 4 voucher definitions: Production Estimation, BOM Production, Manual Production.
 * Same contract as vouchers/defs.js (see the header there), plus:
 *   noGrid, summary(env), toForm(record), extraStockWh(values), mount(env, form).
 */
import { api } from '../../core/api.js';
import { t, fmtNumber, getLang } from '../../core/i18n.js';
import { esc } from '../../core/ui.js';
import { toOptions, findOpt } from '../../core/lookups.js';
import { qtyFmt } from './defs.js';

const nm = (r, key) => (getLang() === 'ur' && r[`${key}_ur`] ? r[`${key}_ur`] : r[key]);
const rs = (n) => `Rs ${fmtNumber(n, 2)}`;
const whByType = (lk, type) => (lk.warehouses.find((w) => w.warehouse_type === type) || {}).value ?? '';
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const dtLocal = (v) => (v ? String(v).replace(' ', 'T').slice(0, 16) : '');
const cards = (items) => `<div class="cost-summary">${items.map(([label, value, cls]) =>
  `<div class="${cls || ''}"><span>${esc(label)}</span><strong dir="ltr">${esc(value)}</strong></div>`).join('')}</div>`;
const variance = (est, act) => (Number(est) > 0 ? ((Number(act) - Number(est)) / Number(est)) * 100 : null);
const pct = (v) => (v === null ? '' : `${v > 0 ? '+' : ''}${fmtNumber(v, 1)}%`);

/* ============================================================ Estimation */

const estimation = {
  api: 'estimations', perm: 'estimation', title: 'tx.estimation', icon: 'calculator',
  lookups: ['parties', 'designs', 'machines', 'items', 'ink_params'],
  noGrid: true,
  header: () => [
    { key: 'design_id', label: 'f.design', type: 'lookup', set: 'designs', required: true },
    { key: 'party_id', label: 'f.customer', type: 'lookup', set: 'parties', filter: (o) => o.is_customer || o.is_fabric_owner },
    { key: 'order_ref', label: 'f.order_ref', type: 'text', max: 40, dir: 'ltr' },
    { key: 'meters', label: 'f.order_meters', type: 'number', min: 0.01, step: '0.01', required: true },
    { key: 'wastage_pct', label: 'f.wastage', type: 'number', min: 0, maxValue: 100, step: '0.01' },
    { key: 'machine_id', label: 'f.machine', type: 'lookup', set: 'machines' },
    { key: 'fabric_item_id', label: 'f.fabric', type: 'lookup', set: 'items', filter: (o) => ['grey_fabric', 'finished_fabric'].includes(o.item_type) },
    { key: 'fabric_gsm', label: 'f.gsm', type: 'number', min: 0, step: '0.01', hint: 'estimation.gsm_hint' },
    { key: 'fabric_width_inch', label: 'f.width_inch', type: 'number', min: 0, step: '0.01' },
  ],
  defaults: (env) => ({ wastage_pct: env.lk.ink_params.default_wastage_pct }),
  effects: {
    design_id: (env) => {
      const d = findOpt(env.lk.designs, env.values().design_id);
      if (!d) return;
      const set = {};
      if (d.party_id && !env.values().party_id) set.party_id = d.party_id;
      if (d.default_machine_id && !env.values().machine_id) set.machine_id = d.default_machine_id;
      env.ctx.setValues(set);
    },
  },
  stockWh: () => null,
  async summary(env) {
    const v = env.values();
    if (!v.design_id || !(Number(v.meters) > 0)) return `<p class="muted">${esc(t('estimation.enter_design_meters'))}</p>`;
    const body = env.ctx.collect();
    const r = await api.post('estimations/calc', body);
    const tt = r.totals;
    const rows = r.lines.map((l) => `<tr>
      <td>${l.line_type === 'ink' ? `<span class="dot" style="background:${esc(l.colour_hex || '#ccc')}"></span>${esc(l.colour_code)} · ${esc(l.colour_name)}` : esc(t(`line_type.${l.line_type}`))}</td>
      <td>${esc(l.item_name || t('estimation.no_item'))}</td>
      <td class="num" dir="ltr">${esc(qtyFmt(l.qty))} ${esc(l.unit_code)}</td>
      <td class="num" dir="ltr">${esc(fmtNumber(l.amount, 2))}</td></tr>`).join('');
    return `
      ${r.warnings.length ? `<div class="notice notice-warn">${r.warnings.map(esc).join('<br>')}</div>` : ''}
      <p class="muted">${esc(t('estimation.basis', { gross: qtyFmt(r.header.gross_meters), gsm: r.header.fabric_gsm || '—', width: r.header.fabric_width_inch || '—' }))}</p>
      <div class="table-scroll"><table class="vd-lines"><thead><tr><th>${esc(t('estimation.requirement'))}</th><th>${esc(t('f.item'))}</th>
        <th class="num">${esc(t('f.qty'))}</th><th class="num">${esc(t('f.amount'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
      ${cards([
        [t('estimation.ink_total'), `${qtyFmt(tt.ink_ml_total, 0)} ml`], [t('estimation.ink_cost'), rs(tt.ink_cost)],
        [t('estimation.paper_cost'), rs(tt.paper_cost)], [t('estimation.chemical_cost'), rs(tt.chemical_cost)],
        [t('estimation.other_cost'), rs(tt.other_cost)], [t('estimation.machine'), `${qtyFmt(tt.machine_hours, 2)} h · ${rs(tt.machine_cost)}`],
        [t('estimation.total'), rs(tt.total_cost), 'total'], [t('estimation.per_meter'), rs(tt.cost_per_meter), 'total'],
      ])}`;
  },
  list: (r) => [`<span dir="ltr">${esc(r.design_code)}</span>`, r.party_name ? `<span>${esc(nm(r, 'party_name'))}</span>` : '',
    `<span dir="ltr">${qtyFmt(r.meters)} m</span>`, `<span dir="ltr">${rs(r.total_cost)} · ${rs(r.cost_per_meter)}/m</span>`].join(''),
  view: {
    fields: (v) => [[t('f.design'), `${v.design_code} · ${v.design_name}`], [t('f.customer'), v.party_name ? nm(v, 'party_name') : ''],
      [t('f.order_ref'), v.order_ref], [t('f.order_meters'), `${qtyFmt(v.meters)} m`], [t('f.wastage'), `${qtyFmt(v.wastage_pct, 2)}%`],
      [t('f.machine'), v.machine_name ? nm(v, 'machine_name') : ''], [t('f.fabric'), v.fabric_item_name ? `${v.fabric_item_code} · ${v.fabric_item_name}` : ''],
      [t('f.gsm'), v.fabric_gsm ? qtyFmt(v.fabric_gsm) : ''], [t('f.width_inch'), v.fabric_width_inch ? qtyFmt(v.fabric_width_inch) : ''],
      [t('estimation.machine'), `${qtyFmt(v.machine_hours, 2)} h · ${rs(v.machine_cost)}`], [t('estimation.ink_total'), `${qtyFmt(v.ink_ml_total, 0)} ml`],
      [t('estimation.total'), rs(v.total_cost)], [t('estimation.per_meter'), rs(v.cost_per_meter)]],
    columns: () => [
      { label: t('estimation.requirement'), format: (l) => (l.line_type === 'ink' ? `${l.colour_code} · ${nm(l, 'colour_name')}` : t(`line_type.${l.line_type}`)) },
      { label: t('f.item'), format: (l) => (l.item_name ? `${l.item_code} · ${nm(l, 'item_name')}` : '') },
      { label: t('f.qty'), num: true, format: (l) => `${qtyFmt(l.qty)} ${l.unit_code || ''}` },
      { label: t('f.rate_short'), num: true, format: (l) => fmtNumber(l.rate, l.line_type === 'ink' ? 4 : 2) },
      { label: t('f.amount'), key: 'amount', num: true, format: (l) => fmtNumber(l.amount, 2) },
    ],
    totals: (v) => ({ amount: fmtNumber(Number(v.total_cost) - Number(v.machine_cost), 2) }),
    signatures: () => [t('sign.prepared'), t('sign.approved')],
  },
};

/* ============================================================ Production */

function production(kind) {
  const isBom = kind === 'bom';
  const def = {
    api: isBom ? 'productions-bom' : 'productions-manual',
    perm: isBom ? 'bom_production' : 'manual_production',
    title: isBom ? 'tx.bom_production' : 'tx.manual_production',
    icon: isBom ? 'layers' : 'wrench',
    lookups: ['parties', 'designs', 'machines', 'items', 'warehouses', ...(isBom ? ['estimations'] : [])],
    header: () => [
      ...(isBom ? [{ key: 'estimation_id', label: 'f.estimation', type: 'lookup', set: 'estimations' }] : [
        { key: 'manual_reason', label: 'f.manual_reason', type: 'select', required: true, default: 'sampling',
          options: ['sampling', 'reprint', 'non_standard', 'job'].map((r) => ({ value: r, label: `manual_reason.${r}` })) }]),
      { key: 'design_id', label: 'f.design', type: 'lookup', set: 'designs', required: isBom },
      { key: 'party_id', label: 'f.customer', type: 'lookup', set: 'parties', filter: (o) => o.is_customer || o.is_fabric_owner },
      { key: 'machine_id', label: 'f.machine', type: 'lookup', set: 'machines', required: true },
      { key: 'operator_name', label: 'f.operator', type: 'text', max: 80 },
      { key: 'fabric_item_id', label: 'f.grey_fabric', type: 'lookup', set: 'items', required: true, filter: (o) => o.item_type === 'grey_fabric' },
      { key: 'fabric_warehouse_id', label: 'f.fabric_from', type: 'lookup', set: 'warehouses', required: true },
      { key: 'fabric_lot_no', label: 'f.fabric_lot', type: 'text', max: 40, dir: 'ltr' },
      { key: 'produced_qty', label: 'f.produced', type: 'number', min: 0.001, step: '0.001', required: true, hint: 'production.produced_hint' },
      { key: 'wastage_qty', label: 'f.wastage_m', type: 'number', min: 0, step: '0.001' },
      { key: 'rejected_qty', label: 'f.rejected_m', type: 'number', min: 0, step: '0.001' },
      { key: 'produced_rolls', label: 'f.rolls', type: 'number', min: 0, step: '1' },
      { key: 'finished_item_id', label: 'f.finished_item', type: 'lookup', set: 'items', required: true, filter: (o) => o.item_type === 'finished_fabric' },
      { key: 'finished_warehouse_id', label: 'f.finished_to', type: 'lookup', set: 'warehouses', required: true },
      { key: 'finished_lot_no', label: 'f.finished_lot', type: 'text', max: 40, dir: 'ltr', placeholder: 'production.same_lot' },
      { key: 'start_time', label: 'f.start_time', type: 'text', inputType: 'datetime-local' },
      { key: 'end_time', label: 'f.end_time', type: 'text', inputType: 'datetime-local' },
      { key: 'machine_hours', label: 'f.machine_hours', type: 'number', min: 0, step: '0.01', hint: 'production.hours_hint' },
      { key: 'material_warehouse_id', label: 'f.materials_from', type: 'lookup', set: 'warehouses', required: true },
    ],
    defaults: (env) => ({
      fabric_warehouse_id: whByType(env.lk, 'floor'),
      finished_warehouse_id: whByType(env.lk, 'finished'),
      material_warehouse_id: whByType(env.lk, 'floor'),
    }),
    stockWh: (v) => v.material_warehouse_id,
    extraStockWh: (v) => [v.fabric_warehouse_id],
    toForm: (r) => ({
      ...r,
      start_time: dtLocal(r.start_time),
      end_time: dtLocal(r.end_time),
      machine_hours: r.machine_hours !== null ? qtyFmt(r.machine_hours, 2) : '',
      produced_qty: qtyFmt(r.produced_qty), wastage_qty: qtyFmt(r.wastage_qty), rejected_qty: qtyFmt(r.rejected_qty),
      lines: r.lines.map((l) => ({ ...l, est_qty: qtyFmt(l.est_qty), actual_qty: qtyFmt(l.actual_qty) })),
    }),
    effects: {
      estimation_id: (env) => {
        const e = findOpt(env.lk.estimations, env.values().estimation_id);
        if (!e) return;
        const v = env.values();
        env.ctx.setValues({
          design_id: e.design_id, party_id: v.party_id || e.party_id || '', machine_id: v.machine_id || e.machine_id || '',
          fabric_item_id: v.fabric_item_id || e.fabric_item_id || '', produced_qty: v.produced_qty || qtyFmt(e.meters),
        });
        designDefaults(env);
        if (isBom) loadBom(env);
      },
      design_id: (env) => { designDefaults(env); if (isBom) loadBom(env); },
      produced_qty: (env) => { if (isBom) loadBom(env); },
      wastage_qty: (env) => { if (isBom) loadBom(env); },
      rejected_qty: (env) => { if (isBom) loadBom(env); },
    },
    columns: (env) => {
      const isInk = (row) => env.item(row)?.item_type === 'ink';
      return [
        { key: 'item_id', label: t('f.material'), type: 'lookup', rowKey: true,
          options: () => toOptions(env.lk.items, (i) => ['ink', 'paper', 'chemical', 'other'].includes(i.item_type)) },
        { key: 'lot_no', label: t('f.lot'), type: 'text', maxlength: 40, ltr: true,
          readonly: (row) => isInk(row) || Number(env.item(row)?.track_lots) !== 1,
          datalist: (row) => env.stock.lots(env.wh(), row.get('item_id')) },
        { key: 'est_qty', label: t('f.est_qty'), type: 'number', readonly: () => true },
        { key: 'actual_qty', label: t('f.actual_qty'), type: 'number', step: '0.001', min: 0 },
        { key: 'unit', label: t('f.unit'), type: 'display', format: (row) => env.item(row)?.unit_code || '' },
        { key: 'variance', label: t('f.variance'), type: 'display', format: (row) => pct(variance(row.get('est_qty'), row.get('actual_qty') || row.get('est_qty'))) },
        { key: 'amount', label: t('f.amount'), type: 'display',
          format: (row) => (env.item(row) ? fmtNumber(Number(row.get('actual_qty') || row.get('est_qty') || 0) * Number(env.item(row).rate || 0), 2) : '') },
        { key: 'available', label: t('f.available'), type: 'display', format: (row) => {
          if (!env.item(row) || isInk(row)) return isInk(row) ? t('production.ink_loaded') : '';
          const a = env.available(row);
          return a === null ? '…' : `${qtyFmt(a)} ${env.item(row).unit_code}`;
        } },
      ];
    },
    footer: (rows, env) => ({ amount: fmtNumber(rows.reduce((s, r) => {
      const it = findOpt(env.lk.items, r.item_id);
      return s + Number(r.actual_qty || r.est_qty || 0) * Number(it?.rate || 0);
    }, 0), 2) }),
    summary: (env) => summary(env),
    mount: (env, form) => {
      if (!isBom) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.dataset.loadBom = '';
      btn.textContent = t('production.reload_bom');
      btn.addEventListener('click', () => loadBom(env, true));
      form.querySelector('[data-grid-name=lines]').appendChild(btn);
    },
    list: (r) => [`<span dir="ltr">${esc(r.design_code || '')}</span>`, r.party_name ? `<span>${esc(nm(r, 'party_name'))}</span>` : '',
      `<span>${esc(nm(r, 'machine_name'))}</span>`, `<span dir="ltr">${qtyFmt(r.produced_qty)} m</span>`,
      Number(r.wastage_qty) + Number(r.rejected_qty) > 0 ? pill(`${t('f.wastage_m')}: ${qtyFmt(Number(r.wastage_qty) + Number(r.rejected_qty))}`, 'pill-warn') : '',
      !isBom ? pill(t(`manual_reason.${r.manual_reason}`)) : '', `<span dir="ltr">${rs(r.cost_per_meter)}/m</span>`].join(''),
    view: {
      fields: (v) => [
        ...(isBom ? [[t('f.estimation'), v.estimation_no]] : [[t('f.manual_reason'), t(`manual_reason.${v.manual_reason}`)]]),
        [t('f.design'), v.design_code ? `${v.design_code} · ${v.design_name}` : ''], [t('f.customer'), v.party_name ? nm(v, 'party_name') : ''],
        [t('f.machine'), `${v.machine_code} · ${nm(v, 'machine_name')}`], [t('f.operator'), v.operator_name],
        [t('f.grey_fabric'), `${v.fabric_item_code} · ${v.fabric_item_name}${v.fabric_lot_no ? ` (${v.fabric_lot_no})` : ''}`],
        [t('production.fabric_used'), `${qtyFmt(v.fabric_issued_qty)} ${v.fabric_unit_code} · ${v.fabric_warehouse_name}`],
        [t('f.finished_item'), `${v.finished_item_code} · ${v.finished_item_name}${v.finished_lot_no ? ` (${v.finished_lot_no})` : ''}`],
        [t('f.produced'), `${qtyFmt(v.produced_qty)} m · ${v.produced_rolls} ${t('f.rolls')} → ${v.finished_warehouse_name}`],
        [t('f.wastage_m'), `${qtyFmt(v.wastage_qty)} m`], [t('f.rejected_m'), `${qtyFmt(v.rejected_qty)} m`],
        [t('production.wastage_pct'), `${fmtNumber(Number(v.printed_qty) > 0 ? ((Number(v.wastage_qty) + Number(v.rejected_qty)) / Number(v.printed_qty)) * 100 : 0, 2)}%`],
        [t('f.machine_hours'), `${qtyFmt(v.machine_hours, 2)} h`],
        [t('production.ink_est_act'), `${qtyFmt(v.ink_ml_estimated, 0)} / ${qtyFmt(v.ink_ml_actual, 0)} ml ${v.ink_variance_pct !== null ? `(${pct(Number(v.ink_variance_pct))})` : ''}`],
        [t('production.material_cost'), rs(v.material_cost)], [t('estimation.ink_cost'), rs(v.ink_cost)],
        [t('estimation.machine'), rs(v.machine_cost)], [t('estimation.total'), rs(v.total_cost)], [t('production.cost_per_m'), rs(v.cost_per_meter)],
      ],
      columns: () => [
        { label: t('f.material'), format: (l) => `${l.line_type === 'ink' ? `${l.colour_code} · ` : ''}${l.item_code} · ${nm(l, 'item_name')}` },
        { label: t('f.lot'), key: 'lot_no' },
        { label: t('f.est_qty'), num: true, format: (l) => qtyFmt(l.est_qty) },
        { label: t('f.actual_qty'), num: true, format: (l) => `${qtyFmt(l.actual_qty)} ${l.unit_code}` },
        { label: t('f.variance'), num: true, format: (l) => pct(variance(l.est_qty, l.actual_qty)) },
        { label: t('f.amount'), key: 'amount', num: true, format: (l) => fmtNumber(l.amount, 2) },
      ],
      totals: (v) => ({ amount: fmtNumber(v.lines.reduce((s, l) => s + Number(l.amount), 0), 2) }),
      signatures: () => [t('sign.operator'), t('sign.supervisor'), t('sign.store')],
    },
  };
  return def;
}

function designDefaults(env) {
  const v = env.values();
  const d = findOpt(env.lk.designs, v.design_id);
  if (!d) return;
  const set = {};
  if (d.finished_item_id && !v.finished_item_id) set.finished_item_id = d.finished_item_id;
  if (d.default_machine_id && !v.machine_id) set.machine_id = d.default_machine_id;
  if (d.party_id && !v.party_id) set.party_id = d.party_id;
  env.ctx.setValues(set);
}

const printedMeters = (v) => (Number(v.produced_qty) || 0) + (Number(v.wastage_qty) || 0) + (Number(v.rejected_qty) || 0);

/**
 * Fills the material grid from the design BOM for the printed meters.
 * Keeps actual quantities the user already changed; `force` resets them to the estimate.
 */
async function loadBom(env, force = false) {
  const v = env.values();
  const meters = printedMeters(v);
  if (!v.design_id || !(meters > 0)) return;
  let res;
  try {
    res = await api.post('production/requirements', { design_id: v.design_id, meters });
  } catch {
    return;
  }
  const rows = env.grid.rows();
  const byItem = new Map(rows.filter((r) => !r.isEmpty()).map((r) => [String(r.get('item_id')), r]));
  const next = [];
  for (const l of res.lines) {
    const r = byItem.get(String(l.item_id));
    const est = qtyFmt(l.est_qty);
    if (r) {
      const oldEst = r.get('est_qty');
      const act = r.get('actual_qty');
      next.push({ item_id: l.item_id, lot_no: r.get('lot_no'), est_qty: est, actual_qty: force || act === '' || act === oldEst ? est : act });
      byItem.delete(String(l.item_id));
    } else {
      next.push({ item_id: l.item_id, est_qty: est, actual_qty: est });
    }
  }
  // Extra materials the user added (not in the BOM) stay, with no estimate.
  for (const r of byItem.values()) next.push({ item_id: r.get('item_id'), lot_no: r.get('lot_no'), est_qty: '', actual_qty: r.get('actual_qty') });
  env.grid.setRows(next);
  env.grid.refreshOptions();
  env.lastWarnings = res.warnings || [];
  env.refreshSummary();
}

function summary(env) {
  const v = env.values();
  const lk = env.lk;
  const printed = printedMeters(v);
  const produced = Number(v.produced_qty) || 0;
  const rows = env.grid.rows().filter((r) => !r.isEmpty());
  let inkEst = 0; let inkAct = 0; let inkCost = 0; let matCost = 0;
  for (const r of rows) {
    const it = findOpt(lk.items, r.get('item_id'));
    if (!it) continue;
    const act = Number(r.get('actual_qty') || r.get('est_qty') || 0);
    const amount = act * Number(it.rate || 0);
    if (it.item_type === 'ink') {
      inkEst += Number(r.get('est_qty') || 0) * Number(it.unit_to_base) * 1000;
      inkAct += act * Number(it.unit_to_base) * 1000;
      inkCost += amount;
    } else {
      matCost += amount;
    }
  }
  const m = findOpt(lk.machines, v.machine_id);
  let hours = v.machine_hours !== '' ? Number(v.machine_hours) : null;
  if (hours === null && v.start_time && v.end_time) hours = Math.max(0, (new Date(v.end_time) - new Date(v.start_time)) / 3600000);
  if (hours === null) hours = m && Number(m.speed_m_per_hr) > 0 ? printed / Number(m.speed_m_per_hr) : 0;
  const machineCost = hours * Number(m?.hourly_cost || 0);
  const total = inkCost + matCost + machineCost;
  const fabricLot = (v.fabric_lot_no || '').trim();
  const fabricAvail = v.fabric_item_id ? env.stock.available(v.fabric_warehouse_id, v.fabric_item_id, fabricLot || null) : null;
  const short = fabricAvail !== null && printed > fabricAvail + 0.0005;
  const wastePct = printed > 0 ? ((printed - produced) / printed) * 100 : 0;
  const vi = variance(inkEst, inkAct);
  return `
    ${(env.lastWarnings || []).length ? `<div class="notice notice-warn">${env.lastWarnings.map(esc).join('<br>')}</div>` : ''}
    ${cards([
      [t('production.printed'), `${qtyFmt(printed)} m`],
      [t('production.fabric_available'), fabricAvail === null ? '—' : `${qtyFmt(fabricAvail)} m`, short ? 'warn' : ''],
      [t('production.wastage_pct'), `${fmtNumber(wastePct, 2)}%`],
      [t('production.ink_est_act'), `${qtyFmt(inkEst, 0)} / ${qtyFmt(inkAct, 0)} ml${vi === null ? '' : ` (${pct(vi)})`}`],
      [t('production.material_cost'), rs(matCost)], [t('estimation.ink_cost'), rs(inkCost)],
      [t('estimation.machine'), `${qtyFmt(hours, 2)} h · ${rs(machineCost)}`],
      [t('production.cost_per_m'), produced > 0 ? rs(total / produced) : '—', 'total'],
    ])}
    <p class="field-hint">${esc(t('production.cost_note'))}</p>`;
}

export const PRODUCTION_VOUCHERS = {
  estimation,
  bom_production: production('bom'),
  manual_production: production('manual'),
};
