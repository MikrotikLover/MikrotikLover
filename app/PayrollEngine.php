<?php
declare(strict_types=1);

namespace App;

/**
 * Salary calculation for one employee and one period. Pure: no database, so every rule is unit tested
 * (tests/PayrollEngineTest.php). Data is gathered by App\Payroll.
 *
 * Permanent / contract (monthly)
 *   Paid Days      = Work Days + Rest Days + Paid Leave            (rest days include paid holidays)
 *                    With a fixed 30 / 26-day basis: Days - unpaid days (absent, leave without pay,
 *                    unmarked, unworked part of half days, days not employed), so a full month is
 *                    always the full basic and each unpaid day costs Basic / Days.
 *                    Work Days count a full present day as 1 and a half / short day by actual hours
 *                    (worked minutes / shift net minutes, max 1) - no fixed half day.
 *   Work Pay       = round(Basic / Days in Month x Paid Days)
 *   Allowance Pay  = round(Allowances / Days in Month x Paid Days)
 * Daily wages
 *   Work Pay       = round(Daily Rate x Present (work) Days)
 *   Allowance Pay  = round(Allowances / Days in Month x Present Days)
 * Both
 *   OT Rate        = override from salary info, else Basic / Days / Shift Hours x Multiplier
 *                    (daily wages: Daily Rate / Shift Hours x Multiplier)
 *   Overtime       = round(OT Hours x OT Rate) + fixed OT voucher amounts
 *   Gross          = Work Pay + Allowance Pay + Overtime
 *   Net            = Gross + Incentive - Advance - Loan - Penalty - Fine - EOBI - PESSI/SESSI - Income Tax
 *   Loan installments are reduced (carried forward) when the salary cannot cover them; other
 *   deductions are never reduced, so a negative net is flagged for review instead.
 */
final class PayrollEngine
{
    public function __construct(
        private string $rounding = 'half_up',
        private float $otMultiplier = 2.0,
        private float $defaultShiftHours = 8.0,
    ) {
    }

    public static function fromSettings(): self
    {
        return new self(
            (string)Settings::get('rounding_rule', 'half_up'),
            (float)Settings::get('ot_multiplier', 2),
            (float)Settings::get('default_shift_hours', 8),
        );
    }

    public function round(float $v): float
    {
        $v = round($v, 6); // remove float noise before deciding
        return match ($this->rounding) {
            'up'   => ceil($v),
            'down' => floor($v),
            default => $v >= 0 ? floor($v + 0.5) : -floor(-$v + 0.5),
        };
    }

    /** Days used as the divisor: actual days of the period, or a fixed 30 / 26. */
    public static function daysInMonth(string $basis, string $from, string $to): int
    {
        return match ($basis) {
            'fixed30' => 30,
            'fixed26' => 26,
            default => (int)round((strtotime($to . ' 12:00') - strtotime($from . ' 12:00')) / 86400) + 1,
        };
    }

    /** Fraction of a day paid for a half / short day = worked minutes / shift net minutes (0..1). */
    public static function dayFraction(int $workMinutes, int $shiftMinutes): float
    {
        if ($shiftMinutes <= 0) {
            return 0.0;
        }
        return round(min(1.0, max(0.0, $workMinutes / $shiftMinutes)), 2);
    }

    /** Employee share of EOBI / PESSI / SESSI for a rate row (null = not applicable). */
    public function statutory(?array $rate, float $wage): float
    {
        if (!$rate) {
            return 0.0;
        }
        $share = (float)$rate['employee_share'];
        $base = match ($rate['calc_method']) {
            'percent_of_min_wage' => (float)$rate['min_wage'],
            'percent_of_wage' => $rate['wage_ceiling'] !== null ? min($wage, (float)$rate['wage_ceiling']) : $wage,
            default => 0.0,
        };
        return $rate['calc_method'] === 'fixed' ? $this->round($share) : $this->round($base * $share / 100);
    }

    /** Annual income tax from slabs: fixed_amount + rate% x (income - income_from) of the matching slab. */
    public static function annualTax(float $annual, array $slabs): float
    {
        foreach ($slabs as $s) {
            $lo = (float)$s['income_from'];
            $hi = $s['income_to'] === null ? INF : (float)$s['income_to'];
            if ($annual > $lo && $annual <= $hi) {
                return (float)$s['fixed_amount'] + ($annual - $lo) * (float)$s['rate_percent'] / 100;
            }
        }
        return 0.0;
    }

    /**
     * @param array $in keys:
     *   type 'permanent'|'daily_wages', days (divisor), basis 'calendar'|'fixed30'|'fixed26', unpaid_days,
 *   basic, daily_rate, allowances,
     *   work_days, rest_days, paid_leave (days, may be fractional),
     *   ot_applicable (bool), ot_rate (override|null), shift_hours (|null), ot_minutes, ot_voucher_hours, ot_voucher_amount,
     *   incentive, penalty, fine, advance, loan_planned,
     *   eobi_rate (row|null), pessi_rate (row|null), tax_slabs (rows|null)
     */
    public function calculate(array $in): array
    {
        $g = fn(string $k, $d = 0) => $in[$k] ?? $d;
        $days = max(1, (int)$g('days', 30));
        $daily = $g('type') === 'daily_wages';
        $basic = (float)$g('basic');
        $rate = (float)$g('daily_rate');
        $work = round((float)$g('work_days'), 2);
        $warnings = [];

        if ($daily) {
            $paid = $work; // daily wages: paid for present days only
            $workPay = $this->round($rate * $work);
        } elseif (in_array($g('basis', 'calendar'), ['fixed30', 'fixed26'], true) && isset($in['unpaid_days'])) {
            // Fixed 30 / 26-day month: a full month earns the full basic whatever its calendar length;
            // only unpaid days (absent, leave without pay, unmarked, unworked part of half days, not
            // employed) are deducted, each worth Basic / Days.
            $paid = round(max(0.0, $days - (float)$in['unpaid_days']), 2);
            $workPay = $this->round($basic / $days * $paid);
        } else {
            $paid = round($work + (float)$g('rest_days') + (float)$g('paid_leave'), 2);
            if ($paid > $days) {
                $warnings[] = "Paid days capped at $days";
                $paid = (float)$days;
            }
            $workPay = $this->round($basic / $days * $paid);
        }
        $allowancePay = $this->round((float)$g('allowances') / $days * $paid);

        // Overtime
        $otHours = round(((int)$g('ot_minutes')) / 60 + (float)$g('ot_voucher_hours'), 2);
        $shiftHours = (float)($g('shift_hours') ?: $this->defaultShiftHours);
        $override = $in['ot_rate'] ?? null; // null / '' = calculate from basic (or daily rate)
        if ($override !== null && $override !== '') {
            $otRate = round((float)$override, 2);
        } else {
            $otRate = $daily
                ? round($rate / $shiftHours * $this->otMultiplier, 2)
                : round($basic / $days / $shiftHours * $this->otMultiplier, 2);
        }
        if (!$g('ot_applicable', true)) {
            if ($otHours > 0 || (float)$g('ot_voucher_amount') > 0) {
                $warnings[] = 'OT not applicable: ' . $otHours . ' h not paid';
            }
            $otHours = 0.0;
            $otAmount = 0.0;
            $otVoucherAmount = 0.0;
        } else {
            $otVoucherAmount = $this->round((float)$g('ot_voucher_amount'));
            $otAmount = $this->round($otHours * $otRate) + $otVoucherAmount;
        }

        $gross = $workPay + $allowancePay + $otAmount;
        $incentive = $this->round((float)$g('incentive'));
        $eobi = $paid > 0 ? $this->statutory($g('eobi_rate', null), $gross) : 0.0;
        $pessi = $paid > 0 ? $this->statutory($g('pessi_rate', null), $gross) : 0.0;
        $tax = 0.0;
        if ($g('tax_slabs', null)) {
            $tax = $this->round(self::annualTax(($gross + $incentive) * 12, $g('tax_slabs')) / 12);
        }
        $advance = $this->round((float)$g('advance'));
        $penalty = $this->round((float)$g('penalty'));
        $fine = $this->round((float)$g('fine'));
        $loanPlanned = $this->round((float)$g('loan_planned'));

        $beforeLoan = $gross + $incentive - $advance - $penalty - $fine - $eobi - $pessi - $tax;
        $loan = min($loanPlanned, max(0.0, $beforeLoan));
        if ($loan < $loanPlanned) {
            $warnings[] = 'Loan installment reduced to ' . number_format($loan) . ' (balance carried forward)';
        }
        $net = $beforeLoan - $loan;
        if ($net < 0) {
            $warnings[] = 'Net salary is negative: ' . number_format(-$net) . ' stays owed (booked to Employee Advances on posting) — recover it with an advance voucher next month';
        }
        if ($paid <= 0 && $gross <= 0) {
            $warnings[] = 'No paid days in this period';
        }

        return [
            'paid_days' => $paid, 'work_pay' => $workPay, 'allowance_pay' => $allowancePay,
            'ot_hours' => $otHours, 'ot_rate' => $otRate, 'ot_amount' => $otAmount, 'ot_voucher_amount' => $otVoucherAmount,
            'gross' => $gross, 'incentive' => $incentive, 'advance' => $advance, 'penalty' => $penalty, 'fine' => $fine,
            'eobi' => $eobi, 'pessi' => $pessi, 'income_tax' => $tax, 'loan_deduction' => $loan, 'net_salary' => $net,
            'warnings' => $warnings,
        ];
    }
}
