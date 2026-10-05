<?php
declare(strict_types=1);

namespace Prod;

/**
 * Imports the "Production Summary" Excel sheet (or a CSV with the same headings).
 *
 * Two steps:
 *   preview(): reads the file, finds the heading row, cleans and validates every row, and stores the
 *              parsed rows in storage/tmp under a token. Nothing is written to the database.
 *   commit():  writes the stored rows.
 *     append   adds only rows not imported before (each row has a fingerprint, so importing the same,
 *              growing workbook every day adds just the new rows)
 *     replace  first removes previously imported rows in the file's date range (manual entries stay),
 *              then adds every row: use it after correcting old rows in Excel.
 */
final class Importer
{
    /** field => accepted headings (lower case, single spaces) */
    public const HEADINGS = [
        'date'        => ['date', 'production date', 'print date'],
        'lot_no'      => ['lot #', 'lot', 'lot no', 'lot no.', 'lot number'],
        'quality'     => ['quality', 'fabric', 'fabric quality'],
        'party'       => ['party name', 'party', 'customer'],
        'design'      => ['design', 'design #', 'design no'],
        'printed_mtr' => ['printed mtr', 'printed meter', 'printed meters', 'printed mtrs', 'meters', 'mtr'],
        'calibration' => ['calibration', 'profile'],
        'ink'         => ['ink use', 'ink', 'ink ml', 'ink use (ml/mtr)', 'ink ml/mtr'],
        'article'     => ['article'],
        'machine'     => ['machine'],
        'shift'       => ['shift'],
        'operator'    => ['operator namw', 'operator name', 'operator'],
    ];
    private const REQUIRED = ['date', 'printed_mtr', 'machine'];
    private const MAX_ERRORS_SHOWN = 300;
    private const BATCH = 500;

    public static function tmpDir(): string
    {
        $dir = rtrim((string)Config::get('storage_path', PROD_ROOT . '/storage'), '/') . '/tmp';
        if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
            throw new \RuntimeException("Cannot create $dir");
        }
        // Housekeeping: uploads older than a day.
        foreach (glob($dir . '/import_*') ?: [] as $f) {
            if (filemtime($f) < time() - 86400) {
                @unlink($f);
            }
        }
        return $dir;
    }

    /** Keeps an uploaded file for the preview/commit steps. Returns the token. */
    public static function stash(string $uploadedPath, string $originalName): string
    {
        $ext = strtolower(pathinfo($originalName, PATHINFO_EXTENSION));
        if (!in_array($ext, ['xlsx', 'csv', 'txt'], true)) {
            throw ApiException::validation(['file' => $ext === 'xls'
                ? 'Old .xls format is not supported. In Excel use Save As → Excel Workbook (.xlsx).'
                : 'Choose an Excel .xlsx or a .csv file.']);
        }
        $token = bin2hex(random_bytes(16));
        $dest = self::tmpDir() . "/import_$token.$ext";
        if (!(is_uploaded_file($uploadedPath) ? move_uploaded_file($uploadedPath, $dest) : copy($uploadedPath, $dest))) {
            throw new \RuntimeException('Could not store the uploaded file.');
        }
        file_put_contents(self::tmpDir() . "/import_$token.meta", json_encode(['name' => mb_substr(basename($originalName), 0, 200), 'ext' => $ext, 'user' => Auth::id()]));
        return $token;
    }

    private static function meta(string $token): array
    {
        if (!preg_match('/^[a-f0-9]{32}$/', $token)) {
            throw ApiException::notFound('Upload');
        }
        $file = self::tmpDir() . "/import_$token.meta";
        $meta = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
        if (!is_array($meta) || (int)$meta['user'] !== (int)Auth::id()) {
            throw new ApiException('This upload has expired. Please choose the file again.', 410);
        }
        $meta['path'] = self::tmpDir() . "/import_$token.{$meta['ext']}";
        return $meta;
    }

    /**
     * Parses the file and returns a summary for the user to confirm.
     * @param string|null $sheet worksheet to read (xlsx); null = first sheet with the expected headings
     */
    public static function preview(string $token, ?string $sheet = null): array
    {
        $meta = self::meta($token);
        $sheets = [];
        if ($meta['ext'] === 'xlsx') {
            $reader = new XlsxReader($meta['path']);
            $sheets = $reader->sheetNames();
            $candidates = $sheet !== null && $sheet !== '' ? [$sheet] : $sheets;
            $found = null;
            foreach ($candidates as $name) {
                $rows = $reader->rows($name);
                $map = self::findHeadings($rows);
                if ($map !== null) {
                    $found = [$name, $rows, $map];
                    break;
                }
            }
            if ($found === null) {
                throw ApiException::validation(['file' => ($sheet ? "Sheet \"$sheet\" has" : 'No sheet has')
                    . ' the expected headings (Date, Printed Mtr, Machine …) in its first 30 rows.']);
            }
            [$sheet, $rows, $map] = $found;
            $toDate = fn(float $v) => $reader->toDate($v);
        } else {
            $sheet = '';
            $rows = self::csvRows($meta['path']);
            $map = self::findHeadings($rows) ?? throw ApiException::validation(['file' => 'The CSV has no heading row with Date, Printed Mtr and Machine.']);
            $toDate = fn(float $v) => XlsxReader::serialToDate($v);
        }

        $parsed = [];
        $errors = [];
        $failed = 0;
        $seen = [];
        $newNames = [];
        $warnInk = 0;
        $highInk = (float)Settings::get('ink_high_ml', 60);
        // The generator continues after the heading row (a started generator cannot be rewound, so no foreach).
        for (; $rows->valid(); $rows->next()) {
            $rowNo = $rows->key();
            $cells = $rows->current();
            $raw = [];
            foreach ($map as $field => $col) {
                $raw[$field] = $cells[$col] ?? null;
            }
            if (count(array_filter($raw, fn($v) => $v !== null && Text::clean(is_bool($v) ? '' : $v) !== '')) === 0) {
                continue; // blank row (or only formula columns we do not read)
            }
            [$row, $problem] = self::parseRow($raw, $toDate);
            if ($problem !== null) {
                $failed++;
                if (count($errors) < self::MAX_ERRORS_SHOWN) {
                    $errors[] = ['row' => $rowNo, 'error' => $problem, 'values' => array_map(fn($v) => is_float($v) ? Text::code($v) : $v, $raw)];
                }
                continue;
            }
            if ($row['ink'] === null || $row['ink'] > $highInk) {
                $warnInk++;
            }
            $base = self::fingerprintBase($row);
            $seen[$base] = ($seen[$base] ?? 0) + 1;
            $row['fp'] = sha1($base . '#' . $seen[$base]);
            $row['src_row'] = $rowNo;
            $parsed[] = $row;
            foreach (['machine', ...array_keys(Masters::KINDS)] as $f) {
                if ($row[$f] !== '') {
                    $newNames[$f][Text::key($row[$f])] = $row[$f];
                }
            }
        }
        if (!$parsed) {
            throw ApiException::validation(['file' => 'No valid production rows were found.' . ($errors ? ' First problem: row ' . $errors[0]['row'] . ' – ' . $errors[0]['error'] : '')]);
        }

        $dates = array_column($parsed, 'date');
        $from = min($dates);
        $to = max($dates);
        $already = self::existingFingerprints($from, $to);
        $dupes = 0;
        foreach ($parsed as $r) {
            if (isset($already[$r['fp']])) {
                $dupes++;
            }
        }
        $replaceRemoves = (int)Database::value("SELECT COUNT(*) FROM production_entries WHERE source = 'import' AND entry_date BETWEEN ? AND ?", [$from, $to]);

        // Which names would be created
        $created = [];
        foreach ($newNames as $field => $names) {
            $existing = $field === 'machine'
                ? Database::column('SELECT name FROM machines')
                : Database::column('SELECT name FROM masters WHERE kind = ?', [$field]);
            $existingKeys = array_flip(array_map([Text::class, 'key'], $existing));
            $new = array_values(array_filter($names, fn($n) => !isset($existingKeys[Text::key($n)])));
            sort($new);
            if ($new) {
                $created[$field] = $new;
            }
        }

        file_put_contents(self::tmpDir() . "/import_$token.json", json_encode(['sheet' => $sheet, 'rows' => $parsed], JSON_UNESCAPED_UNICODE));

        $meters = array_sum(array_column($parsed, 'mtr'));
        return [
            'token'           => $token,
            'file_name'       => $meta['name'],
            'sheets'          => $sheets,
            'sheet'           => $sheet,
            'columns'         => array_map(fn($c) => self::colName($c), $map),
            'rows_valid'      => count($parsed),
            'rows_failed'     => $failed,
            'errors'          => $errors,
            'date_from'       => $from,
            'date_to'         => $to,
            'meters'          => $meters,
            'ink_warnings'    => $warnInk,
            'already_imported'=> $dupes,
            'append_adds'     => count($parsed) - $dupes,
            'replace_removes' => $replaceRemoves,
            'new_names'       => $created,
            'sample'          => array_slice($parsed, 0, 8),
        ];
    }

    /** Writes the previewed rows. @return array summary */
    public static function commit(string $token, string $mode): array
    {
        if (!in_array($mode, ['append', 'replace'], true)) {
            throw ApiException::validation(['mode' => 'Choose append or replace.']);
        }
        $meta = self::meta($token);
        $file = self::tmpDir() . "/import_$token.json";
        $data = is_file($file) ? json_decode((string)file_get_contents($file), true) : null;
        if (!is_array($data) || empty($data['rows'])) {
            throw new ApiException('Preview the file before importing it.', 409);
        }
        $rows = $data['rows'];
        $dates = array_column($rows, 'date');
        $from = min($dates);
        $to = max($dates);
        @set_time_limit(300);

        $result = Database::transaction(function () use ($rows, $mode, $from, $to, $meta, $data) {
            $removed = 0;
            if ($mode === 'replace') {
                $removed = Database::run("DELETE FROM production_entries WHERE source = 'import' AND entry_date BETWEEN ? AND ?", [$from, $to])->rowCount();
            }
            $batchId = Database::insert('import_batches', [
                'file_name' => $meta['name'], 'sheet_name' => (string)$data['sheet'], 'mode' => $mode, 'rows_read' => count($rows),
                'date_from' => $from, 'date_to' => $to, 'created_by' => Auth::id(), 'rows_removed' => $removed,
            ]);
            $already = $mode === 'append' ? self::existingFingerprints($from, $to) : [];
            $uid = Auth::id();
            $added = 0;
            $skipped = 0;
            $buffer = [];
            foreach ($rows as $r) {
                if (isset($already[$r['fp']])) {
                    $skipped++;
                    continue;
                }
                $machineId = Machines::resolve($r['machine']);
                $buffer[] = [
                    $r['date'], $r['lot_no'], Masters::resolve('quality', $r['quality']), Masters::resolve('party', $r['party']),
                    $r['design'], $r['mtr'], Masters::resolve('calibration', $r['calibration']), $r['ink'],
                    Masters::resolve('article', $r['article']), $machineId, $r['shift'], Masters::resolve('operator', $r['operator']),
                    Machines::rateFor($machineId, $r['date']), 'import', $batchId, $r['fp'], $uid,
                ];
                if (count($buffer) >= self::BATCH) {
                    $added += self::flush($buffer);
                }
            }
            $added += self::flush($buffer);
            Database::update('import_batches', ['rows_added' => $added, 'rows_skipped' => $skipped], 'id = :id', ['id' => $batchId]);
            Audit::log('import', 'import_batches', $batchId, null, ['file' => $meta['name'], 'mode' => $mode, 'added' => $added, 'removed' => $removed]);
            return ['batch_id' => $batchId, 'added' => $added, 'skipped' => $skipped, 'removed' => $removed, 'date_from' => $from, 'date_to' => $to];
        });
        foreach (['json', 'meta', $meta['ext']] as $ext) {
            @unlink(self::tmpDir() . "/import_$token.$ext");
        }
        return $result;
    }

    private static function flush(array &$buffer): int
    {
        if (!$buffer) {
            return 0;
        }
        $cols = '(entry_date, lot_no, quality_id, party_id, design, printed_mtr, calibration_id, ink_ml_per_mtr, article_id, machine_id, shift, operator_id, ink_rate, source, import_batch_id, fingerprint, created_by)';
        $one = '(' . implode(',', array_fill(0, 17, '?')) . ')';
        $sql = "INSERT INTO production_entries $cols VALUES " . implode(',', array_fill(0, count($buffer), $one));
        $n = Database::run($sql, array_merge(...$buffer))->rowCount();
        $buffer = [];
        return $n;
    }

    /** @return array<string,true> */
    private static function existingFingerprints(string $from, string $to): array
    {
        return array_fill_keys(Database::column(
            "SELECT fingerprint FROM production_entries WHERE source = 'import' AND fingerprint IS NOT NULL AND entry_date BETWEEN ? AND ?",
            [$from, $to]
        ), true);
    }

    /**
     * Looks for the heading row in the first 30 rows. Leaves the generator positioned after it.
     * @return array<string,int>|null field => column index
     */
    public static function findHeadings(\Iterator $rows): ?array
    {
        $lookup = [];
        foreach (self::HEADINGS as $field => $names) {
            foreach ($names as $n) {
                $lookup[$n] = $field;
            }
        }
        $checked = 0;
        for ($rows->rewind(); $rows->valid() && $checked < 30; $checked++) {
            $map = [];
            foreach ($rows->current() as $col => $v) {
                $field = $lookup[Text::key(is_string($v) ? $v : '')] ?? null;
                if ($field !== null && !isset($map[$field])) {
                    $map[$field] = $col;
                }
            }
            $rows->next();
            if (!array_diff(self::REQUIRED, array_keys($map))) {
                return $map;
            }
        }
        return null;
    }

    /**
     * Cleans one row. @return array{0:?array,1:?string} [row, problem]
     */
    public static function parseRow(array $raw, callable $toDate): array
    {
        $d = $raw['date'] ?? null;
        $date = null;
        if (is_float($d) || is_int($d)) {
            $date = $toDate((float)$d);
        } elseif (is_string($d)) {
            $date = self::parseDateText($d);
        }
        if ($date === null) {
            return [null, 'Date is missing or not a date'];
        }
        $mtr = Text::number($raw['printed_mtr'] ?? null);
        if ($mtr === null || $mtr <= 0) {
            return [null, 'Printed Mtr is missing or not a number'];
        }
        if ($mtr > 1e7) {
            return [null, 'Printed Mtr is too large'];
        }
        $machine = Text::clean($raw['machine'] ?? '');
        if ($machine === '') {
            return [null, 'Machine is missing'];
        }
        $shift = strtoupper(Text::clean($raw['shift'] ?? ''));
        if ($shift === '') {
            $shift = 'A';
        } elseif (!in_array($shift, ['A', 'B', 'C'], true)) {
            return [null, "Shift \"$shift\" is not A, B or C"];
        }
        $inkRaw = $raw['ink'] ?? null;
        $ink = Text::number($inkRaw);
        if ($ink === null && $inkRaw !== null && Text::clean($inkRaw) !== '') {
            return [null, 'Ink use is not a number'];
        }
        if ($ink !== null && ($ink < 0 || $ink >= 1e7)) {
            return [null, 'Ink use is out of range'];
        }
        return [[
            'date'        => $date,
            'lot_no'      => mb_substr(Text::code($raw['lot_no'] ?? ''), 0, 40),
            'quality'     => Text::clean($raw['quality'] ?? ''),
            'party'       => Text::clean($raw['party'] ?? ''),
            'design'      => mb_substr(Text::code($raw['design'] ?? ''), 0, 80),
            'mtr'         => round($mtr, 2),
            'calibration' => Text::clean($raw['calibration'] ?? ''),
            'ink'         => $ink === null ? null : round($ink, 3),
            'article'     => Text::clean($raw['article'] ?? ''),
            'machine'     => $machine,
            'shift'       => $shift,
            'operator'    => Text::clean($raw['operator'] ?? ''),
        ], null];
    }

    /** 2026-01-31, 31/01/2026, 31-01-2026, 31-Jan-26, 31 Jan 2026 (day first, as typed in Pakistan). */
    public static function parseDateText(string $s): ?string
    {
        $s = Text::clean($s);
        if ($s === '') {
            return null;
        }
        if (is_numeric($s)) {
            return XlsxReader::serialToDate((float)$s);
        }
        if (preg_match('/^(\d{4})-(\d{1,2})-(\d{1,2})/', $s, $m)) {
            return checkdate((int)$m[2], (int)$m[3], (int)$m[1]) ? sprintf('%04d-%02d-%02d', $m[1], $m[2], $m[3]) : null;
        }
        if (preg_match('#^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$#', $s, $m)) {
            $y = (int)$m[3] < 100 ? 2000 + (int)$m[3] : (int)$m[3];
            return checkdate((int)$m[2], (int)$m[1], $y) ? sprintf('%04d-%02d-%02d', $y, $m[2], $m[1]) : null;
        }
        foreach (['d-M-y', 'd-M-Y', 'd M Y', 'd M y', 'j-M-y', 'j-M-Y', 'd/M/Y', 'M d, Y'] as $fmt) {
            $dt = \DateTimeImmutable::createFromFormat('!' . $fmt, $s);
            if ($dt && $dt->format($fmt) === $s) {
                return $dt->format('Y-m-d');
            }
        }
        return null;
    }

    private static function fingerprintBase(array $r): string
    {
        $parts = [$r['date'], $r['lot_no'], $r['quality'], $r['party'], $r['design'], number_format($r['mtr'], 2, '.', ''),
            $r['calibration'], $r['ink'] === null ? '' : number_format($r['ink'], 3, '.', ''), $r['article'], $r['machine'], $r['shift'], $r['operator']];
        return implode('|', array_map(fn($p) => Text::key((string)$p), $parts));
    }

    /** @return \Generator<int,array<int,mixed>> */
    private static function csvRows(string $path): \Generator
    {
        $text = (string)file_get_contents($path);
        $text = preg_replace('/^\xEF\xBB\xBF/', '', $text) ?? $text;
        if (!mb_check_encoding($text, 'UTF-8')) {
            $text = mb_convert_encoding($text, 'UTF-8', 'Windows-1252');
        }
        $lines = preg_split('/\r\n|\r|\n/', $text) ?: [];
        $sample = implode("\n", array_slice($lines, 0, 5));
        $delim = substr_count($sample, "\t") > substr_count($sample, ',') ? "\t" : (substr_count($sample, ';') > substr_count($sample, ',') ? ';' : ',');
        foreach ($lines as $i => $line) {
            if (trim($line) === '') {
                continue;
            }
            $cells = [];
            foreach (str_getcsv($line, $delim, '"', '\\') as $c => $v) {
                $v = trim((string)$v);
                if ($v !== '') {
                    $cells[$c] = $v;
                }
            }
            if ($cells) {
                yield $i + 1 => $cells;
            }
        }
    }

    private static function colName(int $i): string
    {
        $s = '';
        for ($i++; $i > 0; $i = intdiv($i - 1, 26)) {
            $s = chr(65 + ($i - 1) % 26) . $s;
        }
        return $s;
    }
}
