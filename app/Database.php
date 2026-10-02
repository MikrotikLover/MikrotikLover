<?php
declare(strict_types=1);

namespace App;

use PDO;
use PDOStatement;

/** Thin PDO wrapper. Prepared statements only; identifiers are whitelisted by callers. */
final class Database
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            $c = Config::get('db');
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=%s',
                $c['host'],
                (int)($c['port'] ?? 3306),
                $c['name'],
                $c['charset'] ?? 'utf8mb4'
            );
            self::$pdo = new PDO($dsn, $c['user'], $c['pass'], [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::ATTR_STRINGIFY_FETCHES  => false,
            ]);
            self::$pdo->exec("SET time_zone = '+05:00', NAMES utf8mb4 COLLATE utf8mb4_unicode_ci,"
                . " SESSION sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
        }
        return self::$pdo;
    }

    public static function run(string $sql, array $params = []): PDOStatement
    {
        $stmt = self::pdo()->prepare($sql);
        foreach ($params as $k => $v) {
            $name = is_int($k) ? $k + 1 : (str_starts_with($k, ':') ? $k : ':' . $k);
            $type = match (true) {
                is_int($v)  => PDO::PARAM_INT,
                is_bool($v) => PDO::PARAM_INT,
                $v === null => PDO::PARAM_NULL,
                default     => PDO::PARAM_STR,
            };
            $stmt->bindValue($name, is_bool($v) ? (int)$v : $v, $type);
        }
        $stmt->execute();
        return $stmt;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll();
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::run($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public static function value(string $sql, array $params = []): mixed
    {
        $v = self::run($sql, $params)->fetchColumn();
        return $v === false ? null : $v;
    }

    public static function column(string $sql, array $params = []): array
    {
        return self::run($sql, $params)->fetchAll(PDO::FETCH_COLUMN);
    }

    /** @param array<string,mixed> $data column => value (columns must be trusted identifiers) */
    public static function insert(string $table, array $data): int
    {
        $cols = array_keys($data);
        $sql = sprintf(
            'INSERT INTO `%s` (%s) VALUES (%s)',
            $table,
            implode(', ', array_map(fn($c) => "`$c`", $cols)),
            implode(', ', array_map(fn($c) => ":$c", $cols))
        );
        self::run($sql, $data);
        return (int)self::pdo()->lastInsertId();
    }

    public static function update(string $table, array $data, string $where, array $whereParams = []): int
    {
        if (!$data) {
            return 0;
        }
        $sets = [];
        $params = [];
        foreach ($data as $col => $val) {
            $sets[] = "`$col` = :set_$col";
            $params["set_$col"] = $val;
        }
        $sql = sprintf('UPDATE `%s` SET %s WHERE %s', $table, implode(', ', $sets), $where);
        return self::run($sql, array_merge($params, $whereParams))->rowCount();
    }

    /** Runs $fn inside a transaction (nested calls join the outer transaction). */
    public static function transaction(callable $fn): mixed
    {
        $pdo = self::pdo();
        if ($pdo->inTransaction()) {
            return $fn();
        }
        $pdo->beginTransaction();
        try {
            $result = $fn();
            $pdo->commit();
            return $result;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Next voucher number for a document type & year, safe under concurrency. */
    public static function nextSequence(string $docType, int $year): int
    {
        return self::transaction(function () use ($docType, $year) {
            self::run(
                'INSERT INTO doc_sequences (doc_type, year, last_no) VALUES (:t, :y, 1)
                 ON DUPLICATE KEY UPDATE last_no = LAST_INSERT_ID(last_no + 1)',
                ['t' => $docType, 'y' => $year]
            );
            $id = (int)self::pdo()->lastInsertId();
            return $id > 0 ? $id : 1;
        });
    }
}
