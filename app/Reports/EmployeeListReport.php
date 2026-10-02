<?php
declare(strict_types=1);

namespace App\Reports;

use App\Controllers\EmployeeController;
use App\Database;

/** Employee List grouped by department (filters: department, designation, status, type, search). */
final class EmployeeListReport extends Report
{
    private array $rows = [];
    private const TYPES = ['permanent' => 'Permanent', 'daily_wages' => 'Daily Wages', 'contract' => 'Contract'];

    public function permission(): array
    {
        return ['employees', 'print'];
    }

    public function title(): string
    {
        return 'Employee List';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function fetch(): array
    {
        if (!$this->rows) {
            [$where, $params] = EmployeeController::filters($this->request);
            $this->rows = Database::all(
                'SELECT e.id, e.code, e.name, e.name_ur, e.relation, e.father_name, e.cnic, e.cell, e.city, e.emp_type, e.status,
                        e.joining_date, e.leaving_date, e.machine_id, d.name AS department, d.name_ur AS department_ur,
                        g.name AS designation, sg.code AS shift_group,
                        (SELECT CASE WHEN e.emp_type = \'daily_wages\' THEN h.daily_rate ELSE h.basic_salary END
                           FROM employee_salary_history h
                          WHERE h.employee_id = e.id AND h.effective_from <= CURDATE()
                          ORDER BY h.effective_from DESC LIMIT 1) AS salary,
                        e.emp_type = \'daily_wages\' AS is_daily
                   FROM employees e
                   JOIN departments d ON d.id = e.department_id
                   JOIN designations g ON g.id = e.designation_id
              LEFT JOIN shift_groups sg ON sg.id = e.shift_group_id'
                . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
                . ' ORDER BY d.name, e.code',
                $params
            );
        }
        return $this->rows;
    }

    protected function subtitle(): string
    {
        $parts = [];
        $r = $this->request;
        if ($id = $r->queryInt('department_id')) {
            $parts[] = 'Department: ' . self::e((string)Database::value('SELECT name FROM departments WHERE id = ?', [$id]));
        }
        if ($id = $r->queryInt('designation_id')) {
            $parts[] = 'Designation: ' . self::e((string)Database::value('SELECT name FROM designations WHERE id = ?', [$id]));
        }
        $status = (string)$r->query('status', '');
        $parts[] = 'Status: ' . ($status !== '' ? ucfirst(self::e($status)) : 'All');
        $type = (string)$r->query('emp_type', '');
        $parts[] = 'Type: ' . (self::TYPES[$type] ?? 'All');
        if (($q = (string)$r->query('q', '')) !== '') {
            $parts[] = 'Search: "' . self::e($q) . '"';
        }
        return implode(' &nbsp;|&nbsp; ', $parts) . ' &nbsp;|&nbsp; As on ' . date('d-m-Y');
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No employees match the selected filters.</p>';
        }
        $showUrdu = (bool)$this->request->query('urdu', '1');
        $h = '<table class="rpt-table"><thead><tr>'
            . '<th class="num">Sr</th><th>Code</th><th>Name</th>' . ($showUrdu ? '<th class="urdu-h">نام</th>' : '')
            . '<th>S/W/D/O</th><th>Designation</th><th>Type</th><th>CNIC</th><th>Cell</th>'
            . '<th>Joining</th><th>Shift Grp</th><th class="num">M.ID</th><th class="num">Basic / Daily Rate</th><th>Status</th>'
            . '</tr></thead><tbody>';
        $cols = $showUrdu ? 14 : 13;
        $sr = 0;
        $dept = null;
        $deptCount = 0;
        $deptTotal = 0.0;
        $grand = 0.0;
        $flush = function () use (&$h, &$dept, &$deptCount, &$deptTotal, $cols) {
            if ($dept !== null) {
                $h .= '<tr class="subtotal"><td colspan="' . ($cols - 2) . '">Total ' . self::e($dept) . ': ' . $deptCount
                    . ' employee(s) &nbsp; <small>(monthly basic of non-daily-wages staff)</small></td><td class="num">'
                    . self::money($deptTotal) . '</td><td></td></tr>';
            }
        };
        foreach ($rows as $row) {
            if ($row['department'] !== $dept) {
                $flush();
                $dept = $row['department'];
                $deptCount = 0;
                $deptTotal = 0;
                $h .= '<tr class="group"><td colspan="' . $cols . '">' . self::e($dept)
                    . ($row['department_ur'] ? ' <span class="urdu">' . self::e($row['department_ur']) . '</span>' : '') . '</td></tr>';
            }
            $sr++;
            $deptCount++;
            if (!(int)$row['is_daily']) { // daily rates are not added to monthly totals
                $deptTotal += (float)$row['salary'];
                $grand += (float)$row['salary'];
            }
            $h .= '<tr' . ($row['status'] === 'inactive' ? ' class="inactive"' : '') . '>'
                . '<td class="num">' . $sr . '</td>'
                . '<td>' . self::e($row['code']) . '</td>'
                . '<td>' . self::e($row['name']) . '</td>'
                . ($showUrdu ? '<td class="urdu">' . self::e($row['name_ur']) . '</td>' : '')
                . '<td>' . self::e(trim($row['relation'] . ' ' . $row['father_name'])) . '</td>'
                . '<td>' . self::e($row['designation']) . '</td>'
                . '<td>' . self::e(self::TYPES[$row['emp_type']] ?? $row['emp_type']) . '</td>'
                . '<td class="nowrap">' . self::e($row['cnic']) . '</td>'
                . '<td class="nowrap">' . self::e($row['cell']) . '</td>'
                . '<td class="nowrap">' . self::date($row['joining_date']) . '</td>'
                . '<td>' . self::e($row['shift_group']) . '</td>'
                . '<td class="num">' . self::e((string)$row['machine_id']) . '</td>'
                . '<td class="num">' . self::money($row['salary']) . ((int)$row['is_daily'] ? '<small>/day</small>' : '') . '</td>'
                . '<td>' . ($row['status'] === 'active' ? 'Active' : 'Inactive' . ($row['leaving_date'] ? '<br><small>' . self::date($row['leaving_date']) . '</small>' : '')) . '</td>'
                . '</tr>';
        }
        $flush();
        $h .= '</tbody><tfoot><tr class="grandtotal"><td colspan="' . ($cols - 2) . '">Grand Total: ' . $sr
            . ' employee(s)</td><td class="num">' . self::money($grand) . '</td><td></td></tr></tfoot></table>';
        return $h;
    }

    public function csv(): array
    {
        $out = [['Sr', 'Code', 'Name', 'Urdu Name', 'Relation', 'Father/Husband', 'Department', 'Designation', 'Type',
            'CNIC', 'Cell', 'City', 'Joining Date', 'Leaving Date', 'Shift Group', 'Machine ID', 'Basic Salary', 'Daily Rate', 'Status']];
        foreach ($this->fetch() as $i => $r) {
            $out[] = [$i + 1, $r['code'], $r['name'], $r['name_ur'], $r['relation'], $r['father_name'], $r['department'],
                $r['designation'], self::TYPES[$r['emp_type']] ?? $r['emp_type'], $r['cnic'], $r['cell'], $r['city'],
                $r['joining_date'], $r['leaving_date'], $r['shift_group'], $r['machine_id'],
                (int)$r['is_daily'] ? '' : $r['salary'], (int)$r['is_daily'] ? $r['salary'] : '', $r['status']];
        }
        return $out;
    }
}
