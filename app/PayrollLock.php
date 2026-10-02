<?php
declare(strict_types=1);

namespace App;

/**
 * Posted salary sheets lock their period: attendance, overtime and leave inside a posted
 * period cannot be changed. Daily-wages employees are locked by daily-wages sheets,
 * everyone else (permanent / contract) by permanent sheets.
 */
final class PayrollLock
{
    private static ?array $periods = null;

    public static function reset(): void
    {
        self::$periods = null;
    }

    private static function periods(): array
    {
        if (self::$periods === null) {
            self::$periods = Database::all("SELECT sheet_type, period_from, period_to FROM salary_sheets WHERE status = 'posted'");
        }
        return self::$periods;
    }

    public static function isLocked(string $empType, string $date): bool
    {
        $type = $empType === 'daily_wages' ? 'daily_wages' : 'permanent';
        foreach (self::periods() as $p) {
            if ($p['sheet_type'] === $type && $date >= $p['period_from'] && $date <= $p['period_to']) {
                return true;
            }
        }
        return false;
    }

    public static function assertOpen(string $empType, string $date, string $what = 'Attendance'): void
    {
        if (self::isLocked($empType, $date)) {
            throw ApiException::conflict("$what on " . date('d-m-Y', strtotime($date)) . ' belongs to a posted salary month and cannot be changed.');
        }
    }
}
