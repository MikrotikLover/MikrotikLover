<?php
declare(strict_types=1);

namespace App;

/**
 * Posted salary sheets lock their period: attendance, overtime, leave and vouchers inside a posted
 * period cannot be changed. Two independent rules, either one locks:
 *   by type      daily-wages employees are locked by daily-wages sheets, everyone else (permanent /
 *                contract) by permanent sheets;
 *   by employee  an employee who has a line on any posted sheet is locked for that sheet's period,
 *                whatever their current type (so changing the type cannot reopen paid days).
 * Date-keyed data (attendance, OT, leave) uses isLocked(); month-keyed data (vouchers' salary month,
 * loan installments' due month) uses isMonthLocked(), which compares the sheet's salary month.
 */
final class PayrollLock
{
    private static ?array $periods = null;
    /** @var array<int,array> employee_id => posted sheets with a line for that employee */
    private static array $byEmployee = [];

    public static function reset(): void
    {
        self::$periods = null;
        self::$byEmployee = [];
    }

    private static function periods(): array
    {
        if (self::$periods === null) {
            self::$periods = Database::all("SELECT id, sheet_type, period_from, period_to, salary_month FROM salary_sheets WHERE status = 'posted'");
        }
        return self::$periods;
    }

    private static function employeeSheets(int $employeeId): array
    {
        return self::$byEmployee[$employeeId] ??= Database::all(
            "SELECT s.period_from, s.period_to, s.salary_month FROM salary_sheets s
               JOIN salary_sheet_lines l ON l.salary_sheet_id = s.id
              WHERE s.status = 'posted' AND l.employee_id = ?",
            [$employeeId]
        );
    }

    private static function group(string $empType): string
    {
        return $empType === 'daily_wages' ? 'daily_wages' : 'permanent';
    }

    public static function isLocked(string $empType, string $date, ?int $employeeId = null): bool
    {
        $type = self::group($empType);
        foreach (self::periods() as $p) {
            if ($p['sheet_type'] === $type && $date >= $p['period_from'] && $date <= $p['period_to']) {
                return true;
            }
        }
        if ($employeeId) {
            foreach (self::employeeSheets($employeeId) as $p) {
                if ($date >= $p['period_from'] && $date <= $p['period_to']) {
                    return true;
                }
            }
        }
        return false;
    }

    /** Salary month (any day of it) already posted for this type / employee. */
    public static function isMonthLocked(string $empType, string $month, ?int $employeeId = null): bool
    {
        $m = substr($month, 0, 7) . '-01';
        $type = self::group($empType);
        foreach (self::periods() as $p) {
            if ($p['sheet_type'] === $type && $p['salary_month'] === $m) {
                return true;
            }
        }
        if ($employeeId) {
            foreach (self::employeeSheets($employeeId) as $p) {
                if ($p['salary_month'] === $m) {
                    return true;
                }
            }
        }
        return false;
    }

    public static function assertOpen(string $empType, string $date, string $what = 'Attendance', ?int $employeeId = null): void
    {
        if (self::isLocked($empType, $date, $employeeId)) {
            throw ApiException::conflict("$what on " . date('d-m-Y', strtotime($date)) . ' belongs to a posted salary month and cannot be changed.');
        }
    }

    public static function assertMonthOpen(string $empType, string $month, string $what, ?int $employeeId = null): void
    {
        if (self::isMonthLocked($empType, $month, $employeeId)) {
            throw ApiException::conflict("$what: salary for " . date('F Y', strtotime(substr($month, 0, 7) . '-01')) . ' is already posted.');
        }
    }
}
