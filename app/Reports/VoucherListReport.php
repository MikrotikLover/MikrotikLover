<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Vouchers;

/**
 * Advance Salary / Incentive / Penalty / Overtime voucher reports (type = ADV | INC | PEN | OT),
 * grouped by department with totals. Filters: from/to (voucher date) or month (salary month),
 * status, department, employee.
 */
final class VoucherListReport extends Report
{
    private ?array $rows = null;
    private const TITLES = ['ADV' => 'Advance Salary Report', 'INC' => 'Incentive Report', 'PEN' => 'Penalty Report', 'OT' => 'Overtime Voucher Report'];

    public function permission(): array
    {
        return ['vouchers', 'print'];
    }

    private function type(): string
    {
        $t = strtoupper((string)$this->request->query('type', 'ADV'));
        return isset(self::TITLES[$t]) ? $t : 'ADV';
    }

    public function title(): string
    {
        return self::TITLES[$this->type()];
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function fetch(): array
    {
        if ($this->rows !== null) {
            return $this->rows;
        }
        $where = ['v.voucher_type = :t', 'v.deleted_at IS NULL'];
        $params = ['t' => $this->type()];
        $month = (string)$this->request->query('month', '');
        if (preg_match('/^\d{4}-\d{2}$/', $month)) {
            $where[] = 'v.deduct_month = :m';
            $params['m'] = "$month-01";
        } else {
            $where[] = 'v.vr_date BETWEEN :f AND :to';
            $params['f'] = $this->qDate('from', date('Y-m-01'));
            $params['to'] = $this->qDate('to', date('Y-m-d'));
        }
        $status = (string)$this->request->query('status', 'posted');
        if (in_array($status, ['draft', 'posted'], true)) {
            $where[] = 'v.status = :s';
            $params['s'] = $status;
        }
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        if ($e = $this->request->queryInt('employee_id')) {
            $where[] = 'v.employee_id = :e';
            $params['e'] = $e;
        }
        return $this->rows = Database::all(
            'SELECT v.*, e.code, e.name, d.name AS department, g.name AS designation, a.name AS pay_account
               FROM vouchers v
               JOIN employees e ON e.id = v.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN accounts a ON a.id = v.pay_account_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, e.code, v.vr_date, v.vr_no',
            $params
        );
    }

    protected function subtitle(): string
    {
        $month = (string)$this->request->query('month', '');
        $parts = [preg_match('/^\d{4}-\d{2}$/', $month)
            ? 'Salary month: ' . date('F Y', strtotime("$month-01"))
            : 'Period: ' . self::date($this->qDate('from', date('Y-m-01'))) . ' to ' . self::date($this->qDate('to', date('Y-m-d')))];
        $status = (string)$this->request->query('status', 'posted');
        $parts[] = 'Status: ' . ($status === '' ? 'All' : ucfirst(self::e($status)));
        if ($x = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $x;
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No vouchers for the selected filters.</p>';
        }
        $ot = $this->type() === 'OT';
        $adv = $this->type() === 'ADV';
        $cols = 9 + ($ot ? 1 : 0) + ($adv ? 1 : 0);
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Vr#</th><th>Date</th><th>Code</th><th>Name</th><th>Designation</th>'
            . '<th>Salary month</th>' . ($adv ? '<th>Paid from</th>' : '') . ($ot ? '<th class="num">OT hours</th>' : '')
            . '<th class="num">Amount</th><th>Status / Remarks</th></tr></thead><tbody>';
        $dept = null;
        $dt = 0.0;
        $dh = 0.0;
        $gt = 0.0;
        $gh = 0.0;
        $sr = 0;
        $flush = function () use (&$h, &$dept, &$dt, &$dh, $cols, $ot) {
            if ($dept !== null) {
                $h .= '<tr class="subtotal"><td colspan="' . ($cols - ($ot ? 3 : 2)) . '">Total ' . self::e($dept) . '</td>'
                    . ($ot ? '<td class="num">' . rtrim(rtrim(number_format($dh, 2), '0'), '.') . '</td>' : '')
                    . '<td class="num">' . self::money($dt) . '</td><td></td></tr>';
            }
        };
        foreach ($rows as $r) {
            if ($r['department'] !== $dept) {
                $flush();
                $dept = $r['department'];
                $dt = $dh = 0;
                $h .= '<tr class="group"><td colspan="' . $cols . '">' . self::e($dept) . '</td></tr>';
            }
            $sr++;
            $dt += (float)$r['amount'];
            $gt += (float)$r['amount'];
            $dh += (float)$r['ot_hours'];
            $gh += (float)$r['ot_hours'];
            $state = $r['salary_sheet_id'] ? 'In salary' : ucfirst($r['status']);
            $h .= '<tr><td class="num">' . $sr . '</td><td class="nowrap">' . self::e(Vouchers::number($r['voucher_type'], $r['vr_no'])) . '</td>'
                . '<td class="nowrap">' . self::date($r['vr_date']) . '</td><td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td>'
                . '<td>' . self::e($r['designation']) . '</td><td class="nowrap">' . date('M Y', strtotime($r['deduct_month'])) . '</td>'
                . ($adv ? '<td>' . self::e($r['pay_account']) . '</td>' : '')
                . ($ot ? '<td class="num">' . ((float)$r['ot_hours'] ? rtrim(rtrim((string)$r['ot_hours'], '0'), '.') : '') . '</td>' : '')
                . '<td class="num">' . self::money($r['amount']) . '</td><td>' . self::e($state . ($r['remarks'] ? ' · ' . $r['remarks'] : '')) . '</td></tr>';
        }
        $flush();
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="' . ($cols - ($ot ? 3 : 2)) . '">Grand Total: ' . $sr . ' voucher(s)</td>'
            . ($ot ? '<td class="num">' . rtrim(rtrim(number_format($gh, 2), '0'), '.') . '</td>' : '')
            . '<td class="num">' . self::money($gt) . '</td><td></td></tr></tfoot></table>';
    }

    public function csv(): array
    {
        $out = [['Vr#', 'Date', 'Department', 'Code', 'Name', 'Designation', 'Salary Month', 'OT Hours', 'Amount', 'Status', 'Remarks']];
        foreach ($this->fetch() as $r) {
            $out[] = [Vouchers::number($r['voucher_type'], $r['vr_no']), $r['vr_date'], $r['department'], $r['code'], $r['name'], $r['designation'],
                substr($r['deduct_month'], 0, 7), $r['ot_hours'], $r['amount'], $r['salary_sheet_id'] ? 'in salary' : $r['status'], $r['remarks']];
        }
        return $out;
    }
}
