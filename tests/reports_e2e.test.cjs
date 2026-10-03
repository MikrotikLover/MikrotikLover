/**
 * Batch 6 browser test: dashboard, report filter forms (keyboard), report page,
 * Excel / CSV downloads and the PDF (print) layout, Urdu RTL.
 *   ADMIN_USER=admin ADMIN_PASS=Admin12345 NODE_PATH=$(npm root -g) node tests/reports_e2e.test.cjs
 * Env: BASE, SHOTS, CHROMIUM_PATH. The .xlsx is re-read with python3 + openpyxl when available.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const SHOTS = process.env.SHOTS || '';
const RUN = String(Date.now()).slice(-5);
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const enter = async (n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(60); } };
  const type = (s) => page.keyboard.type(s);
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    const hidden = el.closest('[data-combobox]')?.querySelector('input[type=hidden]');
    return hidden ? hidden.name : el.name || el.id;
  });
  const apiCall = (method, route, body) => page.evaluate(async ({ method, route, body }) => {
    const me = await (await fetch('api/index.php?r=auth/me', { credentials: 'same-origin' })).json();
    const res = await fetch(`api/index.php?r=${route}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.data.csrf },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }, { method, route, body });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fpms-rpt-'));
  const download = async (selector) => {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 8000 }), page.click(selector)]);
    const file = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(file);
    return file;
  };
  const capturePrint = async (selector) => {
    await page.evaluate(() => { window.__printed = undefined; window.print = () => { window.__printed = document.getElementById('print-root')?.innerText || ''; }; });
    await page.click(selector);
    await page.waitForFunction(() => window.__printed !== undefined, null, { timeout: 8000 });
    return page.evaluate(() => window.__printed);
  };

  console.log('== login + fixtures');
  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('form [name=username]');
  await page.evaluate(() => localStorage.setItem('fpms.lang', 'en'));
  await type(process.env.ADMIN_USER || 'admin'); await enter();
  await type(process.env.ADMIN_PASS || 'Admin12345'); await enter();
  await page.waitForSelector('.tile-list');
  const lk = (await apiCall('GET', 'lookups&sets=units,warehouses')).data;
  const unit = (c) => lk.units.find((u) => u.code === c).value;
  const wh = (c) => lk.warehouses.find((w) => w.code === c).value;
  const id = async (route, body) => (await apiCall('POST', route, body)).data.id;
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()));
  const owner = await id('parties', { name: `Nishat Job ${RUN}`, is_customer: true, is_fabric_owner: true, is_active: true });
  const gf = await id('items', { name: `Grey Lawn ${RUN}`, item_type: 'grey_fabric', unit_id: unit('m'), track_lots: true, is_active: true });
  const ff = await id('items', { name: `Printed Lawn ${RUN}`, item_type: 'finished_fabric', unit_id: unit('m'), track_lots: true, is_active: true });
  const machine = await id('machines', { name: `Reggiani ${RUN}`, machine_type: 'reactive', speed_m_per_hr: '60', is_active: true });
  const design = await id('designs', { name: `Mughal Jaal ${RUN}`, party_id: owner, process_type: 'reactive', is_active: true });
  const a = await apiCall('POST', 'igp', { voucher_date: today, party_id: owner, warehouse_id: wh('FLOOR'), ownership: 'job_work', vehicle_no: `LHR-${RUN}`,
    lines: [{ item_id: gf, lot_no: `NJ-${RUN}`, rolls: '4', qty: '400' }] });
  const b = await apiCall('POST', 'productions-manual', { voucher_date: today, manual_reason: 'job', party_id: owner, design_id: design, machine_id: machine,
    fabric_item_id: gf, fabric_warehouse_id: wh('FLOOR'), fabric_lot_no: `NJ-${RUN}`, finished_item_id: ff, finished_warehouse_id: wh('FIN'),
    produced_qty: '380', produced_rolls: '8', wastage_qty: '12', material_warehouse_id: wh('FLOOR'), lines: [] });
  const c = await apiCall('POST', 'chalans', { voucher_date: today, party_id: owner, warehouse_id: wh('FIN'), vehicle_no: `LEA-${RUN}`,
    lines: [{ item_id: ff, lot_no: `NJ-${RUN}`, rolls: '5', qty: '250' }] });
  check('fixtures (inward 400, printed 380, delivered 250)', a.ok && b.ok && c.ok, JSON.stringify([a, b, c]).slice(0, 300));

  console.log('== dashboard');
  await page.reload();
  await page.waitForSelector('[data-dashboard] .kpi');
  check('four KPI tiles', (await page.locator('[data-dashboard] .kpi').count()) === 4);
  const kpis = await page.textContent('[data-dashboard] .kpi-grid');
  check('KPIs: today inward / outward / produced', /Today's inward/.test(kpis) && /Today's outward/.test(kpis) && /Produced today/.test(kpis), kpis);
  const bar = page.locator('.bar-row', { hasText: `Reggiani ${RUN}` });
  check('machine bar with 380 m', (await bar.count()) === 1 && (await bar.textContent()).includes('380 m'));
  check('pending deliveries list the job-work party', (await page.textContent('[data-pending]')).includes(`Nishat Job ${RUN}`));
  check('top customers list the party', (await page.textContent('[data-top]')).includes(`Nishat Job ${RUN}`));
  await shot('b6-01-dashboard');

  console.log('== home accordion: keyboard filters → report page');
  check('no "coming in batch" badges left', (await page.locator('.acc-item .badge').count()) === 0);
  await page.click('[data-report=inward] summary');
  await page.waitForSelector('[data-report-form=inward] [name=date_from]');
  check('accordion opens a filter form with export buttons', (await page.locator('[data-report-form=inward] [data-export]').count()) === 3);
  check('default period = month start → today', (await page.inputValue('[data-report-form=inward] [name=date_to]')) === today
    && (await page.inputValue('[data-report-form=inward] [name=date_from]')) === `${today.slice(0, 8)}01`);
  await page.click('[data-report=transfer] summary');
  await page.waitForTimeout(150);
  check('only one report open at a time', !(await page.locator('[data-report=inward]').evaluate((d) => d.open)));
  await page.click('[data-report=inward] summary');
  await page.waitForTimeout(150);
  check('first filter focused', (await focused()) === 'type');
  await page.selectOption('[data-report-form=inward] [name=type]', 'job_work');
  await enter();                                 // type → from
  check('ENTER → date from', (await focused()) === 'date_from');
  await enter(2);                                // from → to → party
  check('ENTER → party', (await focused()) === 'party_id');
  await type(`Nishat Job ${RUN}`); await enter(); // pick party, move on
  check('searchable select: ENTER picks + moves to item', (await focused()) === 'item_id');
  await enter(2);                                // item → warehouse → (last) view
  await page.waitForSelector('.report-table', { timeout: 8000 });
  check('ENTER on last filter opens the report page', page.url().includes('#/r/inward?') && page.url().includes(`party_id=${owner}`), page.url());
  const tableText = await page.textContent('.report-table');
  check('report row: vehicle, lot, 400', tableText.includes(`LHR-${RUN}`) && tableText.includes(`NJ-${RUN}`) && tableText.includes('400'));
  check('ownership shown in words', tableText.includes('Party (job work)'));
  check('totals row', (await page.textContent('.report-table tfoot')).includes('400'));
  check('filters described in heading', (await page.textContent('.report-head')).includes(`Nishat Job ${RUN}`));
  check('filters restored on the report page', (await page.inputValue('[data-report-form=inward] input[name=party_id]')) === String(owner));
  await shot('b6-02-inward-report');

  console.log('== exports');
  const xlsx = await download('[data-report-form=inward] [data-export=xlsx]');
  check('xlsx file name', /^inward-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.xlsx$/.test(path.basename(xlsx)), path.basename(xlsx));
  check('xlsx is a ZIP', fs.readFileSync(xlsx).subarray(0, 2).toString() === 'PK');
  let py = '';
  try {
    py = execFileSync('python3', ['-c', `
import openpyxl, sys
ws = openpyxl.load_workbook(sys.argv[1]).active
rows = [r for r in ws.iter_rows(values_only=True)]
head = next(i for i, r in enumerate(rows) if r[0] == 'Date')
print(rows[0][0]); print('|'.join(str(x) for x in rows[head]))
print('|'.join(str(x) for x in rows[head + 1])); print(ws.freeze_panes, ws.sheet_view.rightToLeft)
`, xlsx], { encoding: 'utf8' });
  } catch (e) { py = `ERR ${e.message.split('\n')[0]}`; }
  if (!py.startsWith('ERR')) {
    const lines = py.trim().split('\n');
    check('xlsx: title row', lines[0] === 'Inward Gate Pass report', lines[0]);
    check('xlsx: header labels', lines[1].startsWith('Date|Voucher no|Party|Ownership'), lines[1]);
    check('xlsx: real date + number cells', /^\d{4}-\d{2}-\d{2} 00:00:00\|IGP-/.test(lines[2]) && /\|400(\.0)?\|m$/.test(lines[2]), lines[2]);
    check('xlsx: header frozen, LTR in English', /^A\d+ (False|None)$/.test(lines[3]), lines[3]);
  } else console.log(`  (skipped openpyxl checks: ${py})`);
  const csv = fs.readFileSync(await download('[data-report-form=inward] [data-export=csv]'), 'utf8');
  check('csv: UTF-8 BOM', csv.charCodeAt(0) === 0xFEFF);
  check('csv: header + data + total', csv.includes('Date,Voucher no,Party') && csv.includes(`LHR-${RUN}`) && /\r\nTotal,.*400/.test(csv));
  const pdf = await capturePrint('[data-report-form=inward] [data-export=pdf]');
  check('pdf: report layout with title, period and row', pdf.includes('Inward Gate Pass report') && pdf.includes('Period') && pdf.includes(`LHR-${RUN}`));
  check('pdf: landscape report page', (await page.locator('#print-root .pdoc-report').count()) === 1
    && (await page.evaluate(() => getComputedStyle(document.querySelector('#print-root .pdoc-report')).page)) === 'report');
  await page.emulateMedia({ media: 'print' });
  await shot('b6-03-report-pdf');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.body.classList.remove('printing'); document.getElementById('print-root')?.remove(); });

  console.log('== other reports');
  await page.goto(`${BASE}/#/r/jobwork?date_from=${today.slice(0, 8)}01&date_to=${today}&party_id=${owner}`);
  await page.waitForSelector('.report-table');
  const jw = await page.textContent('.report-table tbody');
  check('job work: received 400, delivered 250, loss 12, balance 138', ['400', '250', '12', '138'].every((n) => jw.includes(n)), jw);
  await page.goto(`${BASE}/#/r/stock?view=ledger&date_from=${today.slice(0, 8)}01&date_to=${today}`);
  await page.waitForSelector('[data-report-form=stock]');
  await page.waitForSelector('[data-wrap=item_id] .field-error', { timeout: 6000 });
  check('stock ledger without item: message beside Item', (await page.textContent('[data-wrap=item_id] .field-error')).includes('Item'));
  await page.click('[data-report-form=stock] [data-wrap=item_id] input:not([type=hidden])');
  await type(`Printed Lawn ${RUN}`); await enter();
  await page.keyboard.press('Control+s');
  await page.waitForSelector('.report-table');
  const ledger = await page.textContent('.report-table');
  check('Ctrl+S runs the report: ledger in 380 / out 250 / balance 130', ledger.includes('Manual production') && ledger.includes('Delivery chalan') && ledger.includes('130'), ledger.slice(0, 300));
  await page.goto(`${BASE}/#/r/production?view=machine&date_from=${today}&date_to=${today}&machine_id=${machine}`);
  await page.waitForSelector('.report-table');
  check('production by machine: 380 m', (await page.textContent('.report-table tbody')).includes('380'));
  await page.selectOption('[data-report-form=production] [name=view]', 'vouchers');
  await page.click('[data-report-form=production] [data-view]');
  await page.waitForFunction(() => /Wastage %/.test(document.querySelector('.report-table thead')?.textContent || ''));
  check('switch view → vouchers with wastage %', (await page.textContent('.report-table tbody')).includes('3.06 %'));
  await page.goto(`${BASE}/#/r/delivery?date_from=2099-01-01&date_to=2099-01-31`);
  await page.waitForSelector('[data-result] .empty');
  check('empty period → friendly empty state', (await page.textContent('[data-result]')).includes('No records'));

  console.log('== Urdu');
  await page.goto(`${BASE}/#/r/inward?date_from=${today.slice(0, 8)}01&date_to=${today}&party_id=${owner}`);
  await page.waitForSelector('.report-table');
  await page.click('.topbar [data-lang]');           // the user's language is saved on the server
  await page.waitForFunction(() => document.documentElement.dir === 'rtl' && document.querySelector('.report-table'));
  check('RTL report page', (await page.getAttribute('html', 'dir')) === 'rtl');
  check('Urdu column labels', (await page.textContent('.report-table thead')).includes('واؤچر نمبر'));
  const xu = await download('[data-report-form=inward] [data-export=xlsx]');
  if (!py.startsWith('ERR')) {
    const rtl = execFileSync('python3', ['-c', 'import openpyxl,sys; ws=openpyxl.load_workbook(sys.argv[1]).active; print(ws.sheet_view.rightToLeft)', xu], { encoding: 'utf8' }).trim();
    check('Urdu xlsx is a right-to-left sheet', rtl === 'True', rtl);
  }
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('[data-dashboard] .kpi');
  await shot('b6-04-home-urdu');
  await page.click('.topbar [data-lang]');
  await page.waitForFunction(() => document.documentElement.dir === 'ltr');

  console.log('== mobile');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.waitForSelector('[data-dashboard] .kpi');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('home has no horizontal scroll on a phone', !overflow);
  await page.click('[data-report=production] summary');
  await page.waitForSelector('[data-report-form=production] [data-view]');
  await shot('b6-05-home-mobile');
  await page.goto(`${BASE}/#/r/inward?date_from=${today.slice(0, 8)}01&date_to=${today}&party_id=${owner}`);
  await page.waitForSelector('.report-table');
  check('report page: table scrolls inside its box, page does not', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await shot('b6-06-report-mobile');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
