<?php
declare(strict_types=1);

namespace App\Reports;

use App\Calendar;
use App\Database;

/**
 * Monthly Attendance Sheet: employees grouped by department x days 1..31 (weekday headers),
 * status codes per day and totals per employee; department daily "present" row.
 */
final class MonthlyAttendanceReport extends Report
{
    private ?array $data = null;
    private const TOTALS = ['P' => 'P', 'HD' => 'HD', 'A' => 'A', 'L' => 'L', 'LW' => 'LW', 'R' => 'R', 'H' => 'H'];

    public function permission(): array
    {
        return ['attendance', 'print'];
    }

    public function title(): string
    {
        return 'Monthly Attendance Sheet';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    protected function pageCss(): string
    {
        return '@page { margin: 8mm 6mm 12mm 6mm; }
            table.mas { font-size: 6.8pt; table-layout: fixed; }
            table.mas th, table.mas td { padding: 1px 1px; text-align: center; overflow: hidden; white-space: nowrap; }
            table.mas td.nm { text-align: left; padding-left: 3px; }
            table.mas td.nm small { color: #444; }
            table.mas th.wk { background: #bdbdbd; }
            table.mas td.wk { background: #ededed; }
            table.mas td.A { font-weight: 700; }
            table.mas td.tot { font-weight: 700; background: #f5f5f5; }
            .legend { font-size: 7pt; margin-top: 4px; }';
    }

    private function month(): string
    {
        $m = (string)$this->request->query('month', date('Y-m'));
        return preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $m) ? $m : date('Y-m');
    }

    private function dataset(): array
    {
        if ($this->data !== null) {
            return $this->data;
        }
        $month = $this->month();
        $from = "$month-01";
        $to = date('Y-m-t', strtotime($from));
        $where = ['e.joining_date <= :to', '(e.leaving_date IS NULL OR e.leaving_date >= :from)'];
        $params = ['to' => $to, 'from' => $from];
        if (!$this->request->query('include_inactive')) {
            $where[] = "(e.status = 'active' OR e.leaving_date IS NOT NULL)";
        }
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :dept';
            $params['dept'] = $d;
        }
        $type = (string)$this->request->query('emp_type', '');
        if (in_array($type, ['permanent', 'daily_wages', 'contract'], true)) {
            $where[] = 'e.emp_type = :t';
            $params['t'] = $type;
        }
        $emps = Database::all(
            'SELECT e.*, d.name AS department, g.name AS designation FROM employees e
               JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code',
            $params
        );
        $att = [];
        if ($emps) {
            $in = implode(',', array_map(fn($e) => (int)$e['id'], $emps));
            foreach (Database::all("SELECT employee_id, att_date, status, work_minutes FROM attendance_daily
                                      WHERE employee_id IN ($in) AND att_date BETWEEN ? AND ?", [$from, $to]) as $a) {
                $att[(int)$a['employee_id']][(int)substr($a['att_date'], 8, 2)] = $a;
            }
            $ot = [];
            foreach (Database::all("SELECT employee_id, SUM(approved_minutes) m FROM overtime WHERE status = 'approved'
                                      AND employee_id IN ($in) AND ot_date BETWEEN ? AND ? GROUP BY employee_id", [$from, $to]) as $o) {
                $ot[(int)$o['employee_id']] = (int)$o['m'];
            }
        }
        $cal = new Calendar($from, $to);
        $companyRest = array_map('intval', (array)\App\Settings::get('weekly_rest_days', [0]));
        return $this->data = ['from' => $from, 'to' => $to, 'days' => (int)date('t', strtotime($from)), 'emps' => $emps,
            'att' => $att, 'ot' => $ot ?? [], 'cal' => $cal, 'rest' => $companyRest];
    }

    protected function subtitle(): string
    {
        $d = $this->dataset();
        $parts = ['Month: ' . date('F Y', strtotime($d['from']))];
        if ($l = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $l;
        }
        $type = (string)$this->request->query('emp_type', '');
        if ($type !== '') {
            $parts[] = 'Type: ' . self::e(ucwords(str_replace('_', ' ', $type)));
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    /** Code shown in a day cell. */
    private function cell(array $e, int $day, array $d): string
    {
        $date = sprintf('%s-%02d', substr($d['from'], 0, 7), $day);
        if (!$d['cal']->isEmployed($e, $date)) {
            return '-';
        }
        return $d['att'][(int)$e['id']][$day]['status'] ?? '';
    }

    private function totals(array $e, array $d): array
    {
        $t = array_fill_keys(array_keys(self::TOTALS), 0);
        foreach ($d['att'][(int)$e['id']] ?? [] as $a) {
            $k = $a['status'] === 'S' ? 'P' : $a['status'];
            if (isset($t[$k])) {
                $t[$k]++;
            }
        }
        $t['OT'] = $d['ot'][(int)$e['id']] ?? 0;
        return $t;
    }

    protected function body(): string
    {
        $d = $this->dataset();
        if (!$d['emps']) {
            return '<p class="empty">No employees for the selected filters.</p>';
        }
        $days = $d['days'];
        $month = substr($d['from'], 0, 7);
        $wk = [];
        $head = '<tr><th>Sr</th><th>Employee</th>';
        for ($i = 1; $i <= $days; $i++) {
            $ts = strtotime(sprintf('%s-%02d', $month, $i));
            $isRest = in_array((int)date('w', $ts), $d['rest'], true) || $d['cal']->holiday(date('Y-m-d', $ts));
            $wk[$i] = $isRest;
            $head .= '<th' . ($isRest ? ' class="wk"' : '') . '>' . $i . '<br>' . substr(date('D', $ts), 0, 2) . '</th>';
        }
        foreach (self::TOTALS as $label) {
            $head .= '<th>' . $label . '</th>';
        }
        $head .= '<th>OT hrs</th></tr>';
        $cols = 2 + $days + count(self::TOTALS) + 1;

        // Explicit column widths so 31 days + totals fit A4 landscape (285 mm usable).
        $colgroup = '<colgroup><col style="width:5mm"><col style="width:40mm">' . str_repeat('<col style="width:5.6mm">', $days)
            . str_repeat('<col style="width:6mm">', count(self::TOTALS)) . '<col style="width:10mm"></colgroup>';
        $h = '<table class="rpt-table mas">' . $colgroup . '<thead>' . $head . '</thead><tbody>';
        $dept = null;
        $deptPresent = [];
        $sr = 0;
        $flush = function () use (&$h, &$dept, &$deptPresent, $days, $wk) {
            if ($dept === null) {
                return;
            }
            $h .= '<tr class="subtotal"><td></td><td class="nm">Present in ' . self::e($dept) . '</td>';
            for ($i = 1; $i <= $days; $i++) {
                $h .= '<td' . ($wk[$i] ? ' class="wk"' : '') . '>' . ($deptPresent[$i] ?? 0) . '</td>';
            }
            $h .= '<td colspan="' . (count(self::TOTALS) + 1) . '"></td></tr>';
        };
        foreach ($d['emps'] as $e) {
            if ($e['department'] !== $dept) {
                $flush();
                $dept = $e['department'];
                $deptPresent = [];
                $h .= '<tr class="group"><td colspan="' . $cols . '" style="text-align:left">' . self::e($dept) . '</td></tr>';
            }
            $sr++;
            $h .= '<tr><td>' . $sr . '</td><td class="nm">' . self::e($e['code']) . ' ' . self::e($e['name'])
                . '<br><small>' . self::e($e['designation']) . '</small></td>';
            for ($i = 1; $i <= $days; $i++) {
                $c = $this->cell($e, $i, $d);
                if (in_array($c, ['P', 'S', 'HD'], true)) {
                    $deptPresent[$i] = ($deptPresent[$i] ?? 0) + 1;
                }
                $cls = trim(($wk[$i] ? 'wk ' : '') . ($c === 'A' ? 'A' : ''));
                $h .= '<td' . ($cls ? ' class="' . $cls . '"' : '') . '>' . self::e($c) . '</td>';
            }
            $t = $this->totals($e, $d);
            foreach (array_keys(self::TOTALS) as $k) {
                $h .= '<td class="tot">' . ($t[$k] ?: '') . '</td>';
            }
            $h .= '<td class="tot">' . self::hm($t['OT']) . '</td></tr>';
        }
        $flush();
        $h .= '</tbody></table>';
        $legend = [];
        foreach (self::STATUS_NAMES as $k => $v) {
            $legend[] = "<b>$k</b> = $v";
        }
        return $h . '<div class="legend">' . implode(' &nbsp; ', $legend) . ' &nbsp; <b>-</b> = not employed &nbsp; blank = not marked'
            . ' &nbsp;|&nbsp; P total includes S (joined) &nbsp;|&nbsp; OT = approved overtime</div>';
    }

    public function csv(): array
    {
        $d = $this->dataset();
        $head = ['Department', 'Code', 'Name', 'Designation'];
        for ($i = 1; $i <= $d['days']; $i++) {
            $head[] = (string)$i;
        }
        $out = [array_merge($head, array_values(self::TOTALS), ['OT Minutes'])];
        foreach ($d['emps'] as $e) {
            $row = [$e['department'], $e['code'], $e['name'], $e['designation']];
            for ($i = 1; $i <= $d['days']; $i++) {
                $row[] = $this->cell($e, $i, $d);
            }
            $t = $this->totals($e, $d);
            foreach (array_keys(self::TOTALS) as $k) {
                $row[] = $t[$k];
            }
            $row[] = $t['OT'];
            $out[] = $row;
        }
        return $out;
    }
}
