<?php
declare(strict_types=1);

namespace App;

/**
 * Daily attendance posting: once an admin has verified a date it is posted (locked). Attendance of a
 * posted date cannot be entered, edited, deleted, re-processed from punches or filled by leave until an
 * admin unposts it (audit-logged). Raw punches keep arriving and are applied after an unpost.
 * Overtime approval and vouchers are not affected (they have their own workflow and the payroll lock).
 */
final class DayLock
{
    /** @var array<string,true>|null */
    private static ?array $posted = null;

    public static function reset(): void
    {
        self::$posted = null;
    }

    public static function isPosted(string $date): bool
    {
        if (self::$posted === null) {
            self::$posted = array_fill_keys(Database::column('SELECT att_date FROM attendance_day_posts'), true);
        }
        return isset(self::$posted[$date]);
    }

    public static function assertOpen(string $date, string $what = 'Attendance'): void
    {
        if (self::isPosted($date)) {
            throw ApiException::conflict("$what: attendance of " . date('d-m-Y', strtotime($date))
                . ' is posted (locked). An administrator must unpost the date first.');
        }
    }

    /** Posted dates in a range with who / when. */
    public static function list(string $from, string $to): array
    {
        return Database::all(
            'SELECT p.att_date, p.remarks, p.posted_at, u.full_name AS posted_by_name
               FROM attendance_day_posts p LEFT JOIN users u ON u.id = p.posted_by
              WHERE p.att_date BETWEEN ? AND ? ORDER BY p.att_date',
            [$from, $to]
        );
    }

    /**
     * Post (lock) every date in the range. Refused while any row of those dates still has a missing
     * time out (it must be corrected first: hours are never invented). Already-posted dates are skipped.
     */
    public static function post(string $from, string $to, ?string $remarks): array
    {
        if ($to > date('Y-m-d')) {
            throw ApiException::validation(['to' => 'Future dates cannot be posted.']);
        }
        if ((strtotime($to) - strtotime($from)) / 86400 > 31) {
            throw ApiException::validation(['to' => 'Post at most 31 days at a time.']);
        }
        $missing = Database::all(
            "SELECT a.att_date, e.code, e.name FROM attendance_daily a JOIN employees e ON e.id = a.employee_id
              WHERE a.att_date BETWEEN ? AND ? AND a.time_in IS NOT NULL AND a.time_out IS NULL AND a.status IN ('P','HD','S')
              ORDER BY a.att_date, e.code LIMIT 11",
            [$from, $to]
        );
        if ($missing) {
            $list = array_map(fn($m) => date('d-m', strtotime($m['att_date'])) . " {$m['code']} {$m['name']}", array_slice($missing, 0, 10));
            throw ApiException::conflict('Correct the missing time out first: ' . implode(', ', $list) . (count($missing) > 10 ? ' …' : '') . '.');
        }
        return Database::transaction(function () use ($from, $to, $remarks) {
            $done = [];
            foreach (Calendar::dates($from, $to) as $d) {
                if (Database::value('SELECT 1 FROM attendance_day_posts WHERE att_date = ?', [$d])) {
                    continue;
                }
                Database::insert('attendance_day_posts', ['att_date' => $d, 'remarks' => $remarks, 'posted_by' => Auth::id()]);
                $done[] = $d;
            }
            if ($done) {
                Audit::log('post', 'attendance_day_posts', null, null, ['dates' => $done, 'remarks' => $remarks,
                    'rows' => (int)Database::value('SELECT COUNT(*) FROM attendance_daily WHERE att_date BETWEEN ? AND ?', [$from, $to])]);
            }
            self::reset();
            return ['posted' => $done];
        });
    }

    /** Admin unpost of one date, with a required reason (audit-logged). */
    public static function unpost(string $date, string $reason): void
    {
        Database::transaction(function () use ($date, $reason) {
            $row = Database::one('SELECT * FROM attendance_day_posts WHERE att_date = ? FOR UPDATE', [$date]);
            if (!$row) {
                throw ApiException::notFound('Posted date');
            }
            Database::run('DELETE FROM attendance_day_posts WHERE att_date = ?', [$date]);
            Audit::log('unpost', 'attendance_day_posts', null, $row, ['att_date' => $date, 'reason' => $reason]);
            self::reset();
        });
    }
}
