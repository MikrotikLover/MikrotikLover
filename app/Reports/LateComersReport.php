<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;

/** Late-comers Report: late arrivals in a period with per-employee count and total late time. */
final class LateComersReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['attendance', 'print'];
    }

    public function title(): string
    {
        return 'Late-comers Report';
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

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        [$from, $to] = $this->range();
        $where = ['a.att_date BETWEEN :f AND :t', 'a.late_minutes >= :m'];
        $params = ['f' => $from, 't' => $to, 'm' => max(1, $this->request->queryInt('min_late', 1))];
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        return $this->rows = Database::all(
            'SELECT a.*, e.code, e.name, d.name AS department, g.name AS designation, s.code AS shift_code, s.start_time, s.grace_minutes
               FROM attendance_daily a
               JOIN employees e ON e.id = a.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN shifts s ON s.id = a.shift_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code, a.att_date',
            $params
        );
    }

    protected function subtitle(): string
    {
        [$from, $to] = $this->range();
        $parts = ['Period: ' . self::date($from) . ' to ' . self::date($to)];
        if (($m = $this->request->queryInt('min_late', 1)) > 1) {
            $parts[] = "Late by at least $m min";
        }
        if ($x = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $x;
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No late arrivals in this period.</p>';
        }
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Code</th><th>Name</th><th>Designation</th><th>Date</th><th>Day</th>'
            . '<th>Shift</th><th>Shift start</th><th>Time In</th><th class="num">Late (h:mm)</th></tr></thead><tbody>';
        $groups = [];
        foreach ($rows as $r) {
            $groups[$r['department']][$r['employee_id']][] = $r;
        }
        $sr = 0;
        $grand = 0;
        $grandCount = 0;
        foreach ($groups as $dept => $emps) {
            $h .= '<tr class="group"><td colspan="10">' . self::e($dept) . '</td></tr>';
            foreach ($emps as $list) {
                $tot = 0;
                foreach ($list as $r) {
                    $sr++;
                    $tot += (int)$r['late_minutes'];
                    $h .= '<tr><td class="num">' . $sr . '</td><td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td><td>'
                        . self::e($r['designation']) . '</td><td class="nowrap">' . self::date($r['att_date']) . '</td><td>' . date('D', strtotime($r['att_date']))
                        . '</td><td>' . self::e($r['shift_code']) . '</td><td>' . ($r['start_time'] ? substr($r['start_time'], 0, 5) : '') . '</td><td>'
                        . self::time($r['time_in']) . '</td><td class="num">' . self::hm($r['late_minutes']) . '</td></tr>';
                }
                $grand += $tot;
                $grandCount += count($list);
                $h .= '<tr class="subtotal"><td colspan="9">' . self::e($list[0]['code'] . ' ' . $list[0]['name']) . ': late ' . count($list)
                    . ' time(s)</td><td class="num">' . self::hm($tot, false) . '</td></tr>';
            }
        }
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="9">Total: ' . $grandCount . ' late arrival(s)</td><td class="num">'
            . self::hm($grand, false) . '</td></tr></tfoot></table>';
    }

    public function csv(): array
    {
        $out = [['Department', 'Code', 'Name', 'Designation', 'Date', 'Shift', 'Shift Start', 'Time In', 'Late Minutes']];
        foreach ($this->fetch() as $r) {
            $out[] = [$r['department'], $r['code'], $r['name'], $r['designation'], $r['att_date'], $r['shift_code'], $r['start_time'], self::time($r['time_in']), $r['late_minutes']];
        }
        return $out;
    }
}
