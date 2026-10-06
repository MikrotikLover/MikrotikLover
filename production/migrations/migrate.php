<?php
declare(strict_types=1);

/**
 * Migration runner. Applies migrations/NNN_*.sql in order, recording each in `schema_migrations`.
 * Creates the first admin user (admin / admin123, must change on first login) when there are no users.
 *
 *   php migrations/migrate.php            apply pending migrations
 *   php migrations/migrate.php --status   list applied / pending
 *   Browser: /migrate.php?key=SETUP_KEY   (only when security.setup_key is set in the config)
 *
 * Statements are split on ";" at the end of a line; the SQL files contain no other semicolons there.
 */

require_once dirname(__DIR__) . '/src/bootstrap.php';

use Prod\Database;

/** @return string[] output lines */
function prod_migrate(bool $statusOnly = false): array
{
    $out = [];
    Database::pdo()->exec('CREATE TABLE IF NOT EXISTS schema_migrations (
        migration VARCHAR(190) NOT NULL PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
    $applied = Database::column('SELECT migration FROM schema_migrations');
    foreach (glob(__DIR__ . '/[0-9][0-9][0-9]_*.sql') ?: [] as $file) {
        $name = basename($file);
        if (in_array($name, $applied, true)) {
            $statusOnly && $out[] = "applied  $name";
            continue;
        }
        if ($statusOnly) {
            $out[] = "PENDING  $name";
            continue;
        }
        $sql = preg_replace('/^\s*--.*$/m', '', (string)file_get_contents($file));
        foreach (preg_split('/;\s*$/m', $sql) as $stmt) {
            if (trim($stmt) !== '') {
                Database::pdo()->exec($stmt); // DDL commits implicitly in MySQL, so no transaction here
            }
        }
        Database::insert('schema_migrations', ['migration' => $name]);
        $out[] = "applied  $name";
    }
    if (!$statusOnly && (int)Database::value('SELECT COUNT(*) FROM users') === 0) {
        Database::insert('users', [
            'username' => 'admin', 'full_name' => 'Administrator', 'role' => 'admin', 'must_change_password' => 1,
            'password_hash' => password_hash('admin123', PASSWORD_DEFAULT),
        ]);
        $out[] = 'created user admin / admin123 (change it at first login)';
    }
    $out[] = 'done';
    return $out;
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    echo implode(PHP_EOL, prod_migrate(in_array('--status', $argv, true))), PHP_EOL;
}
