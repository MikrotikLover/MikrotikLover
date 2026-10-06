# Production (digital printing) app

A standalone web app for the digital printing production log. It replaces the `Production_Details_2026.xlsx` workbook (sheet **Production Summary**). Every printed run is an entry with these fields: Date, Lot #, Quality, Party, Design, Printed Mtr, Calibration, Ink use (ml/m), Article, Machine, Shift and Operator.

It uses the same stack and hosting model as the payroll app in this repository, but it shares no code or data with it. **Stack:** vanilla PHP 8.2+ (no Composer), PDO + MySQL 8 / MariaDB 10.4+, and a vanilla-JS single-page app with no build step. It runs on Hostinger shared hosting.

## What it does

| Page | Purpose |
|---|---|
| Dashboard | Metres, ink litres, ink cost, average ml/m, cost per metre and entries/lots for any date range, compared with the previous period. Also a daily (or monthly) chart and breakdowns by machine, shift, operator, party and article. |
| New Entry | Fast keyboard entry. Enter moves to the next field and Ctrl+S saves. After a save, date, machine, shift, operator, party, lot and quality stay filled for the next row. Party, quality and other names are suggested from the lists. |
| Entries | Filter by date, machine, shift, party, operator, quality, article, lot or free text. Shows totals and pages through results, with CSV export, print, edit and delete. |
| Reports | Summary grouped by any one or two of: party, **customer** (party without "Vol N"), lot, machine, operator, shift, date, month, quality, article, calibration, design, ink company. Exports to CSV and prints. |
| Import Excel | Upload the workbook as it is. The app finds the sheet and heading row itself, shows a preview with any problem rows, then imports. **Add new rows only** skips rows that were already imported, so you can re-import the same growing workbook every day. **Replace** re-imports a date range after old rows were corrected in Excel. |
| Data Check | Lists rows with missing ink, very high ink (thresholds in Settings), very high metres, or a missing operator, party, article or quality. Also finds spelling variants in the lists (Dupatta/Duppata, Mahmood/Mehmood, Allovar/Allover) and merges them in one click. |
| Ink Companies | Ink comes from different companies, and **each company has its own ink rate (Rs/litre)** with a dated history. |
| Machines & Rates | **Each machine has its own machine rate (Rs per printed metre)** with a dated history. Each machine also records **which ink company's ink it uses from which date**. One entry can still be given a different ink company in the entry form. Any change re-prices the affected entries automatically. |
| Lists | Parties, operators, qualities, articles and calibrations. You can rename, merge, hide or delete them. |
| Users / Settings / Audit Log | Roles: **admin** (everything), **manager** (entries, import, lists, ink and machine rates), **entry** (add and edit entries), **viewer** (read only). Every change is written to the audit log. |

**Costs of an entry**, using the rates in force on the entry date:

- **Ink cost** = Printed Mtr × Ink use (ml/m) ÷ 1000 × ink rate (Rs/L) of the entry's ink company. This matches the workbook's formula, which uses Rs 1450/L.
- **Machine cost** = Printed Mtr × machine rate (Rs/m).
- **Total cost** = ink cost + machine cost. The dashboard, entries and reports show all three, along with total cost per metre.

A rate also applies to dates before its first row, so an opening rate covers old production. The average ml/m only counts metres that have an ink figure, so a row with a blank ink cell doesn't pull the average down.

After the first import every machine uses the company **Default ink** at Rs 1450/L and has no machine rate. Rename that company, add the other companies, and set each machine's rate and ink company.

Names are trimmed and matched without regard to case. So `Bana Dora ` and `Bana Dora`, or `MS` and `Ms`, become one record.

## Local setup

```bash
cd production
cp config.sample.php config.php            # set DB credentials
mysql -e "CREATE DATABASE production CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
php migrations/migrate.php                 # tables + first user admin / admin123 (must change at first login)
php -d upload_max_filesize=64M -d post_max_size=64M -S 127.0.0.1:8090 -t public tools/devserver.php
php tests/run.php                          # uses a scratch database "<name>_test"
```

Open http://127.0.0.1:8090, log in, then go to **Import Excel** and upload `Production_Details_2026.xlsx`. Reading the 9 MB / 21,469-row workbook takes about 2 seconds, and the import takes a few more.

## Hosting (Hostinger)

1. Create a MySQL database and user in hPanel.
2. Upload the `production/` folder. Either point a subdomain's document root at `production/public`, or upload the whole folder into the web root, where the top-level `.htaccess` serves only `public/`.
3. Copy `config.sample.php` to `production-config.php` **one level above the app folder**, outside `public_html`, and fill in the DB details. Set `storage_path` to a folder outside the web root as well.
4. Without SSH: set `security.setup_key`, open `/migrate.php?key=…` once, then clear the key.
5. In hPanel → PHP Configuration set `upload_max_filesize` and `post_max_size` to 64M and `max_execution_time` to 300, so the workbook can be uploaded.

## Findings in the 2026 workbook

From the workbook as uploaded on 5 Oct 2026. You can check all of these in the app under **Data Check**.

- 21,469 runs from 1 Jan to 4 Oct 2026: 14,259,818 m printed, matching the sheet's total.
- **40 rows have an ink use above 60 ml/m.** Values like 13,001, 1,936 and 1,933 look like total ink typed into the ml-per-metre column. Together they add 13,731 L and **Rs 1.99 crore** of ink cost, about 7% of the total. Without them the average is 13.06 ml/m, not 14.00.
- 298 rows have no ink figure, and 93 ink cells are stored as text. The app reads the text cells as numbers.
- Row 21042 has no "Total Ink" formula, so the sheet's total ink (198,614 L) is 6.27 L short. The app computes 198,620 L.
- Several names are spelling variants of each other: Duppata/Dupatta, Allover/Allovar/allover, Bin Umar/Bin Umer, Usman Yusuf/Usman Yousaf, Mahmood/Mehmood/Mahmod, and Bana Dora with a trailing space. The case and space variants are merged on import, and the rest can be merged from Data Check.

## Layout

```
public/       web root: index.php (SPA shell), api.php, migrate.php, assets/app.js, assets/app.css
src/          bootstrap, Config, Database, Auth, Audit, XlsxReader (streaming), Importer, Entries, Reports, Pricing, Machines, InkCompanies, Masters, Controllers/
migrations/   001_schema.sql, 002_ink_companies_machine_rates.sql + migrate.php
tests/        php tests/run.php
tools/        devserver.php (router for PHP's built-in server)
```
