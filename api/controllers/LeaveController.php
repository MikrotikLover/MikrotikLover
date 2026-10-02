<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\AttendanceEngine;
use App\Audit;
use App\Auth;
use App\Calendar;
use App\Database;
use App\PayrollLock;
use App\Request;
use App\Validator;

/**
 * Employee Leave Register: apply -> approve / reject; approved leave marks working days as
 * L (paid type) or LW (unpaid type) in attendance. Days = working days in the range
 * (weekly rest days and holidays are not counted). Paid types with a yearly quota are checked
 * against the balance.
 */
final class LeaveController
{
    private const RULES = [
        'employee_id'   => 'required|int|exists:employees',
        'leave_type_id' => 'required|int|exists:leave_types',
        'from_date'     => 'required|date',
        'to_date'       => 'required|date|after_or_equal:from_date',
        'reason'        => 'nullable|string|max:255',
    ];
    private const LABELS = ['leave_type_id' => 'Leave type', 'from_date' => 'From date', 'to_date' => 'To date'];

    public function index(Request $r): array
    {
        $year = $r->queryInt('year', (int)date('Y'));
        $where = ['l.from_date <= :ye', 'l.to_date >= :ys'];
        $params = ['ys' => "$year-01-01", 'ye' => "$year-12-31"];
        foreach (['employee_id' => 'l.employee_id', 'department_id' => 'e.department_id', 'leave_type_id' => 'l.leave_type_id'] as $k => $c) {
            if ($v = $r->queryInt($k)) {
                $where[] = "$c = :$k";
                $params[$k] = $v;
            }
        }
        $status = (string)$r->query('status', '');
        if (in_array($status, ['pending', 'approved', 'rejected', 'cancelled'], true)) {
            $where[] = 'l.status = :st';
            $params['st'] = $status;
        }
        if (($q = (string)$r->query('q', '')) !== '') {
            $where[] = '(e.code LIKE :q1 OR e.name LIKE :q2)';
            $params['q1'] = $params['q2'] = "%$q%";
        }
        return Database::all(
            'SELECT l.*, e.code, e.name, e.name_ur, d.name AS department, t.code AS type_code, t.name AS type_name, t.is_paid,
                    u.full_name AS approved_by_name
               FROM leave_register l
               JOIN employees e ON e.id = l.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN leave_types t ON t.id = l.leave_type_id
          LEFT JOIN users u ON u.id = l.approved_by
              WHERE ' . implode(' AND ', $where) . ' ORDER BY l.from_date DESC, e.code',
            $params
        );
    }

    public function show(Request $r): array
    {
        return $this->find($r->id());
    }

    private function find(int $id): array
    {
        $l = Database::one(
            'SELECT l.*, e.code, e.name, e.emp_type, t.code AS type_code, t.name AS type_name, t.is_paid
               FROM leave_register l JOIN employees e ON e.id = l.employee_id JOIN leave_types t ON t.id = l.leave_type_id WHERE l.id = ?',
            [$id]
        );
        if (!$l) {
            throw ApiException::notFound('Leave');
        }
        return $l;
    }

    /** Working days of the leave range for an employee. */
    private function workingDays(array $emp, string $from, string $to): array
    {
        $cal = new Calendar($from, $to);
        $days = [];
        foreach (Calendar::dates($from, $to) as $d) {
            if ($cal->dayType($emp, $d) === null) {
                $days[] = $d;
            }
        }
        return $days;
    }

    private function validateLeave(array $d, ?int $exceptId): array
    {
        $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$d['employee_id']]);
        $type = Database::one('SELECT * FROM leave_types WHERE id = ?', [$d['leave_type_id']]);
        if (substr($d['from_date'], 0, 4) !== substr($d['to_date'], 0, 4)) {
            throw ApiException::validation(['to_date' => 'A leave cannot cross the year end; enter two applications.']);
        }
        if ($d['from_date'] < $emp['joining_date'] || ($emp['leaving_date'] && $d['to_date'] > $emp['leaving_date'])) {
            throw ApiException::validation(['from_date' => 'Leave must be within the employment period.']);
        }
        foreach (Calendar::dates($d['from_date'], $d['to_date']) as $dt) {
            PayrollLock::assertOpen($emp['emp_type'], $dt, 'Leave');
        }
        $days = $this->workingDays($emp, $d['from_date'], $d['to_date']);
        if (!$days) {
            throw ApiException::validation(['to_date' => 'The selected dates are all rest days / holidays.']);
        }
        $overlap = Database::one(
            "SELECT l.from_date, l.to_date, l.status FROM leave_register l
              WHERE l.employee_id = ? AND l.status IN ('pending','approved') AND l.from_date <= ? AND l.to_date >= ?" . ($exceptId ? ' AND l.id <> ?' : ''),
            array_merge([$d['employee_id'], $d['to_date'], $d['from_date']], $exceptId ? [$exceptId] : [])
        );
        if ($overlap) {
            throw ApiException::validation(['from_date' => sprintf('Overlaps a %s leave from %s to %s.', $overlap['status'],
                date('d-m-Y', strtotime($overlap['from_date'])), date('d-m-Y', strtotime($overlap['to_date'])))]);
        }
        if ((int)$type['is_paid'] && (float)$type['yearly_quota'] > 0) {
            $year = substr($d['from_date'], 0, 4);
            $taken = (float)Database::value(
                "SELECT COALESCE(SUM(days),0) FROM leave_register WHERE employee_id = ? AND leave_type_id = ? AND status IN ('pending','approved')
                   AND YEAR(from_date) = ?" . ($exceptId ? ' AND id <> ?' : ''),
                array_merge([$d['employee_id'], $d['leave_type_id'], $year], $exceptId ? [$exceptId] : [])
            );
            $balance = (float)$type['yearly_quota'] - $taken;
            if (count($days) > $balance) {
                throw ApiException::validation(['leave_type_id' => sprintf('%s balance for %s is %s day(s); this leave needs %d.',
                    $type['name'], $year, rtrim(rtrim(number_format($balance, 1), '0'), '.'), count($days))]);
            }
        }
        return $days;
    }

    public function store(Request $r): array
    {
        $d = Validator::make($r->body(), self::RULES, self::LABELS);
        $days = $this->validateLeave($d, null);
        $id = Database::transaction(function () use ($d, $days) {
            $id = Database::insert('leave_register', $d + ['days' => count($days), 'status' => 'pending', 'created_by' => Auth::id()]);
            Audit::log('create', 'leave_register', $id, null, $d + ['days' => count($days)]);
            return $id;
        });
        if ($r->input('approve') && Auth::can('leave', 'post')) {
            $this->changeStatus($id, 'approved');
        }
        return $this->find($id);
    }

    public function update(Request $r): array
    {
        $old = $this->find($r->id());
        if ($old['status'] !== 'pending') {
            throw ApiException::conflict('Only pending leaves can be edited. Cancel the approved leave and apply again.');
        }
        $d = Validator::make($r->body(), self::RULES, self::LABELS);
        $days = $this->validateLeave($d, (int)$old['id']);
        Database::transaction(function () use ($d, $days, $old) {
            Database::update('leave_register', $d + ['days' => count($days), 'updated_by' => Auth::id()], 'id = :id', ['id' => $old['id']]);
            Audit::log('update', 'leave_register', (int)$old['id'], $old, $d + ['days' => count($days)]);
        });
        return $this->find((int)$old['id']);
    }

    public function destroy(Request $r): array
    {
        $old = $this->find($r->id());
        if ($old['status'] === 'approved') {
            throw ApiException::conflict('Cancel the approved leave first.');
        }
        Database::transaction(function () use ($old) {
            Database::run('DELETE FROM leave_register WHERE id = ?', [$old['id']]);
            Audit::log('delete', 'leave_register', (int)$old['id'], $old, null);
        });
        return ['deleted' => true];
    }

    /** POST /leaves/{id}/status {status: approved|rejected|cancelled} */
    public function status(Request $r): array
    {
        $status = (string)$r->input('status');
        if (!in_array($status, ['approved', 'rejected', 'cancelled'], true)) {
            throw ApiException::validation(['status' => 'Invalid status.']);
        }
        $this->changeStatus($r->id(), $status);
        return $this->find($r->id());
    }

    private function changeStatus(int $id, string $status): void
    {
        $l = $this->find($id);
        $allowed = ['approved' => ['pending'], 'rejected' => ['pending'], 'cancelled' => ['pending', 'approved']];
        if (!in_array($l['status'], $allowed[$status], true)) {
            throw ApiException::conflict("A {$l['status']} leave cannot be $status.");
        }
        if ($status === 'approved') {
            $this->validateLeave($l, $id);
        }
        Database::transaction(function () use ($l, $status) {
            $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$l['employee_id']]);
            foreach (Calendar::dates($l['from_date'], $l['to_date']) as $dt) {
                PayrollLock::assertOpen($emp['emp_type'], $dt, 'Leave');
            }
            Database::update('leave_register', [
                'status' => $status,
                'approved_by' => $status === 'approved' ? Auth::id() : $l['approved_by'],
                'approved_at' => $status === 'approved' ? date('Y-m-d H:i:s') : $l['approved_at'],
                'updated_by' => Auth::id(),
            ], 'id = :id', ['id' => $l['id']]);
            Audit::log($status, 'leave_register', (int)$l['id'], ['status' => $l['status']], ['status' => $status]);

            $code = (int)$l['is_paid'] ? 'L' : 'LW';
            $days = $this->workingDays($emp, $l['from_date'], $l['to_date']);
            if ($status === 'approved') {
                foreach ($days as $dt) {
                    if ($dt > date('Y-m-d')) {
                        continue; // future days are marked by Daily Post when they arrive
                    }
                    $a = Database::one('SELECT * FROM attendance_daily WHERE employee_id = ? AND att_date = ?', [$emp['id'], $dt]);
                    if ($a && $a['status'] !== 'A') {
                        continue; // present / already marked
                    }
                    AttendanceEngine::saveRow([
                        'employee_id' => (int)$emp['id'], 'att_date' => $dt, 'shift_id' => $a['shift_id'] ?? null, 'status' => $code,
                        'time_in' => null, 'time_out' => null, 'work_minutes' => 0, 'late_minutes' => 0, 'early_minutes' => 0,
                        'ot_minutes' => 0, 'source' => $a['source'] ?? 'system', 'is_flagged' => 0, 'flag_reason' => null,
                    ], $a && $a['voucher_id'] ? (int)$a['voucher_id'] : null);
                }
            } elseif ($l['status'] === 'approved') {
                // Cancelled: remove the leave marks set by the system and re-post those days.
                $past = array_values(array_filter($days, fn($d) => $d <= date('Y-m-d')));
                if ($past) {
                    foreach ($past as $dt) {
                        Database::run("DELETE FROM attendance_daily WHERE employee_id = ? AND att_date = ? AND status IN ('L','LW') AND source <> 'manual'", [$emp['id'], $dt]);
                    }
                    (new AttendanceEngine(min($past), max($past)))->post(min($past), max($past), ['employee_ids' => [(int)$emp['id']]]);
                }
            }
        });
    }

    /** GET /leaves/balance?employee_id=&year= */
    public function balance(Request $r): array
    {
        $emp = $r->queryInt('employee_id');
        $year = $r->queryInt('year', (int)date('Y'));
        if (!$emp) {
            throw ApiException::validation(['employee_id' => 'Select an employee.']);
        }
        return Database::all(
            "SELECT t.id, t.code, t.name, t.name_ur, t.is_paid, t.yearly_quota,
                    COALESCE(SUM(CASE WHEN l.status = 'approved' THEN l.days END), 0) AS used,
                    COALESCE(SUM(CASE WHEN l.status = 'pending' THEN l.days END), 0) AS pending
               FROM leave_types t
          LEFT JOIN leave_register l ON l.leave_type_id = t.id AND l.employee_id = ? AND YEAR(l.from_date) = ?
              WHERE t.is_active = 1
           GROUP BY t.id, t.code, t.name, t.name_ur, t.is_paid, t.yearly_quota ORDER BY t.code",
            [$emp, $year]
        );
    }
}
