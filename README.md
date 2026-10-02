# Digital Fabric Printing Management System

Vanilla PHP 8.x + MySQL backend (no framework, no Composer) and a vanilla JavaScript
SPA (mobile-first, English / Urdu RTL) for a digital textile printing unit.
Timezone **Asia/Karachi**, currency **PKR**.

## Delivery status

| Batch | Scope | Status |
|---|---|---|
| 1 | DB schema, folder structure, auth & roles, `enterNav.js` | ✅ this delivery |
| 2 | Master data CRUD, design library, ink master | pending |
| 3 | Inward Gate Pass, Stock Transfer, Stock Consumption, Ink Loading | pending |
| 4 | Estimation, BOM Production, Manual Production | pending |
| 5 | Delivery Chalan + print layouts | pending |
| 6 | Reports, exports, dashboard | pending |

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
│   └── controllers/         Auth, Setup, User, Role, Audit, Health
├── assets/
│   ├── css/app.css
│   └── js/
│       ├── app.js           boot + hash router + top bar + WhatsApp button
│       ├── core/            enterNav.js, searchSelect.js, api.js, i18n.js,
│       │                    session.js, ui.js, icons.js
│       ├── i18n/            en.js, ur.js
│       └── views/           login, setup, home, users, userForm, roles, audit, profile
├── database/schema.sql      full schema for ALL batches (33 tables + stock view)
├── database/seed.sql        roles, permission matrix, units, warehouses, ink colours, settings
└── tests/                   api_smoke.sh, enternav.html + enternav.test.cjs, app_e2e.test.cjs

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
```
