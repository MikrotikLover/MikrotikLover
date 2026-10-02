<?php
/**
 * Configuration template.
 *
 * Copy this file OUTSIDE the deploy folder so redeploys never wipe it:
 *
 *   /home/uXXXXXXX/domains/example.com/public_html      <- deploy folder (this repo)
 *   /home/uXXXXXXX/domains/example.com/fabric_private/config.php   <- this file
 *
 * The private folder (default: sibling "fabric_private") also holds
 * uploads/, logs/ and sessions/. Override its location with the
 * FPMS_PRIVATE_DIR environment variable or 'private_dir' below.
 */
return [
    'db' => [
        'host'    => 'localhost',
        'port'    => 3306,
        'name'    => 'u000000000_fabric',
        'user'    => 'u000000000_fabric',
        'pass'    => 'change-me',
    ],
    'app' => [
        'name'                 => 'Fabric Printing Management',
        'debug'                => false,      // true shows exception details in API errors
        'session_idle_minutes' => 120,        // auto logout after inactivity
        'whatsapp_number'      => '923001234567', // support button, international format without +
        // Required on the one-time "Create Admin" setup screen. Leave '' to disable the check.
        'setup_key'            => 'choose-a-long-random-string',
    ],
    'security' => [
        'max_login_attempts' => 5,   // per username within the lockout window
        'max_ip_attempts'    => 25,  // per IP within the lockout window
        'lockout_minutes'    => 15,
    ],
    // 'private_dir' => '/home/uXXXXXXX/domains/example.com/fabric_private',
];
