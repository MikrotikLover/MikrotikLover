# Digital Fabric Printing Management System

Vanilla PHP 8.x + MySQL backend (no framework, no Composer) and a vanilla JavaScript
SPA (mobile-first, English / Urdu RTL) for a digital textile printing unit.
Timezone **Asia/Karachi**, currency **PKR**.

## Delivery status

| Batch | Scope | Status |
|---|---|---|
| 1 | DB schema, folder structure, auth & roles, `enterNav.js` | ✅ delivered |
| 2 | Master data CRUD, design library, ink master | ✅ delivered |
| 3 | Inward Gate Pass, Stock Transfer, Stock Consumption, Ink Loading | ✅ delivered |
| 4 | Estimation, BOM Production, Manual Production | ✅ delivered |
| 5 | Delivery Chalan + print layouts | ✅ delivered |
| 6 | Reports, exports, dashboard | ✅ delivered |

## Folder structure

```
public_html/                 ← deploy folder (this repository)
├── index.html               SPA shell
├── .htaccess                denies app/, database/, tests/; no-cache for API
├── config.sample.php        copy OUTSIDE the deploy folder as config.php
├── api/index.php            single API entry: api/index.php?r=<route>
├── app/                     backend (web access denied)
│   ├── bootstrap.php        autoload, timezone, error handling
│   ├── routes.php           route table (auth, perm, csrf per route)
│   ├── core/                Config, DB (PDO), Router, Request, Response,
│   │                        Session, Csrf, Auth, Audit, Validator, Lang, Logger
│   ├── controllers/         Auth, Setup, User, Role, Audit, Health,
│   │                        MasterController (base) → Party, Warehouse, Unit, Item,
│   │                        InkColour, Machine, Design; Settings, Lookup
│   │                        VoucherController (base) → InwardGatePass, StockTransfer,
│   │                        StockConsumption, InkLoad, Estimation,
│   │                        ProductionController → BomProduction, ManualProduction,
│   │                        DeliveryChalan;
│   │                        Stock (balances), Report (all reports + dashboard)
│   └── services/            Settings, InkService, Stock (ledger), VoucherNumber,
│                            ProductionService (requirements + costing)
├── assets/
│   ├── css/app.css
│   └── js/
│       ├── app.js           boot + hash router + top bar + WhatsApp button
│       ├── core/            enterNav.js, searchSelect.js, lineGrid.js, formKit.js,
│       │                    lookups.js, stockCache.js, print.js, export.js (CSV / XLSX),
│       │                    api.js, i18n.js, session.js, ui.js, icons.js
│       ├── i18n/            en.js, ur.js
│       └── views/           login, setup, home, users, userForm, roles, audit, profile,
│                            masterList / masterForm + masters/config.js, designs,
│                            designForm, settings, voucherList / voucherForm /
│                            voucherView + vouchers/defs.js, productionDefs.js, deliveryDefs.js,
│                            dashboard, report + reports/defs.js, form.js, runner.js
├── database/schema.sql      full schema for ALL batches (33 tables + stock view)
├── database/seed.sql        roles, permission matrix, units, warehouses, ink colours, settings
└── tests/                   API (bash + curl) and browser (Playwright) tests — see Tests

fabric_private/              ← OUTSIDE the deploy folder (survives redeploys)
├── config.php
├── uploads/                 design images (Batch 2)
├── logs/                    app-YYYY-MM.log
└── sessions/                PHP sessions
```

## Install on Hostinger

1. **Database** — hPanel → Databases → create a MySQL database + user.
   phpMyAdmin → Import `database/schema.sql`, then `database/seed.sql`.
2. **Deploy** — push this repo to `public_html` (Git deploy or File Manager upload).
3. **Config** — create `fabric_private/` *next to* `public_html` (same parent folder),
   copy `config.sample.php` into it as `config.php`, fill in DB credentials and a long
   random `setup_key`. A different location can be set with the `FPMS_PRIVATE_DIR` env var.
4. **Check** — open `https://your-domain/api/index.php?r=health` → `"ok": true`.
5. **First admin** — open the site; the one-time Setup screen asks for the setup key
   and creates the Admin. It is disabled as soon as one user exists.
6. LiteSpeed Cache: nothing to configure — every API response sends
   `Cache-Control: no-store` and `X-LiteSpeed-Cache-Control: no-cache`.

No CLI, cron, `proc_open` or queues are used.

## Security

- PDO prepared statements everywhere, `EMULATE_PREPARES=false`, strict SQL mode.
- CSRF synchroniser token in `X-CSRF-Token` for every non-GET request (419 → auto refresh/retry).
- `password_hash` (bcrypt) with auto-rehash; policy ≥ 8 chars, letters + digits.
- Login lockout: 5 failures per username / 25 per IP in 15 minutes (configurable).
- Session: HttpOnly, SameSite=Lax, Secure on HTTPS, strict mode, id regenerated on login,
  idle timeout (default 120 min). Password change/reset invalidates other sessions.
- Role-based access: `module.action` permissions, editable matrix (Admin always full).
  The user is reloaded on every request, so deactivation/role changes apply immediately.
- Audit log of every create / update (changed fields only) / delete / cancel, logins,
  failed logins, password changes and permission changes — written in the same DB transaction.
- Soft delete (`deleted_at`, `deleted_by`) on masters and users; vouchers also have
  `status = cancelled` with reason.

## Master data (Batch 2)

| Screen | Route | Notes |
|---|---|---|
| Parties | `#/m/parties` | customer / supplier / fabric owner (job work) flags, Urdu name |
| Items | `#/m/items` | type-dependent fields: fabric (quality, GSM, width), ink, paper, chemical, other |
| Ink master | `#/m/inks` | ink items: colour, brand, type, liter/ml unit, **rate per liter**, reorder level |
| Ink colours | `#/m/ink_colours` | C, M, Y, K + specials with swatch colour |
| Machines | `#/m/machines` | type, speed m/hr, hourly running cost, floor warehouse |
| Warehouses / Units | `#/m/warehouses`, `#/m/units` | unit conversion factor to base unit |
| Design library | `#/designs` | image (stored in `fabric_private/uploads/designs`, served only to logged-in users), repeat size, ink per colour, BOM per meter, live costing |
| Settings | `#/settings` | company details, WhatsApp number, ink calculation constants |

- Codes left blank are numbered automatically (`P0001`, `WH0001`, `GF0001`, `INK0001`, `D0001` …).
- Delete is a soft delete and is refused (409) while a record is referenced; mark it inactive instead.
- **Ink per design:** `ml/m = ml_per_m²_at_100% × coverage% × width(m) × GSM ÷ reference GSM`
  (constants in Settings). Tick *Manual* on a colour to enter ml/m measured on the machine.
  Ink cost per meter uses the chosen ink item, or the active ink of that colour for the
  design's process. `InkService::designInkCost()` is reused by estimation/production costing.
- Images are re-encoded with GD (strips metadata), resized to ≤ 2400 px, 360 px JPEG thumbnail.

## Stock vouchers (Batch 3)

| Voucher | Number | Route | Stock effect |
|---|---|---|---|
| Inward Gate Pass | `IGP-2627-00001` | `#/v/igp` | IN to the receiving warehouse (default Grey Store); job-work fabric records the party as lot owner |
| Stock Transfer | `STV-…` | `#/v/transfer` | OUT of source, IN to destination (default Grey Store → Printing Floor) |
| Stock Consumption | `SCV-…` | `#/v/consumption` | OUT (inks, paper, chemicals — not fabric) charged to machine / design / party; rate defaults to item rate |
| Ink Loading | `INK-…` | `#/v/ink_load` | OUT of the machine's floor warehouse; ml converted to the ink's unit (750 ml → 0.75 l) |

- Home → Transactions opens a **new** voucher directly; *All vouchers* opens the register
  (date range, status, search by number / party / vehicle).
- Grids show **available stock** (per lot for lot-tracked items) and suggest lots that have stock.
- After save: toast, the form clears for the next voucher, and a *Last saved · Print* link appears.
- View: Print (A4 with company header and signature lines), Edit, Cancel (with reason).
- Edit replaces the voucher's lines and stock rows; Cancel reverses its stock rows and keeps
  the voucher marked *Cancelled*. Both are refused when stock already used by later
  vouchers would go negative (e.g. cancelling an IGP whose fabric was transferred).
- Negative stock is impossible: items are locked `FOR UPDATE` during a save and balances are
  re-checked after posting, so parallel saves cannot oversell a lot (tested with 6 parallel requests).
- Lot numbers: only items with *Track lot numbers* keep lots in the ledger; their outflows
  require a lot. Other items' lot field is skipped by ENTER.
- Voucher dates cannot be in the future (Asia/Karachi).

## Estimation & production (Batch 4)

| Voucher | Number | Route | What it does |
|---|---|---|---|
| Production Estimation | `PEV-…` | `#/v/estimation` | Design + order meters (+ wastage %) → ink ml per colour, paper, chemicals, fabric, machine hours, estimated cost and cost per meter. Live preview while typing; no stock effect. |
| BOM Production | `BOM-…` | `#/v/bom_production` | Pick an estimation or design → materials load from the design BOM for the printed meters; enter actual quantities (variance % shown). |
| Manual Production | `MPV-…` | `#/v/manual_production` | Sampling, re-print, non-standard jobs: materials entered by hand, design optional. |

Stock posted by a production voucher:

- **OUT grey fabric** = printed meters (good + wastage + rejected) from the fabric warehouse / lot.
- **IN finished fabric** = good meters to the finished store; the lot defaults to the fabric lot and
  the job-work owner is carried over.
- **OUT paper / chemicals / other** at the actual quantity. BOM lines you don't list are still
  consumed at the estimated quantity.
- **Ink is recorded but not deducted**: ink leaves stock on the Ink Loading voucher (Batch 3), so
  production stores estimated vs actual ml per colour for costing and variance only.

Costing per production: materials (+ own fabric at item rate; job-work fabric costs 0) + ink +
machine hours × hourly cost → **cost per good meter**. Machine hours = entered, else end − start,
else printed meters ÷ machine speed. Meters convert to the fabric item's unit (yard, or kg via GSM × width).
Edit and cancel follow the voucher rules: refused when the finished fabric was already moved or used.

## Delivery chalan & print layouts (Batch 5)

**Outward Gate Pass / Delivery Chalan** (`DCV-…`, `#/v/chalan`): dispatch fabric to a party,
stock OUT of the dispatch warehouse (default Finished Store).

- Choosing the party fills the delivery address and shows its **job-work position**: fabric
  received, printed, delivered, pending delivery, ready in the finished store, grey still in stock.
- **Add this party's lots** fills the grid with every lot the party owns in that warehouse
  (full meters, rolls and design).
- **Job-work protection**: a lot owned by one party (job work) cannot be delivered to another.
  Own stock can go to anyone. Only fabric (finished or grey) can be dispatched.
- Design and production are filled from the production that made the lot.

**Print layouts** (A4, from the voucher view):

| Format | Contents |
|---|---|
| Delivery Chalan | Company header, *Deliver to* box (party, address, phone, NTN), PO/ref, vehicle, driver, items with design / lot / rolls / meters and totals, declaration, receiver block (name, CNIC, signature & stamp, date/time), signatures. 1–3 labelled copies (Party / Office / Gate), one per page. |
| Outward Gate Pass | Compact half-page for the gate: party, vehicle, driver, item / lot / rolls / meters, store keeper / gate keeper / driver signatures. No rates. |

Settings → Printing: number of chalan copies and the declaration text.
All other vouchers print through the same layout engine (`assets/js/core/print.js`).

## Reports, exports & dashboard (Batch 6)

**Reporting** on the home screen is an accordion: opening a report shows its filter form.
Enter walks the filters, Enter on the last filter (or Ctrl+S) opens the report page
`#/r/<report>?date_from=…&…` (filters stay in the URL, so a report can be bookmarked).
**Excel**, **CSV** and **PDF** download straight from the filter form (permission `reports.export`).
Every report has a date range (default: 1st of this month → today) plus the filters below.

| Report | Views | Filters |
|---|---|---|
| Inward Gate Pass | voucher lines; type all / own / job work | party, item, warehouse |
| Stock Transfer | voucher lines | item, warehouse (from or to) |
| Stock Consumption | lines · by item · by machine · by job (design / party) | item, machine, design, party, warehouse |
| Production (All / BOM / Manual) | vouchers (printed, produced, wastage %, ink est. vs actual, costs, cost/m) · estimated vs actual materials · by machine (m/hour, cost/m) | party, design, machine |
| Delivery Chalan | chalan lines · party-wise pending vs delivered meters (+ ready stock) | party, item, design, warehouse |
| Ink | by colour · by machine (loaded ml/m) · by design · ink cost per meter · ink stock ledger · reorder alert list | colour, machine, design, ink item, warehouse |
| Stock | current stock (per item, warehouse, lot, owner, value) as at *To date* · stock ledger (one item, opening + running balance) · below reorder level | item, warehouse, party (owner), lot, item type |
| Party-wise job-work balance | per fabric owner: opening, received, delivered, process loss, balance, grey + printed stock, difference | party |

All numbers come from the vouchers and the `stock_movements` ledger; cancelled vouchers are excluded.
Large results are capped at 5,000 rows with a notice ("narrow the filters").

**Exports** (no library, no server process — works on shared hosting):

- **Excel** — a real `.xlsx` written in the browser (`assets/js/core/export.js`): title, company,
  filter lines, bold header with auto-filter and frozen panes, numbers as numbers, dates as Excel
  dates, totals row, right-to-left sheet when the app is in Urdu.
- **CSV** — UTF-8 with BOM, so Excel shows Urdu names correctly.
- **PDF** — A4 landscape report layout opened in the print dialog → *Save as PDF*
  (the header row repeats on every page). The same button prints on paper.

**Dashboard** (top of home, permission `dashboard.view`): today's inward / outward / produced
meters and ink loaded (each opens the matching report for today), production by machine
(last 7 days, with today's meters), ink & paper below reorder level, pending deliveries
(received − delivered, with ready stock) and top customers of the last 30 days.

## Database rules (implemented in schema, used from Batch 3)

- `stock_movements` is the only stock ledger (`item, warehouse, lot, qty_in, qty_out,
  voucher_type, voucher_id …`); `v_stock_balance` derives current stock.
- Each voucher is saved in one DB transaction; numbers come from `voucher_sequences`
  (per type and Pakistani fiscal year, e.g. `IGP-2627-00001`) under `SELECT … FOR UPDATE`.
- Negative stock is blocked at save time (items locked with `FOR UPDATE`, balance re-checked).

## enterNav.js — keyboard data entry

```js
import EnterNav from './core/enterNav.js';
EnterNav.attach(formEl, {
  onSave: (data) => api.post('route', data),   // throw ApiError → errors shown beside fields
  onReset: (form) => {},                       // rebuild grids etc.
  validate: (form) => ({ field: 'message' }),  // optional extra checks
});
```

| Key | Behaviour |
|---|---|
| Enter | next field (never submits). Skips disabled, readonly, hidden, `tabindex=-1`, `[data-enter-skip]` |
| Shift+Enter | previous field |
| Enter in searchable select | picks highlighted option **and** moves on; a required empty one stays open |
| Enter on last column of last grid row | adds a row, focuses its first column |
| Enter on an empty last grid row | jumps to Remarks (first field after the grid) / Save |
| Enter on last field | Save |
| Ctrl+S / ⌘+S | Save from anywhere |
| Validation error | first invalid field focused, message beside it (client or server 422) |
| Saving | save button disabled + spinner (no double save); success → toast, clear, focus first field |
| IME composing (Urdu keyboard) | Enter ignored |

Grids: mark the container `data-enter-grid`, each row `data-row`, key inputs `data-row-key`;
supply `grid.enterNavAddRow = () => newRow` or a `<template data-row-template>`.
`textarea[data-enter-newline]` keeps Enter for new lines.

## Tests

```bash
php -S 127.0.0.1:8080 -t .                       # with FPMS_PRIVATE_DIR pointing at a config
SETUP_KEY=... tests/api_smoke.sh                 # 34 API checks (fresh DB)
NODE_PATH=$(npm root -g) node tests/enternav.test.cjs        # 34 keyboard checks (Playwright)
SETUP_KEY=... NODE_PATH=$(npm root -g) node tests/app_e2e.test.cjs  # 24 SPA end-to-end checks (fresh DB)
ADMIN_PASS=... tests/api_masters.sh               # 58 master-data / design / image API checks
ADMIN_PASS=... NODE_PATH=$(npm root -g) node tests/masters_e2e.test.cjs  # 32 keyboard-driven UI checks
ADMIN_PASS=... tests/api_vouchers.sh              # 52 voucher / stock / concurrency checks
ADMIN_PASS=... NODE_PATH=$(npm root -g) node tests/vouchers_e2e.test.cjs # 33 voucher UI checks
ADMIN_PASS=... tests/api_production.sh            # 58 estimation / production / costing checks
ADMIN_PASS=... NODE_PATH=$(npm root -g) node tests/production_e2e.test.cjs # 22 production UI checks
ADMIN_PASS=... tests/api_chalan.sh                # 26 delivery chalan checks
ADMIN_PASS=... NODE_PATH=$(npm root -g) node tests/chalan_e2e.test.cjs   # 19 chalan + print UI checks
ADMIN_PASS=... tests/api_reports.sh               # 65 report / dashboard / permission checks
ADMIN_PASS=... NODE_PATH=$(npm root -g) node tests/reports_e2e.test.cjs  # 42 report UI + export checks (openpyxl re-reads the .xlsx if installed)
# Use PHP_CLI_SERVER_WORKERS=6 with php -S so the concurrency test really runs in parallel.
```
