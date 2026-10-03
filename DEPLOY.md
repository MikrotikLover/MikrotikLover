# Deploying on Hostinger (shared / Business hosting, LiteSpeed)

This guide gets the Payroll & HR system live on a Hostinger plan with PHP and MySQL. It needs no Composer, no SSH and no build step. After each stage, **System Health** (Administration menu) shows which checks pass.

The paths below use Hostinger's layout: `/home/u123456789/domains/example.com/public_html`. Replace `u123456789` and `example.com` with your own.

---

## 1. Before you start

| Need | Where in hPanel |
|---|---|
| PHP **8.2 or newer** (8.5 recommended) | Websites → Manage → Advanced → **PHP Configuration** → PHP version |
| PHP extensions: `pdo_mysql`, `mbstring`, `gd`, `zip`, `fileinfo`, `json` (all on by default) | PHP Configuration → PHP extensions |
| `upload_max_filesize` and `post_max_size` ≥ **8M** (photos, Excel import) | PHP Configuration → PHP options |
| A MySQL database and user | Databases → **MySQL Databases** |
| Free SSL certificate | Security → **SSL** → install, then turn on **Force HTTPS** |

Write down the database name, user and password. Hostinger prefixes them, e.g. `u123456789_payroll`.

## 2. Upload the files

Upload the **whole project folder** (everything in the repository) into `public_html`:

- **File Manager:** zip the project on your PC, then upload and **Extract** it into `public_html`. The result should be `public_html/app`, `public_html/public`, `public_html/.htaccess` and so on.
- **Git** (Advanced → GIT): repository URL, branch `main`, install path `public_html` (it must be empty the first time). Use **Deploy** after each update.

The `.htaccess` in the project root sends every request to `public/` and refuses `app/`, `migrations/`, `storage/`, `tools/`, `tests/` and `config.php`. The code is never downloadable.

> If your plan lets you set the domain's document root to `public_html/public`, do it; the root `.htaccess` is then simply unused. Everything else stays the same.

## 3. Configuration and storage (outside the deploy folder)

Git deploy replaces the contents of `public_html`, so **configuration and uploads must live outside it**.

1. In File Manager, create two items **next to** `public_html` (in `domains/example.com/`):
   - folder `payroll_storage`
   - file `payroll-config.php`, holding a copy of `config.sample.php`
2. Edit `payroll-config.php`:

```php
'debug' => false,
'db' => ['host' => 'localhost', 'port' => 3306, 'name' => 'u123456789_payroll',
         'user' => 'u123456789_payroll', 'pass' => 'your-db-password', 'charset' => 'utf8mb4'],
'storage_path' => '/home/u123456789/domains/example.com/payroll_storage',
'security' => ['login_max_attempts' => 5, 'login_window_min' => 15, 'setup_key' => 'a-long-random-string-for-step-4'],
```

The app finds `../payroll-config.php` automatically (one level above the app folder). A `config.php` inside the app folder also works, but a Git deploy would remove it.

## 4. Create the database tables

Use one of these:

- **Browser (no SSH):** with `setup_key` set (step 3), open `https://example.com/migrate.php?key=a-long-random-string-for-step-4`. It lists each migration with `OK`. Add `&seed=1` **only** for a demo or training copy; it loads sample employees and vouchers.
- **SSH** (Business plans): `cd domains/example.com/public_html && php migrations/migrate.php`

Then **remove `setup_key`** (set it to `''`). System Health warns while it is still set.

Upgrades work the same way: deploy the new files, then run `migrate.php` again (only new migrations are applied).

## 5. First login

1. Open `https://example.com/` and log in as **admin / admin123**. You must choose a new password immediately.
2. **Company Settings:** name (English and Urdu), address, logo, salary day basis, PESSI or SESSI, rounding, OT multiplier, weekly rest day.
3. **EOBI / PESSI & Tax Slabs:** check the sample rates against the current notifications and add the current tax year's slabs.
4. **Roles & Permissions** and **Users:** create a user for each person; don't share the admin account.
5. **Administration → System Health:** every row should be ✓, except "Storage survives redeploy" if you chose to keep storage inside.

## 6. Attendance devices, kiosk and TV

- **ZKTeco (ADMS / push):** on the device, Comm → Cloud Server Setting:
  - Server address `example.com`, port `80` (or `443` with HTTPS if the device supports it);
  - "Domain name" on, proxy off.
  - The device appears under **Devices, Kiosk & TV** as *inactive*. Activate it there, and its punches are then accepted.
  - Devices often only speak plain HTTP. `/iclock` is deliberately **not** forced to HTTPS by the app's `.htaccess`. If hPanel's *Force HTTPS* breaks the device, turn Force HTTPS off and redirect only the other pages; or use CSV/Excel import instead.
- **Kiosk / TV:** generate the token links on **Devices, Kiosk & TV** and open them full-screen on the kiosk PC or TV. Regenerating a token disables the old link.

## 7. Backups

- **Hostinger:** daily/weekly backups (Files → Backups) include the database. Download one now and then.
- **From the app:** System Health → **Download database backup** (a `.sql.gz` file; admins only, logged in the Audit Log). Restore it with phpMyAdmin → Import, into an empty database.
- **Uploads:** photos and the logo are in `payroll_storage/`. Include that folder in your copies (File Manager → compress → download).

Take a backup **before every salary posting day** and before upgrades.

## 8. Security checklist

- [ ] `debug` is `false` · `setup_key` is empty · admin password changed
- [ ] SSL installed, Force HTTPS on (System Health → HTTPS ✓)
- [ ] `payroll-config.php` and `payroll_storage/` are **outside** `public_html`
- [ ] Opening `https://example.com/app/`, `/migrations/` or `/config.php` gives **403 Forbidden**
- [ ] Each person has their own user with only the permissions they need; disable users who leave
- [ ] LiteSpeed Cache plugin/rules (if enabled for the site) do not cache `/api`. The app already sends `Cache-Control: no-store`; check that the data on the screen updates after saving.

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| "Configuration missing" | `payroll-config.php` is not one level above the app folder, or has a PHP syntax error |
| Blank page / 500 | Temporarily set `debug => true`, reload, read the message, then set it back. PHP errors are also in hPanel → Advanced → **Error logs** |
| Login works but every screen says "Session expired" | The browser blocks cookies, or the site is opened from two addresses (www / non-www). Use one address (hPanel → Domains → redirect www) |
| 404 on `/api/...` | The `.htaccess` files were not uploaded (hidden files). Enable "show hidden files" in File Manager and upload them |
| Photos don't upload | Raise `upload_max_filesize` / `post_max_size` (System Health shows the current values) |
| Times are 5 hours off | Times are set to Asia/Karachi in PHP and on each DB connection. Check System Health → Time zone; the server clock itself must be correct |
| Device punches not arriving | The device is inactive (activate it), the server address is wrong, or HTTPS is forced for `/iclock`. Check **Devices → last seen** |
