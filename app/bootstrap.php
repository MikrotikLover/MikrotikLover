<?php
declare(strict_types=1);

define('APP_DIR', __DIR__);
define('APP_ROOT', dirname(__DIR__));      // the deploy folder (public_html)
define('APP_VERSION', '1.4.0-batch5');

ini_set('display_errors', '0');
ini_set('log_errors', '1');
error_reporting(E_ALL);
mb_internal_encoding('UTF-8');

spl_autoload_register(static function (string $class): void {
    foreach (['core', 'controllers', 'services'] as $dir) {
        $file = APP_DIR . '/' . $dir . '/' . $class . '.php';
        if (is_file($file)) {
            require $file;
            return;
        }
    }
});

Config::load();
date_default_timezone_set('Asia/Karachi');

// Turn warnings/notices into exceptions so bugs never pass silently;
// deprecations are only logged (keeps PHP upgrades on Hostinger safe).
set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    if (in_array($severity, [E_DEPRECATED, E_USER_DEPRECATED], true)) {
        Logger::info("Deprecated: $message at $file:$line");
        return true;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});
