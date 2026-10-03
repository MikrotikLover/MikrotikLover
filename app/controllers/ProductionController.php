<?php
declare(strict_types=1);

/**
 * Base for BOM Production (BOM) and Manual Production (MPV), both stored in
 * `productions` / `production_lines`.
 *
 * Stock posted per voucher:
 *   OUT grey fabric   = printed meters (good + wastage + rejected), from the fabric warehouse/lot
 *   IN  finished fabric = good meters, to the finished warehouse (lot defaults to the fabric lot,
 *                          job-work owner carried over)
 *   OUT paper / chemicals / other material lines (actual qty)
 *   Ink lines are recorded (estimated vs actual ml, cost) but not deducted: ink
 *   already left stock on the Ink Loading voucher.
 *
 * Costing: material (lines + own fabric; job-work fabric costs 0) + ink + machine
 * hours × hourly cost → cost per good meter.
 */
abstract class ProductionController extends VoucherController
{
    protected string $table = 'productions';
    protected string $linesTable = 'production_lines';
    protected string $fk = 'production_id';
    protected array $intColumns = ['party_id', 'design_id', 'machine_id', 'estimation_id', 'fabric_item_id', 'fabric_warehouse_id',
        'finished_item_id', 'finished_warehouse_id', 'produced_rolls'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'ink_colour_id', 'warehouse_id'];
    protected bool $requireLines = false;

    /** 'bom' or 'manual'. */
    protected string $productionType;
    private array $calc = [];

    protected function scopeSql(): string
    {
        return "v.production_type = '{$this->productionType}'";
    }

    protected function fixedHeader(): array
    {
        return ['production_type' => $this->productionType];
    }

    protected function headerRules(): array
    {
        $dt = 'nullable|string|regex:/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/';
        return [
            'party_id'              => 'nullable|integer|exists:parties,id,soft',
            'design_id'             => ($this->productionType === 'bom' ? 'required' : 'nullable') . '|integer|exists:designs,id,soft',
            'machine_id'            => 'required|integer|exists:machines,id,soft',
            'estimation_id'         => 'nullable|integer|exists:production_estimations,id,soft',
            'start_time'            => $dt,
            'end_time'              => $dt,
            'machine_hours'         => 'nullable|numeric|gte:0|lte:10000',
            'operator_name'         => 'nullable|string|max:80',
            'fabric_item_id'        => 'required|integer|exists:items,id,soft',
            'fabric_warehouse_id'   => 'required|integer|exists:warehouses,id,soft',
            'fabric_lot_no'         => self::LOT,
            'finished_item_id'      => 'required|integer|exists:items,id,soft',
            'finished_warehouse_id' => 'required|integer|exists:warehouses,id,soft',
            'finished_lot_no'       => self::LOT,
            'produced_qty'          => self::QTY,
            'produced_rolls'        => 'nullable|integer|gte:0|lte:100000',
            'wastage_qty'           => 'nullable|numeric|gte:0|lte:100000000',
            'rejected_qty'          => 'nullable|numeric|gte:0|lte:100000000',
            'material_warehouse_id' => 'required|integer|exists:warehouses,id,soft',
        ];
    }

    protected function lineRules(): array
    {
        return [
            'item_id'    => 'required|integer',
            'lot_no'     => self::LOT,
            'actual_qty' => 'nullable|numeric|gte:0|lte:99999999999',
        ];
    }

    protected function checkHeader(array $h, ?array $old): array
    {
        $errors = [];
        $type = fn ($id) => DB::value('SELECT item_type FROM items WHERE id = :id', ['id' => $id]);
        if (!empty($h['fabric_item_id']) && $type($h['fabric_item_id']) !== 'grey_fabric') {
            $errors['fabric_item_id'] = Lang::t('production.grey_required');
        }
        if (!empty($h['finished_item_id']) && $type($h['finished_item_id']) !== 'finished_fabric') {
            $errors['finished_item_id'] = Lang::t('design.finished_item_type');
        }
        if (!empty($h['start_time']) && !empty($h['end_time']) && strtotime((string) $h['end_time']) < strtotime((string) $h['start_time'])) {
            $errors['end_time'] = Lang::t('production.end_before_start');
        }
        return $errors;
    }

    protected function extraLockItems(array $h): array
    {
        $ids = [(int) ($h['fabric_item_id'] ?? 0), (int) ($h['finished_item_id'] ?? 0)];
        if (!empty($h['design_id'])) {
            $ids = array_merge($ids, array_map('intval', DB::column('SELECT item_id FROM design_bom WHERE design_id = :d', ['d' => (int) $h['design_id']])));
        }
        return array_filter($ids);
    }

    /** Requirement from the design (BOM production only): item_id → est qty in item unit. */
    protected function requirement(array $h, float $printed, callable $headerErr): array
    {
        return [];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        $produced = (float) $h['produced_qty'];
        $wastage = (float) ($h['wastage_qty'] ?? 0);
        $rejected = (float) ($h['rejected_qty'] ?? 0);
        $printed = $produced + $wastage + $rejected;
        $headerErrors = [];
        $headerErr = function (string $field, string $msg) use (&$headerErrors): void {
            $headerErrors[$field] ??= $msg;
        };

        $fabric = ProductionService::item((int) $h['fabric_item_id']);
        $finished = ProductionService::item((int) $h['finished_item_id']);
        $fabricQty = ProductionService::metersToQty($fabric, $printed);
        $finishedQty = ProductionService::metersToQty($finished, $produced);
        if ($fabricQty === null) {
            $headerErr('fabric_item_id', Lang::t('production.no_conversion'));
        }
        if ($finishedQty === null) {
            $headerErr('finished_item_id', Lang::t('production.no_conversion'));
        }
        $fabricLot = Stock::ledgerLot($fabric, $h['fabric_lot_no'] ?? '');
        if ((int) $fabric['track_lots'] && $fabricLot === '') {
            $headerErr('fabric_lot_no', Lang::t('stock.lot_required'));
        }

        $req = $this->requirement($h, $printed, $headerErr);

        // Entered lines (actual quantities), merged with the BOM requirement.
        $built = [];
        $seen = [];
        foreach ($lines as $l) {
            $id = (int) $l['item_id'];
            $item = ProductionService::item($id) ?? $items[$id];
            if (in_array($item['item_type'], ['grey_fabric', 'finished_fabric'], true)) {
                $err($l['_row'], 'item_id', Lang::t('production.no_fabric_line'));
                continue;
            }
            if (isset($seen[$id])) {
                $err($l['_row'], 'item_id', Lang::t('design.duplicate_item'));
                continue;
            }
            $seen[$id] = true;
            $est = $req[$id]['qty'] ?? 0.0;
            $actual = $l['actual_qty'] !== null ? (float) $l['actual_qty'] : $est;
            if ($item['item_type'] !== 'ink' && (int) $item['track_lots'] && $actual > 0 && trim((string) ($l['lot_no'] ?? '')) === '') {
                $err($l['_row'], 'lot_no', Lang::t('stock.lot_required'));
            }
            $built[] = $this->line($h, $item, $est, $actual, (string) ($l['lot_no'] ?? ''), $l['_row']);
        }
        // BOM lines the user did not list are still consumed at the estimated quantity.
        foreach ($req as $id => $r) {
            if (!isset($seen[$id])) {
                $built[] = $this->line($h, ProductionService::item($id), $r['qty'], $r['qty'], '', null);
            }
        }
        if ($headerErrors) {
            throw HttpException::validation($headerErrors);
        }

        // ---- costing
        $inkEst = 0.0; $inkAct = 0.0; $inkCost = 0.0; $matCost = 0.0;
        foreach ($built as $b) {
            if ($b['line_type'] === 'ink') {
                $item = ProductionService::item((int) $b['item_id']);
                $inkEst += (float) $b['est_qty'] * (float) $item['unit_to_base'] * 1000;
                $inkAct += (float) $b['actual_qty'] * (float) $item['unit_to_base'] * 1000;
                $inkCost += (float) $b['amount'];
            } else {
                $matCost += (float) $b['amount'];
            }
        }
        $owner = Stock::lotOwner((int) $fabric['id'], $fabricLot);
        // Job-work fabric belongs to the customer: no fabric cost for us.
        $fabricCost = $owner === null ? round((float) $fabricQty * (float) $fabric['rate'], 2) : 0.0;
        $machine = DB::one('SELECT speed_m_per_hr, hourly_cost FROM machines WHERE id = :id', ['id' => (int) $h['machine_id']]);
        $hours = $h['machine_hours'] !== null ? (float) $h['machine_hours'] : null;
        if ($hours === null && !empty($h['start_time']) && !empty($h['end_time'])) {
            $hours = round((strtotime((string) $h['end_time']) - strtotime((string) $h['start_time'])) / 3600, 2);
        }
        if ($hours === null) {
            $hours = (float) $machine['speed_m_per_hr'] > 0 ? round($printed / (float) $machine['speed_m_per_hr'], 2) : 0.0;
        }
        $machineCost = round($hours * (float) $machine['hourly_cost'], 2);
        $material = round($matCost + $fabricCost, 2);
        $total = round($material + $inkCost + $machineCost, 2);

        $this->calc = [
            'header' => [
                'fabric_issued_qty'  => (string) round((float) $fabricQty, 3),
                'finished_lot_no'    => trim((string) ($h['finished_lot_no'] ?? '')) !== '' ? trim((string) $h['finished_lot_no']) : trim((string) ($h['fabric_lot_no'] ?? '')),
                'fabric_lot_no'      => trim((string) ($h['fabric_lot_no'] ?? '')),
                'produced_rolls'     => (int) ($h['produced_rolls'] ?? 0),
                'wastage_qty'        => (string) $wastage,
                'rejected_qty'       => (string) $rejected,
                'machine_hours'      => (string) $hours,
                'ink_ml_estimated'   => (string) round($inkEst, 3),
                'ink_ml_actual'      => (string) round($inkAct, 3),
                'material_cost'      => (string) $material,
                'ink_cost'           => (string) round($inkCost, 2),
                'machine_cost'       => (string) $machineCost,
                'total_cost'         => (string) $total,
                'cost_per_meter'     => (string) ($produced > 0 ? round($total / $produced, 4) : 0),
            ],
            'fabric'      => $fabric,
            'finished'    => $finished,
            'fabricQty'   => (float) $fabricQty,
            'finishedQty' => (float) $finishedQty,
            'fabricLot'   => $fabricLot,
            'owner'       => $owner,
        ];
        return $built;
    }

    private function line(array $h, array $item, float $est, float $actual, string $lot, ?int $row): array
    {
        $type = $item['item_type'] === 'ink' ? 'ink' : (in_array($item['item_type'], ['paper', 'chemical'], true) ? $item['item_type'] : 'other');
        return [
            '_row'          => $row,
            'line_type'     => $type,
            'item_id'       => (int) $item['id'],
            'ink_colour_id' => $type === 'ink' ? (int) $item['ink_colour_id'] : null,
            'warehouse_id'  => (int) $h['material_warehouse_id'],
            'lot_no'        => trim($lot),
            'est_qty'       => (string) round($est, 3),
            'actual_qty'    => (string) round($actual, 3),
            'rate'          => (string) $item['rate'],
            'amount'        => (string) round($actual * (float) $item['rate'], 2),
        ];
    }

    protected function totals(array $lines): array
    {
        return $this->calc['header'];
    }

    protected function movements(array $h, int $id, string $no, array $lines, array $items): array
    {
        $c = $this->calc;
        $common = ['party_id' => $h['party_id'], 'machine_id' => $h['machine_id'], 'design_id' => $h['design_id']];
        $rows = [];
        if ($c['fabricQty'] > 0) {
            $rows[] = $common + [
                'item_id' => $c['fabric']['id'], 'warehouse_id' => $h['fabric_warehouse_id'], 'lot_no' => $c['fabricLot'],
                'qty_out' => (string) round($c['fabricQty'], 3), 'rate' => $c['fabric']['rate'], 'owner_party_id' => $c['owner'],
                '_err' => $c['fabricLot'] !== '' ? 'fabric_lot_no' : 'fabric_item_id',
            ];
        }
        $toBase = (float) $c['finished']['unit_to_base'] ?: 1.0;
        $rows[] = $common + [
            'item_id' => $c['finished']['id'], 'warehouse_id' => $h['finished_warehouse_id'],
            'lot_no' => Stock::ledgerLot($c['finished'], $c['header']['finished_lot_no']),
            'qty_in' => (string) round($c['finishedQty'], 3), 'rolls_in' => $c['header']['produced_rolls'],
            // cost per stock unit of finished fabric
            'rate' => (string) round((float) $c['header']['cost_per_meter'] * $toBase, 4), 'owner_party_id' => $c['owner'],
        ];
        foreach ($lines as $l) {
            if ($l['line_type'] === 'ink' || (float) $l['actual_qty'] <= 0) {
                continue;
            }
            $item = ProductionService::item((int) $l['item_id']);
            $rows[] = $common + [
                'item_id' => $l['item_id'], 'warehouse_id' => $l['warehouse_id'], 'lot_no' => Stock::ledgerLot($item, $l['lot_no']),
                'qty_out' => $l['actual_qty'], 'rate' => $l['rate'], 'voucher_line_id' => $l['id'],
                '_err' => $l['_row'] !== null ? "lines.{$l['_row']}.actual_qty" : null,
            ];
        }
        return $rows;
    }

    public function show(int $id): array
    {
        $v = parent::show($id);
        $v['material_warehouse_id'] = $v['lines'][0]['warehouse_id'] ?? null;
        $v['printed_qty'] = (string) round((float) $v['produced_qty'] + (float) $v['wastage_qty'] + (float) $v['rejected_qty'], 3);
        $v['ink_variance_pct'] = (float) $v['ink_ml_estimated'] > 0
            ? round(((float) $v['ink_ml_actual'] - (float) $v['ink_ml_estimated']) / (float) $v['ink_ml_estimated'] * 100, 2) : null;
        return $v;
    }

    protected function selectSql(): string
    {
        return 'v.*, d.design_code, d.name AS design_name, p.name AS party_name, p.name_ur AS party_name_ur,
                m.code AS machine_code, m.name AS machine_name, m.name_ur AS machine_name_ur,
                fi.code AS fabric_item_code, fi.name AS fabric_item_name, fu.code AS fabric_unit_code,
                ni.code AS finished_item_code, ni.name AS finished_item_name, nu.code AS finished_unit_code,
                fw.name AS fabric_warehouse_name, nw.name AS finished_warehouse_name, e.voucher_no AS estimation_no';
    }

    protected function joinSql(): string
    {
        return 'JOIN machines m ON m.id = v.machine_id
                LEFT JOIN designs d ON d.id = v.design_id LEFT JOIN parties p ON p.id = v.party_id
                LEFT JOIN items fi ON fi.id = v.fabric_item_id LEFT JOIN units fu ON fu.id = fi.unit_id
                LEFT JOIN items ni ON ni.id = v.finished_item_id LEFT JOIN units nu ON nu.id = ni.unit_id
                LEFT JOIN warehouses fw ON fw.id = v.fabric_warehouse_id LEFT JOIN warehouses nw ON nw.id = v.finished_warehouse_id
                LEFT JOIN production_estimations e ON e.id = v.estimation_id';
    }

    protected function lineSelectSql(): string
    {
        return parent::lineSelectSql() . ', c.code AS colour_code, c.name AS colour_name, c.name_ur AS colour_name_ur, c.hex AS colour_hex, w.name AS warehouse_name';
    }

    protected function lineJoinSql(): string
    {
        return parent::lineJoinSql() . ' LEFT JOIN ink_colours c ON c.id = l.ink_colour_id JOIN warehouses w ON w.id = l.warehouse_id';
    }

    protected function searchColumns(): array
    {
        return ['d.design_code', 'p.name', 'm.name', 'v.fabric_lot_no', 'v.finished_lot_no'];
    }

    /** POST production/requirements {design_id, meters} — BOM lines for the entry form. */
    public function requirements(): array
    {
        $data = Validator::make(Request::body(), [
            'design_id' => 'required|integer|exists:designs,id,soft',
            'meters'    => 'required|numeric|gte:0|lte:100000000',
        ]);
        $design = ProductionService::design((int) $data['design_id']);
        $out = ['lines' => [], 'warnings' => []];
        foreach (ProductionService::inkRequirement($design, (float) $data['meters']) as $ink) {
            if ($ink['item'] === null) {
                $out['warnings'][] = Lang::t('production.no_ink_item', ['colour' => $ink['colour_code']]);
                continue;
            }
            $out['lines'][] = ['item_id' => (int) $ink['item']['id'], 'line_type' => 'ink', 'est_qty' => (string) $ink['qty'], 'ml' => $ink['ml']];
        }
        foreach (ProductionService::bomRequirement($design, (float) $data['meters']) as $b) {
            $out['lines'][] = ['item_id' => (int) $b['item']['id'], 'line_type' => $b['item']['item_type'], 'est_qty' => (string) $b['qty']];
        }
        $out['design'] = ['finished_item_id' => $design['finished_item_id'] ? (int) $design['finished_item_id'] : null,
            'default_machine_id' => $design['default_machine_id'] ? (int) $design['default_machine_id'] : null,
            'party_id' => $design['party_id'] ? (int) $design['party_id'] : null];
        return $out;
    }
}
