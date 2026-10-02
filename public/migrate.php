<?php
declare(strict_types=1);

/**
 * Browser migration runner for hosts without SSH.
 *   /migrate.php?key=SETUP_KEY          apply pending migrations
 *   /migrate.php?key=SETUP_KEY&seed=1   also load demo data
 * Disabled unless security.setup_key is set in config.php. Clear the key after deploying.
 */
require dirname(__DIR__) . '/migrations/migrate.php';

use App\Config;
use App\Http;

Http::noStore();
header('Content-Type: text/plain; charset=utf-8');

$key = (string)Config::get('security.setup_key', '');
if ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? ''))) {
    http_response_code(403);
    echo "Forbidden. Set security.setup_key in config.php and pass ?key=...\n";
    exit;
}

$m = new Migrator(false);
$ok = $m->run(($_GET['seed'] ?? '') === '1');
http_response_code($ok ? 200 : 500);
echo implode("\n", $m->lines()), "\n";
