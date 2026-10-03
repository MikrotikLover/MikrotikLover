<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\AttendanceEngine;
use App\Audit;
use App\Database;
use App\LiveAttendance;
use App\PayrollLock;
use App\PunchStore;
use App\Request;
use App\SpreadsheetReader;
use App\Validator;

final class AttendanceController
{
    /** Daily Attendance Post: {from, to, department_id?, overwrite_manual?} */
    public function post(Request $r): array
    {
        $d = Validator::make($r->body(), [
            'from' => 'required|date', 'to' => 'required|date|after_or_equal:from',
            'department_id' => 'nullable|int|exists:departments', 'overwrite_manual' => 'bool',
        ], ['from' => 'From date', 'to' => 'To date']);
        if ((strtotime($d['to']) - strtotime($d['from'])) / 86400 > 31) {
            throw ApiException::validation(['to' => 'Post at most 31 days at a time.']);
        }
        if ($d['from'] > date('Y-m-d')) {
            throw ApiException::validation(['from' => 'Cannot post future dates.']);
        }
        @set_time_limit(300);
        $sum = Database::transaction(fn() => (new AttendanceEngine($d['from'], $d['to']))->post($d['from'], $d['to'], [
            'department_id' => $d['department_id'], 'overwrite_manual' => !empty($d['overwrite_manual']),
        ]));
        Audit::log('post', 'attendance_daily', null, null, $d + ['summary' => $sum]);
        $sum['unprocessed_punches'] = (int)Database::value('SELECT COUNT(*) FROM attendance_punches WHERE is_processed = 0 AND employee_id IS NOT NULL AND punch_time < ?', [$d['from'] . ' 00:00:00']);
        return $sum;
    }

    /** Status of raw punches: pending (unprocessed) dates and unmapped machine IDs. */
    public function punchStatus(Request $r): array
    {
        return [
            'pending' => Database::all(
                'SELECT DATE(punch_time) AS punch_date, COUNT(*) AS punches FROM attendance_punches
                  WHERE is_processed = 0 AND employee_id IS NOT NULL GROUP BY DATE(punch_time) ORDER BY punch_date DESC LIMIT 60'
            ),
            'unmapped' => Database::all(
                'SELECT machine_id, COUNT(*) AS punches, MIN(punch_time) AS first_punch, MAX(punch_time) AS last_punch,
                        GROUP_CONCAT(DISTINCT device_sn) AS devices
                   FROM attendance_punches WHERE employee_id IS NULL GROUP BY machine_id ORDER BY machine_id'
            ),
        ];
    }

    /** Daily rows for a range, filterable (exceptions = flagged / late / missing out / absent). */
    public function daily(Request $r): array
    {
        $from = $r->query('from') ?: date('Y-m-d');
        $to = $r->query('to') ?: $from;
        foreach ([$from, $to] as $dt) {
            if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', (string)$dt)) {
                throw ApiException::validation(['from' => 'Invalid date.']);
            }
        }
        $where = ['a.att_date BETWEEN :f AND :t'];
        $params = ['f' => $from, 't' => $to];
        if ($dept = $r->queryInt('department_id')) {
            $where[] = 'e.department_id = :d';
            $params['d'] = $dept;
        }
        if ($emp = $r->queryInt('employee_id')) {
            $where[] = 'a.employee_id = :e';
            $params['e'] = $emp;
        }
        $filter = (string)$r->query('filter', 'exceptions');
        $where[] = match ($filter) {
            'flagged' => 'a.is_flagged = 1',
            'late' => 'a.late_minutes > 0',
            'absent' => "a.status = 'A'",
            'all' => '1 = 1',
            default => "(a.is_flagged = 1 OR (a.time_in IS NOT NULL AND a.time_out IS NULL) OR a.status = 'A')",
        };
        return Database::all(
            'SELECT a.*, e.code, e.name, e.name_ur, e.emp_type, d.name AS department, s.code AS shift_code,
                    v.vr_no
               FROM attendance_daily a
               JOIN employees e ON e.id = a.employee_id
               JOIN departments d ON d.id = e.department_id
          LEFT JOIN shifts s ON s.id = a.shift_id
          LEFT JOIN attendance_vouchers v ON v.id = a.voucher_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY a.att_date, d.name, e.code LIMIT 2000',
            $params
        );
    }

    /** Edit one daily row (exception fixing). Body: status, shift_id, time_in, time_out, remarks */
    public function updateDaily(Request $r): array
    {
        $a = Database::one('SELECT * FROM attendance_daily WHERE id = ?', [$r->id()]);
        if (!$a) {
            throw ApiException::notFound('Attendance row');
        }
        $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$a['employee_id']]);
        $engine = new AttendanceEngine($a['att_date'], $a['att_date']);
        $row = $engine->manualRow($emp, $a['att_date'], $r->body());
        Database::transaction(function () use ($row, $a) {
            $id = AttendanceEngine::saveRow($row, $a['voucher_id'] ? (int)$a['voucher_id'] : null);
            Audit::log('update', 'attendance_daily', $id, $a, $row);
        });
        return Database::one('SELECT * FROM attendance_daily WHERE id = ?', [$a['id']]);
    }

    public function destroyDaily(Request $r): array
    {
        $a = Database::one('SELECT a.*, e.emp_type FROM attendance_daily a JOIN employees e ON e.id = a.employee_id WHERE a.id = ?', [$r->id()]);
        if (!$a) {
            throw ApiException::notFound('Attendance row');
        }
        PayrollLock::assertOpen($a['emp_type'], $a['att_date'], 'Attendance', (int)$a['employee_id']);
        Database::transaction(function () use ($a) {
            Database::run('DELETE FROM overtime WHERE employee_id = ? AND ot_date = ? AND salary_sheet_id IS NULL', [$a['employee_id'], $a['att_date']]);
            Database::run('DELETE FROM attendance_daily WHERE id = ?', [$a['id']]);
            Audit::log('delete', 'attendance_daily', (int)$a['id'], $a, null);
        });
        return ['deleted' => true];
    }

    /** Raw punches of one employee around a date (for checking exceptions). */
    public function punches(Request $r): array
    {
        $emp = $r->queryInt('employee_id');
        $date = (string)$r->query('date', date('Y-m-d'));
        if (!$emp || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            throw ApiException::validation(['employee_id' => 'Employee and date are required.']);
        }
        return Database::all(
            'SELECT id, punch_time, punch_state, source, device_sn, is_processed FROM attendance_punches
              WHERE employee_id = ? AND punch_time BETWEEN ? AND ? ORDER BY punch_time',
            [$emp, date('Y-m-d 00:00:00', strtotime("$date -1 day")), date('Y-m-d 23:59:59', strtotime("$date +1 day"))]
        );
    }

    /** CSV / Excel import of device logs (multipart: file, date_format=auto|dmy|mdy). */
    public function import(Request $r): array
    {
        $f = $_FILES['file'] ?? null;
        if (!$f || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($f['tmp_name'])) {
            throw ApiException::validation(['file' => 'Choose a CSV or Excel (.xlsx) file.']);
        }
        if ($f['size'] > 10 * 1024 * 1024) {
            throw ApiException::validation(['file' => 'File is larger than 10 MB.']);
        }
        $format = in_array($r->input('date_format'), ['dmy', 'mdy'], true) ? $r->input('date_format') : 'auto';
        $rows = SpreadsheetReader::read($f['tmp_name'], (string)$f['name']);
        @set_time_limit(300);
        $res = Database::transaction(fn() => (new PunchStore())->import($rows, $format));
        Audit::log('import', 'attendance_punches', null, null, ['file' => $f['name']] + array_diff_key($res, ['errors' => 1]));
        return $res;
    }

    public function live(Request $r): array
    {
        return LiveAttendance::data();
    }

    /** Kiosk / TV links (tokens created on first use). */
    public function screens(Request $r): array
    {
        return [
            'kiosk_url' => 'kiosk.php?token=' . LiveAttendance::token('kiosk_token'),
            'tv_url'    => 'tv.php?token=' . LiveAttendance::token('tv_token'),
            'adms_url'  => '/iclock/cdata',
        ];
    }

    public function regenerate(Request $r): array
    {
        $which = $r->input('which');
        if (!in_array($which, ['kiosk', 'tv'], true)) {
            throw ApiException::validation(['which' => 'Choose kiosk or tv.']);
        }
        LiveAttendance::token($which . '_token', true);
        Audit::log('update', 'settings', null, null, [$which . '_token' => '(regenerated)']);
        return $this->screens($r);
    }
}
