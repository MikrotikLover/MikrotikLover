<?php
declare(strict_types=1);

namespace App\Reports;

use App\Database;
use App\Vouchers;

/**
 * DayBook: every voucher in a date range, by date. Accounting vouchers (ADV, LOAN, JV) show their
 * debit / credit lines; payroll adjustments (INC, PEN, OT) show their amount in the "Salary adj."
 * column (they reach the books through the salary JV).
 */
final class DayBookReport extends Report
{
    private ?array $data = null;

    public function permission(): array
    {
        return ['vouchers', 'print'];
    }

    public function title(): string
    {
        return 'Day Book';
    }

    public function orientation(): string
    {
        return 'landscape';
    }

    public function supportsCsv(): bool
    {
        return true;
    }

    /** Salary adjustment: deductions in brackets. */
    private static function adj(float $v): string
    {
        return $v < 0 ? '(' . self::money(-$v) . ')' : self::money($v);
    }

    private function types(): array
    {
        $t = array_filter(array_map('strtoupper', explode(',', (string)$this->request->query('types', ''))), fn($x) => isset(Vouchers::TYPES[$x]));
        return $t ?: array_keys(Vouchers::TYPES);
    }

    private function dataset(): array
    {
        if ($this->data !== null) {
            return $this->data;
        }
        $types = $this->types();
        $ph = [];
        $params = ['f' => $this->qDate('from', date('Y-m-d')), 't' => $this->qDate('to', date('Y-m-d'))];
        foreach ($types as $i => $t) {
            $ph[] = ":ty$i";
            $params["ty$i"] = $t;
        }
        $where = ['v.deleted_at IS NULL', 'v.vr_date BETWEEN :f AND :t', 'v.voucher_type IN (' . implode(',', $ph) . ')'];
        if ($this->request->query('include_drafts') !== '1') {
            $where[] = "v.status = 'posted'";
        }
        $vouchers = Database::all(
            'SELECT v.*, e.code, e.name FROM vouchers v LEFT JOIN employees e ON e.id = v.employee_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY v.vr_date, v.voucher_type, v.vr_no',
            $params
        );
        $lines = [];
        if ($vouchers) {
            $ids = implode(',', array_map(fn($v) => (int)$v['id'], $vouchers));
            foreach (Database::all("SELECT j.voucher_id, a.code, a.name, j.debit, j.credit, j.narration FROM journal_entries j
                                      JOIN accounts a ON a.id = j.account_id WHERE j.voucher_id IN ($ids) ORDER BY j.voucher_id, j.line_no") as $l) {
                $lines[(int)$l['voucher_id']][] = $l;
            }
        }
        return $this->data = ['vouchers' => $vouchers, 'lines' => $lines];
    }

    protected function subtitle(): string
    {
        $types = $this->types();
        return 'Period: ' . self::date($this->qDate('from', date('Y-m-d'))) . ' to ' . self::date($this->qDate('to', date('Y-m-d')))
            . ' &nbsp;|&nbsp; ' . (count($types) === count(Vouchers::TYPES) ? 'All voucher types' : self::e(implode(', ', array_map([Vouchers::class, 'label'], $types))))
            . ($this->request->query('include_drafts') === '1' ? ' &nbsp;|&nbsp; including drafts' : '');
    }

    protected function body(): string
    {
        $d = $this->dataset();
        if (!$d['vouchers']) {
            return '<p class="empty">No vouchers in this period.</p>';
        }
        $h = '<table class="rpt-table"><thead><tr><th>Type</th><th>Vr#</th><th>Employee</th><th>Account / Particulars</th>'
            . '<th class="num">Debit</th><th class="num">Credit</th><th class="num">Salary adj.</th><th>Status</th></tr></thead><tbody>';
        $date = null;
        $day = ['dr' => 0, 'cr' => 0, 'adj' => 0];
        $grand = $day;
        $byType = [];
        $flush = function () use (&$h, &$date, &$day) {
            if ($date !== null) {
                $h .= '<tr class="subtotal"><td colspan="4">Total ' . self::date($date) . '</td><td class="num">' . self::money($day['dr']) . '</td><td class="num">'
                    . self::money($day['cr']) . '</td><td class="num">' . self::adj($day['adj']) . '</td><td></td></tr>';
            }
        };
        foreach ($d['vouchers'] as $v) {
            if ($v['vr_date'] !== $date) {
                $flush();
                $date = $v['vr_date'];
                $day = ['dr' => 0, 'cr' => 0, 'adj' => 0];
                $h .= '<tr class="group"><td colspan="8">' . date('l, d F Y', strtotime($date)) . '</td></tr>';
            }
            $byType[$v['voucher_type']] = ($byType[$v['voucher_type']] ?? 0) + (float)$v['amount'];
            $num = self::e(Vouchers::number($v['voucher_type'], $v['vr_no']));
            $emp = self::e(trim(($v['code'] ?? '') . ' ' . ($v['name'] ?? '')));
            $status = ucfirst($v['status']) . ($v['is_system'] ? ' (system)' : '');
            $vl = $d['lines'][(int)$v['id']] ?? [];
            if ($vl) {
                foreach ($vl as $i => $l) {
                    $day['dr'] += (float)$l['debit'];
                    $day['cr'] += (float)$l['credit'];
                    $grand['dr'] += (float)$l['debit'];
                    $grand['cr'] += (float)$l['credit'];
                    $h .= '<tr><td>' . ($i ? '' : self::e(Vouchers::label($v['voucher_type']))) . '</td><td class="nowrap">' . ($i ? '' : $num) . '</td><td>'
                        . ($i ? '' : $emp) . '</td><td' . ((float)$l['credit'] > 0 ? ' style="padding-left:16px"' : '') . '>' . self::e($l['code'] . ' ' . $l['name'])
                        . ($i === 0 && $v['remarks'] ? ' <small>— ' . self::e($v['remarks']) . '</small>' : '') . '</td><td class="num">'
                        . ((float)$l['debit'] ? self::money($l['debit']) : '') . '</td><td class="num">' . ((float)$l['credit'] ? self::money($l['credit']) : '')
                        . '</td><td></td><td>' . ($i ? '' : self::e($status)) . '</td></tr>';
                }
            } else {
                $adj = in_array($v['voucher_type'], ['PEN'], true) ? -(float)$v['amount'] : (float)$v['amount'];
                $day['adj'] += $adj;
                $grand['adj'] += $adj;
                $part = $v['voucher_type'] === 'OT' && (float)$v['ot_hours'] ? rtrim(rtrim((string)$v['ot_hours'], '0'), '.') . ' OT hours' : '';
                $h .= '<tr><td>' . self::e(Vouchers::label($v['voucher_type'])) . '</td><td class="nowrap">' . $num . '</td><td>' . $emp . '</td><td>'
                    . self::e(trim('Salary ' . ($v['deduct_month'] ? date('M Y', strtotime($v['deduct_month'])) : '') . ' ' . $part . ($v['remarks'] ? ' — ' . $v['remarks'] : '')))
                    . '</td><td></td><td></td><td class="num">' . ($adj == 0 && $part !== '' ? 'hours' : self::adj($adj)) . '</td><td>' . self::e($status) . '</td></tr>';
            }
        }
        $flush();
        $h .= '</tbody><tfoot><tr class="grandtotal"><td colspan="4">Grand Total</td><td class="num">' . self::money($grand['dr']) . '</td><td class="num">'
            . self::money($grand['cr']) . '</td><td class="num">' . self::adj($grand['adj']) . '</td><td></td></tr></tfoot></table>';
        $sum = '<table class="rpt-table" style="width:auto;margin-top:8px"><tr><th>Summary by type</th><th class="num">Vouchers total</th></tr>';
        foreach ($byType as $t => $amt) {
            $sum .= '<tr><td>' . self::e(Vouchers::label($t)) . '</td><td class="num">' . self::money($amt) . '</td></tr>';
        }
        return $h . $sum . '</table><p style="font-size:7.5pt">Salary adj.: incentives / overtime added, (penalties) deducted in the salary of the month shown; booked through the salary JV. &quot;hours&quot; = OT hours paid at the employee&#39;s OT rate.</p>';
    }

    public function csv(): array
    {
        $d = $this->dataset();
        $out = [['Date', 'Type', 'Vr#', 'Employee Code', 'Employee', 'Account', 'Debit', 'Credit', 'Salary Adjustment', 'Salary Month', 'Status', 'Remarks']];
        foreach ($d['vouchers'] as $v) {
            $vl = $d['lines'][(int)$v['id']] ?? [];
            $base = [$v['vr_date'], Vouchers::label($v['voucher_type']), Vouchers::number($v['voucher_type'], $v['vr_no']), $v['code'], $v['name']];
            if ($vl) {
                foreach ($vl as $l) {
                    $out[] = [...$base, $l['code'] . ' ' . $l['name'], $l['debit'], $l['credit'], '', '', $v['status'], $v['remarks']];
                }
            } else {
                $out[] = [...$base, '', '', '', $v['voucher_type'] === 'PEN' ? -(float)$v['amount'] : $v['amount'], substr((string)$v['deduct_month'], 0, 7), $v['status'], $v['remarks']];
            }
        }
        return $out;
    }
}
