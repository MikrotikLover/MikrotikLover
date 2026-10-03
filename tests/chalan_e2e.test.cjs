/**
 * Batch 5 browser test: Delivery Chalan entry + chalan / gate-pass print layouts.
 *   ADMIN_USER=admin ADMIN_PASS=Admin12345 NODE_PATH=$(npm root -g) node tests/chalan_e2e.test.cjs
 * Env: BASE, SHOTS, CHROMIUM_PATH.
 */
const { chromium } = require('playwright');

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
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
  const capturePrint = async (selector) => {
    await page.evaluate(() => { window.__printed = undefined; window.print = () => { window.__printed = document.getElementById('print-root')?.innerText || ''; }; });
    await page.click(selector);
    await page.waitForFunction(() => window.__printed !== undefined);
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
  const owner = await id('parties', { name: `Sapphire Job ${RUN}`, is_customer: true, is_fabric_owner: true, address: 'Plot 7, Quaid-e-Azam Industrial Estate, Lahore', phone: '042-35112233', is_active: true });
  await id('parties', { name: `Other Buyer ${RUN}`, is_customer: true, is_active: true });
  const gf = await id('items', { name: `Grey Silk ${RUN}`, item_type: 'grey_fabric', unit_id: unit('m'), track_lots: true, is_active: true });
  const ff = await id('items', { name: `Printed Silk ${RUN}`, item_type: 'finished_fabric', unit_id: unit('m'), track_lots: true, is_active: true });
  const machine = await id('machines', { name: `Printer ${RUN}`, machine_type: 'sublimation', speed_m_per_hr: '40', is_active: true });
  const design = await id('designs', { name: `Ajrak Blue ${RUN}`, party_id: owner, process_type: 'sublimation', is_active: true });
  const in1 = await apiCall('POST', 'igp', { voucher_date: today, party_id: owner, warehouse_id: wh('FLOOR'), ownership: 'job_work', lines: [{ item_id: gf, lot_no: `SJ-${RUN}`, qty: '120' }] });
  const pr = await apiCall('POST', 'productions-manual', { voucher_date: today, manual_reason: 'job', party_id: owner, design_id: design, machine_id: machine,
    fabric_item_id: gf, fabric_warehouse_id: wh('FLOOR'), fabric_lot_no: `SJ-${RUN}`, finished_item_id: ff, finished_warehouse_id: wh('FIN'),
    produced_qty: '110', produced_rolls: '5', wastage_qty: '4', material_warehouse_id: wh('FLOOR'), lines: [] });
  check('fixtures (job-work lot printed into finished store)', in1.ok && pr.ok, JSON.stringify(pr).slice(0, 200));
  check('chalan tile enabled', (await page.locator('a.tile[href="#/v/chalan/new"]').count()) === 1);

  console.log('== chalan (keyboard)');
  await page.goto(`${BASE}/#/v/chalan/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter();                                  // date
  await type(`Sapphire Job ${RUN}`); await enter();
  check('delivery address from party', (await page.inputValue('[name=delivery_address]')).includes('Quaid-e-Azam'));
  await page.waitForFunction(() => /Pending delivery/.test(document.querySelector('[data-summary]')?.textContent || ''), null, { timeout: 6000 });
  const sum = await page.textContent('[data-summary]');
  check('job-work position: received 120, printed 110, ready 110', sum.includes('120 m') && sum.includes('110 m'), sum);
  await enter();                                  // dispatch from (finished store)
  await type('PO-4410'); await enter();
  await type('lez-7781'); await enter();
  await type('Imran'); await enter();
  await type('0301-5554433'); await enter();
  await type('Waqas (store)'); await enter();
  await enter();                                  // address (prefilled)
  check('header → grid', (await focused()) === 'item_id');
  await page.click('[data-party-lots]');
  await page.waitForFunction(() => document.querySelector('[data-grid-name=lines] tbody tr [data-col=lot_no]')?.value, null, { timeout: 6000 });
  const row = '[data-grid-name=lines] tbody tr:first-child';
  check('party lot added with full qty and rolls', (await page.inputValue(`${row} [data-col=lot_no]`)) === `SJ-${RUN}`
    && (await page.inputValue(`${row} [data-col=qty]`)) === '110' && (await page.inputValue(`${row} [data-col=rolls]`)) === '5');
  check('design filled for the lot', (await page.inputValue(`${row} input[name=design_id]`)) === String(design));
  await page.fill(`${row} [data-col=qty]`, '80');
  await page.fill(`${row} [data-col=rolls]`, '4');
  await page.locator(`${row} [data-col=qty]`).dispatchEvent('input');
  await shot('b5-01-chalan-form');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  const no = (await page.textContent('[data-last] a')).trim();
  check('chalan saved', /^DCV-\d{4}-\d{5}$/.test(no), no);

  console.log('== prints');
  await page.click('[data-last] a:not(.btn)');
  await page.waitForSelector('.voucher-doc');
  check('two print buttons (chalan + gate pass)', (await page.locator('[data-print]').count()) === 2);
  const chalanText = await capturePrint('[data-print="0"]');
  check('chalan: title, number, party box, address', chalanText.includes('Delivery Chalan') && chalanText.includes(no) && chalanText.includes('Deliver to') && chalanText.includes('Quaid-e-Azam'));
  check('chalan: design, lot, 80 m, 4 rolls', chalanText.includes(`Ajrak Blue ${RUN}`) && chalanText.includes(`SJ-${RUN}`) && chalanText.includes('80 m'));
  const declaration = await page.evaluate(() => document.querySelector('#print-root .pdoc-declaration')?.textContent.trim() || '');
  check('chalan: declaration (from Settings) + receiver CNIC / signature', declaration.length > 5 && chalanText.includes('CNIC') && chalanText.includes('Signature'), declaration);
  check('receiver name pre-filled in receiver block', chalanText.includes('Waqas (store)'));
  check('chalan: party + office copies (setting = 2)', chalanText.includes('Party copy') && chalanText.includes('Office copy') && !chalanText.includes('Gate copy'));
  check('two pages rendered', (await page.locator('#print-root .pdoc').count()) === 2);
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await shot('b5-02-chalan-print');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.body.classList.remove('printing'); document.getElementById('print-root')?.remove(); });
  const gp = await capturePrint('[data-print="1"]');
  check('gate pass: compact, vehicle + driver + rolls, no rates', gp.includes('Outward Gate Pass') && gp.includes('LEZ-7781') && gp.includes('Imran') && !gp.includes('Rs '));
  check('gate pass single page', (await page.locator('#print-root .pdoc').count()) === 1);
  await page.emulateMedia({ media: 'print' });
  await shot('b5-03-gatepass-print');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.body.classList.remove('printing'); document.getElementById('print-root')?.remove(); });
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('== job-work protection');
  await page.goto(`${BASE}/#/v/chalan/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter();
  await type(`Other Buyer ${RUN}`); await enter();
  await page.click(`${row} [data-col=item_id]`);
  await type(`Printed Silk ${RUN}`); await enter();
  await page.fill(`${row} [data-col=lot_no]`, `SJ-${RUN}`);
  await page.fill(`${row} [data-col=qty]`, '10');
  await page.keyboard.press('Control+s');
  await page.waitForSelector(`${row} [data-col=lot_no][aria-invalid=true]`, { timeout: 6000 });
  check('lot of another party refused beside lot', (await page.textContent(`${row} .field-error`)).includes(`Sapphire Job ${RUN}`));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/v/chalan/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await shot('b5-04-chalan-mobile');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
