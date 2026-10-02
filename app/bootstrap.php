<?php
declare(strict_types=1);

/**
 * Common bootstrap: config, timezone, autoloader, error handling.
 * Included by every entry point (public/*.php, migrations/migrate.php, tests).
 */

define('APP_ROOT', dirname(__DIR__));

date_default_timezone_set('Asia/Karachi');
mb_internal_encoding('UTF-8');

spl_autoload_register(static function (string $class): void {
    $map = [
        'App\\Controllers\\' => APP_ROOT . '/api/controllers/',
        'App\\Reports\\'     => APP_ROOT . '/app/Reports/',
        'App\\'              => APP_ROOT . '/app/',
    ];
    foreach ($map as $prefix => $dir) {
        if (str_starts_with($class, $prefix)) {
            $file = $dir . str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';
            if (is_file($file)) {
                require $file;
            }
            return;
        }
    }
});

App\Config::load();

if (App\Config::get('debug')) {
    error_reporting(E_ALL);
    ini_set('display_errors', '0'); // errors are returned as JSON / logged, never echoed into output
} else {
    error_reporting(E_ALL & ~E_DEPRECATED);
    ini_set('display_errors', '0');
}
ini_set('log_errors', '1');
ini_set('error_log', App\Storage::path('logs') . '/php-error.log');

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});
