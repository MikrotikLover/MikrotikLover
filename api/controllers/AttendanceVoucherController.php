<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\AttendanceEngine;
use App\Audit;
use App\Auth;
use App\Database;
use App\PayrollLock;
use App\Request;
use App\Validator;

/**
 * Manual Attendance Voucher: date + department -> grid of employees employed on that date.
 * Saved rows become source 'manual' (kept by Daily Post unless overwrite is chosen).
 */
final class AttendanceVoucherController
{
    public function index(Request $r): array
    {
        $from = $r->query('from') ?: date('Y-m-01');
        $to = $r->query('to') ?: date('Y-m-d');
        return Database::all(
            'SELECT v.id, v.vr_no, v.vr_date, v.department_id, d.name AS department, v.remarks,
                    (SELECT COUNT(*) FROM attendance_daily a WHERE a.voucher_id = v.id) AS rows_count,
                    u.full_name AS created_by_name, v.created_at
               FROM attendance_vouchers v
          LEFT JOIN departments d ON d.id = v.department_id
          LEFT JOIN users u ON u.id = v.created_by
              WHERE v.vr_date BETWEEN ? AND ? ORDER BY v.vr_date DESC, d.name',
            [$from, $to]
        );
    }

    /** Grid for date + department: existing attendance (any source) or the expected status. */
    public function load(Request $r): array
    {
        $data = Validator::make(['vr_date' => $r->query('date'), 'department_id' => $r->query('department_id')], [
            'vr_date' => 'required|date', 'department_id' => 'required|int|exists:departments',
        ], ['vr_date' => 'Date']);
        return $this->grid($data['vr_date'], (int)$data['department_id']);
    }

    private function grid(string $date, int $deptId): array
    {
        $data = ['department_id' => $deptId];
        $voucher = Database::one('SELECT v.*, u.full_name AS created_by_name FROM attendance_vouchers v LEFT JOIN users u ON u.id = v.created_by
                                   WHERE v.vr_date = ? AND v.department_id = ?', [$date, $data['department_id']]);
        $emps = Database::all(
            "SELECT e.*, g.name AS designation, d.name AS department
               FROM employees e JOIN designations g ON g.id = e.designation_id JOIN departments d ON d.id = e.department_id
              WHERE e.department_id = ? AND e.joining_date <= ? AND (e.leaving_date IS NULL OR e.leaving_date >= ?)
                AND (e.status = 'active' OR e.leaving_date IS NOT NULL)
              ORDER BY e.code",
            [$data['department_id'], $date, $date]
        );
        $engine = new AttendanceEngine($date, $date);
        $cal = $engine->calendar();
        $att = [];
        if ($emps) {
            $in = implode(',', array_map(fn($e) => (int)$e['id'], $emps));
            foreach (Database::all("SELECT * FROM attendance_daily WHERE att_date = ? AND employee_id IN ($in)", [$date]) as $a) {
                $att[(int)$a['employee_id']] = $a;
            }
            $leaves = [];
            foreach (Database::all("SELECT l.employee_id, t.is_paid, t.code FROM leave_register l JOIN leave_types t ON t.id = l.leave_type_id
                                     WHERE l.status = 'approved' AND ? BETWEEN l.from_date AND l.to_date AND l.employee_id IN ($in)", [$date]) as $l) {
                $leaves[(int)$l['employee_id']] = $l;
            }
        }
        $holiday = $cal->holiday($date);
        $rows = [];
        foreach ($emps as $e) {
            $id = (int)$e['id'];
            $a = $att[$id] ?? null;
            $shift = $a && $a['shift_id'] ? $cal->shiftById((int)$a['shift_id']) : $cal->shift($e, $date);
            $expected = $cal->dayType($e, $date) ?? (isset($leaves[$id]) ? ((int)$leaves[$id]['is_paid'] ? 'L' : 'LW') : null);
            $rows[] = [
                'employee_id'  => $id,
                'code'         => $e['code'],
                'name'         => $e['name'],
                'name_ur'      => $e['name_ur'],
                'department'   => $e['department'],
                'designation'  => $e['designation'],
                'emp_type'     => $e['emp_type'],
                'shift_id'     => $shift ? (int)$shift['id'] : null,
                'status'       => $a['status'] ?? $expected,
                'expected'     => $expected,
                'time_in'      => $a && $a['time_in'] ? substr($a['time_in'], 11, 5) : null,
                'time_out'     => $a && $a['time_out'] ? substr($a['time_out'], 11, 5) : null,
                'work_minutes' => $a ? (int)$a['work_minutes'] : 0,
                'remarks'      => $a['remarks'] ?? null,
                'source'       => $a['source'] ?? null,
                'saved'        => $a !== null,
                'flag_reason'  => $a['flag_reason'] ?? null,
                'locked'       => PayrollLock::isLocked($e['emp_type'], $date),
            ];
        }
        return [
            'voucher' => $voucher,
            'date'    => $date,
            'day'     => date('l', strtotime($date)),
            'holiday' => $holiday,
            'rows'    => $rows,
        ];
    }

    /**
     * Save: {vr_date, department_id, remarks, rows:[{employee_id,status,shift_id,time_in,time_out,remarks}], delete_ids:[employee_id]}
     */
    public function save(Request $r): array
    {
        $head = Validator::make($r->body(), [
            'vr_date' => 'required|date', 'department_id' => 'required|int|exists:departments', 'remarks' => 'nullable|string|max:255',
            'rows' => 'nullable|array', 'delete_ids' => 'nullable|array',
        ], ['vr_date' => 'Date']);
        $date = $head['vr_date'];
        $rows = $head['rows'] ?? [];
        $deleteIds = array_values(array_unique(array_map('intval', $head['delete_ids'] ?? [])));
        if (!$rows && !$deleteIds) {
            throw ApiException::validation(['rows' => 'Nothing to save. Mark at least one employee.']);
        }
        $engine = new AttendanceEngine($date, $date);
        $prepared = [];
        $seen = [];
        foreach ($rows as $i => $row) {
            $eid = (int)($row['employee_id'] ?? 0);
            if (isset($seen[$eid])) {
                throw ApiException::validation(['rows' => 'Row ' . ($i + 1) . ': the same employee appears twice.']);
            }
            $seen[$eid] = true;
            $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$eid]);
            if (!$emp) {
                throw ApiException::validation(['rows' => 'Row ' . ($i + 1) . ': employee not found.']);
            }
            if ((int)$emp['department_id'] !== (int)$head['department_id']) {
                throw ApiException::validation(['rows' => "{$emp['code']} {$emp['name']} is not in the selected department."]);
            }
            try {
                $prepared[] = $engine->manualRow($emp, $date, $row);
            } catch (ApiException $e) {
                $msg = implode(' ', $e->errors()) ?: $e->getMessage();
                throw new ApiException('Row ' . ($i + 1) . ': ' . $msg, $e->status(), ['rows' => 'Row ' . ($i + 1) . ': ' . $msg, 'row' => (string)$i]);
            }
        }
        $deletes = [];
        foreach ($deleteIds as $eid) {
            $a = Database::one('SELECT a.*, e.emp_type, e.code FROM attendance_daily a JOIN employees e ON e.id = a.employee_id WHERE a.employee_id = ? AND a.att_date = ?', [$eid, $date]);
            if ($a) {
                PayrollLock::assertOpen($a['emp_type'], $date);
                $deletes[] = $a;
            }
        }

        $vid = Database::transaction(function () use ($head, $date, $prepared, $deletes) {
            $v = Database::one('SELECT * FROM attendance_vouchers WHERE vr_date = ? AND department_id = ? FOR UPDATE', [$date, $head['department_id']]);
            if ($v) {
                $vid = (int)$v['id'];
                Database::update('attendance_vouchers', ['remarks' => $head['remarks'], 'updated_by' => Auth::id()], 'id = :id', ['id' => $vid]);
            } else {
                $vid = Database::insert('attendance_vouchers', [
                    'vr_no' => Database::nextSequence('ATT', 0), 'vr_date' => $date, 'department_id' => $head['department_id'],
                    'remarks' => $head['remarks'], 'created_by' => Auth::id(),
                ]);
            }
            foreach ($prepared as $row) {
                $old = Database::one('SELECT * FROM attendance_daily WHERE employee_id = ? AND att_date = ?', [$row['employee_id'], $date]);
                $id = AttendanceEngine::saveRow($row, $vid);
                Audit::log($old ? 'update' : 'create', 'attendance_daily', $id, $old, $row);
            }
            foreach ($deletes as $a) {
                Database::run("DELETE FROM overtime WHERE employee_id = ? AND ot_date = ? AND salary_sheet_id IS NULL", [$a['employee_id'], $date]);
                Database::run('DELETE FROM attendance_daily WHERE id = ?', [$a['id']]);
                Audit::log('delete', 'attendance_daily', (int)$a['id'], $a, null);
            }
            Audit::log($prepared ? 'save' : 'update', 'attendance_vouchers', $vid, null, ['vr_date' => $date, 'rows' => count($prepared), 'deleted' => count($deletes)]);
            return $vid;
        });

        $out = $this->grid($date, (int)$head['department_id']);
        $out['saved'] = ['voucher_id' => $vid, 'rows' => count($prepared), 'deleted' => count($deletes)];
        return $out;
    }

    /** Delete voucher and the attendance rows it created. */
    public function destroy(Request $r): array
    {
        $v = Database::one('SELECT * FROM attendance_vouchers WHERE id = ?', [$r->id()]);
        if (!$v) {
            throw ApiException::notFound('Attendance voucher');
        }
        $rows = Database::all('SELECT a.*, e.emp_type FROM attendance_daily a JOIN employees e ON e.id = a.employee_id WHERE a.voucher_id = ?', [$v['id']]);
        foreach ($rows as $a) {
            PayrollLock::assertOpen($a['emp_type'], $a['att_date']);
        }
        Database::transaction(function () use ($v, $rows) {
            foreach ($rows as $a) {
                Database::run('DELETE FROM overtime WHERE employee_id = ? AND ot_date = ? AND salary_sheet_id IS NULL', [$a['employee_id'], $a['att_date']]);
            }
            Database::run('DELETE FROM attendance_daily WHERE voucher_id = ?', [$v['id']]);
            Database::run('DELETE FROM attendance_vouchers WHERE id = ?', [$v['id']]);
            Audit::log('delete', 'attendance_vouchers', (int)$v['id'], $v + ['rows' => count($rows)], null);
        });
        return ['deleted' => true, 'rows' => count($rows)];
    }
}
