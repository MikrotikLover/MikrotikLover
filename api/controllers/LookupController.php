<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Database;
use App\Request;
use App\Settings;

/** Dropdown data used by many screens, fetched once by the SPA and refreshed after master edits. */
final class LookupController
{
    public function index(Request $r): array
    {
        return [
            'departments'  => Database::all('SELECT id, code, name, name_ur, is_active FROM departments ORDER BY name'),
            'designations' => Database::all('SELECT id, code, name, name_ur, is_active FROM designations ORDER BY name'),
            'shifts'       => Database::all('SELECT id, code, name, start_time, end_time, is_overnight, duration_minutes, is_active FROM shifts ORDER BY start_time'),
            'shift_groups' => Database::all('SELECT id, code, name, is_active FROM shift_groups ORDER BY name'),
            'roles'        => Database::all('SELECT id, name FROM roles ORDER BY id'),
            'settings'     => [
                'weekly_rest_days' => Settings::get('weekly_rest_days', [0]),
                'salary_day_basis' => Settings::get('salary_day_basis', 'calendar'),
                'social_security'  => Settings::get('social_security', 'PESSI'),
            ],
        ];
    }
}
