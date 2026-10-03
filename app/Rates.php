<?php
declare(strict_types=1);

namespace App;

/**
 * Statutory rates (EOBI / PESSI / SESSI) and income tax slabs are effective-dated: a new notification
 * is a new row (or slab set) with its effective date. Existing rows whose effective date falls on or
 * before the end of the latest posted salary period are locked (posted sheets were calculated with
 * them). New rows may be back-dated (late notifications): they apply to sheets not yet posted, and
 * posted sheets keep their stored amounts.
 */
final class Rates
{
    public const CODES = ['EOBI', 'PESSI', 'SESSI'];
    public const METHODS = ['percent_of_min_wage', 'percent_of_wage', 'fixed'];

    /** Last day covered by any posted salary sheet (null = nothing posted). */
    public static function lockedUntil(): ?string
    {
        $d = Database::value("SELECT MAX(period_to) FROM salary_sheets WHERE status = 'posted'");
        return $d ? (string)$d : null;
    }

    /**
     * A row is locked when a salary sheet covering its effective date was posted while the row existed
     * (that sheet may have been calculated with it).
     */
    public static function assertEditable(string $effectiveFrom, string $createdAt, string $what = 'This rate'): void
    {
        $s = Database::one(
            "SELECT period_from, period_to FROM salary_sheets WHERE status = 'posted' AND period_to >= ? AND posted_at >= ? ORDER BY period_to DESC LIMIT 1",
            [$effectiveFrom, $createdAt]
        );
        if ($s) {
            throw ApiException::conflict("$what (effective " . date('d-m-Y', strtotime($effectiveFrom)) . ') was used by the salary posted for '
                . date('d-m-Y', strtotime($s['period_from'])) . ' to ' . date('d-m-Y', strtotime($s['period_to']))
                . ' and is locked. Add a new row with a later effective date instead.');
        }
    }

    /**
     * Validate and normalise a slab set (pure). Slabs must start at 0, be contiguous (each "from" equals the
     * previous "to"), ascending, and only the last may be open-ended (to = null).
     * @param array $slabs [{income_from, income_to|null, fixed_amount, rate_percent}]
     * @return array normalised rows, sorted by income_from
     * @throws \InvalidArgumentException with "row N: message"
     */
    public static function normaliseSlabs(array $slabs): array
    {
        if (!$slabs) {
            throw new \InvalidArgumentException('Enter at least one slab.');
        }
        $rows = [];
        foreach (array_values($slabs) as $i => $s) {
            $n = $i + 1;
            $from = $s['income_from'] ?? null;
            $to = $s['income_to'] ?? null;
            $fixed = $s['fixed_amount'] ?? 0;
            $rate = $s['rate_percent'] ?? 0;
            foreach (['income from' => $from, 'fixed tax' => $fixed === '' ? 0 : $fixed, 'rate' => $rate === '' ? 0 : $rate] as $label => $v) {
                if (!is_numeric($v) || (float)$v < 0) {
                    throw new \InvalidArgumentException("Row $n: $label must be a positive number.");
                }
            }
            if ($to !== null && $to !== '' && (!is_numeric($to) || (float)$to <= (float)$from)) {
                throw new \InvalidArgumentException("Row $n: income to must be greater than income from.");
            }
            if ((float)$rate > 100) {
                throw new \InvalidArgumentException("Row $n: rate cannot exceed 100%.");
            }
            $rows[] = [
                'income_from' => round((float)$from, 2),
                'income_to' => $to === null || $to === '' ? null : round((float)$to, 2),
                'fixed_amount' => round((float)($fixed === '' ? 0 : $fixed), 2),
                'rate_percent' => round((float)($rate === '' ? 0 : $rate), 3),
            ];
        }
        usort($rows, fn($a, $b) => $a['income_from'] <=> $b['income_from']);
        if ($rows[0]['income_from'] != 0.0) {
            throw new \InvalidArgumentException('The first slab must start at 0.');
        }
        $last = count($rows) - 1;
        foreach ($rows as $i => $r) {
            if ($i < $last) {
                if ($r['income_to'] === null) {
                    throw new \InvalidArgumentException('Only the last slab can be open-ended (no "income to").');
                }
                if ($rows[$i + 1]['income_from'] != $r['income_to']) {
                    throw new \InvalidArgumentException('Slabs must be continuous: a slab starting at '
                        . number_format($rows[$i + 1]['income_from']) . ' must follow one ending at ' . number_format($r['income_to']) . '.');
                }
            }
        }
        if ($rows[$last]['income_to'] !== null) {
            throw new \InvalidArgumentException('The last slab must be open-ended (leave "income to" empty).');
        }
        return $rows;
    }
}
