<?php
declare(strict_types=1);

use Prod\ApiException;
use Prod\Auth;
use Prod\Database;
use Prod\Entries;
use Prod\Importer;
use Prod\Machines;
use Prod\Masters;
use Prod\Reports;

/** Writes a small workbook shaped like Production_Details_2026.xlsx (title row, totals row, headings in row 3). */
function make_xlsx(string $path, array $dataRows): void
{
    $strings = [];
    $si = function (string $s) use (&$strings): int {
        if (!isset($strings[$s])) {
            $strings[$s] = count($strings);
        }
        return $strings[$s];
    };
    $cell = function (string $ref, mixed $v) use ($si): string {
        if ($v === null) {
            return '';
        }
        return is_string($v) ? "<c r=\"$ref\" t=\"s\"><v>{$si($v)}</v></c>" : "<c r=\"$ref\"><v>$v</v></c>";
    };
    $rows = [
        1 => ['Digital Production Report'],
        2 => [null, 'Total', null, null, null, 999],
        3 => ['Date', 'Lot #', 'Quality', 'Party Name', 'Design', 'Printed Mtr', 'CALIBRATION', 'Ink use', 'Article', 'Machine', 'Shift', 'Operator Namw', 'Total  Ink'],
    ];
    $n = 4;
    foreach ($dataRows as $r) {
        $rows[$n++] = $r;
    }
    $xml = '';
    foreach ($rows as $rn => $vals) {
        $xml .= "<row r=\"$rn\">";
        foreach (array_values($vals) as $i => $v) {
            $xml .= $cell(chr(65 + $i) . $rn, $v);
        }
        // Formula column M with a cached value, like the real sheet
        if ($rn >= 4) {
            $xml .= "<c r=\"M$rn\"><f>H$rn*F$rn</f><v>1</v></c>";
        }
        $xml .= '</row>';
    }
    $xml .= '<row r="99"><c r="M99"><f>H99*F99</f><v>0</v></c></row>'; // empty formula-only row
    $ss = '';
    foreach (array_keys($strings) as $s) {
        $ss .= '<si><t>' . htmlspecialchars($s, ENT_XML1) . '</t></si>';
    }
    $z = new ZipArchive();
    $z->open($path, ZipArchive::CREATE | ZipArchive::OVERWRITE);
    $z->addFromString('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Production Summary" sheetId="2" r:id="rId2"/></sheets></workbook>');
    $z->addFromString('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>');
    $z->addFromString('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>Row Labels</t></is></c></row></sheetData></worksheet>');
    $z->addFromString('xl/worksheets/sheet2.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' . $xml . '</sheetData></worksheet>');
    $z->addFromString('xl/sharedStrings.xml', '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' . $ss . '</sst>');
    $z->close();
}

function import_rows(array $rows, string $mode = 'append'): array
{
    $file = sys_get_temp_dir() . '/prod-test-' . getmypid() . '.xlsx';
    make_xlsx($file, $rows);
    $token = Importer::stash($file, 'Production.xlsx');
    $preview = Importer::preview($token);
    return [$preview, Importer::commit($token, $mode)];
}

$R = [
    // date, lot, quality, party, design, mtr, calibration, ink, article, machine, shift, operator
    [46023, 2153, 'Chamki Tilla', 'Umair Farooqi Vol 50', 40976, 160, 'Muslim 72x68', 5.19, 'Shirt', 'Ms', 'A', 'Malik Mehmood'],
    [46023, 2267, 'Cotrai', 'Elan Vol 278', '18238-B', 600, 'Muslim 72x68', 3.75, 'Allover', 'MS', 'A', 'Malik Mehmood'],
    [46023, 2267, 'Cotrai', 'Elan Vol 278', '18238-B', 600, 'Muslim 72x68', 3.75, 'Allover', 'MS', 'A', 'Malik Mehmood'], // a genuine repeat
    [46024, 2273, 'Cotrai ', 'Elan Vol 278', 24794, 600, 'Muslim 72x68', '2.85', 'Dupatta', 'Atexco 5', 'B', 'Ehsan Rafaqat'],
    [46024, 2274, 'Cotrai', 'Elan Vol 278', 24795, 500, 'Muslim 72x68', null, 'Duppata', 'Atexco 5', 'B', 'Ehsan Rafaqat'],
    ['not a date', 1, 'x', 'y', 1, 10, 'c', 1, 'a', 'MS', 'A', 'z'],
];

return [
    'import reads the right sheet, skips bad rows and merges name variants' => function () use ($R) {
        act_as('manager');
        [$p, $res] = import_rows($R);
        assert_eq('Production Summary', $p['sheet']);
        assert_eq(5, $p['rows_valid']);
        assert_eq(1, $p['rows_failed']);
        assert_eq(9, $p['errors'][0]['row'], 'Excel row number of the bad row');
        assert_eq('2026-01-01', $p['date_from']);
        assert_eq(5, $res['added']);
        assert_eq(2, (int)Database::value('SELECT COUNT(*) FROM machines'), '"Ms" and "MS" are one machine');
        assert_eq(1, (int)Database::value("SELECT COUNT(*) FROM masters WHERE kind = 'quality' AND name = 'Cotrai'"), 'trailing space merged');
        assert_eq(2460.0, (float)Database::value('SELECT SUM(printed_mtr) FROM production_entries'));
    },
    'importing the same workbook again adds nothing, a grown workbook adds only new rows' => function () use ($R) {
        act_as('manager');
        [$p, $res] = import_rows($R);
        assert_eq(5, $p['already_imported']);
        assert_eq(0, $res['added']);
        $R[] = [46025, 2280, 'Lawn', 'New Party Vol 1', 'N-1', 300, 'Muslim 72x68', 4.0, 'Shirt', 'MS', 'A', 'Moin'];
        [, $res] = import_rows($R);
        assert_eq(1, $res['added']);
        assert_eq(5, $res['skipped']);
        assert_eq(6, (int)Database::value('SELECT COUNT(*) FROM production_entries'));
    },
    'replace mode swaps imported rows in the date range but keeps manual entries' => function () use ($R) {
        act_as('manager');
        $ms = (int)Database::value("SELECT id FROM machines WHERE name = 'MS'");
        Entries::create(['entry_date' => '2026-01-02', 'printed_mtr' => 50, 'machine_id' => $ms, 'shift' => 'A', 'party' => 'Manual Party']);
        $R[3][5] = 650; // corrected in Excel
        [$p, $res] = import_rows($R, 'replace');
        assert_eq(5, $p['replace_removes'], 'only imported rows inside 1-2 Jan (the 3 Jan row stays)');
        assert_eq(5, $res['removed']);
        assert_eq(5, $res['added']);
        assert_eq(1, (int)Database::value("SELECT COUNT(*) FROM production_entries WHERE source = 'manual'"));
        assert_eq(650.0, (float)Database::value("SELECT printed_mtr FROM production_entries WHERE lot_no = '2273'"));
    },
    'ink cost uses the machine rate on the entry date and follows rate changes' => function () {
        act_as('manager');
        $a5 = (int)Database::value("SELECT id FROM machines WHERE name = 'Atexco 5'");
        // lot 2273: 650 m x 2.85 ml/m = 1852.5 ml at the default 1450 Rs/L
        $cost = fn() => (float)Database::value("SELECT ink_cost FROM production_entries WHERE lot_no = '2273'");
        assert_eq(round(1852.5 * 1450 / 1000, 2), $cost());
        Machines::saveRate($a5, '2026-01-02', 2000, 'new supplier');
        assert_eq(round(1852.5 * 2000 / 1000, 2), $cost(), 'entry on 2026-01-02 re-priced');
        Machines::saveRate($a5, '2026-01-03', 2500);
        assert_eq(round(1852.5 * 2000 / 1000, 2), $cost(), 'later rate does not touch older entries');
        $rid = (int)Database::value("SELECT id FROM machine_rates WHERE machine_id = ? AND effective_from = '2026-01-02'", [$a5]);
        Machines::deleteRate($a5, $rid);
        assert_eq(round(1852.5 * 1450 / 1000, 2), $cost(), 'back to the opening rate');
        $only = (int)Database::value('SELECT id FROM machine_rates WHERE machine_id = ? ORDER BY effective_from LIMIT 1', [$a5]);
        Machines::deleteRate($a5, (int)Database::value("SELECT id FROM machine_rates WHERE machine_id = ? AND effective_from = '2026-01-03'", [$a5]));
        assert_throws(fn() => Machines::deleteRate($a5, $only), ApiException::class, 409);
    },
    'missing ink counts in metres but not in the ink average' => function () {
        $t = Reports::summary(['from' => '2026-01-02', 'to' => '2026-01-02'], 'machine')['totals'];
        assert_eq(1200.0, $t['meters'], '650 + 500 (no ink) + 50 manual (no ink)');
        assert_eq(650.0, $t['ink_meters']);
        assert_eq(2.85, $t['avg_ml']);
    },
    'two-level summary and customer grouping' => function () {
        $s = Reports::summary([], 'customer', 'shift', 'meters');
        $keys = array_unique(array_column($s['rows'], 'k1'));
        assert_true(in_array('Elan', $keys, true), 'Vol number stripped: ' . implode(',', $keys));
        assert_true(isset($s['subtotals']['Elan']), 'subtotal per customer');
        assert_throws(fn() => Reports::summary([], 'password_hash'), ApiException::class, 422);
    },
    'merge moves entries and removes the variant' => function () {
        act_as('manager');
        $keep = (int)Database::value("SELECT id FROM masters WHERE kind = 'article' AND name = 'Dupatta'");
        $drop = (int)Database::value("SELECT id FROM masters WHERE kind = 'article' AND name = 'Duppata'");
        $pairs = Masters::similar('article');
        assert_eq(1, count($pairs), 'Dupatta/Duppata suggested');
        assert_eq(1, Masters::merge($drop, $keep));
        assert_eq(2, (int)Database::value('SELECT COUNT(*) FROM production_entries WHERE article_id = ?', [$keep]));
        assert_eq(null, Database::one('SELECT id FROM masters WHERE id = ?', [$drop]));
        $other = (int)Database::value("SELECT id FROM masters WHERE kind = 'operator' LIMIT 1");
        assert_throws(fn() => Masters::merge($keep, $other), ApiException::class, 422);
        assert_throws(fn() => Masters::rename($keep, 'shirt'), ApiException::class, 409);
    },
    'entry validation' => function () {
        act_as('entry');
        $e = assert_throws(fn() => Entries::create(['entry_date' => '2026-02-30', 'printed_mtr' => 'x', 'machine_id' => 999, 'shift' => 'Z', 'ink_ml_per_mtr' => 'abc']), ApiException::class, 422);
        assert_eq(['entry_date', 'printed_mtr', 'ink_ml_per_mtr', 'machine_id', 'shift'], array_keys($e->errors()));
        $ms = (int)Database::value("SELECT id FROM machines WHERE name = 'MS'");
        $row = Entries::create(['entry_date' => '2026-03-01', 'printed_mtr' => '1,000', 'ink_ml_per_mtr' => '12.5', 'machine_id' => $ms, 'shift' => 'b', 'operator' => ' moin ']);
        assert_eq('B', $row['shift']);
        assert_eq('Moin', $row['operator'], 'matched existing operator case-insensitively');
        assert_eq(12500.0, (float)$row['ink_ml']);
        assert_eq(18125.0, (float)$row['ink_cost']);
        Machines::setActive($ms, false);
        assert_throws(fn() => Entries::create(['entry_date' => '2026-03-01', 'printed_mtr' => 1, 'machine_id' => $ms, 'shift' => 'A']), ApiException::class, 422);
        Entries::update((int)$row['id'], ['entry_date' => '2026-03-01', 'printed_mtr' => 10, 'machine_id' => $ms, 'shift' => 'A']); // editing old entries still works
        Machines::setActive($ms, true);
    },
    'filters' => function () {
        [$w, $p] = Entries::where(['flag' => 'no_ink']);
        assert_eq(3, Reports::totals($w, $p)['entries'], 'lot 2274, the manual entry and the edited entry');
        [$w, $p] = Entries::where(['search' => '18238', 'shift' => 'a']);
        assert_eq(2, Reports::totals($w, $p)['entries']);
        [$w, $p] = Entries::where(['from' => '2026-01-02', 'to' => '2026-01-02', 'machine_id' => '1; DROP TABLE users']);
        assert_true(!str_contains($w, 'DROP'), 'non-numeric id ignored');
    },
    'role permissions on routes' => function () {
        require_once PROD_ROOT . '/src/routes.php';
        $perm = fn(string $m, string $path) => prod_match($m, $path)[1];
        assert_eq('import', $perm('POST', '/import/commit'));
        assert_eq('entries.delete', $perm('DELETE', '/entries/5'));
        assert_eq('entries.add', $perm('GET', '/entries/last'));
        assert_eq('view', $perm('GET', '/entries.csv'));
        assert_eq('users', $perm('PUT', '/users/1'));
        assert_throws(fn() => prod_match('PATCH', '/entries/1'), ApiException::class, 405);
        act_as('viewer');
        assert_true(Auth::can('view') && !Auth::can('entries.add') && !Auth::can('import'), 'viewer is read only');
        act_as('entry');
        assert_true(Auth::can('entries.edit') && !Auth::can('entries.delete') && !Auth::can('rates.edit'), 'entry role');
        act_as('manager');
        assert_true(Auth::can('import') && Auth::can('rates.edit') && !Auth::can('users') && !Auth::can('settings'), 'manager role');
        act_as('admin');
        assert_true(Auth::can('users') && Auth::can('audit'), 'admin role');
    },
    'audit trail records changes only' => function () {
        $n = (int)Database::value("SELECT COUNT(*) FROM audit_log WHERE entity = 'production_entries' AND action = 'update'");
        assert_true($n >= 1, 'entry update audited');
        $row = Database::one("SELECT new_values FROM audit_log WHERE entity = 'production_entries' AND action = 'update' ORDER BY id DESC LIMIT 1");
        $changed = array_keys(json_decode($row['new_values'], true));
        assert_true(in_array('printed_mtr', $changed, true) && !in_array('machine_id', $changed, true), 'only changed fields: ' . implode(',', $changed));
    },
];
