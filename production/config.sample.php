<?php
/**
 * Copy this file and edit the values. The app looks for, in order:
 *   1. the file named by the PRODUCTION_CONFIG environment variable
 *   2. ../production-config.php  one level above the app folder (recommended on Hostinger:
 *                                outside public_html, survives Git redeploys)
 *   3. config.php                in the app folder (local development; never web-served)
 */
return [
    'app_name' => 'Production',
    'debug'    => false,               // never true in production

    'db' => [
        'host' => 'localhost',
        'port' => 3306,
        'name' => 'production',
        'user' => 'production',
        'pass' => 'change-me',
    ],

    // Logs. Keep outside the deploy directory in production, e.g. /home/u123456789/production_storage
    'storage_path' => __DIR__ . '/storage',

    'session' => [
        'name'            => 'PRODSESSID',
        'timeout_minutes' => 60,       // idle timeout
    ],

    'security' => [
        'login_max_attempts' => 5,     // failed attempts per username+IP ...
        'login_window_min'   => 15,    // ... within this many minutes -> locked
        // Required to run migrations from the browser: /migrate.php?key=...  Leave empty for CLI only.
        'setup_key'          => '',
    ],
];
