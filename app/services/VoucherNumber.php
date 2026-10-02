<?php
declare(strict_types=1);

/**
 * Voucher numbers per type and Pakistani fiscal year, e.g. IGP-2627-00001
 * (FY 1 Jul 2026 – 30 Jun 2027). Must be called inside the voucher's save
 * transaction: the sequence row is locked FOR UPDATE, so concurrent saves
 * wait for each other and a rolled-back save does not consume a number.
 */
final class VoucherNumber
{
    public static function fiscalYear(string $date): string
    {
        $startMonth = max(1, min(12, (int) Settings::get('fiscal_year_start_month', '7')));
        $y = (int) substr($date, 0, 4);
        $m = (int) substr($date, 5, 2);
        $startYear = $m >= $startMonth ? $y : $y - 1;
        if ($startMonth === 1) {
            return sprintf('%04d', $startYear);
        }
        return sprintf('%02d%02d', $startYear % 100, ($startYear + 1) % 100);
    }

    public static function next(string $type, string $date, ?string $prefix = null): string
    {
        $prefix ??= $type;
        $fy = self::fiscalYear($date);
        DB::query(
            'INSERT IGNORE INTO voucher_sequences (voucher_type, fiscal_year, prefix, last_no) VALUES (:t, :fy, :p, 0)',
            ['t' => $type, 'fy' => $fy, 'p' => $prefix]
        );
        $last = (int) DB::value(
            'SELECT last_no FROM voucher_sequences WHERE voucher_type = :t AND fiscal_year = :fy FOR UPDATE',
            ['t' => $type, 'fy' => $fy]
        );
        DB::query(
            'UPDATE voucher_sequences SET last_no = :n WHERE voucher_type = :t AND fiscal_year = :fy',
            ['n' => $last + 1, 't' => $type, 'fy' => $fy]
        );
        return sprintf('%s-%s-%05d', $prefix, $fy, $last + 1);
    }
}
