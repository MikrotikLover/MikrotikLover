<?php
declare(strict_types=1);

/**
 * Barcode attendance kiosk. Runs on a PC/tablet at the gate with a USB barcode scanner
 * (scanner types the employee code + Enter). Protected by a secret token instead of a login,
 * so it never times out:  /kiosk.php?token=...  (link under Attendance → Devices & Screens)
 *
 * Each scan stores a raw punch (source "barcode") and posts that employee's day immediately:
 * the first scan of the shift is IN, the next is OUT.
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\AttendanceEngine;
use App\Database;
use App\Http;
use App\LiveAttendance;
use App\PunchStore;
use App\Settings;
use App\Storage;

Http::noStore();
Http::securityHeaders();
$token = (string)($_GET['token'] ?? '');
if (!LiveAttendance::checkToken('kiosk_token', $token)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    exit("Kiosk link is invalid or has been regenerated. Ask the administrator for the current link.\n");
}

// Employee photo
if (isset($_GET['photo'])) {
    $file = Storage::file('photos', (string)Database::value('SELECT photo_file FROM employees WHERE id = ?', [(int)$_GET['photo']]));
    if (!$file) {
        http_response_code(404);
        exit;
    }
    header('Content-Type: image/jpeg');
    header('Cache-Control: private, max-age=3600');
    readfile($file);
    exit;
}

// Scan
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    header('Content-Type: application/json; charset=utf-8');
    $reply = function (array $data, int $status = 200): never {
        http_response_code($status);
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
        exit;
    };
    try {
        $in = json_decode((string)file_get_contents('php://input'), true) ?: [];
        $code = strtoupper(trim(preg_replace('/[^\x20-\x7E]/', '', (string)($in['code'] ?? ''))));
        if ($code === '') {
            $reply(['ok' => false, 'error' => 'Empty scan.'], 422);
        }
        $emp = Database::one(
            'SELECT e.*, d.name AS department, g.name AS designation FROM employees e
               JOIN departments d ON d.id = e.department_id JOIN designations g ON g.id = e.designation_id
              WHERE UPPER(e.code) = ?',
            [$code]
        );
        $today = date('Y-m-d');
        if (!$emp) {
            $reply(['ok' => false, 'error' => "Card $code is not registered."], 404);
        }
        if ($emp['status'] !== 'active' || $emp['joining_date'] > $today || ($emp['leaving_date'] && $emp['leaving_date'] < $today)) {
            $reply(['ok' => false, 'error' => "{$emp['code']} {$emp['name']} is not an active employee."], 403);
        }
        $repeat = max(10, (int)Settings::get('scan_repeat_seconds', 60));
        $last = Database::value('SELECT MAX(punch_time) FROM attendance_punches WHERE employee_id = ?', [$emp['id']]);
        $now = time();
        if ($last && $now - strtotime($last) < $repeat) {
            $reply(['ok' => false, 'error' => "{$emp['name']}: already scanned at " . date('h:i:s A', strtotime($last)) . '.', 'repeat' => true], 409);
        }
        $row = Database::transaction(function () use ($emp, $now) {
            (new PunchStore())->add(['employee_id' => (int)$emp['id'], 'ts' => $now, 'device_sn' => 'KIOSK', 'raw' => 'kiosk ' . ($_SERVER['REMOTE_ADDR'] ?? '')], 'barcode');
            return AttendanceEngine::postPunch((int)$emp['id'], $now);
        });
        $direction = $row && $row['time_out'] && strtotime($row['time_out']) >= $now - 5 ? 'OUT' : 'IN';
        $reply([
            'ok' => true,
            'direction' => $direction,
            'time' => date('h:i A', $now),
            'employee' => [
                'id' => (int)$emp['id'], 'code' => $emp['code'], 'name' => $emp['name'], 'name_ur' => $emp['name_ur'],
                'department' => $emp['department'], 'designation' => $emp['designation'], 'has_photo' => (bool)$emp['photo_file'],
            ],
            'outside' => $row === null, // punch stored, but it is outside every shift window
            'late_minutes' => $direction === 'IN' ? (int)($row['late_minutes'] ?? 0) : 0,
            'work' => $direction === 'OUT' && $row ? sprintf('%d:%02d', intdiv((int)$row['work_minutes'], 60), (int)$row['work_minutes'] % 60) : null,
        ]);
    } catch (Throwable $e) {
        error_log('[kiosk] ' . $e->getMessage());
        $reply(['ok' => false, 'error' => 'Server error - please try again.'], 500);
    }
}

$company = Http::e((string)Settings::get('company_name', ''));
$companyUr = Http::e((string)Settings::get('company_name_ur', ''));
$tokenJs = json_encode($token);
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attendance Kiosk</title>
<link rel="icon" href="data:,">
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0f172a; color: #e2e8f0; font: 18px/1.4 system-ui, Segoe UI, Arial, sans-serif; display: flex; flex-direction: column; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 16px 28px; background: #111827; border-bottom: 1px solid #1f2937; }
  header .co { font-size: 24px; font-weight: 700; } header .ur { font-family: "Noto Nastaliq Urdu", serif; color: #94a3b8; font-size: 18px; }
  #clock { font-size: 40px; font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; } #date { color: #94a3b8; font-size: 16px; text-align: right; }
  main { flex: 1; display: grid; grid-template-columns: 1fr 380px; gap: 24px; padding: 24px 28px; }
  .card { background: #1e293b; border-radius: 16px; padding: 28px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; min-height: 420px; transition: background .2s; }
  .card.in { background: #064e3b; } .card.out { background: #1e3a8a; } .card.err { background: #7f1d1d; }
  .photo { width: 180px; height: 240px; border-radius: 12px; background: #334155 center/cover no-repeat; margin-bottom: 18px; }
  .dir { font-size: 64px; font-weight: 800; letter-spacing: 4px; } .name { font-size: 34px; font-weight: 700; }
  .name-ur { font-family: "Noto Nastaliq Urdu", serif; font-size: 28px; line-height: 2; } .meta { color: #cbd5e1; font-size: 20px; }
  .hint { color: #94a3b8; font-size: 24px; }
  input#scan { width: 100%; font-size: 22px; padding: 12px 16px; border-radius: 10px; border: 2px solid #334155; background: #0b1220; color: #fff; margin-bottom: 14px; }
  input#scan:focus { outline: none; border-color: #60a5fa; }
  .log h2 { margin: 0 0 10px; font-size: 18px; color: #94a3b8; font-weight: 600; }
  .log ul { list-style: none; margin: 0; padding: 0; } .log li { display: flex; justify-content: space-between; padding: 8px 10px; border-bottom: 1px solid #1f2937; font-size: 16px; }
  .log li b.IN { color: #34d399; } .log li b.OUT { color: #60a5fa; } .log li.bad { color: #fca5a5; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } .dir { font-size: 44px; } .name { font-size: 26px; } }
</style>
</head>
<body>
<header>
  <div><div class="co"><?= $company ?></div><div class="ur"><?= $companyUr ?></div></div>
  <div><div id="clock">--:--</div><div id="date"></div></div>
</header>
<main>
  <section id="card" class="card"><div class="hint">Scan your ID card<br><span class="name-ur">اپنا کارڈ اسکین کریں</span></div></section>
  <aside class="log">
    <input id="scan" autocomplete="off" placeholder="Scan card or type code + Enter" autofocus>
    <h2>Recent scans</h2>
    <ul id="log"></ul>
  </aside>
</main>
<script>
const TOKEN = <?= $tokenJs ?>;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tz = { timeZone: 'Asia/Karachi' };
function tick() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('date').textContent = d.toLocaleDateString('en-GB', { ...tz, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
tick(); setInterval(tick, 1000);
let audio;
function beep(ok) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = ok ? 880 : 220; o.connect(g); g.connect(audio.destination);
    g.gain.value = 0.15; o.start(); o.stop(audio.currentTime + (ok ? 0.15 : 0.5));
  } catch (e) { /* no audio */ }
}
let resetTimer;
function show(html, cls) {
  const c = $('card');
  c.className = 'card ' + (cls || '');
  c.innerHTML = html;
  clearTimeout(resetTimer);
  resetTimer = setTimeout(() => show('<div class="hint">Scan your ID card<br><span class="name-ur">اپنا کارڈ اسکین کریں</span></div>', ''), 6000);
}
function log(text, dir, bad) {
  const li = document.createElement('li');
  if (bad) li.className = 'bad';
  li.innerHTML = `<span>${esc(text)}</span>${dir ? `<b class="${dir}">${dir}</b>` : ''}`;
  $('log').prepend(li);
  while ($('log').children.length > 12) $('log').lastChild.remove();
}
let busy = false;
async function scan(code) {
  if (busy || !code) return;
  busy = true;
  try {
    const res = await fetch('kiosk.php?token=' + encodeURIComponent(TOKEN), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const d = await res.json();
    if (!d.ok) {
      beep(false);
      show(`<div class="dir">✖</div><div class="name">${esc(d.error)}</div>`, 'err');
      log(d.error, '', true);
      return;
    }
    const e = d.employee;
    beep(true);
    const photo = e.has_photo ? `<div class="photo" style="background-image:url('kiosk.php?token=${encodeURIComponent(TOKEN)}&photo=${e.id}')"></div>` : '';
    const extra = d.outside ? '<div class="meta">Punch recorded (outside shift hours)</div>' : d.direction === 'IN'
      ? (d.late_minutes > 0 ? `<div class="meta">Late by ${d.late_minutes} min</div>` : '<div class="meta">On time ✔</div>')
      : (d.work ? `<div class="meta">Worked ${d.work} hrs</div>` : '');
    show(`${photo}<div class="dir">${d.outside ? 'PUNCH' : d.direction} · ${esc(d.time)}</div><div class="name">${esc(e.name)}</div>
      ${e.name_ur ? `<div class="name-ur">${esc(e.name_ur)}</div>` : ''}<div class="meta">${esc(e.code)} · ${esc(e.department)} · ${esc(e.designation)}</div>${extra}`,
      d.direction === 'IN' ? 'in' : 'out');
    log(`${d.time}  ${e.code} ${e.name}`, d.outside ? '' : d.direction);
  } catch (err) {
    beep(false);
    show('<div class="dir">✖</div><div class="name">Network error - scan again</div>', 'err');
  } finally {
    busy = false;
  }
}
$('scan').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); const v = ev.target.value.trim(); ev.target.value = ''; scan(v); }
});
// keep focus on the scan box (scanner acts as a keyboard)
setInterval(() => { if (document.activeElement !== $('scan')) $('scan').focus(); }, 1500);
</script>
</body>
</html>
