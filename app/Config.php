<?php
declare(strict_types=1);

namespace App;

/** Reads config.php (or the file named by the PAYROLL_CONFIG environment variable). */
final class Config
{
    private static array $data = [];

    public static function load(): void
    {
        $file = getenv('PAYROLL_CONFIG') ?: APP_ROOT . '/config.php';
        if (!is_file($file)) {
            http_response_code(500);
            header('Content-Type: text/plain; charset=utf-8');
            echo "Configuration missing. Copy config.sample.php to config.php and edit it.\n";
            exit(1);
        }
        self::$data = require $file;
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

    public static function set(string $key, mixed $value): void
    {
        self::$data[$key] = $value;
    }
}
