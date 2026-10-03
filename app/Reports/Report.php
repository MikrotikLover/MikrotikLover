<?php
declare(strict_types=1);

namespace App\Reports;

use App\Auth;
use App\Http;
use App\Request;
use App\Settings;

/**
 * Base for print-ready HTML reports (A4 portrait/landscape via CSS @page) with
 * company header, filter line, page X of Y and "printed by/at" footer.
 */
abstract class Report
{
    protected Request $request;

    /** @return array{0:string,1:string} [module, action] required to open the report */
    abstract public function permission(): array;

    abstract public function title(): string;

    /** Body HTML (between header and footer). */
    abstract protected function body(): string;

    public function orientation(): string
    {
        return 'portrait';
    }

    /** Line under the title describing filters / period. */
    protected function subtitle(): string
    {
        return '';
    }

    public function supportsCsv(): bool
    {
        return false;
    }

    public function csv(): array
    {
        return [];
    }

    protected function pageCss(): string
    {
        return '';
    }

    /** False when every printed item carries its own header (payslips). */
    protected function showHeader(): bool
    {
        return true;
    }

    public function load(Request $r): void
    {
        $this->request = $r;
    }

    protected static function e(?string $s): string
    {
        return Http::e($s);
    }

    /** CSS string literal (for @page content). */
    protected static function cssString(string $s): string
    {
        // < and > are CSS-escaped so a value can never close the <style> element
        return '"' . str_replace(['\\', '"', "\n", '<', '>'], ['\\\\', '\\"', ' ', '\\3C ', '\\3E '], $s) . '"';
    }

    protected function companyHeader(): string
    {
        $c = Settings::company();
        $logo = $c['logo'] ? '<img class="rpt-logo" src="file.php?t=logo&amp;v=' . rawurlencode((string)$c['logo']) . '" alt="">' : '';
        $ur = $c['name_ur'] !== '' ? '<div class="rpt-company-ur urdu">' . self::e($c['name_ur']) . '</div>' : '';
        $addr = trim($c['address'] . ($c['phone'] !== '' ? ' · Ph: ' . $c['phone'] : ''));
        $sub = $this->subtitle();
        return '<header class="rpt-head">' . $logo
            . '<div class="rpt-head-text"><div class="rpt-company">' . self::e($c['name']) . '</div>' . $ur
            . ($addr !== '' ? '<div class="rpt-address">' . self::e($addr) . '</div>' : '')
            . '<h1 class="rpt-title">' . self::e($this->title()) . '</h1>'
            . ($sub !== '' ? '<div class="rpt-sub">' . $sub . '</div>' : '')
            . '</div></header>';
    }

    public function renderHtml(): string
    {
        $user = Auth::user();
        $printed = 'Printed by ' . ($user['full_name'] ?? '-') . ' on ' . date('d-M-Y h:i A');
        $size = $this->orientation() === 'landscape' ? 'A4 landscape' : 'A4 portrait';
        $body = $this->body();
        $csv = $this->supportsCsv()
            ? '<a class="btn" href="?' . self::e(http_build_query(array_merge($_GET, ['format' => 'csv']))) . '">Export CSV</a>'
            : '';
        $title = self::e($this->title());
        $pageContent = self::cssString($printed);
        $printedHtml = self::e($printed);
        $extraCss = $this->pageCss();
        $header = $this->showHeader() ? $this->companyHeader() : '';

        return <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{$title}</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/report.css">
<style>
@page { size: {$size}; margin: 10mm 8mm 13mm 8mm;
  @bottom-left  { content: {$pageContent}; font: 7.5pt Arial, sans-serif; color: #444; }
  @bottom-right { content: "Page " counter(page) " of " counter(pages); font: 7.5pt Arial, sans-serif; color: #444; }
}
{$extraCss}
</style>
</head>
<body class="{$this->orientation()}">
<div class="rpt-toolbar no-print">
  <button class="btn primary" onclick="window.print()" title="F9">Print / PDF (F9)</button>
  {$csv}
  <button class="btn" onclick="window.close()">Close (Esc)</button>
  <span class="hint">Tip: choose "Save as PDF" in the print dialog for a PDF file.</span>
</div>
<main class="rpt">
{$header}
{$body}
<div class="rpt-printed screen-only">{$printedHtml}</div>
</main>
<script>
document.addEventListener('keydown', function (e) {
  if (e.key === 'F9') { e.preventDefault(); window.print(); }
  if (e.key === 'Escape') { window.close(); }
});
</script>
</body>
</html>
HTML;
    }

    public function outputCsv(string $filename): never
    {
        Http::noStore();
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . preg_replace('/[^A-Za-z0-9_.-]/', '_', $filename) . '"');
        $fh = fopen('php://output', 'w');
        fwrite($fh, "\xEF\xBB\xBF"); // BOM so Excel opens UTF-8 (Urdu) correctly
        foreach ($this->csv() as $row) {
            fputcsv($fh, array_map(static function ($v) {
                $v = (string)$v;
                // Neutralise spreadsheet formula injection
                return $v !== '' && in_array($v[0], ['=', '+', '-', '@'], true) && !is_numeric($v) ? "'" . $v : $v;
            }, $row), ',', '"', '\\');
        }
        fclose($fh);
        exit;
    }

    /** Human-readable PKR amount, whole rupees. */
    protected static function money(mixed $v): string
    {
        return $v === null || $v === '' ? '' : number_format((float)$v, 0);
    }

    protected static function date(?string $d): string
    {
        return $d ? date('d-m-Y', strtotime($d)) : '';
    }

    /** Minutes as h:mm ('' for 0 when $blankZero). */
    protected static function hm(mixed $minutes, bool $blankZero = true): string
    {
        $m = (int)$minutes;
        if ($m === 0 && $blankZero) {
            return '';
        }
        return sprintf('%d:%02d', intdiv($m, 60), $m % 60);
    }

    protected static function time(?string $dt): string
    {
        return $dt ? date('H:i', strtotime($dt)) : '';
    }

    /** Validated date from the query string (Y-m-d) or default. */
    protected function qDate(string $key, string $default): string
    {
        $v = (string)$this->request->query($key, '');
        return preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) && strtotime($v) ? $v : $default;
    }

    /** "Department: X" style filter line pieces. */
    protected function filterLabel(string $table, ?int $id, string $label): ?string
    {
        if (!$id || !in_array($table, ['departments', 'designations', 'shifts', 'leave_types'], true)) {
            return null;
        }
        $name = \App\Database::value("SELECT name FROM `$table` WHERE id = ?", [$id]);
        return $name ? "$label: " . self::e((string)$name) : null;
    }

    /** Printed codes: stored L / LW are shown as LWP (leave with pay) / LWOP (leave without pay). */
    public const STATUS_CODES = ['L' => 'LWP', 'LW' => 'LWOP'];

    public static function statusCode(?string $status): string
    {
        return $status === null ? '' : (self::STATUS_CODES[$status] ?? $status);
    }

    public const STATUS_NAMES = [
        'P' => 'Present', 'A' => 'Absent', 'L' => 'Leave with pay', 'LW' => 'Leave without pay', 'S' => 'Joined',
        'R' => 'Rest day', 'H' => 'Holiday', 'HD' => 'Half day', 'O' => 'Off',
    ];
}
