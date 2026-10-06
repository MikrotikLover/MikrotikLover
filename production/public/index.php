<?php
declare(strict_types=1);

// SPA shell. All data is loaded through the JSON API; routing is client-side (#/route).
require dirname(__DIR__) . '/src/bootstrap.php';

use Prod\Config;
use Prod\Http;

Http::noStore();
Http::securityHeaders();
$nonce = Http::nonce();
Http::csp($nonce);
header('Content-Type: text/html; charset=utf-8');

$ver = max(filemtime(__DIR__ . '/assets/app.js'), filemtime(__DIR__ . '/assets/app.css'));
$appName = (string)Config::get('app_name', 'Production');
?>
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title><?= Http::e($appName) ?></title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%232a78d6'/><text x='16' y='22' font-size='16' text-anchor='middle' fill='white' font-family='Arial' font-weight='700'>P</text></svg>">
<link rel="stylesheet" href="assets/app.css?v=<?= $ver ?>">
</head>
<body>
<div id="app"><p class="boot">Loading…</p></div>
<noscript>This application requires JavaScript.</noscript>
<script nonce="<?= $nonce ?>">window.APP_NAME = <?= json_encode($appName) ?>;</script>
<script type="module" src="assets/app.js?v=<?= $ver ?>"></script>
</body>
</html>
