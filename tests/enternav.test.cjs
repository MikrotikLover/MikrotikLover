/**
 * Browser test for enterNav.js + searchSelect.js using tests/enternav.html.
 *
 *   php -S 127.0.0.1:8080 -t .            (from the project root)
 *   NODE_PATH=$(npm root -g) node tests/enternav.test.cjs
 *
 * Env: BASE (default http://127.0.0.1:8080), CHROMIUM_PATH (optional).
 */
const { chromium } = require('playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8080';
let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  page.on('pageerror', (e) => { fail++; console.log('  PAGE ERROR', e.message); });
  await page.goto(`${BASE}/tests/enternav.html`);
  await page.waitForFunction(() => window.ready === true);

  const active = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!el) return null;
    const row = el.closest('[data-row]');
    const rowIdx = row ? [...row.parentElement.children].indexOf(row) : -1;
    return { id: el.id, name: el.name || el.closest('[data-combobox]')?.querySelector('input[type=hidden]')?.name || '', row: rowIdx };
  });
  const press = async (key) => { await page.keyboard.press(key); await page.waitForTimeout(40); };

  console.log('== field navigation');
  await page.waitForTimeout(100);
  check('autofocus first field', (await active()).id === 'a');
  await page.keyboard.type('Hello');
  await press('Enter');
  check('Enter → next field (select)', (await active()).id === 'b');
  check('Enter did not submit', (await page.evaluate(() => window.saveCalls.length)) === 0);
  await press('Enter');
  check('Enter on select → searchable select', (await active()).id === 'c');
  check('searchable select opened on focus', await page.evaluate(() => !document.querySelector('#c').closest('.ss').querySelector('.ss-list').hidden));

  console.log('== searchable select');
  await press('Enter');
  check('required empty select: Enter stays', (await active()).id === 'c');
  await page.keyboard.type('subl');
  await press('Enter');
  check('first Enter selects highlighted option', (await page.evaluate(() => document.querySelector('input[name=c]').value)) === 'paper');
  const afterC = await active();
  check('…and moves on, skipping readonly/disabled/hidden', afterC.id === 'g', JSON.stringify(afterC));
  await press('Shift+Enter');
  check('Shift+Enter → previous field', (await active()).id === 'c');
  check('label shows chosen option', (await page.evaluate(() => document.querySelector('#c').value)) === 'Sublimation Paper');
  await press('Enter'); // list opens on focus with current value highlighted → confirms and moves
  check('Enter keeps current value and moves', (await active()).id === 'g' && (await page.evaluate(() => document.querySelector('input[name=c]').value)) === 'paper');

  console.log('== line-item grid');
  await page.keyboard.type('G value');
  await press('Enter');
  let a = await active();
  check('Enter → grid row 1 first column', a.row === 0 && a.name === 'item', JSON.stringify(a));
  await page.keyboard.type('grey');
  await press('Enter');
  a = await active();
  check('row item picked → qty', a.name === 'qty' && a.row === 0, JSON.stringify(a));
  await page.keyboard.type('12.5');
  await press('Enter');
  await page.keyboard.type('100');
  await press('Enter');
  await page.waitForTimeout(60);
  a = await active();
  check('Enter on last column adds a row and focuses its first column', a.row === 1 && a.name === 'item', JSON.stringify(a));
  check('readonly amount computed and skipped', (await page.evaluate(() => document.querySelectorAll('[data-row]')[0].querySelector('[name=amount]').value)) === '1250');
  await press('Enter');
  a = await active();
  check('Enter on empty new row → Remarks', a.id === 'remarks', JSON.stringify(a));

  console.log('== save');
  await page.keyboard.type('Urgent');
  await press('Enter');
  check('Enter on last field saves', (await page.evaluate(() => window.saveCalls.length)) === 1);
  check('save button disabled while saving', await page.evaluate(() => document.querySelector('#save').disabled));
  await press('Control+s');
  await page.waitForTimeout(400);
  check('no double save', (await page.evaluate(() => window.saveCalls.length)) === 1);
  const saved = await page.evaluate(() => window.saveCalls[0]);
  check('collected data correct', saved.a === 'Hello' && saved.c === 'paper' && saved.lines.length === 1 && saved.lines[0].qty === '12.5' && saved.remarks === 'Urgent', JSON.stringify(saved));
  check('success toast shown', (await page.evaluate(() => window.toasts.at(-1))).join() === 'Saved!,success');
  check('form cleared', await page.evaluate(() => document.querySelector('#a').value === '' && document.querySelectorAll('[data-row]').length === 1 && document.querySelector('input[name=c]').value === ''));
  check('focus back on first field', (await active()).id === 'a');
  check('save button re-enabled', await page.evaluate(() => !document.querySelector('#save').disabled));

  console.log('== validation');
  await press('Control+s');
  await page.waitForTimeout(50);
  check('Ctrl+S with errors does not call onSave', (await page.evaluate(() => window.saveCalls.length)) === 1);
  check('first invalid field focused', (await active()).id === 'a');
  check('message shown beside field', await page.evaluate(() => document.querySelector('#a').closest('.field').querySelector('.field-error')?.textContent === 'This field is required.'));
  check('required searchable select flagged too', await page.evaluate(() => document.querySelector('#c').getAttribute('aria-invalid') === 'true'));
  await page.keyboard.type('x');
  check('error clears on input', await page.evaluate(() => !document.querySelector('#a').closest('.field').querySelector('.field-error')));

  console.log('== server errors');
  await page.fill('#a', 'servererr');
  await page.click('#c');
  await page.keyboard.type('ink');
  await press('Enter');
  await page.fill('#g', 'z');
  await page.focus('#g');
  await press('Enter'); // into grid
  await page.keyboard.type('grey');
  await press('Enter');
  await page.keyboard.type('5');
  await press('Control+s');
  await page.waitForTimeout(450);
  check('server field error shown beside G', await page.evaluate(() => document.querySelector('#g').closest('.field').querySelector('.field-error')?.textContent === 'Server says no'));
  check('grid error mapped to row 1 qty', await page.evaluate(() => document.querySelector('[data-row] [name=qty]').getAttribute('aria-invalid') === 'true'));
  check('first server-invalid field focused', (await active()).id === 'g');
  check('form kept after failed save', (await page.evaluate(() => document.querySelector('#a').value)) === 'servererr');

  console.log('== IME composition');
  await page.focus('#a');
  await page.evaluate(() => {
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    document.querySelector('#a').dispatchEvent(ev);
  });
  check('Enter during IME composition ignored', (await active()).id === 'a');

  await browser.close();
  console.log(`\npassed: ${pass}  failed: ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
