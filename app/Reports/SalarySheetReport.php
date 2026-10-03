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
    /** "Salary Sheet For The Month Of February, 2017"; a weekly / fortnightly daily-wages sheet names its period. */
    public function title(): string
    {
        $s = $this->sheet();
        $kind = $this->isDaily() ? 'Daily Wages ' : '';
        $fullMonth = substr($s['period_from'], 8) === '01' && $s['period_to'] === date('Y-m-t', strtotime($s['period_from']));
        if ($this->isDaily() && !$fullMonth) {
            return $kind . 'Salary Sheet For The Period ' . date('d-m-Y', strtotime($s['period_from'])) . ' To ' . date('d-m-Y', strtotime($s['period_to']));
        }
        return $kind . 'Salary Sheet For The Month Of ' . date('F, Y', strtotime($s['salary_month']));
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    /**
     * [key, header, width mm, kind] kind: money | days | text | rate. Columns of the printed sheet:
     * Sr, ID, Name, Designation, Paid Days, Basic, Gross, OT Hour, OT Rate, Overtime, Advance, Loan Ded.,
     * Remaining Bal., Incentive, Penalty, Fine, Net Salary, Signature. EOBI / social security / tax columns are
     * added only when the sheet has such amounts (they are off unless enabled on an employee).
     */
    private function columns(): array
    {
        $ss = (string)Settings::get('social_security', 'PESSI');
        $cols = [
            ['sr', 'Sr', 6, 'sr'], ['code', 'ID', 10, 'text'], ['name', 'Employee Name', 34, 'name'], ['designation', 'Designation', 20, 'text'],
            ['paid_days', 'Paid Days', 9, 'days'], ['basic', $this->isDaily() ? 'Rate / Day' : 'Basic Salary', 14, 'money'],
            ['pay', 'Gross', 14, 'money'], ['ot_hours', 'OT Hour', 9, 'days'], ['ot_rate', 'OT Rate', 11, 'rate'], ['ot_amount', 'Overtime', 12, 'money'],
            ['advance', 'Advance', 12, 'money'], ['loan_deduction', 'Loan Ded.', 11, 'money'], ['loan_balance', 'Remaining Bal.', 13, 'money'],
            ['incentive', 'Incentive', 11, 'money'], ['penalty', 'Penalty', 10, 'money'], ['fine', 'Fine', 9, 'money'],
        ];
        foreach (['eobi' => 'EOBI', 'pessi' => $ss, 'income_tax' => 'Income Tax'] as $k => $label) {
            if (self::sum($this->lines(), $k) != 0.0) {
                $cols[] = [$k, $label, 10, 'money'];
            }
        }
        $cols[] = ['net_salary', 'Net Salary', 15, 'money'];
        $cols[] = ['sign', 'Signature', 22, 'sign'];
        return $cols;
    }

    private static function value(array $l, string $key): mixed
    {
        return match ($key) {
            'basic' => (float)$l['daily_rate'] > 0 && (float)$l['basic_salary'] == 0.0 ? $l['daily_rate'] : $l['basic_salary'],
            'pay' => (float)$l['work_pay'] + (float)$l['allowance_pay'], // gross before overtime (Net = Gross + Overtime + Incentive - deductions)
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
        // columns after the first four: paid days onward
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
                        'name' => '<td class="nm">' . self::e($l['name'])
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
            . ' &nbsp;·&nbsp; Bank ' . self::money($bank) . ') &nbsp;·&nbsp; Net = Gross + Overtime + Incentive − Advance − Loan − Penalty − Fine. '
            . 'Gross includes prorated allowances; Overtime includes fixed OT voucher amounts.</div>';
        $carried = array_filter($lines, fn($l) => (float)($l['advance_carried'] ?? 0) + (float)($l['penalty_carried'] ?? 0) + (float)($l['fine_carried'] ?? 0) > 0);
        if ($carried) {
            $h .= '<div class="sal-sum"><b>Carried forward to the next period</b> (salary not sufficient; net is never negative):<br>'
                . implode('<br>', array_map(fn($l) => '<b>' . self::e($l['code']) . '</b> ' . self::e($l['name']) . ': '
                    . implode(', ', array_filter([(float)$l['advance_carried'] > 0 ? 'advance ' . self::money($l['advance_carried']) : null,
                        (float)$l['penalty_carried'] > 0 ? 'penalty ' . self::money($l['penalty_carried']) : null,
                        (float)$l['fine_carried'] > 0 ? 'fine ' . self::money($l['fine_carried']) : null])), $carried)) . '</div>';
        }
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
        $out = [array_merge(array_map(fn($c) => $c[1], $cols), ['Advance carried', 'Penalty carried', 'Fine carried', 'Remarks', 'Increment in period'])];
        foreach ($this->lines() as $l) {
            $row = [];
            foreach ($cols as $c) {
                $row[] = self::value($l, $c[0]);
            }
            $out[] = array_merge($row, [$l['advance_carried'] ?? 0, $l['penalty_carried'] ?? 0, $l['fine_carried'] ?? 0, $l['remarks'], $l['increment_note'] ?? '']);
        }
        return $out;
    }
}
