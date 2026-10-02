# Payroll & HR Management System (Pakistan industrial / textile)

Web-based payroll and HR system for Pakistani factories. It rebuilds the workflow of the old Windows payroll app as a keyboard-first web app.

**Stack:** vanilla PHP 8.3+ (target 8.5, no framework, no Composer), PDO + MySQL/MariaDB (InnoDB, `utf8mb4_unicode_ci`), and a vanilla-JS SPA (hash routing, ES modules, no build step). It is designed for Hostinger shared hosting (LiteSpeed, no `exec`/`proc_open`).

## Delivery status

| Batch | Scope | Status |
|---|---|---|
| 1 | Schema + migrations, auth/roles, SPA shell, Setup module (Employee + photo, Department, Designation, Shift, Shift Group, Holidays/rest days, Company settings), Employee List report, ID cards | **Delivered** |
| 2 | Attendance: manual voucher, barcode kiosk, ZKTeco ADMS push + CSV import, daily post, OT approval, leave register, attendance reports, live TV screen | Next |
| 3 | Accounts vouchers, loans, JV, voucher reports, DayBook | — |
| 4 | PayrollEngine, salary sheets, posting/locking, payslips, salary reports, unit tests | — |
| 5 | Dashboard, audit log viewer, rate settings, hardening, Hostinger deployment guide | — |

The **full database schema for every module** is already in place (`migrations/001`–`005`), so later batches only add code.

## Project layout

```
public/            web root: index.php (SPA shell), api.php, report.php, file.php, migrate.php, assets/
api/               router.php + controllers/ (one per module, CrudController base for masters)
app/               bootstrap, Config, Database, Auth, Validator, Audit, Storage, Settings, Permissions, Barcode, Reports/
migrations/        NNN_*.sql + migrate.php runner; seeds/ = demo data
storage/           local dev storage only — production points config storage_path OUTSIDE the deploy dir
tests/             php tests/run.php (no PHPUnit needed)
tools/             generate_seed.php, devserver.php (PHP built-in server router)
```

## Local setup

```bash
cp config.sample.php config.php          # set DB credentials, storage_path
mysql -e "CREATE DATABASE payroll CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
php migrations/migrate.php --seed        # schema + base data + demo data (omit --seed in production)
php -S 127.0.0.1:8080 -t public tools/devserver.php
php tests/run.php
```

Log in with **admin / admin123**. You'll be asked to change the password on first login. Demo users (password `demo1234`): `hr`, `operator`, `accounts`, `viewer`.

Hosts without SSH: set `security.setup_key` in `config.php`, open `/migrate.php?key=…` (add `&seed=1` for demo data), then clear the key.

## Key design points

- **Time zone:** `Asia/Karachi` in PHP, plus `SET time_zone='+05:00'` on every DB connection.
- **API:** `/api/*` sends `Cache-Control: no-store` and `X-LiteSpeed-Cache-Control: no-cache`, and `.htaccess` also disables LSCache for those paths.
- **Security:** session auth with a CSRF header on every non-GET request. Login is throttled (5 failures per user+IP in 15 min). Sessions time out after 30 min idle (client and server). Passwords use `password_hash`. Permissions are a role × module × action matrix (view/add/edit/delete/post/print).
- **Audit:** every create/update/delete writes `audit_log` with the user and the changed fields only (old/new JSON). Every table has `created_by/at` and `updated_by/at`.
- **Photos and logos** go to `storage_path` (outside the deploy folder) and are served only through `file.php` after an auth check. Uploads are re-encoded with GD (EXIF stripped). Photos are cropped client-side to 3:4 (300×400).
- **Locking:** a salary-history row covered by a posted salary sheet is shown as *Locked* and cannot be edited or deleted. The posting itself arrives in batch 4.
- **Employment period guard:** the joining or leaving date can't be moved past existing attendance.
- **Delete policy:** a master or employee referenced by other data can't be deleted (the API returns 409 "mark it inactive instead"). Posted vouchers use soft delete (`deleted_at`).
- **Reports** are server-rendered print-ready HTML with A4 `@page`, a company header, and a "printed by/at" footer. Page X of Y uses CSS margin boxes (Chrome/Edge 131+). CSV export is UTF-8 with a BOM so Urdu opens correctly in Excel. PDF comes from the browser's "Save as PDF".
- **ID cards** are CR80 (85.6 × 54 mm). There are two layouts: A4 sheets with 10 per page and the backs mirrored for duplex, or one face per page for PVC card printers. The barcode is Code 128, generated in PHP as inline SVG (verified against a reference encoder).

## Keyboard (every form)

| Key | Action | Key | Action |
|---|---|---|---|
| F1 | Search | F10 | Save |
| F5 | New | F12 | Delete |
| F7 | Show / reload | PgUp / PgDn | Previous / next record |
| F9 | Print | Enter | Next field (grids: next cell; last cell adds a row) |
| Esc | Close dialog | Ctrl+Del | Remove grid row |

## API endpoints (batch 1)

All responses are `{"ok":true,"data":…}` or `{"ok":false,"error":"…","errors":{field:msg}}`. Status codes: 401 not logged in, 403 no permission, 404 not found, 409 conflict/in use, 419 CSRF, 422 validation, 429 throttled.

| Method | Path | Permission |
|---|---|---|
| GET | `/api/auth/me` | public (returns CSRF token, user, permissions) |
| POST | `/api/auth/login` · `/api/auth/logout` | public |
| POST | `/api/auth/password` | logged in |
| GET | `/api/auth/ping` | logged in (keep-alive) |
| GET | `/api/lookups` | logged in |
| GET | `/api/dashboard/summary` | dashboard.view |
| GET | `/api/employees?q=&department_id=&designation_id=&shift_group_id=&status=&emp_type=&ids=&sort=&dir=&page=&per_page=` | employees.view |
| GET | `/api/employees/{id}` · `/api/employees/next-code` · `/api/employees/{id\|0}/neighbor?dir=prev\|next` | employees.view |
| POST | `/api/employees` (optional `salary`, `qualifications[]`, `experiences[]`) | employees.add |
| PUT | `/api/employees/{id}` | employees.edit |
| DELETE | `/api/employees/{id}` | employees.delete |
| POST / DELETE | `/api/employees/{id}/photo` (multipart `photo`) | employees.edit |
| GET / POST | `/api/employees/{id}/salary` | view / edit |
| PUT / DELETE | `/api/employees/{id}/salary/{sid}` | employees.edit |
| CRUD | `/api/departments` · `/api/designations` · `/api/shifts` · `/api/shift-groups` · `/api/holidays?year=` | module.view/add/edit/delete |
| GET / PUT | `/api/settings/company` | logged in / settings.edit |
| POST / DELETE | `/api/settings/logo` | settings.edit |
| PUT | `/api/settings/rest-days` | holidays.edit |
| CRUD | `/api/users` · `/api/roles` | users.* |
| GET | `/api/roles/modules` | users.view |
| GET | `/report.php?r=employee_list&…[&format=csv]` | employees.print (or reports.print + employees.view) |
| GET | `/report.php?r=id_cards&ids=1,2\|filters&layout=sheet\|cr80&issue_date=` | employees.print |
| GET | `/file.php?t=photo&emp={id}` · `/file.php?t=logo` | employees.view / logged in |

## Manual test checklist (batch 1)

1. Run `php migrations/migrate.php --seed`, log in as `admin/admin123`, and confirm you're forced to change the password.
2. Dashboard shows 15 employees: 14 active, 1 inactive, by department.
3. **Employee Info**: press **F5**. The next code (0016) is prefilled. Type a name and an Urdu name (it renders right-to-left). Type the CNIC as 13 digits and check the dashes appear automatically. Pick a department and designation (the Urdu name shows in each option). Enter the joining date and a shift group. On the Salary tab enter a basic salary. On the Qualification tab type a row, press Enter to move cells, and Enter on the last cell to add a row. Upload a photo, crop it, and press **F10**. The URL becomes `#/employees/{id}`.
4. Save another employee with the same CNIC or Machine ID: you get a field error naming the existing employee.
5. Set an existing employee's joining date after their first attendance day (e.g. 0003 → 2026-09-15): it's rejected.
6. Press **PgUp/PgDn** and use ◀ ▶ to move through records. **F1** opens search (type, then Enter). **F7** reloads. **F9** prints the ID card.
7. Edit a field and click another menu item: you get a "Discard unsaved changes?" prompt.
8. Salary Info → *Add salary record / increment* with a new effective date. History keeps both rows and marks the newest as "Current".
9. Try to delete employee 0003: you get 409 "has attendance… set Inactive instead". A freshly created employee can be deleted.
10. **List of Employees**: filter by department, status, or type, and sort by clicking headers. Tick some rows → *ID Cards (A4)*. Fronts are on page 1 and backs (mirrored) on page 2, with a barcode on each back. Save as PDF.
11. *Print List* gives an A4 landscape list grouped by department with subtotals, a grand total, and Page X of Y. *Excel / CSV* opens in Excel with the Urdu intact.
12. **Shifts**: create 22:00–06:00 and see "Overnight" plus the net hours. A break longer than the shift is rejected.
13. **Shift Groups**: add a rotation (Day 7 days → Night 7 days) and tick rest-day overrides.
14. **Holidays**: switch year and add or edit a holiday. Change the weekly rest days and save.
15. **Company Settings**: edit the name (English and Urdu) and upload a logo. Both appear on reports and ID cards.
16. **Roles**: edit HR permissions (the Admin role is locked). **Users**: create a user and reset a password. You can't disable yourself or remove the last admin.
17. Log in as `operator/demo1234`. Employees are read-only, Save is disabled, and Users/Roles are hidden; opening `#/users` shows "no permission".
18. After 30 min idle you're returned to login. After 5 wrong passwords the login is locked for 15 min.
19. `curl -I /api/auth/me` shows `Cache-Control: no-store` and `X-LiteSpeed-Cache-Control: no-cache`.
20. `php tests/run.php` passes all tests.

## Notes and open questions

- **Allowances.** Salary Info stores a fixed monthly *allowances* amount, but the specified formula is `Gross = Work Pay + Overtime`, so allowances are **not** added to gross. Should allowances be added to gross, prorated by paid days, or only displayed? This is decided before batch 4.
- **Statutory rates and tax slabs** in `006_base_data.sql` are clearly marked *samples* (EOBI 1%/5% of minimum wage, PESSI/SESSI employer 6%, FY 2025-26 salaried slabs). They are effective-dated rows that admins can edit; check them against current notifications.
- Islamic holidays in the demo data are approximate (moon sighting).
- The default weekly rest day is **Sunday**. It can be changed under Holidays or Company Settings, and per shift group.
