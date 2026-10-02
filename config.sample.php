<?php
/**
 * Copy this file to config.php and edit the values.
 *
 * On Hostinger, keep config.php OUTSIDE public_html, or keep it in the
 * project root (one level above /public) which is never web-served.
 * You can also point PAYROLL_CONFIG (environment variable) to an absolute path.
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
