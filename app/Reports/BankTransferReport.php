<?php
declare(strict_types=1);

namespace App\Reports;

/** Bank transfer list: employees paid by bank — CNIC, bank, account, net salary (CSV for the bank portal). */
final class BankTransferReport extends SalaryReport
{
    public function title(): string
    {
        return 'Salary Bank Transfer List';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function bankLines(): array
    {
        return array_values(array_filter($this->lines(), fn($l) => $l['payment_mode'] === 'bank'));
    }

    protected function body(): string
    {
        $lines = $this->bankLines();
        if (!$lines) {
            return '<div class="empty">No employees on this sheet are paid by bank.</div>';
        }
        $h = '<table class="rpt-table"><thead><tr><th>Sr</th><th>Code</th><th>Name</th><th>CNIC</th><th>Department</th><th>Bank</th><th>Account No.</th>'
            . '<th class="num">Net Salary</th></tr></thead><tbody>';
        $total = 0.0;
        $missing = 0;
        foreach ($lines as $i => $l) {
            $total += (float)$l['net_salary'];
            $noAcc = trim((string)$l['bank_account']) === '';
            $missing += $noAcc ? 1 : 0;
            $h .= '<tr><td>' . ($i + 1) . '</td><td>' . self::e($l['code']) . '</td><td>' . self::e($l['name']) . '</td><td class="nowrap">' . self::e($l['cnic'])
                . '</td><td>' . self::e($l['department']) . '</td><td>' . self::e($l['bank_name']) . '</td><td class="nowrap">'
                . ($noAcc ? '<b>MISSING</b>' : self::e($l['bank_account'])) . '</td><td class="num">' . self::money($l['net_salary']) . '</td></tr>';
        }
        $h .= '<tr class="grandtotal"><td colspan="7">Total (' . count($lines) . ' employees)</td><td class="num">' . self::money($total) . '</td></tr></tbody></table>';
        $h .= '<p style="font-size:9pt;margin-top:3mm">Amount in words: <b>' . self::e(\App\Money::words($total)) . '</b></p>';
        if ($missing) {
            $h .= '<p style="font-size:9pt"><b>' . $missing . ' employee(s) have no bank account</b> — update salary info before sending to the bank.</p>';
        }
        return $h . '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:14mm;margin-top:20mm;font-size:8.5pt;text-align:center">'
            . '<div style="border-top:1px solid #000">Prepared by</div><div style="border-top:1px solid #000">Authorized signatory 1</div>'
            . '<div style="border-top:1px solid #000">Authorized signatory 2</div></div>';
    }

    public function csv(): array
    {
        $out = [['Code', 'Name', 'CNIC', 'Bank', 'Account No', 'Amount']];
        foreach ($this->bankLines() as $l) {
            $out[] = [$l['code'], $l['name'], $l['cnic'], $l['bank_name'], $l['bank_account'], (int)round((float)$l['net_salary'])];
        }
        return $out;
    }
}
