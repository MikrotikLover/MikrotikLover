<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Increments;
use App\Money;

/**
 * Increment Register: increments effective in a date range, grouped by department, with the old vs new
 * salary cost per department and in total. A4 landscape, CSV.
 *   report.php?r=increment_register&from=&to=&department_id=&include_joining=1
 */
final class IncrementRegisterReport extends Report
{
    private ?array $rows = null;

    public function permission(): array
    {
        return ['employees', 'print'];
    }

    public function title(): string
    {
        return 'Increment Register';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function from(): string
    {
        return $this->qDate('from', date('Y-01-01'));
    }

    private function to(): string
    {
        return $this->qDate('to', date('Y-12-31'));
    }

    private function rows(): array
    {
        if ($this->rows === null) {
            $where = ['i.effective_date BETWEEN :f AND :t'];
            $params = ['f' => $this->from(), 't' => $this->to()];
            if ($d = $this->request->queryInt('department_id')) {
                $where[] = 'e.department_id = :d';
                $params['d'] = $d;
            }
            if (!$this->request->queryInt('include_joining')) {
                $where[] = "i.increment_type <> 'joining'";
            }
            $this->rows = Database::all(
                'SELECT i.*, e.code, e.name, e.emp_type, d.name AS department, g.name AS designation,
                        ab.full_name AS approved_by_name, cb.full_name AS created_by_name
                   FROM salary_increments i JOIN employees e ON e.id = i.employee_id
                   JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              LEFT JOIN users ab ON ab.id = i.approved_by LEFT JOIN users cb ON cb.id = i.created_by
                  WHERE ' . implode(' AND ', $where) . ' ORDER BY d.name, i.effective_date, e.code',
                $params
            );
        }
        return $this->rows;
    }

    protected function subtitle(): string
    {
        $parts = ['Effective ' . self::date($this->from()) . ' to ' . self::date($this->to())];
        if ($f = $this->filterLabel('departments', $this->request->queryInt('department_id'), 'Department')) {
            $parts[] = $f;
        }
        $parts[] = $this->request->queryInt('include_joining') ? 'Joining rows included' : 'Increments only';
        return implode(' &nbsp;|&nbsp; ', $parts);
    }

    /** "10.00%", "+5,000", "= 50,000", "Joining" */
    public static function valueLabel(array $r): string
    {
        return match ($r['increment_type']) {
            'percentage' => rtrim(rtrim(number_format((float)$r['increment_value'], 2, '.', ''), '0'), '.') . '%',
            'fixed' => '+' . number_format((float)$r['increment_value']),
            'new_salary' => '= ' . number_format((float)$r['increment_value']),
            default => '',
        };
    }

    /** Change in percent of the old salary, 2 decimals ('' when there was no old salary). */
    public static function changePct(array $r): string
    {
        $old = Money::toPaisa((string)$r['old_salary']);
        if ($old <= 0) {
            return '';
        }
        return number_format(Money::divRound((Money::toPaisa((string)$r['new_salary']) - $old) * 10000, $old) / 100, 2) . '%';
    }

    private static function sum(array $rows, string $key): int
    {
        $t = 0;
        foreach ($rows as $r) {
            $t += Money::toPaisa((string)$r[$key]);
        }
        return $t;
    }

    private function totalRow(string $class, string $label, array $rows): string
    {
        $old = self::sum($rows, 'old_salary');
        $new = self::sum($rows, 'new_salary');
        $pct = $old > 0 ? number_format(Money::divRound(($new - $old) * 10000, $old) / 100, 2) . '%' : '';
        return '<tr class="' . $class . '"><td colspan="7">' . self::e($label) . ' (' . count($rows) . ')</td>'
            . '<td class="num">' . self::money(Money::fromPaisa($old)) . '</td><td class="num">' . self::money(Money::fromPaisa($new)) . '</td>'
            . '<td class="num">' . self::money(Money::fromPaisa($new - $old)) . '</td><td class="num">' . $pct . '</td><td colspan="4"></td></tr>';
    }

    protected function body(): string
    {
        $rows = $this->rows();
        if (!$rows) {
            return '<div class="empty">No increments in this period.</div>';
        }
        $groups = [];
        foreach ($rows as $r) {
            $groups[$r['department']][] = $r;
        }
        $h = '<table class="rpt-table"><thead><tr><th>Sr</th><th>Effective</th><th>Code</th><th>Name</th><th>Designation</th><th>Type</th><th>Value</th>'
            . '<th class="num">Old Salary</th><th class="num">New Salary</th><th class="num">Increase</th><th class="num">%</th>'
            . '<th>Reason</th><th>Approved by</th><th>Entered by</th><th>Status</th></tr></thead><tbody>';
        $sr = 0;
        foreach ($groups as $dept => $list) {
            $h .= '<tr class="group"><td colspan="15">' . self::e($dept) . '</td></tr>';
            foreach ($list as $r) {
                $daily = $r['emp_type'] === 'daily_wages' ? '<small>/day</small>' : '';
                $h .= '<tr><td class="num">' . ++$sr . '</td><td>' . self::date($r['effective_date']) . '</td><td>' . self::e($r['code']) . '</td>'
                    . '<td>' . self::e($r['name']) . '</td><td>' . self::e($r['designation']) . '</td>'
                    . '<td>' . self::e(Increments::TYPES[$r['increment_type']] ?? $r['increment_type']) . '</td><td>' . self::e(self::valueLabel($r)) . '</td>'
                    . '<td class="num">' . self::money($r['old_salary']) . $daily . '</td><td class="num">' . self::money($r['new_salary']) . $daily . '</td>'
                    . '<td class="num">' . self::money(Money::fromPaisa(Money::toPaisa((string)$r['new_salary']) - Money::toPaisa((string)$r['old_salary']))) . '</td>'
                    . '<td class="num">' . self::changePct($r) . '</td><td>' . self::e($r['reason']) . '</td>'
                    . '<td>' . self::e($r['approved_by_name']) . '</td><td>' . self::e($r['created_by_name']) . '</td>'
                    . '<td>' . (Increments::status($r['effective_date']) === 'applied' ? 'Applied' : '<b>Scheduled</b>') . '</td></tr>';
            }
            $h .= $this->totalRow('subtotal', 'Sub-total ' . $dept, $list);
        }
        $h .= $this->totalRow('grandtotal', 'Grand Total', $rows) . '</tbody></table>';
        $h .= '<p style="font-size:8pt;margin-top:3mm">Old / New Salary = monthly basic (daily wages: rate per day, marked /day). '
            . 'Totals compare the salary cost before and after these increments. Department = the employee\'s current department.</p>';
        return $h;
    }

    public function csv(): array
    {
        $out = [['Department', 'Effective', 'Code', 'Name', 'Designation', 'Employee Type', 'Type', 'Value', 'Old Salary', 'New Salary', 'Increase', 'Increase %',
            'Reason', 'Approved by', 'Entered by', 'Status']];
        foreach ($this->rows() as $r) {
            $out[] = [$r['department'], $r['effective_date'], $r['code'], $r['name'], $r['designation'], $r['emp_type'],
                Increments::TYPES[$r['increment_type']] ?? $r['increment_type'], $r['increment_value'], $r['old_salary'], $r['new_salary'],
                Money::fromPaisa(Money::toPaisa((string)$r['new_salary']) - Money::toPaisa((string)$r['old_salary'])), self::changePct($r),
                $r['reason'], $r['approved_by_name'], $r['created_by_name'], Increments::status($r['effective_date'])];
        }
        return $out;
    }
}
