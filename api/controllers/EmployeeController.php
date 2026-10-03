<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Config;
use App\Database;
use App\Increments;
use App\Request;
use App\Storage;
use App\Validator;

final class EmployeeController
{
    private const RULES = [
        'code'           => 'required|code|max:20',
        'name'           => 'required|string|max:100',
        'name_ur'        => 'nullable|string|max:100',
        'relation'       => 'required|in:S/O,W/O,D/O',
        'father_name'    => 'nullable|string|max:100',
        'father_name_ur' => 'nullable|string|max:100',
        'gender'         => 'required|in:M,F',
        'address'        => 'nullable|string|max:255',
        'city'           => 'nullable|string|max:60',
        'dob'            => 'nullable|date|before:joining_date',
        'cell'           => 'nullable|phone|max:20',
        'phone_res'      => 'nullable|phone|max:20',
        'reference'      => 'nullable|string|max:100',
        'qualification'  => 'nullable|string|max:100',
        'cnic'           => 'nullable|cnic',
        'email'          => 'nullable|email|max:120',
        'department_id'  => 'required|int|exists:departments',
        'designation_id' => 'required|int|exists:designations',
        'emp_type'       => 'required|in:permanent,daily_wages,contract',
        'joining_date'   => 'required|date',
        'leaving_date'   => 'nullable|date|after_or_equal:joining_date',
        'shift_group_id' => 'nullable|int|exists:shift_groups',
        'shift_date'     => 'nullable|date',
        'status'         => 'required|in:active,inactive',
        'machine_id'     => 'nullable|int|min:1|max:4294967295',
        'remarks'        => 'nullable|string|max:255',
    ];

    private const LABELS = [
        'dob' => 'Date of birth', 'cnic' => 'CNIC', 'cell' => 'Cell no.', 'phone_res' => 'Phone (res)',
        'emp_type' => 'Type', 'machine_id' => 'Machine ID', 'father_name' => 'Father/Husband name',
        'joining_date' => 'Joining date', 'leaving_date' => 'Leaving date',
    ];

    /**
     * Salary info = the terms (allowances, OT, statutory, payment). The pay rate itself lives in
     * salary_increments: basic_salary / daily_rate here are only read when a new employee is created
     * (they become the joining row); on later records they are stored as a snapshot of the increment rate.
     */
    private const SALARY_RULES = [
        'effective_from'   => 'required|date',
        'basic_salary'     => 'nullable|num|min:0|max:99999999',
        'daily_rate'       => 'nullable|num|min:0|max:9999999',
        'allowances'       => 'required|num|min:0|max:99999999',
        'ot_applicable'    => 'bool',
        'ot_rate'          => 'nullable|num|min:0|max:999999',
        'eobi_applicable'  => 'bool',
        'pessi_applicable' => 'bool',
        'tax_applicable'   => 'bool',
        'payment_mode'     => 'required|in:cash,bank',
        'bank_name'        => 'nullable|string|max:100',
        'bank_account'     => 'nullable|string|max:40',
        'reason'           => 'nullable|string|max:100',
        'remarks'          => 'nullable|string|max:255',
    ];

    private const SORTS = [
        'code' => 'e.code', 'name' => 'e.name', 'department' => 'd.name, e.name', 'designation' => 'g.name, e.name',
        'joining_date' => 'e.joining_date', 'id' => 'e.id',
    ];

    // ------------------------------------------------------------------ list

    public function index(Request $r): array
    {
        [$where, $params] = self::filters($r);
        $sort = self::SORTS[$r->query('sort', 'code')] ?? 'e.code';
        $dir = strtolower((string)$r->query('dir', 'asc')) === 'desc' ? 'DESC' : 'ASC';
        $perPage = min(max($r->queryInt('per_page', 50), 0), 1000);
        $page = max($r->queryInt('page', 1), 1);

        $from = ' FROM employees e
                  JOIN departments d  ON d.id = e.department_id
                  JOIN designations g ON g.id = e.designation_id
             LEFT JOIN shift_groups sg ON sg.id = e.shift_group_id'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '');

        $total = (int)Database::value('SELECT COUNT(*)' . $from, $params);
        $sql = 'SELECT e.id, e.code, e.name, e.name_ur, e.relation, e.father_name, e.cnic, e.cell, e.city,
                       e.emp_type, e.status, e.joining_date, e.leaving_date, e.machine_id,
                       e.department_id, d.name AS department, d.name_ur AS department_ur,
                       e.designation_id, g.name AS designation, g.name_ur AS designation_ur,
                       sg.name AS shift_group, (e.photo_file IS NOT NULL) AS has_photo,
                       IF(e.emp_type = \'daily_wages\', 0, e.basic_salary) AS basic_salary,
                       IF(e.emp_type = \'daily_wages\', e.basic_salary, 0) AS daily_rate'
            . $from . " ORDER BY $sort $dir, e.id";
        if ($perPage > 0) {
            $sql .= ' LIMIT ' . $perPage . ' OFFSET ' . (($page - 1) * $perPage);
        }
        return ['rows' => Database::all($sql, $params), 'total' => $total, 'page' => $page, 'per_page' => $perPage];
    }

    /** Shared list filters (also used by the Employee List report and ID cards). */
    public static function filters(Request $r): array
    {
        $where = [];
        $params = [];
        $q = (string)$r->query('q', '');
        if ($q !== '') {
            $where[] = '(e.code LIKE :q1 OR e.name LIKE :q2 OR e.name_ur LIKE :q3 OR e.cnic LIKE :q4
                         OR e.cell LIKE :q5 OR e.father_name LIKE :q6 OR e.machine_id = :q7)';
            foreach (range(1, 6) as $i) {
                $params["q$i"] = "%$q%";
            }
            $params['q7'] = ctype_digit($q) ? (int)$q : -1;
        }
        foreach (['department_id' => 'e.department_id', 'designation_id' => 'e.designation_id', 'shift_group_id' => 'e.shift_group_id'] as $k => $col) {
            $v = $r->queryInt($k);
            if ($v) {
                $where[] = "$col = :$k";
                $params[$k] = $v;
            }
        }
        $status = (string)$r->query('status', '');
        if (in_array($status, ['active', 'inactive'], true)) {
            $where[] = 'e.status = :status';
            $params['status'] = $status;
        }
        $type = (string)$r->query('emp_type', '');
        if (in_array($type, ['permanent', 'daily_wages', 'contract'], true)) {
            $where[] = 'e.emp_type = :emp_type';
            $params['emp_type'] = $type;
        }
        $ids = (string)$r->query('ids', '');
        if ($ids !== '') {
            $list = array_values(array_filter(array_map('intval', explode(',', $ids))));
            if ($list) {
                $ph = [];
                foreach (array_slice($list, 0, 1000) as $i => $id) {
                    $ph[] = ":id$i";
                    $params["id$i"] = $id;
                }
                $where[] = 'e.id IN (' . implode(',', $ph) . ')';
            }
        }
        return [$where, $params];
    }

    // ------------------------------------------------------------------ single

    public function show(Request $r): array
    {
        return $this->load($r->id());
    }

    private function load(int $id): array
    {
        $e = Database::one(
            'SELECT e.*, d.name AS department, d.name_ur AS department_ur, g.name AS designation, g.name_ur AS designation_ur,
                    sg.name AS shift_group, cu.full_name AS created_by_name, uu.full_name AS updated_by_name
               FROM employees e
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN shift_groups sg ON sg.id = e.shift_group_id
          LEFT JOIN users cu ON cu.id = e.created_by
          LEFT JOIN users uu ON uu.id = e.updated_by
              WHERE e.id = ?',
            [$id]
        );
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        $e['salary_history'] = $this->salaryRows($id);
        $e['shift_history'] = Database::all(
            'SELECT h.shift_date, h.changed_at, sg.code AS shift_group_code, sg.name AS shift_group, u.full_name AS changed_by_name
               FROM employee_shift_history h LEFT JOIN shift_groups sg ON sg.id = h.shift_group_id LEFT JOIN users u ON u.id = h.changed_by
              WHERE h.employee_id = ? ORDER BY h.changed_at DESC, h.id DESC',
            [$id]
        );
        $e['qualifications'] = Database::all(
            'SELECT degree, institute, passing_year, grade, remarks FROM employee_qualifications WHERE employee_id = ? ORDER BY id',
            [$id]
        );
        $e['experiences'] = Database::all(
            'SELECT organization, designation, from_date, to_date, reason_left, remarks FROM employee_experiences WHERE employee_id = ? ORDER BY id',
            [$id]
        );
        $e['photo_url'] = $e['photo_file'] ? 'file.php?t=photo&emp=' . $id . '&v=' . rawurlencode($e['photo_file']) : null;
        return $e;
    }

    private function salaryRows(int $id): array
    {
        $rows = Database::all(
            'SELECT h.*, cu.full_name AS created_by_name FROM employee_salary_history h
               LEFT JOIN users cu ON cu.id = h.created_by
              WHERE h.employee_id = ? ORDER BY h.effective_from DESC',
            [$id]
        );
        $today = date('Y-m-d');
        $currentMarked = false;
        foreach ($rows as &$row) {
            $row['is_current'] = false;
            if (!$currentMarked && $row['effective_from'] <= $today) {
                $row['is_current'] = true;
                $currentMarked = true;
            }
            $row['is_locked'] = $this->salaryLocked($id, $row['effective_from']);
        }
        return $rows;
    }

    /** Navigation for Prev / Next buttons (by Auto ID). */
    public function neighbor(Request $r): ?array
    {
        $id = (int)$r->params['id'];
        $dir = $r->query('dir') === 'prev' ? 'prev' : 'next';
        $sql = $dir === 'prev'
            ? 'SELECT id FROM employees WHERE id < ? ORDER BY id DESC LIMIT 1'
            : 'SELECT id FROM employees WHERE id > ? ORDER BY id ASC LIMIT 1';
        if ($id === 0) { // from a blank form: first / last record
            $next = Database::value($dir === 'prev' ? 'SELECT MAX(id) FROM employees' : 'SELECT MIN(id) FROM employees');
        } else {
            $next = Database::value($sql, [$id]);
        }
        return $next ? $this->load((int)$next) : null;
    }

    /** Exact lookup by employee code (keyboard pickers). */
    public function lookup(Request $r): ?array
    {
        $code = (string)$r->query('code', '');
        if ($code === '') {
            return null;
        }
        return Database::one(
            'SELECT e.id, e.code, e.name, e.name_ur, e.status, e.emp_type, e.joining_date, e.leaving_date, e.department_id,
                    d.name AS department, g.name AS designation
               FROM employees e JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              WHERE e.code = ?',
            [$code]
        );
    }

    public function nextCode(Request $r): array
    {
        $max = Database::value("SELECT MAX(CAST(code AS UNSIGNED)) FROM employees WHERE code REGEXP '^[0-9]+$'");
        $len = (int)Database::value("SELECT MAX(CHAR_LENGTH(code)) FROM employees WHERE code REGEXP '^[0-9]+$'");
        $next = (int)$max + 1;
        return ['code' => str_pad((string)$next, max(4, $len), '0', STR_PAD_LEFT)];
    }

    // ------------------------------------------------------------------ save

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        $existing = Database::one('SELECT * FROM employees WHERE id = ?', [$r->id()]);
        if (!$existing) {
            throw ApiException::notFound('Employee');
        }
        return $this->save($r, $existing);
    }

    private function save(Request $r, ?array $existing): array
    {
        $body = $r->body();
        $data = Validator::make($body, self::RULES, self::LABELS);
        $id = $existing ? (int)$existing['id'] : null;

        // uniqueness
        $errors = [];
        foreach (['code' => 'Code', 'cnic' => 'CNIC', 'machine_id' => 'Machine ID'] as $col => $label) {
            if ($data[$col] === null) {
                continue;
            }
            $other = Database::one(
                "SELECT id, code, name FROM employees WHERE `$col` = :v" . ($id ? ' AND id <> :id' : ''),
                ['v' => $data[$col]] + ($id ? ['id' => $id] : [])
            );
            if ($other) {
                $errors[$col] = "$label is already assigned to {$other['code']} - {$other['name']}.";
            }
        }
        if ($data['shift_group_id'] && !$data['shift_date']) {
            $data['shift_date'] = $data['joining_date'];
        }
        if (!$data['shift_group_id']) {
            $data['shift_date'] = null;
        }
        if ($data['dob'] && $data['dob'] > date('Y-m-d', strtotime('-14 years'))) {
            $errors['dob'] = 'Employee must be at least 14 years old.';
        }

        // Attendance must stay inside the employment period.
        if ($id) {
            $before = Database::value(
                "SELECT MIN(att_date) FROM attendance_daily WHERE employee_id = ? AND att_date < ? AND status <> 'O'",
                [$id, $data['joining_date']]
            );
            if ($before) {
                $errors['joining_date'] = "Attendance exists on $before, before this joining date.";
            }
            if ($data['leaving_date']) {
                $after = Database::value(
                    "SELECT MAX(att_date) FROM attendance_daily WHERE employee_id = ? AND att_date > ? AND status <> 'O'",
                    [$id, $data['leaving_date']]
                );
                if ($after) {
                    $errors['leaving_date'] = "Attendance exists on $after, after this leaving date.";
                }
            }
        }

        // Initial salary (new employee only; later changes go through the salary history endpoints)
        $salary = null;
        if (!$existing && !empty($body['salary']) && is_array($body['salary'])) {
            $sb = $body['salary'] + ['effective_from' => $data['joining_date']];
            if (empty($sb['effective_from'])) {
                $sb['effective_from'] = $data['joining_date'];
            }
            try {
                $salary = Validator::make($sb, self::SALARY_RULES);
                $this->checkSalaryTypeFields($salary, $data['emp_type'], true);
                // the joining salary is kept exactly as typed (decimal string, no float)
                $raw = $data['emp_type'] === 'daily_wages' ? ($sb['daily_rate'] ?? null) : ($sb['basic_salary'] ?? null);
                $salary['_joining'] = Increments::decimal($raw)
                    ?? throw ApiException::validation([$data['emp_type'] === 'daily_wages' ? 'daily_rate' : 'basic_salary' => 'Enter an amount with at most 2 decimals.']);
                $salary['basic_salary'] ??= 0;
                $salary['daily_rate'] ??= 0;
            } catch (ApiException $e) {
                foreach ($e->errors() as $k => $msg) {
                    $errors["salary.$k"] = $msg;
                }
            }
        }

        $quals = $this->cleanRows($body['qualifications'] ?? null, ['degree' => 'required|string|max:100',
            'institute' => 'nullable|string|max:150', 'passing_year' => 'nullable|int|min:1950|max:2100',
            'grade' => 'nullable|string|max:20', 'remarks' => 'nullable|string|max:255'], 'qualifications', $errors);
        $exps = $this->cleanRows($body['experiences'] ?? null, ['organization' => 'required|string|max:150',
            'designation' => 'nullable|string|max:100', 'from_date' => 'nullable|date',
            'to_date' => 'nullable|date|after_or_equal:from_date', 'reason_left' => 'nullable|string|max:150',
            'remarks' => 'nullable|string|max:255'], 'experiences', $errors);

        if ($errors) {
            throw ApiException::validation($errors);
        }

        $id = Database::transaction(function () use ($data, $existing, $salary, $quals, $exps) {
            if ($existing) {
                $id = (int)$existing['id'];
                Database::update('employees', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
                Audit::log('update', 'employees', $id, $existing, $data);
                Increments::moveJoining($id, $existing['joining_date'], $data['joining_date']); // the joining row follows the joining date
                if ((int)$existing['shift_group_id'] !== (int)$data['shift_group_id'] || $existing['shift_date'] !== $data['shift_date']) {
                    if ($existing['shift_group_id'] && !Database::value('SELECT 1 FROM employee_shift_history WHERE employee_id = ?', [$id])) {
                        self::logShift($id, $existing); // first change: keep the assignment it replaces
                    }
                    self::logShift($id, $data);
                }
            } else {
                $id = Database::insert('employees', $data + ['created_by' => Auth::id()]);
                Audit::log('create', 'employees', $id, null, $data);
                $joining = '0.00';
                if ($salary) {
                    $joining = $salary['_joining'];
                    unset($salary['_joining']);
                    $sid = Database::insert('employee_salary_history', $salary + ['employee_id' => $id, 'created_by' => Auth::id(),
                        'reason' => $salary['reason'] ?? 'Appointment']);
                    Audit::log('create', 'employee_salary_history', $sid, null, $salary + ['employee_id' => $id]);
                }
                Increments::addJoining($id, $data['joining_date'], $joining); // every employee starts with a 'joining' row
                if ($data['shift_group_id']) {
                    self::logShift($id, $data);
                }
            }
            if ($quals !== null) {
                Database::run('DELETE FROM employee_qualifications WHERE employee_id = ?', [$id]);
                foreach ($quals as $q) {
                    Database::insert('employee_qualifications', $q + ['employee_id' => $id]);
                }
            }
            if ($exps !== null) {
                Database::run('DELETE FROM employee_experiences WHERE employee_id = ?', [$id]);
                foreach ($exps as $x) {
                    Database::insert('employee_experiences', $x + ['employee_id' => $id]);
                }
            }
            return $id;
        });
        return $this->load($id);
    }

    /** Shift group history: one row per change of group or rotation start date. */
    private static function logShift(int $id, array $data): void
    {
        Database::insert('employee_shift_history', ['employee_id' => $id, 'shift_group_id' => $data['shift_group_id'] ?: null,
            'shift_date' => $data['shift_date'], 'changed_by' => Auth::id()]);
    }

    /** Validate repeatable child rows; blank rows are skipped. null = not sent (leave unchanged). */
    private function cleanRows(mixed $rows, array $rules, string $key, array &$errors): ?array
    {
        if ($rows === null) {
            return null;
        }
        if (!is_array($rows)) {
            $errors[$key] = 'Invalid rows.';
            return null;
        }
        $out = [];
        foreach (array_values($rows) as $i => $row) {
            if (!is_array($row) || !array_filter($row, fn($v) => $v !== null && $v !== '')) {
                continue;
            }
            try {
                $out[] = Validator::make($row, $rules);
            } catch (ApiException $e) {
                $errors[$key] = 'Row ' . ($i + 1) . ': ' . implode(' ', $e->errors());
            }
        }
        return $out;
    }

    public function destroy(Request $r): array
    {
        $id = $r->id();
        $e = Database::one('SELECT * FROM employees WHERE id = ?', [$id]);
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        // An employee with attendance, vouchers, overtime, leave or salary records is never removed: the record is
        // kept and set Inactive (soft delete). Only an employee without any such data is deleted.
        $used = Database::value(
            'SELECT (SELECT COUNT(*) FROM attendance_daily WHERE employee_id = :a) + (SELECT COUNT(*) FROM salary_sheet_lines WHERE employee_id = :b)
                  + (SELECT COUNT(*) FROM vouchers WHERE employee_id = :c) + (SELECT COUNT(*) FROM overtime WHERE employee_id = :d)
                  + (SELECT COUNT(*) FROM leave_register WHERE employee_id = :e) + (SELECT COUNT(*) FROM attendance_punches WHERE employee_id = :f)',
            ['a' => $id, 'b' => $id, 'c' => $id, 'd' => $id, 'e' => $id, 'f' => $id]
        );
        if ((int)$used > 0) {
            if ($e['status'] === 'inactive') {
                throw ApiException::conflict('This employee has attendance or salary records and is already inactive; it cannot be removed.');
            }
            Database::transaction(function () use ($e, $id) {
                Database::update('employees', ['status' => 'inactive', 'updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
                Audit::log('deactivate', 'employees', $id, ['status' => $e['status']], ['status' => 'inactive', 'reason' => 'delete requested; employee has records']);
            });
            return ['deleted' => false, 'deactivated' => true, 'message' => 'The employee has attendance or salary records, so the record was kept and set Inactive.'];
        }
        try {
            Database::transaction(function () use ($e, $id) {
                Database::run('DELETE FROM employees WHERE id = ?', [$id]);
                Audit::log('delete', 'employees', $id, $e, null);
            });
        } catch (\PDOException $ex) {
            if (($ex->errorInfo[1] ?? 0) === 1451) {
                throw ApiException::conflict('This employee is referenced by other records and cannot be deleted. Set the status to Inactive instead.');
            }
            throw $ex;
        }
        Storage::delete('photos', $e['photo_file']);
        return ['deleted' => true];
    }

    // ------------------------------------------------------------------ photo

    public function uploadPhoto(Request $r): array
    {
        $id = $r->id();
        $e = Database::one('SELECT id, photo_file FROM employees WHERE id = ?', [$id]);
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        if (empty($_FILES['photo'])) {
            throw ApiException::validation(['photo' => 'Choose a photo to upload.']);
        }
        $name = Storage::storeImage(
            $_FILES['photo'],
            'photos',
            'emp' . $id,
            (int)Config::get('uploads.photo_width', 300),
            (int)Config::get('uploads.photo_height', 400)
        );
        Database::update('employees', ['photo_file' => $name, 'updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
        Audit::log('update', 'employees', $id, ['photo_file' => $e['photo_file']], ['photo_file' => $name]);
        Storage::delete('photos', $e['photo_file']);
        return ['photo_url' => 'file.php?t=photo&emp=' . $id . '&v=' . rawurlencode($name)];
    }

    public function deletePhoto(Request $r): array
    {
        $id = $r->id();
        $e = Database::one('SELECT id, photo_file FROM employees WHERE id = ?', [$id]);
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        Database::update('employees', ['photo_file' => null, 'updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
        Audit::log('update', 'employees', $id, ['photo_file' => $e['photo_file']], ['photo_file' => null]);
        Storage::delete('photos', $e['photo_file']);
        return ['photo_url' => null];
    }

    // ------------------------------------------------------------------ salary history

    public function salaryIndex(Request $r): array
    {
        return $this->salaryRows($r->id());
    }

    public function salaryStore(Request $r): array
    {
        $emp = $this->employeeForSalary($r->id());
        $data = $this->snapshotRate($emp, Validator::make($r->body(), self::SALARY_RULES));
        $this->checkSalary($emp, $data, null);
        $sid = Database::transaction(function () use ($emp, $data) {
            $sid = Database::insert('employee_salary_history', $data + ['employee_id' => $emp['id'], 'created_by' => Auth::id()]);
            Audit::log('create', 'employee_salary_history', $sid, null, $data + ['employee_id' => $emp['id']]);
            return $sid;
        });
        return ['id' => $sid, 'rows' => $this->salaryRows((int)$emp['id'])];
    }

    public function salaryUpdate(Request $r): array
    {
        $emp = $this->employeeForSalary($r->id());
        $row = $this->salaryRow((int)$emp['id'], $r->id('sid'));
        $data = $this->snapshotRate($emp, Validator::make($r->body(), self::SALARY_RULES));
        $this->checkSalary($emp, $data, $row);
        Database::transaction(function () use ($row, $data) {
            Database::update('employee_salary_history', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $row['id']]);
            Audit::log('update', 'employee_salary_history', (int)$row['id'], $row, $data);
        });
        return ['id' => (int)$row['id'], 'rows' => $this->salaryRows((int)$emp['id'])];
    }

    public function salaryDestroy(Request $r): array
    {
        $emp = $this->employeeForSalary($r->id());
        $row = $this->salaryRow((int)$emp['id'], $r->id('sid'));
        if ($this->salaryLocked((int)$emp['id'], $row['effective_from'])) {
            throw ApiException::conflict('This salary record is used by a posted salary sheet and cannot be deleted.');
        }
        Database::transaction(function () use ($row) {
            Database::run('DELETE FROM employee_salary_history WHERE id = ?', [$row['id']]);
            Audit::log('delete', 'employee_salary_history', (int)$row['id'], $row, null);
        });
        return ['rows' => $this->salaryRows((int)$emp['id'])];
    }

    private function employeeForSalary(int $id): array
    {
        $e = Database::one('SELECT id, emp_type, joining_date FROM employees WHERE id = ?', [$id]);
        if (!$e) {
            throw ApiException::notFound('Employee');
        }
        return $e;
    }

    private function salaryRow(int $empId, int $sid): array
    {
        $row = Database::one('SELECT * FROM employee_salary_history WHERE id = ? AND employee_id = ?', [$sid, $empId]);
        if (!$row) {
            throw ApiException::notFound('Salary record');
        }
        return $row;
    }

    /** A salary row is locked once a posted salary sheet covers a period on/after its effective date. */
    private function salaryLocked(int $empId, string $effectiveFrom): bool
    {
        return (bool)Database::value(
            "SELECT 1 FROM salary_sheet_lines l JOIN salary_sheets s ON s.id = l.salary_sheet_id
              WHERE l.employee_id = ? AND s.status = 'posted' AND s.period_to >= ? LIMIT 1",
            [$empId, $effectiveFrom]
        );
    }

    /** Rate columns of a salary info record = the increment rate on its effective date (never typed in). */
    private function snapshotRate(array $emp, array $data): array
    {
        $rate = Increments::getSalaryOnDate((int)$emp['id'], $data['effective_from']);
        $data['basic_salary'] = $emp['emp_type'] === 'daily_wages' ? 0 : $rate;
        $data['daily_rate'] = $emp['emp_type'] === 'daily_wages' ? $rate : 0;
        return $data;
    }

    private function checkSalaryTypeFields(array $data, string $empType, bool $rateRequired = false): void
    {
        if ($rateRequired && $empType === 'daily_wages' && ($data['daily_rate'] ?? 0) <= 0) {
            throw ApiException::validation(['daily_rate' => 'Daily rate is required for daily wages employees.']);
        }
        if ($rateRequired && $empType !== 'daily_wages' && ($data['basic_salary'] ?? 0) <= 0) {
            throw ApiException::validation(['basic_salary' => 'Basic salary is required.']);
        }
        if ($data['payment_mode'] === 'bank' && !$data['bank_account']) {
            throw ApiException::validation(['bank_account' => 'Bank account is required for bank payment.']);
        }
    }

    private function checkSalary(array $emp, array $data, ?array $existing): void
    {
        $this->checkSalaryTypeFields($data, $emp['emp_type']);
        if ($data['effective_from'] < $emp['joining_date']) {
            throw ApiException::validation(['effective_from' => 'Effective date cannot be before the joining date (' . $emp['joining_date'] . ').']);
        }
        $dup = Database::value(
            'SELECT id FROM employee_salary_history WHERE employee_id = ? AND effective_from = ?' . ($existing ? ' AND id <> ?' : ''),
            $existing ? [$emp['id'], $data['effective_from'], $existing['id']] : [$emp['id'], $data['effective_from']]
        );
        if ($dup) {
            throw ApiException::validation(['effective_from' => 'A salary record with this effective date already exists.']);
        }
        if ($this->salaryLocked((int)$emp['id'], $data['effective_from'])
            || ($existing && $this->salaryLocked((int)$emp['id'], $existing['effective_from']))) {
            throw ApiException::conflict('Salary for posted months cannot be changed. Add a new record effective from the next unposted month.');
        }
    }
}
