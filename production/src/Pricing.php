<?php
declare(strict_types=1);

namespace Prod;

/**
 * Prices an entry from three dated histories:
 *   machine_inks   which ink company a machine uses from a date
 *   ink_rates      Rs per litre of an ink company from a date
 *   machine_rates  Rs per printed metre of a machine from a date
 * The row in force on a date is the latest one starting on or before it. A date before the first row
 * uses the first row, so an opening rate covers older production. No rows at all -> rate 0.
 *
 * Entries keep the result (ink_company_id, ink_rate, machine_rate); recompute() refreshes them after a
 * history changes. An ink company picked by hand on an entry (ink_company_manual = 1) is never replaced.
 */
final class Pricing
{
    private const HISTORIES = [
        'machine_inks'  => ['machine_id', 'ink_company_id'],
        'ink_rates'     => ['ink_company_id', 'rate_per_litre'],
        'machine_rates' => ['machine_id', 'rate_per_mtr'],
    ];

    /** @var array<string,array<int,array<int,array{0:string,1:mixed}>>> table => key => [[from, value], ...] ascending */
    private static array $cache = [];

    public static function forget(): void
    {
        self::$cache = [];
    }

    private static function at(string $table, int $key, string $date): mixed
    {
        [$keyCol, $valCol] = self::HISTORIES[$table];
        if (!isset(self::$cache[$table][$key])) {
            self::$cache[$table][$key] = array_map(
                fn($r) => [$r['effective_from'], $r[$valCol]],
                Database::all("SELECT effective_from, $valCol FROM $table WHERE $keyCol = ? ORDER BY effective_from", [$key])
            );
        }
        $list = self::$cache[$table][$key];
        if (!$list) {
            return null;
        }
        $value = $list[0][1];
        foreach ($list as [$from, $v]) {
            if ($from > $date) {
                break;
            }
            $value = $v;
        }
        return $value;
    }

    public static function inkCompanyFor(int $machineId, string $date): ?int
    {
        $v = self::at('machine_inks', $machineId, $date);
        return $v === null ? null : (int)$v;
    }

    public static function inkRateFor(?int $companyId, string $date): float
    {
        return $companyId ? (float)(self::at('ink_rates', $companyId, $date) ?? 0) : 0.0;
    }

    public static function machineRateFor(int $machineId, string $date): float
    {
        return (float)(self::at('machine_rates', $machineId, $date) ?? 0);
    }

    /**
     * Pricing columns for a new or edited entry. @param int|null $manualCompany ink company picked by hand
     * @return array{ink_company_id:?int,ink_company_manual:int,ink_rate:float,machine_rate:float}
     */
    public static function forEntry(int $machineId, string $date, ?int $manualCompany = null): array
    {
        $company = $manualCompany ?: self::inkCompanyFor($machineId, $date);
        return [
            'ink_company_id'     => $company,
            'ink_company_manual' => $manualCompany ? 1 : 0,
            'ink_rate'           => self::inkRateFor($company, $date),
            'machine_rate'       => self::machineRateFor($machineId, $date),
        ];
    }

    /**
     * Re-applies the histories to entries. @param string $column 'machine_id' | 'ink_company_id' | '' (all)
     */
    public static function recompute(string $column = '', int $id = 0): int
    {
        self::forget();
        $where = match ($column) {
            'machine_id'     => 'e.machine_id = :id',
            'ink_company_id' => 'e.ink_company_id = :id',
            ''               => '1 = 1',
        };
        $p = $column === '' ? [] : ['id' => $id];
        $hist = fn(string $table, string $keyExpr, string $val) => "COALESCE(
            (SELECT h.$val FROM $table h WHERE h.{$keyExpr} AND h.effective_from <= e.entry_date ORDER BY h.effective_from DESC LIMIT 1),
            (SELECT h.$val FROM $table h WHERE h.{$keyExpr} ORDER BY h.effective_from LIMIT 1))";
        if ($column !== 'ink_company_id') {
            Database::run('UPDATE production_entries e SET e.ink_company_id = '
                . $hist('machine_inks', 'machine_id = e.machine_id', 'ink_company_id')
                . " WHERE e.ink_company_manual = 0 AND $where", $p);
        }
        return Database::run('UPDATE production_entries e SET
                e.ink_rate = COALESCE(' . $hist('ink_rates', 'ink_company_id = e.ink_company_id', 'rate_per_litre') . ', 0),
                e.machine_rate = COALESCE(' . $hist('machine_rates', 'machine_id = e.machine_id', 'rate_per_mtr') . ", 0)
             WHERE $where", $p)->rowCount();
    }

    /** Validated [date, number] for a history row. */
    public static function input(mixed $from, mixed $value, string $field, string $label): array
    {
        $errors = [];
        $from = Text::date($from);
        $value = Text::number($value);
        if ($from === null) {
            $errors['effective_from'] = 'Enter a valid date.';
        }
        if ($value === null || $value < 0 || $value > 1e7) {
            $errors[$field] = "Enter the $label.";
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        return [$from, $value];
    }
}
