<?php
declare(strict_types=1);

namespace Prod;

/** Ink companies (suppliers) and their ink rate history in Rs per litre. */
final class InkCompanies
{
    public static function find(int $id): array
    {
        return Database::one('SELECT * FROM ink_companies WHERE id = ?', [$id]) ?? throw ApiException::notFound('Ink company');
    }

    public static function list(): array
    {
        $rows = Database::all(
            'SELECT c.id, c.name, c.is_active, COUNT(e.id) AS entries, COALESCE(SUM(e.ink_ml), 0) / 1000 AS litres, MAX(e.entry_date) AS last_used
               FROM ink_companies c LEFT JOIN production_entries e ON e.ink_company_id = c.id GROUP BY c.id ORDER BY c.name'
        );
        $today = date('Y-m-d');
        foreach ($rows as &$r) {
            $id = (int)$r['id'];
            $r['current_rate'] = Pricing::inkRateFor($id, $today);
            $r['rates'] = Database::all('SELECT id, effective_from, rate_per_litre, note FROM ink_rates WHERE ink_company_id = ? ORDER BY effective_from DESC', [$id]);
            // Machines whose current ink is this company
            $r['machines'] = Database::column(
                'SELECT m.name FROM machines m WHERE (SELECT mi.ink_company_id FROM machine_inks mi WHERE mi.machine_id = m.id AND mi.effective_from <= ?
                   ORDER BY mi.effective_from DESC LIMIT 1) = ? ORDER BY m.name',
                [$today, $id]
            );
        }
        return $rows;
    }

    private static function cleanName(mixed $name): string
    {
        $name = mb_substr(Text::clean($name), 0, 80);
        if ($name === '') {
            throw ApiException::validation(['name' => 'Company name is required.']);
        }
        return $name;
    }

    public static function create(mixed $name, mixed $rate): int
    {
        $name = self::cleanName($name);
        [, $rate] = Pricing::input(Machines::FIRST_DATE, $rate, 'rate_per_litre', 'ink rate in Rs per litre');
        if (Database::value('SELECT id FROM ink_companies WHERE name = ?', [$name])) {
            throw ApiException::conflict("Ink company \"$name\" already exists.");
        }
        return Database::transaction(function () use ($name, $rate) {
            $id = Database::insert('ink_companies', ['name' => $name]);
            Database::insert('ink_rates', ['ink_company_id' => $id, 'effective_from' => Machines::FIRST_DATE, 'rate_per_litre' => $rate,
                'note' => 'Opening rate', 'created_by' => Auth::id()]);
            Audit::log('create', 'ink_companies', $id, null, ['name' => $name, 'rate_per_litre' => $rate]);
            return $id;
        });
    }

    public static function update(int $id, array $in): void
    {
        $row = self::find($id);
        $data = [];
        if (array_key_exists('name', $in)) {
            $data['name'] = self::cleanName($in['name']);
            if (Database::value('SELECT id FROM ink_companies WHERE name = ? AND id <> ?', [$data['name'], $id])) {
                throw ApiException::conflict("\"{$data['name']}\" already exists.");
            }
        }
        if (array_key_exists('is_active', $in)) {
            $data['is_active'] = (int)(bool)$in['is_active'];
        }
        Database::update('ink_companies', $data, 'id = :id', ['id' => $id]);
        Audit::log('update', 'ink_companies', $id, $row, $data + $row);
    }

    public static function delete(int $id): void
    {
        $row = self::find($id);
        if ((int)Database::value('SELECT COUNT(*) FROM production_entries WHERE ink_company_id = ?', [$id]) > 0
            || (int)Database::value('SELECT COUNT(*) FROM machine_inks WHERE ink_company_id = ?', [$id]) > 0) {
            throw ApiException::conflict('This ink company is used by machines or entries. Mark it inactive instead.');
        }
        if ((int)Settings::get('default_ink_company_id', 0) === $id) {
            throw ApiException::conflict('This is the default ink company for new machines (Settings). Choose another default first.');
        }
        Database::run('DELETE FROM ink_companies WHERE id = ?', [$id]);
        Audit::log('delete', 'ink_companies', $id, $row);
    }

    /** Adds or replaces the rate from a date, then re-prices this company's entries. */
    public static function saveRate(int $id, mixed $from, mixed $rate, mixed $note = ''): void
    {
        self::find($id);
        [$from, $rate] = Pricing::input($from, $rate, 'rate_per_litre', 'ink rate in Rs per litre');
        Database::transaction(function () use ($id, $from, $rate, $note) {
            $old = Database::one('SELECT * FROM ink_rates WHERE ink_company_id = ? AND effective_from = ?', [$id, $from]);
            Database::run(
                'INSERT INTO ink_rates (ink_company_id, effective_from, rate_per_litre, note, created_by) VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE rate_per_litre = VALUES(rate_per_litre), note = VALUES(note)',
                [$id, $from, $rate, mb_substr(Text::clean($note), 0, 150), Auth::id()]
            );
            Audit::log($old ? 'update' : 'create', 'ink_rates', $id, $old, ['effective_from' => $from, 'rate_per_litre' => $rate]);
            Pricing::recompute('ink_company_id', $id);
        });
    }

    public static function deleteRate(int $id, int $rateId): void
    {
        $row = Database::one('SELECT * FROM ink_rates WHERE id = ? AND ink_company_id = ?', [$rateId, $id]) ?? throw ApiException::notFound('Rate');
        if ((int)Database::value('SELECT COUNT(*) FROM ink_rates WHERE ink_company_id = ?', [$id]) <= 1) {
            throw ApiException::conflict('An ink company needs at least one rate. Change this rate instead of deleting it.');
        }
        Database::transaction(function () use ($id, $rateId, $row) {
            Database::run('DELETE FROM ink_rates WHERE id = ?', [$rateId]);
            Audit::log('delete', 'ink_rates', $id, $row);
            Pricing::recompute('ink_company_id', $id);
        });
    }
}
