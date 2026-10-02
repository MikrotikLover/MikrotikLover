/**
 * Batch 3 browser test: IGP, Stock Transfer, Stock Consumption, Ink Loading
 * entered by keyboard, then view / print / edit / cancel.
 *   ADMIN_USER=admin ADMIN_PASS=Admin12345 NODE_PATH=$(npm root -g) node tests/vouchers_e2e.test.cjs
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
  const shot = async (name, full = true) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: full }); };
  const enter = async (n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(60); } };
  const type = (s) => page.keyboard.type(s);
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    const hidden = el.closest('[data-combobox]')?.querySelector('input[type=hidden]');
    return hidden ? hidden.name : el.name || el.id;
  });
  // API calls from inside the page (same session cookie + CSRF).
  const apiCall = (method, route, body) => page.evaluate(async ({ method, route, body }) => {
    const boot = await (await fetch('api/index.php?r=auth/me', { credentials: 'same-origin' })).json();
    const res = await fetch(`api/index.php?r=${route}`, {
      method, credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.data.csrf },
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
  const floor = lk.warehouses.find((w) => w.code === 'FLOOR').value;
  const cyan = lk.ink_colours.find((c) => c.code === 'C').value;
  const party = (await apiCall('POST', 'parties', { name: `Gulberg Textiles ${RUN}`, is_customer: true, is_fabric_owner: true, is_active: true })).data;
  const fab = (await apiCall('POST', 'items', { name: `Cambric ${RUN}`, item_type: 'grey_fabric', unit_id: unit('m'), track_lots: true, is_active: true })).data;
  const ink = (await apiCall('POST', 'items', { name: `Cyan HD ${RUN}`, item_type: 'ink', unit_id: unit('l'), ink_colour_id: cyan, process_type: 'sublimation', rate_per_liter: '4000', is_active: true })).data;
  const machine = (await apiCall('POST', 'machines', { name: `Epson F9 ${RUN}`, machine_type: 'sublimation', speed_m_per_hr: '40', warehouse_id: floor, is_active: true })).data;
  const sup = (await apiCall('POST', 'parties', { name: `Supplier ${RUN}`, is_supplier: true, is_active: true })).data;
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date()));
  const inkIn = await apiCall('POST', 'igp', { voucher_date: today, party_id: sup.id, warehouse_id: floor, ownership: 'own', lines: [{ item_id: ink.id, qty: '2' }] });
  check('fixtures', party.id && fab.id && ink.id && machine.id && inkIn.ok, JSON.stringify(inkIn).slice(0, 200));
  check('transaction tiles open new vouchers', (await page.locator('a.tile[href="#/v/igp/new"]').count()) === 1);

  console.log('== inward gate pass (keyboard)');
  await page.goto(`${BASE}/#/v/igp/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(200);
  check('date focused first, defaults to today', (await focused()) === 'voucher_date' && (await page.inputValue('[name=voucher_date]')) === today);
  await enter();
  await type(`Gulberg Textiles ${RUN}`); await enter();
  check('fabric owner → ownership job work', (await page.inputValue('[name=ownership]')) === 'job_work');
  await enter();                       // ownership
  await enter();                       // warehouse (Grey Store default)
  await type('PC-889'); await enter(); // party challan
  await type('les-4521'); await enter();
  await type('Akram'); await enter();
  await type('0300-1112223'); await enter();
  check('header → grid item', (await focused()) === 'item_id');
  await type(`Cambric ${RUN}`); await enter();
  await type('LOT-A'); await enter();
  await type('3'); await enter();
  await type('120'); await enter();    // qty
  await page.waitForTimeout(80);
  check('row 2 added', (await page.locator('[data-grid-name=lines] tbody tr').count()) === 2);
  await type(`Cambric ${RUN}`); await enter();
  await type('LOT-B'); await enter(); await type('1'); await enter(); await type('40.5'); await enter();
  await page.waitForTimeout(80);
  check('footer totals', (await page.textContent('[data-grid-name=lines] tfoot')).includes('160.5'));
  await enter();                       // empty row 3 → remarks
  check('empty row → remarks', (await focused()) === 'remarks');
  await shot('b3-01-igp-form');
  await type('Received in good condition');
  await enter();                       // last field → save
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  const igpNo = (await page.textContent('[data-last] a')).trim();
  check('saved: last-saved link with number', /^IGP-\d{4}-\d{5}$/.test(igpNo), igpNo);
  check('form cleared, focus back on date', (await focused()) === 'voucher_date' && (await page.locator('[data-grid-name=lines] tbody tr').count()) === 1);

  console.log('== view + print');
  await page.click('[data-last] a:not(.btn)');
  await page.waitForSelector('.voucher-doc');
  const doc = await page.textContent('.voucher-doc');
  check('view shows vehicle upper-cased + lines', doc.includes('LES-4521') && doc.includes('LOT-A') && doc.includes('LOT-B'));
  await page.evaluate(() => { window.print = () => { window.__printed = document.getElementById('print-root')?.textContent || ''; }; });
  await page.click('[data-print]');
  await page.waitForFunction(() => window.__printed !== undefined);
  const printed = await page.evaluate(() => window.__printed);
  check('print layout has number, lines and signatures', printed.includes(igpNo) && printed.includes('LOT-A') && printed.includes('Gate keeper'));
  await page.emulateMedia({ media: 'print' });
  await shot('b3-02-igp-print');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => { document.body.classList.remove('printing'); document.getElementById('print-root')?.remove(); });
  await shot('b3-03-igp-view');
  const igpId = page.url().split('/').pop();

  console.log('== stock transfer');
  await page.goto(`${BASE}/#/v/transfer/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter(3);                      // date, from (grey), to (floor)
  check('defaults Grey → Floor, into grid', (await focused()) === 'item_id');
  await type(`Cambric ${RUN}`); await enter();
  await page.waitForTimeout(100);
  const avail = await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=available]');
  check('available shown for item (all lots)', avail.includes('160.5'), avail);
  await type('LOT-A'); await enter();
  await page.waitForTimeout(80);
  check('available narrows to lot', (await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=available]')).includes('120'));
  await type('2'); await enter();
  await type('150');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-grid-name=lines] tbody tr:first-child [data-col=qty][aria-invalid=true]', { timeout: 5000 });
  const err = await page.textContent('[data-grid-name=lines] tbody tr:first-child .field-error');
  check('insufficient stock shown beside qty', err.includes('Only 120 m'), err);
  check('focus on qty', (await focused()) === 'qty');
  await shot('b3-04-transfer-error');
  await page.keyboard.press('Control+a'); await type('100');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  check('transfer saved', /^STV-/.test((await page.textContent('[data-last] a')).trim()));
  const stvLink = await page.getAttribute('[data-last] a:not(.btn)', 'href');

  console.log('== stock consumption');
  await page.goto(`${BASE}/#/v/consumption/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter();                       // date
  await enter();                       // warehouse floor
  await type(`Epson F9 ${RUN}`); await enter();
  await enter();                       // purpose
  await enter(); await enter();        // design, party
  check('into grid', (await focused()) === 'item_id');
  await page.click('[data-grid-name=lines] tbody tr:first-child [data-col=item_id]');
  const opts = await page.locator('[data-grid-name=lines] tbody tr:first-child .ss-option .ss-label').allTextContents();
  check('only non-fabric items with floor stock offered', opts.some((o) => o.includes(`Cyan HD ${RUN}`)) && !opts.some((o) => o.includes(`Cambric ${RUN}`)), opts.join(' | '));
  await type(`Cyan HD ${RUN}`); await enter();
  check('lot skipped for non-lot item', (await focused()) === 'qty');
  await type('0.5'); await enter();
  check('rate defaulted from item', (await page.inputValue('[data-grid-name=lines] tbody tr:first-child [data-col=rate]')) === '4000');
  await page.waitForTimeout(80);
  check('amount 2,000.00', (await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=amount]')).includes('2,000.00'));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  check('consumption saved', /^SCV-/.test((await page.textContent('[data-last] a')).trim()));

  console.log('== ink loading');
  await page.goto(`${BASE}/#/v/ink_load/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await page.waitForTimeout(250);
  await enter();
  await type(`Epson F9 ${RUN}`); await enter();
  check('machine → its warehouse', (await page.inputValue('input[name=warehouse_id]')) === String(floor));
  await enter();
  await type(`Cyan HD ${RUN}`); await enter();
  await type('750'); await enter();
  await page.waitForTimeout(80);
  check('750 ml shown as 0.75 l', (await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=qty]')).includes('0.75 l'));
  check('available 1.5 l after consumption', (await page.textContent('[data-grid-name=lines] tbody tr:first-child [data-col=available]')).includes('1.5 l'));
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-last]:not([hidden])', { timeout: 6000 });
  check('ink load saved', /^INK-/.test((await page.textContent('[data-last] a')).trim()));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/v/ink_load/new`);
  await page.waitForSelector('[data-grid-name=lines]');
  await shot('b3-05-ink-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  console.log('== cancel + edit');
  await page.goto(`${BASE}/${stvLink}`);
  await page.waitForSelector('[data-cancel]');
  await page.click('[data-cancel]');
  await page.waitForSelector('dialog [name=reason]');
  await type('Wrong lot moved');
  await enter();
  await page.waitForSelector('.voucher-doc .pill-off', { timeout: 5000 });
  check('transfer cancelled, edit/cancel buttons gone', (await page.locator('[data-cancel]').count()) === 0);
  await page.goto(`${BASE}/#/v/igp/${igpId}/edit`);
  await page.waitForSelector('[data-grid-name=lines] tbody tr');
  await page.waitForTimeout(200);
  check('edit loads lines', (await page.locator('[data-grid-name=lines] tbody tr').count()) === 2);
  await page.fill('[data-grid-name=lines] tbody tr:first-child [data-col=qty]', '130');
  await page.keyboard.press('Control+s');
  await page.waitForFunction((id) => location.hash === `#/v/igp/${id}`, igpId, { timeout: 6000 });
  check('edit saved → view', (await page.textContent('.voucher-doc tfoot')).includes('170.5'));

  console.log('== register');
  await page.goto(`${BASE}/#/v/transfer`);
  await page.waitForSelector('.rows');
  check('register lists cancelled transfer', (await page.locator('.rows .row-item.is-muted').count()) >= 1);
  await shot('b3-06-register');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
