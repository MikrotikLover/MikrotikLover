<?php
declare(strict_types=1);

/** Key/value settings with a per-request cache. */
final class Settings
{
    private static ?array $cache = null;

    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (DB::all('SELECT setting_key, setting_value FROM settings') as $row) {
                self::$cache[$row['setting_key']] = (string) $row['setting_value'];
            }
        }
        return self::$cache;
    }

    public static function get(string $key, string $default = ''): string
    {
        return self::all()[$key] ?? $default;
    }

    public static function float(string $key, float $default = 0.0): float
    {
        $v = self::all()[$key] ?? null;
        return is_numeric($v) ? (float) $v : $default;
    }

    /** Upsert; call inside a transaction. */
    public static function set(string $key, ?string $value): void
    {
        DB::query(
            'INSERT INTO settings (setting_key, setting_value, updated_by) VALUES (:k, :v, :u)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
            ['k' => $key, 'v' => $value, 'u' => Auth::id()]
        );
        self::$cache = null;
    }
}
