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
 * Increments (salary_increments): the period is split into segments at each effective date and every
 *   segment pays (segment salary / Days in Month) x its own paid days (absent / leave / half days counted
 *   per segment). Daily wages: segment rate x segment present days.
 * Both
 *   OT Rate        = override from salary info, else Salary / (Days x Shift Hours) x Multiplier, using
 *                    the salary effective on each OT date (daily wages: Daily Rate / Shift Hours x Multiplier)
 *   Overtime       = round(sum of OT Hours x OT Rate per rate) + fixed OT voucher amounts
 *   Work pay and overtime are computed in integer paisa (App\Money), never float.
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

    /** Legacy numeric input (float / int / string) -> 2-decimal string for paisa maths. */
    private static function amount(mixed $v): string
    {
        if (is_string($v) && preg_match('/^-?\d+(\.\d{1,2})?$/', $v)) {
            return $v;
        }
        return number_format((float)$v, 2, '.', '');
    }

    /** Day / hour count with 2 decimals -> integer hundredths. */
    private static function hundredths(float $v): int
    {
        return (int)round($v * 100);
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
     *   segments  (optional) [{salary, work_days, rest_days, paid_leave, unpaid_days, len}] one per salary
     *             period inside the sheet; salary = monthly basic (daily wages: rate per day) as a decimal string
     *   ot_items  (optional) [{minutes, hours, salary}] OT minutes / voucher hours with the salary of their date
     *   Without segments / ot_items the single basic (daily_rate) is used, as before.
     */
    public function calculate(array $in): array
    {
        $g = fn(string $k, $d = 0) => $in[$k] ?? $d;
        $days = max(1, (int)$g('days', 30));
        $daily = $g('type') === 'daily_wages';
        $work = round((float)$g('work_days'), 2);
        $warnings = [];

        // Salary segments: the period split at increment effective dates (one segment when the salary did
        // not change). Each segment pays (segment salary / days in month) x its own paid days.
        $segments = $in['segments'] ?? [[
            'salary' => self::amount($daily ? $g('daily_rate') : $g('basic')),
            'work_days' => $work, 'rest_days' => (float)$g('rest_days'), 'paid_leave' => (float)$g('paid_leave'),
            'unpaid_days' => (float)$g('unpaid_days'), 'len' => $days,
        ]];
        $fixed = !$daily && in_array($g('basis', 'calendar'), ['fixed30', 'fixed26'], true) && (isset($in['unpaid_days']) || isset($in['segments']));
        $segPaid = []; // paid days per segment, in hundredths
        foreach ($segments as $s) {
            if ($daily) {
                $segPaid[] = self::hundredths((float)$s['work_days']); // daily wages: present days only
            } elseif ($fixed) {
                // Fixed 30 / 26-day month: a full month earns the full basic whatever its calendar length;
                // only unpaid days (absent, leave without pay, unmarked, unworked part of half days, not
                // employed) are deducted, each worth Basic / Days.
                $segPaid[] = self::hundredths((float)$s['len'] - (float)$s['unpaid_days']);
            } else {
                $segPaid[] = self::hundredths((float)$s['work_days'] + (float)$s['rest_days'] + (float)$s['paid_leave']);
            }
        }
        $cap = $days * 100;
        if ($fixed) {
            // the divisor (30 / 26) differs from the calendar length: the last segment absorbs the difference
            $segPaid[count($segPaid) - 1] += $cap - self::hundredths(array_sum(array_map(fn($s) => (float)$s['len'], $segments)));
            $segPaid = array_map(fn($p) => max(0, $p), $segPaid);
            for ($i = count($segPaid) - 1, $over = array_sum($segPaid) - $cap; $i >= 0 && $over > 0; $i--) {
                $cut = min($over, $segPaid[$i]);
                $segPaid[$i] -= $cut;
                $over -= $cut;
            }
        } elseif (!$daily && array_sum($segPaid) > $cap) {
            $warnings[] = "Paid days capped at $days";
            for ($i = count($segPaid) - 1, $over = array_sum($segPaid) - $cap; $i >= 0 && $over > 0; $i--) {
                $cut = min($over, $segPaid[$i]);
                $segPaid[$i] -= $cut;
                $over -= $cut;
            }
        }
        $num = 0; // sum of salary(paisa) x paid days(hundredths)
        foreach ($segments as $i => $s) {
            $num += Money::toPaisa($s['salary']) * $segPaid[$i];
        }
        $paid = array_sum($segPaid) / 100.0;
        $workPay = (float)Money::divRound($num, ($daily ? 1 : $days) * 100 * 100, $this->rounding);
        $allowancePay = $this->round((float)$g('allowances') / $days * $paid);

        // Overtime: each OT date is priced with the salary effective on that date
        //   rate/hour = salary / (days x shift hours) x multiplier   (daily wages: rate / shift hours x multiplier)
        $shiftMinutes = (int)round((float)($g('shift_hours') ?: $this->defaultShiftHours) * 60);
        $mult = (int)round($this->otMultiplier * 100);
        $items = $in['ot_items'] ?? [['minutes' => (int)$g('ot_minutes'), 'hours' => (float)$g('ot_voucher_hours'),
            'salary' => self::amount($daily ? $g('daily_rate') : $g('basic'))]];
        $override = $in['ot_rate'] ?? null; // null / '' = calculate from the salary
        $rateOf = fn($salary) => $override !== null && $override !== ''
            ? Money::toPaisa(self::amount($override))
            : Money::divRound(Money::toPaisa(self::amount($salary)) * $mult * 60, ($daily ? 1 : $days) * max(1, $shiftMinutes) * 100);
        $groups = []; // rate paisa => hours (hundredths)
        foreach ($items as $it) {
            $hrs = Money::divRound((int)($it['minutes'] ?? 0) * 100, 60) + self::hundredths((float)($it['hours'] ?? 0));
            if ($hrs > 0) {
                $rp = $rateOf($it['salary']);
                $groups[$rp] = ($groups[$rp] ?? 0) + $hrs;
            }
        }
        $hoursH = array_sum($groups);
        $otNum = 0;
        foreach ($groups as $rp => $hh) {
            $otNum += $rp * $hh;
        }
        $otRate = match (true) {
            count($groups) > 1 => Money::divRound($otNum, $hoursH) / 100.0, // blended: OT hours x OT rate = OT amount on print
            count($groups) === 1 => array_key_first($groups) / 100.0,
            default => $rateOf($items ? end($items)['salary'] : 0) / 100.0,  // no OT: rate shown for reference
        };
        $otHours = $hoursH / 100.0;
        $otRates = [];
        krsort($groups);
        foreach ($groups as $rp => $hh) {
            $otRates[] = ['rate' => $rp / 100.0, 'hours' => $hh / 100.0];
        }
        if (!$g('ot_applicable', true)) {
            if ($otHours > 0 || (float)$g('ot_voucher_amount') > 0) {
                $warnings[] = 'OT not applicable: ' . $otHours . ' h not paid';
            }
            $otHours = 0.0;
            $otAmount = 0.0;
            $otVoucherAmount = 0.0;
            $otRates = [];
        } else {
            $otVoucherAmount = $this->round((float)$g('ot_voucher_amount'));
            $otAmount = (float)Money::divRound($otNum, 100 * 100, $this->rounding) + $otVoucherAmount;
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
            'ot_hours' => $otHours, 'ot_rate' => $otRate, 'ot_amount' => $otAmount, 'ot_voucher_amount' => $otVoucherAmount, 'ot_rates' => $otRates,
            'segment_paid_days' => array_map(fn($p) => $p / 100.0, $segPaid),
            'gross' => $gross, 'incentive' => $incentive, 'advance' => $advance, 'penalty' => $penalty, 'fine' => $fine,
            'eobi' => $eobi, 'pessi' => $pessi, 'income_tax' => $tax, 'loan_deduction' => $loan, 'net_salary' => $net,
            'warnings' => $warnings,
        ];
    }
}
