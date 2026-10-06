<?php
declare(strict_types=1);

namespace Prod;

/**
 * Reads the configuration file, first found of:
 *   1. the file named by the PRODUCTION_CONFIG environment variable
 *   2. ../production-config.php  (one level above the app folder: survives Git redeploys, never web-served)
 *   3. config.php in the app folder
 */
final class Config
{
    private static array $data = [];

    public static function load(): void
    {
        $file = getenv('PRODUCTION_CONFIG') ?: '';
        if ($file === '') {
            $outside = dirname(PROD_ROOT) . '/production-config.php';
            $file = is_file($outside) ? $outside : PROD_ROOT . '/config.php';
        }
        if (!is_file($file)) {
            http_response_code(500);
            header('Content-Type: text/plain; charset=utf-8');
            echo "Configuration missing. Copy config.sample.php to ../production-config.php (or config.php) and edit it.\n";
            exit(1);
        }
        self::$data = require $file;
    }

    /** Overrides one top-level key (tests point 'db' at a scratch database). */
    public static function set(string $key, mixed $value): void
    {
        self::$data[$key] = $value;
    }

    /** Dot-notation access: Config::get('db.host') */
    public static function get(string $key, mixed $default = null): mixed
    {
        $value = self::$data;
        foreach (explode('.', $key) as $part) {
            if (!is_array($value) || !array_key_exists($part, $value)) {
                return $default;
            }
            $value = $value[$part];
        }
        return $value;
    }
}
