/**
 * Shared by the home accordion and the #/r/<key> page: fetch a report, format
 * its cells, describe the filters in words, and export (Excel / CSV / PDF).
 */
import { api } from '../../core/api.js';
import { t, has, getLang, fmtDate, fmtNumber, todayPK } from '../../core/i18n.js';
import { session } from '../../core/session.js';
import { findOpt, optLabel } from '../../core/lookups.js';
import { exportCsv, exportXlsx } from '../../core/export.js';
import { printReport } from '../../core/print.js';

const NUMERIC = new Set(['int', 'qty', 'money', 'pct', 'num']);
// Text columns holding codes that have their own translations.
const ENUM_COLS = { ownership: 'ownership', purpose: 'purpose', line_type: 'line_type', item_type: 'item_type',
  production_type: 'ptype', voucher_type: 'vtype' };

export const isNumeric = (type) => NUMERIC.has(type);
export const colLabel = (key) => (has(`rcol.${key}`) ? t(`rcol.${key}`) : key);

export function enumText(key, v) {
  const prefix = ENUM_COLS[key];
  if (!prefix || v === null || v === undefined || v === '') return v;
  return has(`${prefix}.${v}`) ? t(`${prefix}.${v}`) : v;
}

const trim3 = (n) => fmtNumber(n, 3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');

/** Display text of one cell. */
export function cellText(col, v) {
  if (v === null || v === undefined || v === '') return '';
  switch (col.type) {
    case 'date': return fmtDate(v);
    case 'int': return fmtNumber(v, 0);
    case 'qty':
    case 'num': return trim3(v);
    case 'money': return fmtNumber(v, 2);
    case 'pct': return `${fmtNumber(v, 2)} %`;
    default: return String(enumText(col.key, v));
  }
}

export const fetchReport = (def, query) => api.get(`reports/${def.key}`, query);

/** Columns of a report payload with labels and an Excel/CSV text mapper for code columns. */
export function columnsOf(data) {
  return data.columns.map((c) => ({ ...c, label: colLabel(c.key), num: isNumeric(c.type), text: ENUM_COLS[c.key] ? (v) => enumText(c.key, v) : null }));
}

/** Filters in words, for report headings: ['Period: 01-10-2026 – 03-10-2026', 'Party: …']. */
export function describe(def, query, lk, fields) {
  const out = [`${t('rpt.period')}: ${fmtDate(query.date_from)} – ${fmtDate(query.date_to)}`];
  for (const f of fields) {
    const v = query[f.key];
    if (!v || f.key === 'date_from' || f.key === 'date_to') continue;
    let text = v;
    if (f.type === 'lookup') text = optLabel(findOpt(lk[f.set], v) || { label: v });
    else if (f.type === 'select') text = t((f.options.find((o) => String(o.value) === String(v)) || { label: v }).label);
    out.push(`${t(f.label)}: ${text}`);
  }
  return out;
}

export function reportTitle(def, data) {
  const view = def.views && data.view && has(`rview.${def.key}.${data.view}`) ? ` — ${t(`rview.${def.key}.${data.view}`)}` : '';
  return `${t(`rpt.${def.key}`)}${view}`;
}

const fileName = (def, data) => `${def.key}${data.view && def.views ? `-${data.view}` : ''}-${data.filters?.date_from || todayPK()}-${data.filters?.date_to || todayPK()}`;

function totalsFor(columns, data) {
  if (!data.totals) return null;
  return columns.map((c, i) => {
    if (c.key in data.totals) return cellText(c, data.totals[c.key]);
    return i === 0 ? t('grid.total') : '';
  });
}

/** format: 'xlsx' | 'csv' | 'pdf' */
export function exportReport(format, def, data, lines) {
  const columns = columnsOf(data);
  const company = getLang() === 'ur' && session.app.name_ur ? session.app.name_ur : session.app.name;
  const title = reportTitle(def, data);
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'short', timeStyle: 'short' }).format(new Date()).replace(/\//g, '-');
  const meta = `${t('rpt.printed_on')} ${now} · ${session.user?.full_name || ''}${data.truncated ? ` · ${t('rpt.truncated', { n: data.rows.length })}` : ''}`;
  if (format === 'pdf') {
    printReport({
      title, lines, meta,
      columns: columns.map((c) => ({ label: c.label, num: c.num })),
      rows: data.rows.map((r) => columns.map((c) => cellText(c, r[c.key]))),
      totals: totalsFor(columns, data),
    });
    return;
  }
  const sheet = {
    title, sheetName: t(`rpt.${def.key}`), lines: [company || '', ...lines], columns, rows: data.rows,
    totals: data.totals, totalLabel: t('grid.total'), rtl: getLang() === 'ur',
  };
  if (format === 'csv') exportCsv(sheet, fileName(def, data));
  else exportXlsx(sheet, fileName(def, data));
}
