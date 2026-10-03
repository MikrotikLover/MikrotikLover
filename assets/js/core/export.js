/**
 * export.js — report downloads without any library or server-side process
 * (Hostinger has no proc_open / CLI, and we use no Composer packages).
 *
 *   exportCsv(sheet, 'inward-2026-10-01')   UTF-8 with BOM so Excel shows Urdu
 *   exportXlsx(sheet, 'inward-2026-10-01')  real .xlsx (Office Open XML in a ZIP)
 *
 *   sheet = {
 *     title: 'Inward Gate Pass report', lines: ['Company', 'Period: …'],  // heading rows
 *     columns: [{ label, type: 'text'|'date'|'int'|'qty'|'money'|'pct'|'num', key }],
 *     rows: [{ key: value }], totals: { key: value } | null, rtl: false,
 *   }
 *
 * Numbers stay numbers (sum/filter in Excel), dates become real Excel dates.
 * PDF is produced by the browser's print dialog ("Save as PDF") — see print.js.
 */

/* ------------------------------------------------------------------ helpers */

const enc = new TextEncoder();

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const isNum = (t) => ['int', 'qty', 'money', 'pct', 'num'].includes(t);
const numOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Cell value as plain text for CSV (numbers unformatted, dates ISO). */
function csvCell(col, v) {
  if (v === null || v === undefined) return '';
  if (isNum(col.type)) {
    const n = numOrNull(v);
    return n === null ? '' : String(n);
  }
  return String(col.text ? col.text(v) : v);
}

/* ---------------------------------------------------------------------- CSV */

export function csvString(sheet) {
  const q = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const out = [];
  out.push([q(sheet.title)]);
  (sheet.lines || []).forEach((l) => out.push([q(l)]));
  out.push([]);
  out.push(sheet.columns.map((c) => q(c.label)));
  sheet.rows.forEach((r) => out.push(sheet.columns.map((c) => q(csvCell(c, r[c.key])))));
  if (sheet.totals) {
    out.push(sheet.columns.map((c, i) => (i === 0 && !(c.key in sheet.totals) ? q(sheet.totalLabel || 'Total') : q(csvCell(c, sheet.totals[c.key])))));
  }
  return out.map((r) => r.join(',')).join('\r\n');
}

export function exportCsv(sheet, name) {
  download(new Blob(['﻿', csvString(sheet)], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}

/* --------------------------------------------------------------------- ZIP */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal ZIP writer, "stored" (no compression) — every spreadsheet app accepts it. */
export function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const { name, data } of files) {
    const nameBytes = enc.encode(name);
    const bytes = typeof data === 'string' ? enc.encode(data) : data;
    const crc = crc32(bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);          // version needed
    local.setUint16(6, 0x0800, true);      // UTF-8 names
    local.setUint16(8, 0, true);           // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, bytes);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, bytes.length, true);
    cen.setUint32(24, bytes.length, true);
    cen.setUint16(28, nameBytes.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), nameBytes);
    offset += 30 + nameBytes.length + bytes.length;
  }

  const cenSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

/* -------------------------------------------------------------------- XLSX */

const xml = (s) => String(s)
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Style ids: cellXfs index = FORMATS index * 2 + (bold ? 1 : 0).
const FORMATS = ['text', 'int', 'qty', 'money', 'pct', 'date', 'num'];
const NUMFMT = { text: 0, int: 3, qty: 164, money: 4, pct: 165, date: 166, num: 167 };
const style = (type, bold = false) => Math.max(0, FORMATS.indexOf(type)) * 2 + (bold ? 1 : 0);

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0.###"/><numFmt numFmtId="165" formatCode="0.00&quot; %&quot;"/><numFmt numFmtId="166" formatCode="dd\\-mm\\-yyyy"/><numFmt numFmtId="167" formatCode="#,##0.###"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE5E7EB"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${FORMATS.length * 2 + 2}">${FORMATS.map((f) => {
    const id = NUMFMT[f];
    const fmt = id ? ` numFmtId="${id}" applyNumberFormat="1"` : ' numFmtId="0"';
    return `<xf${fmt} fontId="0" fillId="0" borderId="0" xfId="0"/><xf${fmt} fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
  }).join('')}<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
const TITLE_STYLE = FORMATS.length * 2;
const HEAD_STYLE = FORMATS.length * 2 + 1;

/** "2026-10-02" → Excel serial day number (1900 date system). */
function excelDate(v) {
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return (Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000;
}

function cell(ref, col, v, bold = false) {
  if (v === null || v === undefined || v === '') return '';
  if (isNum(col.type)) {
    const n = numOrNull(v);
    if (n !== null) return `<c r="${ref}" s="${style(col.type, bold)}"><v>${n}</v></c>`;
  }
  if (col.type === 'date') {
    const d = excelDate(v);
    if (d !== null) return `<c r="${ref}" s="${style('date', bold)}"><v>${d}</v></c>`;
  }
  return strCell(ref, col.text ? col.text(v) : v, style('text', bold));
}

const strCell = (ref, text, s) => `<c r="${ref}" t="inlineStr" s="${s}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;

export function xlsxSheetXml(sheet) {
  const rows = [];
  let r = 0;
  const row = (cells) => { r++; rows.push(`<row r="${r}">${cells(r)}</row>`); };
  row((n) => strCell(`A${n}`, sheet.title, TITLE_STYLE));
  (sheet.lines || []).forEach((l) => row((n) => strCell(`A${n}`, l, style('text'))));
  r++; // blank row
  const headRow = r + 1;
  row((n) => sheet.columns.map((c, i) => strCell(`${colName(i)}${n}`, c.label, HEAD_STYLE)).join(''));
  sheet.rows.forEach((rec) => row((n) => sheet.columns.map((c, i) => cell(`${colName(i)}${n}`, c, rec[c.key])).join('')));
  if (sheet.totals) {
    row((n) => sheet.columns.map((c, i) => {
      if (i === 0 && !(c.key in sheet.totals)) return strCell(`A${n}`, sheet.totalLabel || 'Total', style('text', true));
      return cell(`${colName(i)}${n}`, c, sheet.totals[c.key], true);
    }).join(''));
  }

  // Column widths from the longest text (capped), numbers get a sensible minimum.
  const widths = sheet.columns.map((c) => {
    let w = String(c.label).length;
    for (const rec of sheet.rows.slice(0, 500)) {
      const v = rec[c.key];
      w = Math.max(w, v === null || v === undefined ? 0 : String(c.text ? c.text(v) : v).length);
    }
    return Math.min(48, Math.max(isNum(c.type) ? 12 : c.type === 'date' ? 12 : 8, w + 2));
  });
  const last = `${colName(Math.max(0, sheet.columns.length - 1))}${Math.max(r, headRow)}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="A1:${last}"/>
<sheetViews><sheetView workbookViewId="0"${sheet.rtl ? ' rightToLeft="1"' : ''}><pane ySplit="${headRow}" topLeftCell="A${headRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
<autoFilter ref="A${headRow}:${colName(Math.max(0, sheet.columns.length - 1))}${headRow + sheet.rows.length}"/>
<pageSetup orientation="landscape" paperSize="9" fitToWidth="1" fitToHeight="0"/>
</worksheet>`;
}

export function xlsxBlob(sheet) {
  const sheetName = xml(String(sheet.sheetName || 'Report').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xml(sheet.title)}</dc:title><dc:creator>FPMS</dc:creator>
<dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created>
</cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
${sheet.rows.length ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$${(sheet.lines || []).length + 3}:$${colName(sheet.columns.length - 1)}$${(sheet.lines || []).length + 3 + sheet.rows.length}</definedName></definedNames>` : ''}
</workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
    { name: 'xl/worksheets/sheet1.xml', data: xlsxSheetXml(sheet) },
  ];
  return new Blob([zip(files)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function exportXlsx(sheet, name) {
  download(xlsxBlob(sheet), `${name}.xlsx`);
}
