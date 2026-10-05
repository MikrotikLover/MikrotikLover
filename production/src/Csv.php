<?php
declare(strict_types=1);

namespace Prod;

final class Csv
{
    /** Streams a UTF-8 CSV (with BOM so Excel shows Urdu correctly) and exits. */
    public static function send(string $filename, array $head, iterable $rows): never
    {
        Http::noStore();
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . preg_replace('/[^A-Za-z0-9._-]/', '_', $filename) . '"');
        $out = fopen('php://output', 'w');
        fwrite($out, "\xEF\xBB\xBF");
        fputcsv($out, $head, ',', '"', '');
        foreach ($rows as $row) {
            // Neutralise formula injection: cells starting with = + - @ are prefixed with a quote,
            // except plain numbers (negative values stay numeric).
            $row = array_map(fn($v) => is_string($v) && $v !== '' && strpbrk($v[0], '=+-@') !== false && !is_numeric($v) ? "'" . $v : $v, $row);
            fputcsv($out, $row, ',', '"', '');
        }
        fclose($out);
        exit;
    }
}
