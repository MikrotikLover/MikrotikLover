<?php
declare(strict_types=1);

namespace Prod;

final class Settings
{
    public const KEYS = [
        'company_name'     => 'string',
        'default_ink_rate' => 'number', // Rs per litre, first rate of a newly created machine
        'ink_high_ml'      => 'number', // Data check: ink use above this (ml/m) is suspicious
        'mtr_high'         => 'number', // Data check: printed metres above this in one row is suspicious
    ];

    private static ?array $cache = null;

    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Database::all('SELECT k, v FROM settings') as $r) {
                $type = self::KEYS[$r['k']] ?? 'string';
                self::$cache[$r['k']] = $type === 'number' ? (float)$r['v'] : $r['v'];
            }
        }
        return self::$cache;
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        return self::all()[$key] ?? $default;
    }

    public static function save(array $values): void
    {
        foreach (self::KEYS as $k => $type) {
            if (array_key_exists($k, $values)) {
                $v = $type === 'number' ? (string)(float)$values[$k] : Text::clean($values[$k]);
                Database::run('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [$k, $v]);
            }
        }
        self::$cache = null;
    }
}
