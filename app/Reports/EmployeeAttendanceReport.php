<?php
declare(strict_types=1);

namespace App\Reports;

use App\Calendar;
use App\Database;

/** Employee-wise Monthly Attendance: Vr#, date, time in/out, hours, status, description per day. */
final class EmployeeAttendanceReport extends Report
{
    private ?array $data = null;

    public function permission(): array
    {
        return ['attendance', 'print'];
    }

    public function title(): string
    {
        return 'Employee-wise Attendance Report';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function dataset(): array
    {
        if ($this->data !== null) {
            return $this->data;
        }
        $r = $this->request;
        $month = (string)$r->query('month', '');
        if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            $from = "$month-01";
            $to = date('Y-m-t', strtotime($from));
        } else {
            $from = $this->qDate('from', date('Y-m-01'));
            $to = $this->qDate('to', date('Y-m-d'));
        }
        if ($to < $from) {
            [$from, $to] = [$to, $from];
        }
        $where = [];
        $params = [];
        if ($id = $r->queryInt('employee_id')) {
            $where[] = 'e.id = :id';
            $params['id'] = $id;
        } elseif (($code = (string)$r->query('code', '')) !== '') {
            $where[] = 'e.code = :code';
            $params['code'] = $code;
        } elseif ($dept = $r->queryInt('department_id')) {
            $where[] = 'e.department_id = :dept AND e.joining_date <= :to AND (e.leaving_date IS NULL OR e.leaving_date >= :from)';
            $params += ['dept' => $dept, 'to' => $to, 'from' => $from];
        } else {
            $where[] = '1 = 0';
        }
        $emps = Database::all(
            'SELECT e.*, d.name AS department, g.name AS designation, sg.name AS shift_group FROM employees e
               JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
          LEFT JOIN shift_groups sg ON sg.id = e.shift_group_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY e.code LIMIT 300',
            $params
        );
        $rows = [];
        $leaves = [];
        if ($emps) {
            $in = implode(',', array_map(fn($e) => (int)$e['id'], $emps));
            foreach (Database::all(
                "SELECT a.*, v.vr_no, s.code AS shift_code, o.approved_minutes, o.status AS ot_status
                   FROM attendance_daily a
              LEFT JOIN attendance_vouchers v ON v.id = a.voucher_id
              LEFT JOIN shifts s ON s.id = a.shift_id
              LEFT JOIN overtime o ON o.employee_id = a.employee_id AND o.ot_date = a.att_date
                  WHERE a.employee_id IN ($in) AND a.att_date BETWEEN ? AND ?",
                [$from, $to]
            ) as $a) {
                $rows[(int)$a['employee_id']][$a['att_date']] = $a;
            }
            foreach (Database::all(
                "SELECT l.employee_id, l.from_date, l.to_date, t.name FROM leave_register l JOIN leave_types t ON t.id = l.leave_type_id
                  WHERE l.status = 'approved' AND l.employee_id IN ($in) AND l.from_date <= ? AND l.to_date >= ?",
                [$to, $from]
            ) as $l) {
                foreach (Calendar::dates(max($from, $l['from_date']), min($to, $l['to_date'])) as $dt) {
                    $leaves[(int)$l['employee_id']][$dt] = $l['name'];
                }
            }
        }
        return $this->data = ['from' => $from, 'to' => $to, 'emps' => $emps, 'rows' => $rows, 'leaves' => $leaves, 'cal' => new Calendar($from, $to)];
    }

    protected function subtitle(): string
    {
        $d = $this->dataset();
        return 'Period: ' . self::date($d['from']) . ' to ' . self::date($d['to']);
    }

    private function description(array $e, string $date, ?array $a, array $d): string
    {
        $parts = [];
        if (!$d['cal']->isEmployed($e, $date)) {
            return 'Not employed';
        }
        if ($h = $d['cal']->holiday($date)) {
            $parts[] = $h['name'];
        }
        if ($lv = $d['leaves'][(int)$e['id']][$date] ?? null) {
            $parts[] = $lv;
        }
        if ($a) {
            if (!$h && $a['status'] === 'R') {
                $parts[] = 'Weekly rest';
            }
            if ((int)$a['late_minutes'] > 0) {
                $parts[] = 'Late ' . self::hm($a['late_minutes']);
            }
            if ((int)$a['early_minutes'] > 0 && $a['time_out']) {
                $parts[] = 'Early ' . self::hm($a['early_minutes']);
            }
            if ($a['flag_reason']) {
                $parts[] = $a['flag_reason'];
            }
            if ($a['remarks']) {
                $parts[] = $a['remarks'];
            }
        } else {
            $parts[] = 'Not marked';
        }
        return implode('; ', $parts);
    }

    protected function body(): string
    {
        $d = $this->dataset();
        if (!$d['emps']) {
            return '<p class="empty">Select an employee (or a department).</p>';
        }
        $html = '';
        foreach ($d['emps'] as $n => $e) {
            $eid = (int)$e['id'];
            $html .= '<div style="' . ($n ? 'page-break-before:always;break-before:page;' : '') . 'margin:4px 0 6px">'
                . '<table class="rpt-table" style="width:auto"><tr><th>Employee</th><td><b>' . self::e($e['code']) . ' — ' . self::e($e['name']) . '</b>'
                . ($e['name_ur'] ? ' <span class="urdu">' . self::e($e['name_ur']) . '</span>' : '') . '</td>'
                . '<th>Department</th><td>' . self::e($e['department']) . '</td><th>Designation</th><td>' . self::e($e['designation']) . '</td>'
                . '<th>Shift group</th><td>' . self::e($e['shift_group'] ?? '-') . '</td></tr></table></div>';
            $html .= '<table class="rpt-table"><thead><tr><th>Vr#</th><th>Date</th><th>Day</th><th>Shift</th><th>Time In</th><th>Time Out</th>'
                . '<th class="num">Hours</th><th class="num">OT (appr.)</th><th>Status</th><th>Description</th></tr></thead><tbody>';
            $tot = ['work' => 0, 'ot' => 0] + array_fill_keys(array_keys(self::STATUS_NAMES), 0);
            foreach (Calendar::dates($d['from'], $d['to']) as $dt) {
                $a = $d['rows'][$eid][$dt] ?? null;
                if ($a) {
                    $tot['work'] += (int)$a['work_minutes'];
                    $tot[$a['status']]++;
                    $tot['ot'] += $a['ot_status'] === 'approved' ? (int)$a['approved_minutes'] : 0;
                }
                $html .= '<tr><td>' . ($a && $a['vr_no'] ? (int)$a['vr_no'] : ($a ? self::e(ucfirst($a['source'])) : '')) . '</td>'
                    . '<td class="nowrap">' . self::date($dt) . '</td><td>' . date('D', strtotime($dt)) . '</td>'
                    . '<td>' . self::e($a['shift_code'] ?? '') . '</td>'
                    . '<td class="nowrap">' . ($a ? self::time($a['time_in']) . ($a['time_in'] && substr($a['time_in'], 0, 10) !== $dt ? ' (' . date('d/m', strtotime($a['time_in'])) . ')' : '') : '') . '</td>'
                    . '<td class="nowrap">' . ($a ? self::time($a['time_out']) . ($a['time_out'] && substr($a['time_out'], 0, 10) !== $dt ? ' (+1)' : '') : '') . '</td>'
                    . '<td class="num">' . self::hm($a['work_minutes'] ?? 0) . '</td>'
                    . '<td class="num">' . ($a && $a['ot_status'] === 'approved' ? self::hm($a['approved_minutes']) : '') . '</td>'
                    . '<td><b>' . self::e($a['status'] ?? '') . '</b></td>'
                    . '<td>' . self::e($this->description($e, $dt, $a, $d)) . '</td></tr>';
            }
            $counts = [];
            foreach (self::STATUS_NAMES as $k => $v) {
                if ($tot[$k]) {
                    $counts[] = "$k: {$tot[$k]}";
                }
            }
            $html .= '</tbody><tfoot><tr class="grandtotal"><td colspan="6">' . implode(' &nbsp; ', $counts) . '</td>'
                . '<td class="num">' . self::hm($tot['work'], false) . '</td><td class="num">' . self::hm($tot['ot'], false) . '</td><td colspan="2"></td></tr></tfoot></table>';
        }
        return $html;
    }

    public function csv(): array
    {
        $d = $this->dataset();
        $out = [['Code', 'Name', 'Vr#', 'Date', 'Shift', 'Time In', 'Time Out', 'Work Minutes', 'Approved OT Minutes', 'Status', 'Description']];
        foreach ($d['emps'] as $e) {
            foreach (Calendar::dates($d['from'], $d['to']) as $dt) {
                $a = $d['rows'][(int)$e['id']][$dt] ?? null;
                $out[] = [$e['code'], $e['name'], $a['vr_no'] ?? '', $dt, $a['shift_code'] ?? '', $a ? ($a['time_in'] ?? '') : '',
                    $a ? ($a['time_out'] ?? '') : '', $a['work_minutes'] ?? '', $a && $a['ot_status'] === 'approved' ? $a['approved_minutes'] : '',
                    $a['status'] ?? '', $this->description($e, $dt, $a, $d)];
            }
        }
        return $out;
    }
}
