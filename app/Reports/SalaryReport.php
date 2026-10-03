<?php
declare(strict_types=1);

namespace App\Reports;

use App\ApiException;
use App\Database;
use App\Payroll;

/**
 * Base for reports printed from a saved salary sheet (?id=). Drafts print with a DRAFT mark;
 * only posted sheets are final. Optional filters: department_id, employee_id.
 */
abstract class SalaryReport extends Report
{
    private ?array $sheet = null;
    private ?array $lines = null;

    public function permission(): array
    {
        return ['salary', 'print'];
    }

    protected function sheet(): array
    {
        if ($this->sheet === null) {
            $this->sheet = Database::one('SELECT * FROM salary_sheets WHERE id = ?', [(int)$this->request->query('id', 0)])
                ?? throw ApiException::notFound('Salary sheet');
        }
        return $this->sheet;
    }

    /** Lines joined with employee details, ordered by department then code. */
    protected function lines(): array
    {
        if ($this->lines === null) {
            $where = ['l.salary_sheet_id = :id'];
            $params = ['id' => $this->sheet()['id']];
            if ($d = $this->request->queryInt('department_id')) {
                $where[] = 'l.department_id = :d';
                $params['d'] = $d;
            }
            if ($e = $this->request->queryInt('employee_id')) {
                $where[] = 'l.employee_id = :e';
                $params['e'] = $e;
            }
            $this->lines = Database::all(
                'SELECT l.*, e.code, e.name, e.name_ur, e.father_name, e.cnic, e.joining_date, d.name AS department, d.name_ur AS department_ur,
                        g.name AS designation, g.name_ur AS designation_ur
                   FROM salary_sheet_lines l JOIN employees e ON e.id = l.employee_id
                   JOIN departments d ON d.id = l.department_id JOIN designations g ON g.id = l.designation_id
                  WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code',
                $params
            );
        }
        return $this->lines;
    }

    protected function isDaily(): bool
    {
        return $this->sheet()['sheet_type'] === 'daily_wages';
    }

    protected function monthName(): string
    {
        return date('F Y', strtotime($this->sheet()['salary_month']));
    }

    protected function subtitle(): string
    {
        $s = $this->sheet();
        $parts = [
            Payroll::TYPES[$s['sheet_type']] . ' — <b>' . $this->monthName() . '</b>',
            'Period: ' . self::date($s['period_from']) . ' to ' . self::date($s['period_to']),
            'Paid Date: ' . ($s['paid_date'] ? self::date($s['paid_date']) : '__________'),
        ];
        if ($f = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $f;
        }
        $parts[] = $s['status'] === 'posted' ? 'Posted' : '<b>DRAFT — not posted</b>';
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    /** @return array<string,array> lines grouped by department name */
    protected function byDepartment(): array
    {
        $g = [];
        foreach ($this->lines() as $l) {
            $g[$l['department']][] = $l;
        }
        return $g;
    }

    protected static function days(mixed $v): string
    {
        $f = (float)$v;
        if ($f == 0.0) {
            return '';
        }
        return rtrim(rtrim(number_format($f, 2, '.', ''), '0'), '.');
    }

    protected static function sum(array $lines, string $key): float
    {
        return array_sum(array_map(fn($l) => (float)$l[$key], $lines));
    }

    protected function emptyMsg(): string
    {
        return '<div class="empty">No employees on this salary sheet for the selected filter.</div>';
    }
}
