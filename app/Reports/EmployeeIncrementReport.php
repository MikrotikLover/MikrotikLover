<?php
declare(strict_types=1);

namespace App\Reports;

use App\ApiException;
use App\Database;
use App\Increments;
use App\Money;

/**
 * Employee Increment History: one employee's salary timeline from joining. A4 portrait, CSV.
 *   report.php?r=employee_increments&employee_id=|code=
 */
final class EmployeeIncrementReport extends Report
{
    private ?array $emp = null;

    public function permission(): array
    {
        return ['employees', 'print'];
    }

    public function title(): string
    {
        return 'Employee Increment History';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    private function employee(): array
    {
        if ($this->emp === null) {
            $id = $this->request->queryInt('employee_id');
            $code = (string)$this->request->query('code', '');
            $sql = 'SELECT e.*, d.name AS department, g.name AS designation FROM employees e
                      JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id WHERE ';
            $this->emp = ($id ? Database::one($sql . 'e.id = ?', [$id]) : ($code !== '' ? Database::one($sql . 'e.code = ?', [$code]) : null))
                ?? throw ApiException::notFound('Employee');
        }
        return $this->emp;
    }

    /** Oldest first (a timeline). */
    private function rows(): array
    {
        return array_reverse(Increments::history((int)$this->employee()['id']));
    }

    protected function subtitle(): string
    {
        $e = $this->employee();
        return '<b>' . self::e($e['code'] . ' — ' . $e['name']) . '</b> &nbsp;|&nbsp; ' . self::e($e['department'] . ' / ' . $e['designation'])
            . ' &nbsp;|&nbsp; Joined ' . self::date($e['joining_date']) . ($e['leaving_date'] ? ' · Left ' . self::date($e['leaving_date']) : '');
    }

    protected function body(): string
    {
        $e = $this->employee();
        $rows = $this->rows();
        $daily = $e['emp_type'] === 'daily_wages';
        $unit = $daily ? ' per day' : ' per month';
        $current = Increments::getSalaryOnDate((int)$e['id'], date('Y-m-d'));
        $h = '<table class="rpt-table" style="margin-bottom:4mm;width:auto"><tbody>'
            . '<tr><td>Current salary (' . self::date(date('Y-m-d')) . ')</td><td class="num"><b>Rs. ' . self::money($current) . '</b>' . self::e($unit) . '</td></tr>';
        if ($rows) {
            $first = $rows[0];
            $h .= '<tr><td>Joining salary (' . self::date($first['effective_date']) . ')</td><td class="num">Rs. ' . self::money($first['new_salary']) . '</td></tr>';
            $firstP = Money::toPaisa((string)$first['new_salary']);
            if ($firstP > 0) {
                $h .= '<tr><td>Total change since joining</td><td class="num">Rs. ' . self::money(Money::fromPaisa(Money::toPaisa($current) - $firstP))
                    . ' (' . number_format(Money::divRound((Money::toPaisa($current) - $firstP) * 10000, $firstP) / 100, 2) . '%)</td></tr>';
            }
            $scheduled = array_filter($rows, fn($r) => $r['status'] === 'scheduled');
            foreach ($scheduled as $s) {
                $h .= '<tr><td>Scheduled from ' . self::date($s['effective_date']) . '</td><td class="num">Rs. ' . self::money($s['new_salary']) . '</td></tr>';
            }
        }
        $h .= '</tbody></table>';
        if (!$rows) {
            return $h . '<div class="empty">No salary records.</div>';
        }
        $h .= '<table class="rpt-table"><thead><tr><th>#</th><th>Effective</th><th>Type</th><th>Value</th><th class="num">Old Salary</th>'
            . '<th class="num">New Salary</th><th class="num">Change</th><th class="num">%</th><th>Reason</th><th>Approved by</th><th>Entered by</th><th>Status</th></tr></thead><tbody>';
        foreach ($rows as $i => $r) {
            $joining = $r['increment_type'] === 'joining';
            $h .= '<tr><td class="num">' . ($i + 1) . '</td><td>' . self::date($r['effective_date']) . '</td>'
                . '<td>' . self::e(Increments::TYPES[$r['increment_type']]) . '</td><td>' . self::e(IncrementRegisterReport::valueLabel($r)) . '</td>'
                . '<td class="num">' . ($joining ? '' : self::money($r['old_salary'])) . '</td><td class="num"><b>' . self::money($r['new_salary']) . '</b></td>'
                . '<td class="num">' . ($joining ? '' : self::money(Money::fromPaisa(Money::toPaisa((string)$r['new_salary']) - Money::toPaisa((string)$r['old_salary'])))) . '</td>'
                . '<td class="num">' . ($joining ? '' : IncrementRegisterReport::changePct($r)) . '</td>'
                . '<td>' . self::e($r['reason']) . '</td><td>' . self::e($r['approved_by_name']) . '</td><td>' . self::e($r['created_by_name']) . '</td>'
                . '<td>' . ($r['status'] === 'applied' ? 'Applied' : '<b>Scheduled</b>') . '</td></tr>';
        }
        $h .= '</tbody></table><p style="font-size:8pt;margin-top:3mm">Salary = ' . ($daily ? 'rate per day (daily wages)' : 'monthly basic salary')
            . '. Each increment applies from its effective date; payroll splits a month at that date.</p>';
        return $h;
    }

    public function csv(): array
    {
        $e = $this->employee();
        $out = [['Code', 'Name', 'Effective', 'Type', 'Value', 'Old Salary', 'New Salary', 'Change', 'Change %', 'Reason', 'Approved by', 'Entered by', 'Status']];
        foreach ($this->rows() as $r) {
            $out[] = [$e['code'], $e['name'], $r['effective_date'], Increments::TYPES[$r['increment_type']], $r['increment_value'], $r['old_salary'],
                $r['new_salary'], Money::fromPaisa(Money::toPaisa((string)$r['new_salary']) - Money::toPaisa((string)$r['old_salary'])),
                IncrementRegisterReport::changePct($r), $r['reason'], $r['approved_by_name'], $r['created_by_name'], $r['status']];
        }
        return $out;
    }
}
