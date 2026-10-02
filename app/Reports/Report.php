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
        return '"' . str_replace(['\\', '"', "\n"], ['\\\\', '\\"', ' '], $s) . '"';
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
        $extraCss = $this->pageCss();

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
{$this->companyHeader()}
{$body}
<div class="rpt-printed screen-only">{$printed}</div>
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
}
