<?php
declare(strict_types=1);

/** Read-only stock helpers for voucher screens. */
final class StockController
{
    /**
     * GET stock/balance?warehouse_id=&item_id=  → balances per item / lot (non-zero only).
     * Used by voucher grids to show available quantity and lot suggestions.
     */
    public function balance(): array
    {
        $wh = Request::queryInt('warehouse_id');
        if ($wh <= 0) {
            throw HttpException::validation(['warehouse_id' => Lang::t('validation.required')]);
        }
        $where = 'sm.warehouse_id = :w';
        $params = ['w' => $wh];
        if (($item = Request::queryInt('item_id')) > 0) {
            $where .= ' AND sm.item_id = :i';
            $params['i'] = $item;
        }
        $rows = DB::all(
            "SELECT sm.item_id, sm.lot_no, SUM(sm.qty_in - sm.qty_out) AS qty, SUM(sm.rolls_in - sm.rolls_out) AS rolls
             FROM stock_movements sm WHERE $where
             GROUP BY sm.item_id, sm.lot_no HAVING ABS(qty) > 0.0005 ORDER BY sm.item_id, sm.lot_no",
            $params
        );
        return array_map(static fn ($r) => [
            'item_id' => (int) $r['item_id'],
            'lot_no'  => $r['lot_no'],
            'qty'     => (float) $r['qty'],
            'rolls'   => (int) $r['rolls'],
        ], $rows);
    }
}
