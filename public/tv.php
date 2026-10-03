<?php
declare(strict_types=1);

/**
 * Live TV attendance screen (full screen, auto refresh every 30 s). Token protected so a TV in the
 * hall can stay open all day without a login:  /tv.php?token=...
 * (link under Attendance → Devices & Screens).
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\Http;
use App\LiveAttendance;
use App\Settings;
use App\Storage;

Http::noStore();
Http::securityHeaders();
Http::csp();
$token = (string)($_GET['token'] ?? '');
if (!LiveAttendance::checkToken('tv_token', $token)) {
    http_response_code(403);
    header('Content-Type: text/plain; charset=utf-8');
    exit("TV link is invalid or has been regenerated.\n");
}
if (isset($_GET['logo'])) {
    $f = Storage::file('logos', (string)Settings::get('company_logo', ''));
    if (!$f) {
        http_response_code(404);
        exit;
    }
    header('Content-Type: image/png');
    readfile($f);
    exit;
}
if (isset($_GET['data'])) {
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(LiveAttendance::data(), JSON_UNESCAPED_UNICODE);
    exit;
}
$company = Http::e((string)Settings::get('company_name', ''));
$companyUr = Http::e((string)Settings::get('company_name_ur', ''));
$logo = Settings::get('company_logo') ? '<img src="tv.php?token=' . Http::e(rawurlencode($token)) . '&logo=1" alt="">' : '';
$tokenJs = json_encode($token);
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Attendance</title>
<link rel="icon" href="data:,">
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; background: #0b1120; color: #e2e8f0; font: 2vh/1.3 system-ui, Segoe UI, Arial, sans-serif; overflow: hidden; }
  .wrap { display: grid; grid-template-rows: auto auto 1fr; height: 100%; padding: 1.6vh 2vw; gap: 1.6vh; }
  header { display: flex; align-items: center; gap: 1.5vw; }
  header img { height: 7vh; background: #fff; border-radius: 1vh; padding: .4vh; }
  header .co { flex: 1; } header .co b { font-size: 3.6vh; display: block; } header .ur { font-family: "Noto Nastaliq Urdu", serif; color: #94a3b8; font-size: 2.4vh; }
  .clock { text-align: right; } .clock .t { font-size: 5.4vh; font-weight: 800; font-variant-numeric: tabular-nums; } .clock .d { color: #94a3b8; font-size: 2.2vh; }
  .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1vw; }
  .kpi { background: #111a2e; border-radius: 1.4vh; padding: 1.4vh 1vw; border-top: .6vh solid #334155; }
  .kpi .v { font-size: 6vh; font-weight: 800; font-variant-numeric: tabular-nums; } .kpi .l { color: #94a3b8; font-size: 2vh; text-transform: uppercase; letter-spacing: .1em; }
  .kpi.p { border-color: #10b981; } .kpi.p .v { color: #34d399; } .kpi.a { border-color: #ef4444; } .kpi.a .v { color: #f87171; }
  .kpi.l2 { border-color: #f59e0b; } .kpi.l2 .v { color: #fbbf24; } .kpi.v2 { border-color: #3b82f6; } .kpi.v2 .v { color: #60a5fa; }
  .bottom { display: grid; grid-template-columns: 2.2fr 1fr; gap: 1.4vw; min-height: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 2.3vh; }
  th { text-align: right; color: #94a3b8; font-weight: 600; padding: .8vh .8vw; border-bottom: 2px solid #1f2a44; font-size: 1.8vh; text-transform: uppercase; letter-spacing: .06em; }
  th:first-child, td:first-child { text-align: left; }
  td { text-align: right; padding: .9vh .8vw; border-bottom: 1px solid #1a2238; font-variant-numeric: tabular-nums; }
  td .ur { font-family: "Noto Nastaliq Urdu", serif; color: #94a3b8; font-size: 1.8vh; margin-left: .6vw; }
  td.p { color: #34d399; font-weight: 700; } td.a { color: #f87171; font-weight: 700; } td.l { color: #fbbf24; } td.late { color: #fb923c; }
  .bar { height: .7vh; background: #1f2a44; border-radius: .4vh; margin-top: .4vh; overflow: hidden; } .bar span { display: block; height: 100%; background: #10b981; }
  tr.total td { font-weight: 800; border-top: 2px solid #334155; }
  .panel { background: #111a2e; border-radius: 1.4vh; padding: 1.2vh 1vw; overflow: hidden; }
  .panel h2 { margin: 0 0 1vh; font-size: 2vh; color: #94a3b8; text-transform: uppercase; letter-spacing: .1em; }
  .feed div { display: flex; justify-content: space-between; padding: .8vh 0; border-bottom: 1px solid #1a2238; font-size: 2.1vh; }
  .feed .t { color: #60a5fa; font-variant-numeric: tabular-nums; margin-right: .8vw; } .feed .dp { color: #94a3b8; font-size: 1.7vh; }
  .stale { position: fixed; bottom: 1vh; right: 2vw; color: #f87171; font-size: 1.8vh; display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header><?= $logo ?><div class="co"><b><?= $company ?></b><span class="ur"><?= $companyUr ?></span></div>
    <div class="clock"><div class="t" id="clock">--:--</div><div class="d" id="date"></div></div></header>
  <section class="kpis" id="kpis"></section>
  <section class="bottom">
    <div class="panel"><h2>Department wise · today</h2><table><thead><tr><th>Department</th><th>Strength</th><th>Present</th><th>Late</th><th>Leave</th><th>Absent</th><th>Not in yet</th><th>Off</th></tr></thead><tbody id="rows"></tbody></table></div>
    <div class="panel"><h2>Latest punches</h2><div class="feed" id="feed"></div></div>
  </section>
</div>
<div class="stale" id="stale">Connection lost - showing last data</div>
<script>
const TOKEN = <?= $tokenJs ?>;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tz = { timeZone: 'Asia/Karachi' };
function tick() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
  $('date').textContent = d.toLocaleDateString('en-GB', { ...tz, weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
}
tick(); setInterval(tick, 5000);
async function load() {
  try {
    const res = await fetch('tv.php?data=1&token=' + encodeURIComponent(TOKEN), { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    const t = d.totals;
    const working = t.strength - t.off;
    const pct = working ? Math.round((t.present / working) * 100) : 0;
    $('kpis').innerHTML = [
      ['', t.strength, 'Strength'], ['p', t.present, `Present (${pct}%)`], ['l2', t.late, 'Late'],
      ['v2', t.leave, 'On leave'], ['a', t.absent + t.not_in, 'Absent / not in'], ['', t.inside, 'Inside now'],
    ].map(([c, v, l]) => `<div class="kpi ${c}"><div class="v">${v}</div><div class="l">${l}</div></div>`).join('');
    $('rows').innerHTML = d.departments.map((x) => {
      const w = x.strength - x.off;
      const p = w ? Math.round((x.present / w) * 100) : 0;
      return `<tr><td>${esc(x.department)}<span class="ur">${esc(x.department_ur || '')}</span><div class="bar"><span style="width:${p}%"></span></div></td>
        <td>${x.strength}</td><td class="p">${x.present}</td><td class="late">${x.late}</td><td class="l">${x.leave}</td><td class="a">${x.absent}</td><td>${x.not_in}</td><td>${x.off}</td></tr>`;
    }).join('') + `<tr class="total"><td>Total</td><td>${t.strength}</td><td class="p">${t.present}</td><td class="late">${t.late}</td><td class="l">${t.leave}</td><td class="a">${t.absent}</td><td>${t.not_in}</td><td>${t.off}</td></tr>`;
    $('feed').innerHTML = d.recent.map((r) => `<div><span><span class="t">${esc(r.punch_time.slice(11, 16))}</span>${esc(r.name)}</span><span class="dp">${esc(r.department)}</span></div>`).join('')
      || '<div><span>No punches yet today</span></div>';
    $('stale').style.display = 'none';
  } catch (e) {
    $('stale').style.display = 'block';
  }
}
load(); setInterval(load, 30000);
</script>
</body>
</html>
