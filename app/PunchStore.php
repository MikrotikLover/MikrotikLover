<?php
declare(strict_types=1);

namespace App;

/**
 * Stores raw punches (machine push, CSV/Excel import, barcode kiosk). Duplicates are ignored
 * (same person + time + source). Machine punches are mapped to employees by employees.machine_id;
 * unknown machine IDs are kept and mapped later when the ID is enrolled.
 */
final class PunchStore
{
    private array $machineMap = [];
    private array $codeMap = [];

    public function __construct()
    {
        foreach (Database::all('SELECT id, code, machine_id FROM employees') as $e) {
            if ($e['machine_id'] !== null) {
                $this->machineMap[(int)$e['machine_id']] = (int)$e['id'];
            }
            $this->codeMap[strtoupper($e['code'])] = (int)$e['id'];
        }
    }

    public function employeeByMachine(int $machineId): ?int
    {
        return $this->machineMap[$machineId] ?? null;
    }

    public function employeeByCode(string $code): ?int
    {
        return $this->codeMap[strtoupper(trim($code))] ?? null;
    }

    /**
     * @param array{machine_id?:?int, employee_id?:?int, ts:int, state?:?int, verify?:?int, device_sn?:?string, raw?:?string} $p
     * @return bool true when inserted, false when duplicate
     */
    public function add(array $p, string $source): bool
    {
        $machine = isset($p['machine_id']) ? (int)$p['machine_id'] : null;
        $emp = $p['employee_id'] ?? ($machine !== null ? $this->employeeByMachine($machine) : null);
        if ($machine === null && $emp === null) {
            throw new \InvalidArgumentException('Punch needs a machine ID or employee.');
        }
        $stmt = Database::run(
            'INSERT IGNORE INTO attendance_punches
                (machine_id, employee_id, punch_time, punch_state, verify_mode, source, person_key, device_sn, raw_line, created_by)
             VALUES (:m, :e, :t, :st, :v, :src, :pk, :sn, :raw, :cb)',
            [
                'm' => $machine, 'e' => $emp, 't' => date('Y-m-d H:i:s', $p['ts']),
                'st' => $p['state'] ?? null, 'v' => $p['verify'] ?? null, 'src' => $source,
                'pk' => $machine !== null ? 'M' . $machine : 'E' . $emp,
                'sn' => isset($p['device_sn']) ? mb_substr((string)$p['device_sn'], 0, 50) : null,
                'raw' => isset($p['raw']) ? mb_substr((string)$p['raw'], 0, 255) : null,
                'cb' => Auth::id(),
            ]
        );
        return $stmt->rowCount() > 0;
    }

    /**
     * Parse a date/time string from device exports.
     * $format: auto (Y-m-d first, then d/m/Y), dmy, mdy
     */
    public static function parseDateTime(string $s, string $format = 'auto'): ?int
    {
        $s = trim(preg_replace('/\s+/', ' ', $s));
        if ($s === '') {
            return null;
        }
        if (preg_match('/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/', $s, $m)) {
            [$y, $mo, $d] = [(int)$m[1], (int)$m[2], (int)$m[3]];
        } elseif (preg_match('/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?$/', $s, $m)) {
            $a = (int)$m[1];
            $b = (int)$m[2];
            $y = (int)$m[3];
            if ($y < 100) {
                $y += 2000;
            }
            $mdy = $format === 'mdy' || ($format === 'auto' && $b > 12 && $a <= 12);
            [$mo, $d] = $mdy ? [$a, $b] : [$b, $a];
        } else {
            return null;
        }
        $h = (int)$m[4];
        $i = (int)$m[5];
        $sec = isset($m[6]) && $m[6] !== '' ? (int)$m[6] : 0;
        if (!empty($m[7])) {
            $pm = strtolower($m[7]) === 'pm';
            if ($h === 12) {
                $h = $pm ? 12 : 0;
            } elseif ($pm) {
                $h += 12;
            }
        }
        if (!checkdate($mo, $d, $y) || $h > 23 || $i > 59 || $sec > 59) {
            return null;
        }
        return mktime($h, $i, $sec, $mo, $d, $y);
    }

    /**
     * Import rows from a device export.
     * Recognised headers: AC-No / PIN / User ID / Enroll No / Machine ID (machine id) or Code / Employee Code,
     * and Date Time / Check Time / Time (or separate Date + Time), optional State / Status.
     * Without a header row the ZKTeco attlog.dat layout is assumed: PIN, datetime, state, verify.
     */
    public function import(array $rows, string $format = 'auto'): array
    {
        $res = ['rows' => 0, 'inserted' => 0, 'duplicates' => 0, 'unmapped' => [], 'errors' => [], 'from' => null, 'to' => null];
        if (!$rows) {
            return $res;
        }
        $header = array_map(fn($h) => strtolower(trim(preg_replace('/[^A-Za-z0-9\/ ]/', ' ', (string)$h))), $rows[0]);
        $hasHeader = !self::parseDateTime(implode(' ', array_slice($rows[0], 1, 2)), $format)
            && !self::parseDateTime((string)($rows[0][1] ?? ''), $format)
            && count(array_filter($header, fn($h) => preg_match('/[a-z]/', $h))) >= 2;
        $col = ['machine' => null, 'code' => null, 'dt' => null, 'date' => null, 'time' => null, 'state' => null, 'verify' => null];
        if ($hasHeader) {
            $find = function (array $patterns) use ($header): ?int {
                foreach ($patterns as $p) {
                    foreach ($header as $i => $h) {
                        if (preg_match($p, trim(preg_replace('/\s+/', ' ', $h)))) {
                            return $i;
                        }
                    }
                }
                return null;
            };
            $col['machine'] = $find(['/^ac ?no$/', '/^pin$/', '/^enroll(ment)?( ?(no|number|id))?$/', '/^machine ?id$/', '/^user ?id$/', '/^badge( ?no)?$/', '/^(emp|employee) ?(no|id)$/']);
            $col['code'] = $find(['/^(emp|employee)? ?code$/']);
            $col['dt'] = $find(['/^(date ?time|check ?time|punch ?time|time ?stamp|log ?time|datetime)$/']);
            $col['date'] = $find(['/^(date|check ?date|punch ?date)$/']);
            $col['time'] = $find(['/^(time|check ?time|punch ?time)$/']);
            $col['state'] = $find(['/^(state|status|check ?type|in ?\/ ?out|io ?mode)$/']);
            if ($col['dt'] === null && $col['date'] !== null && $col['time'] === null) {
                $col['dt'] = $col['date']; // single "Date" column holding date+time
                $col['date'] = null;
            }
            if ($col['dt'] === null && $col['date'] === null && $col['time'] !== null) {
                $col['dt'] = $col['time']; // single "Time" column holding date+time (ZK "No, Name, Time" export)
            }
            if ($col['dt'] !== null) {
                $col['date'] = $col['time'] = null;
            }
            if (($col['machine'] === null && $col['code'] === null) || ($col['dt'] === null && ($col['date'] === null || $col['time'] === null))) {
                throw ApiException::validation(['file' => 'Columns not recognised. Need an ID column (AC-No / PIN / Enroll No / Machine ID or Code) and Date Time (or Date + Time). Found: ' . implode(', ', $rows[0])]);
            }
            $data = array_slice($rows, 1);
            $lineOffset = 2;
        } else {
            $col = ['machine' => 0, 'code' => null, 'dt' => 1, 'date' => null, 'time' => null, 'state' => 2, 'verify' => 3];
            $data = $rows;
            $lineOffset = 1;
        }

        foreach ($data as $n => $r) {
            $line = $n + $lineOffset;
            if (!array_filter($r, fn($v) => trim((string)$v) !== '')) {
                continue;
            }
            $res['rows']++;
            $dtStr = $col['dt'] !== null ? ($r[$col['dt']] ?? '') : trim(($r[$col['date']] ?? '') . ' ' . ($r[$col['time']] ?? ''));
            $ts = self::parseDateTime((string)$dtStr, $format);
            if ($ts === null) {
                if (count($res['errors']) < 20) {
                    $res['errors'][] = "Line $line: cannot read date/time \"$dtStr\"";
                }
                continue;
            }
            $p = ['ts' => $ts, 'raw' => implode(',', $r)];
            if ($col['code'] !== null && trim((string)($r[$col['code']] ?? '')) !== '') {
                $emp = $this->employeeByCode((string)$r[$col['code']]);
                if (!$emp) {
                    $res['unmapped']['code ' . $r[$col['code']]] = true;
                    continue;
                }
                $p['employee_id'] = $emp;
            } else {
                $mid = trim((string)($r[$col['machine']] ?? ''));
                if (!ctype_digit($mid)) {
                    if (count($res['errors']) < 20) {
                        $res['errors'][] = "Line $line: invalid machine ID \"$mid\"";
                    }
                    continue;
                }
                $p['machine_id'] = (int)$mid;
                if (!$this->employeeByMachine((int)$mid)) {
                    $res['unmapped']['machine ' . $mid] = true;
                }
            }
            if ($col['state'] !== null && isset($r[$col['state']]) && is_numeric($r[$col['state']])) {
                $p['state'] = (int)$r[$col['state']];
            }
            if ($col['verify'] !== null && isset($r[$col['verify']]) && is_numeric($r[$col['verify']])) {
                $p['verify'] = (int)$r[$col['verify']];
            }
            if ($this->add($p, 'csv')) {
                $res['inserted']++;
            } else {
                $res['duplicates']++;
            }
            $d = date('Y-m-d', $ts);
            $res['from'] = $res['from'] === null || $d < $res['from'] ? $d : $res['from'];
            $res['to'] = $res['to'] === null || $d > $res['to'] ? $d : $res['to'];
        }
        $res['unmapped'] = array_keys($res['unmapped']);
        return $res;
    }
}
