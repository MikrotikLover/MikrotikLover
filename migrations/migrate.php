<?php
declare(strict_types=1);

/**
 * Migration runner. Applies migrations/NNN_*.sql in order, recording each in `schema_migrations`.
 *
 * CLI:      php migrations/migrate.php            apply pending migrations
 *           php migrations/migrate.php --seed     also apply demo seed files (migrations/seeds/*.sql)
 *           php migrations/migrate.php --status   list applied / pending
 * Browser:  /migrate.php?key=SETUP_KEY[&seed=1]   (only when security.setup_key is set in config.php)
 *
 * Statements are split on ';' at the end of a statement (quotes and comments are respected).
 * No DELIMITER / stored procedures are used, so this works on shared hosting without the mysql CLI.
 */

require_once dirname(__DIR__) . '/app/bootstrap.php';

use App\Database;

final class Migrator
{
    private array $log = [];

    public function __construct(private bool $cli)
    {
    }

    private function out(string $line): void
    {
        $this->log[] = $line;
        if ($this->cli) {
            echo $line, PHP_EOL;
        }
    }

    public function lines(): array
    {
        return $this->log;
    }

    private function ensureTable(): void
    {
        Database::pdo()->exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations (
                migration  VARCHAR(190) NOT NULL PRIMARY KEY,
                applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
             ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        );
    }

    /** @return array<string,string> name => path */
    private function files(bool $seed): array
    {
        $files = glob(__DIR__ . '/[0-9][0-9][0-9]_*.sql') ?: [];
        if ($seed) {
            $files = array_merge($files, glob(__DIR__ . '/seeds/[0-9][0-9][0-9]_*.sql') ?: []);
        }
        $out = [];
        foreach ($files as $f) {
            $out[(str_contains($f, '/seeds/') ? 'seeds/' : '') . basename($f)] = $f;
        }
        return $out;
    }

    /** @return string[] migrations not yet applied (seeds excluded) */
    public function pending(): array
    {
        $this->ensureTable();
        $applied = Database::column('SELECT migration FROM schema_migrations');
        return array_values(array_diff(array_keys($this->files(false)), $applied));
    }

    public function status(bool $seed): void
    {
        $this->ensureTable();
        $applied = Database::column('SELECT migration FROM schema_migrations');
        foreach ($this->files($seed) as $name => $f) {
            $this->out(sprintf('%-8s %s', in_array($name, $applied, true) ? 'applied' : 'PENDING', $name));
        }
    }

    public function run(bool $seed): bool
    {
        $this->ensureTable();
        $applied = Database::column('SELECT migration FROM schema_migrations');
        $pending = array_diff_key($this->files($seed), array_flip($applied));
        if (!$pending) {
            $this->out('Nothing to migrate. Database is up to date.');
            return true;
        }
        $pdo = Database::pdo();
        foreach ($pending as $name => $file) {
            $this->out("Applying $name ...");
            $statements = self::split((string)file_get_contents($file));
            // MySQL DDL auto-commits, so a failed migration may be partially applied:
            // each migration is written to be re-checked by hand if that happens.
            try {
                $pdo->exec('SET FOREIGN_KEY_CHECKS = 1');
                foreach ($statements as $i => $sql) {
                    $pdo->exec($sql);
                }
                Database::insert('schema_migrations', ['migration' => $name]);
                $this->out('  OK (' . count($statements) . ' statements)');
            } catch (\Throwable $e) {
                $this->out('  FAILED at statement #' . (($i ?? 0) + 1) . ': ' . $e->getMessage());
                return false;
            }
        }
        $this->out('Done.');
        return true;
    }

    /** Split SQL text into statements, ignoring ';' inside quotes and comments. */
    public static function split(string $sql): array
    {
        $out = [];
        $buf = '';
        $len = strlen($sql);
        $quote = null;
        for ($i = 0; $i < $len; $i++) {
            $c = $sql[$i];
            $n = $i + 1 < $len ? $sql[$i + 1] : '';
            if ($quote !== null) {
                $buf .= $c;
                if ($c === '\\' && $quote !== '`') {
                    $buf .= $n;
                    $i++;
                } elseif ($c === $quote) {
                    if ($n === $quote) { // doubled quote escape
                        $buf .= $n;
                        $i++;
                    } else {
                        $quote = null;
                    }
                }
                continue;
            }
            if ($c === '-' && $n === '-' || $c === '#') {
                $end = strpos($sql, "\n", $i);
                $i = $end === false ? $len : $end;
                $buf .= "\n";
                continue;
            }
            if ($c === '/' && $n === '*') {
                $end = strpos($sql, '*/', $i + 2);
                $i = $end === false ? $len : $end + 1;
                continue;
            }
            if ($c === "'" || $c === '"' || $c === '`') {
                $quote = $c;
                $buf .= $c;
                continue;
            }
            if ($c === ';') {
                if (trim($buf) !== '') {
                    $out[] = trim($buf);
                }
                $buf = '';
                continue;
            }
            $buf .= $c;
        }
        if (trim($buf) !== '') {
            $out[] = trim($buf);
        }
        return $out;
    }
}

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $args = array_slice($argv, 1);
    $m = new Migrator(true);
    if (in_array('--status', $args, true)) {
        $m->status(in_array('--seed', $args, true));
        exit(0);
    }
    exit($m->run(in_array('--seed', $args, true)) ? 0 : 1);
}
