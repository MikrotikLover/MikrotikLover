<?php
declare(strict_types=1);

namespace App;

/**
 * Reads the first sheet of .xlsx, or .csv / .txt / .dat (comma, semicolon or tab separated) into rows of strings.
 * XLSX needs only ZipArchive + SimpleXML (available on shared hosting). Excel date cells are
 * returned as 'Y-m-d H:i:s' strings when the cell style is a date format.
 */
final class SpreadsheetReader
{
    /** @return array<int,array<int,string>> */
    public static function read(string $path, string $originalName): array
    {
        $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        if ($ext === 'xlsx') {
            return self::xlsx($path);
        }
        if ($ext === 'xls') {
            throw ApiException::validation(['file' => 'Old .xls format is not supported. In Excel use "Save As" → CSV or .xlsx.']);
        }
        return self::delimited((string)file_get_contents($path));
    }

    public static function delimited(string $text): array
    {
        $text = preg_replace('/^\xEF\xBB\xBF/', '', $text);
        if (!mb_check_encoding($text, 'UTF-8')) {
            $text = mb_convert_encoding($text, 'UTF-8', 'Windows-1252');
        }
        $lines = preg_split('/\r\n|\r|\n/', $text);
        $sample = implode("\n", array_slice($lines, 0, 5));
        $delim = substr_count($sample, "\t") > substr_count($sample, ',') ? "\t" : (substr_count($sample, ';') > substr_count($sample, ',') ? ';' : ',');
        $rows = [];
        foreach ($lines as $line) {
            if (trim($line) === '') {
                continue;
            }
            $rows[] = array_map('trim', str_getcsv($line, $delim, '"', '\\'));
        }
        return $rows;
    }

    public static function xlsx(string $path): array
    {
        if (!class_exists(\ZipArchive::class)) {
            throw ApiException::validation(['file' => 'This server cannot read .xlsx files. Save the sheet as CSV and import that.']);
        }
        $zip = new \ZipArchive();
        if ($zip->open($path) !== true) {
            throw ApiException::validation(['file' => 'The .xlsx file could not be opened.']);
        }
        $shared = [];
        if (($xml = $zip->getFromName('xl/sharedStrings.xml')) !== false) {
            $sx = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
            foreach ($sx->si as $si) {
                $t = '';
                if (isset($si->t)) {
                    $t = (string)$si->t;
                } else {
                    foreach ($si->r as $run) {
                        $t .= (string)$run->t;
                    }
                }
                $shared[] = $t;
            }
        }
        // Which style indexes are dates
        $dateStyles = [];
        if (($xml = $zip->getFromName('xl/styles.xml')) !== false) {
            $sx = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
            $customDate = [];
            if (isset($sx->numFmts)) {
                foreach ($sx->numFmts->numFmt as $f) {
                    $code = strtolower((string)$f['formatCode']);
                    if (preg_match('/[dmyhs]/', preg_replace('/"[^"]*"|\[[^\]]*\]/', '', $code))) {
                        $customDate[(int)$f['numFmtId']] = true;
                    }
                }
            }
            $i = 0;
            if (isset($sx->cellXfs)) {
                foreach ($sx->cellXfs->xf as $xf) {
                    $id = (int)$xf['numFmtId'];
                    if (($id >= 14 && $id <= 22) || ($id >= 45 && $id <= 47) || isset($customDate[$id])) {
                        $dateStyles[$i] = true;
                    }
                    $i++;
                }
            }
        }
        $sheetPath = 'xl/worksheets/sheet1.xml';
        if (($wb = $zip->getFromName('xl/workbook.xml')) !== false && ($rels = $zip->getFromName('xl/_rels/workbook.xml.rels')) !== false) {
            $wbx = simplexml_load_string($wb, \SimpleXMLElement::class, LIBXML_NONET);
            $relx = simplexml_load_string($rels, \SimpleXMLElement::class, LIBXML_NONET);
            $first = $wbx->sheets->sheet[0] ?? null;
            if ($first) {
                $rid = (string)$first->attributes('http://schemas.openxmlformats.org/officeDocument/2006/relationships')['id'];
                foreach ($relx->Relationship as $rel) {
                    if ((string)$rel['Id'] === $rid) {
                        $target = ltrim((string)$rel['Target'], '/');
                        $sheetPath = str_starts_with($target, 'xl/') ? $target : 'xl/' . $target;
                    }
                }
            }
        }
        $xml = $zip->getFromName($sheetPath);
        $zip->close();
        if ($xml === false) {
            throw ApiException::validation(['file' => 'No worksheet found in the .xlsx file.']);
        }
        $sx = simplexml_load_string($xml, \SimpleXMLElement::class, LIBXML_NONET);
        $rows = [];
        foreach ($sx->sheetData->row as $row) {
            $out = [];
            foreach ($row->c as $c) {
                $ref = (string)$c['r'];
                $col = self::colIndex(preg_replace('/\d+/', '', $ref));
                $type = (string)$c['t'];
                $v = (string)($c->v ?? '');
                if ($type === 's') {
                    $v = $shared[(int)$v] ?? '';
                } elseif ($type === 'inlineStr') {
                    $v = (string)($c->is->t ?? '');
                } elseif ($type === '' && $v !== '' && isset($dateStyles[(int)$c['s']]) && is_numeric($v)) {
                    $v = self::excelDate((float)$v);
                }
                $out[$col] = trim($v);
            }
            if ($out) {
                $max = max(array_keys($out));
                $rows[] = array_map(fn($i) => $out[$i] ?? '', range(0, $max));
            }
        }
        return $rows;
    }

    private static function colIndex(string $letters): int
    {
        $n = 0;
        foreach (str_split(strtoupper($letters)) as $ch) {
            $n = $n * 26 + (ord($ch) - 64);
        }
        return max(0, $n - 1);
    }

    public static function excelDate(float $serial): string
    {
        if ($serial < 1) { // time only
            return gmdate('H:i:s', (int)round($serial * 86400));
        }
        return gmdate('Y-m-d H:i:s', (int)round(($serial - 25569) * 86400));
    }
}
