/**
 * Batch 2 browser test: master data, ink master, design library (keyboard-driven).
 * Needs an admin account on the target DB.
 *
 *   ADMIN_USER=admin ADMIN_PASS=Admin12345 NODE_PATH=$(npm root -g) node tests/masters_e2e.test.cjs
 * Env: BASE, SHOTS (screenshot folder), CHROMIUM_PATH.
 */
const { chromium } = require('playwright');
const os = require('os');
const path = require('path');
const fs = require('fs');

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
  const enter = async (n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(50); } };
  const type = (s) => page.keyboard.type(s);
  const focused = () => page.evaluate(() => {
    const el = document.activeElement;
    const hidden = el.closest('[data-combobox]')?.querySelector('input[type=hidden]');
    return hidden ? hidden.name : el.name || el.id;
  });

  console.log('== login');
  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('form [name=username]');
  await page.evaluate(() => localStorage.setItem('fpms.lang', 'en'));
  await type(process.env.ADMIN_USER || 'admin'); await enter();
  await type(process.env.ADMIN_PASS || 'Admin12345'); await enter();
  await page.waitForSelector('.tile-list');
  check('setup tiles now clickable', (await page.locator('a.tile[href="#/m/parties"]').count()) === 1);

  console.log('== party (keyboard only)');
  await page.goto(`${BASE}/#/m/parties/new`);
  await page.waitForSelector('form [name=name]');
  await page.waitForTimeout(150);
  check('first field focused (code)', (await focused()) === 'code');
  await enter(); // blank code → auto
  await type(`Rehman Fabrics ${RUN}`); await enter();
  await type('رحمان فیبرکس'); await enter();
  await enter(); // customer (checked by default)
  await enter(); // supplier
  await page.keyboard.press('Space'); await enter(); // fabric owner ✓
  await type('Rehman'); await enter();
  await type('0321-7654321'); await enter();
  await enter(); await enter(); // whatsapp, email
  await type('Lahore'); await enter();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[name=name]')?.value === '', null, { timeout: 5000 });
  check('party saved, form cleared for next', true);
  await page.goto(`${BASE}/#/m/parties`);
  await page.waitForSelector('.rows');
  await page.fill('[name=q]', `Rehman Fabrics ${RUN}`);
  await page.waitForTimeout(600);
  const partyRow = await page.locator('.rows .row-item').first().textContent();
  check('party listed with auto code and fabric-owner tag', /P\d{4}/.test(partyRow) && partyRow.includes('Fabric owner'), partyRow);

  console.log('== items: type-dependent fields');
  await page.goto(`${BASE}/#/m/items/new`);
  await page.waitForSelector('form [name=item_type]');
  check('fabric shows quality', await page.isVisible('[data-wrap=quality]'));
  check('fabric hides colour', !(await page.isVisible('[data-wrap=ink_colour_id]')));
  await page.selectOption('[name=item_type]', 'ink');
  await page.waitForTimeout(80);
  check('ink shows colour + rate/liter', await page.isVisible('[data-wrap=ink_colour_id]') && await page.isVisible('[data-wrap=rate_per_liter]'));
  check('ink hides quality', !(await page.isVisible('[data-wrap=quality]')));
  await page.click('[data-wrap=unit_id] .ss-input');
  const unitOpts = await page.locator('[data-wrap=unit_id] .ss-option .ss-label').allTextContents();
  check('ink units limited to volume', unitOpts.length === 2 && unitOpts.every((u) => /Liter|Milliliter/.test(u)), unitOpts.join(','));
  await page.keyboard.press('Escape');

  console.log('== ink master');
  await page.goto(`${BASE}/#/m/inks/new`);
  await page.waitForSelector('form [name=name]');
  await page.waitForTimeout(150);
  await enter(); // code auto
  await type(`Yellow Ink ${RUN}`); await enter();
  await enter(); // urdu name
  await type('Yell'); await enter(); // colour → Yellow
  check('colour picked by typing', (await page.inputValue('input[name=ink_colour_id]')) !== '');
  check('focus moved to ink type', (await focused()) === 'process_type');
  await enter(); // process: sublimation
  await type('DuPont'); await enter();
  await type('Liter'); await enter();
  await type('4200'); await enter();
  await type('5'); await enter();
  await enter(); // remarks
  await enter(); // active → last field → save
  await page.waitForFunction(() => document.querySelector('[name=name]')?.value === '', null, { timeout: 5000 });
  check('ink saved via Enter on last field', true);
  await page.goto(`${BASE}/#/m/inks`);
  await page.waitForSelector('.rows');
  await page.fill('[name=q]', `Yellow Ink ${RUN}`);
  await page.waitForTimeout(600);
  const inkRow = await page.locator('.rows .row-item').first().textContent();
  check('ink listed with rate per liter', inkRow.includes('4,200.00') && inkRow.includes('/ L'), inkRow);
  await shot('b2-01-inks');

  console.log('== design (keyboard + grids)');
  await page.goto(`${BASE}/#/designs/new`);
  await page.waitForSelector('form [name=name]');
  await page.waitForTimeout(150);
  await enter(); // code auto
  await type(`Paisley ${RUN}`); await enter();
  await type(`Rehman Fabrics ${RUN}`); await enter(); // customer
  await enter(); // process sublimation
  await enter(); // machine (optional)
  await enter(); // finished item (optional)
  await type('64'); await enter(); // repeat w
  await type('48'); await enter(); // repeat h
  await type('120'); await enter(); // basis gsm
  await type('58'); await enter(); // basis width
  let f = await focused();
  check('Enter flows from header into ink grid', f === 'ink_colour_id', f);
  await type('Cyan'); await enter();
  await type('35'); await enter();   // coverage
  check('manual checkbox next', (await focused()) === 'is_manual');
  await enter();                      // manual (unchecked)
  f = await focused();
  check('readonly ml/m skipped → ink item', f === 'item_id', f);
  await enter();                      // ink item: default (last column → new row)
  await page.waitForTimeout(80);
  check('new ink row added', (await page.locator('[data-grid-name=inks] tbody tr').count()) === 2);
  await type('Yellow'); await enter();
  await type('20'); await enter(); await enter(); await enter();
  await page.waitForTimeout(80);
  await enter(); // empty third row → leaves grid to BOM
  f = await focused();
  check('empty ink row jumps to BOM grid', f === 'item_id' && await page.evaluate(() => !!document.activeElement.closest('[data-grid-name=bom]')), f);
  const ml = await page.inputValue('[data-grid-name=inks] tbody tr:first-child [data-col=ml_per_meter]');
  // 12 × 0.35 × 1.4732 × 1.2 = 7.4249
  check('cyan ml/m calculated live', ml === '7.4249', ml);
  await enter(); // empty BOM row → remarks
  check('empty BOM row jumps to remarks', (await focused()) === 'remarks');
  await shot('b2-02-design-form');

  // image (chosen before first save → uploaded after create)
  const png = path.join(os.tmpdir(), `design-${RUN}.png`);
  fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  await page.setInputFiles('input[name=image]', png);
  check('image preview shown', (await page.locator('[data-preview] img').count()) === 1);
  await page.focus('[name=remarks]');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[name=name]')?.value === '', null, { timeout: 8000 });
  check('design saved and form cleared', true);
  check('success toast names design code', /D\d{4}/.test(await page.locator('.toast-success').last().textContent()));

  console.log('== design list + edit');
  await page.goto(`${BASE}/#/designs`);
  await page.waitForSelector('.gallery');
  await page.fill('[name=q]', `Paisley ${RUN}`);
  await page.waitForTimeout(600);
  check('design card has thumbnail', (await page.locator('.gallery .design-card img').count()) === 1);
  await page.locator('.gallery .design-thumb').first().click();
  await page.waitForSelector('[data-grid-name=inks] tbody tr');
  await page.waitForTimeout(150);
  check('edit loads 2 ink rows', (await page.locator('[data-grid-name=inks] tbody tr').count()) === 2);
  const summary = await page.textContent('[data-summary]');
  check('summary shows ink cost', /Ink cost per meter/.test(summary) && /Rs/.test(summary), summary);

  // Server-side grid error: duplicate colour
  await page.click('[data-grid-name=inks] [data-add]');
  await page.waitForTimeout(80);
  await type('Cyan'); await enter();
  await type('5');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[data-grid-name=inks] tbody tr:nth-child(3) [aria-invalid=true]', { timeout: 5000 });
  check('duplicate colour error shown in its row', true);
  check('focus moved to the invalid cell', await page.evaluate(() => !!document.activeElement.closest('[data-grid-name=inks] tbody tr:nth-child(3)')));
  await page.click('[data-grid-name=inks] tbody tr:nth-child(3) [data-remove]');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => location.hash === '#/designs', null, { timeout: 5000 });
  check('edit saved → back to list', true);

  console.log('== mobile + urdu');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/#/designs/new`);
  await page.waitForSelector('[data-grid-name=inks]');
  await page.click('[data-cmyk]');
  await page.waitForTimeout(150);
  check('Add CMYK fills 4 rows', (await page.locator('[data-grid-name=inks] tbody tr').count()) === 4);
  await shot('b2-03-design-mobile');
  await page.click('.topbar [data-lang]');
  await page.waitForTimeout(300);
  await page.goto(`${BASE}/#/m/items`);
  await page.waitForSelector('.rows');
  check('items list in Urdu RTL', (await page.getAttribute('html', 'dir')) === 'rtl');
  await shot('b2-04-items-ur');
  await page.click('.topbar [data-lang]');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
