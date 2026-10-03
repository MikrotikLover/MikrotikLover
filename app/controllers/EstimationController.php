<?php
declare(strict_types=1);

/**
 * Production Estimation Voucher (PEV): design + order meters → ink ml per
 * colour, paper, chemicals, fabric, machine hours and estimated cost.
 * Lines are calculated on the server (never entered). No stock effect.
 */
final class EstimationController extends VoucherController
{
    protected string $type = 'PEV';
    protected string $table = 'production_estimations';
    protected string $linesTable = 'production_estimation_lines';
    protected string $fk = 'estimation_id';
    protected bool $linesFromBody = false;
    protected array $intColumns = ['party_id', 'design_id', 'machine_id', 'fabric_item_id'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'unit_id', 'ink_colour_id'];

    private array $calc = [];

    protected function headerRules(): array
    {
        return [
            'party_id'          => 'nullable|integer|exists:parties,id,soft',
            'order_ref'         => 'nullable|string|max:40',
            'design_id'         => 'required|integer|exists:designs,id,soft',
            'machine_id'        => 'nullable|integer|exists:machines,id,soft',
            'fabric_item_id'    => 'nullable|integer|exists:items,id,soft',
            'fabric_gsm'        => 'nullable|numeric|gte:0|lte:5000',
            'fabric_width_inch' => 'nullable|numeric|gte:0|lte:1000',
            'meters'            => 'required|numeric|gte:0.01|lte:100000000',
            'wastage_pct'       => 'nullable|numeric|gte:0|lte:100',
        ];
    }

    protected function lineRules(): array
    {
        return [];
    }

    protected function checkHeader(array $h, ?array $old): array
    {
        if (!empty($h['fabric_item_id'])
            && !in_array(DB::value('SELECT item_type FROM items WHERE id = :id', ['id' => $h['fabric_item_id']]), ['grey_fabric', 'finished_fabric'], true)) {
            return ['fabric_item_id' => Lang::t('production.fabric_type')];
        }
        return [];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        $this->calc = ProductionService::estimate($h);
        return $this->calc['lines'];
    }

    protected function totals(array $lines): array
    {
        // Resolved GSM / width / wastage are saved so the estimate can be reproduced.
        return array_intersect_key($this->calc['header'], array_flip(['fabric_gsm', 'fabric_width_inch', 'wastage_pct'])) + $this->calc['totals'];
    }

    protected function movements(array $h, int $id, string $no, array $lines, array $items): array
    {
        return [];
    }

    /** POST estimations/calc — live preview for the entry form (nothing saved). */
    public function calc(): array
    {
        $h = Validator::make(Request::body(), $this->headerRules());
        if ($errors = $this->checkHeader($h, null)) {
            throw HttpException::validation($errors);
        }
        $r = ProductionService::estimate($h);
        $names = [];
        foreach ($r['lines'] as &$l) {
            $l['item_name'] = $l['item_id'] ? (ProductionService::item((int) $l['item_id'])['name'] ?? '') : '';
            $l['unit_code'] = $l['line_type'] === 'ink' ? 'ml' : (ProductionService::item((int) $l['item_id'])['unit_code'] ?? '');
            if ($l['ink_colour_id']) {
                $names[$l['ink_colour_id']] ??= DB::one('SELECT code, name, hex FROM ink_colours WHERE id = :id', ['id' => $l['ink_colour_id']]);
                $l['colour_code'] = $names[$l['ink_colour_id']]['code'];
                $l['colour_name'] = $names[$l['ink_colour_id']]['name'];
                $l['colour_hex'] = $names[$l['ink_colour_id']]['hex'];
            }
        }
        unset($l);
        return $r;
    }

    protected function selectSql(): string
    {
        return 'v.*, d.design_code, d.name AS design_name, p.name AS party_name, p.name_ur AS party_name_ur,
                m.name AS machine_name, m.name_ur AS machine_name_ur, fi.code AS fabric_item_code, fi.name AS fabric_item_name';
    }

    protected function joinSql(): string
    {
        return 'JOIN designs d ON d.id = v.design_id LEFT JOIN parties p ON p.id = v.party_id
                LEFT JOIN machines m ON m.id = v.machine_id LEFT JOIN items fi ON fi.id = v.fabric_item_id';
    }

    protected function lineSelectSql(): string
    {
        return 'l.*, i.code AS item_code, i.name AS item_name, i.name_ur AS item_name_ur, i.item_type, u.code AS unit_code,
                c.code AS colour_code, c.name AS colour_name, c.name_ur AS colour_name_ur, c.hex AS colour_hex';
    }

    protected function lineJoinSql(): string
    {
        return 'LEFT JOIN items i ON i.id = l.item_id LEFT JOIN units u ON u.id = l.unit_id LEFT JOIN ink_colours c ON c.id = l.ink_colour_id';
    }

    protected function searchColumns(): array
    {
        return ['d.design_code', 'd.name', 'p.name', 'v.order_ref'];
    }
}
