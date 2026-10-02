<?php
declare(strict_types=1);

namespace App;

/**
 * Loan installment schedule (pure functions, no database).
 *
 * A schedule is a list of months starting at the loan's start month. Some months are "fixed":
 *   deducted  - payroll already deducted `amount`
 *   adjusted  - operator changed this month's installment to `amount` (may be more or less)
 *   skipped   - nothing is deducted this month
 * Every other month gets the normal installment until the balance is fully covered; the last
 * installment is the remainder. Skipping or adjusting a month therefore pushes the balance to
 * later months automatically.
 */
final class LoanSchedule
{
    /**
     * @param array<string,array{status:string,amount:float}> $fixed keyed by 'Y-m-01'
     * @return list<array{month:string,amount:float,status:string}>
     */
    public static function build(float $amount, float $installment, string $startMonth, array $fixed = []): array
    {
        if ($amount <= 0 || $installment <= 0) {
            throw new \InvalidArgumentException('Amount and installment must be positive.');
        }
        $remaining = round($amount, 2);
        foreach ($fixed as $f) {
            if ($f['status'] !== 'skipped') {
                $remaining = round($remaining - (float)$f['amount'], 2);
            }
        }
        if ($remaining < -0.001) {
            throw new \InvalidArgumentException('Fixed installments exceed the loan amount.');
        }
        $out = [];
        $month = self::month($startMonth);
        $lastFixed = $fixed ? max(array_keys($fixed)) : $month;
        $guard = 0;
        while (($remaining > 0.001 || $month <= $lastFixed) && $guard++ < 600) {
            if (isset($fixed[$month])) {
                $out[] = ['month' => $month, 'amount' => (float)$fixed[$month]['amount'], 'status' => $fixed[$month]['status']];
            } elseif ($remaining > 0.001) {
                $amt = min($installment, $remaining);
                $remaining = round($remaining - $amt, 2);
                $out[] = ['month' => $month, 'amount' => $amt, 'status' => 'scheduled'];
            }
            $month = self::addMonths($month, 1);
        }
        return $out;
    }

    public static function month(string $date): string
    {
        return date('Y-m-01', strtotime(substr($date, 0, 7) . '-01'));
    }

    public static function addMonths(string $month, int $n): string
    {
        return date('Y-m-01', strtotime(self::month($month) . " +$n month"));
    }

    /** Number of normal installments for amount / installment. */
    public static function count(float $amount, float $installment): int
    {
        return (int)ceil(round($amount / $installment, 6));
    }
}
