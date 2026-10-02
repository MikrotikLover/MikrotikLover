<?php
declare(strict_types=1);

/**
 * Thin PDO wrapper. All queries use prepared statements; identifiers passed to
 * the insert/update helpers come from code (never from user input) and are
 * still validated against a strict pattern.
 */
final class DB
{
    private static ?PDO $pdo = null;

    public static function pdo(): PDO
    {
        if (self::$pdo === null) {
            if (!Config::isConfigured()) {
                throw new HttpException(503, Lang::t('error.db_not_configured'), [], 'db_not_configured');
            }
            $dsn = sprintf(
                'mysql:host=%s;port=%d;dbname=%s;charset=utf8mb4',
                Config::get('db.host'),
                (int) Config::get('db.port'),
                Config::get('db.name')
            );
            try {
                self::$pdo = new PDO($dsn, (string) Config::get('db.user'), (string) Config::get('db.pass'), [
                    PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES   => false,
                    PDO::ATTR_STRINGIFY_FETCHES  => false,
                ]);
            } catch (PDOException $e) {
                Logger::error('DB connection failed: ' . $e->getMessage());
                throw new HttpException(503, Lang::t('error.db_unavailable'), [], 'db_unavailable');
            }
            // Asia/Karachi is UTC+5 all year (no DST), so a fixed offset is safe
            // and works even when MySQL timezone tables are not loaded.
            self::$pdo->exec("SET time_zone = '+05:00', sql_mode = 'STRICT_TRANS_TABLES,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'");
        }
        return self::$pdo;
    }

    public static function query(string $sql, array $params = []): PDOStatement
    {
        $stmt = self::pdo()->prepare($sql);
        foreach ($params as $key => $value) {
            $name = is_int($key) ? $key + 1 : (str_starts_with($key, ':') ? $key : ':' . $key);
            $type = match (true) {
                is_int($value)  => PDO::PARAM_INT,
                is_bool($value) => PDO::PARAM_BOOL,
                $value === null => PDO::PARAM_NULL,
                default         => PDO::PARAM_STR,
            };
            $stmt->bindValue($name, $value, $type);
        }
        $stmt->execute();
        return $stmt;
    }

    public static function one(string $sql, array $params = []): ?array
    {
        $row = self::query($sql, $params)->fetch();
        return $row === false ? null : $row;
    }

    public static function all(string $sql, array $params = []): array
    {
        return self::query($sql, $params)->fetchAll();
    }

    public static function value(string $sql, array $params = []): mixed
    {
        $value = self::query($sql, $params)->fetchColumn();
        return $value === false ? null : $value;
    }

    public static function column(string $sql, array $params = []): array
    {
        return self::query($sql, $params)->fetchAll(PDO::FETCH_COLUMN);
    }

    public static function insert(string $table, array $data): int
    {
        self::assertIdentifier($table);
        $cols = array_keys($data);
        array_walk($cols, [self::class, 'assertIdentifier']);
        $sql = sprintf(
            'INSERT INTO `%s` (`%s`) VALUES (%s)',
            $table,
            implode('`, `', $cols),
            implode(', ', array_map(fn ($c) => ':' . $c, $cols))
        );
        self::query($sql, $data);
        return (int) self::pdo()->lastInsertId();
    }

    /** UPDATE `table` SET ... WHERE id = :id. Returns affected rows. */
    public static function update(string $table, array $data, int $id): int
    {
        self::assertIdentifier($table);
        if ($data === []) {
            return 0;
        }
        $sets = [];
        foreach (array_keys($data) as $col) {
            self::assertIdentifier($col);
            $sets[] = "`$col` = :$col";
        }
        $data['__id'] = $id;
        $sql = sprintf('UPDATE `%s` SET %s WHERE id = :__id', $table, implode(', ', $sets));
        return self::query($sql, $data)->rowCount();
    }

    /**
     * Runs $fn inside a transaction; commits on success, rolls back on any
     * exception and rethrows it. Nested calls join the outer transaction.
     */
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
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    /** Builds "IN (:p0, :p1 ...)" placeholders and merges their values into $params. */
    public static function in(array $values, array &$params, string $prefix = 'in'): string
    {
        if ($values === []) {
            return '(NULL)';
        }
        $names = [];
        foreach (array_values($values) as $i => $v) {
            $name = $prefix . $i;
            $params[$name] = $v;
            $names[] = ':' . $name;
        }
        return '(' . implode(', ', $names) . ')';
    }

    public static function now(): string
    {
        return date('Y-m-d H:i:s');
    }

    private static function assertIdentifier(string $name): void
    {
        if (!preg_match('/^[a-z_][a-z0-9_]{0,63}$/', $name)) {
            throw new InvalidArgumentException("Invalid SQL identifier: $name");
        }
    }
}
