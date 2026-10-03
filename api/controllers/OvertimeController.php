<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\PayrollLock;
use App\Request;
use App\Validator;

/**
 * Overtime approval. Daily Post creates "pending" OT candidates; a supervisor approves / rejects /
 * edits the minutes. Only approved minutes reach payroll. Rows used by a posted salary sheet are read-only.
 */
final class OvertimeController
{
    public function index(Request $r): array
    {
        $from = (string)($r->query('from') ?: date('Y-m-01'));
        $to = (string)($r->query('to') ?: date('Y-m-d'));
        $where = ['o.ot_date BETWEEN :f AND :t'];
        $params = ['f' => $from, 't' => $to];
        if ($d = $r->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        if ($e = $r->queryInt('employee_id')) {
            $where[] = 'o.employee_id = :e';
            $params['e'] = $e;
        }
        $status = (string)$r->query('status', '');
        if (in_array($status, ['pending', 'approved', 'rejected'], true)) {
            $where[] = 'o.status = :s';
            $params['s'] = $status;
        }
        return Database::all(
            'SELECT o.*, e.code, e.name, e.name_ur, e.emp_type, d.name AS department, g.name AS designation,
                    a.time_in, a.time_out, a.work_minutes, a.status AS att_status, s.code AS shift_code,
                    u.full_name AS approved_by_name
               FROM overtime o
               JOIN employees e ON e.id = o.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN attendance_daily a ON a.employee_id = o.employee_id AND a.att_date = o.ot_date
          LEFT JOIN shifts s ON s.id = a.shift_id
          LEFT JOIN users u ON u.id = o.approved_by
              WHERE ' . implode(' AND ', $where) . ' ORDER BY o.ot_date, d.name, e.code LIMIT 3000',
            $params
        );
    }

    /** Manual OT entry for a day the employee worked. */
    public function store(Request $r): array
    {
        $d = Validator::make($r->body(), [
            'employee_id' => 'required|int|exists:employees', 'ot_date' => 'required|date',
            'approved_minutes' => 'required|int|min:1|max:960', 'remarks' => 'required|string|max:255',
        ], ['approved_minutes' => 'OT minutes', 'ot_date' => 'Date', 'remarks' => 'Reason']);
        $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$d['employee_id']]);
        PayrollLock::assertOpen($emp['emp_type'], $d['ot_date'], 'Overtime', (int)$emp['id']);
        $att = Database::one('SELECT * FROM attendance_daily WHERE employee_id = ? AND att_date = ?', [$d['employee_id'], $d['ot_date']]);
        if (!$att || !in_array($att['status'], ['P', 'S', 'HD', 'R', 'H'], true)) {
            throw ApiException::validation(['ot_date' => 'Overtime can only be entered for a day the employee was present.']);
        }
        if (Database::value('SELECT id FROM overtime WHERE employee_id = ? AND ot_date = ?', [$d['employee_id'], $d['ot_date']])) {
            throw ApiException::validation(['ot_date' => 'An overtime entry already exists for this day; edit it in the list.']);
        }
        $id = Database::insert('overtime', [
            'employee_id' => $d['employee_id'], 'ot_date' => $d['ot_date'], 'attendance_id' => $att['id'],
            // manual entry: the minutes entered are the ceiling for approval (approval may only lower them)
            'computed_minutes' => $d['approved_minutes'], 'is_manual' => 1, 'approved_minutes' => $d['approved_minutes'], 'status' => 'pending',
            'remarks' => $d['remarks'], 'created_by' => Auth::id(),
        ]);
        Audit::log('create', 'overtime', $id, null, $d);
        return ['id' => $id];
    }

    /** Bulk decision: {items:[{id, status: approved|rejected|pending, approved_minutes, remarks}]} */
    public function decide(Request $r): array
    {
        $items = $r->input('items', []);
        if (!is_array($items) || !$items) {
            throw ApiException::validation(['items' => 'Select at least one overtime row.']);
        }
        $done = Database::transaction(function () use ($items) {
            $n = 0;
            foreach ($items as $i => $it) {
                $d = Validator::make((array)$it, [
                    'id' => 'required|int', 'status' => 'required|in:pending,approved,rejected',
                    'approved_minutes' => 'required|int|min:0|max:960', 'remarks' => 'nullable|string|max:255',
                ], ['approved_minutes' => 'Approved minutes']);
                $o = Database::one('SELECT o.*, e.emp_type, e.code FROM overtime o JOIN employees e ON e.id = o.employee_id WHERE o.id = ? FOR UPDATE', [$d['id']]);
                if (!$o) {
                    throw ApiException::notFound('Overtime row');
                }
                if ($o['salary_sheet_id']) {
                    throw ApiException::conflict("Overtime of {$o['code']} on {$o['ot_date']} is already paid in a salary sheet.");
                }
                PayrollLock::assertOpen($o['emp_type'], $o['ot_date'], 'Overtime', (int)$o['employee_id']);
                if ($d['status'] === 'approved' && $d['approved_minutes'] === 0) {
                    throw ApiException::validation(['items' => "Row " . ($i + 1) . ": approved minutes must be more than 0 (or reject)."]);
                }
                // approved hours can only be edited down: never above the computed (or manually entered) overtime
                $ceiling = (int)$o['computed_minutes'];
                if ($d['status'] !== 'rejected' && $d['approved_minutes'] > $ceiling) {
                    throw ApiException::validation(['items' => "Row " . ($i + 1) . " ({$o['code']} {$o['ot_date']}): approved time cannot exceed the "
                        . sprintf('%d:%02d', intdiv($ceiling, 60), $ceiling % 60) . ' h worked beyond the shift.']);
                }
                $upd = [
                    'status' => $d['status'],
                    'approved_minutes' => $d['status'] === 'rejected' ? 0 : $d['approved_minutes'],
                    'remarks' => $d['remarks'],
                    'approved_by' => $d['status'] === 'pending' ? null : Auth::id(),
                    'approved_at' => $d['status'] === 'pending' ? null : date('Y-m-d H:i:s'),
                    'updated_by' => Auth::id(),
                ];
                Database::update('overtime', $upd, 'id = :id', ['id' => $o['id']]);
                Audit::log('update', 'overtime', (int)$o['id'], $o, $upd);
                $n++;
            }
            return $n;
        });
        return ['updated' => $done];
    }

    /** Delete a manual entry (system candidates are rejected instead). */
    public function destroy(Request $r): array
    {
        $o = Database::one('SELECT o.*, e.emp_type FROM overtime o JOIN employees e ON e.id = o.employee_id WHERE o.id = ?', [$r->id()]);
        if (!$o) {
            throw ApiException::notFound('Overtime row');
        }
        if ($o['salary_sheet_id']) {
            throw ApiException::conflict('This overtime is already paid in a salary sheet.');
        }
        if (!(int)$o['is_manual']) {
            throw ApiException::conflict('Overtime computed from attendance cannot be deleted; reject it instead.');
        }
        PayrollLock::assertOpen($o['emp_type'], $o['ot_date'], 'Overtime', (int)$o['employee_id']);
        Database::run('DELETE FROM overtime WHERE id = ?', [$o['id']]);
        Audit::log('delete', 'overtime', (int)$o['id'], $o, null);
        return ['deleted' => true];
    }
}
