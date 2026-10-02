<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Vouchers;

/** Loan Report with outstanding balances (optionally the installment schedule of each loan). */
final class LoanReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['loans', 'print'];
    }

    public function title(): string
    {
        return 'Loan Report';
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
        if ($this->rows !== null) {
            return $this->rows;
        }
        $where = ['v.deleted_at IS NULL', "v.status = 'posted'"];
        $params = [];
        $status = (string)$this->request->query('status', 'active');
        if (in_array($status, ['active', 'closed'], true)) {
            $where[] = 'l.status = :s';
            $params['s'] = $status;
        }
        if ($d = $this->request->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $d;
        }
        if ($e = $this->request->queryInt('employee_id')) {
            $where[] = 'l.employee_id = :e';
            $params['e'] = $e;
        }
        return $this->rows = Database::all(
            "SELECT l.*, v.vr_no, v.vr_date, e.code, e.name, d.name AS department, g.name AS designation,
                    COALESCE(SUM(li.deducted_amount), 0) AS deducted,
                    MIN(CASE WHEN li.status IN ('scheduled','adjusted') THEN li.due_month END) AS next_month,
                    COUNT(CASE WHEN li.status IN ('scheduled','adjusted') THEN 1 END) AS remaining,
                    SUM(li.status = 'skipped') AS skipped
               FROM loans l
               JOIN vouchers v ON v.id = l.voucher_id
               JOIN employees e ON e.id = l.employee_id
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id
          LEFT JOIN loan_installments li ON li.loan_id = l.id
              WHERE " . implode(' AND ', $where) . '
           GROUP BY l.id ORDER BY d.name, e.code, v.vr_date',
            $params
        );
    }

    protected function subtitle(): string
    {
        $status = (string)$this->request->query('status', 'active');
        $parts = ['Loans: ' . ($status === '' ? 'All' : ucfirst(self::e($status))), 'As on ' . date('d-m-Y')];
        if ($x = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $x;
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No loans for the selected filters.</p>';
        }
        $detail = (bool)$this->request->query('detail');
        $h = '<table class="rpt-table"><thead><tr><th class="num">Sr</th><th>Vr#</th><th>Date</th><th>Code</th><th>Name</th><th>Designation</th>'
            . '<th class="num">Loan</th><th class="num">Installment</th><th>Start</th><th class="num">Deducted</th><th class="num">Balance</th>'
            . '<th>Next due</th><th class="num">Inst. left</th><th>Status</th></tr></thead><tbody>';
        $dept = null;
        $sr = 0;
        $tot = ['amount' => 0, 'deducted' => 0, 'balance' => 0];
        $dTot = $tot;
        $flush = function () use (&$h, &$dept, &$dTot) {
            if ($dept !== null) {
                $h .= '<tr class="subtotal"><td colspan="6">Total ' . self::e($dept) . '</td><td class="num">' . self::money($dTot['amount'])
                    . '</td><td colspan="2"></td><td class="num">' . self::money($dTot['deducted']) . '</td><td class="num">' . self::money($dTot['balance'])
                    . '</td><td colspan="3"></td></tr>';
            }
        };
        foreach ($rows as $r) {
            if ($r['department'] !== $dept) {
                $flush();
                $dept = $r['department'];
                $dTot = ['amount' => 0, 'deducted' => 0, 'balance' => 0];
                $h .= '<tr class="group"><td colspan="14">' . self::e($dept) . '</td></tr>';
            }
            $sr++;
            $bal = (float)$r['amount'] - (float)$r['deducted'];
            foreach (['amount' => (float)$r['amount'], 'deducted' => (float)$r['deducted'], 'balance' => $bal] as $k => $v) {
                $dTot[$k] += $v;
                $tot[$k] += $v;
            }
            $h .= '<tr><td class="num">' . $sr . '</td><td class="nowrap">' . self::e(Vouchers::number('LOAN', $r['vr_no'])) . '</td><td class="nowrap">'
                . self::date($r['vr_date']) . '</td><td>' . self::e($r['code']) . '</td><td>' . self::e($r['name']) . '</td><td>' . self::e($r['designation'])
                . '</td><td class="num">' . self::money($r['amount']) . '</td><td class="num">' . self::money($r['installment']) . '</td><td class="nowrap">'
                . date('M Y', strtotime($r['start_month'])) . '</td><td class="num">' . self::money($r['deducted']) . '</td><td class="num"><b>'
                . self::money($bal) . '</b></td><td class="nowrap">' . ($r['next_month'] ? date('M Y', strtotime($r['next_month'])) : '') . '</td><td class="num">'
                . (int)$r['remaining'] . ((int)$r['skipped'] ? ' <small>(' . (int)$r['skipped'] . ' skipped)</small>' : '') . '</td><td>' . ucfirst(self::e($r['status'])) . '</td></tr>';
            if ($detail) {
                $inst = Database::all('SELECT * FROM loan_installments WHERE loan_id = ? ORDER BY due_month', [$r['id']]);
                $cells = array_map(fn($i) => date('M y', strtotime($i['due_month'])) . ': ' . ($i['status'] === 'deducted'
                    ? self::money($i['deducted_amount']) . ' ✔' : ($i['status'] === 'skipped' ? 'skipped' : self::money($i['scheduled_amount']) . ($i['status'] === 'adjusted' ? '*' : ''))), $inst);
                $h .= '<tr><td></td><td colspan="13" style="font-size:7.5pt;color:#333">' . self::e(implode(' · ', $cells)) . '</td></tr>';
            }
        }
        $flush();
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="6">Grand Total: ' . $sr . ' loan(s)</td><td class="num">' . self::money($tot['amount'])
            . '</td><td colspan="2"></td><td class="num">' . self::money($tot['deducted']) . '</td><td class="num">' . self::money($tot['balance'])
            . '</td><td colspan="3"></td></tr></tfoot></table>'
            . ($detail ? '<p style="font-size:7.5pt">✔ = deducted in salary · * = adjusted installment</p>' : '');
    }

    public function csv(): array
    {
        $out = [['Vr#', 'Date', 'Department', 'Code', 'Name', 'Loan Amount', 'Installment', 'Start Month', 'Deducted', 'Balance', 'Next Due', 'Installments Left', 'Status']];
        foreach ($this->fetch() as $r) {
            $out[] = [Vouchers::number('LOAN', $r['vr_no']), $r['vr_date'], $r['department'], $r['code'], $r['name'], $r['amount'], $r['installment'],
                substr($r['start_month'], 0, 7), $r['deducted'], (float)$r['amount'] - (float)$r['deducted'], $r['next_month'] ? substr($r['next_month'], 0, 7) : '',
                $r['remaining'], $r['status']];
        }
        return $out;
    }
}
