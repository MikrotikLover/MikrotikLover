<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Money;
use App\Vouchers;

/** Printable voucher (any type): number, date, employee, amount in figures and words, signatures. */
final class VoucherSlipReport extends Report
{
    private ?array $v = null;

    public function permission(): array
    {
        $v = $this->voucher();
        return [Vouchers::TYPES[$v['voucher_type']]['module'], 'print'];
    }

    private function voucher(): array
    {
        if ($this->v === null) {
            $this->v = Vouchers::find((int)$this->request->query('id', 0));
        }
        return $this->v;
    }

    public function title(): string
    {
        return Vouchers::label($this->voucher()['voucher_type']) . ' Voucher';
    }

    protected function subtitle(): string
    {
        $v = $this->voucher();
        return '<b>' . self::e($v['number']) . '</b> &nbsp;|&nbsp; Date: ' . self::date($v['vr_date']) . ' &nbsp;|&nbsp; '
            . ($v['status'] === 'posted' ? 'Posted' : '<b>DRAFT - not posted</b>');
    }

    protected function pageCss(): string
    {
        return '.slip th { width: 32mm; text-align: left; background: #f2f2f2; } .slip td, .slip th { padding: 5px 8px; }
            .signs { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10mm; margin-top: 22mm; }
            .signs div { border-top: 1px solid #000; text-align: center; padding-top: 3px; font-size: 8.5pt; }
            .amount-big { font-size: 13pt; font-weight: 700; }';
    }

    protected function body(): string
    {
        $v = $this->voucher();
        $type = $v['voucher_type'];
        $rows = [];
        if ($v['employee_id']) {
            $rows[] = ['Employee', self::e($v['code'] . ' — ' . $v['name']) . ($v['name_ur'] ? ' <span class="urdu">' . self::e($v['name_ur']) . '</span>' : '')];
            $rows[] = ['Department', self::e($v['department'] . ' / ' . $v['designation'])];
        }
        if (in_array($type, ['ADV', 'INC', 'PEN', 'OT'], true)) {
            $rows[] = [$type === 'ADV' || $type === 'PEN' ? 'Deduct from salary of' : 'Pay with salary of', date('F Y', strtotime($v['deduct_month']))];
        }
        if ($type === 'OT' && (float)$v['ot_hours']) {
            $rows[] = ['OT hours', rtrim(rtrim((string)$v['ot_hours'], '0'), '.') . ' hour(s) at the employee\'s OT rate'];
        }
        if (in_array($type, ['ADV', 'LOAN'], true) && $v['pay_account']) {
            $rows[] = ['Paid from', self::e($v['pay_account_code'] . ' - ' . $v['pay_account'])];
        }
        $extra = '';
        if ($type === 'LOAN') {
            $loan = Database::one('SELECT * FROM loans WHERE voucher_id = ?', [$v['id']]);
            $rows[] = ['Installment', self::money($loan['installment']) . ' per month from ' . date('F Y', strtotime($loan['start_month']))];
            $inst = Database::all('SELECT * FROM loan_installments WHERE loan_id = ? ORDER BY due_month', [$loan['id']]);
            $extra = '<h3 style="font-size:10pt;margin:10px 0 4px">Repayment schedule</h3><table class="rpt-table" style="width:auto"><tr><th>Month</th><th class="num">Installment</th><th>Status</th></tr>';
            foreach ($inst as $i) {
                $extra .= '<tr><td>' . date('M Y', strtotime($i['due_month'])) . '</td><td class="num">' . self::money($i['status'] === 'deducted' ? $i['deducted_amount'] : $i['scheduled_amount'])
                    . '</td><td>' . ucfirst(self::e($i['status'])) . '</td></tr>';
            }
            $extra .= '</table>';
        }
        if ($type === 'JV') {
            $extra = '<table class="rpt-table" style="margin-top:8px"><thead><tr><th>Account</th><th>Employee</th><th>Narration</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead><tbody>';
            foreach (Vouchers::journal((int)$v['id']) as $l) {
                $extra .= '<tr><td>' . self::e($l['account_code'] . ' - ' . $l['account']) . '</td><td>' . self::e(trim(($l['employee_code'] ?? '') . ' ' . ($l['employee'] ?? '')))
                    . '</td><td>' . self::e($l['narration']) . '</td><td class="num">' . ((float)$l['debit'] ? number_format((float)$l['debit'], 2) : '')
                    . '</td><td class="num">' . ((float)$l['credit'] ? number_format((float)$l['credit'], 2) : '') . '</td></tr>';
            }
            $extra .= '</tbody></table>';
        }
        $rows[] = ['Amount', '<span class="amount-big">Rs. ' . self::money($v['amount']) . '/-</span>'];
        $rows[] = ['In words', self::e(Money::words($v['amount']))];
        if ($v['remarks']) {
            $rows[] = ['Remarks', self::e($v['remarks'])];
        }
        $h = '<table class="rpt-table slip">';
        foreach ($rows as [$k, $val]) {
            $h .= '<tr><th>' . self::e($k) . '</th><td>' . $val . '</td></tr>';
        }
        $h .= '</table>' . $extra;
        $last = $v['employee_id'] ? ($type === 'PEN' ? 'Employee' : 'Received by (employee)') : 'Authorized by';
        $h .= '<div class="signs"><div>Prepared by<br>' . self::e($v['created_by_name'] ?? '') . '</div><div>Checked by</div><div>Approved by'
            . ($v['posted_by_name'] ? '<br>' . self::e($v['posted_by_name']) : '') . '</div><div>' . $last . '</div></div>';
        return $h;
    }
}
