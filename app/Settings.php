<?php
declare(strict_types=1);

namespace App;

/** Key/value company settings (values JSON-encoded in the `settings` table). */
final class Settings
{
    private static ?array $cache = null;

    /** Keys editable from Company Settings screen, with their validation rules. */
    public const COMPANY_RULES = [
        'company_name'         => 'required|string|max:150',
        'company_name_ur'      => 'nullable|string|max:150',
        'company_address'      => 'nullable|string|max:255',
        'company_address_ur'   => 'nullable|string|max:255',
        'company_phone'        => 'nullable|string|max:60',
        'company_email'        => 'nullable|email|max:120',
        'company_ntn'          => 'nullable|string|max:30',
        'salary_day_basis'     => 'required|in:calendar,fixed30,fixed26',
        'weekly_rest_days'     => 'array',
        'social_security'      => 'required|in:PESSI,SESSI',
        'rounding_rule'        => 'required|in:half_up,up,down',
        'ot_multiplier'        => 'required|num|min:1|max:5',
        'default_shift_hours'  => 'required|num|min:1|max:24',
        'max_daily_hours'      => 'required|int|min:1|max:24',
        'late_grace_minutes'   => 'required|int|min:0|max:240',
        'scan_repeat_seconds'  => 'required|int|min:10|max:3600',
        'id_card_valid_months' => 'required|int|min:1|max:120',
        'id_card_back_note'    => 'nullable|string|max:255',
    ];

    public static function all(): array
    {
        if (self::$cache === null) {
            self::$cache = [];
            foreach (Database::all('SELECT setting_key, setting_value FROM settings') as $r) {
                self::$cache[$r['setting_key']] = $r['setting_value'] === null ? null : json_decode($r['setting_value'], true);
            }
        }
        return self::$cache;
    }

    public static function get(string $key, mixed $default = null): mixed
    {
        return self::all()[$key] ?? $default;
    }

    public static function set(string $key, mixed $value): void
    {
        Database::run(
            'INSERT INTO settings (setting_key, setting_value, updated_by) VALUES (:k, :v, :u)
             ON DUPLICATE KEY UPDATE setting_value = :v2, updated_by = :u2',
            ['k' => $key, 'v' => $json = json_encode($value, JSON_UNESCAPED_UNICODE), 'u' => Auth::id(), 'v2' => $json, 'u2' => Auth::id()]
        );
        self::$cache = null;
    }

    /** Company block used by report headers and ID cards. */
    public static function company(): array
    {
        $s = self::all();
        return [
            'name'       => (string)($s['company_name'] ?? ''),
            'name_ur'    => (string)($s['company_name_ur'] ?? ''),
            'address'    => (string)($s['company_address'] ?? ''),
            'address_ur' => (string)($s['company_address_ur'] ?? ''),
            'phone'      => (string)($s['company_phone'] ?? ''),
            'email'      => (string)($s['company_email'] ?? ''),
            'ntn'        => (string)($s['company_ntn'] ?? ''),
            'logo'       => $s['company_logo'] ?? null,
        ];
    }
}
