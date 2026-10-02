<?php
declare(strict_types=1);

/**
 * GET lookups?sets=units,warehouses,parties,ink_colours,items,machines,designs,ink_params
 * Compact, active-only option lists for dropdowns (any logged-in user).
 * Each option has value + label (+ label_ur, sub) and set-specific extras.
 */
final class LookupController
{
    public function index(): array
    {
        $sets = array_filter(explode(',', (string) Request::query('sets', '')));
        $out = [];
        foreach (array_unique($sets) as $set) {
            $out[$set] = match ($set) {
                'units' => $this->rows(
                    'SELECT id, code, name, name_ur, dimension, to_base, decimals FROM units
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY dimension, to_base DESC',
                    fn ($r) => ['sub' => $r['code']]
                ),
                'warehouses' => $this->rows(
                    "SELECT id, code, name, name_ur, warehouse_type FROM warehouses
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY FIELD(warehouse_type,'grey','floor','finished','general'), name",
                    fn ($r) => ['sub' => $r['code']]
                ),
                'parties' => $this->rows(
                    'SELECT id, code, name, name_ur, is_customer, is_supplier, is_fabric_owner, city FROM parties
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY name',
                    fn ($r) => ['sub' => trim($r['code'] . ($r['city'] ? ' · ' . $r['city'] : ''))]
                ),
                'ink_colours' => $this->rows(
                    'SELECT id, code, name, name_ur, hex, is_process FROM ink_colours
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order, code',
                    fn ($r) => ['sub' => $r['code']]
                ),
                'items' => $this->rows(
                    'SELECT i.id, i.code, i.name, i.name_ur, i.item_type, i.unit_id, u.code AS unit_code, u.to_base AS unit_to_base,
                            u.dimension AS unit_dimension, u.decimals AS unit_decimals, i.ink_colour_id, i.process_type, i.rate, i.gsm, i.width_inch, i.track_lots
                     FROM items i JOIN units u ON u.id = i.unit_id
                     WHERE i.is_active = 1 AND i.deleted_at IS NULL ORDER BY i.item_type, i.name',
                    fn ($r) => ['sub' => $r['code'] . ' · ' . $r['unit_code']]
                ),
                'machines' => $this->rows(
                    'SELECT id, code, name, name_ur, machine_type, speed_m_per_hr, hourly_cost, warehouse_id FROM machines
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY name',
                    fn ($r) => ['sub' => $r['code'] . ' · ' . $r['machine_type']]
                ),
                'designs' => $this->rows(
                    'SELECT id, design_code AS code, name, NULL AS name_ur, party_id, process_type FROM designs
                     WHERE is_active = 1 AND deleted_at IS NULL ORDER BY design_code',
                    fn ($r) => ['sub' => $r['code']]
                ),
                'ink_params' => InkService::params(),
                default => throw HttpException::validation(['sets' => Lang::t('validation.in')]),
            };
        }
        return $out;
    }

    private function rows(string $sql, callable $extra): array
    {
        return array_map(static function (array $r) use ($extra): array {
            $id = (int) $r['id'];
            unset($r['id']);
            return ['value' => $id, 'label' => $r['name'], 'label_ur' => $r['name_ur'] ?: null] + $extra($r) + $r;
        }, DB::all($sql));
    }
}
