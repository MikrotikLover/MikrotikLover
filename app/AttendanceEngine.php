<?php
declare(strict_types=1);

namespace App;

/**
 * Turns raw punches into daily attendance and validates manual entries.
 *
 * Rules
 *  - Working minutes are ALWAYS computed from Time In / Time Out (never typed).
 *  - Time Out must be after Time In; a manual Time Out earlier than Time In is accepted only for an
 *    overnight shift (it is then on the next day). More than 24 h is rejected; more than the
 *    "max_daily_hours" setting is accepted but flagged.
 *  - Shift break is deducted when the employee stayed more than half of the shift span.
 *  - Late = minutes after shift start, counted only when beyond the grace period.
 *  - Early leave = minutes before shift end. OT candidate = minutes after shift end when at least
 *    the shift's "min OT"; on rest days / holidays all worked minutes are OT candidates.
 *  - Half day (HD) when worked minutes are below the shift's half-day threshold.
 *
 * Daily post (idempotent, re-runnable for a date range):
 *  - Punch window for date D = shift start - 4 h .. shift end + 6 h, trimmed so it never overlaps
 *    the previous working day's shift end (+30 min) or the next working day's shift start (-2 h). Without a shift:
 *    the calendar day. First punch = In, last punch = Out. A punch is used for one date only.
 *  - Manual rows (voucher / edited) are kept unless "overwrite manual" is chosen.
 *  - No punches: holiday H, rest day R, approved leave L / LW, otherwise A.
 *    Future dates are never posted; today is posted only for employees who have punched.
 *  - Dates inside a posted salary month are skipped.
 */
final class AttendanceEngine
{
    private Calendar $cal;
    private int $maxHours;
    /** @var array<int,true> punch ids already used for an earlier date */
    private array $consumed = [];
    /** @var array<int,array<string,array{0:int,1:int}>> */
    private array $windows = [];

    public function __construct(string $from, string $to)
    {
        $this->cal = new Calendar($from, $to);
        $this->maxHours = min(24, max(1, (int)Settings::get('max_daily_hours', 16)));
    }

    public function calendar(): Calendar
    {
        return $this->cal;
    }

    // ------------------------------------------------------------------ calculation

    /** Gross span of a shift in minutes (end <= start = crosses midnight). */
    public static function span(array $shift): int
    {
        $s = self::toMinutes($shift['start_time']);
        $e = self::toMinutes($shift['end_time']);
        return $e > $s ? $e - $s : 1440 - $s + $e;
    }

    public static function toMinutes(string $t): int
    {
        [$h, $m] = array_map('intval', explode(':', $t));
        return $h * 60 + $m;
    }

    /**
     * @param ?string $dayType null working day, 'R' rest day, 'H' holiday
     * @return array{work_minutes:int,late_minutes:int,early_minutes:int,ot_minutes:int,is_flagged:int,flag_reason:?string,half_day:bool}
     */
    public function compute(?array $shift, string $date, ?int $inTs, ?int $outTs, ?string $dayType = null): array
    {
        $r = ['work_minutes' => 0, 'late_minutes' => 0, 'early_minutes' => 0, 'ot_minutes' => 0,
              'is_flagged' => 0, 'flag_reason' => null, 'half_day' => false];
        if ($inTs === null) {
            return $r;
        }
        $flags = [];
        if ($outTs === null) {
            $flags[] = 'Missing time out';
        } elseif ($outTs <= $inTs) {
            throw ApiException::validation(['time_out' => 'Time Out must be after Time In.']);
        }
        $elapsed = $outTs === null ? 0 : intdiv($outTs - $inTs, 60);
        if ($elapsed > 24 * 60) {
            throw ApiException::validation(['time_out' => 'Working time cannot exceed 24 hours.']);
        }
        if ($elapsed > $this->maxHours * 60) {
            $flags[] = "More than {$this->maxHours} hours";
        }

        if ($shift) {
            $span = self::span($shift);
            $startTs = strtotime("$date {$shift['start_time']}");
            $endTs = $startTs + $span * 60;
            $break = (int)$shift['break_minutes'];
            $work = $elapsed > intdiv($span, 2) ? max(0, $elapsed - $break) : $elapsed;
            $r['work_minutes'] = $work;
            $minOt = (int)$shift['min_ot_minutes'];
            if ($dayType === null) {
                $lateBy = intdiv($inTs - $startTs, 60);
                $r['late_minutes'] = $lateBy > (int)$shift['grace_minutes'] ? $lateBy : 0;
                if ($outTs !== null) {
                    $r['early_minutes'] = $outTs < $endTs ? intdiv($endTs - $outTs, 60) : 0;
                    $extra = intdiv($outTs - $endTs, 60);
                    $r['ot_minutes'] = $extra >= max(1, $minOt) ? $extra : 0;
                    $half = (int)$shift['half_day_minutes'];
                    $r['half_day'] = $half > 0 && $work < $half;
                }
            } elseif ($outTs !== null) {
                $r['ot_minutes'] = $work >= max(1, $minOt) ? $work : 0; // rest day / holiday work
            }
        } else {
            $r['work_minutes'] = $elapsed;
        }
        if ($flags) {
            $r['is_flagged'] = 1;
            $r['flag_reason'] = implode('; ', $flags);
        }
        return $r;
    }

    /**
     * Convert manual HH:MM times on a date to timestamps. Out <= In is allowed only for an
     * overnight shift (Out moves to the next day).
     * @return array{0:?int,1:?int}
     */
    public static function manualTimes(string $date, ?string $in, ?string $out, ?array $shift): array
    {
        if ($in === null && $out !== null) {
            throw ApiException::validation(['time_in' => 'Enter Time In before Time Out.']);
        }
        $inTs = $in === null ? null : strtotime("$date $in");
        $outTs = $out === null ? null : strtotime("$date $out");
        if ($inTs !== null && $outTs !== null && $outTs <= $inTs) {
            if ($shift && (int)$shift['is_overnight']) {
                $outTs += 86400;
            } else {
                throw ApiException::validation(['time_out' => 'Time Out must be after Time In (only overnight shifts may end the next day).']);
            }
        }
        return [$inTs, $outTs];
    }

    /**
     * Validate a manual entry (voucher grid / exception edit) and build the attendance row.
     * @param array $emp employees row
     * @param array $in  status, shift_id?, time_in? (HH:MM[:SS]), time_out?, remarks?
     */
    public function manualRow(array $emp, string $date, array $in): array
    {
        $who = "{$emp['code']} {$emp['name']}";
        if (!$this->cal->isEmployed($emp, $date)) {
            throw ApiException::validation(['status' => "$who cannot be marked on " . date('d-m-Y', strtotime($date))
                . ' (joined ' . date('d-m-Y', strtotime($emp['joining_date'])) . ($emp['leaving_date'] ? ', left ' . date('d-m-Y', strtotime($emp['leaving_date'])) : '') . ').']);
        }
        if ($date > date('Y-m-d')) {
            throw ApiException::validation(['status' => 'Attendance cannot be entered for a future date.']);
        }
        PayrollLock::assertOpen($emp['emp_type'], $date);
        $status = (string)($in['status'] ?? '');
        if (!in_array($status, ['P', 'A', 'L', 'LW', 'S', 'R', 'H', 'HD', 'O'], true)) {
            throw ApiException::validation(['status' => "Select a valid status for $who."]);
        }
        $timeIn = self::normTime($in['time_in'] ?? null);
        $timeOut = self::normTime($in['time_out'] ?? null);
        if (($timeIn || $timeOut) && !in_array($status, ['P', 'HD', 'S', 'R', 'H'], true)) {
            throw ApiException::validation(['time_in' => "$who: times can only be entered for P, HD, S, R or H."]);
        }
        $shiftId = isset($in['shift_id']) && $in['shift_id'] !== '' && $in['shift_id'] !== null ? (int)$in['shift_id'] : null;
        $shift = $shiftId ? $this->cal->shiftById($shiftId) : $this->cal->shift($emp, $date);
        if ($shiftId && !$shift) {
            throw ApiException::validation(['shift_id' => 'Selected shift does not exist.']);
        }
        try {
            [$inTs, $outTs] = self::manualTimes($date, $timeIn, $timeOut, $shift);
            $calc = $this->compute($shift, $date, $inTs, $outTs, in_array($status, ['R', 'H'], true) ? $status : null);
        } catch (ApiException $e) {
            throw ApiException::validation(array_map(fn($m) => "$who: $m", $e->errors()));
        }
        $remarks = trim((string)($in['remarks'] ?? ''));
        return [
            'employee_id'   => (int)$emp['id'],
            'att_date'      => $date,
            'shift_id'      => $shift ? (int)$shift['id'] : null,
            'status'        => $status,
            'time_in'       => $inTs ? date('Y-m-d H:i:s', $inTs) : null,
            'time_out'      => $outTs ? date('Y-m-d H:i:s', $outTs) : null,
            'work_minutes'  => $calc['work_minutes'],
            'late_minutes'  => $calc['late_minutes'],
            'early_minutes' => $calc['early_minutes'],
            'ot_minutes'    => in_array($status, ['P', 'S', 'R', 'H'], true) ? $calc['ot_minutes'] : 0,
            'source'        => 'manual',
            'is_flagged'    => $calc['is_flagged'],
            'flag_reason'   => $calc['flag_reason'],
            'remarks'       => $remarks === '' ? null : mb_substr($remarks, 0, 255),
        ];
    }

    private static function normTime(mixed $t): ?string
    {
        if ($t === null || trim((string)$t) === '') {
            return null;
        }
        if (!preg_match('/^([01]?\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/', trim((string)$t), $m)) {
            throw ApiException::validation(['time_in' => "Invalid time \"$t\" (use HH:MM)."]);
        }
        return sprintf('%02d:%s:00', (int)$m[1], $m[2]);
    }

    /** Save a row (insert or update by employee+date) and keep the overtime candidate in sync. */
    public static function saveRow(array $row, ?int $voucherId = null): int
    {
        $uid = Auth::id();
        $data = $row + ['voucher_id' => $voucherId, 'created_by' => $uid, 'updated_by' => $uid];
        $update = ['shift_id', 'status', 'time_in', 'time_out', 'work_minutes', 'late_minutes', 'early_minutes',
                   'ot_minutes', 'source', 'is_flagged', 'flag_reason', 'updated_by'];
        if (array_key_exists('remarks', $row)) {
            $update[] = 'remarks';
        }
        if ($voucherId !== null || ($row['source'] ?? '') === 'manual') {
            $update[] = 'voucher_id';
        }
        $id = Database::upsert('attendance_daily', $data, $update);
        self::syncOvertime($id, (int)$row['employee_id'], $row['att_date'], (int)$row['ot_minutes']);
        return $id;
    }

    /** OT candidate row: pending rows follow the computed value; decided rows keep the decision. */
    public static function syncOvertime(int $attId, int $empId, string $date, int $ot): void
    {
        $row = Database::one('SELECT * FROM overtime WHERE employee_id = ? AND ot_date = ?', [$empId, $date]);
        if ($row && $row['salary_sheet_id']) {
            return; // consumed by payroll
        }
        $uid = Auth::id();
        if ($ot <= 0) {
            if ($row && $row['status'] === 'pending' && (int)$row['computed_minutes'] > 0) {
                Database::run('DELETE FROM overtime WHERE id = ?', [$row['id']]);
            } elseif ($row && (int)$row['computed_minutes'] !== 0) {
                Database::update('overtime', ['computed_minutes' => 0, 'attendance_id' => $attId, 'updated_by' => $uid], 'id = :id', ['id' => $row['id']]);
            }
            return;
        }
        if (!$row) {
            Database::insert('overtime', [
                'employee_id' => $empId, 'ot_date' => $date, 'attendance_id' => $attId, 'computed_minutes' => $ot,
                'approved_minutes' => $ot, 'status' => 'pending', 'created_by' => $uid,
            ]);
        } elseif ($row['status'] === 'pending') {
            Database::update('overtime', ['computed_minutes' => $ot, 'approved_minutes' => $ot, 'attendance_id' => $attId, 'updated_by' => $uid],
                'id = :id', ['id' => $row['id']]);
        } elseif ((int)$row['computed_minutes'] !== $ot) {
            Database::update('overtime', ['computed_minutes' => $ot, 'attendance_id' => $attId, 'updated_by' => $uid], 'id = :id', ['id' => $row['id']]);
        }
    }

    // ------------------------------------------------------------------ posting

    /** Link punches of machine IDs that were enrolled after the punch was received. */
    public static function remapPunches(): int
    {
        $n = Database::run(
            'UPDATE attendance_punches p JOIN employees e ON e.machine_id = p.machine_id
                SET p.employee_id = e.id WHERE p.employee_id IS NULL AND p.machine_id IS NOT NULL'
        )->rowCount();
        return $n;
    }

    /** @return array{0:?array,1:int,2:int} [shift, windowStart, windowEnd] */
    public function window(array $emp, string $date): array
    {
        $shift = $this->cal->shift($emp, $date);
        if ($shift) {
            $s = strtotime("$date {$shift['start_time']}");
            $ws = $s - 4 * 3600;
            $we = $s + self::span($shift) * 60 + 6 * 3600;
        } else {
            $ws = strtotime("$date 00:00:00");
            $we = $ws + 86399;
        }
        $prevDate = date('Y-m-d', strtotime("$date -1 day"));
        // Neighbouring days only limit the window when they are working days (a rest day /
        // holiday has no shift to protect, e.g. Saturday night shift ending Sunday morning).
        $prev = $this->cal->dayType($emp, $prevDate) === null ? $this->cal->shift($emp, $prevDate) : null;
        if ($prev) {
            $prevEnd = strtotime("$prevDate {$prev['start_time']}") + self::span($prev) * 60;
            $ws = max($ws, $prevEnd + 1800);
        }
        $nextDate = date('Y-m-d', strtotime("$date +1 day"));
        $next = $this->cal->dayType($emp, $nextDate) === null ? $this->cal->shift($emp, $nextDate) : null;
        if ($next) {
            $we = min($we, strtotime("$nextDate {$next['start_time']}") - 7200);
        }
        return [$shift, $ws, $we];
    }

    /**
     * Post attendance for a date range.
     * @param array{department_id?:?int, employee_ids?:?array, overwrite_manual?:bool, only_with_punches?:bool} $opt
     */
    public function post(string $from, string $to, array $opt = []): array
    {
        $today = date('Y-m-d');
        if ($to > $today) {
            $to = $today;
        }
        $sum = ['from' => $from, 'to' => $to, 'employees' => 0, 'posted' => 0, 'present' => 0, 'absent' => 0,
                'kept_manual' => 0, 'locked' => 0, 'flagged' => 0, 'ot_candidates' => 0, 'remapped' => self::remapPunches()];
        if ($from > $to) {
            return $sum;
        }

        $where = ['e.joining_date <= :to', '(e.leaving_date IS NULL OR e.leaving_date >= :from)',
                  "(e.status = 'active' OR e.leaving_date IS NOT NULL)"];
        $params = ['to' => $to, 'from' => $from];
        if (!empty($opt['department_id'])) {
            $where[] = 'e.department_id = :dept';
            $params['dept'] = (int)$opt['department_id'];
        }
        if (!empty($opt['employee_ids'])) {
            $ph = [];
            foreach (array_values($opt['employee_ids']) as $i => $id) {
                $ph[] = ":e$i";
                $params["e$i"] = (int)$id;
            }
            $where[] = 'e.id IN (' . implode(',', $ph) . ')';
        }
        $emps = Database::all('SELECT e.* FROM employees e WHERE ' . implode(' AND ', $where) . ' ORDER BY e.id', $params);
        if (!$emps) {
            return $sum;
        }
        $ids = array_map(fn($e) => (int)$e['id'], $emps);
        $in = implode(',', $ids); // integers only

        $punches = [];
        foreach (Database::all(
            "SELECT id, employee_id, punch_time, source FROM attendance_punches
              WHERE employee_id IN ($in) AND punch_time BETWEEN ? AND ? ORDER BY employee_id, punch_time, id",
            [date('Y-m-d 00:00:00', strtotime("$from -1 day")), date('Y-m-d 23:59:59', strtotime("$to +2 day"))]
        ) as $p) {
            $p['ts'] = strtotime($p['punch_time']);
            $punches[(int)$p['employee_id']][] = $p;
        }
        $existing = [];
        foreach (Database::all("SELECT id, employee_id, att_date, source, status FROM attendance_daily WHERE employee_id IN ($in) AND att_date BETWEEN ? AND ?", [$from, $to]) as $r) {
            $existing[(int)$r['employee_id']][$r['att_date']] = $r;
        }
        $leaves = [];
        foreach (Database::all(
            "SELECT l.employee_id, l.from_date, l.to_date, t.is_paid FROM leave_register l JOIN leave_types t ON t.id = l.leave_type_id
              WHERE l.status = 'approved' AND l.employee_id IN ($in) AND l.from_date <= ? AND l.to_date >= ?",
            [$to, $from]
        ) as $l) {
            foreach (Calendar::dates(max($l['from_date'], $from), min($l['to_date'], $to)) as $d) {
                $leaves[(int)$l['employee_id']][$d] = (int)$l['is_paid'] ? 'L' : 'LW';
            }
        }

        $dates = Calendar::dates($from, $to);
        $usedPunchIds = [];
        foreach ($emps as $emp) {
            $eid = (int)$emp['id'];
            $sum['employees']++;
            foreach ($dates as $date) {
                if (!$this->cal->isEmployed($emp, $date)) {
                    continue;
                }
                [$shift, $ws, $we] = $this->window($emp, $date);
                $this->windows[$eid][$date] = [$ws, $we];
                $dayPunches = [];
                foreach ($punches[$eid] ?? [] as $p) {
                    if ($p['ts'] >= $ws && $p['ts'] <= $we && !isset($this->consumed[(int)$p['id']])) {
                        $dayPunches[] = $p;
                    }
                }
                foreach ($dayPunches as $p) {
                    $this->consumed[(int)$p['id']] = true; // never reuse for the next date
                }
                if (PayrollLock::isLocked($emp['emp_type'], $date)) {
                    $sum['locked']++;
                    continue;
                }
                $ex = $existing[$eid][$date] ?? null;
                if ($ex && $ex['source'] === 'manual' && empty($opt['overwrite_manual'])) {
                    $sum['kept_manual']++;
                    continue;
                }
                if (!$dayPunches && (!empty($opt['only_with_punches']))) {
                    continue;
                }
                $dayType = $this->cal->dayType($emp, $date);
                $leave = $leaves[$eid][$date] ?? null;
                if (!$dayPunches && $date === $today && $dayType === null && !$leave) {
                    continue; // not in yet today
                }

                if ($dayPunches) {
                    $inTs = $dayPunches[0]['ts'];
                    $last = end($dayPunches);
                    $outTs = count($dayPunches) > 1 ? $last['ts'] : null;
                    if ($outTs !== null && $outTs - $inTs < 60) {
                        $outTs = null; // double punch within a minute = single punch
                    }
                    $calc = $this->compute($shift, $date, $inTs, $outTs, in_array($dayType, ['R', 'H'], true) ? $dayType : null);
                    $status = match (true) {
                        $dayType === 'R', $dayType === 'H' => $dayType,
                        $date === $emp['joining_date'] => 'S',
                        $calc['half_day'] => 'HD',
                        default => 'P',
                    };
                    if ($leave) {
                        $calc['is_flagged'] = 1;
                        $calc['flag_reason'] = trim(($calc['flag_reason'] ? $calc['flag_reason'] . '; ' : '') . 'Worked during approved leave');
                    }
                    $source = $dayPunches[0]['source'] === 'manual' ? 'machine' : $dayPunches[0]['source'];
                    $row = [
                        'employee_id' => $eid, 'att_date' => $date, 'shift_id' => $shift ? (int)$shift['id'] : null,
                        'status' => $status,
                        'time_in' => date('Y-m-d H:i:s', $inTs), 'time_out' => $outTs ? date('Y-m-d H:i:s', $outTs) : null,
                        'work_minutes' => $calc['work_minutes'], 'late_minutes' => $calc['late_minutes'],
                        'early_minutes' => $calc['early_minutes'], 'ot_minutes' => $calc['ot_minutes'],
                        'source' => $source, 'is_flagged' => $calc['is_flagged'], 'flag_reason' => $calc['flag_reason'],
                    ];
                    foreach ($dayPunches as $p) {
                        $usedPunchIds[] = (int)$p['id'];
                    }
                    $sum['present'] += in_array($status, ['P', 'S', 'HD'], true) ? 1 : 0;
                    $sum['ot_candidates'] += $calc['ot_minutes'] > 0 ? 1 : 0;
                    $sum['flagged'] += $calc['is_flagged'];
                } else {
                    $status = $dayType ?? $leave ?? 'A';
                    $row = [
                        'employee_id' => $eid, 'att_date' => $date, 'shift_id' => $shift ? (int)$shift['id'] : null,
                        'status' => $status, 'time_in' => null, 'time_out' => null, 'work_minutes' => 0, 'late_minutes' => 0,
                        'early_minutes' => 0, 'ot_minutes' => 0, 'source' => 'system', 'is_flagged' => 0, 'flag_reason' => null,
                    ];
                    $sum['absent'] += $status === 'A' ? 1 : 0;
                }
                self::saveRow($row);
                $sum['posted']++;
            }
        }
        foreach (array_chunk($usedPunchIds, 500) as $chunk) {
            Database::run('UPDATE attendance_punches SET is_processed = 1 WHERE id IN (' . implode(',', $chunk) . ')');
        }
        return $sum;
    }

    /**
     * Real-time post after a single punch (kiosk / device push): re-posts the punch date and the
     * previous date for that employee (only dates with punches), returns the attendance row the
     * punch belongs to.
     */
    public static function postPunch(int $employeeId, int $ts): ?array
    {
        $d = date('Y-m-d', $ts);
        $prev = date('Y-m-d', $ts - 86400);
        $engine = new self($prev, $d);
        $engine->post($prev, $d, ['employee_ids' => [$employeeId], 'only_with_punches' => true]);
        foreach ([$d, $prev] as $date) {
            [$ws, $we] = $engine->windows[$employeeId][$date] ?? [0, -1];
            if ($ts >= $ws && $ts <= $we) {
                return Database::one('SELECT * FROM attendance_daily WHERE employee_id = ? AND att_date = ?', [$employeeId, $date]);
            }
        }
        return null;
    }
}
