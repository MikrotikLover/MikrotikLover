<?php
declare(strict_types=1);

/**
 * Material requirement and costing for estimation and production vouchers.
 *
 * Ink: ml per meter per colour comes from the design (design_inks). For an
 * estimation it is recalculated for the order's fabric GSM / width (unless the
 * design colour is "manual"). Ink is costed with the design line's ink item or
 * the default ink of that colour for the design's process (InkService).
 *
 * Note on stock: ink leaves stock when it is loaded into a machine (Ink
 * Loading voucher). Production records ink use for costing and estimated-vs-
 * actual variance but does NOT deduct ink again.
 */
final class ProductionService
{
    /** Design header needed for calculations, or 422 on the given field. */
    public static function design(int $designId, string $errorField = 'design_id'): array
    {
        $d = DB::one(
            'SELECT id, design_code, name, process_type, basis_gsm, basis_width_inch, finished_item_id, default_machine_id, party_id
             FROM designs WHERE id = :id AND deleted_at IS NULL',
            ['id' => $designId]
        );
        if ($d === null) {
            throw HttpException::validation([$errorField => Lang::t('validation.exists')]);
        }
        return $d;
    }

    /**
     * Converts printed meters to an item's stock unit.
     * length units: meters ÷ to_base (yard = 0.9144); mass units: meters × width(m) × GSM ÷ 1000 kg.
     * Returns null when a weight unit has no GSM / width to convert with.
     */
    public static function metersToQty(array $item, float $meters, ?float $gsm = null, ?float $widthInch = null): ?float
    {
        $toBase = (float) ($item['unit_to_base'] ?? 1) ?: 1.0;
        return match ($item['unit_dimension'] ?? 'length') {
            'length' => $meters / $toBase,
            'mass'   => (($gsm ?? (float) ($item['gsm'] ?? 0)) > 0 && ($widthInch ?? (float) ($item['width_inch'] ?? 0)) > 0)
                ? $meters * (($widthInch ?? (float) $item['width_inch']) * InkService::INCH_TO_M) * ($gsm ?? (float) $item['gsm']) / 1000 / $toBase
                : null,
            default  => $meters,
        };
    }

    /**
     * Ink per colour for $meters printed.
     * @param ?float $gsm/$widthInch recalculate ml/m for this fabric (estimation); null = design's stored ml/m.
     * @return list<array{ink_colour_id:int, colour_code:string, item: ?array, ml: float, qty: ?float, rate_per_ml: float, amount: float}>
     */
    public static function inkRequirement(array $design, float $meters, ?float $gsm = null, ?float $widthInch = null): array
    {
        $params = InkService::params();
        $rows = DB::all(
            'SELECT di.ink_colour_id, di.item_id, di.coverage_pct, di.ml_per_meter, di.is_manual, c.code AS colour_code
             FROM design_inks di JOIN ink_colours c ON c.id = di.ink_colour_id
             WHERE di.design_id = :d ORDER BY c.sort_order, c.code',
            ['d' => (int) $design['id']]
        );
        $out = [];
        foreach ($rows as $r) {
            $mlPerM = (float) $r['ml_per_meter'];
            if (!(int) $r['is_manual'] && $gsm !== null && $widthInch !== null) {
                $mlPerM = InkService::mlPerMeter((float) $r['coverage_pct'], $gsm, $widthInch, $params);
            }
            $item = $r['item_id'] ? self::item((int) $r['item_id']) : null;
            if ($item === null) {
                $def = InkService::defaultInkItem((int) $r['ink_colour_id'], (string) $design['process_type']);
                $item = $def ? self::item((int) $def['id']) : null;
            }
            $ml = round($mlPerM * $meters, 3);
            $ratePerMl = $item && (float) $item['unit_to_base'] > 0 ? (float) $item['rate'] / (float) $item['unit_to_base'] / 1000 : 0.0;
            $out[] = [
                'ink_colour_id' => (int) $r['ink_colour_id'],
                'colour_code'   => $r['colour_code'],
                'item'          => $item,
                'ml'            => $ml,
                'qty'           => $item ? round($ml / 1000 / (float) $item['unit_to_base'], 3) : null,
                'rate_per_ml'   => $ratePerMl,
                'amount'        => round($ml * $ratePerMl, 2),
            ];
        }
        return $out;
    }

    /** Non-ink BOM for $meters printed: qty per meter × (1 + wastage%) × meters. */
    public static function bomRequirement(array $design, float $meters): array
    {
        $rows = DB::all('SELECT item_id, qty_per_meter, wastage_pct FROM design_bom WHERE design_id = :d ORDER BY id', ['d' => (int) $design['id']]);
        $out = [];
        foreach ($rows as $r) {
            $item = self::item((int) $r['item_id']);
            if ($item === null) {
                continue;
            }
            $qty = round((float) $r['qty_per_meter'] * (1 + (float) $r['wastage_pct'] / 100) * $meters, 3);
            $out[] = ['item' => $item, 'qty' => $qty, 'amount' => round($qty * (float) $item['rate'], 2)];
        }
        return $out;
    }

    /**
     * Full production estimate for an order.
     * In: design_id, meters, wastage_pct?, fabric_item_id?, fabric_gsm?, fabric_width_inch?, machine_id?
     * Out: resolved header values, lines (production_estimation_lines rows) and totals.
     */
    public static function estimate(array $h): array
    {
        $design = self::design((int) $h['design_id']);
        $fabric = !empty($h['fabric_item_id']) ? self::item((int) $h['fabric_item_id']) : null;
        $gsm = (float) ($h['fabric_gsm'] ?: ($fabric['gsm'] ?? null) ?: $design['basis_gsm'] ?: 0);
        $width = (float) ($h['fabric_width_inch'] ?: ($fabric['width_inch'] ?? null) ?: $design['basis_width_inch'] ?: 0);
        $wastage = $h['wastage_pct'] !== null && $h['wastage_pct'] !== '' ? (float) $h['wastage_pct'] : Settings::float('default_wastage_pct', 3);
        $meters = (float) $h['meters'];
        $gross = round($meters * (1 + $wastage / 100), 3);
        $mlUnit = (int) DB::value("SELECT id FROM units WHERE code = 'ml' AND deleted_at IS NULL");

        $lines = [];
        $tot = ['ink_ml_total' => 0.0, 'ink_cost' => 0.0, 'paper_cost' => 0.0, 'chemical_cost' => 0.0, 'other_cost' => 0.0];
        $warnings = [];
        foreach (self::inkRequirement($design, $gross, $gsm ?: null, $width ?: null) as $ink) {
            if ($ink['item'] === null) {
                $warnings[] = Lang::t('production.no_ink_item', ['colour' => $ink['colour_code']]);
            }
            $lines[] = [
                'line_type' => 'ink', 'item_id' => $ink['item']['id'] ?? null, 'ink_colour_id' => $ink['ink_colour_id'],
                'qty' => (string) $ink['ml'], 'unit_id' => $mlUnit ?: null,
                'rate' => (string) round($ink['rate_per_ml'], 4), 'amount' => (string) $ink['amount'],
            ];
            $tot['ink_ml_total'] += $ink['ml'];
            $tot['ink_cost'] += $ink['amount'];
        }
        foreach (self::bomRequirement($design, $gross) as $b) {
            $type = in_array($b['item']['item_type'], ['paper', 'chemical'], true) ? $b['item']['item_type'] : 'other';
            $lines[] = [
                'line_type' => $type, 'item_id' => (int) $b['item']['id'], 'ink_colour_id' => null,
                'qty' => (string) $b['qty'], 'unit_id' => (int) $b['item']['unit_id'],
                'rate' => (string) $b['item']['rate'], 'amount' => (string) $b['amount'],
            ];
            $tot[$type . '_cost'] += $b['amount'];
        }
        if ($fabric !== null) {
            $fq = self::metersToQty($fabric, $gross, $gsm ?: null, $width ?: null);
            if ($fq !== null) {
                $amount = round($fq * (float) $fabric['rate'], 2);
                $lines[] = [
                    'line_type' => 'fabric', 'item_id' => (int) $fabric['id'], 'ink_colour_id' => null,
                    'qty' => (string) round($fq, 3), 'unit_id' => (int) $fabric['unit_id'],
                    'rate' => (string) $fabric['rate'], 'amount' => (string) $amount,
                ];
                $tot['other_cost'] += $amount;
            }
        }

        $machine = !empty($h['machine_id'])
            ? DB::one('SELECT speed_m_per_hr, hourly_cost FROM machines WHERE id = :id', ['id' => (int) $h['machine_id']])
            : null;
        $hours = $machine && (float) $machine['speed_m_per_hr'] > 0 ? round($gross / (float) $machine['speed_m_per_hr'], 2) : 0.0;
        $machineCost = round($hours * (float) ($machine['hourly_cost'] ?? 0), 2);
        $total = $tot['ink_cost'] + $tot['paper_cost'] + $tot['chemical_cost'] + $tot['other_cost'] + $machineCost;

        return [
            'header' => [
                'fabric_gsm'        => $gsm ? (string) $gsm : null,
                'fabric_width_inch' => $width ? (string) $width : null,
                'wastage_pct'       => (string) $wastage,
                'gross_meters'      => $gross,
            ],
            'lines'  => $lines,
            'totals' => [
                'ink_ml_total'   => (string) round($tot['ink_ml_total'], 3),
                'ink_cost'       => (string) round($tot['ink_cost'], 2),
                'paper_cost'     => (string) round($tot['paper_cost'], 2),
                'chemical_cost'  => (string) round($tot['chemical_cost'], 2),
                'other_cost'     => (string) round($tot['other_cost'], 2),
                'machine_hours'  => (string) $hours,
                'machine_cost'   => (string) $machineCost,
                'total_cost'     => (string) round($total, 2),
                'cost_per_meter' => (string) ($meters > 0 ? round($total / $meters, 4) : 0),
            ],
            'warnings' => $warnings,
        ];
    }

    /** Item row with unit info (cached per request). */
    public static function item(int $id): ?array
    {
        static $cache = [];
        if (!array_key_exists($id, $cache)) {
            $cache[$id] = DB::one(
                'SELECT i.id, i.code, i.name, i.item_type, i.unit_id, i.rate, i.gsm, i.width_inch, i.track_lots, i.ink_colour_id,
                        u.code AS unit_code, u.dimension AS unit_dimension, u.to_base AS unit_to_base
                 FROM items i JOIN units u ON u.id = i.unit_id WHERE i.id = :id AND i.deleted_at IS NULL',
                ['id' => $id]
            );
        }
        return $cache[$id];
    }
}
