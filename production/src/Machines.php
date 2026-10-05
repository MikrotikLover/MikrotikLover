<?php
declare(strict_types=1);

namespace Prod;

/**
 * Printing machines and their ink rate history (Rs per litre, effective from a date).
 * Every machine always has at least one rate; a date before the first rate uses the first rate.
 * Each entry stores the rate of its machine and date in ink_rate; recompute() keeps it in step
 * whenever a machine's rates change.
 */
final class Machines
{
    public const FIRST_RATE_DATE = '2000-01-01';

    /** @var array<string,int> key => id */
    private static array $cache = [];
    /** @var array<int,array<int,array{0:string,1:float}>> machine id => [[effective_from, rate], ...] ascending */
    private static array $rates = [];

    public static function find(int $id): array
    {
        return Database::one('SELECT * FROM machines WHERE id = ?', [$id]) ?? throw ApiException::notFound('Machine');
    }

    /** Id for a machine name, creating it (with the default ink rate) when new. Empty -> null. */
    public static function resolve(mixed $name): ?int
    {
        $name = mb_substr(Text::clean($name), 0, 60);
        if ($name === '') {
            return null;
        }
        $key = Text::key($name);
        if (!isset(self::$cache[$key])) {
            $id = Database::value('SELECT id FROM machines WHERE name = ?', [$name]);
            self::$cache[$key] = $id ? (int)$id : self::create($name, (float)Settings::get('default_ink_rate', 0));
        }
        return self::$cache[$key];
    }

    public static function create(string $name, float $rate): int
    {
        $name = mb_substr(Text::clean($name), 0, 60);
        if ($name === '') {
            throw ApiException::validation(['name' => 'Machine name is required.']);
        }
        if (Database::value('SELECT id FROM machines WHERE name = ?', [$name])) {
            throw ApiException::conflict("Machine \"$name\" already exists.");
        }
        return Database::transaction(function () use ($name, $rate) {
            $id = Database::insert('machines', ['name' => $name]);
            Database::insert('machine_rates', [
                'machine_id' => $id, 'effective_from' => self::FIRST_RATE_DATE, 'rate_per_litre' => $rate,
                'note' => 'Opening rate', 'created_by' => Auth::id(),
            ]);
            Audit::log('create', 'machines', $id, null, ['name' => $name, 'rate_per_litre' => $rate]);
            return $id;
        });
    }

    public static function forgetCache(): void
    {
        self::$cache = [];
        self::$rates = [];
    }

    public static function list(): array
    {
        $rows = Database::all(
            'SELECT m.id, m.name, m.is_active, COUNT(e.id) AS entries, COALESCE(SUM(e.printed_mtr), 0) AS meters, MAX(e.entry_date) AS last_used
               FROM machines m LEFT JOIN production_entries e ON e.machine_id = m.id GROUP BY m.id ORDER BY m.name'
        );
        $today = date('Y-m-d');
        foreach ($rows as &$r) {
            $r['current_rate'] = self::rateFor((int)$r['id'], $today);
            $r['rates'] = self::rates((int)$r['id']);
        }
        return $rows;
    }

    public static function rates(int $machineId): array
    {
        return Database::all('SELECT id, effective_from, rate_per_litre, note FROM machine_rates WHERE machine_id = ? ORDER BY effective_from DESC', [$machineId]);
    }

    /** Rs per litre for a machine on a date. */
    public static function rateFor(int $machineId, string $date): float
    {
        if (!isset(self::$rates[$machineId])) {
            self::$rates[$machineId] = array_map(
                fn($r) => [$r['effective_from'], (float)$r['rate_per_litre']],
                Database::all('SELECT effective_from, rate_per_litre FROM machine_rates WHERE machine_id = ? ORDER BY effective_from', [$machineId])
            );
        }
        $list = self::$rates[$machineId];
        if (!$list) {
            return 0.0;
        }
        $rate = $list[0][1];
        foreach ($list as [$from, $r]) {
            if ($from > $date) {
                break;
            }
            $rate = $r;
        }
        return $rate;
    }

    public static function rename(int $id, mixed $name): void
    {
        $row = self::find($id);
        $name = mb_substr(Text::clean($name), 0, 60);
        if ($name === '') {
            throw ApiException::validation(['name' => 'Machine name is required.']);
        }
        if (Database::value('SELECT id FROM machines WHERE name = ? AND id <> ?', [$name, $id])) {
            throw ApiException::conflict("\"$name\" already exists. Use Merge to combine the two machines.");
        }
        Database::update('machines', ['name' => $name], 'id = :id', ['id' => $id]);
        Audit::log('update', 'machines', $id, $row, ['name' => $name] + $row);
        self::forgetCache();
    }

    public static function setActive(int $id, bool $active): void
    {
        $row = self::find($id);
        Database::update('machines', ['is_active' => (int)$active], 'id = :id', ['id' => $id]);
        Audit::log('update', 'machines', $id, $row, ['is_active' => (int)$active] + $row);
    }

    /** Moves all entries to $targetId (they take the target machine's rates) and deletes the source. */
    public static function merge(int $sourceId, int $targetId): int
    {
        if ($sourceId === $targetId) {
            throw ApiException::validation(['target_id' => 'Pick a different machine to merge into.']);
        }
        $src = self::find($sourceId);
        $dst = self::find($targetId);
        return Database::transaction(function () use ($src, $dst) {
            $moved = Database::run('UPDATE production_entries SET machine_id = ? WHERE machine_id = ?', [$dst['id'], $src['id']])->rowCount();
            Database::run('DELETE FROM machines WHERE id = ?', [$src['id']]);
            self::recompute((int)$dst['id']);
            Audit::log('merge', 'machines', (int)$src['id'], ['name' => $src['name']], ['merged_into' => $dst['name'], 'entries' => $moved]);
            self::forgetCache();
            return $moved;
        });
    }

    public static function delete(int $id): void
    {
        $row = self::find($id);
        if ((int)Database::value('SELECT COUNT(*) FROM production_entries WHERE machine_id = ?', [$id]) > 0) {
            throw ApiException::conflict('This machine has production entries. Merge it into another machine or mark it inactive.');
        }
        Database::run('DELETE FROM machines WHERE id = ?', [$id]);
        Audit::log('delete', 'machines', $id, $row);
        self::forgetCache();
    }

    /** Adds or replaces the rate effective from a date, then re-prices that machine's entries. */
    public static function saveRate(int $machineId, mixed $from, mixed $rate, mixed $note = ''): void
    {
        self::find($machineId);
        $errors = [];
        $from = Text::date($from);
        $rate = Text::number($rate);
        if ($from === null) {
            $errors['effective_from'] = 'Enter a valid date.';
        }
        if ($rate === null || $rate < 0 || $rate > 1e7) {
            $errors['rate_per_litre'] = 'Enter the ink rate in Rs per litre.';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        Database::transaction(function () use ($machineId, $from, $rate, $note) {
            $old = Database::one('SELECT * FROM machine_rates WHERE machine_id = ? AND effective_from = ?', [$machineId, $from]);
            Database::run(
                'INSERT INTO machine_rates (machine_id, effective_from, rate_per_litre, note, created_by) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE rate_per_litre = VALUES(rate_per_litre), note = VALUES(note)',
                [$machineId, $from, $rate, mb_substr(Text::clean($note), 0, 150), Auth::id()]
            );
            Audit::log($old ? 'update' : 'create', 'machine_rates', $machineId, $old, ['effective_from' => $from, 'rate_per_litre' => $rate]);
            self::recompute($machineId);
        });
    }

    public static function deleteRate(int $machineId, int $rateId): void
    {
        $row = Database::one('SELECT * FROM machine_rates WHERE id = ? AND machine_id = ?', [$rateId, $machineId]) ?? throw ApiException::notFound('Rate');
        if ((int)Database::value('SELECT COUNT(*) FROM machine_rates WHERE machine_id = ?', [$machineId]) <= 1) {
            throw ApiException::conflict('A machine needs at least one ink rate. Change this rate instead of deleting it.');
        }
        Database::transaction(function () use ($machineId, $rateId, $row) {
            Database::run('DELETE FROM machine_rates WHERE id = ?', [$rateId]);
            Audit::log('delete', 'machine_rates', $machineId, $row);
            self::recompute($machineId);
        });
    }

    /** Re-applies the rate history to every entry of the machine. */
    public static function recompute(int $machineId): int
    {
        self::$rates = [];
        return Database::run(
            'UPDATE production_entries e SET e.ink_rate = COALESCE(
                 (SELECT r.rate_per_litre FROM machine_rates r WHERE r.machine_id = e.machine_id AND r.effective_from <= e.entry_date
                   ORDER BY r.effective_from DESC LIMIT 1),
                 (SELECT r.rate_per_litre FROM machine_rates r WHERE r.machine_id = e.machine_id ORDER BY r.effective_from LIMIT 1),
                 0)
             WHERE e.machine_id = ?',
            [$machineId]
        )->rowCount();
    }
}
