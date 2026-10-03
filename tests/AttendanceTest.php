<?php
declare(strict_types=1);

// Attendance engine rules, manual time handling, device date parsing and spreadsheet reading.
// (No database writes; the engine is created without its DB-loading constructor.)

use App\ApiException;
use App\AttendanceEngine;
use App\PunchStore;
use App\SpreadsheetReader;

function engine(int $maxHours = 16): AttendanceEngine
{
    $e = (new ReflectionClass(AttendanceEngine::class))->newInstanceWithoutConstructor();
    $p = new ReflectionProperty(AttendanceEngine::class, 'maxHours');
    $p->setValue($e, $maxHours);
    return $e;
}

const SHIFT_G = ['id' => 1, 'start_time' => '09:00:00', 'end_time' => '17:00:00', 'is_overnight' => 0, 'break_minutes' => 60,
                 'grace_minutes' => 10, 'half_day_minutes' => 210, 'min_ot_minutes' => 30];
const SHIFT_N = ['id' => 3, 'start_time' => '20:00:00', 'end_time' => '08:00:00', 'is_overnight' => 1, 'break_minutes' => 60,
                 'grace_minutes' => 10, 'half_day_minutes' => 330, 'min_ot_minutes' => 30];

$ts = fn(string $s) => strtotime($s);

return [
    'work hours computed from in/out with break deducted' => function () use ($ts) {
        $r = engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:04'), $ts('2026-09-01 17:37'));
        assert_eq(453, $r['work_minutes']);   // 513 elapsed - 60 break
        assert_eq(0, $r['late_minutes']);     // 4 min is inside 10 min grace
        assert_eq(37, $r['ot_minutes']);      // 37 min after shift end >= 30 min minimum
        assert_eq(0, $r['early_minutes']);
        assert_eq(false, $r['half_day']);
    },
    'late beyond grace counts full minutes; short OT ignored; early leave' => function () use ($ts) {
        $r = engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:25'), $ts('2026-09-01 17:20'));
        assert_eq(25, $r['late_minutes']);
        assert_eq(0, $r['ot_minutes']);
        $r = engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:00'), $ts('2026-09-01 16:30'));
        assert_eq(30, $r['early_minutes']);
    },
    'half day when worked minutes below threshold (no break under half shift)' => function () use ($ts) {
        $r = engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:00'), $ts('2026-09-01 12:00'));
        assert_eq(180, $r['work_minutes']);
        assert_eq(true, $r['half_day']);
    },
    'overnight shift ends next morning' => function () use ($ts) {
        $r = engine()->compute(SHIFT_N, '2026-09-01', $ts('2026-09-01 20:00'), $ts('2026-09-02 08:45'));
        assert_eq(705, $r['work_minutes']);   // 765 - 60
        assert_eq(45, $r['ot_minutes']);
    },
    'rest day / holiday work: all worked time is an OT candidate, no late' => function () use ($ts) {
        $r = engine()->compute(SHIFT_G, '2026-09-06', $ts('2026-09-06 10:00'), $ts('2026-09-06 14:00'), 'R');
        assert_eq(240, $r['ot_minutes']);
        assert_eq(0, $r['late_minutes']);
    },
    'time out must be after time in; > 24 h rejected; > max hours flagged' => function () use ($ts) {
        assert_throws(fn() => engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 17:00'), $ts('2026-09-01 09:00')), ApiException::class);
        assert_throws(fn() => engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:00'), $ts('2026-09-02 10:00')), ApiException::class);
        $r = engine(16)->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 06:00'), $ts('2026-09-01 23:30'));
        assert_eq(1, $r['is_flagged']);
        assert_true(str_contains((string)$r['flag_reason'], '16 hours'));
    },
    'missing time out is flagged with zero work' => function () use ($ts) {
        $r = engine()->compute(SHIFT_G, '2026-09-01', $ts('2026-09-01 09:00'), null);
        assert_eq(0, $r['work_minutes']);
        assert_eq('Missing time out', $r['flag_reason']);
    },
    'manual times: out before in crosses midnight; equal times and out without in rejected' => function () {
        [$in, $out] = AttendanceEngine::manualTimes('2026-09-01', '20:00:00', '08:00:00', SHIFT_N);
        assert_eq('2026-09-02 08:00', date('Y-m-d H:i', $out));
        assert_eq('2026-09-01 20:00', date('Y-m-d H:i', $in));
        // spec 2.4: time out earlier than time in = crossing midnight, whatever the shift
        [$in, $out] = AttendanceEngine::manualTimes('2026-09-01', '17:00:00', '09:00:00', SHIFT_G);
        assert_eq('2026-09-02 09:00', date('Y-m-d H:i', $out));
        assert_throws(fn() => AttendanceEngine::manualTimes('2026-09-01', '09:00:00', '09:00:00', SHIFT_G), ApiException::class);
        assert_throws(fn() => AttendanceEngine::manualTimes('2026-09-01', null, '09:00:00', SHIFT_G), ApiException::class);
    },
    'shift span' => function () {
        assert_eq(480, AttendanceEngine::span(SHIFT_G));
        assert_eq(720, AttendanceEngine::span(SHIFT_N));
    },
    'device date formats (ISO, d/m/Y, m/d/Y with AM/PM)' => function () {
        assert_eq('2026-09-01 08:05:00', date('Y-m-d H:i:s', PunchStore::parseDateTime('2026-09-01 08:05:00')));
        assert_eq('2026-09-01 08:05:00', date('Y-m-d H:i:s', PunchStore::parseDateTime('01/09/2026 08:05')));          // auto = day first
        assert_eq('2026-01-09 08:05:00', date('Y-m-d H:i:s', PunchStore::parseDateTime('01/09/2026 08:05', 'mdy')));
        assert_eq('2026-09-13 20:05:00', date('Y-m-d H:i:s', PunchStore::parseDateTime('09/13/2026 8:05 PM')));        // 13 cannot be a month
        assert_eq('2026-09-01 00:10:00', date('Y-m-d H:i:s', PunchStore::parseDateTime('1-9-26 12:10 AM')));
        assert_eq(null, PunchStore::parseDateTime('31/02/2026 08:00'));
        assert_eq(null, PunchStore::parseDateTime('hello'));
    },
    'CSV / tab reader detects delimiter and strips BOM' => function () {
        $rows = SpreadsheetReader::delimited("\xEF\xBB\xBFAC-No,Name,Time\r\n3,Shahid,2026-09-01 08:02\r\n\r\n4,\"Naveed, A\",2026-09-01 20:10\n");
        assert_eq(3, count($rows));
        assert_eq('AC-No', $rows[0][0]);
        assert_eq('Naveed, A', $rows[2][1]);
        $rows = SpreadsheetReader::delimited("3\t2026-09-01 08:02:11\t0\t1\n");
        assert_eq(['3', '2026-09-01 08:02:11', '0', '1'], $rows[0]);
    },
    'XLSX reader: shared strings, numbers and date cells' => function () {
        if (!class_exists(ZipArchive::class)) {
            return; // ZipArchive not installed in this PHP build
        }
        $f = tempnam(sys_get_temp_dir(), 'xl') . '.xlsx';
        $z = new ZipArchive();
        $z->open($f, ZipArchive::CREATE);
        $z->addFromString('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>');
        $z->addFromString('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>');
        $z->addFromString('xl/sharedStrings.xml', '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>PIN</t></si><si><t>Check Time</t></si></sst>');
        $z->addFromString('xl/styles.xml', '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs><xf numFmtId="0"/><xf numFmtId="22"/></cellXfs></styleSheet>');
        $z->addFromString('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            . '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
            . '<row r="2"><c r="A2"><v>3</v></c><c r="B2" s="1"><v>46266.3347222222</v></c></row></sheetData></worksheet>');
        $z->close();
        $rows = SpreadsheetReader::xlsx($f);
        unlink($f);
        assert_eq(['PIN', 'Check Time'], $rows[0]);
        assert_eq('3', $rows[1][0]);
        assert_eq('2026-09-01 08:02:00', $rows[1][1]);
    },
];
