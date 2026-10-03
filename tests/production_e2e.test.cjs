/**
 * Batch 4 browser test: Production Estimation, BOM Production, Manual Production.
 *   ADMIN_USER=admin ADMIN_PASS=Admin12345 NODE_PATH=$(npm root -g) node tests/production_e2e.test.cjs
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

  console.log('== login + fixtures');
  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('form [name=username]');
  await page.evaluate(() => localStorage.setItem('fpms.lang', 'en'));
  await type(process.env.ADMIN_USER || 'admin'); await enter();
  await type(process.env.ADMIN_PASS || 'Admin12345'); await enter();
  await page.waitForSelector('.tile-list');
  const lk = (await apiCall('GET', 'lookups&sets=units,warehouses,ink_colours')).data;
  const unit = (c) => lk.units.find((u) => u.code === c).value;
  const wh = (c) => lk.warehouses.find((w) => w.code === c).value;
  const colour = (c) => lk.ink_colours.find((x) => x.code === c).value;
  const id = async (route, body) => (await apiCall('POST', route, body)).data.id;
  const party = await id('parties', { name: `Kohinoor ${RUN}`, is_customer: true, is_fabric_owner: true, is_active: true });
  const sup = await id('parties', { name: `Vendor ${RUN}`, is_supplier: true, is_active: true });
  const gf = await id('items', { name: `Grey Lawn ${RUN}`, item_type: 'grey_fabric', unit_id: unit('m'), gsm: '110', width_inch: '58', track_lots: true, is_active: true });
  const ff = await id('items', { name: `Printed Lawn ${RUN}`, item_type: 'finished_fabric', unit_id: unit('m'), track_lots: true, is_active: true });
  const inkc = await id('items', { name: `Cyan E${RUN}`, item_type: 'ink', unit_id: unit('l'), ink_colour_id: colour('C'), process_type: 'sublimation', rate_per_liter: '4000', is_active: true });
  const inky = await id('items', { name: `Yellow E${RUN}`, item_type: 'ink', unit_id: unit('l'), ink_colour_id: colour('Y'), process_type: 'sublimation', rate_per_liter: '3500', is_active: true });
  const paper = await id('items', { name: `Transfer Paper E${RUN}`, item_type: 'paper', unit_id: unit('m'), rate: '22', is_active: true });
  const machine = await id('machines', { name: `Atexco ${RUN}`, machine_type: 'sublimation', speed_m_per_hr: '60', hourly_cost: '1200', warehouse_id: wh('FLOOR'), is_active: true });
  const design = await id('designs', { name: `Mughal Jaal ${RUN}`, party_id: party, process_type: 'sublimation', basis_gsm: '110', basis_width_inch: '58',
    finished_item_id: ff, default_machine_id: machine, is_active: true,
    inks: [{ ink_colour_id: colour('C'), coverage_pct: '30', item_id: inkc }, { ink_colour_id: colour('Y'), coverage_pct: '25', item_id: inky }],
    bom: [{ item_id: paper, qty_per_meter: '1.02', wastage_pct: '0' }] });
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()));
  const in1 = await apiCall('POST', 'igp', { voucher_date: today, party_id: party, warehouse_id: wh('FLOOR'), ownership: 'job_work', lines: [{ item_id: gf, lot_no: `KH-${RUN}`, qty: '300' }] });
  const in2 = await apiCall('POST', 'igp', { voucher_date: today, party_id: sup, warehouse_id: wh('FLOOR'), ownership: 'own', lines: [{ item_id: paper, qty: '1000' }] });
  check('fixtures', design && in1.ok && in2.ok);
  check('production tiles enabled', (await page.locator('a.tile[href="#/v/bom_production/new"]').count()) === 1);

  console.log('== estimation (keyboard)');
  await page.goto(`${BASE}/#/v/estimation/new`);
  await page.waitForSelector('form [name=order_ref]');
  await page.waitForTimeout(200);
  await enter(); // date
  await type(`Mughal Jaal ${RUN}`); await enter();
  check('design → customer & machine filled', (await page.inputValue('input[name=party_id]')) === String(party) && (await page.inputValue('input[name=machine_id]')) === String(machine));
  await enter();                        // customer
  await type('PO-5521'); await enter();
  await type('2000'); await enter();    // meters
  check('wastage defaults from settings', (await page.inputValue('[name=wastage_pct]')) !== '');
  await enter(); await enter();         // wastage, machine
  await type(`Grey Lawn ${RUN}`); await enter();
  await page.waitForFunction(() => /Cost per meter/.test(document.querySelector('[data-summary]')?.textContent || ''), null, { timeout: 6000 });
  const sum = await page.textContent('[data-summary]');
  check('live estimate shows inks, paper, machine and cost/m', sum.includes('C ·') && sum.includes('Y ·') && sum.includes(`Transfer Paper E${RUN}`) && /Machine/.test(sum), sum.slice(0, 300));
  await shot('b4-01-estimation');
  await enter(); await enter();         // gsm, width (blank → from fabric)
  check('→ remarks', (await focused()) === 'remarks');
  await enter();                        // save
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  const pev = (await page.textContent('[data-last] a')).trim();
  check('estimation saved', /^PEV-\d{4}-\d{5}$/.test(pev), pev);

  console.log('== BOM production');
  await page.goto(`${BASE}/#/v/bom_production/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter(); // date
  await type(pev); await enter();       // estimation → fills design, party, machine, fabric, meters
  await page.waitForFunction(() => document.querySelectorAll('[data-grid-name=lines] tbody tr').length >= 3, null, { timeout: 6000 });
  check('estimation filled header', (await page.inputValue('input[name=design_id]')) === String(design) && (await page.inputValue('[name=produced_qty]')) === '2000');
  check('BOM lines auto-loaded (2 inks + paper)', (await page.locator('[data-grid-name=lines] tbody tr').count()) === 3);
  // Change meters to what was actually produced this shift.
  await page.fill('[name=fabric_lot_no]', `KH-${RUN}`);
  await page.fill('[name=produced_qty]', '240');
  await page.locator('[name=produced_qty]').dispatchEvent('change');
  await page.fill('[name=wastage_qty]', '6');
  await page.locator('[name=wastage_qty]').dispatchEvent('change');
  await page.fill('[name=rejected_qty]', '4');
  await page.locator('[name=rejected_qty]').dispatchEvent('change');
  await page.waitForTimeout(500);
  const estPaper = await page.inputValue('[data-grid-name=lines] tbody tr:nth-child(3) [data-col=est_qty]');
  check('BOM re-scaled to 250 printed m (paper 255)', estPaper === '255', estPaper);
  await page.fill('[data-grid-name=lines] tbody tr:nth-child(3) [data-col=actual_qty]', '262');
  await page.locator('[data-grid-name=lines] tbody tr:nth-child(3) [data-col=actual_qty]').dispatchEvent('input');
  await page.waitForTimeout(150);
  const variance = await page.textContent('[data-grid-name=lines] tbody tr:nth-child(3) [data-col=variance]');
  check('variance shown (+2.7%)', variance.includes('+2.7%'), variance);
  const s2 = await page.textContent('[data-summary]');
  check('summary: printed 250, fabric available 300', s2.includes('250 m') && s2.includes('300 m'), s2.slice(0, 200));
  check('ink rows marked as taken at ink loading', (await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=available]')).includes('at loading'));
  await shot('b4-02-bom-form');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  const bomNo = (await page.textContent('[data-last] a')).trim();
  check('BOM production saved', /^BOM-\d{4}-\d{5}$/.test(bomNo), bomNo);
  await page.click('[data-last] a:not(.btn)');
  await page.waitForSelector('.voucher-doc');
  const doc = await page.textContent('.voucher-doc');
  check('view: fabric used 250, produced 240, wastage 4%', doc.includes('250 m') && doc.includes('240 m') && doc.includes('4.00%'), doc.slice(0, 400));
  check('view: estimation linked', doc.includes(pev));
  await shot('b4-03-bom-view');

  console.log('== shortage + manual production');
  await page.goto(`${BASE}/#/v/manual_production/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter();                        // date
  check('reason first (sampling default)', (await focused()) === 'manual_reason' && (await page.inputValue('[name=manual_reason]')) === 'sampling');
  await enter();                        // reason
  await enter();                        // design (optional)
  await enter();                        // customer
  await type(`Atexco ${RUN}`); await enter();
  await type('Sajid'); await enter();
  await type(`Grey Lawn ${RUN}`); await enter();
  await enter();                        // fabric warehouse (floor)
  await type(`KH-${RUN}`); await enter();
  await type('100'); await enter();     // produced (more than the 50 m left in the lot)
  await enter(3);                       // wastage, rejected, rolls
  check('→ finished item', (await focused()) === 'finished_item_id');
  await type(`Printed Lawn ${RUN}`); await enter();
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[name=fabric_lot_no][aria-invalid=true]', { timeout: 6000 });
  const msg = await page.textContent('[data-wrap=fabric_lot_no] .field-error');
  check('fabric shortage shown beside fabric lot', msg.includes('Only 50 m'), msg);
  await page.fill('[name=produced_qty]', '3');
  await page.click('[data-grid-name=lines] tbody tr:first-child [data-col=item_id]');
  await type(`Transfer Paper E${RUN}`); await enter();
  await page.waitForTimeout(80);
  const f = await focused();
  check('lot skipped, est read-only skipped → actual', f === 'actual_qty', f);
  await type('4');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  check('manual production saved', /^MPV-\d{4}-\d{5}$/.test((await page.textContent('[data-last] a')).trim()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/v/bom_production/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await shot('b4-04-bom-mobile');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
