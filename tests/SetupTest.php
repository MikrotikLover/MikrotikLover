<?php
declare(strict_types=1);

// Unit tests for batch 1 logic that does not need a database.

use App\ApiException;
use App\Barcode;
use App\Controllers\ShiftController;
use App\Validator;

require_once dirname(__DIR__) . '/migrations/migrate.php';

return [
    'CNIC format accepted and normalised from 13 digits' => function () {
        $v = Validator::make(['cnic' => '3520212345671'], ['cnic' => 'nullable|cnic']);
        assert_eq('35202-1234567-1', $v['cnic']);
        $v = Validator::make(['cnic' => '35202-1234567-1'], ['cnic' => 'nullable|cnic']);
        assert_eq('35202-1234567-1', $v['cnic']);
    },
    'CNIC with wrong length rejected' => function () {
        $e = assert_throws(fn() => Validator::make(['cnic' => '35202-123456-1'], ['cnic' => 'cnic']), ApiException::class);
        assert_eq(422, $e->status());
        assert_true(isset($e->errors()['cnic']));
    },
    'required, max length and empty-string-to-null' => function () {
        $e = assert_throws(fn() => Validator::make(['name' => '  '], ['name' => 'required|string|max:5']), ApiException::class);
        assert_true(isset($e->errors()['name']));
        assert_throws(fn() => Validator::make(['name' => 'abcdef'], ['name' => 'required|string|max:5']), ApiException::class);
        assert_eq(['remarks' => null], Validator::make(['remarks' => ''], ['remarks' => 'nullable|string']));
    },
    'dates: valid format, before / after_or_equal' => function () {
        assert_throws(fn() => Validator::make(['d' => '2026-02-30'], ['d' => 'date']), ApiException::class);
        $rules = ['joining_date' => 'required|date', 'leaving_date' => 'nullable|date|after_or_equal:joining_date', 'dob' => 'nullable|date|before:joining_date'];
        $ok = Validator::make(['joining_date' => '2026-01-01', 'leaving_date' => '2026-01-01', 'dob' => '2000-05-05'], $rules);
        assert_eq('2026-01-01', $ok['leaving_date']);
        $e = assert_throws(fn() => Validator::make(['joining_date' => '2026-01-01', 'leaving_date' => '2025-12-31'], $rules), ApiException::class);
        assert_true(isset($e->errors()['leaving_date']));
        $e = assert_throws(fn() => Validator::make(['joining_date' => '2026-01-01', 'dob' => '2026-01-01'], $rules), ApiException::class);
        assert_true(isset($e->errors()['dob']));
    },
    'numbers, booleans, time and in:' => function () {
        $v = Validator::make(['a' => '1,500.50', 'b' => '7', 'c' => 'on', 't' => '8:05', 'x' => 'bank'],
            ['a' => 'num', 'b' => 'int|min:1|max:10', 'c' => 'bool', 't' => 'time', 'x' => 'in:cash,bank']);
        assert_eq(1500.5, $v['a']);
        assert_eq(7, $v['b']);
        assert_eq(1, $v['c']);
        assert_eq('08:05:00', $v['t']);
        assert_throws(fn() => Validator::make(['t' => '24:00'], ['t' => 'time']), ApiException::class);
        assert_throws(fn() => Validator::make(['b' => '11'], ['b' => 'int|max:10']), ApiException::class);
        assert_throws(fn() => Validator::make(['x' => 'cheque'], ['x' => 'in:cash,bank']), ApiException::class);
    },
    'shift span handles overnight shifts' => function () {
        assert_eq(480, ShiftController::spanMinutes('09:00:00', '17:00:00'));
        assert_eq(720, ShiftController::spanMinutes('20:00:00', '08:00:00'));
        assert_eq(1440, ShiftController::spanMinutes('07:00:00', '07:00:00'));
    },
    'Code 128 barcode: set C for even digits, set B otherwise, checksum' => function () {
        // "0001" -> start C(105), 00, 01, checksum (105 + 1*0 + 2*1) % 103 = 4
        $m = Barcode::modules('0001');
        assert_eq(10 + 11 * 4 + 13 + 10, strlen($m));
        assert_eq('11010011100', substr($m, 10, 11), 'start C');
        assert_eq('10010001100', substr($m, 10 + 33, 11), 'checksum symbol 4');
        $m = Barcode::modules('A1'); // start B(104), A=33, 1=17, check (104+33+34)%103=68
        assert_eq('11010010000', substr($m, 10, 11), 'start B');
        assert_eq('10000100110', substr($m, 10 + 33, 11), 'checksum symbol 68');
        assert_true(str_contains(Barcode::svg('0001'), '<svg'));
        assert_throws(fn() => Barcode::modules('اردو'), InvalidArgumentException::class);
    },
    'SQL splitter ignores semicolons in strings and comments' => function () {
        $sql = "-- comment; here\nINSERT INTO t VALUES ('a;b', \"c;d\"); /* x; y */ SELECT 1;\n# hash; comment\nSELECT 'it''s; ok'";
        $parts = Migrator::split($sql);
        assert_eq(3, count($parts));
        assert_eq("INSERT INTO t VALUES ('a;b', \"c;d\")", $parts[0]);
        assert_eq("SELECT 'it''s; ok'", $parts[2]);
    },
];
