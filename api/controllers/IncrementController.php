<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Auth;
use App\Database;
use App\Increments;
use App\Request;

/**
 * Salary increments. Viewing needs employees.view; adding, bulk-applying and deleting are for
 * admin-role users only (route permission 'admin'). Rules live in App\Increments.
 */
final class IncrementController
{
    /** Users who can be named as approver, plus whether the caller may manage increments. */
    public function meta(Request $r): array
    {
        return [
            'can_manage' => Auth::isAdmin(),
            'today' => date('Y-m-d'),
            'approvers' => Database::all('SELECT id, full_name FROM users WHERE is_active = 1 ORDER BY full_name'),
            'types' => Increments::TYPES,
        ];
    }

    /** Employee's increment history (newest first) with the current and scheduled salary. */
    public function history(Request $r): array
    {
        $id = $r->id();
        $e = Database::one(
            'SELECT e.id, e.code, e.name, e.emp_type, e.joining_date, e.leaving_date, e.status, e.basic_salary, d.name AS department, g.name AS designation
               FROM employees e JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id WHERE e.id = ?',
            [$id]
        ) ?? throw ApiException::notFound('Employee');
        $e['current_salary'] = Increments::getSalaryOnDate($id, date('Y-m-d'));
        return ['employee' => $e, 'rows' => Increments::history($id)];
    }

    /** Live preview of one increment (old salary, new salary, blocking rule). Nothing is written. */
    public function preview(Request $r): array
    {
        $type = (string)$r->query('increment_type', '');
        $date = (string)$r->query('effective_date', '') ?: date('Y-m-d');
        if (!isset(Increments::TYPES[$type]) || $type === 'joining') {
            throw ApiException::validation(['increment_type' => 'Choose percentage, fixed amount or new salary.']);
        }
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || !strtotime($date)) {
            throw ApiException::validation(['effective_date' => 'Enter a valid date.']);
        }
        $value = Increments::decimal($r->query('increment_value', ''));
        if ($value === null) {
            throw ApiException::validation(['increment_value' => 'Enter a positive number with at most 2 decimals.']);
        }
        return Increments::preview((int)$r->queryInt('employee_id', 0), $type, $value, $date);
    }

    public function store(Request $r): array
    {
        $id = Increments::add($r->body());
        $row = Database::one('SELECT employee_id FROM salary_increments WHERE id = ?', [$id]);
        return ['id' => $id] + $this->history(self::withId($r, (int)$row['employee_id']));
    }

    public function bulkPreview(Request $r): array
    {
        return Increments::bulkPreview($r->body());
    }

    public function bulkApply(Request $r): array
    {
        return Increments::bulkApply($r->body());
    }

    public function destroy(Request $r): array
    {
        $row = Increments::delete($r->id());
        return ['deleted' => true] + $this->history(self::withId($r, (int)$row['employee_id']));
    }

    private static function withId(Request $r, int $id): Request
    {
        $copy = clone $r;
        $copy->params = ['id' => (string)$id];
        return $copy;
    }
}
