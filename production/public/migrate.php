<?php
declare(strict_types=1);

// Browser migration runner for hosts without SSH: /migrate.php?key=SETUP_KEY
// Works only while security.setup_key is set in the config; clear the key afterwards.
require dirname(__DIR__) . '/src/bootstrap.php';
require PROD_ROOT . '/migrations/migrate.php';

use Prod\Config;
use Prod\Http;

Http::noStore();
header('Content-Type: text/plain; charset=utf-8');
$key = (string)Config::get('security.setup_key', '');
if ($key === '' || !hash_equals($key, (string)($_GET['key'] ?? ''))) {
    http_response_code(403);
    exit("Forbidden. Set security.setup_key in the config and open /migrate.php?key=...\n");
}
echo implode("\n", prod_migrate(isset($_GET['status']))), "\n";
