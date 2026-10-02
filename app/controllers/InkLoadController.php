<?php
declare(strict_types=1);

/**
 * Ink Loading: ml of each ink filled into a machine's tanks. Stock OUT of the
 * machine's floor warehouse; ml converted to the ink's stock unit (liter/ml).
 */
final class InkLoadController extends VoucherController
{
    protected string $type = 'INK';
    protected string $table = 'ink_loads';
    protected string $linesTable = 'ink_load_lines';
    protected string $fk = 'ink_load_id';
    protected array $intColumns = ['machine_id', 'warehouse_id'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'ink_colour_id'];

    protected function headerRules(): array
    {
        return [
            'voucher_time' => self::TIME,
            'machine_id'   => 'required|integer|exists:machines,id,soft',
            'warehouse_id' => 'required|integer|exists:warehouses,id,soft',
        ];
    }

    protected function lineRules(): array
    {
        return [
            'item_id'   => 'required|integer',
            'lot_no'    => self::LOT,
            'ml_filled' => 'required|numeric|gte:0.001|lte:10000000',
        ];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        foreach ($lines as &$l) {
            $item = $items[(int) $l['item_id']];
            if ($item['item_type'] !== 'ink' || $item['unit_dimension'] !== 'volume') {
                $err($l['_row'], 'item_id', Lang::t('ink_load.not_ink'));
                continue;
            }
            $this->requireLot($l, $item, $err);
            $l['lot_no'] = trim((string) ($l['lot_no'] ?? ''));
            $l['ink_colour_id'] = (int) $item['ink_colour_id'];
            // ml → liters → item unit (liter: ×1, ml: ÷0.001)
            $l['qty'] = (string) round(((float) $l['ml_filled'] / 1000) / (float) $item['unit_to_base'], 3);
            if ((float) $l['qty'] <= 0) {
                $err($l['_row'], 'ml_filled', Lang::t('ink_load.too_small'));
            }
            $l['rate'] = (string) $item['rate'];
            $l['amount'] = (string) round((float) $l['qty'] * (float) $item['rate'], 2);
        }
        return $lines;
    }

    protected function totals(array $lines): array
    {
        return [
            'total_ml'     => (string) round(array_sum(array_map('floatval', array_column($lines, 'ml_filled'))), 3),
            'total_amount' => (string) round(array_sum(array_map('floatval', array_column($lines, 'amount'))), 2),
        ];
    }

    protected function movements(array $h, int $id, string $no, array $lines, array $items): array
    {
        return array_map(fn ($l) => [
            'item_id'         => $l['item_id'],
            'warehouse_id'    => $h['warehouse_id'],
            'lot_no'          => Stock::ledgerLot($items[(int) $l['item_id']], $l['lot_no']),
            'qty_out'         => $l['qty'],
            'rate'            => $l['rate'],
            'machine_id'      => $h['machine_id'],
            'voucher_line_id' => $l['id'],
            '_err'            => "lines.{$l['_row']}.ml_filled",
        ], $lines);
    }

    protected function selectSql(): string
    {
        return 'v.*, m.code AS machine_code, m.name AS machine_name, m.name_ur AS machine_name_ur, w.name AS warehouse_name, w.name_ur AS warehouse_name_ur';
    }

    protected function joinSql(): string
    {
        return 'JOIN machines m ON m.id = v.machine_id JOIN warehouses w ON w.id = v.warehouse_id';
    }

    protected function lineSelectSql(): string
    {
        return parent::lineSelectSql() . ', c.code AS colour_code, c.name AS colour_name, c.name_ur AS colour_name_ur, c.hex AS colour_hex';
    }

    protected function lineJoinSql(): string
    {
        return parent::lineJoinSql() . ' JOIN ink_colours c ON c.id = l.ink_colour_id';
    }

    protected function searchColumns(): array
    {
        return ['m.name'];
    }
}
