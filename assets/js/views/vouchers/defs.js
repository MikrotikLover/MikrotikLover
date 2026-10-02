/**
 * Voucher definitions: one object per voucher type drives the shared
 * list (voucherList.js), entry form (voucherForm.js), detail view and print
 * (voucherView.js).
 *
 *  api          endpoint; perm: permission prefix (igp → igp.view/create/edit/cancel)
 *  lookups      lookup sets the form needs
 *  header(env)  formKit fields (voucher_date is added automatically)
 *  defaults(env) initial header values for a new voucher
 *  effects      {field: (env) => void} run when a header field changes
 *  stockWh(v)   warehouse whose stock the grid shows / issues from (null = inward)
 *  columns(env) lineGrid columns; toLine(record line) maps a saved line back into the grid
 *  footer(rows, env) footer cells {columnKey: text}
 *  list(r)      HTML meta for the list row; view: fields / columns / totals / signatures
 */
import { t, fmtNumber, getLang } from '../../core/i18n.js';
import { esc } from '../../core/ui.js';
import { toOptions, findOpt } from '../../core/lookups.js';

const nm = (r, key) => (getLang() === 'ur' && r[`${key}_ur`] ? r[`${key}_ur`] : r[key]);
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const qtyFmt = (n, d = 3) => {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v * 10 ** d) / 10 ** d) : '';
};
const whByType = (lk, type) => (lk.warehouses.find((w) => w.warehouse_type === type) || {}).value ?? '';
const tracked = (env, row) => Number(env.item(row)?.track_lots) === 1;
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;

/* ----------------------------------------------------------- shared columns */

const itemCol = (env, filter = null) => ({
  key: 'item_id', label: t('f.item'), type: 'lookup', rowKey: true,
  options: () => toOptions(env.lk.items, filter),
  onChange: (row) => {
    if (!tracked(env, row) && env.outflow) row.set('lot_no', '');
    const lots = env.outflow ? env.stock.lots(env.wh(), row.get('item_id')) : [];
    if (env.outflow && tracked(env, row) && lots.length === 1 && !row.get('lot_no')) row.set('lot_no', lots[0].value);
  },
});
const lotCol = (env) => ({
  key: 'lot_no', label: t('f.lot'), type: 'text', maxlength: 40, ltr: true,
  // Outflows: lot only for lot-tracked items (skipped by ENTER otherwise), with stock lots suggested.
  readonly: env.outflow ? (row) => !tracked(env, row) : undefined,
  datalist: env.outflow ? (row) => env.stock.lots(env.wh(), row.get('item_id')) : undefined,
});
const rollsCol = () => ({ key: 'rolls', label: t('f.rolls'), type: 'number', step: '1', min: 0 });
const qtyCol = () => ({ key: 'qty', label: t('f.qty'), type: 'number', step: '0.001', min: 0 });
const unitCol = (env) => ({ key: 'unit', label: t('f.unit'), type: 'display', format: (row) => env.item(row)?.unit_code || '' });
const availCol = (env) => ({
  key: 'available', label: t('f.available'), type: 'display',
  format: (row) => {
    const it = env.item(row);
    if (!it) return '';
    const a = env.available(row);
    return a === null ? '…' : `${qtyFmt(a)} ${it.unit_code}`;
  },
});

/* ----------------------------------------------------------- shared view bits */

const viewColumns = {
  item: { label: () => t('f.item'), format: (l) => `${l.item_code} · ${nm(l, 'item_name')}` },
  lot: { label: () => t('f.lot'), key: 'lot_no' },
  rolls: { label: () => t('f.rolls'), key: 'rolls', num: true },
  qty: { label: () => t('f.qty'), key: 'qty', num: true, format: (l) => `${qtyFmt(l.qty)} ${l.unit_code}` },
};
const col = (k) => ({ ...viewColumns[k], label: viewColumns[k].label() });

export const VOUCHERS = {
  /* ======================================================== Inward Gate Pass */
  igp: {
    api: 'igp', perm: 'igp', title: 'tx.igp', icon: 'gate_in', lookups: ['parties', 'warehouses', 'items'],
    header: () => [
      { key: 'party_id', label: 'f.party', type: 'lookup', set: 'parties', required: true },
      { key: 'ownership', label: 'f.ownership', type: 'select', required: true, default: 'job_work',
        options: [{ value: 'job_work', label: 'ownership.job_work' }, { value: 'own', label: 'ownership.own' }] },
      { key: 'warehouse_id', label: 'f.received_in', type: 'lookup', set: 'warehouses', required: true },
      { key: 'party_challan_no', label: 'f.party_challan_no', type: 'text', max: 40, dir: 'ltr' },
      { key: 'vehicle_no', label: 'f.vehicle_no', type: 'text', max: 20, dir: 'ltr', upper: true },
      { key: 'driver_name', label: 'f.driver_name', type: 'text', max: 80 },
      { key: 'driver_phone', label: 'f.driver_phone', type: 'text', inputType: 'tel', max: 30, dir: 'ltr', pattern: '[0-9+\\-\\s\\(\\)]{7,30}' },
    ],
    defaults: (env) => ({ warehouse_id: whByType(env.lk, 'grey'), ownership: 'job_work' }),
    effects: {
      // Fabric owners send job-work fabric; anyone else is a purchase (own stock).
      party_id: (env) => {
        const p = findOpt(env.lk.parties, env.values().party_id);
        if (p) env.ctx.setValues({ ownership: Number(p.is_fabric_owner) ? 'job_work' : 'own' });
      },
    },
    stockWh: () => null,
    columns: (env) => [itemCol(env), lotCol(env), rollsCol(), qtyCol(), unitCol(env)],
    footer: (rows) => ({ rolls: String(sum(rows, 'rolls')), qty: qtyFmt(sum(rows, 'qty')) }),
    list: (r) => [`<span>${esc(nm(r, 'party_name'))}</span>`, `<span dir="ltr">${qtyFmt(r.total_qty)} · ${r.total_rolls} ${esc(t('f.rolls'))}</span>`,
      r.vehicle_no ? `<span dir="ltr">${esc(r.vehicle_no)}</span>` : '', pill(t(`ownership.${r.ownership}`))].join(''),
    view: {
      fields: (v) => [[t('f.party'), `${v.party_code} · ${nm(v, 'party_name')}`], [t('f.ownership'), t(`ownership.${v.ownership}`)],
        [t('f.received_in'), nm(v, 'warehouse_name')], [t('f.party_challan_no'), v.party_challan_no], [t('f.vehicle_no'), v.vehicle_no],
        [t('f.driver_name'), v.driver_name], [t('f.driver_phone'), v.driver_phone]],
      columns: () => [col('item'), col('lot'), col('rolls'), col('qty')],
      totals: (v) => ({ rolls: String(v.total_rolls), qty: qtyFmt(v.total_qty) }),
      signatures: () => [t('sign.gate'), t('sign.store'), t('sign.driver')],
    },
  },

  /* ======================================================== Stock Transfer */
  transfer: {
    api: 'transfers', perm: 'transfer', title: 'tx.transfer', icon: 'transfer', lookups: ['warehouses', 'items'],
    header: () => [
      { key: 'from_warehouse_id', label: 'f.from_warehouse', type: 'lookup', set: 'warehouses', required: true },
      { key: 'to_warehouse_id', label: 'f.to_warehouse', type: 'lookup', set: 'warehouses', required: true,
        filter: (o, v) => String(o.value) !== String(v.from_warehouse_id) },
    ],
    defaults: (env) => ({ from_warehouse_id: whByType(env.lk, 'grey'), to_warehouse_id: whByType(env.lk, 'floor') }),
    stockWh: (v) => v.from_warehouse_id,
    columns: (env) => [itemCol(env, (i) => env.hasStock(i.value)), lotCol(env), rollsCol(), qtyCol(), availCol(env)],
    footer: (rows) => ({ rolls: String(sum(rows, 'rolls')), qty: qtyFmt(sum(rows, 'qty')) }),
    list: (r) => `<span>${esc(nm(r, 'from_warehouse_name'))} → ${esc(nm(r, 'to_warehouse_name'))}</span><span dir="ltr">${qtyFmt(r.total_qty)} · ${r.total_rolls} ${esc(t('f.rolls'))}</span>`,
    view: {
      fields: (v) => [[t('f.from_warehouse'), nm(v, 'from_warehouse_name')], [t('f.to_warehouse'), nm(v, 'to_warehouse_name')]],
      columns: () => [col('item'), col('lot'), col('rolls'), col('qty')],
      totals: (v) => ({ rolls: String(v.total_rolls), qty: qtyFmt(v.total_qty) }),
      signatures: () => [t('sign.issued'), t('sign.received'), t('sign.approved')],
    },
  },

  /* ======================================================== Stock Consumption */
  consumption: {
    api: 'consumptions', perm: 'consumption', title: 'tx.consumption', icon: 'beaker',
    lookups: ['warehouses', 'items', 'machines', 'designs', 'parties'],
    header: () => [
      { key: 'warehouse_id', label: 'f.issue_from', type: 'lookup', set: 'warehouses', required: true },
      { key: 'machine_id', label: 'f.machine', type: 'lookup', set: 'machines' },
      { key: 'purpose', label: 'f.purpose', type: 'select', required: true, default: 'production',
        options: ['production', 'sampling', 'maintenance', 'cleaning', 'other'].map((p) => ({ value: p, label: `purpose.${p}` })) },
      { key: 'design_id', label: 'f.design', type: 'lookup', set: 'designs' },
      { key: 'party_id', label: 'f.job_party', type: 'lookup', set: 'parties', filter: (o) => o.is_customer || o.is_fabric_owner },
    ],
    defaults: (env) => ({ warehouse_id: whByType(env.lk, 'floor'), purpose: 'production' }),
    effects: {
      machine_id: (env) => {
        const m = findOpt(env.lk.machines, env.values().machine_id);
        if (m?.warehouse_id && !env.values().warehouse_id) env.ctx.setValues({ warehouse_id: m.warehouse_id });
      },
      design_id: (env) => {
        const d = findOpt(env.lk.designs, env.values().design_id);
        if (d?.party_id && !env.values().party_id) env.ctx.setValues({ party_id: d.party_id });
      },
    },
    stockWh: (v) => v.warehouse_id,
    columns: (env) => [
      { ...itemCol(env, (i) => !['grey_fabric', 'finished_fabric'].includes(i.item_type) && env.hasStock(i.value)),
        onChange: (row) => { itemCol(env).onChange(row); const it = env.item(row); row.set('rate', it ? Number(it.rate) : ''); } },
      lotCol(env), qtyCol(),
      { key: 'rate', label: t('f.rate_short'), type: 'number', step: '0.0001', min: 0 },
      { key: 'amount', label: t('f.amount'), type: 'display', format: (row) => (env.item(row) ? fmtNumber((Number(row.get('qty')) || 0) * (Number(row.get('rate')) || 0), 2) : '') },
      availCol(env),
    ],
    footer: (rows) => ({ amount: fmtNumber(rows.reduce((s, r) => s + (Number(r.qty) || 0) * (Number(r.rate) || 0), 0), 2) }),
    list: (r) => [`<span>${esc(nm(r, 'warehouse_name'))}</span>`, r.machine_name ? `<span>${esc(nm(r, 'machine_name'))}</span>` : '',
      r.design_code ? `<span dir="ltr">${esc(r.design_code)}</span>` : '', pill(t(`purpose.${r.purpose}`)),
      `<span dir="ltr">Rs ${fmtNumber(r.total_amount, 2)}</span>`].join(''),
    view: {
      fields: (v) => [[t('f.issue_from'), nm(v, 'warehouse_name')], [t('f.machine'), v.machine_name ? nm(v, 'machine_name') : ''],
        [t('f.purpose'), t(`purpose.${v.purpose}`)], [t('f.design'), v.design_code ? `${v.design_code} · ${v.design_name}` : ''],
        [t('f.job_party'), v.party_name ? nm(v, 'party_name') : '']],
      columns: () => [col('item'), col('lot'), col('qty'),
        { label: t('f.rate_short'), num: true, format: (l) => fmtNumber(l.rate, 2) },
        { label: t('f.amount'), key: 'amount', num: true, format: (l) => fmtNumber(l.amount, 2) }],
      totals: (v) => ({ amount: fmtNumber(v.total_amount, 2) }),
      signatures: () => [t('sign.issued'), t('sign.operator'), t('sign.approved')],
    },
  },

  /* ======================================================== Ink Loading */
  ink_load: {
    api: 'ink-loads', perm: 'ink_load', title: 'tx.ink_load', icon: 'drop', lookups: ['warehouses', 'items', 'machines', 'ink_colours'],
    header: () => [
      { key: 'machine_id', label: 'f.machine', type: 'lookup', set: 'machines', required: true },
      { key: 'warehouse_id', label: 'f.issue_from', type: 'lookup', set: 'warehouses', required: true },
    ],
    defaults: (env) => ({ warehouse_id: whByType(env.lk, 'floor') }),
    effects: {
      machine_id: (env) => {
        const m = findOpt(env.lk.machines, env.values().machine_id);
        if (m?.warehouse_id) env.ctx.setValues({ warehouse_id: m.warehouse_id });
        env.grid?.refreshOptions();
      },
    },
    stockWh: (v) => v.warehouse_id,
    columns: (env) => {
      const unitQty = (row) => {
        const it = env.item(row);
        return it ? ((Number(row.get('ml_filled')) || 0) / 1000) / Number(it.unit_to_base || 1) : 0;
      };
      return [
        { ...itemCol(env, (i) => {
          if (i.item_type !== 'ink' || i.unit_dimension !== 'volume') return false;
          const m = findOpt(env.lk.machines, env.values().machine_id);
          return !m || !i.process_type || i.process_type === 'any' || i.process_type === m.machine_type;
        }), label: t('f.ink_item') },
        lotCol(env),
        { key: 'ml_filled', label: t('f.ml_filled'), type: 'number', step: '0.001', min: 0 },
        { key: 'qty', label: t('f.stock_qty'), type: 'display', format: (row) => (env.item(row) ? `${qtyFmt(unitQty(row))} ${env.item(row).unit_code}` : '') },
        { key: 'amount', label: t('f.amount'), type: 'display', format: (row) => (env.item(row) ? fmtNumber(unitQty(row) * Number(env.item(row).rate || 0), 2) : '') },
        availCol(env),
      ];
    },
    footer: (rows) => ({ ml_filled: `${qtyFmt(sum(rows, 'ml_filled'))} ml` }),
    list: (r) => `<span>${esc(nm(r, 'machine_name'))}</span><span dir="ltr">${qtyFmt(r.total_ml)} ml</span><span dir="ltr">Rs ${fmtNumber(r.total_amount, 2)}</span>`,
    view: {
      fields: (v) => [[t('f.machine'), `${v.machine_code} · ${nm(v, 'machine_name')}`], [t('f.issue_from'), nm(v, 'warehouse_name')]],
      columns: () => [
        { label: t('f.colour'), format: (l) => `${l.colour_code} · ${nm(l, 'colour_name')}` },
        col('item'), col('lot'),
        { label: t('f.ml_filled'), key: 'ml_filled', num: true, format: (l) => qtyFmt(l.ml_filled) },
        { label: t('f.stock_qty'), num: true, format: (l) => `${qtyFmt(l.qty)} ${l.unit_code}` },
        { label: t('f.amount'), key: 'amount', num: true, format: (l) => fmtNumber(l.amount, 2) }],
      totals: (v) => ({ ml_filled: qtyFmt(v.total_ml), amount: fmtNumber(v.total_amount, 2) }),
      signatures: () => [t('sign.loaded'), t('sign.supervisor')],
    },
  },
};

export { qtyFmt, nm };
