<?php
declare(strict_types=1);

use Prod\Importer;
use Prod\Text;
use Prod\XlsxReader;

$toDate = fn(float $v) => XlsxReader::serialToDate($v);

return [
    'clean collapses spaces and trims' => function () {
        assert_eq('Bana Dora', Text::clean(" Bana  Dora \u{00A0}"));
        assert_eq('mustjab raj vol 33', Text::key('Mustjab Raj  Vol 33'));
    },
    'numbers and codes from cells' => function () {
        assert_eq(6.4, Text::number('6.4'));
        assert_eq(1200.0, Text::number('1,200'));
        assert_eq(null, Text::number('abc'));
        assert_eq(null, Text::number(''));
        assert_eq('2153', Text::code(2153.0));
        assert_eq('2734+2741', Text::code('2734+2741'));
        assert_eq('12.5', Text::code(12.5));
    },
    'excel serial dates' => function () {
        assert_eq('2026-01-01', XlsxReader::serialToDate(46023.0));
        assert_eq('2026-10-04', XlsxReader::serialToDate(46299.0));
        assert_eq(null, XlsxReader::serialToDate(0.0));
        assert_eq(0, XlsxReader::colIndex('A4'));
        assert_eq(27, XlsxReader::colIndex('AB12'));
    },
    'typed dates are day first' => function () {
        assert_eq('2026-01-31', Importer::parseDateText('31/01/2026'));
        assert_eq('2026-02-03', Importer::parseDateText('03-02-26'));
        assert_eq('2026-05-01', Importer::parseDateText('01-May-26'));
        assert_eq('2026-10-04', Importer::parseDateText('2026-10-04'));
        assert_eq(null, Importer::parseDateText('31/02/2026'));
        assert_eq(null, Importer::parseDateText('soon'));
    },
    'row parsing cleans values like the 2026 sheet' => function () use ($toDate) {
        [$row, $err] = Importer::parseRow([
            'date' => 46023.0, 'lot_no' => 2153.0, 'quality' => 'Bana Dora ', 'party' => 'Umair Farooqi Vol 50', 'design' => 40976.0,
            'printed_mtr' => 160.0, 'calibration' => 'Muslim 72x68', 'ink' => '5.19', 'article' => 'Shirt', 'machine' => 'Ms', 'shift' => 'a',
            'operator' => 'Moin ',
        ], $toDate);
        assert_eq(null, $err);
        assert_eq('2026-01-01', $row['date']);
        assert_eq('2153', $row['lot_no']);
        assert_eq('40976', $row['design']);
        assert_eq('Bana Dora', $row['quality']);
        assert_eq(5.19, $row['ink']);
        assert_eq('A', $row['shift']);
        assert_eq('Moin', $row['operator']);
    },
    'row parsing rejects bad rows with a reason' => function () use ($toDate) {
        $base = ['date' => 46023.0, 'printed_mtr' => 100.0, 'machine' => 'MS', 'shift' => 'A', 'ink' => 5.0];
        assert_eq('Date is missing or not a date', Importer::parseRow(['date' => 'x'] + $base, $toDate)[1]);
        assert_eq('Printed Mtr is missing or not a number', Importer::parseRow(['printed_mtr' => null] + $base, $toDate)[1]);
        assert_eq('Machine is missing', Importer::parseRow(['machine' => ' '] + $base, $toDate)[1]);
        assert_eq('Shift "D" is not A, B or C', Importer::parseRow(['shift' => 'd'] + $base, $toDate)[1]);
        assert_eq('Ink use is not a number', Importer::parseRow(['ink' => 'n/a'] + $base, $toDate)[1]);
        [$row] = Importer::parseRow(['ink' => null] + $base, $toDate);
        assert_eq(null, $row['ink'], 'missing ink is allowed');
    },
    'heading row is found below a title' => function () {
        $rows = (function () {
            yield 1 => [0 => 'Digital Production Report'];
            yield 2 => [1 => 'Total', 5 => 123.0];
            yield 3 => ['Date', 'Lot #', 'Quality', 'Party Name', 'Design', 'Printed Mtr', 'CALIBRATION', 'Ink use', 'Article', 'Machine', 'Shift', 'Operator Namw', 'Total  Ink'];
            yield 4 => [46023.0];
        })();
        $map = Importer::findHeadings($rows);
        assert_eq(['date' => 0, 'lot_no' => 1, 'quality' => 2, 'party' => 3, 'design' => 4, 'printed_mtr' => 5, 'calibration' => 6, 'ink' => 7,
            'article' => 8, 'machine' => 9, 'shift' => 10, 'operator' => 11], $map);
        assert_eq(4, $rows->key(), 'generator continues after the headings');
    },
];
