<?php
declare(strict_types=1);

/** Stock Transfer Voucher: OUT of one warehouse, IN to another (source must have stock). */
final class StockTransferController extends VoucherController
{
    protected string $type = 'STV';
    protected string $table = 'stock_transfers';
    protected string $linesTable = 'stock_transfer_lines';
    protected string $fk = 'transfer_id';
    protected array $intColumns = ['from_warehouse_id', 'to_warehouse_id', 'total_rolls'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'rolls', 'owner_party_id'];

    protected function headerRules(): array
    {
        return [
            'from_warehouse_id' => 'required|integer|exists:warehouses,id,soft',
            'to_warehouse_id'   => 'required|integer|exists:warehouses,id,soft',
        ];
    }

    protected function lineRules(): array
    {
        return [
            'item_id' => 'required|integer',
            'lot_no'  => self::LOT,
            'rolls'   => 'nullable|integer|gte:0|lte:100000',
            'qty'     => self::QTY,
            'remarks' => 'nullable|string|max:255',
        ];
    }

    protected function checkHeader(array $h, ?array $old): array
    {
        return isset($h['from_warehouse_id'], $h['to_warehouse_id']) && (int) $h['from_warehouse_id'] === (int) $h['to_warehouse_id']
            ? ['to_warehouse_id' => Lang::t('transfer.same_warehouse')] : [];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        foreach ($lines as &$l) {
            $item = $items[(int) $l['item_id']];
            $this->requireLot($l, $item, $err);
            $l['rolls'] = (int) ($l['rolls'] ?? 0);
            $l['lot_no'] = trim((string) ($l['lot_no'] ?? ''));
            $l['owner_party_id'] = Stock::lotOwner((int) $l['item_id'], Stock::ledgerLot($item, $l['lot_no']));
        }
        return $lines;
    }

    protected function totals(array $lines): array
    {
        return [
            'total_rolls' => array_sum(array_column($lines, 'rolls')),
            'total_qty'   => (string) round(array_sum(array_map('floatval', array_column($lines, 'qty'))), 3),
        ];
    }

    protected function movements(array $h, int $id, string $no, array $lines, array $items): array
    {
        $rows = [];
        foreach ($lines as $l) {
            $item = $items[(int) $l['item_id']];
            $common = [
                'item_id'         => $l['item_id'],
                'lot_no'          => Stock::ledgerLot($item, $l['lot_no']),
                'rate'            => $item['rate'],
                'owner_party_id'  => $l['owner_party_id'],
                'voucher_line_id' => $l['id'],
            ];
            $rows[] = $common + ['warehouse_id' => $h['from_warehouse_id'], 'qty_out' => $l['qty'], 'rolls_out' => $l['rolls'], '_err' => "lines.{$l['_row']}.qty"];
            $rows[] = $common + ['warehouse_id' => $h['to_warehouse_id'], 'qty_in' => $l['qty'], 'rolls_in' => $l['rolls']];
        }
        return $rows;
    }

    protected function selectSql(): string
    {
        return 'v.*, wf.name AS from_warehouse_name, wf.name_ur AS from_warehouse_name_ur, wt.name AS to_warehouse_name, wt.name_ur AS to_warehouse_name_ur';
    }

    protected function joinSql(): string
    {
        return 'JOIN warehouses wf ON wf.id = v.from_warehouse_id JOIN warehouses wt ON wt.id = v.to_warehouse_id';
    }
}
