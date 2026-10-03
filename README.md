# Payroll & HR Management System (Pakistan industrial / textile)

Web-based payroll and HR system for Pakistani factories. It rebuilds the workflow of the old Windows payroll app as a keyboard-first web app.

**Stack:** vanilla PHP 8.3+ (target 8.5, no framework, no Composer), PDO + MySQL/MariaDB (InnoDB, `utf8mb4_unicode_ci`), and a vanilla-JS SPA (hash routing, ES modules, no build step). It is designed for Hostinger shared hosting (LiteSpeed, no `exec`/`proc_open`).

## Delivery status

| Batch | Scope | Status |
|---|---|---|
| 1 | Schema + migrations, auth/roles, SPA shell, Setup module (Employee + photo, Department, Designation, Shift, Shift Group, Holidays/rest days, Company settings), Employee List report, ID cards | **Delivered** |
| 2 | Attendance: manual voucher, barcode kiosk, ZKTeco ADMS push + CSV/Excel import, daily post, OT approval, leave register, attendance reports, live TV screen | **Delivered** |
| 3 | Accounts vouchers + loan schedule + JV + voucher reports + DayBook | **Delivered** |
| 4 | PayrollEngine, salary sheets, posting/locking, payslips, salary reports, unit tests | **Delivered** |
| 5 | Dashboard, audit log viewer, rate settings, hardening, Hostinger deployment guide | **Delivered** |
| + | Salary increment module: single / bulk increments, effective-dated salary, pro-rata salary sheet, OT at the salary of each date, history + 2 reports (see below) | **Delivered** |
| ++ | Full-scope update: attendance day lock + admin unpost, net never negative (carry forward), salary unpost, weekly daily-wage sheets, Data Entry role, OT approval rules, print layouts (see below) | **Delivered** |

The **full database schema for every module** is already in place (`migrations/001`–`005`), so later batches only add code.

## Project layout

```
public/            web root: index.php (SPA shell), api.php, report.php, file.php, migrate.php, assets/
api/               router.php + controllers/ (one per module, CrudController base for masters)
app/               bootstrap, Config, Database, Auth, Validator, Audit, Storage, Settings, Permissions, Barcode, Reports/
migrations/        NNN_*.sql + migrate.php runner; seeds/ = demo data
storage/           local dev storage only — production points config storage_path OUTSIDE the deploy dir
tests/             php tests/run.php (no PHPUnit needed)
public/iclock.php  ZKTeco ADMS push endpoint (/iclock/cdata, /iclock/getrequest)
public/kiosk.php   barcode attendance kiosk (token link)
public/tv.php      live TV attendance screen (token link)
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

**Production on Hostinger: follow [DEPLOY.md](DEPLOY.md)** (upload, config outside `public_html`, migrations from the browser, devices, backups, security checklist).

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

## Batch 2 — Attendance

### How attendance flows

```
ZKTeco (push /iclock/cdata) ─┐
Barcode kiosk (kiosk.php) ───┼─► attendance_punches (raw, never edited) ─► Daily Attendance Post ─► attendance_daily ─► overtime (pending)
CSV / Excel / attlog.dat ────┘                                                    ▲                       ▲                 │
Manual Attendance Voucher (date + department grid) ───────────────────────────────┘ (source = manual)     │                 ▼
Approved leave (L / LW) ──────────────────────────────────────────────────────────────────────────────────┘     Overtime Approval → payroll (batch 4)
```

- **Real time.** Kiosk scans and device pushes post that employee's day immediately, so the TV screen is live. Daily Post is still the full, re-runnable job, e.g. for imported files and for marking absentees.
- **Idempotent.** Re-posting a range gives identical results. Manual rows (voucher or edited) are kept unless *overwrite manual* is ticked. Dates in a posted salary month are never changed.
- **Night shifts.** The punch window for a date runs from shift start − 4 h to shift end + 6 h. It is trimmed so it never overlaps the previous working day's shift end or the next working day's shift start, so a 20:00–08:00 shift picks up next-morning punches. First punch = In, last punch = Out, and each punch is used for one date only.

### Calculation rules (engine: `app/AttendanceEngine.php`, covered by `tests/AttendanceTest.php`)

| Item | Rule |
|---|---|
| Working hours | Always Out − In (never typed). The shift break is deducted when the stay exceeds half the shift span. |
| Validation | Time Out earlier than Time In = a night shift crossing midnight (Out moves to the next day); Out equal to In is rejected; over 24 h is rejected. *(Changed in the full-scope update; previously only overnight shifts could cross midnight.)* Over *max daily hours* (setting, default 16) is accepted but flagged. A single punch is flagged "Missing time out" and no hours are invented. |
| Late | Minutes after shift start, counted only when beyond the shift's grace minutes. |
| Early | Minutes before shift end. |
| OT candidate | Minutes after shift end, when ≥ the shift's *min OT*. On rest days and holidays, all worked time counts. Candidates arrive *Pending*. Approve, reject, or edit the hours in Overtime Approval. Only approved OT will reach payroll. |
| Half day | Worked minutes below the shift's *half-day threshold* → HD. |
| No punch | Holiday → H, weekly rest day → R, approved leave → L (paid type) / LW (unpaid type), otherwise A. Today is posted only for people who have already punched. |
| Employment period | Nothing can be marked before the joining date or after the leaving date, or on a future date. |
| Duplicates | One row per employee per date (unique key). Re-importing the same punches is ignored. |
| Leave | Days counted = working days only. Overlapping applications are refused. Paid types with a yearly quota are checked against the balance (pending + approved). Approve marks those working days L/LW. Days already worked keep P and get flagged. Cancel re-posts those days. |

### Devices, kiosk and TV

- **ZKTeco push.** On the device, go to *Comm → Cloud Server Setting*: server = your domain, port 80, Domain-name mode on. An unknown serial number registers itself as *inactive*. Its logs are refused, and the device keeps and retries them, until you tick *Active* under **Attendance → Devices, Kiosk & TV**. Enter each employee's enrollment number as **Machine ID**. Punches from IDs that aren't linked yet are kept and linked on the next post.
- **Kiosk and TV** are opened with secret links (shown on the same screen, *Regenerate* to revoke), so they never hit the 30-min login timeout. The kiosk works with any USB barcode scanner (Code 128 on the ID card back). A repeat scan within 60 s is ignored.
- **Hostinger note.** Most ZKTeco models push over plain HTTP, so don't force an HTTPS redirect on `/iclock/*` (the rule in `public/.htaccess` already leaves it alone).

### API endpoints added in batch 2

| Method | Path | Permission |
|---|---|---|
| GET | `/api/attendance/vouchers?from=&to=` | attendance.view |
| GET | `/api/attendance/vouchers/load?date=&department_id=` | attendance.view |
| POST | `/api/attendance/vouchers` `{vr_date, department_id, remarks, rows:[{employee_id,status,shift_id,time_in,time_out,remarks}], delete_ids:[]}` | attendance.add |
| DELETE | `/api/attendance/vouchers/{id}` | attendance.delete |
| POST | `/api/attendance/post` `{from, to, department_id?, overwrite_manual?}` (max 31 days) | attendance_post.post |
| GET | `/api/attendance/punch-status` (pending dates, unmapped machine IDs) | attendance_post.view |
| GET | `/api/attendance/daily?from=&to=&department_id=&employee_id=&filter=exceptions\|flagged\|late\|absent\|all` | attendance.view |
| PUT / DELETE | `/api/attendance/daily/{id}` | attendance.edit / .delete |
| GET | `/api/attendance/punches?employee_id=&date=` | attendance.view |
| POST | `/api/attendance/import` (multipart `file`, `date_format=auto\|dmy\|mdy`) | attendance.add |
| GET | `/api/attendance/live` | attendance.view |
| GET / POST | `/api/attendance/screens` · `/api/attendance/screens/regenerate {which: kiosk\|tv}` | devices.view / devices.edit |
| GET / POST / DELETE | `/api/overtime?from=&to=&department_id=&status=` · `/api/overtime` (manual) · `/api/overtime/{id}` | overtime.view / add / delete |
| POST | `/api/overtime/decide` `{items:[{id, status, approved_minutes, remarks}]}` | overtime.post |
| CRUD | `/api/leaves?year=&status=&q=` · `/api/leave-types` · `/api/devices` | leave.* / devices.* |
| POST | `/api/leaves/{id}/status` `{status: approved\|rejected\|cancelled}` | leave.post |
| GET | `/api/leaves/balance?employee_id=&year=` | leave.view |
| GET | `/api/employees/lookup?code=` | logged in |
| GET/POST | `/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd` | device serial number (active devices only) |
| GET/POST | `/kiosk.php?token=` · `/tv.php?token=[&data=1]` | secret token |
| GET | `report.php?r=daily_attendance \| monthly_attendance \| employee_attendance \| shift_attendance \| overtime \| late_comers \| leave_register` (+ `&format=csv`) | attendance.print / overtime.print / leave.print |

### Manual test checklist (batch 2)

1. Run `php migrations/migrate.php --seed`. Under **Daily Attendance Post** choose 01-09-2026 → 01-10-2026 and press **F10**. About 340 rows are posted. Re-post: the results are identical, and manual rows show as *kept*.
2. **Review & fix** lists the open exceptions: the 01-10 night shift still in progress, and employee 0009, who forgot to punch out. Double-click 0009 and enter Out 17:45. Hours and OT are recalculated, and the row becomes manual.
3. **Attendance Voucher**: date 30-09-2026, Stitching, **F7**. Change a status and press **F10** → Vr# assigned. Enter Time In 20:00, Out 08:00 on a day-shift employee: it's rejected. On a night shift it's accepted as next day. Try a date before 0012's joining date (14-09-2026): it's rejected. PgUp/PgDn moves the date; **F1** lists vouchers; **F9** prints the Daily Attendance Report.
4. **Overtime Approval** shows the pending candidates. Edit one to 1:00, tick rows, and Approve/Reject. Approving with 0:00 is refused. *Manual OT* is only allowed on a day the employee was present.
5. **Leave Register**: employee 0007, CL, 28-09 → 02-10 gives 5 working days and the balance updates. An overlapping application is refused. Sick leave over the 8-day quota is refused. Approve: absent days become L. Cancel: those days are re-posted.
6. **Machine Log Import**: upload a CSV with `AC-No., Name, Time` (or `attlog.dat`, or `.xlsx`). It shows new / duplicate / unknown-ID / error counts. Importing again shows them all as duplicates.
7. **Devices, Kiosk & TV**: open the kiosk link and type `0002` + Enter → IN with name, Urdu name, and late or on-time. Scan again within 60 s → "already scanned". Unknown card → error. Open the TV link: department counts plus the latest punch.
8. ZKTeco push without a device:
   `curl "http://HOST/iclock/cdata?SN=TEST1&options=all"` (handshake). Then
   `printf '3\t2026-10-02 08:02:11\t0\t1\n' | curl --data-binary @- "http://HOST/iclock/cdata?SN=TEST1&table=ATTLOG&Stamp=1"`
   → refused until you activate TEST1 in Devices, then `OK: 1`.
9. Reports: the **Monthly Attendance Sheet** for 2026-09 (A4 landscape, 30 days with weekday headers, totals, department present row, page X of Y). Also check the employee-wise report for 0002 (night shifts show "+1"), the daily, shift-wise, late-comers, overtime (detail/summary) and leave register reports, plus each CSV export.
10. As `operator`: attendance screens work, but Overtime approve/reject is disabled. As `hr`: approve works.
11. `php tests/run.php` → 20 passed.

### Batch 2 decisions to confirm

- **Half day (HD) in payroll.** Decided: no fixed ½ day. Short days are paid on the actual hours logged (see *Payroll decisions* below).
- **Break deduction.** The break is deducted only when the stay exceeds half the shift span.
- **Rest-day / holiday work.** All worked time is an OT candidate, and the day stays R/H (still paid as rest/holiday).
- **Joining day.** The joining date shows **S** when the employee punched, and **A** when they didn't.
- **Overtime approval.** HR approves by default (granted in `008_attendance_permissions.sql`). Change this in Roles & Permissions if a separate supervisor role is wanted.

## Batch 3 — Accounts

### Vouchers

| Voucher | Purpose | On posting | Used by payroll (batch 4) |
|---|---|---|---|
| **Advance** (ADV) | Salary advance paid to an employee | Dr Employee Advances / Cr Cash or Bank (*Paid from*) | Deducted **in full** from the salary of its *salary month* |
| **Loan** (LOAN) | Amount, monthly installment, first deduction month → installment schedule | Dr Employee Loans / Cr Cash or Bank | The installment due that month is deducted; the remaining balance is tracked |
| **Incentive** (INC) | Bonus / incentive | — (booked in the salary JV) | Added to that month's salary |
| **Penalty** (PEN) | Fine / penalty | — (booked in the salary JV) | Deducted from that month's salary |
| **Overtime** (OT) | Extra OT hours (paid at the employee's OT rate) and/or a fixed amount | — (booked in the salary JV) | Added to that month's OT |
| **Journal** (JV) | Free double entry; salary posting will create system JVs | Lines must balance (Dr = Cr), checked on save and on post | — |

- **Life cycle.** A **Draft** can be edited or deleted. **Post** locks it, and only posted vouchers reach payroll. **Unpost** is allowed only while the voucher is not used in a salary sheet, its salary month is not posted, and (for loans) no installment has been deducted. Deleting a posted voucher is a **soft delete**: it is hidden everywhere but kept in the audit trail.
- **Numbering.** Each type has its own sequence: `ADV-0001`, `LN-0001`, `INC-…`, `PEN-…`, `OT-…`, `JV-…`.
- **Amounts** are whole rupees. The employee must be employed on the voucher date. The salary month can't be before the voucher month, and can't be a month whose salary is already posted.
- **Loan schedule.** There are *n* equal installments with the remainder in the last one. **Skip** a month and the balance moves to the end. **Adjust** a month to any amount up to the remaining balance and the rest is re-spread. **Reset** undoes either. Deducted months are locked. Because the schedule is rebuilt around deducted, adjusted and skipped months, a short deduction (salary too low) also rolls forward automatically. Covered by `tests/AccountsTest.php`.
- **Chart of accounts.** Codes 1001–5003 are seeded. Accounts with a *system key* (cash, bank, employee advances/loans, salary payable, EOBI/SS/tax payable, expenses) are used by automatic postings and can't be deleted or deactivated.

### Reports

All have Print/PDF and Excel/CSV. **Advance Salary**, **Incentive**, **Penalty** and **Overtime voucher** reports are grouped by department with totals, filtered by salary month or date range. **Loan Report** lists outstanding balances, next due month and installments left, optionally with each schedule. **JV Report** shows lines, totals and an account filter. **Day Book** shows every voucher by date, with journal lines for ADV/LOAN/JV and salary adjustments for INC/PEN/OT, plus day totals and a summary by type. The **Voucher slip** (F9 on any voucher) prints the amount in figures and in words (lakh/crore) with signature blocks, and includes the repayment schedule for loans and the lines for JVs.

### API endpoints added in batch 3

| Method | Path | Permission |
|---|---|---|
| GET | `/api/vouchers/{adv\|inc\|pen\|ot}?month=&from=&to=&status=&q=&employee_id=` · `/api/vouchers/{type}/{id}` | vouchers.view |
| POST / PUT | `/api/vouchers/{type}` · `/api/vouchers/{type}/{id}` `{vr_date, employee_id, deduct_month (YYYY-MM), amount, ot_hours?, pay_account_id?, remarks, post?}` | vouchers.add / edit |
| GET | `/api/loans?status=&q=` · `/api/loans/{voucher id}` (summary, installments, journal) | loans.view |
| POST / PUT | `/api/loans` · `/api/loans/{id}` `{vr_date, employee_id, amount, installment, start_month, pay_account_id, remarks, post?}` | loans.add / edit |
| POST | `/api/loans/{id}/installments/{iid}` `{action: skip\|adjust\|reset, amount?}` | loans.edit |
| GET / POST / PUT | `/api/journal` · `/api/journal/{id}` `{vr_date, remarks, lines:[{account_id, employee_id?, debit, credit, narration}], post?}` | journal.* |
| POST | `/api/voucher-actions/{id}/post` · `/api/voucher-actions/{id}/unpost` | `<type module>.post` |
| DELETE | `/api/voucher-actions/{id}` (draft: delete, posted: soft delete) | `<type module>.delete` |
| GET | `/api/voucher-nav/{TYPE}?vr_no=&dir=prev\|next` | `<type module>.view` |
| CRUD | `/api/accounts` | journal.* |
| GET | `report.php?r=vouchers&type=ADV\|INC\|PEN\|OT` · `r=loans` · `r=journal` · `r=daybook` · `r=voucher&id=` | vouchers / loans / journal .print |

### Manual test checklist (batch 3)

1. Run `php migrations/migrate.php --seed`. The demo includes 3 advances, 2 incentives, 1 penalty, 1 OT voucher, 2 loans and 1 JV.
2. **Advance Voucher**: F5, employee code `0006` + Enter, amount 7500, then *Save & Post*. You get `ADV-0005`, posted. Edit is disabled and **Unpost** re-enables it. A decimal amount (50.5) is rejected. **F9** prints the slip with "Rupees Seven Thousand Five Hundred Only".
3. **Loan Voucher**: open `LN-0002`. Skip Oct 2026 and the balance moves to Apr/May 2027. Adjust Dec to 10,000 and later months are re-spread. Adjust to more than the balance and it's refused. Reset puts the month back. A new loan of 10,000 at 3,000 previews "4 installment(s), last Rs 1,000".
4. **Journal Voucher**: two lines with 1,200 Dr / 1,000 Cr show "Difference 200.00 Dr" and saving is refused. Fix the credit to 1,200 and *Save & Post*.
5. **Incentive / Penalty / Overtime vouchers**: pick a salary month and post. The OT voucher accepts hours only, a fixed amount only, or both.
6. **Chart of Accounts**: deleting `1001 Cash in Hand` is refused (system account). A new account can be added and deleted while it has no entries.
7. Delete a posted advance → soft delete: it disappears from lists and reports, and the deletion is recorded in `audit_log` (the viewer arrives in batch 5).
8. Reports → Accounts: **Day Book** for 01-09-2026 → today (debits = credits, salary adjustments in their own column), **Loan Report** with schedule, Advance/Incentive/Penalty reports for Sep 2026, JV report.
9. As `hr`: vouchers and loans are view/print only. As `accounts`: everything in Accounts.
10. `php tests/run.php` → 26 passed.

## Batch 4 — Payroll

### Workflow (Payroll → Salary Sheet — Permanent / Daily Wages)

1. Choose **From / To** (defaults to the previous month; any period of up to 31 days, e.g. 26th–25th). The salary month is the month of **To**.
2. **Show (F7)** computes every employee from attendance, approved overtime, posted vouchers and loan installments. Nothing is written.
3. Review. Enter **Fine** and **Remarks** per row (Enter / ↓ moves to the next row). Rows with warnings show ⚠ (hover for details). Net is never negative (see the full-scope section).
4. **Save (F10)** stores a **draft** (one per month for Permanent; Daily Wages can be weekly / fortnightly / monthly). Show again at any time to recalculate; saved fines and remarks are kept.
5. **Post & Lock** recalculates and compares with the saved draft. If attendance, overtime or vouchers changed in the meantime it refuses with "press Show and Save again". Otherwise it:
   - marks the vouchers, overtime rows and loan installments as consumed by the sheet (a short installment is carried forward and the loan is re-scheduled);
   - creates the system **salary JV**: Dr Salaries (work pay + allowances), Overtime, Incentives / Cr Employee Advances, Employee Loans, Penalty income (penalties + fines), EOBI payable, PESSI/SESSI payable, Income tax payable, Salaries payable (net). It always balances;
   - locks the period. Attendance, vouchers, OT approval and leave for that period and employee type can no longer change. A posted sheet can't be edited, re-saved or deleted; only its **Paid Date** can still be set.
6. **F9** prints the salary sheet. Payslips, Bank List and Department Summary are buttons on the same toolbar, and also under Reports → Payroll.

**Sheet types.** The *Permanent* sheet covers permanent and contract employees; *Daily Wages* covers daily-wage employees. Each locks only its own employee types.

### Calculation rules (`app/PayrollEngine.php`, pure, covered by `tests/PayrollEngineTest.php`)

| Item | Rule |
|---|---|
| Days in month | Days in the selected period (`salary_day_basis` = `calendar`; `fixed30` / `fixed26` also supported) |
| Work days | P / S = 1; **HD = worked minutes ÷ shift net minutes** (max 1, actual hours, no fixed ½) |
| Rest days | R + paid holidays (H) |
| Paid days (permanent) | Calendar basis: Work + Rest + Paid leave (L), capped at days in month. Fixed 30 / 26 basis: Days − unpaid days (absent, leave without pay, unmarked, the unworked part of half days, days not employed), so a full month always earns the full basic |
| Work Pay | `round(Basic ÷ Days × Paid days)`; Allowance pay = `round(Allowances ÷ Days × Paid days)` |
| Daily wages | Pay = `round(Daily rate × Work days)`; rest days and leave are not paid; allowances prorate on work days |
| OT rate | Employee's fixed OT rate, else `Basic ÷ Days ÷ Shift hours × OT multiplier` (daily: `Rate ÷ Shift hours × multiplier`) |
| OT amount | `round(OT hours × OT rate)` + fixed OT-voucher amounts. OT hours = approved OT + OT-voucher hours. Employees without OT: not paid, with a warning |
| Gross | Work Pay + Allowance pay + OT |
| EOBI / PESSI / SESSI | Employee share from `statutory_rates` effective on the period end (only when applicable on the employee) |
| Income tax | `tax_slabs` effective on the period end: annual tax on (Gross + Incentive) × 12, ÷ 12 |
| Net | Gross + Incentive − Advance − Loan − Penalty − Fine − EOBI − PESSI − Tax |
| Rounding | Whole rupees using the company rounding rule (half up by default; up / down available) |

Every verified example from the specification is a unit test: 4,500 · 3,929 · 5,357 · 4,685 · 7,131 · OT 75/h → 750 · daily wages 33,000 + 750.

**Assumptions (please confirm or correct):**
- The salary rate is the salary-info record effective on the **last day** of the period. A mid-period increment is not split.
- **Unmarked days** (employed, no attendance row) are unpaid and flagged. Post attendance before running payroll.
- A **half day without times** pays 0 hours and is flagged (enter the times in attendance).
- *(Superseded by the full-scope update.)* Net is never negative: the loan installment is reduced first and its balance rescheduled; then the advance, penalty and fine that the salary can't cover are carried forward to the next period as system vouchers.
- Income tax is annualised from the month's salary, with no year-to-date reconciliation. The JV books only the **employee share** of EOBI / PESSI (the employer share is a separate challan entry).
- **Fine** is entered on the salary sheet. **Penalty** comes from posted penalty vouchers.
- *(Superseded.)* An administrator can unpost the latest posted sheet, with a reason; it is audit-logged.

### Reports (Print / PDF; CSV where noted)

- **Salary Sheet** (CSV). A4 landscape, every column from the spec, grouped by department with sub-totals, grand total, paid date, page X of Y and a signature column. Work Pay includes prorated allowances, so each row adds up.
- **Payslips**. English / Urdu, two per A4 page: attendance, earnings, deductions, loan balance, net in figures and words, signatures. Filter by department, or `employee_id` for one employee.
- **Bank Transfer List** (CSV). Employees paid by bank, with CNIC, bank, account (missing accounts flagged), total in words.
- **Department Salary Summary** (CSV). Head count, earnings, each deduction, net and the cash/bank split per department.

### API endpoints added in batch 4

| Method | Path | Permission |
|---|---|---|
| GET | `/api/salary/sheets?type=&year=` | salary.view |
| GET | `/api/salary/preview?type=permanent\|daily_wages&from=&to=` (computes; a posted month returns the stored sheet) | salary.view |
| GET | `/api/salary/sheets/{id}` | salary.view |
| POST | `/api/salary/sheets` `{sheet_type, period_from, period_to, paid_date?, remarks?, lines:[{employee_id, fine, remarks}]}` (save draft) | salary.add |
| POST | `/api/salary/sheets/{id}/post` `{paid_date?}` | salary.post |
| PUT | `/api/salary/sheets/{id}/paid-date` `{paid_date}` | salary.edit |
| DELETE | `/api/salary/sheets/{id}` (draft only) | salary.delete |
| GET | `report.php?r=salary_sheet\|payslips\|salary_bank\|salary_departments&id=` (`&department_id=`, `&employee_id=`) | salary.print |

Migration `010_payroll_lines.sql` makes day counts fractional, adds allowance, holiday, unmarked and warning columns, adds the `salary_sheet_loans` table, and gives HR salary view/print.

### Manual test checklist (batch 4)

1. Run `php migrations/migrate.php --seed` (applies 010), then `php tests/run.php` → 42 passed.
2. **Salary Sheet — Permanent**, 01-09-2026 → 30-09-2026, **F7**. You get 12 employees grouped by department. Check:
   - `0011` OT 6 h × 714.29 = 4,286 (OT voucher, 7-hour shift);
   - `0005` incentive 6,774 and loan 2,000 (balance 10,000);
   - `0003` advance 5,000; `0009` advance 3,000; `0006` penalty 500;
   - half days paid by hours (e.g. `0006` 22.42 work days).
3. Type a fine of 300 for `0004`. Net and grand total update immediately. **F10** → "Draft saved".
4. Change attendance (or post a new incentive) for a September employee, then press Post → refused with "press Show and Save again". Show, Save, then **Post & Lock** and confirm.
5. After posting:
   - the vouchers show as used (Unpost refused) and `LN-0001` Sep is deducted;
   - Journal Voucher has a new system JV for "Permanent salary September 2026" with Dr = Cr;
   - editing September attendance for a permanent employee → "belongs to a posted salary month";
   - a new advance for September is refused.
6. Show again → "posted and locked", and the grid is read only. Save, Post and Delete are disabled; the Paid Date can still be changed.
7. **F9** Salary Sheet: landscape, department sub-totals, grand total, page X of Y. **Payslips**: 2 per page, Urdu labels and amount in words. **Bank List**: `0001`, `0002`, `0011`. **Dept. Summary**: totals equal the sheet.
8. **Daily Wages** sheet for September: 3 employees, Pay = rate × work days. Rest days are not paid.
9. Try an overlapping period (26-09 → 25-10) for Permanent → refused.
10. As `hr`: view and print only (no Save / Post). As `accounts`: full access.

## Batch 5 — Dashboard, audit, rates, hardening, deployment

### What was added

- **Dashboard.** Every section is shown only to users who may see that module.
  - Headcount and today's attendance.
  - **Attendance for the last 14 days:** stacked bars with a hover tooltip, a legend and a *Table* toggle.
  - **Needs attention:** punches not posted, unknown machine IDs, overtime to approve, pending leave, draft vouchers and draft salary sheets. Each is a link to its screen.
  - Salary sheets of the last 6 months, loans outstanding, this month's vouchers, employees by department and upcoming holidays.
- **EOBI / PESSI & Tax Slabs** (Setup).
  - Effective-dated statutory rates: method, employee and employer share, minimum wage, wage ceiling.
  - Income tax slab sets per tax year, with *Copy as new year*.
  - Slabs are validated: they start at 0, are continuous, and only the last one is open-ended (`app/Rates.php`, `tests/RatesTest.php`).
  - **Locking:** a rate or slab set is locked once a salary sheet that covers its effective date has been posted while the row existed. Add a new row instead. New rows may be back-dated (late notifications); they apply to sheets not yet posted, and posted sheets keep their stored amounts.
- **Company Settings** now also has salary **rounding** (half up / up / down), the **OT multiplier** and the **default shift hours** used for the OT rate.
- **Audit Log** (Administration).
  - Filter by date, user, record type, action, and free text in the values or IP.
  - 100 entries per page; PgUp/PgDn change pages.
  - Double-click an entry to see the changed fields side by side (before / after).
  - *Login attempts* lists the last 30 days of successful and failed logins.
- **System Health** (Administration, admins).
  - Checks: PHP version and extensions, HTTPS, debug, setup key, storage writable / outside the web root / outside the deploy folder, DB version, time zone, pending migrations, default admin password, upload limits, table sizes.
  - **Download database backup** (`backup.php`): a gzip SQL dump in pure PHP, streamed table by table. Admins only, and audit-logged. Verified by restoring into an empty database with identical table checksums.
- **Deployment guide:** [DEPLOY.md](DEPLOY.md).

### Hardening

- **Content-Security-Policy.**
  - The SPA allows only same-origin scripts plus a per-request nonce for its one inline script.
  - Print, kiosk and TV pages allow inline scripts but nothing external.
  - JSON responses send `default-src 'none'`.
  - Also sent: `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and HSTS on HTTPS.
- The DOM helper no longer accepts raw HTML (`html:`) or inline `on…=` handler strings. All text is inserted as text.
- JSON request bodies are capped at 4 MB (413).
- Auto-registration of unknown ZKTeco serial numbers is capped (10 new inactive devices per day; serials up to 40 characters).
- **Config location.** Config can live in `../payroll-config.php`, outside the deploy folder, so Git redeploys can't wipe it or expose it. Storage should also live outside, and System Health warns if it doesn't.
- Removed two files committed by mistake (an empty curl cookie file `-b`, and a Python wheel).
- **Already in place from batch 1:**
  - Login throttling (5 attempts per user + IP in 15 minutes) and session regeneration on login.
  - HttpOnly / SameSite / Secure cookies, idle timeout, CSRF on every write.
  - Prepared statements everywhere; uploads stored outside the web root and served through PHP.
  - Root and folder `.htaccess` deny rules; `Cache-Control: no-store` on the API.

### API endpoints added in batch 5

| Method | Path | Permission |
|---|---|---|
| GET | `/api/dashboard/summary` (now with trend, pending, payroll, loans) | dashboard.view (+ module view per section) |
| GET | `/api/rates` → `{locked_until, statutory, tax_sets}` | settings.view |
| POST / PUT / DELETE | `/api/rates/statutory` · `/api/rates/statutory/{id}` `{code, effective_from, calc_method, employee_share, employer_share, min_wage?, wage_ceiling?, remarks?}` | settings.edit |
| PUT | `/api/rates/tax-slabs` `{tax_year, effective_from, original_effective_from?, slabs:[{income_from, income_to\|null, fixed_amount, rate_percent}]}` | settings.edit |
| DELETE | `/api/rates/tax-slabs?effective_from=` | settings.edit |
| GET | `/api/audit?from=&to=&user_id=&entity=&action=&entity_id=&q=&page=` · `/api/audit/{id}` · `/api/audit/facets` · `/api/audit/logins` | audit.view |
| GET | `/api/system/status` | settings.edit |
| GET | `backup.php` (download `.sql.gz`) | settings.edit |

### Manual test checklist (batch 5)

1. `php tests/run.php` → 47 passed.
2. **Dashboard** as admin:
   - 14 bars; hovering a bar shows the day's present / absent / leave / late, and *Table* shows the same numbers.
   - *Needs attention* lists unposted punches and draft vouchers, and each item opens its screen.
   - Log in as `operator`: only the attendance parts are shown (payroll, loans and voucher panels are hidden).
3. **Rates.** With September salary posted:
   - editing or deleting the 2025-07-01 EOBI row or the 2025-26 slabs is refused with the name of the posted period;
   - *New rate* EOBI from 01-10-2026 with minimum wage 42,000 saves, and without a minimum wage it is refused;
   - a slab set with a gap (0–600,000 then 700,000–) is refused, saying which boundary is wrong;
   - *Copy as new year* → 2026-27 from 01-07-2026 saves, and can be edited and deleted while no posted salary used it.
4. **Company Settings:** change the OT multiplier to 1.5 → Show (F7) on a month that is **not posted** uses the new OT rate (October, `0011`: 75,000 ÷ 31 ÷ 7 × 1.5 = 518.43). Posted months keep their stored amounts. Set it back to 2.
5. **Audit Log:**
   - the changes from steps 3–4 appear, and double-click shows before/after;
   - filter by user, record type `statutory_rates` and action;
   - *Login attempts* shows a failed login you made on purpose;
   - as `hr`, the menu item is hidden and `/api/audit` returns 403.
6. **System Health:** locally, *Debug* shows ✕ when `debug` is true. **Download database backup** produces `payroll-backup-….sql.gz`; importing it into an empty database gives the same data.
7. View the page source of the app: the response has a `Content-Security-Policy` header with a nonce. The browser console shows no CSP errors on the dashboard, employee photo cropper, reports, kiosk and TV.
8. Follow DEPLOY.md on a Hostinger test subdomain: `/app/`, `/migrations/` and `/config.php` return 403; `migrate.php?key=` works until the key is cleared.

## Final review fixes (after batch 5)

An independent security review and a payroll-correctness review of the whole system found the issues below. All are fixed and re-tested through the API on a fresh database.

**Security**
- **Privilege escalation through users and roles.** A non-admin with user or role rights can no longer:
  - assign the Admin role, or edit, reset or delete an admin user;
  - edit their own role, or grant permissions they don't hold themselves (`Auth::assertCanGrantRole`, `Auth::holdsAll`).
- **"Save & Post" now needs the post permission** (vouchers, loans, journal). Without it, the request is refused and nothing is saved.
- **Attendance voucher.** Overwriting an existing day needs `attendance.edit`; removing rows needs `attendance.delete`.
- **ZKTeco push.**
  - Optional **Allowed internet IP(s)** per device, plus a *Last IP* column on the device list (the serial number alone is not a secret).
  - Punches dated more than 1 hour in the future are dropped.
- **Login throttling** is per user + IP, per IP across all usernames (password spraying) and per username across all IPs. The attempt is recorded before checking, which closes the race on parallel requests.
- **Sessions end when a password changes** (own change or admin reset): `users.session_version`, migration 011.
- **Backup download and System Health are admin-only.** The dump contains password hashes and every salary.
- **The printed-by name** on reports is HTML-escaped, and CSS-escaped inside the `@page` rule.

**Payroll**
- **Employee type change.** The lock now applies **per employee** too: dates and salary months on a posted sheet where the employee has a line stay locked, whatever the current type. A new sheet skips days already paid on another posted sheet (warning shown), so nothing is paid twice.
- **Salary-month locks** (vouchers, loan installments) compare the posted sheet's **salary month** (`PayrollLock::isMonthLocked`), so a short first period (e.g. 10th–30th) also locks its month's vouchers.
- **Vouchers for employees not on the sheet** (joined after the period, left, inactive) block posting, with a list to correct. Due loan installments of such employees are marked *skipped* and their balance moves to later months.
- **Loan reschedule never puts a balance into a month whose salary is already posted.**
- **Fixed 30 / 26-day basis** now deducts only unpaid days from the fixed divisor (see the table above). Before, a full February paid 28/30 and absences could be hidden by the cap.
- **A negative net** is debited to Employee Advances instead of reducing other employees' payable. The JV still balances.
- **OT vouchers** of employees without OT are no longer consumed (they stay open for correction, like approved OT rows).
- **Posting consumes vouchers and OT with guarded updates** (`salary_sheet_id IS NULL`, still posted / approved). A concurrent change makes posting stop instead of silently using stale data.

Tests: `php tests/run.php` → 49 passed (adds the fixed-basis cases).

## Salary increment module

Admins enter every increment by hand; nothing is applied automatically. Increments can be **percentage**, **fixed amount** or a **direct new salary**, and each takes effect from an effective date. Payroll and overtime always price a date with the salary effective on that date.

### How it works

- **One source for the pay rate.** `salary_increments` holds the rate over time: the monthly basic for permanent and contract staff, and the rate per day for daily wages. `App\Increments::getSalaryOnDate($employeeId, $date): string` returns the latest `new_salary` with `effective_date <= $date` (ties go to the highest `id`), as a decimal string. Payroll calls it through a per-request cache, so a whole sheet costs one query.
- **Other salary terms stay where they were.** `employee_salary_history` still holds allowances, OT applicability and the fixed OT rate, the EOBI / PESSI / tax flags, and the payment mode and bank. Its `basic_salary` and `daily_rate` columns are no longer read by payroll. New records store a snapshot of the increment rate there.
- **`employees.basic_salary`** (new column) is a cached copy of the salary effective **today**. It is refreshed after every increment write and once a day: the first API request of the day, or the optional cron `tools/sync_salaries.php`. A future increment therefore doesn't change it until its date.
- **Calculation.** New salary = old + old × % / 100, or old + amount, or the value itself. It is rounded half up to a whole rupee. The value must be > 0 and the new salary must be > 0. All increment, pro-rata and OT arithmetic uses integer paisa (`App\Money::toPaisa / divRound`), never float.
- **Date rules.**
  - The effective date defaults to today (Asia/Karachi). It must be after the joining date and not after the leaving date.
  - **Future** dates are allowed. The increment shows as *Scheduled* until its date.
  - **Past** dates are allowed only if no salary sheet with this employee is posted for that month or any later month. Arrears are not calculated.
  - Only one increment per employee per date.
  - A new increment must be dated **after** the employee's latest one. To add an earlier one, delete the later one first. This keeps `old_salary` correct.
- **Pro-rata.** When an effective date falls inside a salary period, the period is split into segments. Each segment pays `segment salary ÷ days in month × paid days in that segment`. Absent days, leave, half days and unmarked days are counted per segment. Fines are still one amount per row.
  - On the fixed 30 / 26-day basis, the last segment absorbs the difference between the divisor and the calendar length, so a full month still pays exactly the blended salary.
  - Daily wages pay each segment's rate × its present days.
  - The row gets **▲ inc** on screen (hover for the split) and **▲** plus a footnote on the printed sheet. The split is stored in `salary_sheet_lines.increment_note`.
- **Overtime.** Each approved OT row is priced with the salary effective on its `ot_date`, and each OT-voucher hour with the salary on its voucher date. The rate is `salary ÷ (days in month × shift hours) × multiplier` (daily wages: `rate ÷ shift hours × multiplier`). The multiplier comes from Company Settings → *Overtime multiplier* (1, 1.5, 2…). If OT falls on both sides of an increment, the sheet shows a blended rate (so hours × rate = amount), and the note lists each rate. An employee's fixed OT rate, if set, still overrides all of this.
- **Deleting.**
  - Only the employee's latest increment can be deleted, and never the joining row.
  - It can't be deleted if a salary sheet is posted for its month or later.
  - `employees.basic_salary` is recalculated afterwards.
  - There is no edit. To correct an increment, delete it and add it again.
- **Permissions.**
  - Add, bulk-apply and delete: admin-role users only (the router's `'admin'` permission).
  - History and both reports: anyone with `employees.view` / `employees.print`.
  - Every write is in a DB transaction and audit-logged (`salary_increments` create / delete / bulk; joining-row moves).

### Screens

- **Payroll → Salary Increment** (`#/increments[/{employee id}]`): pick the employee (code + Enter, or F2).
  - The screen shows the current salary and any scheduled increments.
  - Choose the type, value, effective date, approver and reason. A live server preview shows old salary → new salary, the change and %, Applied / Scheduled, and any rule that blocks it. **F10** saves.
  - The history grid below has *Delete* on the latest row. **F9** prints the employee's history.
- **Payroll → Bulk Increment** (`#/increments/bulk`, admins only): choose a department or shift group, optionally monthly or daily-wages staff only, then a percentage or fixed amount, date and reason.
  - **Preview (F7)** lists every employee with old / new salary. Employees who fail a rule are greyed out with the reason.
  - Untick employees to exclude them, then **Confirm & Apply (F10)**.
  - Everything is saved in one transaction: if any ticked employee fails a rule at save time, nothing is saved.
- **Employee Info → Increment History** tab: date, type, value, old / new salary, reason, approved by, created by, and status (Applied / Scheduled, plus *Posted* when locked).
- **Reports → Employees:**
  - **Increment Register:** date range and department; grouped by department, with old vs new salary cost per department and in total; CSV.
  - **Employee Increment History:** one employee's timeline from joining, with current, joining and scheduled salary; CSV.

### API endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/api/employees/{id}/increments` → `{employee (current_salary), rows}` | employees.view |
| GET | `/api/increments/meta` → approvers, `can_manage` | employees.view |
| GET | `/api/increments/preview?employee_id=&increment_type=&increment_value=&effective_date=` | admin |
| POST | `/api/increments` `{employee_id, increment_type: percentage\|fixed\|new_salary, increment_value: "10.5", effective_date, reason?, approved_by?}` | admin |
| POST | `/api/increments/bulk/preview` `{scope: department\|shift_group, scope_id, emp_group?: monthly\|daily, increment_type: percentage\|fixed, increment_value, effective_date}` | admin |
| POST | `/api/increments/bulk` (same + `employee_ids: [...]` = the ticked employees, `reason?`, `approved_by?`) | admin |
| DELETE | `/api/increments/{id}` | admin |
| GET | `report.php?r=increment_register&from=&to=&department_id=&include_joining=1` · `r=employee_increments&employee_id=\|code=` (+ `&format=csv`) | employees.print |

### Files

**New**
- `migrations/012_salary_increments.sql`: the table (spec DDL with `INT UNSIGNED` + foreign keys to match `employees` / `users`); backfill from salary history; `employees.basic_salary`; `salary_sheet_lines.increment_note`.
- `migrations/seeds/120_demo_increments.sql`: the same backfill for the demo seed, which loads employees after 012.
- `app/Increments.php`: `getSalaryOnDate`, segments, formulas, date rules, add / bulk / delete, `basic_salary` sync.
- `api/controllers/IncrementController.php`
- `app/Reports/IncrementRegisterReport.php`, `app/Reports/EmployeeIncrementReport.php`
- `public/assets/js/pages/increments.js`: single and bulk screens, plus the shared history grid.
- `tools/sync_salaries.php`: optional hPanel cron.
- `tests/IncrementsTest.php`

**Changed**
- `app/Money.php`: integer-paisa helpers (`toPaisa`, `fromPaisa`, `divRound`, `roundRupees`).
- `app/PayrollEngine.php`: optional `segments` (pro-rata) and `ot_items` (per-date OT pricing) inputs, computed in paisa. Without them the result is exactly as before.
- `app/Payroll.php`: the rate comes from `getSalaryOnDate`. Attendance is counted per salary segment, and OT rows and OT vouchers are priced by their date. It writes `increment_note`. A sheet with no increment inside its period is unchanged: Jun, Sep and Oct 2026, on calendar, fixed30 and fixed26, were compared line by line with the previous code, all identical.
- `api/router.php`: increment routes, the `'admin'` route permission, and the daily `basic_salary` sync.
- `api/controllers/EmployeeController.php`:
  - a new employee gets a *joining* row (from the basic salary or daily rate typed on the Salary Info tab);
  - changing the joining date moves that row (refused if an increment or posted salary is in the way);
  - the list reads `employees.basic_salary`;
  - salary info records no longer take a typed rate (the server stores the increment snapshot).
- `app/Reports/EmployeeListReport.php`: salary column from `employees.basic_salary`.
- `app/Reports/SalarySheetReport.php`: ▲ marker, footnote and CSV column for mid-period increments.
- `public/report.php`: registers the two reports.
- `public/assets/js/app.js`: menu items and routes.
- `public/assets/js/pages/employee.js`:
  - new *Increment History* tab;
  - the Salary Info dialog drops the basic / daily rate fields, because the rate is managed by increments (the initial salary of a new employee is still typed there);
  - tab indexes shifted.
- `public/assets/js/pages/salary.js`: ▲ inc badge with tooltip, and a formula note.
- `public/assets/js/pages/reports.js`: the two report cards.
- `DEPLOY.md`: upgrade note and optional cron.

### Decisions to confirm

- **`employees.basic_salary` didn't exist.** The salary lived only in `employee_salary_history`. It was added as a synced cache, as the spec asked. For daily-wages staff it holds the rate per day.
- **Backfill uses the full history, not only the current salary.** A single joining row at today's salary would make re-generated old months (e.g. June 2026 for `0001`: 145,000, not 160,000) use the wrong salary. Employees without any salary record get a joining row of 0. Migrated amounts are kept exactly, not rounded.
- **Changing the employee type** between daily wages and monthly doesn't convert the rate. Add a *new salary* increment from the change date.
- **Bulk fixed amounts** on mixed groups: the *Employees* filter defaults to *Monthly* so a Rs 3,000 increment doesn't hit daily rates by accident.
- **Posted-month lock is per employee.** It checks posted sheets that have a line for that employee (salary month ≥ the effective month, or a period reaching the date).
- **Existing engine deductions** (EOBI / PESSI / tax / loans) still use the batch-4 float code, rounded to whole rupees. Only work pay, OT and increment arithmetic moved to paisa.
- **Observed, not changed:** the Salary Sheet screen opens on the previous month. When that month is posted, the From / To fields stay read only; open another month from the *Sheets:* buttons.

### Test checklist (increments)

Automated: `php tests/run.php` → 62 passed (13 new in `IncrementsTest.php`). The scenarios below were also run end to end through the HTTP API on a fresh `--seed` database (56 checks, all passing). Today = 03-10-2026 in the examples.

1. **% increment.** `0003` (45,000): 10% from 15-10-2026 → preview 45,000 → 49,500 (+4,500, 10.00%), Scheduled. 7.5% of 75,000 = 80,625; 3.33% of 44,000 = 45,465.20 → **45,465**.
2. **Fixed increment.** `0004` (43,000): +3,000 from 01-10-2026 → 46,000, *Applied*. The employee list shows 46,000.
3. **Direct new salary.** `0006`: new salary 47,500.40 from today → 47,500, old salary 42,000.
4. **Mid-month increment with pro-rata.** Before posting September, `0005` (52,000; LWP on 1 Sep, absent on 30 Sep): +8,000 from 16-09-2026. Show September → work pay **52,267** = 52,000/30×14 + 60,000/30×14. Basic 60,000. The row has **▲ inc** with the split in its tooltip, and the printed sheet has ▲ and a footnote.
5. **Future-dated increment.** After step 1, `employees.basic_salary` for `0003` stays 45,000 and the history shows *Scheduled*. On 15-10, the first request of the day (or the cron) makes it 49,500. October's draft splits at 15-10.
6. **Past date in an unposted month (allowed).** Step 2 (01-10-2026 while October isn't posted).
7. **Past date in a posted month (blocked).** Post September, then try `0009` from 20-09-2026 → "Salary for September 2026 is already posted for this employee…". 01-08-2026 is also refused, because a later month is posted.
8. **Bulk increment with exclusions.** Bulk → Department *Administration*, Monthly, 5%, 01-11-2026 → Preview shows `0001` 160,000 → 168,000 and `0015` 40,000 → 42,000. Untick `0015` → Apply → only `0001` is saved. Bulk +1,000 from 25-09-2026 on a department after September is posted → refused, **nothing** saved.
9. **Overtime before and after an increment.** `0005`: approve 2 h OT on 10-09 and 2 h on 17-09 → OT = 2 h × (52,000 ÷ (30 × shift h) × 2) + 2 h × (60,000 ÷ (30 × shift h) × 2). The tooltip lists both rates. Change the multiplier to 1.5 in Company Settings → an unposted month uses the new rate.
10. **Regenerating an old month's sheet.** August draft for `0005` still uses 52,000. June 2026 for `0001` uses 145,000, not 160,000. A posted September is returned as stored.
11. **Delete rules.**
    - The joining row → "cannot be deleted".
    - A non-latest increment → "Only the latest…".
    - `0005`'s 16-09 increment (September posted) → refused.
    - The latest scheduled or applied increment → deleted, and `basic_salary` returns to the old value (`0004` → 43,000).
    - Re-adding it works (correct = delete + add).
12. **Validation.** Duplicate date, a date before the latest increment, value 0, a negative value, 3 decimals, before joining, and after the leaving date (`0014`) → each refused with a clear message.
13. **Permissions.**
    - As `hr`: the menu shows *Salary Increment* (history only, no form) but not *Bulk Increment*.
    - As `hr`, `POST /api/increments`, `/bulk` and `DELETE` → 403. `accounts` → 403.
    - History and reports work.
14. **New employee.** Create an employee with basic 38,000 joining 01-10-2026 → a *joining* row of 38,000. Change the joining date to 28-09-2026 → the joining row moves.
15. **Reports.** Increment Register 01-09 → 31-12 (department sub-totals, grand total old vs new, CSV). Employee Increment History for `0001` (145,000 → 160,000 → scheduled 168,000). Both print in A4 with Page X of Y.

## Full-scope update (Al Nahar parity)

The full specification (setup, attendance, accounts, salary sheets, users and roles, increments) was checked against this codebase module by module. Most of it already existed (batches 1–5 and the increment module above). This update adds only what was missing; nothing else was rewritten. Migration: `013_full_scope.sql`.

### What was added or changed

| Spec | Change |
|---|---|
| 1.1 Settings | **Late grace minutes** (company default; a shift's own grace overrides it) and the **barcode repeat window** in Company Settings. The OT multiplier help text now explains the per-date formula. |
| 1.5 Shift groups | **Shift group history** (`employee_shift_history`): every change of group or rotation start is kept and shown on Employee Info. |
| 1.6 Employee delete | An employee with attendance, salary, voucher, overtime, leave or punch records is **kept and set Inactive** (soft delete, audit-logged). Only an employee without any records is removed. |
| 2 Statuses | Stored codes L / LW are shown everywhere as **LWP / LWOP** (screens, reports, CSV). |
| 2.1 Attendance voucher | **Status filter** in the header (Auto Attendance, voucher number, department and prev/next already existed). |
| 2.2 Barcode | Repeat scans ignored within **2 minutes** (setting `scan_repeat_seconds` = 120; existing installs at the old 60 s default are moved to 120). |
| 2.4 Working hours | Time Out earlier than Time In = **crossing midnight on any shift** (previously only overnight shifts). Out = In is rejected. A missing time out is flagged and no hours are invented (unchanged). |
| 2.5 Daily Attendance Post | **Post & lock dates** (admin) on the Daily Attendance Post screen. Posting is refused while a *missing time out* exists. A posted date can't be entered, edited, deleted, re-processed from punches or filled by leave. **Admin unpost** needs a reason and is audit-logged. Punches that arrive for a locked date wait and are applied after an unpost. |
| 2.6 Overtime | Approved hours can only be **edited down** (never above the overtime worked, or the hours entered manually). **Manual overtime** (Overtime Approval → Manual OT, and the Overtime Voucher) is **admin only, with a reason**. Manual rows are flagged `is_manual` and are no longer touched by attendance re-posting. |
| 2.7 Leave register | **Employee-wise** register (employee code filter). |
| 2.8 Monthly sheet | Day headers **"01 - Wednesday"** (vertical), a **rotated department label** per group, and totals **P, A, LWP, LWOP, R** (+ H, HD). |
| 3.2 Loans | **Skip / change an installment: admin only** (audit-logged as before). |
| 4.1 Net never negative | Deduction order: fine → penalty → advance → loan. The **loan installment gives way first** (balance rescheduled). Then advance, penalty and fine that the pay can't cover are **carried forward**: posting creates system ADV / PEN vouchers for the next period (no extra journal; the advance stays receivable). The sheet shows the warning; the print lists what was carried. |
| 4.1 Unpost | **Admin unpost** of the latest posted sheet (reason required, audit-logged). It reverses everything posting did: removes the salary JV and carry vouchers, releases vouchers, overtime and loan installments (installments get their exact previous status back; loans are rescheduled), and makes the sheet a draft. Refused while a later sheet with the same employees is posted. |
| 4.2 Daily wages | **Weekly / fortnightly / monthly** sheets (period presets). Several daily-wages sheets per month (one per start date, no overlaps). Vouchers and loan installments still open are taken by the next sheet the employee is on, so a daily-wager's month never closes to new vouchers. |
| 4.3 Print | Title **"Salary Sheet For The Month Of September, 2026"** (weekly sheets name the period). Columns per spec: Sr, ID, Employee Name, Designation, Paid Days, Basic Salary, Gross, OT Hour, OT Rate, Overtime, Advance, Loan Ded., Remaining Bal., Incentive, Penalty, Fine, Net Salary, Signature. Department sub-totals, grand total, landscape, page X of Y. |
| 5 Roles | New **Data Entry** role: setup, attendance, vouchers, loans, leave, salary drafts. It has no posting / unposting, no OT approval, no increments, and no users. Admin and Viewer exist. |

### Hostinger quick reference

Full steps are in [DEPLOY.md](DEPLOY.md).

- **Config:** `../payroll-config.php`, one level above the app folder, so Git redeploys can't wipe it. Copy it from `config.sample.php`: DB credentials, `storage_path`, `setup_key`.
- **Photos and logos:** `storage_path` in that config, pointing **outside** `public_html`, e.g. `/home/u123456789/domains/example.com/payroll_storage`. Redeploys don't touch it, and files are served only through `file.php` after a login check. System Health warns if it's inside the deploy folder.
- **Migrations:** `https://example.com/migrate.php?key=…` (browser) or `php migrations/migrate.php` (SSH). Upgrades apply only new migrations.
- **hPanel cron (optional):** `5 0 * * *  /usr/bin/php /home/USER/domains/example.com/public_html/tools/sync_salaries.php`. It moves scheduled increments into `employees.basic_salary` at midnight; without it, the first request of the day does the same.
- **ZKTeco ADMS:** on the device, *Comm → Cloud Server Setting*: server = your domain, port 80, Domain-name mode on. The device appears under **Attendance → Devices, Kiosk & TV** as inactive; tick *Active* and optionally set its internet IP. Enter each employee's enrollment number as **Machine ID**. Exported logs (CSV / Excel / attlog.dat) go through **Machine Log Import**.

### API endpoints added

| Method | Path | Permission |
|---|---|---|
| GET | `/api/attendance/day-posts?from=&to=` | attendance.view |
| POST | `/api/attendance/day-posts` `{from, to, remarks?}` (post & lock) | admin |
| POST | `/api/attendance/day-posts/unpost` `{date, reason}` | admin |
| POST | `/api/salary/sheets/{id}/unpost` `{reason}` | admin |
| POST | `/api/overtime` (manual OT, `remarks` = reason required) | admin (was overtime.add) |
| POST | `/api/loans/{id}/installments/{iid}` (skip / adjust / reset) | admin (was loans.edit) |
| POST/PUT | `/api/vouchers/ot` (overtime voucher, `remarks` required) | admin |
| GET | `report.php?r=leave_register&code=` (employee-wise) | leave.print |

### Files

**New:** `migrations/013_full_scope.sql`, `migrations/seeds/130_demo_shift_history.sql`, `app/DayLock.php`.

**Changed:**
- `app/AttendanceEngine.php`: day lock, company grace, out-before-in crosses midnight, manual OT rows protected, approved OT never above worked OT.
- `app/Payroll.php`: carry-forward, unpost, daily-wages periods, joining boundary not shown as an increment.
- `app/PayrollEngine.php`: net never negative.
- `app/PayrollLock.php`: a daily-wages month doesn't close to vouchers.
- `app/Settings.php`, `app/Reports/Report.php`, `app/Reports/MonthlyAttendanceReport.php`, `app/Reports/SalarySheetReport.php`, `app/Reports/{Daily,Employee,Shift}AttendanceReport.php`, `app/Reports/LeaveReport.php`.
- `api/router.php`, `api/controllers/{Attendance,AttendanceVoucher,Leave,Overtime,Voucher,Salary,Employee}Controller.php`.
- `public/assets/js/pages/{attendance-post,attendance-voucher,overtime,salary,settings,employee,reports}.js`.
- Tests: `tests/{PayrollEngine,Attendance}Test.php`.

### Decisions to confirm

- **EOBI / PESSI / income tax, payslips and the bank transfer list already existed** (batches 4–5), although the spec says not to add them. I did **not** delete them: they are off unless enabled on an employee's salary info, and the salary sheet print shows their columns only when a sheet has such amounts. Say the word and I'll remove them completely (menu, reports, engine, JV lines, rates screen).
- **Leave types:** the spec has LWP / LWOP. The existing leave register has typed leave (CL, SL, AL = with pay; LWP = without pay) with quotas. These are shown as LWP / LWOP in attendance.
- **Carry-forward order:** the spec says to cap the loan first. After the loan, the advance gives way before the penalty and fine, because the advance stays a receivable and is simply recovered next period.
- **Attendance day lock** is company-wide per date and blocks attendance only. Overtime approval and vouchers keep their own workflow; posted salary still locks everything.

### Full test checklist

Automated: `php tests/run.php` → **63 passed**. The end-to-end scripts were run through the HTTP API on a fresh `--seed` database: **61 checks** (full scope) + **59 checks** (increments), all passing. A September sheet without increments is line-for-line identical to the previous version.

1. **Night shift hours.** Attendance Voucher, 01-10-2026, employee on shift N: In 20:00, Out 08:00 → Out on 02-10, hours = 12 h − break (11:00). Out equal to In is rejected.
2. **Missing time out.** Enter only Time In → row flagged *Missing time out*, 0 hours. **Post & lock** that date is refused until it is corrected.
3. **Auto attendance.** Attendance Voucher → date + department → F7 → tick *Auto Attendance* → everyone P → F10. The status filter shows only the chosen status.
4. **Duplicate attendance blocked.** Save the same date / department again → rows are updated, never duplicated (one row per employee per date).
5. **Daily post lock.**
   - Post & lock 01-10 → editing that date is refused, even for an admin.
   - Unpost needs an admin and a reason; the audit log shows it.
   - After the unpost, the date can be edited again.
6. **Barcode.** Kiosk: scan `0008` → IN with photo and name. Scan again within 2 minutes → "already scanned".
7. **Overtime approval.**
   - Approving more than the worked or entered time is refused; lowering works.
   - Manual OT without a reason, or by a non-admin, is refused.
   - Only approved OT reaches the sheet.
8. **Loan installments until balance 0.** Loan 10,000 @ 4,000 → schedule 4,000 + 4,000 + 2,000. Post September → 4,000 deducted, Remaining Bal. 6,000, next installments 4,000 + 2,000. When the salary is short, the installment is reduced and rescheduled. Skip / change is admin only.
9. **Net salary never negative.** `0009`: advance 60,000 + penalty 700 + fine 300 → net 0. Fine and penalty are deducted, the advance is partly deducted, and the rest becomes a system ADV voucher for October. No line on the sheet is negative.
10. **% increment**, 11. **fixed increment**, 12. **direct new salary**, 13. **mid-month increment pro-rata**, 14. **future-dated increment**, 15. **past date in an unposted month (allowed)**, 16. **past date in a posted month (blocked)**, 17. **bulk increment with exclusions**, 18. **overtime before and after an increment**, 19. **regenerating an old month**: see *Test checklist (increments)* above (same numbers: 49,500 · 46,000 · 47,500 · 52,267 · …).
20. **Posting / unposting locks.**
    - After posting September, editing September attendance and adding a September voucher are refused.
    - HR can't unpost, and unpost needs a reason.
    - Admin unpost → draft again: JV and carry voucher removed, loan installment back to scheduled, attendance editable.
    - Show → Save → Post again works.
21. **Daily wages weekly sheets.**
    - Weekly 01–07 Sep posted, then an advance for a daily-wager is still accepted; weekly 08–14 Sep deducts it.
    - Pay = rate × paid days.
    - An overlapping period is refused.
    - The print title names the period.
22. **Delete rules.**
    - Increments: see the increment checklist.
    - Employees: deleting `0004` (has attendance) keeps it and sets it Inactive; a new employee without records is removed.
23. **Roles.** A *Data Entry* user can save attendance and draft vouchers, but can't post vouchers or salary, lock dates, enter OT vouchers or add increments (403). A Viewer only sees and prints.
24. **Reports.**
    - Monthly sheet ("01 - Tuesday", rotated department, LWP / LWOP totals); employee-wise leave register.
    - Salary sheet title and columns.
    - Daily, employee-wise, shift-wise, overtime, vouchers, loans, DayBook, JV, employee list and ID cards (Code128 SVG) all render and print A4.

## Notes and open questions

- **Payroll decisions (confirmed, implemented in batch 4):**
  - **Paid days from actual hours.** A full Present day counts as 1 day, so the verified examples still hold (e.g. 9,000 ÷ 28 × 14 = 4,500). A half day or short day counts as `worked minutes ÷ shift net minutes`, capped at 1, instead of a fixed ½.
  - **Allowances** are added to gross and prorated the same way: `Allowance pay = Allowances ÷ days in month × paid days`. Gross = Work Pay + Allowance pay + Overtime.
- **Statutory rates and tax slabs** in `006_base_data.sql` are clearly marked *samples* (EOBI 1%/5% of minimum wage, PESSI/SESSI employer 6%, FY 2025-26 salaried slabs). They are effective-dated rows that admins can edit; check them against current notifications.
- Islamic holidays in the demo data are approximate (moon sighting).
- The default weekly rest day is **Sunday**. It can be changed under Holidays or Company Settings, and per shift group.
