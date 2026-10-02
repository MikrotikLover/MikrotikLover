<?php
declare(strict_types=1);

// SPA shell. All data is loaded through the JSON API; routing is client-side (#/route).
require dirname(__DIR__) . '/app/bootstrap.php';

use App\Config;
use App\Http;

Http::noStore();
Http::securityHeaders();
header('Content-Type: text/html; charset=utf-8');

// Cache-buster for static assets: newest mtime under assets/
$ver = 0;
foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator(__DIR__ . '/assets', FilesystemIterator::SKIP_DOTS)) as $f) {
    $ver = max($ver, $f->getMTime());
}
$appName = Http::e((string)Config::get('app_name', 'Payroll & HR'));
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="app-version" content="<?= $ver ?>">
<title><?= $appName ?></title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%231d4ed8'/><text x='16' y='22' font-size='16' text-anchor='middle' fill='white' font-family='Arial' font-weight='700'>P</text></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/app.css?v=<?= $ver ?>">
</head>
<body>
<div id="app"><div style="padding:40px;text-align:center;color:#6b7280">Loading…</div></div>
<noscript>This application requires JavaScript.</noscript>
<script>window.APP = { name: <?= json_encode((string)Config::get('app_name', 'Payroll & HR')) ?>, version: <?= $ver ?> };</script>
<script type="module" src="assets/js/app.js?v=<?= $ver ?>"></script>
</body>
</html>
