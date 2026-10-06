<?php
declare(strict_types=1);

/**
 * Test runner (no Composer / PHPUnit needed).
 *   php tests/run.php
 * Database tests use a scratch database: the configured name with "_test" appended (override with
 * PRODUCTION_TEST_DB). It is dropped and re-created on every run, so the DB user needs CREATE/DROP on it.
 * Every tests/*Test.php returns 'name' => callable; a test fails by throwing.
 */

require dirname(__DIR__) . '/src/bootstrap.php';
require PROD_ROOT . '/migrations/migrate.php';
ini_set('display_errors', '1'); // show fatal errors on the console

use Prod\Config;
use Prod\Database;

$db = Config::get('db');
$db['name'] = getenv('PRODUCTION_TEST_DB') ?: $db['name'] . '_test';
Config::set('db', $db);
$tmp = sys_get_temp_dir() . '/prod-test-' . getmypid();
Config::set('storage_path', $tmp);

$pdo = new PDO(sprintf('mysql:host=%s;port=%d;charset=utf8mb4', $db['host'], (int)($db['port'] ?? 3306)), $db['user'], $db['pass']);
$pdo->exec("DROP DATABASE IF EXISTS `{$db['name']}`");
$pdo->exec("CREATE DATABASE `{$db['name']}` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
prod_migrate();

function assert_eq(mixed $expected, mixed $actual, string $msg = ''): void
{
    if ($expected !== $actual) {
        throw new RuntimeException(($msg ? "$msg: " : '') . 'expected ' . var_export($expected, true) . ', got ' . var_export($actual, true));
    }
}

function assert_true(bool $cond, string $msg = 'assertion failed'): void
{
    if (!$cond) {
        throw new RuntimeException($msg);
    }
}

function assert_throws(callable $fn, string $class, ?int $status = null): Throwable
{
    try {
        $fn();
    } catch (Throwable $e) {
        if ($e instanceof $class && ($status === null || ($e instanceof Prod\ApiException && $e->status() === $status))) {
            return $e;
        }
        throw new RuntimeException("expected $class" . ($status ? " ($status)" : '') . ', got ' . $e::class . ': ' . $e->getMessage());
    }
    throw new RuntimeException("expected $class to be thrown");
}

function act_as(string $role): array
{
    $u = Database::one('SELECT * FROM users WHERE username = ?', ["t_$role"]);
    if (!$u) {
        Database::insert('users', ['username' => "t_$role", 'role' => $role, 'password_hash' => password_hash('x', PASSWORD_DEFAULT)]);
        $u = Database::one('SELECT * FROM users WHERE username = ?', ["t_$role"]);
    }
    Prod\Auth::actAs($u);
    return $u;
}

$pass = 0;
$fail = 0;
foreach (glob(__DIR__ . '/*Test.php') as $file) {
    $tests = require $file;
    echo basename($file), PHP_EOL;
    foreach ($tests as $name => $fn) {
        try {
            $fn();
            $pass++;
            echo "  ✔ $name", PHP_EOL;
        } catch (Throwable $e) {
            $fail++;
            echo "  ✘ $name\n      ", $e->getMessage(), ' @ ', basename($e->getFile()), ':', $e->getLine(), PHP_EOL;
        }
    }
}
$pdo->exec("DROP DATABASE IF EXISTS `{$db['name']}`");
array_map('unlink', glob("$tmp/*/*") ?: []);
echo PHP_EOL, "$pass passed, $fail failed", PHP_EOL;
exit($fail ? 1 : 0);
