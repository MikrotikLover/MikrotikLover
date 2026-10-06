<?php
declare(strict_types=1);

/**
 * Common bootstrap: config, timezone, autoloader, error handling.
 * Included by every entry point (public/*.php, migrations/migrate.php, tests).
 */

define('PROD_ROOT', dirname(__DIR__));

date_default_timezone_set('Asia/Karachi');
mb_internal_encoding('UTF-8');

spl_autoload_register(static function (string $class): void {
    if (str_starts_with($class, 'Prod\\')) {
        $file = PROD_ROOT . '/src/' . str_replace('\\', '/', substr($class, 5)) . '.php';
        if (is_file($file)) {
            require $file;
        }
    }
});

Prod\Config::load();

error_reporting(Prod\Config::get('debug') ? E_ALL : E_ALL & ~E_DEPRECATED);
ini_set('display_errors', '0'); // errors are returned as JSON / logged, never echoed into output
ini_set('log_errors', '1');
$logDir = rtrim((string)Prod\Config::get('storage_path', PROD_ROOT . '/storage'), '/') . '/logs';
if (!is_dir($logDir)) {
    @mkdir($logDir, 0775, true);
}
ini_set('error_log', $logDir . '/php-error.log');

set_error_handler(static function (int $severity, string $message, string $file, int $line): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});
