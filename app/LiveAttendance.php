<?php
declare(strict_types=1);

namespace App;

/** Today's attendance by department (used by the live TV screen and the dashboard). */
final class LiveAttendance
{
    public static function data(?string $date = null): array
    {
        $date ??= date('Y-m-d');
        $cal = new Calendar($date, $date);
        $emps = Database::all(
            "SELECT e.id, e.department_id, e.joining_date, e.leaving_date, e.shift_group_id, e.shift_date, e.emp_type,
                    d.name AS department, d.name_ur AS department_ur
               FROM employees e JOIN departments d ON d.id = e.department_id
              WHERE e.joining_date <= ? AND (e.leaving_date IS NULL OR e.leaving_date >= ?)
                AND (e.status = 'active' OR e.leaving_date IS NOT NULL)",
            [$date, $date]
        );
        $att = [];
        foreach (Database::all('SELECT employee_id, status, late_minutes, time_in, time_out FROM attendance_daily WHERE att_date = ?', [$date]) as $a) {
            $att[(int)$a['employee_id']] = $a;
        }
        $depts = [];
        $tot = ['strength' => 0, 'present' => 0, 'late' => 0, 'leave' => 0, 'absent' => 0, 'not_in' => 0, 'off' => 0, 'inside' => 0];
        foreach ($emps as $e) {
            $k = (int)$e['department_id'];
            $depts[$k] ??= ['department' => $e['department'], 'department_ur' => $e['department_ur']] + array_fill_keys(array_keys($tot), 0);
            $a = $att[(int)$e['id']] ?? null;
            $status = $a['status'] ?? null;
            $bucket = match (true) {
                in_array($status, ['P', 'S', 'HD'], true) => 'present',
                in_array($status, ['L', 'LW'], true) => 'leave',
                $status === 'A' => 'absent',
                in_array($status, ['R', 'H', 'O'], true) && !($a['time_in'] ?? null) => 'off',
                in_array($status, ['R', 'H'], true) => 'present', // working on rest day / holiday
                default => $cal->dayType($e, $date) !== null ? 'off' : 'not_in',
            };
            $inc = ['strength' => 1, $bucket => 1];
            if ($bucket === 'present' && (int)($a['late_minutes'] ?? 0) > 0) {
                $inc['late'] = 1;
            }
            if ($bucket === 'present' && $a['time_in'] && !$a['time_out']) {
                $inc['inside'] = 1;
            }
            foreach ($inc as $key => $v) {
                $depts[$k][$key] += $v;
                $tot[$key] += $v;
            }
        }
        usort($depts, fn($a, $b) => strcmp($a['department'], $b['department']));
        $recent = Database::all(
            "SELECT p.punch_time, p.source, e.code, e.name, e.name_ur, d.name AS department
               FROM attendance_punches p JOIN employees e ON e.id = p.employee_id JOIN departments d ON d.id = e.department_id
              WHERE p.punch_time >= ? ORDER BY p.punch_time DESC, p.id DESC LIMIT 12",
            [$date . ' 00:00:00']
        );
        return ['date' => $date, 'time' => date('H:i:s'), 'totals' => $tot, 'departments' => array_values($depts), 'recent' => $recent];
    }

    /** Shared-secret tokens for kiosk / TV pages (created on first use). */
    public static function token(string $key, bool $regenerate = false): string
    {
        $t = Settings::get($key);
        if ($regenerate || !is_string($t) || strlen($t) < 32) {
            $t = bin2hex(random_bytes(24));
            Settings::set($key, $t);
        }
        return $t;
    }

    public static function checkToken(string $key, ?string $given): bool
    {
        $t = Settings::get($key);
        return is_string($t) && strlen($t) >= 32 && is_string($given) && hash_equals($t, $given);
    }
}
