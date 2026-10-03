<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;

/** Shift-wise Attendance Report: for a date (or range), employees grouped by the shift they worked. */
final class ShiftAttendanceReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['attendance', 'print'];
    }

    public function title(): string
    {
        return 'Shift-wise Attendance Report';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function range(): array
    {
        $from = $this->qDate('from', $this->qDate('date', date('Y-m-d')));
        $to = $this->qDate('to', $from);
        return $to < $from ? [$to, $from] : [$from, $to];
    }

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        [$from, $to] = $this->range();
        $where = ['a.att_date BETWEEN :f AND :t'];
        $params = ['f' => $from, 't' => $to];
        if ($s = $this->request->queryInt('shift_id')) {
            $where[] = 'a.shift_id = :s';
            $params['s'] = $s;
        }
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        if (!$this->request->query('all_status')) {
            $where[] = "a.status IN ('P','S','HD','R','H') AND a.time_in IS NOT NULL";
        }
        return $this->rows = Database::all(
            'SELECT a.*, e.code, e.name, d.name AS department, g.name AS designation,
                    COALESCE(s.code, \'-\') AS shift_code, s.name AS shift_name, s.start_time, s.end_time
               FROM attendance_daily a
               JOIN employees e ON e.id = a.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN shifts s ON s.id = a.shift_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY s.start_time IS NULL, s.start_time, s.code, a.att_date, d.name, e.code',
            $params
        );
    }

    protected function subtitle(): string
    {
        [$from, $to] = $this->range();
        $parts = [$from === $to ? 'Date: ' . date('d-m-Y (l)', strtotime($from)) : 'Period: ' . self::date($from) . ' to ' . self::date($to)];
        foreach ([['shifts', 'shift_id', 'Shift'], ['departments', 'department_id', 'Department']] as [$t, $k, $l]) {
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
            return '<p class="empty">No attendance for the selected filters.</p>';
        }
        [$from, $to] = $this->range();
        $multi = $from !== $to;
        $cols = $multi ? 11 : 10;
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th>' . ($multi ? '<th>Date</th>' : '')
            . '<th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>In</th><th>Out</th>'
            . '<th class="num">Hours</th><th class="num">Late</th><th>Status</th></tr></thead><tbody>';
        $shift = null;
        $n = 0;
        $sr = 0;
        $work = 0;
        $flush = function () use (&$h, &$shift, &$n, &$work, $cols) {
            if ($shift !== null) {
                $h .= '<tr class="subtotal"><td colspan="' . ($cols - 3) . '">' . self::e($shift) . ': ' . $n . ' record(s)</td><td class="num">'
                    . self::hm($work, false) . '</td><td colspan="2"></td></tr>';
            }
        };
        foreach ($rows as $r) {
            $label = $r['shift_code'] === '-' ? 'No shift' : "{$r['shift_code']} — {$r['shift_name']} (" . substr($r['start_time'], 0, 5) . '–' . substr($r['end_time'], 0, 5) . ')';
            if ($label !== $shift) {
                $flush();
                $shift = $label;
                $n = $work = 0;
                $h .= '<tr class="group"><td colspan="' . $cols . '">' . self::e($label) . '</td></tr>';
            }
            $n++;
            $sr++;
            $work += (int)$r['work_minutes'];
            $h .= '<tr><td class="num">' . $sr . '</td>' . ($multi ? '<td class="nowrap">' . self::date($r['att_date']) . '</td>' : '')
                . '<td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td><td>' . self::e($r['department']) . '</td>'
                . '<td>' . self::e($r['designation']) . '</td><td>' . self::time($r['time_in']) . '</td><td>' . self::time($r['time_out']) . '</td>'
                . '<td class="num">' . self::hm($r['work_minutes']) . '</td><td class="num">' . self::hm($r['late_minutes']) . '</td>'
                . '<td><b>' . self::e(self::statusCode($r['status'])) . '</b></td></tr>';
        }
        $flush();
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="' . $cols . '">Total: ' . $sr . ' record(s)</td></tr></tfoot></table>';
    }

    public function csv(): array
    {
        $out = [['Shift', 'Date', 'Code', 'Name', 'Department', 'Designation', 'Time In', 'Time Out', 'Work Minutes', 'Late Minutes', 'Status']];
        foreach ($this->fetch() as $r) {
            $out[] = [$r['shift_code'], $r['att_date'], $r['code'], $r['name'], $r['department'], $r['designation'], self::time($r['time_in']),
                self::time($r['time_out']), $r['work_minutes'], $r['late_minutes'], $r['status']];
        }
        return $out;
    }
}
