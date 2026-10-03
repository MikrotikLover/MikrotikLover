<?php
declare(strict_types=1);

namespace App;

/**
 * Salary sheet workflow: Show (build) -> Save (draft) -> Post (lock + consume vouchers + loan
 * installments + overtime + salary JV). Calculation itself lives in PayrollEngine.
 *
 * Sources per employee and period
 *   attendance_daily   P/S = 1 day, HD = worked minutes / shift net minutes, R = rest day, H = paid holiday
 *                      (rest), L = paid leave, LW = leave without pay, A = absent, missing row = unmarked (unpaid)
 *   salary_increments  pay rate (monthly basic / daily rate) via Increments::getSalaryOnDate(): the period is
 *                      split at increment effective dates and each part is paid pro rata; each OT date
 *                      is priced with the salary effective on that date
 *   employee_salary_history  other salary terms (allowances, OT applicability / fixed OT rate, statutory
 *                      flags, payment mode) from the record effective on the last day of the period
 *   overtime           approved minutes in the period
 *   vouchers           posted ADV / INC / PEN / OT whose salary month = the sheet's month
 *   loan_installments  scheduled / adjusted installments due in the sheet's month (posted, active loans)
 *   statutory_rates / tax_slabs   rows effective on the last day of the period
 * Posted sheets lock their period (PayrollLock) and are never edited.
 */
final class Payroll
{
    public const TYPES = ['permanent' => 'Permanent', 'daily_wages' => 'Daily Wages'];
    /** Numeric line columns compared before posting (data must not have changed since saving). */
    private const CHECK = ['paid_days', 'work_pay', 'allowance_pay', 'ot_amount', 'gross', 'advance', 'loan_deduction', 'incentive', 'penalty',
        'advance_carried', 'penalty_carried', 'fine_carried',
        'fine', 'eobi', 'pessi', 'income_tax', 'net_salary'];

    public static function month(string $to): string
    {
        return substr($to, 0, 7) . '-01';
    }

    public static function validatePeriod(string $type, string $from, string $to): void
    {
        $errors = [];
        if (!isset(self::TYPES[$type])) {
            $errors['sheet_type'] = 'Choose Permanent or Daily Wages.';
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $from) || !strtotime($from)) {
            $errors['period_from'] = 'Enter the From date.';
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $to) || !strtotime($to)) {
            $errors['period_to'] = 'Enter the To date.';
        }
        if (!$errors) {
            $len = (strtotime($to . ' 12:00') - strtotime($from . ' 12:00')) / 86400 + 1;
            if ($len < 1) {
                $errors['period_to'] = 'To date must be on or after the From date.';
            } elseif ($len > 31) {
                $errors['period_to'] = 'A salary period can be at most 31 days.';
            }
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
    }

    private static function empTypes(string $type): array
    {
        return $type === 'daily_wages' ? ['daily_wages'] : ['permanent', 'contract'];
    }

    /** Latest row per key effective on $date. */
    private static function effective(string $sql, array $params): array
    {
        return Database::all($sql, $params);
    }

    /**
     * Build all lines (nothing is written).
     * @param array<int,array{fine?:float,remarks?:?string}> $manual per employee manual inputs (fine, remarks)
     */
    public static function build(string $type, string $from, string $to, ?int $sheetId = null, array $manual = []): array
    {
        self::validatePeriod($type, $from, $to);
        $month = self::month($to);
        $basis = (string)Settings::get('salary_day_basis', 'calendar');
        $days = PayrollEngine::daysInMonth($basis, $from, $to);
        $engine = PayrollEngine::fromSettings();
        $cal = new Calendar($from, $to);
        $sid = $sheetId ?? 0;

        $types = self::empTypes($type);
        $emps = Database::all(
            'SELECT e.*, d.name AS department, d.name_ur AS department_ur, g.name AS designation
               FROM employees e JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              WHERE e.emp_type IN (' . implode(',', array_map(fn($t) => Database::pdo()->quote($t), $types)) . ')
                AND e.joining_date <= :to AND (e.leaving_date IS NULL OR e.leaving_date >= :from)
                AND (e.status = \'active\' OR e.leaving_date IS NOT NULL)
              ORDER BY d.name, e.code',
            ['to' => $to, 'from' => $from]
        );
        $out = ['type' => $type, 'from' => $from, 'to' => $to, 'month' => $month, 'days' => $days, 'basis' => $basis,
                'lines' => [], 'used' => ['vouchers' => [], 'overtime' => [], 'installments' => []]];
        if (!$emps) {
            $out['totals'] = self::totals([]);
            return $out;
        }
        $ids = array_map(fn($e) => (int)$e['id'], $emps);
        $in = implode(',', $ids);

        Increments::prefetch($ids);
        // salary terms effective on the last day of the period (the rate itself comes from salary_increments)
        $sal = [];
        foreach (Database::all("SELECT * FROM employee_salary_history WHERE employee_id IN ($in) AND effective_from <= ? ORDER BY employee_id, effective_from", [$to]) as $h) {
            $sal[(int)$h['employee_id']] = $h; // later rows overwrite earlier ones
        }
        // attendance + shift length
        $att = [];
        foreach (Database::all(
            "SELECT a.employee_id, a.att_date, a.status, a.work_minutes, s.duration_minutes
               FROM attendance_daily a LEFT JOIN shifts s ON s.id = a.shift_id
              WHERE a.employee_id IN ($in) AND a.att_date BETWEEN ? AND ?",
            [$from, $to]
        ) as $a) {
            $att[(int)$a['employee_id']][$a['att_date']] = $a;
        }
        // approved overtime not yet paid
        $ot = [];
        foreach (Database::all(
            "SELECT id, employee_id, ot_date, approved_minutes FROM overtime
              WHERE employee_id IN ($in) AND status = 'approved' AND ot_date BETWEEN ? AND ? AND (salary_sheet_id IS NULL OR salary_sheet_id = ?)",
            [$from, $to, $sid]
        ) as $o) {
            $ot[(int)$o['employee_id']][] = $o;
        }
        // posted vouchers for this salary month
        $vch = [];
        foreach (Database::all(
            "SELECT id, employee_id, voucher_type, vr_date, amount, ot_hours FROM vouchers
              WHERE employee_id IN ($in) AND voucher_type IN ('ADV','INC','PEN','OT') AND status = 'posted' AND deleted_at IS NULL
                AND deduct_month " . ($type === 'daily_wages' ? '<=' : '=') . " ? AND (salary_sheet_id IS NULL OR salary_sheet_id = ?)",
            [$month, $sid]
        ) as $v) {
            $vch[(int)$v['employee_id']][] = $v;
        }
        // loan installments due this month
        $inst = [];
        foreach (Database::all(
            "SELECT li.id, li.loan_id, li.scheduled_amount, l.employee_id, l.amount AS loan_amount,
                    (SELECT COALESCE(SUM(x.deducted_amount),0) FROM loan_installments x WHERE x.loan_id = l.id AND x.status = 'deducted') AS deducted_before
               FROM loan_installments li
               JOIN loans l ON l.id = li.loan_id
               JOIN vouchers v ON v.id = l.voucher_id
              WHERE l.employee_id IN ($in) AND li.due_month " . ($type === 'daily_wages' ? '<=' : '=') . " ? AND li.status IN ('scheduled','adjusted')
                AND l.status = 'active' AND v.status = 'posted' AND v.deleted_at IS NULL
              ORDER BY l.id",
            [$month]
        ) as $i) {
            $inst[(int)$i['employee_id']][] = $i;
        }
        // other outstanding loan balances (loans with no installment this month)
        $loanBal = [];
        foreach (Database::all(
            "SELECT l.employee_id, SUM(l.amount - (SELECT COALESCE(SUM(x.deducted_amount),0) FROM loan_installments x WHERE x.loan_id = l.id AND x.status = 'deducted')) bal
               FROM loans l JOIN vouchers v ON v.id = l.voucher_id
              WHERE l.employee_id IN ($in) AND l.status = 'active' AND v.status = 'posted' AND v.deleted_at IS NULL GROUP BY l.employee_id"
        ) as $b) {
            $loanBal[(int)$b['employee_id']] = (float)$b['bal'];
        }
        // days already paid to an employee on another posted sheet (e.g. the employee type changed)
        $paidElsewhere = [];
        foreach (Database::all(
            "SELECT l.employee_id, s.period_from, s.period_to, s.sheet_type FROM salary_sheet_lines l JOIN salary_sheets s ON s.id = l.salary_sheet_id
              WHERE s.status = 'posted' AND s.id <> ? AND s.period_from <= ? AND s.period_to >= ? AND l.employee_id IN ($in)",
            [$sid, $to, $from]
        ) as $pe) {
            $paidElsewhere[(int)$pe['employee_id']][] = $pe;
        }
        // statutory rates and tax slabs effective on the last day
        $rates = [];
        foreach (Database::all('SELECT * FROM statutory_rates WHERE effective_from <= ? ORDER BY code, effective_from', [$to]) as $r) {
            $rates[$r['code']] = $r;
        }
        $ss = (string)Settings::get('social_security', 'PESSI');
        $slabFrom = Database::value('SELECT MAX(effective_from) FROM tax_slabs WHERE effective_from <= ?', [$to]);
        $slabs = $slabFrom ? Database::all('SELECT * FROM tax_slabs WHERE effective_from = ? ORDER BY income_from', [$slabFrom]) : [];

        foreach ($emps as $e) {
            $eid = (int)$e['id'];
            $h = $sal[$eid] ?? null;
            $daily = $type === 'daily_wages';
            $rateAtEnd = Increments::getSalaryOnDate($eid, $to);
            $warn = [];
            if (!$h) {
                $warn[] = 'No salary info record effective in this period (allowances, OT and statutory not applied)';
            }
            // salary segments: the period split at increment effective dates
            $segs = [];
            foreach (Increments::segments($eid, $from, $to) as $sg) {
                $segs[] = $sg + ['work_days' => 0.0, 'rest_days' => 0.0, 'paid_leave' => 0.0, 'unpaid_days' => 0.0, 'len' => 0];
            }
            if (Money::toPaisa($rateAtEnd) <= 0 && !array_filter($segs, fn($sg) => Money::toPaisa($sg['salary']) > 0)) {
                $warn[] = 'No salary effective in this period (add a salary increment)';
            }
            // attendance summary (totals in $c; the same counts per salary segment in $segs)
            $c = ['work' => 0.0, 'rest' => 0.0, 'holiday' => 0.0, 'leave' => 0.0, 'lwop' => 0.0, 'absent' => 0.0, 'unmarked' => 0.0];
            $unpaid = 0.0;   // days in the period that earn nothing (used by the fixed 30 / 26 day bases)
            $elsewhere = 0;
            $hdNoTime = 0;
            $si = 0;
            foreach (Calendar::dates($from, $to) as $d) {
                while (isset($segs[$si + 1]) && $d >= $segs[$si + 1]['from']) {
                    $si++;
                }
                $seg = &$segs[$si];
                $seg['len']++;
                if (!$cal->isEmployed($e, $d)) {
                    $unpaid++;
                    $seg['unpaid_days']++;
                    continue;
                }
                foreach ($paidElsewhere[$eid] ?? [] as $pe) {
                    if ($d >= $pe['period_from'] && $d <= $pe['period_to']) {
                        $elsewhere++;
                        $unpaid++;
                        $seg['unpaid_days']++;
                        continue 2;
                    }
                }
                $a = $att[$eid][$d] ?? null;
                if (!$a) {
                    $c['unmarked']++;
                    $unpaid++;
                    $seg['unpaid_days']++;
                    continue;
                }
                switch ($a['status']) {
                    case 'P':
                    case 'S':
                        $c['work'] += 1;
                        $seg['work_days'] += 1;
                        break;
                    case 'HD':
                        $shiftMin = (int)($a['duration_minutes'] ?: ($cal->shift($e, $d)['duration_minutes'] ?? 0));
                        if ((int)$a['work_minutes'] === 0) {
                            $hdNoTime++;
                        }
                        $fraction = PayrollEngine::dayFraction((int)$a['work_minutes'], $shiftMin);
                        $c['work'] += $fraction;
                        $unpaid += 1 - $fraction;
                        $seg['work_days'] += $fraction;
                        $seg['unpaid_days'] += 1 - $fraction;
                        break;
                    case 'R':
                        $c['rest'] += 1;
                        $seg['rest_days'] += 1;
                        break;
                    case 'H':
                        $hol = $cal->holiday($d);
                        if (!$hol || (int)$hol['is_paid']) {
                            $c['rest'] += 1;
                            $c['holiday'] += 1;
                            $seg['rest_days'] += 1;
                        } else {
                            $unpaid++;
                            $seg['unpaid_days']++;
                        }
                        break;
                    case 'L':
                        $c['leave'] += 1;
                        $seg['paid_leave'] += 1;
                        break;
                    case 'LW':
                        $c['lwop'] += 1;
                        $unpaid++;
                        $seg['unpaid_days']++;
                        break;
                    case 'A':
                        $c['absent'] += 1;
                        $unpaid++;
                        $seg['unpaid_days']++;
                        break;
                    case 'O': // outside employment
                        $unpaid++;
                        $seg['unpaid_days']++;
                        break;
                }
            }
            unset($seg);
            if ($c['unmarked'] > 0) {
                $warn[] = (int)$c['unmarked'] . ' day(s) without attendance (not paid)';
            }
            if ($elsewhere) {
                $warn[] = "$elsewhere day(s) already paid on another posted sheet (employee type changed) — not paid again";
            }
            if ($hdNoTime) {
                $warn[] = "$hdNoTime half day(s) without times (paid 0 h — enter times in attendance)";
            }
            // overtime & vouchers
            // each OT date is priced with the salary effective on that date
            $otItems = [];
            foreach ($ot[$eid] ?? [] as $o) {
                $otItems[] = ['minutes' => (int)$o['approved_minutes'], 'hours' => 0, 'salary' => Increments::getSalaryOnDate($eid, $o['ot_date'])];
            }
            $sum = ['ADV' => 0.0, 'INC' => 0.0, 'PEN' => 0.0, 'OT' => 0.0, 'OTH' => 0.0];
            foreach ($vch[$eid] ?? [] as $v) {
                $sum[$v['voucher_type']] += (float)$v['amount'];
                if ($v['voucher_type'] === 'OT') {
                    $sum['OTH'] += (float)$v['ot_hours'];
                    $otItems[] = ['minutes' => 0, 'hours' => (float)$v['ot_hours'], 'salary' => Increments::getSalaryOnDate($eid, $v['vr_date'])];
                }
            }
            $otItems[] = ['minutes' => 0, 'hours' => 0, 'salary' => $rateAtEnd]; // reference rate when there is no OT
            $planned = array_sum(array_map(fn($i) => (float)$i['scheduled_amount'], $inst[$eid] ?? []));
            $shift = $cal->shift($e, $from);
            $shiftHours = $shift && (int)$shift['duration_minutes'] > 0 ? (int)$shift['duration_minutes'] / 60 : null;
            $fine = (float)($manual[$eid]['fine'] ?? 0);

            $r = $engine->calculate([
                'type' => $type, 'days' => $days, 'basis' => $basis, 'unpaid_days' => round($unpaid, 2),
                'basic' => $daily ? 0 : $rateAtEnd, 'daily_rate' => $daily ? $rateAtEnd : 0, 'allowances' => (float)($h['allowances'] ?? 0),
                'work_days' => $c['work'], 'rest_days' => $c['rest'], 'paid_leave' => $c['leave'],
                'segments' => $segs, 'ot_items' => $otItems,
                'ot_applicable' => $h ? (bool)(int)$h['ot_applicable'] : false, 'ot_rate' => $h['ot_rate'] ?? null, 'shift_hours' => $shiftHours,
                'ot_voucher_amount' => $sum['OT'],
                'incentive' => $sum['INC'], 'penalty' => $sum['PEN'], 'fine' => $fine, 'advance' => $sum['ADV'], 'loan_planned' => $planned,
                'eobi_rate' => $h && (int)$h['eobi_applicable'] ? ($rates['EOBI'] ?? null) : null,
                'pessi_rate' => $h && (int)$h['pessi_applicable'] ? ($rates[$ss] ?? null) : null,
                'tax_slabs' => $h && (int)$h['tax_applicable'] ? $slabs : null,
            ]);

            // mid-period increment: which salary paid which days (shown as a marker / tooltip on the sheet)
            $note = [];
            // a boundary at the joining row (salary 0 before it) is not an increment
            $paidSegs = array_filter($segs, fn($sg) => Money::toPaisa($sg['salary']) > 0);
            if (count($paidSegs) > 1) {
                foreach ($paidSegs as $i => $sg) {
                    $note[] = date('d-m', strtotime($sg['from'])) . ' to ' . date('d-m', strtotime($sg['to'])) . ' @ '
                        . number_format((float)$sg['salary']) . ($daily ? '/day' : '') . ' (' . $r['segment_paid_days'][$i] . ' paid d)';
                }
                $note = ['Increment in period: ' . implode('; ', $note)];
            }
            if (count($r['ot_rates']) > 1) {
                $note[] = 'OT: ' . implode(' + ', array_map(fn($x) => $x['hours'] . ' h @ ' . number_format($x['rate'], 2), $r['ot_rates']));
            }

            // allocate the loan deduction over this month's installments, in loan order
            $left = $r['loan_deduction'];
            $alloc = [];
            foreach ($inst[$eid] ?? [] as $i) {
                $take = min((float)$i['scheduled_amount'], $left);
                $left -= $take;
                $alloc[] = ['installment_id' => (int)$i['id'], 'loan_id' => (int)$i['loan_id'], 'planned' => (float)$i['scheduled_amount'], 'deducted' => $take];
            }
            $balance = max(0.0, ($loanBal[$eid] ?? 0.0) - $r['loan_deduction']);

            $out['lines'][] = [
                'employee_id' => $eid, 'code' => $e['code'], 'name' => $e['name'], 'name_ur' => $e['name_ur'],
                'department_id' => (int)$e['department_id'], 'department' => $e['department'], 'department_ur' => $e['department_ur'],
                'designation_id' => (int)$e['designation_id'], 'designation' => $e['designation'], 'emp_type' => $e['emp_type'],
                'basic_salary' => $daily ? 0.0 : (float)$rateAtEnd, 'daily_rate' => $daily ? (float)$rateAtEnd : 0.0, 'allowances' => (float)($h['allowances'] ?? 0),
                'absent_days' => $c['absent'], 'leave_wp_days' => $c['leave'], 'leave_wop_days' => $c['lwop'], 'rest_days' => $c['rest'],
                'holiday_days' => $c['holiday'], 'unmarked_days' => $c['unmarked'], 'work_days' => round($c['work'], 2),
                'paid_days' => $r['paid_days'], 'work_pay' => $r['work_pay'], 'allowance_pay' => $r['allowance_pay'],
                'ot_hours' => $r['ot_hours'], 'ot_rate' => $r['ot_rate'], 'ot_amount' => $r['ot_amount'], 'ot_voucher_amount' => $r['ot_voucher_amount'],
                'gross' => $r['gross'], 'fine' => $r['fine'], 'fine_entered' => $r['fine_entered'], 'advance' => $r['advance'], 'loan_deduction' => $r['loan_deduction'],
                'advance_carried' => $r['advance_carried'], 'penalty_carried' => $r['penalty_carried'], 'fine_carried' => $r['fine_carried'],
                'loan_balance' => $balance, 'incentive' => $r['incentive'], 'penalty' => $r['penalty'], 'eobi' => $r['eobi'], 'pessi' => $r['pessi'],
                'income_tax' => $r['income_tax'], 'net_salary' => $r['net_salary'],
                'payment_mode' => $h['payment_mode'] ?? 'cash', 'bank_name' => $h['bank_name'] ?? null, 'bank_account' => $h['bank_account'] ?? null,
                'remarks' => isset($manual[$eid]['remarks']) && trim((string)$manual[$eid]['remarks']) !== '' ? mb_substr(trim((string)$manual[$eid]['remarks']), 0, 255) : null,
                'warnings' => array_merge($warn, $r['warnings']),
                'increment_note' => $note ? mb_substr(implode(' | ', $note), 0, 255) : null,
                'loans' => $alloc,
            ];
            foreach ($vch[$eid] ?? [] as $v) {
                if ($v['voucher_type'] === 'OT' && !(int)($h['ot_applicable'] ?? 0)) {
                    continue; // not paid (OT not applicable): stays open for correction, like approved OT rows
                }
                $out['used']['vouchers'][] = (int)$v['id'];
            }
            foreach ($ot[$eid] ?? [] as $o) {
                $out['used']['overtime'][] = (int)$o['id'];
            }
            if (!(int)($h['ot_applicable'] ?? 0)) {
                // approved OT of employees without OT is not consumed (stays visible for correction)
                $out['used']['overtime'] = array_values(array_diff($out['used']['overtime'], array_map(fn($o) => (int)$o['id'], $ot[$eid] ?? [])));
            }
        }
        $out['totals'] = self::totals($out['lines']);
        return $out;
    }

    public static function totals(array $lines): array
    {
        $keys = ['basic_salary', 'work_pay', 'allowance_pay', 'ot_hours', 'ot_amount', 'gross', 'fine', 'advance', 'loan_deduction', 'loan_balance',
            'incentive', 'penalty', 'eobi', 'pessi', 'income_tax', 'net_salary', 'paid_days', 'work_days'];
        $t = array_fill_keys($keys, 0.0) + ['employees' => count($lines), 'bank' => 0.0, 'cash' => 0.0, 'warnings' => 0];
        foreach ($lines as $l) {
            foreach ($keys as $k) {
                $t[$k] += (float)$l[$k];
            }
            $t[$l['payment_mode'] === 'bank' ? 'bank' : 'cash'] += (float)$l['net_salary'];
            $t['warnings'] += !empty($l['warnings']) ? 1 : 0;
        }
        return $t;
    }

    private static function lineRow(array $l, int $sheetId): array
    {
        $cols = ['employee_id', 'department_id', 'designation_id', 'basic_salary', 'daily_rate', 'allowances', 'absent_days', 'leave_wp_days',
            'leave_wop_days', 'rest_days', 'holiday_days', 'unmarked_days', 'work_days', 'paid_days', 'work_pay', 'allowance_pay', 'ot_hours',
            'ot_rate', 'ot_amount', 'ot_voucher_amount', 'gross', 'fine', 'advance', 'loan_deduction', 'loan_balance', 'incentive', 'penalty',
            'eobi', 'pessi', 'income_tax', 'net_salary', 'payment_mode', 'bank_name', 'bank_account', 'remarks', 'increment_note',
            'fine_entered', 'advance_carried', 'penalty_carried', 'fine_carried'];
        $row = array_intersect_key($l, array_flip($cols));
        $row['warnings'] = $l['warnings'] ? mb_substr(implode('; ', $l['warnings']), 0, 500) : null;
        return $row + ['salary_sheet_id' => $sheetId];
    }

    /** Save (create or replace) the draft sheet for type + month. */
    public static function save(string $type, string $from, string $to, array $manual, ?string $paidDate, ?string $remarks): int
    {
        self::validatePeriod($type, $from, $to);
        $month = self::month($to);
        return Database::transaction(function () use ($type, $from, $to, $manual, $paidDate, $remarks, $month) {
            $sheet = self::findSheet($type, $from, $to, true);
            if ($sheet && $sheet['status'] === 'posted') {
                throw ApiException::conflict(self::TYPES[$type] . ' salary ' . ($type === 'daily_wages'
                    ? 'from ' . date('d-m-Y', strtotime($sheet['period_from'])) : 'for ' . date('F Y', strtotime($month))) . ' is already posted and locked.');
            }
            self::assertNoOverlap($type, $from, $to, $sheet ? (int)$sheet['id'] : null);
            $build = self::build($type, $from, $to, $sheet ? (int)$sheet['id'] : null, $manual);
            $head = ['period_from' => $from, 'period_to' => $to, 'days_in_month' => $build['days'], 'day_basis' => $build['basis'],
                     'paid_date' => $paidDate, 'remarks' => $remarks];
            if ($sheet) {
                $id = (int)$sheet['id'];
                Database::update('salary_sheets', $head + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
                Database::run('DELETE FROM salary_sheet_lines WHERE salary_sheet_id = ?', [$id]);
                Database::run('DELETE FROM salary_sheet_loans WHERE salary_sheet_id = ?', [$id]);
            } else {
                $id = Database::insert('salary_sheets', $head + ['sheet_type' => $type, 'salary_month' => $month, 'status' => 'draft', 'created_by' => Auth::id()]);
            }
            foreach ($build['lines'] as $l) {
                Database::insert('salary_sheet_lines', self::lineRow($l, $id));
                foreach ($l['loans'] as $a) {
                    Database::insert('salary_sheet_loans', ['salary_sheet_id' => $id, 'employee_id' => $l['employee_id'],
                        'loan_installment_id' => $a['installment_id'], 'planned' => $a['planned'], 'deducted' => $a['deducted']]);
                }
            }
            Audit::log($sheet ? 'update' : 'create', 'salary_sheets', $id, null,
                ['type' => $type, 'from' => $from, 'to' => $to, 'employees' => count($build['lines']), 'net' => $build['totals']['net_salary']]);
            return $id;
        });
    }

    /**
     * The sheet a Show / Save of this period belongs to: permanent = one sheet per salary month;
     * daily wages = one sheet per period start (weekly / fortnightly / monthly periods).
     */
    public static function findSheet(string $type, string $from, string $to, bool $lock = false): ?array
    {
        $sql = $type === 'daily_wages'
            ? 'SELECT * FROM salary_sheets WHERE sheet_type = ? AND period_from = ?'
            : 'SELECT * FROM salary_sheets WHERE sheet_type = ? AND salary_month = ?';
        return Database::one($sql . ($lock ? ' FOR UPDATE' : ''), [$type, $type === 'daily_wages' ? $from : self::month($to)]);
    }

    private static function assertNoOverlap(string $type, string $from, string $to, ?int $except): void
    {
        $o = Database::one(
            'SELECT period_from, period_to, status FROM salary_sheets WHERE sheet_type = ? AND period_from <= ? AND period_to >= ?' . ($except ? ' AND id <> ?' : ''),
            $except ? [$type, $to, $from, $except] : [$type, $to, $from]
        );
        if ($o) {
            throw ApiException::validation(['period_from' => sprintf('Overlaps the %s sheet %s to %s.', $o['status'],
                date('d-m-Y', strtotime($o['period_from'])), date('d-m-Y', strtotime($o['period_to'])))]);
        }
    }

    /** Post: re-verify against current data, consume sources, write the salary JV and lock the period. */
    public static function post(int $id, ?string $paidDate): void
    {
        Database::transaction(function () use ($id, $paidDate) {
            $sheet = Database::one('SELECT * FROM salary_sheets WHERE id = ? FOR UPDATE', [$id]);
            if (!$sheet) {
                throw ApiException::notFound('Salary sheet');
            }
            if ($sheet['status'] === 'posted') {
                throw ApiException::conflict('This salary sheet is already posted.');
            }
            $saved = [];
            foreach (Database::all('SELECT * FROM salary_sheet_lines WHERE salary_sheet_id = ?', [$id]) as $l) {
                $saved[(int)$l['employee_id']] = $l;
            }
            if (!$saved) {
                throw ApiException::conflict('The sheet has no employees.');
            }
            $manual = [];
            foreach ($saved as $eid => $l) {
                $manual[$eid] = ['fine' => (float)$l['fine_entered'], 'remarks' => $l['remarks']];
            }
            $build = self::build($sheet['sheet_type'], $sheet['period_from'], $sheet['period_to'], $id, $manual);
            $changed = [];
            foreach ($build['lines'] as $l) {
                $s = $saved[$l['employee_id']] ?? null;
                if (!$s) {
                    $changed[] = $l['code'] . ' (new)';
                    continue;
                }
                foreach (self::CHECK as $k) {
                    if (abs((float)$s[$k] - (float)$l[$k]) > 0.004) {
                        $changed[] = $l['code'];
                        break;
                    }
                }
                unset($saved[$l['employee_id']]);
            }
            foreach ($saved as $s) {
                $changed[] = 'employee #' . $s['employee_id'] . ' (no longer eligible)';
            }
            if ($changed) {
                throw ApiException::conflict('Attendance, overtime or vouchers changed after the sheet was saved (' . implode(', ', array_slice($changed, 0, 8))
                    . (count($changed) > 8 ? ' …' : '') . '). Press Show and Save again, then post.');
            }

            // Vouchers of this salary month for employees who are NOT on the sheet would never be deducted / paid:
            // the month is locked after posting. Refuse until they are corrected (salary month, employee dates).
            $onSheet = array_map(fn($l) => (int)$l['employee_id'], $build['lines']);
            $types = self::empTypes($sheet['sheet_type']);
            $tq = implode(',', array_map(fn($t) => Database::pdo()->quote($t), $types));
            $notIn = $onSheet ? ' AND v.employee_id NOT IN (' . implode(',', $onSheet) . ')' : '';
            $orphans = Database::all(
                "SELECT v.voucher_type, v.vr_no, e.code, e.name FROM vouchers v JOIN employees e ON e.id = v.employee_id
                  WHERE v.voucher_type IN ('ADV','INC','PEN','OT') AND v.status = 'posted' AND v.deleted_at IS NULL AND v.salary_sheet_id IS NULL
                    AND v.deduct_month " . ($sheet['sheet_type'] === 'daily_wages' ? '<=' : '=') . " ? AND e.emp_type IN ($tq)$notIn"
                    // daily wages: only employees who will never be on a later sheet (left / inactive) block posting
                    . ($sheet['sheet_type'] === 'daily_wages' ? " AND (e.status = 'inactive' OR (e.leaving_date IS NOT NULL AND e.leaving_date <= " . Database::pdo()->quote($sheet['period_to']) . '))' : '')
                    . ' ORDER BY e.code',
                [$sheet['salary_month']]
            );
            if ($orphans) {
                $list = array_map(fn($o) => Vouchers::number($o['voucher_type'], $o['vr_no']) . " ({$o['code']} {$o['name']})", $orphans);
                throw ApiException::conflict('These vouchers are for ' . date('F Y', strtotime($sheet['salary_month']))
                    . ' but the employee is not on this sheet (joined after the period, left, or inactive): ' . implode(', ', array_slice($list, 0, 10))
                    . (count($list) > 10 ? ' …' : '') . '. Change their salary month (or the employee\'s dates), then post.');
            }

            // consume sources; guarded so a voucher unposted / an OT row changed at the same moment is detected
            foreach (array_chunk($build['used']['vouchers'], 500) as $chunk) {
                $n = Database::run('UPDATE vouchers SET salary_sheet_id = ' . $id . ' WHERE id IN (' . implode(',', $chunk) . ")
                    AND salary_sheet_id IS NULL AND status = 'posted' AND deleted_at IS NULL")->rowCount();
                if ($n !== count($chunk)) {
                    throw ApiException::conflict('Vouchers changed while posting. Press Show and Save again, then post.');
                }
            }
            foreach (array_chunk($build['used']['overtime'], 500) as $chunk) {
                $n = Database::run('UPDATE overtime SET salary_sheet_id = ' . $id . ' WHERE id IN (' . implode(',', $chunk) . ")
                    AND salary_sheet_id IS NULL AND status = 'approved'")->rowCount();
                if ($n !== count($chunk)) {
                    throw ApiException::conflict('Overtime changed while posting. Press Show and Save again, then post.');
                }
            }
            // loan installments: allocation from the fresh build (draft rows may be stale after a loan edit)
            Database::run('DELETE FROM salary_sheet_loans WHERE salary_sheet_id = ?', [$id]);
            $loans = [];
            $allocs = [];
            foreach ($build['lines'] as $l) {
                foreach ($l['loans'] as $a) {
                    Database::insert('salary_sheet_loans', ['salary_sheet_id' => $id, 'employee_id' => $l['employee_id'],
                        'loan_installment_id' => $a['installment_id'], 'planned' => $a['planned'], 'deducted' => $a['deducted']]);
                    $a['loan_installment_id'] = $a['installment_id'];
                    $allocs[] = $a;
                }
            }
            foreach ($allocs as $a) {
                $deducted = (float)$a['deducted'];
                // remembered so that an admin unpost can restore the installment exactly
                Database::run('UPDATE loan_installments SET pre_post_status = status WHERE id = ?', [$a['loan_installment_id']]);
                Database::update('loan_installments', [
                    'status' => $deducted > 0 ? 'deducted' : 'skipped',
                    'deducted_amount' => $deducted,
                    'salary_sheet_id' => $id,
                    'remarks' => $deducted < (float)$a['planned'] ? 'Salary not sufficient; balance carried forward' : null,
                    'updated_by' => Auth::id(),
                ], 'id = :id', ['id' => $a['loan_installment_id']]);
                $loans[(int)$a['loan_id']] = true;
            }
            // installments due this month for employees not on the sheet: skipped, balance moves to later months
            // (daily-wages sheets can be weekly: an installment waits for the next sheet the employee is on)
            foreach ($sheet['sheet_type'] === 'daily_wages' ? [] : Database::all(
                "SELECT li.id, li.loan_id FROM loan_installments li JOIN loans l ON l.id = li.loan_id JOIN employees e ON e.id = l.employee_id
                   JOIN vouchers v ON v.id = l.voucher_id
                  WHERE li.due_month = ? AND li.status IN ('scheduled','adjusted') AND l.status = 'active' AND v.status = 'posted' AND v.deleted_at IS NULL
                    AND e.emp_type IN ($tq)" . ($onSheet ? ' AND l.employee_id NOT IN (' . implode(',', $onSheet) . ')' : ''),
                [$sheet['salary_month']]
            ) as $o) {
                Database::run('UPDATE loan_installments SET pre_post_status = status WHERE id = ?', [$o['id']]);
                Database::update('loan_installments', ['status' => 'skipped', 'deducted_amount' => 0, 'salary_sheet_id' => $id,
                    'remarks' => 'Employee not on the salary sheet; balance carried forward', 'updated_by' => Auth::id()], 'id = :id', ['id' => $o['id']]);
                $loans[(int)$o['loan_id']] = true;
            }
            foreach (array_keys($loans) as $loanId) {
                Vouchers::reschedule($loanId); // re-spreads any shortfall, closes fully repaid loans
            }

            // Net is never negative: advance / penalty / fine that the pay could not cover are carried to the next
            // period as system vouchers (no journal: the advance is still receivable in Employee Advances).
            $carried = self::carryForward($id, $sheet, $build['lines']);

            // salary JV
            $t = $build['totals'];
            $label = self::TYPES[$sheet['sheet_type']] . ' salary ' . date('F Y', strtotime($sheet['salary_month']));
            $jvLines = [];
            $add = function (string $key, float $amount, bool $debit, string $text) use (&$jvLines) {
                if (abs($amount) < 0.005) {
                    return;
                }
                if ($amount < 0) { // e.g. negative net: flip side
                    $debit = !$debit;
                    $amount = -$amount;
                }
                $jvLines[] = ['account_id' => Vouchers::systemAccount($key), 'employee_id' => null,
                    'debit' => $debit ? $amount : 0, 'credit' => $debit ? 0 : $amount, 'narration' => $text];
            };
            $add('salary_expense', $t['work_pay'] + $t['allowance_pay'], true, 'Salaries & allowances');
            $add('overtime_expense', $t['ot_amount'], true, 'Overtime');
            $add('incentive_expense', $t['incentive'], true, 'Incentives');
            $add('employee_advances', $t['advance'], false, 'Advances recovered');
            $add('employee_loans', $t['loan_deduction'], false, 'Loan installments recovered');
            $add('penalty_income', $t['penalty'] + $t['fine'], false, 'Penalties & fines');
            $add('eobi_payable', $t['eobi'], false, 'EOBI (employee share)');
            $add('pessi_payable', $t['pessi'], false, (string)Settings::get('social_security', 'PESSI') . ' (employee share)');
            $add('tax_payable', $t['income_tax'], false, 'Income tax withheld');
            // A negative net is money the employee still owes (e.g. an advance larger than the salary): it is not
            // netted against other employees' payable but stays receivable in Employee Advances.
            $positive = $shortfall = 0.0;
            foreach ($build['lines'] as $l) {
                $n = (float)$l['net_salary'];
                $n >= 0 ? $positive += $n : $shortfall -= $n;
            }
            $add('salary_payable', $positive, false, 'Net salaries payable');
            $add('employee_advances', $shortfall, true, 'Salary shortfall still owed by employees');
            $jvId = null;
            if ($jvLines) {
                $jvId = Database::insert('vouchers', [
                    'voucher_type' => 'JV', 'vr_no' => Vouchers::nextNo('JV'), 'vr_date' => $sheet['period_to'], 'amount' => round(array_sum(array_column($jvLines, 'debit')), 2),
                    'remarks' => $label, 'status' => 'posted', 'is_system' => 1, 'salary_sheet_id' => $id,
                    'posted_by' => Auth::id(), 'posted_at' => date('Y-m-d H:i:s'), 'created_by' => Auth::id(),
                ]);
                Vouchers::writeJournal($jvId, $jvLines);
            }

            Database::update('salary_sheets', ['status' => 'posted', 'paid_date' => $paidDate ?: $sheet['paid_date'], 'jv_id' => $jvId,
                'posted_by' => Auth::id(), 'posted_at' => date('Y-m-d H:i:s'), 'updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            PayrollLock::reset();
            Audit::log('post', 'salary_sheets', $id, ['status' => 'draft'], ['status' => 'posted', 'net' => $t['net_salary'], 'jv_id' => $jvId,
                'vouchers' => count($build['used']['vouchers']), 'overtime_rows' => count($build['used']['overtime']), 'installments' => count($loans),
                'carried_vouchers' => $carried]);
        });
    }

    /** Create the carry-forward vouchers of a sheet being posted. Returns the voucher ids. */
    private static function carryForward(int $sheetId, array $sheet, array $lines): array
    {
        $next = date('Y-m-d', strtotime($sheet['period_to'] . ' +1 day'));
        $nextMonth = substr($next, 0, 7) . '-01';
        $label = self::TYPES[$sheet['sheet_type']] . ' salary ' . date('d-m-Y', strtotime($sheet['period_from'])) . ' to ' . date('d-m-Y', strtotime($sheet['period_to']));
        $ids = [];
        foreach ($lines as $l) {
            foreach (['advance_carried' => ['ADV', 'advance'], 'penalty_carried' => ['PEN', 'penalty'], 'fine_carried' => ['PEN', 'fine']] as $k => [$type, $what]) {
                $amount = (float)($l[$k] ?? 0);
                if ($amount <= 0) {
                    continue;
                }
                if (PayrollLock::isMonthLocked($l['emp_type'], $nextMonth, (int)$l['employee_id']) && $l['emp_type'] !== 'daily_wages') {
                    throw ApiException::conflict("{$l['code']}: the $what not deducted cannot be carried forward because "
                        . date('F Y', strtotime($nextMonth)) . ' is already posted.');
                }
                $row = ['voucher_type' => $type, 'vr_no' => Vouchers::nextNo($type), 'vr_date' => $sheet['period_to'], 'employee_id' => (int)$l['employee_id'],
                    'amount' => $amount, 'deduct_month' => $nextMonth, 'carried_from_sheet_id' => $sheetId,
                    'remarks' => mb_substr("Carried forward: $what not deducted from $label (salary not sufficient)", 0, 255),
                    'status' => 'posted', 'is_system' => 1, 'posted_by' => Auth::id(), 'posted_at' => date('Y-m-d H:i:s'), 'created_by' => Auth::id()];
                $vid = Database::insert('vouchers', $row);
                Audit::log('create', 'vouchers', $vid, null, $row);
                $ids[] = $vid;
            }
        }
        return $ids;
    }

    /**
     * Admin unpost of a posted sheet (audit-logged). Allowed only for the latest posted sheet of its
     * type and while no later posted sheet includes any of its employees, so nothing paid later depends
     * on it. Reverses everything posting did: salary JV removed, vouchers / overtime / loan installments
     * released (installments get their previous status back, loans are rescheduled), carry-forward
     * vouchers deleted, the sheet becomes a draft again.
     */
    public static function unpost(int $id, string $reason): void
    {
        Database::transaction(function () use ($id, $reason) {
            $sheet = Database::one('SELECT * FROM salary_sheets WHERE id = ? FOR UPDATE', [$id]) ?? throw ApiException::notFound('Salary sheet');
            if ($sheet['status'] !== 'posted') {
                throw ApiException::conflict('Only a posted salary sheet can be unposted.');
            }
            $later = Database::one(
                "SELECT s.id, s.sheet_type, s.period_from, s.period_to FROM salary_sheets s
                  WHERE s.status = 'posted' AND s.id <> ? AND s.period_from > ?
                    AND (s.sheet_type = ? OR EXISTS (SELECT 1 FROM salary_sheet_lines a JOIN salary_sheet_lines b ON b.employee_id = a.employee_id
                                                      WHERE a.salary_sheet_id = s.id AND b.salary_sheet_id = ?))
                  ORDER BY s.period_from LIMIT 1",
                [$id, $sheet['period_to'], $sheet['sheet_type'], $id]
            );
            if ($later) {
                throw ApiException::conflict('A later salary sheet (' . self::TYPES[$later['sheet_type']] . ' ' . date('d-m-Y', strtotime($later['period_from']))
                    . ' to ' . date('d-m-Y', strtotime($later['period_to'])) . ') is posted. Unpost that one first.');
            }
            $used = Database::value('SELECT COUNT(*) FROM vouchers WHERE carried_from_sheet_id = ? AND salary_sheet_id IS NOT NULL', [$id]);
            if ($used) {
                throw ApiException::conflict('A carried-forward voucher of this sheet is already used by another posted sheet. Unpost that one first.');
            }
            // salary JV
            if ($sheet['jv_id']) {
                $jv = Database::one('SELECT * FROM vouchers WHERE id = ?', [$sheet['jv_id']]);
                Database::update('salary_sheets', ['jv_id' => null], 'id = :id', ['id' => $id]);
                Database::run('DELETE FROM journal_entries WHERE voucher_id = ?', [$sheet['jv_id']]);
                Database::run('DELETE FROM vouchers WHERE id = ?', [$sheet['jv_id']]);
                Audit::log('delete', 'vouchers', (int)$sheet['jv_id'], $jv, null);
            }
            // carry-forward vouchers created by this sheet
            foreach (Database::all('SELECT * FROM vouchers WHERE carried_from_sheet_id = ?', [$id]) as $v) {
                Database::run('DELETE FROM vouchers WHERE id = ?', [$v['id']]);
                Audit::log('delete', 'vouchers', (int)$v['id'], $v, null);
            }
            // consumed vouchers and overtime become open again
            $vouchers = Database::run('UPDATE vouchers SET salary_sheet_id = NULL WHERE salary_sheet_id = ?', [$id])->rowCount();
            $ot = Database::run('UPDATE overtime SET salary_sheet_id = NULL WHERE salary_sheet_id = ?', [$id])->rowCount();
            // loan installments get their pre-posting state back, loans are rescheduled
            $loans = Database::column('SELECT DISTINCT loan_id FROM loan_installments WHERE salary_sheet_id = ?', [$id]);
            Database::run("UPDATE loan_installments SET status = COALESCE(pre_post_status, 'scheduled'), pre_post_status = NULL,
                                  deducted_amount = 0, salary_sheet_id = NULL, remarks = NULL, updated_by = ?
                            WHERE salary_sheet_id = ?", [Auth::id(), $id]);
            foreach ($loans as $loanId) {
                Database::run("UPDATE loans SET status = 'active' WHERE id = ?", [$loanId]);
            }
            Database::update('salary_sheets', ['status' => 'draft', 'posted_by' => null, 'posted_at' => null,
                'unposted_by' => Auth::id(), 'unposted_at' => date('Y-m-d H:i:s'), 'updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            PayrollLock::reset();
            foreach ($loans as $loanId) {
                Vouchers::reschedule((int)$loanId);
            }
            Audit::log('unpost', 'salary_sheets', $id, ['status' => 'posted', 'jv_id' => $sheet['jv_id'], 'posted_at' => $sheet['posted_at']],
                ['status' => 'draft', 'reason' => $reason, 'vouchers_released' => $vouchers, 'overtime_released' => $ot, 'loans' => count($loans)]);
        });
    }
}
