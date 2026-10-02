<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Vouchers;

/** JV Report: journal vouchers in a period with their debit / credit lines. */
final class JournalReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['journal', 'print'];
    }

    public function title(): string
    {
        return 'Journal Voucher Report';
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
        $where = ["v.voucher_type = 'JV'", 'v.deleted_at IS NULL', 'v.vr_date BETWEEN :f AND :t'];
        $params = ['f' => $this->qDate('from', date('Y-m-01')), 't' => $this->qDate('to', date('Y-m-d'))];
        $status = (string)$this->request->query('status', 'posted');
        if (in_array($status, ['draft', 'posted'], true)) {
            $where[] = 'v.status = :s';
            $params['s'] = $status;
        }
        if ($id = $this->request->queryInt('id')) {
            $where[] = 'v.id = :id';
            $params['id'] = $id;
        }
        if ($a = $this->request->queryInt('account_id')) {
            $where[] = 'EXISTS (SELECT 1 FROM journal_entries x WHERE x.voucher_id = v.id AND x.account_id = :a)';
            $params['a'] = $a;
        }
        return $this->rows = Database::all(
            'SELECT v.id, v.vr_no, v.vr_date, v.remarks, v.status, v.is_system, j.line_no, a.code AS account_code, a.name AS account,
                    e.code AS employee_code, e.name AS employee, j.debit, j.credit, j.narration
               FROM vouchers v JOIN journal_entries j ON j.voucher_id = v.id JOIN accounts a ON a.id = j.account_id
          LEFT JOIN employees e ON e.id = j.employee_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY v.vr_date, v.vr_no, j.line_no',
            $params
        );
    }

    protected function subtitle(): string
    {
        $status = (string)$this->request->query('status', 'posted');
        $parts = ['Period: ' . self::date($this->qDate('from', date('Y-m-01'))) . ' to ' . self::date($this->qDate('to', date('Y-m-d'))),
            'Status: ' . ($status === '' ? 'All' : ucfirst(self::e($status)))];
        if ($a = $this->request->queryInt('account_id')) {
            $parts[] = 'Account: ' . self::e((string)Database::value("SELECT CONCAT(code, ' - ', name) FROM accounts WHERE id = ?", [$a]));
        }
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    protected function body(): string
    {
        $rows = $this->fetch();
        if (!$rows) {
            return '<p class="empty">No journal vouchers for the selected filters.</p>';
        }
        $h = '<table class="rpt-table"><thead><tr><th>Account</th><th>Employee</th><th>Narration</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>';
        $cur = null;
        $dr = $cr = $gdr = $gcr = 0.0;
        $n = 0;
        $flush = function () use (&$h, &$cur, &$dr, &$cr) {
            if ($cur !== null) {
                $h .= '<tr class="subtotal"><td colspan="3">Total</td><td class="num">' . number_format($dr, 2) . '</td><td class="num">' . number_format($cr, 2) . '</td></tr>';
            }
        };
        foreach ($rows as $r) {
            if ($r['id'] !== $cur) {
                $flush();
                $cur = $r['id'];
                $dr = $cr = 0;
                $n++;
                $h .= '<tr class="group"><td colspan="5">' . self::e(Vouchers::number('JV', $r['vr_no'])) . ' &nbsp; ' . self::date($r['vr_date'])
                    . ' &nbsp; ' . self::e($r['remarks']) . ($r['is_system'] ? ' <small>(system)</small>' : '') . ($r['status'] === 'draft' ? ' <small>[DRAFT]</small>' : '') . '</td></tr>';
            }
            $dr += (float)$r['debit'];
            $cr += (float)$r['credit'];
            $gdr += (float)$r['debit'];
            $gcr += (float)$r['credit'];
            $h .= '<tr><td' . ((float)$r['credit'] > 0 ? ' style="padding-left:18px"' : '') . '>' . self::e($r['account_code'] . ' - ' . $r['account']) . '</td>'
                . '<td>' . self::e(trim(($r['employee_code'] ?? '') . ' ' . ($r['employee'] ?? ''))) . '</td><td>' . self::e($r['narration']) . '</td>'
                . '<td class="num">' . ((float)$r['debit'] ? number_format((float)$r['debit'], 2) : '') . '</td>'
                . '<td class="num">' . ((float)$r['credit'] ? number_format((float)$r['credit'], 2) : '') . '</td></tr>';
        }
        $flush();
        return $h . '</tbody><tfoot><tr class="grandtotal"><td colspan="3">Grand Total: ' . $n . ' voucher(s)</td><td class="num">' . number_format($gdr, 2)
            . '</td><td class="num">' . number_format($gcr, 2) . '</td></tr></tfoot></table>';
    }

    public function csv(): array
    {
        $out = [['Vr#', 'Date', 'Narration', 'Status', 'Line', 'Account Code', 'Account', 'Employee Code', 'Employee', 'Line Narration', 'Debit', 'Credit']];
        foreach ($this->fetch() as $r) {
            $out[] = [Vouchers::number('JV', $r['vr_no']), $r['vr_date'], $r['remarks'], $r['status'], $r['line_no'], $r['account_code'], $r['account'],
                $r['employee_code'], $r['employee'], $r['narration'], $r['debit'], $r['credit']];
        }
        return $out;
    }
}
