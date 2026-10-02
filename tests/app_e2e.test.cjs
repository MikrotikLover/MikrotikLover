/**
 * End-to-end test of the SPA on a FRESH database (schema + seed, no users).
 *
 *   php -S 127.0.0.1:8080 -t .
 *   SETUP_KEY=... NODE_PATH=$(npm root -g) node tests/app_e2e.test.cjs
 *
 * Env: BASE, SETUP_KEY, SHOTS (folder for screenshots, optional), CHROMIUM_PATH.
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
const SHOTS = process.env.SHOTS || '';
let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Network failures (e.g. Google Fonts blocked offline) are not app errors.
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  const shot = async (name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
  const enter = async (n = 1) => { for (let i = 0; i < n; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(40); } };

  console.log('== setup');
  await page.goto(`${BASE}/`);
  await page.waitForSelector('form');
  check('redirected to setup', page.url().endsWith('#/setup'));
  await shot('01-setup');
  if (process.env.SETUP_KEY) await page.keyboard.type(process.env.SETUP_KEY);
  if (process.env.SETUP_KEY) await enter();
  await page.keyboard.type('Muhammad Ali');
  await enter();
  await page.keyboard.type('admin');
  await enter();
  await page.keyboard.type('Admin12345');
  await enter();
  await page.keyboard.type('Admin12345');
  await enter(); // last field → save
  await page.waitForSelector('.tile-list');
  check('admin created and home shown', page.url().endsWith('#/'));
  check('transactions section', (await page.locator('#h-tx').count()) === 1);
  check('8 transaction cards', (await page.locator('#h-tx + .tile-list li').count()) === 8);
  check('reporting accordion', (await page.locator('.acc-item').count()) === 8);
  check('whatsapp button', (await page.locator('.wa-fab').count()) === 1);
  await page.locator('.acc-item summary').first().click();
  await shot('02-home-en');

  console.log('== users');
  await page.goto(`${BASE}/#/users/new`);
  await page.waitForSelector('form [name=full_name]');
  await page.waitForTimeout(100);
  await page.keyboard.type('Store Keeper One');
  await enter();
  await page.keyboard.type('store1');
  await enter();
  await page.keyboard.type('store');
  await enter(); // picks "Store Keeper" in the role searchable select
  check('role chosen via searchable select', (await page.inputValue('input[name=role_id]')) !== '');
  await enter(); // lang select
  await page.keyboard.type('03001234567');
  await enter();
  await enter(); // email optional, skip
  await page.keyboard.type('weak');
  await enter(); // → "Active" checkbox
  await enter(); // → "Must change password" checkbox
  await enter(); // last field → save → client-side validation error
  await page.waitForTimeout(100);
  check('weak password flagged beside field', (await page.locator('[name=password]').getAttribute('aria-invalid')) === 'true');
  check('focus on invalid password', await page.evaluate(() => document.activeElement.name === 'password'));
  await shot('03-user-form-error');
  await page.keyboard.type('Store12345');
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => document.querySelector('[name=full_name]')?.value === '', null, { timeout: 5000 });
  check('saved: form cleared for next entry', true);
  check('focus back on first field', await page.evaluate(() => document.activeElement.name === 'full_name'));
  check('success toast', (await page.locator('.toast-success').count()) >= 1);

  // duplicate username → server error beside username
  await page.keyboard.type('Dup');
  await enter();
  await page.keyboard.type('store1');
  await enter();
  await page.keyboard.type('gate');
  await enter();
  await page.fill('[name=password]', 'Store12345');
  await page.keyboard.press('Control+s');
  await page.waitForSelector('[name=username][aria-invalid=true]', { timeout: 5000 });
  check('server duplicate error focused on username', await page.evaluate(() => document.activeElement.name === 'username'));

  await page.goto(`${BASE}/#/users`);
  await page.waitForSelector('.rows');
  check('users list shows 2 users', (await page.locator('.rows .row-item').count()) === 2);
  await shot('04-users');

  console.log('== urdu');
  await page.click('.topbar [data-lang]');
  await page.waitForTimeout(150);
  check('html dir=rtl', (await page.getAttribute('html', 'dir')) === 'rtl');
  check('title in urdu', (await page.textContent('.topbar-title')).includes('یوزرز'));
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.tile-list');
  await shot('05-home-ur');

  console.log('== roles & audit');
  await page.goto(`${BASE}/#/roles`);
  await page.waitForSelector('.role-form');
  check('role tabs', (await page.locator('.role-tabs .tab').count()) === 5);
  await page.goto(`${BASE}/#/audit`);
  await page.waitForSelector('.rows');
  check('audit entries visible', (await page.locator('.rows .row-item').count()) >= 2);
  await shot('06-audit-ur');
  await page.click('.topbar [data-lang]');

  console.log('== logout / forced password change');
  await page.click('[data-menu]');
  await page.click('[data-logout]');
  await page.waitForSelector('form [name=username]');
  check('back on login', page.url().endsWith('#/login'));
  await shot('07-login');
  await page.keyboard.type('store1');
  await enter();
  await page.keyboard.type('wrongpass1');
  await enter();
  await page.waitForSelector('[name=password][aria-invalid=true]');
  check('wrong password message beside password', (await page.locator('.field-error').first().textContent()).length > 3);
  await page.keyboard.type('Store12345');
  await enter();
  await page.waitForFunction(() => location.hash === '#/profile');
  check('forced to profile to change password', true);
  await page.keyboard.type('Store12345');
  await enter();
  await page.keyboard.type('NewStore123');
  await enter();
  await page.keyboard.type('NewStore123');
  await enter();
  await page.waitForFunction(() => location.hash === '#/');
  check('after change → home', true);
  check('store keeper sees no Users setup tile', (await page.locator('a[href="#/users"]').count()) === 0);

  console.log('== desktop layout');
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('08-home-desktop');

  check('no JS errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
