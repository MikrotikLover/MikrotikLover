<?php
declare(strict_types=1);

namespace Prod;

/**
 * Totals and group-by summaries over production entries.
 * Average ink (ml/m) and cost per metre use only the metres that have an ink figure, so rows with
 * a missing ink value do not pull the averages down.
 */
final class Reports
{
    /** dimension => [SQL expression, label] */
    public const DIMENSIONS = [
        'date'        => ['e.entry_date', 'Date'],
        'month'       => ["DATE_FORMAT(e.entry_date, '%Y-%m')", 'Month'],
        'machine'     => ['mc.name', 'Machine'],
        'shift'       => ['e.shift', 'Shift'],
        'operator'    => ["COALESCE(op.name, '(none)')", 'Operator'],
        'party'       => ["COALESCE(pa.name, '(none)')", 'Party'],
        // Party name without its volume number: "Al Karam Vol 801" -> "Al Karam"
        'customer'    => ["COALESCE(TRIM(REGEXP_REPLACE(pa.name, '[[:space:]]+[Vv][Oo][Ll][.]?[[:space:]]*[0-9][0-9+ ]*$', '')), '(none)')", 'Customer'],
        'quality'     => ["COALESCE(qu.name, '(none)')", 'Quality'],
        'article'     => ["COALESCE(ar.name, '(none)')", 'Article'],
        'calibration' => ["COALESCE(ca.name, '(none)')", 'Calibration'],
        'lot'         => ['e.lot_no', 'Lot #'],
        'design'      => ['e.design', 'Design'],
        'ink_company' => ["COALESCE(ic.name, '(none)')", 'Ink company'],
    ];

    private const METRICS = 'COUNT(*) AS entries, COALESCE(SUM(e.printed_mtr), 0) AS meters,
        COALESCE(SUM(CASE WHEN e.ink_ml_per_mtr IS NOT NULL THEN e.printed_mtr END), 0) AS ink_meters,
        COALESCE(SUM(e.ink_ml), 0) AS ink_ml, COALESCE(SUM(e.ink_cost), 0) AS ink_cost, COALESCE(SUM(e.machine_cost), 0) AS machine_cost,
        COUNT(DISTINCT NULLIF(e.lot_no, \'\')) AS lots, MIN(e.entry_date) AS first_date, MAX(e.entry_date) AS last_date';

    /** Adds litres, average ml/m and cost per metre; casts numbers. */
    public static function derive(array $r): array
    {
        foreach (['entries', 'lots'] as $k) {
            $r[$k] = (int)($r[$k] ?? 0);
        }
        foreach (['meters', 'ink_meters', 'ink_ml', 'ink_cost', 'machine_cost'] as $k) {
            $r[$k] = (float)($r[$k] ?? 0);
        }
        $r['total_cost'] = round($r['ink_cost'] + $r['machine_cost'], 2);
        $r['total_per_mtr'] = $r['meters'] > 0 ? round($r['total_cost'] / $r['meters'], 3) : null;
        $r['machine_cost'] = round($r['machine_cost'], 2);
        $r['ink_litres'] = round($r['ink_ml'] / 1000, 3);
        $r['avg_ml'] = $r['ink_meters'] > 0 ? round($r['ink_ml'] / $r['ink_meters'], 3) : null;
        $r['cost_per_mtr'] = $r['ink_meters'] > 0 ? round($r['ink_cost'] / $r['ink_meters'], 3) : null;
        $r['ink_cost'] = round($r['ink_cost'], 2);
        return $r;
    }

    public static function totals(string $where, array $p): array
    {
        return self::derive(Database::one('SELECT ' . self::METRICS . ' FROM ' . Entries::FROM . " WHERE $where", $p) ?? []);
    }

    /**
     * Group-by summary. @param string $g1 first dimension, $g2 optional second dimension
     */
    public static function summary(array $q, string $g1, ?string $g2 = null, string $sort = 'key'): array
    {
        if (!isset(self::DIMENSIONS[$g1]) || ($g2 !== null && $g2 !== '' && !isset(self::DIMENSIONS[$g2]))) {
            throw ApiException::validation(['group' => 'Choose what to group by.']);
        }
        $g2 = ($g2 === '' || $g2 === $g1) ? null : $g2;
        [$where, $p] = Entries::where($q);
        $k1 = self::DIMENSIONS[$g1][0];
        $select = "$k1 AS k1" . ($g2 ? ', ' . self::DIMENSIONS[$g2][0] . ' AS k2' : '');
        $group = $g2 ? 'k1, k2' : 'k1';
        $order = match ($sort) {
            'meters' => 'meters DESC',
            'cost'   => 'ink_cost + machine_cost DESC',
            'avg'    => 'SUM(e.ink_ml) / NULLIF(SUM(CASE WHEN e.ink_ml_per_mtr IS NOT NULL THEN e.printed_mtr END), 0) DESC',
            default  => $group,
        };
        if ($g2 && $sort !== 'key') {
            $order = "k1, $order"; // keep second-level rows under their first-level group
        }
        $rows = Database::all('SELECT ' . $select . ', ' . self::METRICS . ' FROM ' . Entries::FROM . " WHERE $where GROUP BY $group ORDER BY $order LIMIT 20001", $p);
        $truncated = count($rows) > 20000;
        $rows = array_map([self::class, 'derive'], array_slice($rows, 0, 20000));

        $groups = [];
        if ($g2) {
            // First-level subtotals for the two-level view
            $sub = Database::all("SELECT $k1 AS k1, " . self::METRICS . ' FROM ' . Entries::FROM . " WHERE $where GROUP BY k1", $p);
            foreach ($sub as $s) {
                $groups[(string)$s['k1']] = self::derive($s);
            }
        }
        return [
            'group1'    => $g1, 'group2' => $g2,
            'labels'    => [self::DIMENSIONS[$g1][1], $g2 ? self::DIMENSIONS[$g2][1] : null],
            'rows'      => $rows,
            'subtotals' => $groups,
            'totals'    => self::totals($where, $p),
            'truncated' => $truncated,
        ];
    }

    /** Dashboard figures for a date range, with the previous period of equal length for comparison. */
    public static function dashboard(string $from, string $to, ?int $machineId = null): array
    {
        $q = ['from' => $from, 'to' => $to, 'machine_id' => $machineId ? (string)$machineId : ''];
        [$where, $p] = Entries::where($q);
        $days = (int)((strtotime($to) - strtotime($from)) / 86400) + 1;
        $prevTo = date('Y-m-d', strtotime($from) - 86400);
        $prevFrom = date('Y-m-d', strtotime($prevTo) - ($days - 1) * 86400);
        [$pw, $pp] = Entries::where(['from' => $prevFrom, 'to' => $prevTo] + $q);

        $by = function (string $dim, int $limit = 0, string $order = 'meters DESC') use ($where, $p) {
            $rows = Database::all('SELECT ' . self::DIMENSIONS[$dim][0] . ' AS k, ' . self::METRICS . ' FROM ' . Entries::FROM
                . " WHERE $where GROUP BY k ORDER BY $order" . ($limit ? " LIMIT $limit" : ''), $p);
            return array_map([self::class, 'derive'], $rows);
        };
        return [
            'from'       => $from, 'to' => $to,
            'prev_from'  => $prevFrom, 'prev_to' => $prevTo,
            'totals'     => self::totals($where, $p),
            'previous'   => self::totals($pw, $pp),
            'daily'      => $by('date', 0, 'k'),
            'machines'   => $by('machine'),
            'shifts'     => $by('shift', 0, 'k'),
            'operators'  => $by('operator', 12),
            'parties'    => $by('party', 12),
            'articles'   => $by('article', 8),
            'last_entry' => Database::value('SELECT MAX(entry_date) FROM production_entries'),
        ];
    }

    /** Counts for each data-check flag (optionally limited to a date range). */
    public static function checks(array $q): array
    {
        $out = [];
        foreach (Entries::FLAGS as $flag) {
            [$where, $p] = Entries::where(['flag' => $flag] + $q);
            $out[$flag] = (int)Database::value('SELECT COUNT(*) FROM ' . Entries::FROM . " WHERE $where", $p);
        }
        return $out;
    }
}
