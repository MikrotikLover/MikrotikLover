<?php
declare(strict_types=1);

/**
 * ZKTeco ADMS / "push" protocol endpoint (no shell access needed - the device calls us over HTTP).
 * Configure the device: Comm. → Cloud Server Setting → Server address = your domain, port 80 (or 443
 * on models that support HTTPS), "HTTPS" off unless supported. The device then calls:
 *
 *   GET  /iclock/cdata?SN=XXXX&options=all...      handshake → we return options (incl. ATTLOGStamp)
 *   POST /iclock/cdata?SN=XXXX&table=ATTLOG&Stamp=n body lines: PIN \t YYYY-MM-DD HH:MM:SS \t state \t verify ...
 *   GET  /iclock/getrequest?SN=XXXX                command poll → "OK" (no commands)
 *   POST /iclock/devicecmd?SN=XXXX                 command result → "OK"
 *
 * Unknown serial numbers are registered automatically as INACTIVE; their logs are refused (the
 * device keeps them and retries) until an admin activates the device under Attendance → Devices.
 * Punches are stored raw and mapped by employees.machine_id; each pushed batch is posted in real time.
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\AttendanceEngine;
use App\Database;
use App\Http;
use App\PunchStore;

Http::noStore();
header('Content-Type: text/plain; charset=utf-8');

function iclock_reply(string $text, int $status = 200): never
{
    http_response_code($status);
    echo $text;
    exit;
}

try {
    $sn = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($_GET['SN'] ?? $_GET['sn'] ?? ''));
    if ($sn === '') {
        iclock_reply('ERROR: missing SN', 400);
    }
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?: '';
    $endpoint = strtolower(basename(preg_replace('/\.aspx$/i', '', $path)));
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    $device = Database::one('SELECT * FROM devices WHERE serial_no = ?', [$sn]);
    if (!$device) {
        Database::insert('devices', ['serial_no' => $sn, 'name' => 'New device ' . $sn, 'location' => 'Auto-registered, activate to accept punches', 'is_active' => 0]);
        $device = Database::one('SELECT * FROM devices WHERE serial_no = ?', [$sn]);
    }
    Database::update('devices', ['last_seen_at' => date('Y-m-d H:i:s')], 'id = :id', ['id' => $device['id']]);
    $active = (int)$device['is_active'] === 1;

    if ($endpoint === 'getrequest' || $endpoint === 'devicecmd') {
        iclock_reply('OK');
    }
    if ($endpoint !== 'cdata') {
        iclock_reply('OK');
    }

    if ($method === 'GET') {
        $stamp = $device['last_stamp'] ?: '0';
        iclock_reply(implode("\r\n", [
            "GET OPTION FROM: $sn",
            "ATTLOGStamp=$stamp",
            'OPERLOGStamp=9999',
            'ATTPHOTOStamp=None',
            'ErrorDelay=60',
            'Delay=30',
            'TransTimes=00:00;14:05',
            'TransInterval=1',
            'TransFlag=TransData AttLog',
            'TimeZone=5',
            'Realtime=1',
            'Encrypt=None',
        ]) . "\r\n");
    }

    // POST data
    $table = strtoupper((string)($_GET['table'] ?? ''));
    if ($table !== 'ATTLOG') {
        iclock_reply('OK'); // OPERLOG, ATTPHOTO, user info ... not needed
    }
    if (!$active) {
        iclock_reply('ERROR: device not enabled', 403); // device keeps the logs and retries later
    }

    $body = (string)file_get_contents('php://input');
    $store = new PunchStore();
    $count = 0;
    $latest = []; // employee_id => latest ts in this batch
    Database::transaction(function () use ($body, $store, $sn, &$count, &$latest) {
        foreach (preg_split('/\r\n|\r|\n/', $body) as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $f = preg_split('/\t/', $line);
            if (count($f) < 2 || !ctype_digit(trim($f[0]))) {
                continue;
            }
            $ts = PunchStore::parseDateTime($f[1]);
            if ($ts === null) {
                continue;
            }
            $machine = (int)trim($f[0]);
            $inserted = $store->add([
                'machine_id' => $machine, 'ts' => $ts,
                'state' => isset($f[2]) && is_numeric($f[2]) ? (int)$f[2] : null,
                'verify' => isset($f[3]) && is_numeric($f[3]) ? (int)$f[3] : null,
                'device_sn' => $sn, 'raw' => $line,
            ], 'machine');
            $count++;
            $emp = $store->employeeByMachine($machine);
            if ($inserted && $emp) {
                $latest[$emp] = max($latest[$emp] ?? 0, $ts);
            }
        }
    });
    if (isset($_GET['Stamp']) && preg_match('/^\d+$/', (string)$_GET['Stamp'])) {
        Database::update('devices', ['last_stamp' => (string)$_GET['Stamp']], 'id = :id', ['id' => $device['id']]);
    }
    // Real-time post (bounded: only employees in this batch, only recent punches)
    foreach ($latest as $emp => $ts) {
        if ($ts > time() - 3 * 86400) {
            try {
                Database::transaction(fn() => AttendanceEngine::postPunch($emp, $ts));
            } catch (Throwable $e) {
                error_log('[iclock] post ' . $emp . ': ' . $e->getMessage());
            }
        }
    }
    iclock_reply('OK: ' . $count);
} catch (Throwable $e) {
    error_log('[iclock] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    iclock_reply('ERROR: server', 500);
}
