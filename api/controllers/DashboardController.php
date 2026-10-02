<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Database;
use App\Request;

/** Headcount dashboard (attendance, payroll and loan widgets are added in later batches). */
final class DashboardController
{
    public function summary(Request $r): array
    {
        $totals = Database::one(
            "SELECT COUNT(*) AS total,
                    SUM(status = 'active') AS active,
                    SUM(status = 'inactive') AS inactive,
                    SUM(status = 'active' AND emp_type = 'permanent') AS permanent,
                    SUM(status = 'active' AND emp_type = 'daily_wages') AS daily_wages,
                    SUM(status = 'active' AND emp_type = 'contract') AS contract,
                    SUM(status = 'active' AND joining_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) AS joined_this_month
               FROM employees"
        );
        $byDept = Database::all(
            "SELECT d.id, d.name, d.name_ur, COUNT(e.id) AS employees
               FROM departments d
          LEFT JOIN employees e ON e.department_id = d.id AND e.status = 'active'
              WHERE d.is_active = 1
           GROUP BY d.id, d.name, d.name_ur
           ORDER BY employees DESC, d.name"
        );
        $today = Database::one(
            "SELECT SUM(status IN ('P','HD','S')) AS present, SUM(status = 'A') AS absent,
                    SUM(status IN ('L','LW')) AS on_leave, SUM(late_minutes > 0) AS late
               FROM attendance_daily WHERE att_date = CURDATE()"
        );
        $holidays = Database::all(
            'SELECT holiday_date, name, name_ur FROM holidays WHERE holiday_date >= CURDATE() ORDER BY holiday_date LIMIT 5'
        );
        return [
            'totals'            => array_map('intval', $totals ?? []),
            'by_department'     => $byDept,
            'today'             => array_map('intval', $today ?? []),
            'upcoming_holidays' => $holidays,
        ];
    }
}
