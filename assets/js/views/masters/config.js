/**
 * Master data screens are generated from these definitions
 * (list: views/masterList.js, form: views/masterForm.js).
 *
 * key       route segment (#/m/<key>), api: endpoint, title: i18n key
 * perm      {view, manage}; lookups: sets loaded for the form
 * fixed     values always sent (e.g. Ink Master → item_type=ink)
 * listQuery fixed list filters; filters: extra list filter selects
 * list      {lead, title, sub, meta} row renderers (return HTML-safe strings via esc)
 * fields    see core/formKit.js
 */
import { t, fmtNumber, getLang } from '../../core/i18n.js';
import { esc } from '../../core/ui.js';

const nm = (r, key = 'name') => (getLang() === 'ur' && r[`${key}_ur`] ? r[`${key}_ur`] : r[key]);
const pill = (text, cls = '') => `<span class="pill ${cls}">${esc(text)}</span>`;
const swatch = (hex) => `<span class="swatch" style="background:${esc(/^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#ccc')}"></span>`;

const PROCESS = [
  { value: 'sublimation', label: 'process.sublimation' },
  { value: 'reactive', label: 'process.reactive' },
  { value: 'pigment', label: 'process.pigment' },
];
const ITEM_TYPES = [
  { value: 'grey_fabric', label: 'item_type.grey_fabric' },
  { value: 'finished_fabric', label: 'item_type.finished_fabric' },
  { value: 'ink', label: 'item_type.ink' },
  { value: 'paper', label: 'item_type.paper' },
  { value: 'chemical', label: 'item_type.chemical' },
  { value: 'other', label: 'item_type.other' },
];
const codeField = (max = 20) => ({ key: 'code', label: 'f.code', type: 'text', max, dir: 'ltr', hint: 'f.code_auto', upper: true });
const nameFields = (max) => [
  { key: 'name', label: 'f.name', type: 'text', max, required: true },
  { key: 'name_ur', label: 'f.name_ur', type: 'text', max, dir: 'rtl' },
];
const active = { key: 'is_active', label: 'common.active', type: 'checkbox', default: true };
const typeIs = (...types) => (v) => types.includes(v.item_type);

export const MASTERS = {
  parties: {
    api: 'parties', title: 'setup.parties', icon: 'briefcase',
    perm: { view: 'parties.view', manage: 'parties.manage' },
    filters: [{ key: 'type', label: 'party.type', options: [
      { value: 'customer', label: 'party.customer' }, { value: 'supplier', label: 'party.supplier' }, { value: 'fabric_owner', label: 'party.fabric_owner' }] }],
    list: {
      title: (r) => esc(nm(r)),
      sub: (r) => esc(r.code),
      meta: (r) => [
        r.is_customer ? pill(t('party.customer')) : '', r.is_supplier ? pill(t('party.supplier')) : '',
        r.is_fabric_owner ? pill(t('party.fabric_owner'), 'pill-warn') : '',
        r.city ? `<span>${esc(r.city)}</span>` : '', r.phone ? `<span dir="ltr">${esc(r.phone)}</span>` : ''].join(''),
    },
    fields: [
      codeField(), ...nameFields(120),
      { key: 'is_customer', label: 'party.customer', type: 'checkbox', default: true },
      { key: 'is_supplier', label: 'party.supplier', type: 'checkbox' },
      { key: 'is_fabric_owner', label: 'party.fabric_owner', type: 'checkbox', hint: 'party.fabric_owner_hint' },
      { key: 'contact_person', label: 'f.contact_person', type: 'text', max: 100 },
      { key: 'phone', label: 'f.phone', type: 'text', inputType: 'tel', max: 30, dir: 'ltr', pattern: '[0-9+\\-\\s\\(\\)]{7,30}' },
      { key: 'whatsapp', label: 'f.whatsapp', type: 'text', inputType: 'tel', max: 30, dir: 'ltr', pattern: '[0-9+\\-\\s\\(\\)]{7,30}' },
      { key: 'email', label: 'f.email', type: 'text', inputType: 'email', max: 150, dir: 'ltr' },
      { key: 'city', label: 'f.city', type: 'text', max: 60 },
      { key: 'address', label: 'f.address', type: 'text', max: 255, span: true },
      { key: 'ntn', label: 'f.ntn', type: 'text', max: 30, dir: 'ltr' },
      { key: 'strn', label: 'f.strn', type: 'text', max: 30, dir: 'ltr' },
      { key: 'remarks', label: 'f.remarks', type: 'textarea', max: 255 },
      active,
    ],
  },

  warehouses: {
    api: 'warehouses', title: 'setup.warehouses', icon: 'warehouse',
    perm: { view: 'warehouses.view', manage: 'warehouses.manage' },
    list: {
      title: (r) => esc(nm(r)),
      sub: (r) => esc(r.code),
      meta: (r) => pill(t(`wh_type.${r.warehouse_type}`)) + (r.address ? `<span>${esc(r.address)}</span>` : ''),
    },
    fields: [
      codeField(), ...nameFields(80),
      { key: 'warehouse_type', label: 'f.warehouse_type', type: 'select', required: true, default: 'general', options: [
        { value: 'grey', label: 'wh_type.grey' }, { value: 'floor', label: 'wh_type.floor' },
        { value: 'finished', label: 'wh_type.finished' }, { value: 'general', label: 'wh_type.general' }] },
      { key: 'address', label: 'f.address', type: 'text', max: 255, span: true },
      active,
    ],
  },

  units: {
    api: 'units', title: 'setup.units', icon: 'ruler',
    perm: { view: 'units.view', manage: 'units.manage' },
    list: {
      title: (r) => esc(nm(r)),
      sub: (r) => esc(r.code),
      meta: (r) => pill(t(`dimension.${r.dimension}`)) + `<span dir="ltr">1 ${esc(r.code)} = ${esc(Number(r.to_base))} ${esc(t(`base_unit.${r.dimension}`))}</span>`,
    },
    fields: [
      { key: 'code', label: 'f.code', type: 'text', max: 10, required: true, dir: 'ltr' },
      ...nameFields(40),
      { key: 'dimension', label: 'f.dimension', type: 'select', required: true, default: 'length', options: [
        { value: 'length', label: 'dimension.length' }, { value: 'mass', label: 'dimension.mass' },
        { value: 'volume', label: 'dimension.volume' }, { value: 'count', label: 'dimension.count' }] },
      { key: 'to_base', label: 'f.to_base', type: 'number', required: true, min: 0, step: 'any', default: '1', hint: 'f.to_base_hint' },
      { key: 'decimals', label: 'f.decimals', type: 'number', required: true, min: 0, maxValue: 4, step: '1', default: '2' },
      active,
    ],
  },

  items: {
    api: 'items', title: 'setup.items', icon: 'box',
    perm: { view: 'items.view', manage: 'items.manage' },
    lookups: ['units', 'ink_colours'],
    lookupSet: 'items',
    filters: [{ key: 'item_type', label: 'f.item_type', options: ITEM_TYPES }],
    list: {
      lead: (r) => (r.item_type === 'ink' ? swatch(r.colour_hex) : null),
      title: (r) => esc(nm(r)),
      sub: (r) => esc(r.code),
      meta: (r) => [pill(t(`item_type.${r.item_type}`)), r.quality ? `<span>${esc(r.quality)}</span>` : '',
        r.gsm ? `<span dir="ltr">${esc(Number(r.gsm))} GSM</span>` : '', r.width_inch ? `<span dir="ltr">${esc(Number(r.width_inch))}"</span>` : '',
        `<span dir="ltr">${esc(r.unit_code)} · Rs ${esc(fmtNumber(r.rate, 2))}</span>`].join(''),
    },
    fields: [
      { key: 'item_type', label: 'f.item_type', type: 'select', required: true, default: 'grey_fabric', options: ITEM_TYPES },
      codeField(30), ...nameFields(150),
      { key: 'unit_id', label: 'f.unit', type: 'lookup', set: 'units', required: true,
        filter: (o, v) => (v.item_type === 'ink' ? o.dimension === 'volume' : ['grey_fabric', 'finished_fabric'].includes(v.item_type) ? ['length', 'mass'].includes(o.dimension) : true) },
      { key: 'quality', label: 'f.quality', type: 'text', max: 80, when: typeIs('grey_fabric', 'finished_fabric') },
      { key: 'gsm', label: 'f.gsm', type: 'number', min: 0, step: '0.01', when: typeIs('grey_fabric', 'finished_fabric', 'paper') },
      { key: 'width_inch', label: 'f.width_inch', type: 'number', min: 0, step: '0.01', when: typeIs('grey_fabric', 'finished_fabric', 'paper') },
      { key: 'ink_colour_id', label: 'f.colour', type: 'lookup', set: 'ink_colours', required: true, when: typeIs('ink') },
      { key: 'brand', label: 'f.brand', type: 'text', max: 60, when: typeIs('ink', 'paper', 'chemical', 'other') },
      { key: 'process_type', label: 'f.process_type', type: 'select', when: typeIs('ink', 'paper', 'chemical'),
        options: [...PROCESS, { value: 'any', label: 'process.any' }] },
      { key: 'rate', label: 'f.rate', type: 'number', min: 0, step: '0.0001', hint: 'f.rate_hint', when: (v) => v.item_type !== 'ink' },
      { key: 'rate_per_liter', label: 'f.rate_per_liter', type: 'number', min: 0, step: '0.01', when: typeIs('ink') },
      { key: 'reorder_level', label: 'f.reorder_level', type: 'number', min: 0, step: '0.001' },
      { key: 'track_lots', label: 'f.track_lots', type: 'checkbox', when: typeIs('grey_fabric', 'finished_fabric') },
      { key: 'remarks', label: 'f.remarks', type: 'textarea', max: 255 },
      active,
    ],
  },

  inks: {
    api: 'items', title: 'setup.inks', icon: 'drop',
    perm: { view: ['inks.view', 'items.view'], manage: ['inks.manage', 'items.manage'] },
    lookups: ['units', 'ink_colours'],
    lookupSet: 'items',
    fixed: { item_type: 'ink' },
    listQuery: { item_type: 'ink' },
    links: [{ href: '#/m/ink_colours', label: 'setup.ink_colours', perm: 'inks.view' }],
    list: {
      lead: (r) => swatch(r.colour_hex),
      title: (r) => esc(nm(r)),
      sub: (r) => `${esc(r.code)} · ${esc(nm(r, 'colour_name') || '')}`,
      meta: (r) => [r.process_type ? pill(t(`process.${r.process_type}`)) : '', r.brand ? `<span>${esc(r.brand)}</span>` : '',
        `<span dir="ltr">Rs ${esc(fmtNumber(r.rate_per_liter ?? 0, 2))} / L</span>`,
        `<span>${esc(t('f.reorder_level'))}: <span dir="ltr">${esc(fmtNumber(r.reorder_level, 3))} ${esc(r.unit_code)}</span></span>`].join(''),
    },
    fields: [
      codeField(30), ...nameFields(150),
      { key: 'ink_colour_id', label: 'f.colour', type: 'lookup', set: 'ink_colours', required: true },
      { key: 'process_type', label: 'f.ink_type', type: 'select', required: true, default: 'sublimation', options: [...PROCESS, { value: 'any', label: 'process.any' }] },
      { key: 'brand', label: 'f.brand', type: 'text', max: 60 },
      { key: 'unit_id', label: 'f.unit', type: 'lookup', set: 'units', required: true, filter: (o) => o.dimension === 'volume', hint: 'f.ink_unit_hint' },
      { key: 'rate_per_liter', label: 'f.rate_per_liter', type: 'number', min: 0, step: '0.01', required: true },
      { key: 'reorder_level', label: 'f.reorder_level', type: 'number', min: 0, step: '0.001', hint: 'f.reorder_hint' },
      { key: 'remarks', label: 'f.remarks', type: 'textarea', max: 255 },
      active,
    ],
  },

  ink_colours: {
    api: 'ink-colours', title: 'setup.ink_colours', icon: 'drop',
    perm: { view: 'inks.view', manage: 'inks.manage' },
    lookupSet: 'ink_colours',
    list: {
      lead: (r) => swatch(r.hex),
      title: (r) => esc(nm(r)),
      sub: (r) => esc(r.code),
      meta: (r) => pill(t(r.is_process ? 'colour.process' : 'colour.special')) + `<span dir="ltr">${esc(r.hex)}</span>`,
    },
    fields: [
      { key: 'code', label: 'f.code', type: 'text', max: 10, required: true, dir: 'ltr', upper: true, pattern: '[A-Za-z0-9]{1,10}' },
      ...nameFields(40),
      { key: 'hex', label: 'f.hex', type: 'color', required: true, default: '#000000' },
      { key: 'is_process', label: 'colour.process', type: 'checkbox', hint: 'colour.process_hint' },
      { key: 'sort_order', label: 'f.sort_order', type: 'number', min: 0, step: '1', default: '0' },
      active,
    ],
  },

  machines: {
    api: 'machines', title: 'setup.machines', icon: 'printer',
    perm: { view: 'machines.view', manage: 'machines.manage' },
    lookups: ['warehouses'],
    lookupSet: 'machines',
    filters: [{ key: 'machine_type', label: 'f.machine_type', options: PROCESS }],
    list: {
      title: (r) => esc(nm(r)),
      sub: (r) => `${esc(r.code)}${r.make_model ? ` · ${esc(r.make_model)}` : ''}`,
      meta: (r) => [pill(t(`process.${r.machine_type}`)), `<span dir="ltr">${esc(fmtNumber(r.speed_m_per_hr, 0))} m/hr</span>`,
        Number(r.hourly_cost) ? `<span dir="ltr">Rs ${esc(fmtNumber(r.hourly_cost, 0))}/hr</span>` : '',
        r.warehouse_name ? `<span>${esc(nm(r, 'warehouse_name'))}</span>` : ''].join(''),
    },
    fields: [
      codeField(), ...nameFields(80),
      { key: 'machine_type', label: 'f.machine_type', type: 'select', required: true, default: 'sublimation', options: PROCESS },
      { key: 'make_model', label: 'f.make_model', type: 'text', max: 80 },
      { key: 'speed_m_per_hr', label: 'f.speed', type: 'number', required: true, min: 0, step: '0.01' },
      { key: 'print_width_inch', label: 'f.print_width', type: 'number', min: 0, step: '0.01' },
      { key: 'hourly_cost', label: 'f.hourly_cost', type: 'number', min: 0, step: '0.01', hint: 'f.hourly_cost_hint' },
      { key: 'warehouse_id', label: 'f.machine_warehouse', type: 'lookup', set: 'warehouses', hint: 'f.machine_warehouse_hint' },
      { key: 'remarks', label: 'f.remarks', type: 'textarea', max: 255 },
      active,
    ],
  },
};

export { PROCESS, swatch, nm };
