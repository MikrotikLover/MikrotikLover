<?php
declare(strict_types=1);

namespace App\Reports;

use App\Settings;

/** Department salary summary: head count, gross, each deduction and net per department. */
final class DepartmentSalaryReport extends SalaryReport
{
    private const COLS = [
        'work' => 'Work Pay', 'ot_amount' => 'Overtime', 'gross' => 'Gross', 'incentive' => 'Incentive', 'advance' => 'Advance',
        'loan_deduction' => 'Loan', 'penalty' => 'Penalty + Fine', 'eobi' => 'EOBI', 'pessi' => 'PESSI', 'income_tax' => 'Income Tax', 'net_salary' => 'Net Salary',
    ];

    public function title(): string
    {
        return 'Department Salary Summary';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function headers(): array
    {
        return array_merge(self::COLS, ['pessi' => (string)Settings::get('social_security', 'PESSI')]);
    }

    private function summary(): array
    {
        $rows = [];
        foreach ($this->byDepartment() as $dept => $lines) {
            $r = ['department' => $dept, 'employees' => count($lines), 'cash' => 0.0, 'bank' => 0.0];
            foreach (array_keys(self::COLS) as $k) {
                $r[$k] = match ($k) {
                    'work' => self::sum($lines, 'work_pay') + self::sum($lines, 'allowance_pay'),
                    'penalty' => self::sum($lines, 'penalty') + self::sum($lines, 'fine'),
                    default => self::sum($lines, $k),
                };
            }
            foreach ($lines as $l) {
                $r[$l['payment_mode'] === 'bank' ? 'bank' : 'cash'] += (float)$l['net_salary'];
            }
            $rows[] = $r;
        }
        return $rows;
    }

    protected function body(): string
    {
        $rows = $this->summary();
        if (!$rows) {
            return $this->emptyMsg();
        }
        $heads = $this->headers();
        $h = '<table class="rpt-table"><thead><tr><th>Department</th><th class="num">Employees</th>';
        foreach ($heads as $t) {
            $h .= '<th class="num">' . self::e($t) . '</th>';
        }
        $h .= '<th class="num">Cash</th><th class="num">Bank</th></tr></thead><tbody>';
        $tot = array_fill_keys(array_merge(['employees', 'cash', 'bank'], array_keys(self::COLS)), 0.0);
        foreach ($rows as $r) {
            $h .= '<tr><td>' . self::e($r['department']) . '</td><td class="num">' . $r['employees'] . '</td>';
            foreach (array_keys(self::COLS) as $k) {
                $h .= '<td class="num">' . self::money($r[$k]) . '</td>';
            }
            $h .= '<td class="num">' . self::money($r['cash']) . '</td><td class="num">' . self::money($r['bank']) . '</td></tr>';
            foreach ($tot as $k => $_) {
                $tot[$k] += $r[$k];
            }
        }
        $h .= '<tr class="grandtotal"><td>Grand Total</td><td class="num">' . (int)$tot['employees'] . '</td>';
        foreach (array_keys(self::COLS) as $k) {
            $h .= '<td class="num">' . self::money($tot[$k]) . '</td>';
        }
        return $h . '<td class="num">' . self::money($tot['cash']) . '</td><td class="num">' . self::money($tot['bank']) . '</td></tr></tbody></table>';
    }

    public function csv(): array
    {
        $heads = $this->headers();
        $out = [array_merge(['Department', 'Employees'], array_values($heads), ['Cash', 'Bank'])];
        foreach ($this->summary() as $r) {
            $row = [$r['department'], $r['employees']];
            foreach (array_keys(self::COLS) as $k) {
                $row[] = $r[$k];
            }
            $out[] = array_merge($row, [$r['cash'], $r['bank']]);
        }
        return $out;
    }
}
