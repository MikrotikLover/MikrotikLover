<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;

/** Overtime Report: detail (per day) or summary (per employee), grouped by department. */
final class OvertimeReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['overtime', 'print'];
    }

    public function title(): string
    {
        return 'Overtime Report';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function range(): array
    {
        $from = $this->qDate('from', date('Y-m-01'));
        $to = $this->qDate('to', date('Y-m-d'));
        return $to < $from ? [$to, $from] : [$from, $to];
    }

    private function summary(): bool
    {
        return $this->request->query('mode') === 'summary';
    }

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        [$from, $to] = $this->range();
        $where = ['o.ot_date BETWEEN :f AND :t'];
        $params = ['f' => $from, 't' => $to];
        $status = (string)$this->request->query('status', 'approved');
        if (in_array($status, ['pending', 'approved', 'rejected'], true)) {
            $where[] = 'o.status = :s';
            $params['s'] = $status;
        }
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        if ($e = $this->request->queryInt('employee_id')) {
            $where[] = 'o.employee_id = :e';
            $params['e'] = $e;
        }
        return $this->rows = Database::all(
            'SELECT o.*, e.code, e.name, d.name AS department, g.name AS designation, a.time_in, a.time_out, a.status AS att_status,
                    u.full_name AS approved_by_name
               FROM overtime o
               JOIN employees e ON e.id = o.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN attendance_daily a ON a.employee_id = o.employee_id AND a.att_date = o.ot_date
          LEFT JOIN users u ON u.id = o.approved_by
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code, o.ot_date',
            $params
        );
    }

    protected function subtitle(): string
    {
        [$from, $to] = $this->range();
        $status = (string)$this->request->query('status', 'approved');
        $parts = ['Period: ' . self::date($from) . ' to ' . self::date($to), 'Status: ' . ($status === '' ? 'All' : ucfirst(self::e($status))),
            $this->summary() ? 'Summary' : 'Detail'];
        if ($x = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $x;
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No overtime for the selected filters.</p>';
        }
        $summary = $this->summary();
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Code</th><th>Name</th><th>Designation</th>'
            . ($summary ? '<th class="num">Days</th>' : '<th>Date</th><th>In</th><th>Out</th><th>Att.</th>')
            . '<th class="num">Computed</th><th class="num">Approved</th>' . ($summary ? '' : '<th>Status</th><th>Approved by / Remarks</th>')
            . '</tr></thead><tbody>';
        $cols = $summary ? 7 : 12;
        $groups = [];
        foreach ($rows as $r) {
            $groups[$r['department']][$r['employee_id']][] = $r;
        }
        $sr = 0;
        $gc = $ga = 0;
        foreach ($groups as $dept => $emps) {
            $h .= '<tr class="group"><td colspan="' . $cols . '">' . self::e($dept) . '</td></tr>';
            $dc = $da = 0;
            foreach ($emps as $list) {
                $c = array_sum(array_map(fn($x) => (int)$x['computed_minutes'], $list));
                $a = array_sum(array_map(fn($x) => (int)$x['approved_minutes'], $list));
                $dc += $c;
                $da += $a;
                $e = $list[0];
                if ($summary) {
                    $sr++;
                    $h .= '<tr><td class="num">' . $sr . '</td><td>' . self::e($e['code']) . '</td><td>' . self::e($e['name']) . '</td><td>'
                        . self::e($e['designation']) . '</td><td class="num">' . count($list) . '</td><td class="num">' . self::hm($c, false)
                        . '</td><td class="num">' . self::hm($a, false) . '</td></tr>';
                    continue;
                }
                foreach ($list as $x) {
                    $sr++;
                    $h .= '<tr><td class="num">' . $sr . '</td><td>' . self::e($x['code']) . '</td><td>' . self::e($x['name']) . '</td><td>'
                        . self::e($x['designation']) . '</td><td class="nowrap">' . self::date($x['ot_date']) . '</td><td>' . self::time($x['time_in'])
                        . '</td><td>' . self::time($x['time_out']) . '</td><td>' . self::e($x['att_status']) . '</td><td class="num">'
                        . self::hm($x['computed_minutes']) . '</td><td class="num">' . self::hm($x['approved_minutes']) . '</td><td>'
                        . ucfirst(self::e($x['status'])) . '</td><td>' . self::e(trim(($x['approved_by_name'] ?? '') . ' ' . ($x['remarks'] ?? ''))) . '</td></tr>';
                }
                $h .= '<tr class="subtotal"><td colspan="8">' . self::e($e['code'] . ' ' . $e['name']) . ' total</td><td class="num">' . self::hm($c, false)
                    . '</td><td class="num">' . self::hm($a, false) . '</td><td colspan="2"></td></tr>';
            }
            $gc += $dc;
            $ga += $da;
            $h .= '<tr class="subtotal"><td colspan="' . ($summary ? 5 : 8) . '">Total ' . self::e($dept) . '</td><td class="num">' . self::hm($dc, false)
                . '</td><td class="num">' . self::hm($da, false) . '</td>' . ($summary ? '' : '<td colspan="2"></td>') . '</tr>';
        }
        $h .= '</tbody><tfoot><tr class="grandtotal"><td colspan="' . ($summary ? 5 : 8) . '">Grand Total (hours)</td><td class="num">' . self::hm($gc, false)
            . '</td><td class="num">' . self::hm($ga, false) . '</td>' . ($summary ? '' : '<td colspan="2"></td>') . '</tr></tfoot></table>';
        return $h;
    }

    public function csv(): array
    {
        $out = [['Department', 'Code', 'Name', 'Designation', 'Date', 'Time In', 'Time Out', 'Computed Minutes', 'Approved Minutes', 'Status', 'Approved By', 'Remarks']];
        foreach ($this->fetch() as $x) {
            $out[] = [$x['department'], $x['code'], $x['name'], $x['designation'], $x['ot_date'], self::time($x['time_in']), self::time($x['time_out']),
                $x['computed_minutes'], $x['approved_minutes'], $x['status'], $x['approved_by_name'], $x['remarks']];
        }
        return $out;
    }
}
