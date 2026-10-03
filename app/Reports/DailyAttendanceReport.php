<?php
declare(strict_types=1);

namespace App\Reports;

use App\Calendar;
use App\Database;

/** Daily Attendance Report: every employee employed on the date, grouped by department. */
final class DailyAttendanceReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['attendance', 'print'];
    }

    public function title(): string
    {
        return 'Daily Attendance Report';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function day(): string
    {
        return $this->qDate('date', date('Y-m-d'));
    }

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        $date = $this->day();
        $where = ['e.joining_date <= :d1', '(e.leaving_date IS NULL OR e.leaving_date >= :d2)', "(e.status = 'active' OR e.leaving_date IS NOT NULL)"];
        $params = ['d1' => $date, 'd2' => $date, 'd3' => $date];
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :dept';
            $params['dept'] = $d;
        }
        if ($t = (string)$this->request->query('emp_type', '')) {
            if (in_array($t, ['permanent', 'daily_wages', 'contract'], true)) {
                $where[] = 'e.emp_type = :t';
                $params['t'] = $t;
            }
        }
        $rows = Database::all(
            'SELECT e.id, e.code, e.name, e.name_ur, e.joining_date, e.leaving_date, e.shift_group_id, e.shift_date, e.emp_type,
                    d.name AS department, g.name AS designation,
                    a.status, a.time_in, a.time_out, a.work_minutes, a.late_minutes, a.early_minutes, a.ot_minutes, a.remarks,
                    a.flag_reason, s.code AS shift_code
               FROM employees e
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN attendance_daily a ON a.employee_id = e.id AND a.att_date = :d3
          LEFT JOIN shifts s ON s.id = a.shift_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code',
            $params
        );
        $status = (string)$this->request->query('status', '');
        if ($status !== '') {
            $rows = array_values(array_filter($rows, fn($r) => $status === 'none' ? $r['status'] === null : $r['status'] === $status));
        }
        return $this->rows = $rows;
    }

    protected function subtitle(): string
    {
        $date = $this->day();
        $parts = ['Date: ' . date('d-m-Y (l)', strtotime($date))];
        if ($h = (new Calendar($date, $date))->holiday($date)) {
            $parts[] = 'Holiday: ' . self::e($h['name']);
        }
        if ($l = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $l;
        }
        if (($s = (string)$this->request->query('status', '')) !== '') {
            $parts[] = 'Status: ' . self::e(self::STATUS_NAMES[$s] ?? 'Not marked');
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No employees for the selected filters.</p>';
        }
        $count = array_fill_keys(array_keys(self::STATUS_NAMES), 0) + ['none' => 0];
        foreach ($rows as $r) {
            $count[$r['status'] ?? 'none']++;
        }
        $sum = '<table class="rpt-table" style="width:auto;margin-bottom:6px"><tr>';
        foreach ($count as $k => $n) {
            if ($n || in_array($k, ['P', 'A', 'L'], true)) {
                $sum .= '<th>' . ($k === 'none' ? 'Not marked' : self::e(self::STATUS_NAMES[$k])) . '</th><td class="num">' . $n . '</td>';
            }
        }
        $sum .= '<th>Total</th><td class="num">' . count($rows) . '</td></tr></table>';

        $h = $sum . '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Code</th><th>Name</th><th>Designation</th><th>Shift</th>'
            . '<th>In</th><th>Out</th><th class="num">Hours</th><th class="num">Late</th><th class="num">Early</th><th class="num">OT</th>'
            . '<th>Status</th><th>Remarks</th></tr></thead><tbody>';
        $dept = null;
        $sr = 0;
        $dc = 0;
        $dp = 0;
        $flush = function () use (&$h, &$dept, &$dc, &$dp) {
            if ($dept !== null) {
                $h .= '<tr class="subtotal"><td colspan="13">' . self::e($dept) . ': ' . $dc . ' employee(s), present ' . $dp . '</td></tr>';
            }
        };
        foreach ($rows as $r) {
            if ($r['department'] !== $dept) {
                $flush();
                $dept = $r['department'];
                $dc = $dp = 0;
                $h .= '<tr class="group"><td colspan="13">' . self::e($dept) . '</td></tr>';
            }
            $sr++;
            $dc++;
            $dp += in_array($r['status'], ['P', 'S', 'HD'], true) ? 1 : 0;
            $h .= '<tr><td class="num">' . $sr . '</td><td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td>'
                . '<td>' . self::e($r['designation']) . '</td><td>' . self::e($r['shift_code']) . '</td>'
                . '<td>' . self::time($r['time_in']) . '</td><td>' . self::time($r['time_out']) . '</td>'
                . '<td class="num">' . self::hm($r['work_minutes']) . '</td><td class="num">' . self::hm($r['late_minutes']) . '</td>'
                . '<td class="num">' . self::hm($r['early_minutes']) . '</td><td class="num">' . self::hm($r['ot_minutes']) . '</td>'
                . '<td><b>' . self::e($r['status'] === null ? '—' : self::statusCode($r['status'])) . '</b></td>'
                . '<td>' . self::e(trim(($r['remarks'] ?? '') . ' ' . ($r['flag_reason'] ?? ''))) . '</td></tr>';
        }
        $flush();
        return $h . '</tbody></table>';
    }

    public function csv(): array
    {
        $out = [['Date', 'Department', 'Code', 'Name', 'Designation', 'Shift', 'Time In', 'Time Out', 'Work Minutes', 'Late Minutes', 'Early Minutes', 'OT Minutes', 'Status', 'Remarks']];
        foreach ($this->fetch() as $r) {
            $out[] = [$this->day(), $r['department'], $r['code'], $r['name'], $r['designation'], $r['shift_code'], self::time($r['time_in']),
                self::time($r['time_out']), $r['work_minutes'], $r['late_minutes'], $r['early_minutes'], $r['ot_minutes'], self::statusCode($r['status']),
                trim(($r['remarks'] ?? '') . ' ' . ($r['flag_reason'] ?? ''))];
        }
        return $out;
    }
}
