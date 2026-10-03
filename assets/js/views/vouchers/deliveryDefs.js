/**
 * Batch 5: Outward Gate Pass / Delivery Chalan (same contract as vouchers/defs.js).
 * Two print formats: the full Delivery Chalan (party box, declaration, receiver
 * block, 1–3 labelled copies from Settings) and a compact Outward Gate Pass.
 */
import { api } from '../../core/api.js';
import { t, getLang } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { esc } from '../../core/ui.js';
import { toOptions, findOpt } from '../../core/lookups.js';
import { qtyFmt } from './defs.js';

const nm = (r, key) => (getLang() === 'ur' && r[`${key}_ur`] ? r[`${key}_ur`] : r[key]);
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const whByType = (lk, type) => (lk.warehouses.find((w) => w.warehouse_type === type) || {}).value ?? '';
const cards = (items) => `<div class="cost-summary">${items.map(([label, value, cls]) =>
  `<div class="${cls || ''}"><span>${esc(label)}</span><strong dir="ltr">${esc(value)}</strong></div>`).join('')}</div>`;

/** Party lots in the dispatch warehouse (for lot hints, design auto-fill and "add all"). */
const lotCache = new Map();
async function partyLots(env) {
  const v = env.values();
  if (!v.party_id || !v.warehouse_id) return [];
  const key = `${v.party_id}|${v.warehouse_id}`;
  if (!lotCache.has(key)) {
    lotCache.set(key, api.get('chalans/party-lots', { party_id: v.party_id, warehouse_id: v.warehouse_id }).catch(() => []));
  }
  return lotCache.get(key);
}

export const chalan = {
  api: 'chalans', perm: 'chalan', title: 'tx.chalan', icon: 'truck',
  lookups: ['parties', 'warehouses', 'items', 'designs'],
  header: () => [
    { key: 'party_id', label: 'f.party', type: 'lookup', set: 'parties', required: true, filter: (o) => o.is_customer || o.is_fabric_owner },
    { key: 'warehouse_id', label: 'f.dispatch_from', type: 'lookup', set: 'warehouses', required: true },
    { key: 'party_ref', label: 'f.party_ref', type: 'text', max: 40, dir: 'ltr' },
    { key: 'vehicle_no', label: 'f.vehicle_no', type: 'text', max: 20, dir: 'ltr', upper: true },
    { key: 'driver_name', label: 'f.driver_name', type: 'text', max: 80 },
    { key: 'driver_phone', label: 'f.driver_phone', type: 'text', inputType: 'tel', max: 30, dir: 'ltr', pattern: '[0-9+\\-\\s\\(\\)]{7,30}' },
    { key: 'receiver_name', label: 'f.receiver_name', type: 'text', max: 80 },
    { key: 'delivery_address', label: 'f.delivery_address', type: 'text', max: 255, span: true },
  ],
  defaults: (env) => ({ warehouse_id: whByType(env.lk, 'finished') }),
  effects: {
    party_id: (env) => {
      const p = findOpt(env.lk.parties, env.values().party_id);
      if (p?.address && !env.values().delivery_address) env.ctx.setValues({ delivery_address: p.address });
      env.grid.rows().forEach((r) => r.refresh());
    },
  },
  stockWh: (v) => v.warehouse_id,
  columns: (env) => {
    const item = (row) => env.item(row);
    const tracked = (row) => Number(item(row)?.track_lots) === 1;
    let lots = [];
    const loadLots = () => partyLots(env).then((l) => { lots = l; });
    env.lotsReady = loadLots;
    return [
      { key: 'item_id', label: t('f.item'), type: 'lookup', rowKey: true,
        options: () => toOptions(env.lk.items, (i) => ['finished_fabric', 'grey_fabric'].includes(i.item_type) && env.hasStock(i.value)),
        onChange: (row) => {
          if (!tracked(row)) row.set('lot_no', '');
          const mine = env.stock.lots(env.wh(), row.get('item_id'));
          if (tracked(row) && mine.length === 1 && !row.get('lot_no')) row.set('lot_no', mine[0].value);
        } },
      { key: 'lot_no', label: t('f.lot'), type: 'text', maxlength: 40, ltr: true,
        readonly: (row) => !tracked(row),
        datalist: (row) => env.stock.lots(env.wh(), row.get('item_id')),
        onChange: (row) => {
          // Design of the lot (from its production) when known.
          const l = lots.find((x) => x.item_id === Number(row.get('item_id')) && x.lot_no === (row.get('lot_no') || '').trim());
          if (l?.design_id && !row.get('design_id')) row.set('design_id', l.design_id);
        } },
      { key: 'design_id', label: t('f.design'), type: 'lookup', options: () => toOptions(env.lk.designs) },
      { key: 'rolls', label: t('f.rolls'), type: 'number', step: '1', min: 0 },
      { key: 'qty', label: t('f.qty'), type: 'number', step: '0.001', min: 0 },
      { key: 'available', label: t('f.available'), type: 'display', format: (row) => {
        const it = item(row);
        if (!it) return '';
        const a = env.available(row);
        return a === null ? '…' : `${qtyFmt(a)} ${it.unit_code}`;
      } },
    ];
  },
  footer: (rows) => ({ rolls: String(sum(rows, 'rolls')), qty: qtyFmt(sum(rows, 'qty')) }),
  mount: (env, form) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.dataset.partyLots = '';
    btn.textContent = t('chalan.add_party_lots');
    btn.addEventListener('click', async () => {
      lotCache.clear();
      const lots = await partyLots(env);
      if (!lots.length) {
        env.lastNote = t('chalan.no_party_lots');
        env.refreshSummary();
        return;
      }
      env.lastNote = '';
      const kept = env.grid.getRows().filter((r) => !lots.some((l) => l.item_id === Number(r.item_id) && l.lot_no === r.lot_no));
      env.grid.setRows([...kept, ...lots.map((l) => ({ item_id: l.item_id, lot_no: l.lot_no, design_id: l.design_id, rolls: l.rolls, qty: qtyFmt(l.qty) }))]);
      env.grid.refreshOptions();
    });
    // Above the grid, so the item dropdown (open on focus) never covers it.
    form.querySelector('[data-grid-name=lines]').prepend(btn);
    env.lotsReady?.();
  },
  async summary(env) {
    const v = env.values();
    env.lotsReady?.();
    if (!v.party_id) return '';
    const s = await api.get('chalans/party-summary', { party_id: v.party_id });
    const fin = s.stock.filter((x) => x.item_type === 'finished_fabric').reduce((a, x) => a + x.qty, 0);
    const grey = s.stock.filter((x) => x.item_type === 'grey_fabric').reduce((a, x) => a + x.qty, 0);
    return `${env.lastNote ? `<div class="notice notice-warn">${esc(env.lastNote)}</div>` : ''}
      <p class="muted">${esc(t('chalan.jobwork_title'))}</p>
      ${cards([
        [t('chalan.received'), `${qtyFmt(s.received)} m`], [t('chalan.printed'), `${qtyFmt(s.produced)} m`],
        [t('chalan.delivered'), `${qtyFmt(s.delivered)} m`], [t('chalan.pending'), `${qtyFmt(s.pending)} m`, s.pending > 0 ? 'warn' : ''],
        [t('chalan.ready_stock'), `${qtyFmt(fin)} m`, 'total'], [t('chalan.grey_stock'), `${qtyFmt(grey)} m`],
      ])}`;
  },
  list: (r) => [`<span>${esc(nm(r, 'party_name'))}</span>`, `<span dir="ltr">${qtyFmt(r.total_qty)} m · ${r.total_rolls} ${esc(t('f.rolls'))}</span>`,
    r.vehicle_no ? `<span dir="ltr">${esc(r.vehicle_no)}</span>` : '', r.party_ref ? `<span dir="ltr">${esc(r.party_ref)}</span>` : ''].join(''),
  view: {
    fields: (v) => [[t('f.party'), `${v.party_code} · ${nm(v, 'party_name')}`], [t('f.party_ref'), v.party_ref],
      [t('f.delivery_address'), v.delivery_address], [t('f.dispatch_from'), nm(v, 'warehouse_name')], [t('f.vehicle_no'), v.vehicle_no],
      [t('f.driver_name'), v.driver_name], [t('f.driver_phone'), v.driver_phone], [t('f.receiver_name'), v.receiver_name]],
    columns: () => [
      { label: t('f.item'), format: (l) => `${l.item_code} · ${nm(l, 'item_name')}` },
      { label: t('f.design'), format: (l) => (l.design_code ? `${l.design_code} · ${l.design_name}` : '') },
      { label: t('f.lot'), key: 'lot_no' },
      { label: t('f.rolls'), key: 'rolls', num: true },
      { label: t('f.qty'), key: 'qty', num: true, format: (l) => `${qtyFmt(l.qty)} ${l.unit_code}` },
    ],
    totals: (v) => ({ rolls: String(v.total_rolls), qty: qtyFmt(v.total_qty) }),
    signatures: () => [t('sign.prepared'), t('sign.gate'), t('sign.driver')],
    prints: () => [
      {
        label: t('print.chalan'),
        build: (doc, v) => {
          const n = Math.max(1, Math.min(3, Number(session.app.chalan_copies) || 2));
          return {
            ...doc,
            title: t('print.chalan_title'),
            party: {
              label: t('print.to'),
              name: `${nm(v, 'party_name')} (${v.party_code})`,
              lines: [v.delivery_address || [v.party_address, v.party_city].filter(Boolean).join(', '),
                [v.party_phone ? `${t('f.phone')}: ${v.party_phone}` : '', v.party_ntn ? `NTN: ${v.party_ntn}` : ''].filter(Boolean).join(' · ')],
            },
            fields: [[t('f.party_ref'), v.party_ref], [t('f.dispatch_from'), nm(v, 'warehouse_name')], [t('f.vehicle_no'), v.vehicle_no],
              [t('f.driver_name'), v.driver_name], [t('f.driver_phone'), v.driver_phone]],
            declaration: session.app.chalan_terms || t('print.default_terms'),
            receiver: true,
            receiverName: v.receiver_name || '',
            copies: ['print.copy.party', 'print.copy.office', 'print.copy.gate'].slice(0, n).map((k) => t(k)),
          };
        },
      },
      {
        label: t('print.gate_pass'),
        build: (doc, v) => ({
          ...doc,
          title: t('print.gate_pass_title'),
          variant: 'gatepass',
          fields: [[t('f.party'), nm(v, 'party_name')], [t('f.vehicle_no'), v.vehicle_no], [t('f.driver_name'), v.driver_name],
            [t('f.driver_phone'), v.driver_phone], [t('f.dispatch_from'), nm(v, 'warehouse_name')]],
          columns: [
            { label: t('f.item'), format: (l) => nm(l, 'item_name') },
            { label: t('f.lot'), key: 'lot_no' },
            { label: t('f.rolls'), key: 'rolls', num: true },
            { label: t('f.qty'), key: 'qty', num: true, format: (l) => `${qtyFmt(l.qty)} ${l.unit_code}` },
          ],
          signatures: [t('sign.store'), t('sign.gate'), t('sign.driver')],
        }),
      },
    ],
  },
};

export const DELIVERY_VOUCHERS = { chalan };
