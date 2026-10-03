<?php
declare(strict_types=1);

namespace App;

/**
 * PKR helpers: amount in words using the Pakistani numbering system (thousand, lakh, crore), and exact
 * integer-paisa arithmetic (1 rupee = 100 paisa) so salary maths never goes through float.
 */
final class Money
{
    /** Decimal string with at most 2 places, e.g. "45000", "45000.5", "1250.75" (no sign, no commas). */
    public const DECIMAL_REGEX = '/^\d{1,10}(\.\d{1,2})?$/';

    /** "45000.50" / "45000" / int -> 4500050 paisa. Parses the string exactly (never via float). */
    public static function toPaisa(string|int $amount): int
    {
        if (is_int($amount)) {
            return $amount * 100;
        }
        $s = trim($amount);
        $neg = str_starts_with($s, '-');
        if ($neg) {
            $s = substr($s, 1);
        }
        if (!preg_match('/^(\d+)(?:\.(\d{1,2}))?$/', $s, $m)) { // at most 2 decimals: never truncate silently
            throw new \InvalidArgumentException("Invalid amount: $amount");
        }
        $p = (int)$m[1] * 100 + (int)str_pad($m[2] ?? '0', 2, '0');
        return $neg ? -$p : $p;
    }

    /** 4500050 -> "45000.50" (DECIMAL(12,2) string). */
    public static function fromPaisa(int $paisa): string
    {
        $sign = $paisa < 0 ? '-' : '';
        $a = abs($paisa);
        return $sign . intdiv($a, 100) . '.' . str_pad((string)($a % 100), 2, '0', STR_PAD_LEFT);
    }

    /**
     * Integer division with rounding: half_up (half away from zero), up (ceiling) or down (floor).
     * Used for every rupee / paisa result so rounding never depends on float representation.
     */
    public static function divRound(int $num, int $den, string $mode = 'half_up'): int
    {
        if ($den === 0) {
            throw new \DivisionByZeroError('divRound by zero');
        }
        if ($den < 0) {
            [$num, $den] = [-$num, -$den];
        }
        $q = intdiv($num, $den);   // truncates toward zero
        $r = $num % $den;          // same sign as $num
        if ($r === 0) {
            return $q;
        }
        return match ($mode) {
            'up'   => $num > 0 ? $q + 1 : $q,
            'down' => $num > 0 ? $q : $q - 1,
            default => 2 * abs($r) >= $den ? ($num > 0 ? $q + 1 : $q - 1) : $q,
        };
    }

    /** Paisa rounded to whole rupees, returned in paisa (e.g. 4500050 -> 4500100). */
    public static function roundRupees(int $paisa, string $mode = 'half_up'): int
    {
        return self::divRound($paisa, 100, $mode) * 100;
    }

    private const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
        'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    private const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    /** e.g. 125000 -> "Rupees One Lakh Twenty-Five Thousand Only" (whole rupees) */
    public static function words(float|int|string $amount): string
    {
        $n = (int)round((float)$amount);
        if ($n === 0) {
            return 'Rupees Zero Only';
        }
        return ($n < 0 ? 'Minus ' : '') . 'Rupees ' . self::spell(abs($n)) . ' Only';
    }

    private static function spell(int $n): string
    {
        $parts = [];
        foreach ([[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand'], [100, 'Hundred']] as [$div, $name]) {
            if ($n >= $div) {
                $q = intdiv($n, $div);
                $parts[] = ($q > 99 ? self::spell($q) : self::belowHundred($q)) . ' ' . $name;
                $n %= $div;
            }
        }
        if ($n > 0) {
            $parts[] = self::belowHundred($n);
        }
        return implode(' ', $parts);
    }

    private static function belowHundred(int $n): string
    {
        if ($n < 20) {
            return self::ONES[$n];
        }
        return self::TENS[intdiv($n, 10)] . ($n % 10 ? '-' . self::ONES[$n % 10] : '');
    }
}
