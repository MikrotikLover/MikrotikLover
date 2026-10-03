<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Database;
use App\Request;

/** Dashboard: headcount, today's attendance, 14-day trend, pending work, payroll and loans (each part by permission). */
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
        $out = [
            'totals'            => array_map('intval', $totals ?? []),
            'by_department'     => $byDept,
            'today'             => array_map('intval', $today ?? []),
            'upcoming_holidays' => $holidays,
            'pending'           => [],
        ];

        if (Auth::can('attendance', 'view')) {
            $from = date('Y-m-d', strtotime('-13 days'));
            $rows = [];
            foreach (Database::all(
                "SELECT att_date, SUM(status IN ('P','HD','S')) AS present, SUM(status = 'A') AS absent,
                        SUM(status IN ('L','LW')) AS on_leave, SUM(late_minutes > 0) AS late
                   FROM attendance_daily WHERE att_date BETWEEN ? AND CURDATE() GROUP BY att_date",
                [$from]
            ) as $t) {
                $rows[$t['att_date']] = $t;
            }
            $trend = [];
            for ($d = $from; $d <= date('Y-m-d'); $d = date('Y-m-d', strtotime($d . ' +1 day'))) {
                $t = $rows[$d] ?? [];
                $trend[] = ['date' => $d, 'present' => (int)($t['present'] ?? 0), 'absent' => (int)($t['absent'] ?? 0),
                            'on_leave' => (int)($t['on_leave'] ?? 0), 'late' => (int)($t['late'] ?? 0)];
            }
            $out['trend'] = $trend;
        }
        $pending = [];
        if (Auth::can('attendance_post', 'view')) {
            $p = Database::one('SELECT COUNT(*) n, COUNT(DISTINCT DATE(punch_time)) d FROM attendance_punches WHERE is_processed = 0 AND employee_id IS NOT NULL');
            $pending[] = ['key' => 'punches', 'label' => 'Punches not posted', 'count' => (int)$p['n'], 'note' => (int)$p['d'] . ' day(s)', 'path' => '/attendance/post'];
            $u = (int)Database::value('SELECT COUNT(DISTINCT machine_id) FROM attendance_punches WHERE employee_id IS NULL');
            $pending[] = ['key' => 'unmapped', 'label' => 'Unknown machine IDs', 'count' => $u, 'note' => 'link to employees', 'path' => '/attendance/post'];
        }
        if (Auth::can('overtime', 'view')) {
            $pending[] = ['key' => 'overtime', 'label' => 'Overtime to approve', 'count' => (int)Database::value("SELECT COUNT(*) FROM overtime WHERE status = 'pending'"), 'path' => '/overtime'];
        }
        if (Auth::can('leave', 'view')) {
            $pending[] = ['key' => 'leave', 'label' => 'Leave applications', 'count' => (int)Database::value("SELECT COUNT(*) FROM leave_register WHERE status = 'pending'"), 'path' => '/leaves'];
        }
        if (Auth::can('vouchers', 'view')) {
            $pending[] = ['key' => 'vouchers', 'label' => 'Draft vouchers', 'count' => (int)Database::value("SELECT COUNT(*) FROM vouchers WHERE status = 'draft' AND deleted_at IS NULL"), 'path' => '/vouchers/adv'];
        }
        if (Auth::can('salary', 'view')) {
            $pending[] = ['key' => 'salary', 'label' => 'Draft salary sheets', 'count' => (int)Database::value("SELECT COUNT(*) FROM salary_sheets WHERE status = 'draft'"), 'path' => '/salary/permanent'];
            $out['payroll'] = Database::all(
                "SELECT s.salary_month, s.sheet_type, s.status, COUNT(l.id) employees, COALESCE(SUM(l.gross),0) gross, COALESCE(SUM(l.net_salary),0) net
                   FROM salary_sheets s LEFT JOIN salary_sheet_lines l ON l.salary_sheet_id = s.id
                  WHERE s.salary_month >= DATE_SUB(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 6 MONTH)
               GROUP BY s.id ORDER BY s.salary_month DESC, s.sheet_type"
            );
        }
        if (Auth::can('loans', 'view')) {
            $out['loans'] = Database::one(
                "SELECT COUNT(*) AS active, COALESCE(SUM(l.amount - (SELECT COALESCE(SUM(x.deducted_amount),0) FROM loan_installments x WHERE x.loan_id = l.id)),0) AS balance
                   FROM loans l JOIN vouchers v ON v.id = l.voucher_id WHERE l.status = 'active' AND v.status = 'posted' AND v.deleted_at IS NULL"
            );
        }
        if (Auth::can('vouchers', 'view')) {
            $out['month_vouchers'] = Database::all(
                "SELECT voucher_type, COUNT(*) n, SUM(amount) amount FROM vouchers
                  WHERE status = 'posted' AND deleted_at IS NULL AND voucher_type IN ('ADV','INC','PEN')
                    AND deduct_month = DATE_FORMAT(CURDATE(), '%Y-%m-01') GROUP BY voucher_type"
            );
        }
        $out['pending'] = $pending;
        return $out;
    }
}
