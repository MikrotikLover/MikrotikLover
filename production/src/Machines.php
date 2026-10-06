<?php
declare(strict_types=1);

namespace Prod;

/**
 * Printing machines with two dated histories (see Pricing):
 *   machine_rates  the machine rate in Rs per printed metre
 *   machine_inks   which ink company's ink the machine uses
 */
final class Machines
{
    /** Date of opening rows: "from the start". */
    public const FIRST_DATE = '2000-01-01';

    /** @var array<string,int> key => id */
    private static array $cache = [];

    public static function find(int $id): array
    {
        return Database::one('SELECT * FROM machines WHERE id = ?', [$id]) ?? throw ApiException::notFound('Machine');
    }

    /** Id for a machine name, creating it (with the default ink company) when new. Empty -> null. */
    public static function resolve(mixed $name): ?int
    {
        $name = mb_substr(Text::clean($name), 0, 60);
        if ($name === '') {
            return null;
        }
        $key = Text::key($name);
        if (!isset(self::$cache[$key])) {
            $id = Database::value('SELECT id FROM machines WHERE name = ?', [$name]);
            self::$cache[$key] = $id ? (int)$id : self::create($name);
        }
        return self::$cache[$key];
    }

    /**
     * @param int|null   $inkCompanyId ink company used from the start (null = the default from Settings)
     * @param float|null $ratePerMtr   opening machine rate (null = not set yet)
     */
    public static function create(mixed $name, ?int $inkCompanyId = null, ?float $ratePerMtr = null): int
    {
        $name = mb_substr(Text::clean($name), 0, 60);
        if ($name === '') {
            throw ApiException::validation(['name' => 'Machine name is required.']);
        }
        if (Database::value('SELECT id FROM machines WHERE name = ?', [$name])) {
            throw ApiException::conflict("Machine \"$name\" already exists.");
        }
        $inkCompanyId ??= self::defaultInkCompany();
        if ($inkCompanyId !== null && !Database::value('SELECT id FROM ink_companies WHERE id = ?', [$inkCompanyId])) {
            throw ApiException::validation(['ink_company_id' => 'Choose an ink company.']);
        }
        return Database::transaction(function () use ($name, $inkCompanyId, $ratePerMtr) {
            $id = Database::insert('machines', ['name' => $name]);
            if ($inkCompanyId !== null) {
                Database::insert('machine_inks', ['machine_id' => $id, 'effective_from' => self::FIRST_DATE, 'ink_company_id' => $inkCompanyId, 'created_by' => Auth::id()]);
            }
            if ($ratePerMtr !== null) {
                Database::insert('machine_rates', ['machine_id' => $id, 'effective_from' => self::FIRST_DATE, 'rate_per_mtr' => $ratePerMtr,
                    'note' => 'Opening rate', 'created_by' => Auth::id()]);
            }
            Audit::log('create', 'machines', $id, null, ['name' => $name, 'ink_company_id' => $inkCompanyId, 'rate_per_mtr' => $ratePerMtr]);
            Pricing::forget();
            return $id;
        });
    }

    private static function defaultInkCompany(): ?int
    {
        $id = (int)Settings::get('default_ink_company_id', 0);
        if ($id && Database::value('SELECT id FROM ink_companies WHERE id = ?', [$id])) {
            return $id;
        }
        $first = Database::value('SELECT MIN(id) FROM ink_companies WHERE is_active = 1');
        return $first ? (int)$first : null;
    }

    public static function forgetCache(): void
    {
        self::$cache = [];
        Pricing::forget();
    }

    public static function list(): array
    {
        $rows = Database::all(
            'SELECT m.id, m.name, m.is_active, COUNT(e.id) AS entries, COALESCE(SUM(e.printed_mtr), 0) AS meters, MAX(e.entry_date) AS last_used
               FROM machines m LEFT JOIN production_entries e ON e.machine_id = m.id GROUP BY m.id ORDER BY m.name'
        );
        $today = date('Y-m-d');
        foreach ($rows as &$r) {
            $id = (int)$r['id'];
            $r['current_rate'] = Database::value('SELECT COUNT(*) FROM machine_rates WHERE machine_id = ?', [$id]) ? Pricing::machineRateFor($id, $today) : null;
            $r['rates'] = Database::all('SELECT id, effective_from, rate_per_mtr, note FROM machine_rates WHERE machine_id = ? ORDER BY effective_from DESC', [$id]);
            $r['inks'] = Database::all(
                'SELECT mi.id, mi.effective_from, mi.ink_company_id, c.name AS ink_company FROM machine_inks mi JOIN ink_companies c ON c.id = mi.ink_company_id
                  WHERE mi.machine_id = ? ORDER BY mi.effective_from DESC', [$id]
            );
            $cur = Pricing::inkCompanyFor($id, $today);
            $r['current_ink_company'] = $cur ? Database::value('SELECT name FROM ink_companies WHERE id = ?', [$cur]) : null;
        }
        return $rows;
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

    /** Moves all entries to $targetId (they take the target machine's rates and ink) and deletes the source. */
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
            Pricing::recompute('machine_id', (int)$dst['id']);
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

    /** Adds or replaces the machine rate (Rs per metre) from a date, then re-prices the machine's entries. */
    public static function saveRate(int $machineId, mixed $from, mixed $rate, mixed $note = ''): void
    {
        self::find($machineId);
        [$from, $rate] = Pricing::input($from, $rate, 'rate_per_mtr', 'machine rate in Rs per metre');
        Database::transaction(function () use ($machineId, $from, $rate, $note) {
            $old = Database::one('SELECT * FROM machine_rates WHERE machine_id = ? AND effective_from = ?', [$machineId, $from]);
            Database::run(
                'INSERT INTO machine_rates (machine_id, effective_from, rate_per_mtr, note, created_by) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE rate_per_mtr = VALUES(rate_per_mtr), note = VALUES(note)',
                [$machineId, $from, $rate, mb_substr(Text::clean($note), 0, 150), Auth::id()]
            );
            Audit::log($old ? 'update' : 'create', 'machine_rates', $machineId, $old, ['effective_from' => $from, 'rate_per_mtr' => $rate]);
            Pricing::recompute('machine_id', $machineId);
        });
    }

    public static function deleteRate(int $machineId, int $rateId): void
    {
        $row = Database::one('SELECT * FROM machine_rates WHERE id = ? AND machine_id = ?', [$rateId, $machineId]) ?? throw ApiException::notFound('Rate');
        Database::transaction(function () use ($machineId, $rateId, $row) {
            Database::run('DELETE FROM machine_rates WHERE id = ?', [$rateId]);
            Audit::log('delete', 'machine_rates', $machineId, $row);
            Pricing::recompute('machine_id', $machineId);
        });
    }

    /** The machine uses this ink company's ink from a date; its entries from then on are re-priced. */
    public static function saveInk(int $machineId, mixed $from, mixed $companyId): void
    {
        self::find($machineId);
        $errors = [];
        $from = Text::date($from);
        $companyId = (int)$companyId;
        if ($from === null) {
            $errors['effective_from'] = 'Enter a valid date.';
        }
        if (!$companyId || !Database::value('SELECT id FROM ink_companies WHERE id = ?', [$companyId])) {
            $errors['ink_company_id'] = 'Choose an ink company.';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        Database::transaction(function () use ($machineId, $from, $companyId) {
            $old = Database::one('SELECT * FROM machine_inks WHERE machine_id = ? AND effective_from = ?', [$machineId, $from]);
            Database::run(
                'INSERT INTO machine_inks (machine_id, effective_from, ink_company_id, created_by) VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE ink_company_id = VALUES(ink_company_id)',
                [$machineId, $from, $companyId, Auth::id()]
            );
            Audit::log($old ? 'update' : 'create', 'machine_inks', $machineId, $old, ['effective_from' => $from, 'ink_company_id' => $companyId]);
            Pricing::recompute('machine_id', $machineId);
        });
    }

    public static function deleteInk(int $machineId, int $rowId): void
    {
        $row = Database::one('SELECT * FROM machine_inks WHERE id = ? AND machine_id = ?', [$rowId, $machineId]) ?? throw ApiException::notFound('Ink change');
        if ((int)Database::value('SELECT COUNT(*) FROM machine_inks WHERE machine_id = ?', [$machineId]) <= 1) {
            throw ApiException::conflict('A machine needs an ink company. Add the new company instead of deleting this one.');
        }
        Database::transaction(function () use ($machineId, $rowId, $row) {
            Database::run('DELETE FROM machine_inks WHERE id = ?', [$rowId]);
            Audit::log('delete', 'machine_inks', $machineId, $row);
            Pricing::recompute('machine_id', $machineId);
        });
    }
}
