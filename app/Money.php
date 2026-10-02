<?php
declare(strict_types=1);

namespace App;

/** PKR helpers: amount in words using the Pakistani numbering system (thousand, lakh, crore). */
final class Money
{
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
