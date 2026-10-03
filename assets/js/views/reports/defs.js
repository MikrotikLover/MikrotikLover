/**
 * Batch 6: report definitions. One entry per report on the home "Reporting"
 * accordion and per #/r/<key> page. Filters are formKit fields; their values
 * go straight to GET reports/<key> as query parameters.
 *
 *   views: [{ value, label }]  — first one is the default (server default too)
 *   types: [{ value, label }]  — optional second selector (inward ownership,
 *                                production BOM/Manual/All)
 *   needs: { view: [filter keys] } — required filters for a view (stock ledger → item)
 */
import { todayPK } from '../../core/i18n.js';

const monthStart = () => `${todayPK().slice(0, 8)}01`;

const F = {
  date_from: () => ({ key: 'date_from', label: 'filter.date_from', type: 'text', inputType: 'date', required: true, default: monthStart, dir: 'ltr' }),
  date_to: () => ({ key: 'date_to', label: 'filter.date_to', type: 'text', inputType: 'date', required: true, default: todayPK, dir: 'ltr' }),
  party: (filter = null) => ({ key: 'party_id', label: 'filter.party', type: 'lookup', set: 'parties', filter }),
  item: (filter = null) => ({ key: 'item_id', label: 'filter.item', type: 'lookup', set: 'items', filter }),
  design: () => ({ key: 'design_id', label: 'filter.design', type: 'lookup', set: 'designs' }),
  warehouse: () => ({ key: 'warehouse_id', label: 'filter.warehouse', type: 'lookup', set: 'warehouses' }),
  machine: () => ({ key: 'machine_id', label: 'filter.machine', type: 'lookup', set: 'machines' }),
  colour: () => ({ key: 'ink_colour_id', label: 'filter.colour', type: 'lookup', set: 'ink_colours' }),
  lot: () => ({ key: 'lot_no', label: 'filter.lot', type: 'text', max: 40, dir: 'ltr' }),
  itemType: (opts) => ({ key: 'item_type', label: 'filter.item_type', type: 'select',
    options: opts.map((v) => ({ value: v, label: v === 'all' ? 'rpt.all' : `item_type.${v}` })) }),
};

const fabric = (o) => ['grey_fabric', 'finished_fabric'].includes(o.item_type);
const view = (v, key) => ({ value: v, label: `rview.${key}.${v}` });

export const REPORTS = [
  {
    key: 'inward', perm: 'reports.inward', icon: 'gate_in',
    types: [{ value: '', label: 'rpt.all' }, { value: 'own', label: 'ownership.own' }, { value: 'job_work', label: 'ownership.job_work' }],
    filters: () => [F.date_from(), F.date_to(), F.party(), F.item(), F.warehouse()],
  },
  {
    key: 'transfer', perm: 'reports.transfer', icon: 'transfer',
    filters: () => [F.date_from(), F.date_to(), F.item(), F.warehouse()],
  },
  {
    key: 'consumption', perm: 'reports.consumption', icon: 'beaker',
    views: ['detail', 'item', 'machine', 'job'].map((v) => view(v, 'consumption')),
    filters: () => [F.date_from(), F.date_to(), F.item(), F.machine(), F.design(), F.party(), F.warehouse()],
  },
  {
    key: 'production', perm: 'reports.production', icon: 'layers',
    types: [{ value: '', label: 'rpt.all' }, { value: 'bom', label: 'tx.bom_production' }, { value: 'manual', label: 'tx.manual_production' }],
    views: ['vouchers', 'materials', 'machine'].map((v) => view(v, 'production')),
    filters: () => [F.date_from(), F.date_to(), F.party(), F.design(), F.machine()],
  },
  {
    key: 'delivery', perm: 'reports.delivery', icon: 'truck',
    views: ['vouchers', 'party'].map((v) => view(v, 'delivery')),
    filters: () => [F.date_from(), F.date_to(), F.party((o) => o.is_customer || o.is_fabric_owner), F.item(fabric), F.design(), F.warehouse()],
  },
  {
    key: 'ink', perm: 'reports.ink', icon: 'drop',
    views: ['colour', 'machine', 'design', 'cost', 'ledger', 'reorder'].map((v) => view(v, 'ink')),
    filters: () => [F.date_from(), F.date_to(), F.colour(), F.machine(), F.design(), F.item((o) => o.item_type === 'ink'), F.warehouse()],
  },
  {
    key: 'stock', perm: 'reports.stock', icon: 'box',
    views: ['current', 'ledger', 'reorder'].map((v) => view(v, 'stock')),
    needs: { ledger: ['item_id'] },
    filters: () => [F.date_from(), F.date_to(), F.item(), F.warehouse(), F.party(), F.lot(),
      F.itemType(['all', 'grey_fabric', 'finished_fabric', 'ink', 'paper', 'chemical', 'other'])],
  },
  {
    key: 'jobwork', perm: 'reports.jobwork', icon: 'briefcase',
    filters: () => [F.date_from(), F.date_to(), F.party((o) => o.is_fabric_owner)],
  },
];

export const REPORT_LOOKUPS = ['parties', 'items', 'designs', 'warehouses', 'machines', 'ink_colours'];

/** Filters with the view / type selectors prepended as plain selects (enterNav order). */
export function reportFields(def) {
  const out = [];
  if (def.views) out.push({ key: 'view', label: 'filter.view', type: 'select', required: true, placeholder: false, options: def.views });
  if (def.types) out.push({ key: 'type', label: 'filter.type', type: 'select', placeholder: false, options: def.types });
  return [...out, ...def.filters()];
}

/** Collected form values → query object (empty values dropped). */
export function toQuery(values) {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== null && v !== '' && v !== undefined).map(([k, v]) => [k, String(v)]));
}
