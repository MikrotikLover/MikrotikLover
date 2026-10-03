<?php
declare(strict_types=1);

namespace App;

use PDO;

/**
 * SQL dump of the whole database in pure PHP (shared hosting has no mysqldump / exec). Streams gzip
 * output table by table with unbuffered reads, so memory stays flat. Restore with phpMyAdmin Import
 * or `mysql db < file.sql`.
 */
final class Backup
{
    /** @param callable(string):void $write receives SQL text chunks */
    public static function dump(callable $write): void
    {
        $pdo = Database::pdo();
        $db = (string)Database::value('SELECT DATABASE()');
        $write("-- Payroll & HR database backup\n-- Database: `$db`  Created: " . date('Y-m-d H:i:s') . " (Asia/Karachi)\n\n"
            . "SET NAMES utf8mb4;\nSET time_zone = '+05:00';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n");
        $tables = Database::column("SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name");
        foreach ($tables as $t) {
            $create = Database::one("SHOW CREATE TABLE `$t`");
            $write("-- --------------------------------------------------------\n-- Table `$t`\n\nDROP TABLE IF EXISTS `$t`;\n"
                . $create['Create Table'] . ";\n\n");
            $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, false);
            try {
                $st = $pdo->query("SELECT * FROM `$t`");
                $cols = null;
                $batch = [];
                while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
                    $cols ??= '(`' . implode('`, `', array_keys($row)) . '`)';
                    $batch[] = '(' . implode(', ', array_map(fn($v) => $v === null ? 'NULL' : $pdo->quote((string)$v), $row)) . ')';
                    if (count($batch) >= 200) {
                        $write("INSERT INTO `$t` $cols VALUES\n" . implode(",\n", $batch) . ";\n");
                        $batch = [];
                    }
                }
                if ($batch) {
                    $write("INSERT INTO `$t` $cols VALUES\n" . implode(",\n", $batch) . ";\n");
                }
                $st->closeCursor();
            } finally {
                $pdo->setAttribute(PDO::MYSQL_ATTR_USE_BUFFERED_QUERY, true);
            }
            $write("\n");
        }
        $write("SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- End of backup\n");
    }
}
