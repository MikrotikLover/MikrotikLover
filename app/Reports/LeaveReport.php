<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;

/** Leave Register report for a year (applications + per-employee totals by type). */
final class LeaveReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['leave', 'print'];
    }

    public function title(): string
    {
        return 'Leave Register';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function year(): int
    {
        $y = $this->request->queryInt('year', (int)date('Y'));
        return $y >= 2000 && $y <= 2100 ? $y : (int)date('Y');
    }

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        $y = $this->year();
        $where = ['l.from_date <= :ye', 'l.to_date >= :ys'];
        $params = ['ys' => "$y-01-01", 'ye' => "$y-12-31"];
        $status = (string)$this->request->query('status', 'approved');
        if (in_array($status, ['pending', 'approved', 'rejected', 'cancelled'], true)) {
            $where[] = 'l.status = :s';
            $params['s'] = $status;
        }
        foreach (['department_id' => 'e.department_id', 'leave_type_id' => 'l.leave_type_id', 'employee_id' => 'l.employee_id'] as $k => $c) {
            if ($v = $this->request->queryInt($k)) {
                $where[] = "$c = :$k";
                $params[$k] = $v;
            }
        }
        return $this->rows = Database::all(
            'SELECT l.*, e.code, e.name, d.name AS department, t.code AS type_code, t.name AS type_name, u.full_name AS approved_by_name
               FROM leave_register l
               JOIN employees e ON e.id = l.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN leave_types t ON t.id = l.leave_type_id
          LEFT JOIN users u ON u.id = l.approved_by
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code, l.from_date',
            $params
        );
    }

    protected function subtitle(): string
    {
        $status = (string)$this->request->query('status', 'approved');
        $parts = ['Year: ' . $this->year(), 'Status: ' . ($status === '' ? 'All' : ucfirst(self::e($status)))];
        foreach ([['departments', 'department_id', 'Department'], ['leave_types', 'leave_type_id', 'Leave type']] as [$t, $k, $l]) {
            if ($x = $this->filterLabel($t, $this->request->queryInt($k), $l)) {
                $parts[] = $x;
            }
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No leave records for the selected filters.</p>';
        }
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Code</th><th>Name</th><th>Type</th><th>From</th><th>To</th>'
            . '<th class="num">Days</th><th>Status</th><th>Reason</th><th>Approved by</th></tr></thead><tbody>';
        $dept = null;
        $sr = 0;
        $total = 0.0;
        foreach ($rows as $r) {
            if ($r['department'] !== $dept) {
                $dept = $r['department'];
                $h .= '<tr class="group"><td colspan="10">' . self::e($dept) . '</td></tr>';
            }
            $sr++;
            $total += (float)$r['days'];
            $h .= '<tr><td class="num">' . $sr . '</td><td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td><td>'
                . self::e($r['type_code'] . ' - ' . $r['type_name']) . '</td><td class="nowrap">' . self::date($r['from_date']) . '</td><td class="nowrap">'
                . self::date($r['to_date']) . '</td><td class="num">' . rtrim(rtrim((string)$r['days'], '0'), '.') . '</td><td>' . ucfirst(self::e($r['status']))
                . '</td><td>' . self::e($r['reason']) . '</td><td>' . self::e($r['approved_by_name']) . '</td></tr>';
        }
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="6">Total</td><td class="num">' . rtrim(rtrim(number_format($total, 1), '0'), '.')
            . '</td><td colspan="3"></td></tr></tfoot></table>';
    }

    public function csv(): array
    {
        $out = [['Department', 'Code', 'Name', 'Leave Type', 'From', 'To', 'Days', 'Status', 'Reason', 'Approved By']];
        foreach ($this->fetch() as $r) {
            $out[] = [$r['department'], $r['code'], $r['name'], $r['type_name'], $r['from_date'], $r['to_date'], $r['days'], $r['status'], $r['reason'], $r['approved_by_name']];
        }
        return $out;
    }
}
