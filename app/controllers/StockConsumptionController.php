<?php
declare(strict_types=1);

/** Stock Consumption Voucher: issue inks, paper, chemicals to a machine / job (stock OUT). */
final class StockConsumptionController extends VoucherController
{
    protected string $type = 'SCV';
    protected string $table = 'stock_consumptions';
    protected string $linesTable = 'stock_consumption_lines';
    protected string $fk = 'consumption_id';
    protected array $intColumns = ['warehouse_id', 'machine_id', 'party_id', 'design_id', 'production_id'];

    protected function headerRules(): array
    {
        return [
            'warehouse_id' => 'required|integer|exists:warehouses,id,soft',
            'machine_id'   => 'nullable|integer|exists:machines,id,soft',
            'party_id'     => 'nullable|integer|exists:parties,id,soft',
            'design_id'    => 'nullable|integer|exists:designs,id,soft',
            'purpose'      => 'required|in:production,sampling,maintenance,cleaning,other',
        ];
    }

    protected function lineRules(): array
    {
        return [
            'item_id' => 'required|integer',
            'lot_no'  => self::LOT,
            'qty'     => self::QTY,
            'rate'    => 'nullable|numeric|gte:0|lte:100000000',
            'remarks' => 'nullable|string|max:255',
        ];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        foreach ($lines as &$l) {
            $item = $items[(int) $l['item_id']];
            if (in_array($item['item_type'], ['grey_fabric', 'finished_fabric'], true)) {
                $err($l['_row'], 'item_id', Lang::t('consumption.no_fabric'));
            }
            $this->requireLot($l, $item, $err);
            $l['lot_no'] = trim((string) ($l['lot_no'] ?? ''));
            $l['rate'] = $l['rate'] === null ? (string) $item['rate'] : $l['rate'];
            $l['amount'] = (string) round((float) $l['qty'] * (float) $l['rate'], 2);
        }
        return $lines;
    }

    protected function totals(array $lines): array
    {
        return ['total_amount' => (string) round(array_sum(array_map('floatval', array_column($lines, 'amount'))), 2)];
    }

    protected function movements(array $h, int $id, string $no, array $lines, array $items): array
    {
        return array_map(fn ($l) => [
            'item_id'         => $l['item_id'],
            'warehouse_id'    => $h['warehouse_id'],
            'lot_no'          => Stock::ledgerLot($items[(int) $l['item_id']], $l['lot_no']),
            'qty_out'         => $l['qty'],
            'rate'            => $l['rate'],
            'party_id'        => $h['party_id'],
            'machine_id'      => $h['machine_id'],
            'design_id'       => $h['design_id'],
            'voucher_line_id' => $l['id'],
            '_err'            => "lines.{$l['_row']}.qty",
        ], $lines);
    }

    protected function selectSql(): string
    {
        return 'v.*, w.name AS warehouse_name, w.name_ur AS warehouse_name_ur, m.name AS machine_name, m.name_ur AS machine_name_ur,
                p.name AS party_name, p.name_ur AS party_name_ur, d.design_code, d.name AS design_name';
    }

    protected function joinSql(): string
    {
        return 'JOIN warehouses w ON w.id = v.warehouse_id LEFT JOIN machines m ON m.id = v.machine_id
                LEFT JOIN parties p ON p.id = v.party_id LEFT JOIN designs d ON d.id = v.design_id';
    }

    protected function searchColumns(): array
    {
        return ['m.name', 'd.design_code', 'p.name'];
    }
}
