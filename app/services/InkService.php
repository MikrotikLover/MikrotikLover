<?php
declare(strict_types=1);

/**
 * Ink calculations shared by the design library (Batch 2), estimation and
 * production costing (Batch 4).
 *
 *   ml per meter (one colour) = ml_per_sqm_full × coverage% / 100
 *                               × fabric width (m) × fabric GSM / reference GSM
 *
 * ml_per_sqm_full  = ml of one colour per m² at 100% coverage on reference-GSM fabric
 * Heavier fabric absorbs proportionally more ink, so the GSM ratio scales it.
 */
final class InkService
{
    public const INCH_TO_M = 0.0254;

    public static function params(): array
    {
        return [
            'ml_per_sqm_full' => Settings::float('ink_ml_per_sqm_full', 12.0),
            'reference_gsm'   => max(1.0, Settings::float('ink_reference_gsm', 100.0)),
        ];
    }

    public static function mlPerMeter(float $coveragePct, float $gsm, float $widthInch, ?array $params = null): float
    {
        $p = $params ?? self::params();
        if ($coveragePct <= 0 || $gsm <= 0 || $widthInch <= 0) {
            return 0.0;
        }
        $ml = $p['ml_per_sqm_full'] * ($coveragePct / 100) * ($widthInch * self::INCH_TO_M) * ($gsm / $p['reference_gsm']);
        return round($ml, 4);
    }

    /**
     * Ink item used for a colour when the design line has none: the active ink
     * of that colour for the process (or 'any'), preferring an exact process match.
     */
    public static function defaultInkItem(int $colourId, string $process): ?array
    {
        return DB::one(
            "SELECT i.id, i.code, i.name, i.rate, u.to_base
             FROM items i JOIN units u ON u.id = i.unit_id
             WHERE i.item_type = 'ink' AND i.ink_colour_id = :c AND i.is_active = 1 AND i.deleted_at IS NULL
               AND (i.process_type = :p OR i.process_type = 'any')
             ORDER BY (i.process_type = :p2) DESC, i.id
             LIMIT 1",
            ['c' => $colourId, 'p' => $process, 'p2' => $process]
        );
    }

    /**
     * Per-colour ink usage and cost per meter for a design.
     * @return array{lines: array, ml_per_meter: float, cost_per_meter: float}
     */
    public static function designInkCost(int $designId): array
    {
        $design = DB::one('SELECT process_type FROM designs WHERE id = :id', ['id' => $designId]);
        $lines = DB::all(
            'SELECT di.id, di.ink_colour_id, di.item_id, di.coverage_pct, di.ml_per_meter, di.is_manual,
                    c.code AS colour_code, c.name AS colour_name, c.name_ur AS colour_name_ur, c.hex AS colour_hex,
                    i.code AS item_code, i.name AS item_name, i.rate AS item_rate, u.to_base AS item_to_base
             FROM design_inks di
             JOIN ink_colours c ON c.id = di.ink_colour_id
             LEFT JOIN items i ON i.id = di.item_id
             LEFT JOIN units u ON u.id = i.unit_id
             WHERE di.design_id = :d ORDER BY c.sort_order, c.code',
            ['d' => $designId]
        );
        $totalMl = 0.0;
        $totalCost = 0.0;
        foreach ($lines as &$l) {
            $item = $l['item_id'] ? ['id' => $l['item_id'], 'code' => $l['item_code'], 'name' => $l['item_name'], 'rate' => $l['item_rate'], 'to_base' => $l['item_to_base']]
                : self::defaultInkItem((int) $l['ink_colour_id'], (string) ($design['process_type'] ?? 'sublimation'));
            $ratePerLiter = $item && (float) $item['to_base'] > 0 ? (float) $item['rate'] / (float) $item['to_base'] : 0.0;
            $ml = (float) $l['ml_per_meter'];
            $l['id'] = (int) $l['id'];
            $l['ink_colour_id'] = (int) $l['ink_colour_id'];
            $l['item_id'] = $l['item_id'] !== null ? (int) $l['item_id'] : null;
            $l['is_manual'] = (int) $l['is_manual'];
            $l['costing_item'] = $item ? ['id' => (int) $item['id'], 'code' => $item['code'], 'name' => $item['name']] : null;
            $l['rate_per_liter'] = round($ratePerLiter, 4);
            $l['cost_per_meter'] = round($ml / 1000 * $ratePerLiter, 4);
            unset($l['item_rate'], $l['item_to_base']);
            $totalMl += $ml;
            $totalCost += $l['cost_per_meter'];
        }
        unset($l);
        return ['lines' => $lines, 'ml_per_meter' => round($totalMl, 4), 'cost_per_meter' => round($totalCost, 4)];
    }
}
