<?php
declare(strict_types=1);

namespace App\Reports;

use App\Settings;

/**
 * Salary Sheet (Permanent or Daily Wages): A4 landscape, grouped by department with sub-totals,
 * grand total, paid date and a signature column. Work Pay includes prorated allowances, so every
 * row adds up: Gross = Work Pay + OT Amount.
 */
final class SalarySheetReport extends SalaryReport
{
    public function title(): string
    {
        return ($this->isDaily() ? 'Daily Wages' : 'Permanent') . ' Salary Sheet';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    /** [key, header, width mm, kind] kind: money | days | text | rate */
    private function columns(): array
    {
        $ss = (string)Settings::get('social_security', 'PESSI');
        return [
            ['sr', 'Sr', 5, 'sr'], ['department', 'Department', 14, 'text'], ['name', 'Name', 26, 'name'], ['designation', 'Designation', 16, 'text'],
            ['basic', $this->isDaily() ? 'Rate / Day' : 'Basic', 12, 'money'], ['fine', 'Fine', 9, 'money'],
            ['absent_days', 'Absent', 7, 'days'], ['leave_wp_days', 'Leave WP', 7, 'days'], ['leave_wop_days', 'Leave WOP', 7, 'days'],
            ['rest_days', 'Rest Days', 7, 'days'], ['work_days', 'Work Days', 7, 'days'], ['paid_days', 'Paid Days', 7, 'days'],
            ['pay', 'Work Pay', 13, 'money'], ['ot_hours', 'OT Hours', 7, 'days'], ['ot_rate', 'OT Rate', 11, 'rate'], ['ot_amount', 'OT Amount', 10, 'money'],
            ['gross', 'Gross', 13, 'money'], ['advance', 'Advance', 10, 'money'], ['loan_deduction', 'Loan Ded.', 10, 'money'],
            ['loan_balance', 'Loan Bal.', 11, 'money'], ['incentive', 'Incentive', 10, 'money'], ['penalty', 'Penalty', 9, 'money'],
            ['eobi', 'EOBI', 8, 'money'], ['pessi', $ss, 8, 'money'], ['income_tax', 'Income Tax', 9, 'money'], ['net_salary', 'Net Salary', 14, 'money'],
            ['sign', 'Signature', 18, 'sign'],
        ];
    }

    private static function value(array $l, string $key): mixed
    {
        return match ($key) {
            'basic' => (float)$l['daily_rate'] > 0 && (float)$l['basic_salary'] == 0.0 ? $l['daily_rate'] : $l['basic_salary'],
            'pay' => (float)$l['work_pay'] + (float)$l['allowance_pay'],
            default => $l[$key] ?? '',
        };
    }

    protected function pageCss(): string
    {
        return '@page { margin: 8mm 6mm 12mm 6mm; }
            table.sal { font-size: 6.4pt; table-layout: fixed; }
            table.sal th { font-size: 6.2pt; text-align: center; padding: 1px; white-space: normal; line-height: 1.1; overflow-wrap: anywhere; }
            table.sal td { padding: 1px 2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; height: 7mm; }
            table.sal td.nm { white-space: normal; line-height: 1.15; }
            table.sal td.nm small { color: #444; }
            table.sal td.c { text-align: center; }
            table.sal td.net { font-weight: 700; }
            .sal-foot { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12mm; margin-top: 16mm; font-size: 8pt; }
            .sal-foot div { border-top: 1px solid #000; text-align: center; padding-top: 3px; }
            .sal-sum { margin-top: 4mm; font-size: 8pt; }
            .inc-mark { color: #b45309; font-size: 6pt; }';
    }

    private function cell(array $c, mixed $v, bool $total = false): string
    {
        [$key, , , $kind] = $c;
        return match ($kind) {
            'money' => '<td class="num' . ($key === 'net_salary' ? ' net' : '') . '">' . ((float)$v != 0.0 ? self::money($v) : '') . '</td>',
            'days' => '<td class="c">' . self::days($v) . '</td>',
            'rate' => '<td class="num">' . ($total || (float)$v == 0.0 ? '' : number_format((float)$v, 2)) . '</td>',
            'sign' => '<td class="sign"></td>',
            default => '<td>' . self::e((string)$v) . '</td>',
        };
    }

    private function totalRow(string $class, string $label, array $lines): string
    {
        $cols = $this->columns();
        $h = '<tr class="' . $class . '"><td colspan="4">' . self::e($label) . ' (' . count($lines) . ')</td>';
        foreach (array_slice($cols, 4) as $c) {
            if ($c[0] === 'basic' || $c[3] === 'rate' || $c[3] === 'sign') {
                $h .= '<td></td>';
                continue;
            }
            $h .= $this->cell($c, array_sum(array_map(fn($l) => (float)self::value($l, $c[0]), $lines)), true);
        }
        return $h . '</tr>';
    }

    protected function body(): string
    {
        $lines = $this->lines();
        if (!$lines) {
            return $this->emptyMsg();
        }
        $cols = $this->columns();
        $h = '<table class="rpt-table sal"><colgroup>';
        foreach ($cols as $c) {
            $h .= '<col style="width:' . $c[2] . 'mm">';
        }
        $h .= '</colgroup><thead><tr>';
        foreach ($cols as $c) {
            $h .= '<th>' . self::e($c[1]) . '</th>';
        }
        $h .= '</tr></thead><tbody>';
        $sr = 0;
        foreach ($this->byDepartment() as $dept => $rows) {
            $h .= '<tr class="group"><td colspan="' . count($cols) . '">' . self::e($dept) . '</td></tr>';
            foreach ($rows as $l) {
                $h .= '<tr>';
                foreach ($cols as $c) {
                    $h .= match ($c[3]) {
                        'sr' => '<td class="c">' . ++$sr . '</td>',
                        'name' => '<td class="nm"><b>' . self::e($l['code']) . '</b> ' . self::e($l['name'])
                            . (!empty($l['increment_note']) ? ' <span class="inc-mark" title="' . self::e($l['increment_note']) . '">▲</span>' : '') . '</td>',
                        default => $this->cell($c, self::value($l, $c[0])),
                    };
                }
                $h .= '</tr>';
            }
            $h .= $this->totalRow('subtotal', 'Sub-total ' . $dept, $rows);
        }
        $h .= $this->totalRow('grandtotal', 'Grand Total', $lines) . '</tbody></table>';

        $cash = $bank = 0.0;
        foreach ($lines as $l) {
            $l['payment_mode'] === 'bank' ? $bank += (float)$l['net_salary'] : $cash += (float)$l['net_salary'];
        }
        $h .= '<div class="sal-sum">Net payable: <b>Rs. ' . self::money($cash + $bank) . '</b> &nbsp; (Cash ' . self::money($cash)
            . ' &nbsp;·&nbsp; Bank ' . self::money($bank) . ') &nbsp;·&nbsp; Work Pay includes prorated allowances; OT Amount includes fixed OT voucher amounts.</div>';
        $notes = array_filter($lines, fn($l) => !empty($l['increment_note']));
        if ($notes) {
            $h .= '<div class="sal-sum"><b>▲ Salary changed within the period</b> (work pay is split pro rata; OT is priced at the salary of each OT date):<br>'
                . implode('<br>', array_map(fn($l) => '<b>' . self::e($l['code']) . '</b> ' . self::e($l['name']) . ': ' . self::e($l['increment_note']), $notes)) . '</div>';
        }
        $h .= '<div class="sal-foot"><div>Prepared by</div><div>Checked by (HR)</div><div>Accounts</div><div>Approved by</div></div>';
        return $h;
    }

    public function csv(): array
    {
        $cols = array_values(array_filter($this->columns(), fn($c) => !in_array($c[3], ['sr', 'sign'], true)));
        $out = [array_merge(['Code'], array_map(fn($c) => $c[1], $cols), ['Payment', 'Bank Account', 'Remarks', 'Increment in period'])];
        foreach ($this->lines() as $l) {
            $row = [$l['code']];
            foreach ($cols as $c) {
                $row[] = self::value($l, $c[0]);
            }
            $out[] = array_merge($row, [$l['payment_mode'], $l['bank_account'], $l['remarks'], $l['increment_note'] ?? '']);
        }
        return $out;
    }
}
