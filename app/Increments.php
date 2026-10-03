<?php
declare(strict_types=1);

namespace App;

/**
 * Salary increments: the effective-dated pay rate of every employee (monthly basic for permanent /
 * contract staff, rate per day for daily wages). Every increment is entered by an admin; nothing is
 * applied automatically.
 *
 *   getSalaryOnDate()  the one function payroll and overtime use to price a date
 *   add()              single increment (percentage | fixed | new_salary)
 *   bulkPreview/Apply  percentage or fixed increment for a department or shift group, one transaction
 *   delete()           latest increment only, never the joining row, never into a posted month
 *
 * Date rules (add, bulk, delete)
 *   - future dates are allowed: the row is "scheduled" and payroll picks it up from that date;
 *   - a past date is allowed only while no salary sheet with this employee is posted for that month or
 *     any later month (no arrears are calculated);
 *   - one row per employee per effective date, and a new increment must be dated after the employee's
 *     latest one (to insert an earlier one, delete the later one first), so old_salary is always right.
 *
 * Money is handled as integer paisa (App\Money), never float. New salaries are whole rupees (half up).
 */
final class Increments
{
    public const TYPES = ['joining' => 'Joining', 'percentage' => 'Percentage', 'fixed' => 'Fixed amount', 'new_salary' => 'New salary'];
    /** Highest salary / rate accepted (same limit as the salary info screen). */
    public const MAX_SALARY = 99999999;
    public const MAX_PERCENT = 1000;

    /** @var array<int,list<array{0:string,1:int,2:string}>> employee_id => [effective_date, id, new_salary] ascending */
    private static array $cache = [];

    // ------------------------------------------------------------------ salary on a date

    /** Load the increment rows of many employees with one query (payroll calls this before pricing). */
    public static function prefetch(array $employeeIds): void
    {
        $ids = array_values(array_unique(array_map('intval', $employeeIds)));
        foreach (array_chunk($ids, 1000) as $chunk) {
            foreach ($chunk as $id) {
                self::$cache[$id] = [];
            }
            foreach (Database::all(
                'SELECT employee_id, effective_date, id, new_salary FROM salary_increments
                  WHERE employee_id IN (' . implode(',', $chunk) . ') ORDER BY employee_id, effective_date, id'
            ) as $r) {
                self::$cache[(int)$r['employee_id']][] = [$r['effective_date'], (int)$r['id'], (string)$r['new_salary']];
            }
        }
    }

    public static function forget(?int $employeeId = null): void
    {
        if ($employeeId === null) {
            self::$cache = [];
        } else {
            unset(self::$cache[$employeeId]);
        }
    }

    private static function rows(int $employeeId): array
    {
        if (!isset(self::$cache[$employeeId])) {
            self::prefetch([$employeeId]);
        }
        return self::$cache[$employeeId];
    }

    /**
     * Salary effective on $date (decimal string, "0.00" when none). Same result as
     *   SELECT new_salary FROM salary_increments WHERE employee_id = ? AND effective_date <= ?
     *   ORDER BY effective_date DESC, id DESC LIMIT 1
     * served from a per-request cache that prefetch() fills and every write clears.
     */
    public static function getSalaryOnDate(int $employeeId, string $date): string
    {
        $found = null;
        foreach (self::rows($employeeId) as [$d, , $salary]) {
            if ($d > $date) {
                break;
            }
            $found = $salary; // ascending by (date, id): the last one on or before $date wins
        }
        return $found ?? '0.00';
    }

    /**
     * Split $from..$to at every effective date inside it.
     * @return list<array{from:string,to:string,salary:string}>
     */
    public static function segments(int $employeeId, string $from, string $to): array
    {
        $starts = [$from];
        foreach (self::rows($employeeId) as [$d]) {
            if ($d > $from && $d <= $to && end($starts) !== $d) {
                $starts[] = $d;
            }
        }
        $out = [];
        foreach ($starts as $i => $s) {
            $e = isset($starts[$i + 1]) ? date('Y-m-d', strtotime($starts[$i + 1] . ' -1 day')) : $to;
            $out[] = ['from' => $s, 'to' => $e, 'salary' => self::getSalaryOnDate($employeeId, $s)];
        }
        return $out;
    }

    // ------------------------------------------------------------------ calculation

    /**
     * New salary for an increment, rounded to the nearest whole rupee (half up).
     *   percentage: old + old x value / 100      fixed: old + value      new_salary: value
     * @return string decimal string, e.g. "47250.00"
     */
    public static function compute(string $type, string $oldSalary, string $value): string
    {
        $old = Money::toPaisa($oldSalary);
        $v = Money::toPaisa($value); // percent or rupees, x100
        $paisa = match ($type) {
            // old x (100 + pct) / 100, in paisa; $v is pct x 100 -> old x (10000 + v) / 10000
            'percentage' => Money::divRound($old * (10000 + $v), 10000 * 100) * 100,
            'fixed' => Money::roundRupees($old + $v),
            'new_salary' => Money::roundRupees($v),
            default => throw new \InvalidArgumentException("Unknown increment type: $type"),
        };
        return Money::fromPaisa($paisa);
    }

    /** Normalise a user-entered amount / percent to a 2-decimal string, or null when invalid. */
    public static function decimal(mixed $raw): ?string
    {
        if (is_int($raw)) {
            $raw = (string)$raw;
        } elseif (is_float($raw)) {
            $raw = (string)$raw; // JSON number: shortest form, e.g. 7.5
        }
        if (!is_string($raw)) {
            return null;
        }
        $s = str_replace(',', '', trim($raw));
        if (!preg_match(Money::DECIMAL_REGEX, $s)) {
            return null;
        }
        return Money::fromPaisa(Money::toPaisa($s));
    }

    /** Validates type + value, returns [old, new] salaries as decimal strings or throws 422. */
    private static function priced(string $type, string $value, string $old, string $field = 'increment_value'): array
    {
        if (Money::toPaisa($value) <= 0) {
            throw ApiException::validation([$field => 'Value must be greater than 0.']);
        }
        if ($type === 'percentage' && Money::toPaisa($value) > self::MAX_PERCENT * 100) {
            throw ApiException::validation([$field => 'Percentage must not exceed ' . self::MAX_PERCENT . '%.']);
        }
        $new = self::compute($type, $old, $value);
        if (Money::toPaisa($new) <= 0) {
            throw ApiException::validation([$field => 'New salary must be greater than 0 (current salary is ' . number_format((float)$old) . ').']);
        }
        if (Money::toPaisa($new) > self::MAX_SALARY * 100) {
            throw ApiException::validation([$field => 'New salary must not exceed ' . number_format(self::MAX_SALARY) . '.']);
        }
        return [$old, $new];
    }

    // ------------------------------------------------------------------ date rules

    /**
     * Posted salary sheet (with a line for this employee) whose salary month is the month of $date or later,
     * or whose period reaches $date. Null when the date is still open.
     */
    public static function postedSheetFrom(int $employeeId, string $date): ?array
    {
        return Database::one(
            "SELECT s.id, s.sheet_type, s.salary_month, s.period_from, s.period_to
               FROM salary_sheets s JOIN salary_sheet_lines l ON l.salary_sheet_id = s.id
              WHERE l.employee_id = ? AND s.status = 'posted' AND (s.salary_month >= ? OR s.period_to >= ?)
              ORDER BY s.salary_month DESC LIMIT 1",
            [$employeeId, substr($date, 0, 7) . '-01', $date]
        );
    }

    private static function latest(int $employeeId): ?array
    {
        return Database::one('SELECT * FROM salary_increments WHERE employee_id = ? ORDER BY effective_date DESC, id DESC LIMIT 1', [$employeeId]);
    }

    /** All date rules for a new increment. Returns an error message or null. */
    public static function dateError(array $emp, string $date): ?string
    {
        $d = fn(string $x) => date('d-m-Y', strtotime($x));
        if ($date <= $emp['joining_date']) {
            return 'Effective date must be after the joining date (' . $d($emp['joining_date']) . ').';
        }
        if ($emp['leaving_date'] && $date > $emp['leaving_date']) {
            return 'Effective date is after the leaving date (' . $d($emp['leaving_date']) . ').';
        }
        if (Database::value('SELECT 1 FROM salary_increments WHERE employee_id = ? AND effective_date = ?', [$emp['id'], $date])) {
            return 'An increment effective ' . $d($date) . ' already exists for this employee.';
        }
        $latest = self::latest((int)$emp['id']);
        if ($latest && $latest['effective_date'] > $date) {
            return 'This employee already has a later increment (effective ' . $d($latest['effective_date'])
                . '). Delete it first to add an earlier one.';
        }
        if ($p = self::postedSheetFrom((int)$emp['id'], $date)) {
            return 'Salary for ' . date('F Y', strtotime($p['salary_month'])) . ' is already posted for this employee. '
                . 'Choose an effective date in a month that is not posted yet (arrears are not calculated).';
        }
        return null;
    }

    public static function status(string $effectiveDate): string
    {
        return $effectiveDate <= date('Y-m-d') ? 'applied' : 'scheduled';
    }

    // ------------------------------------------------------------------ writes

    private const RULES = [
        'employee_id'    => 'required|int',
        'increment_type' => 'required|in:percentage,fixed,new_salary',
        'effective_date' => 'required|date',
        'reason'         => 'nullable|string|max:255',
        'approved_by'    => 'nullable|int|exists:users',
    ];
    private const LABELS = ['increment_type' => 'Type', 'effective_date' => 'Effective date', 'approved_by' => 'Approved by'];

    private static function employeeForUpdate(int $id): array
    {
        $e = Database::one('SELECT id, code, name, emp_type, joining_date, leaving_date, status FROM employees WHERE id = ? FOR UPDATE', [$id]);
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        return $e;
    }

    /** Preview for the single-increment screen (nothing written). */
    public static function preview(int $employeeId, string $type, string $value, string $date): array
    {
        $emp = Database::one('SELECT id, joining_date, leaving_date FROM employees WHERE id = ?', [$employeeId]) ?? throw ApiException::notFound('Employee');
        $old = self::getSalaryOnDate($employeeId, date('Y-m-d', strtotime("$date -1 day")));
        $out = ['old_salary' => $old, 'new_salary' => null, 'error' => self::dateError($emp, $date), 'status' => self::status($date)];
        try {
            $out['new_salary'] = self::priced($type, $value, $old)[1];
        } catch (ApiException $e) {
            $out['error'] ??= implode(' ', $e->errors());
        }
        return $out;
    }

    /** Add one increment. $in: employee_id, increment_type, increment_value, effective_date, reason, approved_by */
    public static function add(array $in): int
    {
        $d = Validator::make($in, self::RULES, self::LABELS);
        $value = self::decimal($in['increment_value'] ?? null)
            ?? throw ApiException::validation(['increment_value' => 'Enter a positive number with at most 2 decimals.']);
        return Database::transaction(function () use ($d, $value) {
            $emp = self::employeeForUpdate($d['employee_id']); // serialises increments of this employee
            self::forget((int)$emp['id']);
            if ($err = self::dateError($emp, $d['effective_date'])) {
                throw ApiException::validation(['effective_date' => $err]);
            }
            $old = self::getSalaryOnDate((int)$emp['id'], date('Y-m-d', strtotime($d['effective_date'] . ' -1 day')));
            [$old, $new] = self::priced($d['increment_type'], $value, $old);
            return self::insert($emp, $d['increment_type'], $value, $old, $new, $d['effective_date'], $d['reason'] ?? null, $d['approved_by'] ?? null);
        });
    }

    private static function insert(array $emp, string $type, string $value, string $old, string $new, string $date, ?string $reason, ?int $approvedBy): int
    {
        $row = ['employee_id' => (int)$emp['id'], 'increment_type' => $type, 'increment_value' => $value, 'old_salary' => $old,
            'new_salary' => $new, 'effective_date' => $date, 'reason' => $reason, 'approved_by' => $approvedBy, 'created_by' => Auth::id()];
        $id = Database::insert('salary_increments', $row);
        Audit::log('create', 'salary_increments', $id, null, $row + ['employee_code' => $emp['code']]);
        self::forget((int)$emp['id']);
        self::syncBasicSalaries([(int)$emp['id']]);
        return $id;
    }

    /** Joining row for a new employee (called inside the employee-create transaction). */
    public static function addJoining(int $employeeId, string $joiningDate, string $salary): int
    {
        $row = ['employee_id' => $employeeId, 'increment_type' => 'joining', 'increment_value' => $salary, 'old_salary' => '0.00',
            'new_salary' => $salary, 'effective_date' => $joiningDate, 'reason' => 'Joining salary', 'created_by' => Auth::id()];
        $id = Database::insert('salary_increments', $row);
        Audit::log('create', 'salary_increments', $id, null, $row);
        self::forget($employeeId);
        self::syncBasicSalaries([$employeeId]);
        return $id;
    }

    /**
     * The joining row follows a changed joining date. Refused when an increment or a posted salary
     * sheet would end up before / around it.
     */
    public static function moveJoining(int $employeeId, string $oldDate, string $newDate): void
    {
        if ($oldDate === $newDate) {
            return;
        }
        $row = Database::one("SELECT * FROM salary_increments WHERE employee_id = ? AND increment_type = 'joining'", [$employeeId]);
        if (!$row) {
            return;
        }
        $next = Database::value("SELECT MIN(effective_date) FROM salary_increments WHERE employee_id = ? AND increment_type <> 'joining'", [$employeeId]);
        if ($next && $newDate >= $next) {
            throw ApiException::validation(['joining_date' => 'An increment is effective ' . date('d-m-Y', strtotime($next)) . '; the joining date must be before it.']);
        }
        if (self::postedSheetFrom($employeeId, min($oldDate, $newDate))) {
            throw ApiException::validation(['joining_date' => 'Salary is already posted for this employee; the joining date can no longer change the joining salary row.']);
        }
        Database::update('salary_increments', ['effective_date' => $newDate], 'id = :id', ['id' => $row['id']]);
        Audit::log('update', 'salary_increments', (int)$row['id'], ['effective_date' => $oldDate], ['effective_date' => $newDate]);
        self::forget($employeeId);
        self::syncBasicSalaries([$employeeId]);
    }

    /** Delete rules: latest only, not the joining row, not into a posted month. Recalculates basic_salary. */
    public static function delete(int $id): array
    {
        return Database::transaction(function () use ($id) {
            $row = Database::one('SELECT * FROM salary_increments WHERE id = ?', [$id]) ?? throw ApiException::notFound('Increment');
            self::employeeForUpdate((int)$row['employee_id']);
            if ($row['increment_type'] === 'joining') {
                throw ApiException::conflict('The joining salary row cannot be deleted.');
            }
            $latest = self::latest((int)$row['employee_id']);
            if ((int)$latest['id'] !== (int)$row['id']) {
                throw ApiException::conflict('Only the latest increment of an employee can be deleted (latest is effective '
                    . date('d-m-Y', strtotime($latest['effective_date'])) . ').');
            }
            if ($p = self::postedSheetFrom((int)$row['employee_id'], $row['effective_date'])) {
                throw ApiException::conflict('Salary for ' . date('F Y', strtotime($p['salary_month']))
                    . ' is already posted for this employee, so this increment can no longer be deleted.');
            }
            Database::run('DELETE FROM salary_increments WHERE id = ?', [$id]);
            Audit::log('delete', 'salary_increments', $id, $row, null);
            self::forget((int)$row['employee_id']);
            self::syncBasicSalaries([(int)$row['employee_id']]);
            return $row;
        });
    }

    // ------------------------------------------------------------------ bulk

    private const BULK_RULES = [
        'scope'          => 'required|in:department,shift_group',
        'scope_id'       => 'required|int',
        'emp_group'      => 'nullable|in:monthly,daily',
        'increment_type' => 'required|in:percentage,fixed',
        'effective_date' => 'required|date',
        'reason'         => 'nullable|string|max:255',
        'approved_by'    => 'nullable|int|exists:users',
        'employee_ids'   => 'nullable|array',
    ];

    private static function bulkInput(array $in): array
    {
        $d = Validator::make($in, self::BULK_RULES, self::LABELS + ['scope_id' => 'Department / shift group', 'emp_group' => 'Employee type']);
        $d['increment_value'] = self::decimal($in['increment_value'] ?? null)
            ?? throw ApiException::validation(['increment_value' => 'Enter a positive number with at most 2 decimals.']);
        if (Money::toPaisa($d['increment_value']) <= 0) {
            throw ApiException::validation(['increment_value' => 'Value must be greater than 0.']);
        }
        return $d;
    }

    /** Active employees of the department / shift group (optionally monthly or daily wages only). */
    private static function scopeEmployees(array $d, bool $lock = false): array
    {
        $col = $d['scope'] === 'department' ? 'e.department_id' : 'e.shift_group_id';
        $where = ["$col = ?", "e.status = 'active'"];
        if (($d['emp_group'] ?? null) === 'daily') {
            $where[] = "e.emp_type = 'daily_wages'";
        } elseif (($d['emp_group'] ?? null) === 'monthly') {
            $where[] = "e.emp_type <> 'daily_wages'";
        }
        return Database::all(
            'SELECT e.id, e.code, e.name, e.emp_type, e.joining_date, e.leaving_date, e.status, d.name AS department, g.name AS designation
               FROM employees e JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY e.code' . ($lock ? ' FOR UPDATE' : ''),
            [$d['scope_id']]
        );
    }

    /** One preview row per employee: old / new salary or the rule that blocks it. */
    private static function bulkRows(array $d, array $emps): array
    {
        self::prefetch(array_column($emps, 'id'));
        $before = date('Y-m-d', strtotime($d['effective_date'] . ' -1 day'));
        $rows = [];
        foreach ($emps as $e) {
            $old = self::getSalaryOnDate((int)$e['id'], $before);
            $r = ['employee_id' => (int)$e['id'], 'code' => $e['code'], 'name' => $e['name'], 'emp_type' => $e['emp_type'],
                'department' => $e['department'], 'designation' => $e['designation'], 'old_salary' => $old, 'new_salary' => null,
                'error' => self::dateError($e, $d['effective_date'])];
            try {
                $r['new_salary'] = self::priced($d['increment_type'], $d['increment_value'], $old)[1];
            } catch (ApiException $x) {
                $r['error'] ??= implode(' ', $x->errors());
            }
            $rows[] = $r;
        }
        return $rows;
    }

    private static function totals(array $rows): array
    {
        $old = $new = 0;
        foreach ($rows as $r) {
            if ($r['new_salary'] !== null && !$r['error']) {
                $old += Money::toPaisa($r['old_salary']);
                $new += Money::toPaisa($r['new_salary']);
            }
        }
        return ['old' => Money::fromPaisa($old), 'new' => Money::fromPaisa($new), 'difference' => Money::fromPaisa($new - $old)];
    }

    public static function bulkPreview(array $in): array
    {
        $d = self::bulkInput($in);
        $rows = self::bulkRows($d, self::scopeEmployees($d));
        return ['rows' => $rows, 'totals' => self::totals($rows), 'status' => self::status($d['effective_date'])];
    }

    /**
     * Apply to the employees ticked in the preview (employee_ids; the unticked ones are the exclusions).
     * One transaction: if any ticked employee fails a rule, nothing is saved.
     */
    public static function bulkApply(array $in): array
    {
        $d = self::bulkInput($in);
        $ids = array_values(array_unique(array_map('intval', (array)($d['employee_ids'] ?? []))));
        if (!$ids) {
            throw ApiException::validation(['employee_ids' => 'Tick at least one employee.']);
        }
        return Database::transaction(function () use ($d, $ids) {
            $emps = self::scopeEmployees($d, true);
            $inScope = array_column($emps, null, 'id');
            $outside = array_diff($ids, array_keys($inScope));
            if ($outside) {
                throw ApiException::conflict('Some ticked employees are no longer in this department / shift group or are inactive. Press Preview again.');
            }
            self::forget();
            $rows = self::bulkRows($d, array_values(array_intersect_key($inScope, array_flip($ids))));
            $errors = array_filter($rows, fn($r) => $r['error']);
            if ($errors) {
                throw ApiException::conflict('Nothing was saved. ' . implode(' ', array_map(fn($r) => "{$r['code']}: {$r['error']}", array_slice($errors, 0, 5)))
                    . (count($errors) > 5 ? ' …' : ''));
            }
            foreach ($rows as $r) {
                self::insert($inScope[$r['employee_id']], $d['increment_type'], $d['increment_value'], $r['old_salary'], $r['new_salary'],
                    $d['effective_date'], $d['reason'] ?? null, $d['approved_by'] ?? null);
            }
            Audit::log('bulk', 'salary_increments', null, null, ['scope' => $d['scope'], 'scope_id' => $d['scope_id'], 'type' => $d['increment_type'],
                'value' => $d['increment_value'], 'effective_date' => $d['effective_date'], 'employees' => count($rows),
                'excluded' => array_values(array_diff(array_keys($inScope), $ids))]);
            return ['saved' => count($rows), 'rows' => $rows, 'totals' => self::totals($rows)];
        });
    }

    // ------------------------------------------------------------------ reads

    /** Employee's full timeline, newest first, with status and delete eligibility. */
    public static function history(int $employeeId): array
    {
        $rows = Database::all(
            'SELECT i.*, ab.full_name AS approved_by_name, cb.full_name AS created_by_name
               FROM salary_increments i LEFT JOIN users ab ON ab.id = i.approved_by LEFT JOIN users cb ON cb.id = i.created_by
              WHERE i.employee_id = ? ORDER BY i.effective_date DESC, i.id DESC',
            [$employeeId]
        );
        foreach ($rows as $i => &$r) {
            $r['status'] = self::status($r['effective_date']);
            $r['is_latest'] = $i === 0;
            $r['locked'] = (bool)self::postedSheetFrom($employeeId, $r['effective_date']);
            $r['can_delete'] = $i === 0 && $r['increment_type'] !== 'joining' && !$r['locked'];
        }
        return $rows;
    }

    // ------------------------------------------------------------------ employees.basic_salary cache

    /** employees.basic_salary = salary effective today (Asia/Karachi), for all or some employees. */
    public static function syncBasicSalaries(?array $employeeIds = null): int
    {
        $sql = 'UPDATE employees e
                   SET e.basic_salary = COALESCE((SELECT i.new_salary FROM salary_increments i
                                                   WHERE i.employee_id = e.id AND i.effective_date <= ?
                                                   ORDER BY i.effective_date DESC, i.id DESC LIMIT 1), 0)';
        $params = [date('Y-m-d')];
        if ($employeeIds !== null) {
            $ids = array_values(array_filter(array_map('intval', $employeeIds)));
            if (!$ids) {
                return 0;
            }
            $sql .= ' WHERE e.id IN (' . implode(',', $ids) . ')';
        }
        return Database::run($sql, $params)->rowCount();
    }

    /**
     * Scheduled increments become the current salary on their date: the first request of each day
     * (or the optional hPanel cron, tools/sync_salaries.php) refreshes employees.basic_salary.
     */
    public static function syncDue(): void
    {
        $today = date('Y-m-d');
        if (Settings::get('salary_synced_on') === $today) {
            return;
        }
        $n = self::syncBasicSalaries();
        Settings::set('salary_synced_on', $today);
        if ($n > 0) {
            Audit::log('sync', 'employees', null, null, ['basic_salary_updated' => $n, 'date' => $today]);
        }
    }
}
