<?php
declare(strict_types=1);

namespace Prod;

final class Text
{
    /** Trims and collapses runs of whitespace (incl. non-breaking spaces): "Bana Dora " -> "Bana Dora". */
    public static function clean(mixed $s): string
    {
        $s = preg_replace('/[\s\x{00A0}]+/u', ' ', (string)$s) ?? (string)$s;
        return trim($s);
    }

    /** Key used to match names the database collation treats as equal ("MS" = "Ms"). */
    public static function key(string $s): string
    {
        return mb_strtolower(self::clean($s));
    }

    /**
     * Number from a cell: accepts 5.19, "5.19", "1,200". Returns null for empty / non-numeric.
     */
    public static function number(mixed $v): ?float
    {
        if (is_int($v) || is_float($v)) {
            return (float)$v;
        }
        $s = str_replace([',', ' '], '', self::clean($v));
        return ($s !== '' && is_numeric($s)) ? (float)$s : null;
    }

    /** Numbers read from Excel come as 2153.0 -> "2153"; text stays as is. */
    public static function code(mixed $v): string
    {
        if (is_float($v) && floor($v) === $v && abs($v) < 1e15) {
            return (string)(int)$v;
        }
        if (is_float($v)) {
            return rtrim(rtrim(sprintf('%.6F', $v), '0'), '.');
        }
        return self::clean($v);
    }

    /** Valid Y-m-d string or null. */
    public static function date(mixed $v): ?string
    {
        $s = self::clean($v);
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $s, $m) || !checkdate((int)$m[2], (int)$m[3], (int)$m[1])) {
            return null;
        }
        return $s;
    }
}
