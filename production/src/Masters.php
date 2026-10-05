<?php
declare(strict_types=1);

namespace Prod;

/**
 * Name lists used by production entries: party, quality, article, calibration, operator.
 * Names are cleaned (trimmed, single spaces) and matched case-insensitively, so "Bana Dora " and
 * "bana dora" resolve to one record. Typos that differ in letters ("Duppata" / "Dupatta") are fixed
 * with merge().
 */
final class Masters
{
    /** kind => production_entries column */
    public const KINDS = [
        'party'       => 'party_id',
        'quality'     => 'quality_id',
        'article'     => 'article_id',
        'calibration' => 'calibration_id',
        'operator'    => 'operator_id',
    ];

    /** @var array<string,int> "kind|key" => id */
    private static array $cache = [];

    public static function assertKind(string $kind): void
    {
        if (!isset(self::KINDS[$kind])) {
            throw ApiException::notFound('List');
        }
    }

    /** Id for a name, creating the record when it does not exist yet. Empty name -> null. */
    public static function resolve(string $kind, mixed $name): ?int
    {
        self::assertKind($kind);
        $name = mb_substr(Text::clean($name), 0, 120);
        if ($name === '') {
            return null;
        }
        $ck = $kind . '|' . Text::key($name);
        if (!isset(self::$cache[$ck])) {
            Database::run(
                'INSERT INTO masters (kind, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)',
                [$kind, $name]
            );
            self::$cache[$ck] = (int)Database::pdo()->lastInsertId();
        }
        return self::$cache[$ck];
    }

    public static function forgetCache(): void
    {
        self::$cache = [];
    }

    public static function find(int $id): array
    {
        return Database::one('SELECT * FROM masters WHERE id = ?', [$id]) ?? throw ApiException::notFound();
    }

    /** All records of a kind with usage (entries, metres, last used date). */
    public static function list(string $kind): array
    {
        self::assertKind($kind);
        $col = self::KINDS[$kind];
        return Database::all(
            "SELECT m.id, m.name, m.is_active, COUNT(e.id) AS entries, COALESCE(SUM(e.printed_mtr), 0) AS meters, MAX(e.entry_date) AS last_used
               FROM masters m LEFT JOIN production_entries e ON e.$col = m.id
              WHERE m.kind = ? GROUP BY m.id ORDER BY m.name",
            [$kind]
        );
    }

    public static function rename(int $id, mixed $name): array
    {
        $row = self::find($id);
        $name = mb_substr(Text::clean($name), 0, 120);
        if ($name === '') {
            throw ApiException::validation(['name' => 'Name is required.']);
        }
        $other = Database::value('SELECT id FROM masters WHERE kind = ? AND name = ? AND id <> ?', [$row['kind'], $name, $id]);
        if ($other) {
            throw ApiException::conflict("\"$name\" already exists. Use Merge to combine the two.");
        }
        Database::update('masters', ['name' => $name], 'id = :id', ['id' => $id]);
        Audit::log('update', 'masters', $id, $row, ['name' => $name] + $row);
        self::forgetCache();
        return self::find($id);
    }

    public static function setActive(int $id, bool $active): void
    {
        $row = self::find($id);
        Database::update('masters', ['is_active' => (int)$active], 'id = :id', ['id' => $id]);
        Audit::log('update', 'masters', $id, $row, ['is_active' => (int)$active] + $row);
    }

    /** Moves every entry of $sourceId to $targetId and deletes the source. Returns entries moved. */
    public static function merge(int $sourceId, int $targetId): int
    {
        if ($sourceId === $targetId) {
            throw ApiException::validation(['target_id' => 'Pick a different record to merge into.']);
        }
        $src = self::find($sourceId);
        $dst = self::find($targetId);
        if ($src['kind'] !== $dst['kind']) {
            throw ApiException::validation(['target_id' => 'Both records must be in the same list.']);
        }
        $col = self::KINDS[$src['kind']];
        return Database::transaction(function () use ($src, $dst, $col) {
            $moved = Database::run("UPDATE production_entries SET $col = ? WHERE $col = ?", [$dst['id'], $src['id']])->rowCount();
            Database::run('DELETE FROM masters WHERE id = ?', [$src['id']]);
            Audit::log('merge', 'masters', (int)$src['id'], ['name' => $src['name']], ['merged_into' => $dst['name'], 'entries' => $moved]);
            self::forgetCache();
            return $moved;
        });
    }

    public static function delete(int $id): void
    {
        $row = self::find($id);
        $col = self::KINDS[$row['kind']];
        if ((int)Database::value("SELECT COUNT(*) FROM production_entries WHERE $col = ?", [$id]) > 0) {
            throw ApiException::conflict('This name is used by production entries. Merge it into another name or mark it inactive.');
        }
        Database::run('DELETE FROM masters WHERE id = ?', [$id]);
        Audit::log('delete', 'masters', $id, $row);
        self::forgetCache();
    }

    /**
     * Likely typos within a list: names whose letters differ by at most 2 edits while their numbers
     * are identical ("Duppata"/"Dupatta", "Usman Yusuf"/"Usman Yousaf", but not "Vol 947"/"Vol 948").
     * @return array<int,array{a:array,b:array}>
     */
    public static function similar(string $kind): array
    {
        $rows = self::list($kind);
        $prep = [];
        foreach ($rows as $r) {
            $norm = preg_replace('/[^a-z0-9]+/', '', mb_strtolower($r['name'])) ?? '';
            preg_match_all('/\d+/', $norm, $m);
            $letters = preg_replace('/\d+/', '', $norm) ?? '';
            if (strlen($letters) < 4) {
                continue;
            }
            $prep[] = [$r, $letters, implode(',', $m[0])];
        }
        $pairs = [];
        $n = count($prep);
        for ($i = 0; $i < $n; $i++) {
            for ($j = $i + 1; $j < $n; $j++) {
                [$ra, $a, $da] = $prep[$i];
                [$rb, $b, $db] = $prep[$j];
                if ($da !== $db || abs(strlen($a) - strlen($b)) > 2) {
                    continue;
                }
                // One letter apart, or two apart in longer names that start the same ("Duppata"/"Dupatta"),
                // but not "USA Vol 10"/"SRA Vol 10".
                $dist = $a === $b ? 0 : levenshtein($a, $b);
                if ($dist <= 1 || ($dist === 2 && min(strlen($a), strlen($b)) >= 7 && substr($a, 0, 3) === substr($b, 0, 3))) {
                    // Suggest keeping the one with more entries.
                    $pairs[] = $ra['entries'] >= $rb['entries'] ? ['keep' => $ra, 'merge' => $rb] : ['keep' => $rb, 'merge' => $ra];
                }
            }
        }
        return $pairs;
    }
}
