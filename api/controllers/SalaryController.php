<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Payroll;
use App\Request;
use App\Validator;

/**
 * Salary Sheet (Permanent / Daily Wages): Show (preview, nothing written) -> Save (draft) -> Post
 * (locks the month, consumes vouchers / overtime / loan installments, writes the salary JV).
 * Posted sheets are read only; only the paid date can still be changed.
 */
final class SalaryController
{
    public function index(Request $r): array
    {
        $where = ['1=1'];
        $params = [];
        if (isset(Payroll::TYPES[$t = (string)$r->query('type', '')])) {
            $where[] = 's.sheet_type = :t';
            $params['t'] = $t;
        }
        if ($y = $r->queryInt('year')) {
            $where[] = 'YEAR(s.salary_month) = :y';
            $params['y'] = $y;
        }
        return Database::all(
            'SELECT s.id, s.sheet_type, s.period_from, s.period_to, s.salary_month, s.days_in_month, s.status, s.paid_date, s.jv_id, s.remarks,
                    s.posted_at, COUNT(l.id) AS employees, COALESCE(SUM(l.gross),0) AS gross, COALESCE(SUM(l.net_salary),0) AS net_salary
               FROM salary_sheets s LEFT JOIN salary_sheet_lines l ON l.salary_sheet_id = s.id
              WHERE ' . implode(' AND ', $where) . ' GROUP BY s.id ORDER BY s.salary_month DESC, s.sheet_type',
            $params
        );
    }

    /** Show (F7): compute the grid from current data; fines / remarks come from the saved draft if any. */
    public function preview(Request $r): array
    {
        $type = (string)$r->query('type', '');
        $from = (string)$r->query('from', '');
        $to = (string)$r->query('to', '');
        Payroll::validatePeriod($type, $from, $to);
        $sheet = Payroll::findSheet($type, $from, $to);
        if ($sheet && $sheet['status'] === 'posted') {
            // a posted month is shown as stored, never recomputed
            return $this->stored((int)$sheet['id']);
        }
        $manual = [];
        if ($sheet) {
            foreach (Database::all('SELECT employee_id, fine_entered, remarks FROM salary_sheet_lines WHERE salary_sheet_id = ?', [$sheet['id']]) as $l) {
                $manual[(int)$l['employee_id']] = ['fine' => (float)$l['fine_entered'], 'remarks' => $l['remarks']];
            }
        }
        $b = Payroll::build($type, $from, $to, $sheet ? (int)$sheet['id'] : null, $manual);
        unset($b['used']);
        $b['sheet'] = $sheet ? $this->head($sheet) : null;
        $b['status'] = $sheet ? 'draft' : 'new';
        return $b;
    }

    public function show(Request $r): array
    {
        return $this->stored($r->id());
    }

    private function head(array $s): array
    {
        return array_intersect_key($s, array_flip(['id', 'sheet_type', 'period_from', 'period_to', 'salary_month', 'days_in_month', 'day_basis',
            'status', 'paid_date', 'jv_id', 'remarks', 'posted_at']));
    }

    private function stored(int $id): array
    {
        $s = Database::one('SELECT * FROM salary_sheets WHERE id = ?', [$id]);
        if (!$s) {
            throw ApiException::notFound('Salary sheet');
        }
        $lines = Database::all(
            'SELECT l.*, e.code, e.name, e.name_ur, d.name AS department, d.name_ur AS department_ur, g.name AS designation, e.emp_type
               FROM salary_sheet_lines l JOIN employees e ON e.id = l.employee_id
               JOIN departments d ON d.id = l.department_id JOIN designations g ON g.id = l.designation_id
              WHERE l.salary_sheet_id = ? ORDER BY d.name, e.code',
            [$id]
        );
        foreach ($lines as &$l) {
            $l['warnings'] = $l['warnings'] ? explode('; ', $l['warnings']) : [];
        }
        unset($l);
        return ['type' => $s['sheet_type'], 'from' => $s['period_from'], 'to' => $s['period_to'], 'month' => $s['salary_month'],
            'days' => (int)$s['days_in_month'], 'basis' => $s['day_basis'], 'lines' => $lines, 'totals' => Payroll::totals($lines),
            'sheet' => $this->head($s), 'status' => $s['status']];
    }

    /** Save (F10): {sheet_type, period_from, period_to, paid_date, remarks, lines:[{employee_id, fine, remarks}]} */
    public function store(Request $r): array
    {
        $d = Validator::make($r->body(), [
            'sheet_type' => 'required|string', 'period_from' => 'required|date', 'period_to' => 'required|date',
            'paid_date' => 'nullable|date', 'remarks' => 'nullable|string|max:255', 'lines' => 'nullable|array',
        ], ['sheet_type' => 'Type', 'period_from' => 'From', 'period_to' => 'To', 'paid_date' => 'Paid Date']);
        $manual = [];
        $errors = [];
        foreach ((array)($d['lines'] ?? []) as $i => $l) {
            $eid = (int)($l['employee_id'] ?? 0);
            $fine = $l['fine'] ?? 0;
            if ($fine === '' || $fine === null) {
                $fine = 0;
            }
            if (!is_numeric($fine) || (float)$fine < 0 || (float)$fine > 10000000) {
                $errors["lines.$i.fine"] = 'Fine must be a positive amount.';
                continue;
            }
            $manual[$eid] = ['fine' => (float)$fine, 'remarks' => isset($l['remarks']) ? (string)$l['remarks'] : null];
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        $id = Payroll::save($d['sheet_type'], $d['period_from'], $d['period_to'], $manual, $d['paid_date'] ?? null, $d['remarks'] ?? null);
        return $this->stored($id);
    }

    public function post(Request $r): array
    {
        $d = Validator::make($r->body(), ['paid_date' => 'nullable|date'], ['paid_date' => 'Paid Date']);
        Payroll::post($r->id(), $d['paid_date'] ?? null);
        return $this->stored($r->id());
    }

    /** Admin: unpost a posted sheet {reason} (audit-logged). */
    public function unpost(Request $r): array
    {
        $d = Validator::make($r->body(), ['reason' => 'required|string|max:255'], ['reason' => 'Reason']);
        Payroll::unpost($r->id(), $d['reason']);
        return $this->stored($r->id());
    }

    /** The paid date is printed on the sheet and payslips; it may be set after posting. */
    public function paidDate(Request $r): array
    {
        $s = Database::one('SELECT * FROM salary_sheets WHERE id = ?', [$r->id()]);
        if (!$s) {
            throw ApiException::notFound('Salary sheet');
        }
        $d = Validator::make($r->body(), ['paid_date' => 'nullable|date'], ['paid_date' => 'Paid Date']);
        Database::update('salary_sheets', ['paid_date' => $d['paid_date'] ?? null, 'updated_by' => Auth::id()], 'id = :id', ['id' => $s['id']]);
        Audit::log('update', 'salary_sheets', (int)$s['id'], ['paid_date' => $s['paid_date']], ['paid_date' => $d['paid_date'] ?? null]);
        return $this->head(Database::one('SELECT * FROM salary_sheets WHERE id = ?', [$s['id']]));
    }

    public function destroy(Request $r): array
    {
        $s = Database::one('SELECT * FROM salary_sheets WHERE id = ?', [$r->id()]);
        if (!$s) {
            throw ApiException::notFound('Salary sheet');
        }
        if ($s['status'] === 'posted') {
            throw ApiException::conflict('A posted salary sheet is locked and cannot be deleted.');
        }
        Database::transaction(function () use ($s) {
            Database::run('DELETE FROM salary_sheets WHERE id = ?', [$s['id']]); // lines and loan rows cascade
            Audit::log('delete', 'salary_sheets', (int)$s['id'], $this->head($s), null);
        });
        return ['deleted' => true];
    }
}
