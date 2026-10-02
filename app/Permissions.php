<?php
declare(strict_types=1);

namespace App;

/** Module x action permission catalogue (used by the role matrix editor and the API). */
final class Permissions
{
    public const ACTIONS = ['view', 'add', 'edit', 'delete', 'post', 'print'];

    /** module key => [label, group, applicable actions] */
    public const MODULES = [
        'dashboard'       => ['Dashboard',            'General',    ['view']],
        'employees'       => ['Employees',            'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'departments'     => ['Departments',          'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'designations'    => ['Designations',         'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'shifts'          => ['Shifts',               'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'shift_groups'    => ['Shift Groups',         'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'holidays'        => ['Holidays',             'Setup',      ['view', 'add', 'edit', 'delete', 'print']],
        'attendance'      => ['Attendance',           'Attendance', ['view', 'add', 'edit', 'delete', 'print']],
        'attendance_post' => ['Daily Attendance Post', 'Attendance', ['view', 'post']],
        'overtime'        => ['Overtime Approval',    'Attendance', ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'leave'           => ['Leave Register',       'Attendance', ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'devices'         => ['Attendance Devices',   'Attendance', ['view', 'add', 'edit', 'delete']],
        'vouchers'        => ['Vouchers',             'Accounts',   ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'loans'           => ['Loans',                'Accounts',   ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'journal'         => ['Journal Vouchers',     'Accounts',   ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'salary'          => ['Salary Sheet',         'Payroll',    ['view', 'add', 'edit', 'delete', 'post', 'print']],
        'reports'         => ['Reports',              'Reports',    ['view', 'print']],
        'settings'        => ['Company Settings & Rates', 'Admin',  ['view', 'edit']],
        'users'           => ['Users & Roles',        'Admin',      ['view', 'add', 'edit', 'delete']],
        'audit'           => ['Audit Log',            'Admin',      ['view']],
    ];

    public static function valid(string $module, string $action): bool
    {
        return isset(self::MODULES[$module]) && in_array($action, self::MODULES[$module][2], true);
    }

    /** @return array<string,string[]> module => allowed actions for a role */
    public static function forRole(int $roleId): array
    {
        $role = Database::one('SELECT is_admin FROM roles WHERE id = ?', [$roleId]);
        if (!$role) {
            return [];
        }
        if ((int)$role['is_admin'] === 1) {
            return array_map(fn($m) => $m[2], self::MODULES);
        }
        $out = [];
        foreach (Database::all('SELECT module, action FROM permissions WHERE role_id = ?', [$roleId]) as $r) {
            if (self::valid($r['module'], $r['action'])) {
                $out[$r['module']][] = $r['action'];
            }
        }
        return $out;
    }
}
