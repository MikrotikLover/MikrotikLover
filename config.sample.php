<?php
/**
 * Copy this file and edit the values. The app looks for, in order:
 *   1. the file named by the PAYROLL_CONFIG environment variable
 *   2. ../payroll-config.php   one level above the app folder (recommended on Hostinger:
 *                              outside public_html, survives Git redeploys)
 *   3. config.php              in the app folder (local development; never web-served)
 * See DEPLOY.md.
 */
return [
    'app_name' => 'Payroll & HR',
    'debug'    => false,               // never true in production

    'db' => [
        'host'    => 'localhost',
        'port'    => 3306,
        'name'    => 'payroll',
        'user'    => 'payroll',
        'pass'    => 'change-me',
        'charset' => 'utf8mb4',
    ],

    // Persistent storage for photos, logos, exports, logs.
    // MUST be outside the deploy directory, because Hostinger Git deploy
    // wipes the deploy folder. Example: /home/u123456789/payroll_storage
    'storage_path' => __DIR__ . '/storage',

    'session' => [
        'name'            => 'PAYROLLSESSID',
        'timeout_minutes' => 30,       // idle timeout
    ],

    'security' => [
        'login_max_attempts' => 5,     // failed attempts per username+IP ...
        'login_window_min'   => 15,    // ... within this many minutes -> locked
        // Required to run migrations from the browser: /migrate.php?key=...
        // Leave empty to allow CLI only.
        'setup_key'          => '',
    ],

    // Upload limits
    'uploads' => [
        'photo_max_bytes' => 3 * 1024 * 1024,
        'photo_width'     => 300,      // stored photo size (3:4)
        'photo_height'    => 400,
    ],
];
