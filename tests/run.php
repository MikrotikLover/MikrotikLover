<?php
declare(strict_types=1);

/**
 * Minimal test runner (no Composer / PHPUnit needed on shared hosting).
 *   php tests/run.php
 * Every tests/*Test.php file returns an array of 'name' => callable. A test fails by throwing.
 */

require dirname(__DIR__) . '/app/bootstrap.php';

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

function assert_throws(callable $fn, string $class, string $msg = ''): Throwable
{
    try {
        $fn();
    } catch (Throwable $e) {
        if ($e instanceof $class) {
            return $e;
        }
        throw new RuntimeException(($msg ? "$msg: " : '') . "expected $class, got " . $e::class . ': ' . $e->getMessage());
    }
    throw new RuntimeException(($msg ? "$msg: " : '') . "expected $class to be thrown");
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
            echo "  ✘ $name\n      ", $e->getMessage(), PHP_EOL;
        }
    }
}
echo PHP_EOL, "$pass passed, $fail failed", PHP_EOL;
exit($fail ? 1 : 0);
