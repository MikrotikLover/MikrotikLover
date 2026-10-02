<?php
declare(strict_types=1);

/**
 * The stock ledger. Every stock-affecting voucher posts rows to
 * stock_movements through this class; balances are always SUM(qty_in - qty_out).
 *
 * Usage inside a voucher save transaction:
 *   Stock::lockItems($itemIds);           // serialise concurrent saves per item
 *   Stock::remove('IGP', $id);            // on edit / cancel
 *   Stock::post($rows);
 *   Stock::assertNonNegative($checks);    // throws 422 if any balance < 0
 *
 * Lots: only items with track_lots = 1 keep a lot number in the ledger; for
 * other items the ledger lot is '' (the voucher line still stores what was typed).
 */
final class Stock
{
    private const EPS = 0.0005;

    /** SELECT … FOR UPDATE on the items, in id order (consistent order avoids deadlocks). */
    public static function lockItems(array $itemIds): void
    {
        $ids = array_values(array_unique(array_map('intval', array_filter($itemIds))));
        if (!$ids) {
            return;
        }
        sort($ids);
        $params = [];
        DB::query('SELECT id FROM items WHERE id IN ' . DB::in($ids, $params) . ' ORDER BY id FOR UPDATE', $params);
    }

    /** Item info needed for posting (unit, lot tracking, rate). */
    public static function items(array $itemIds): array
    {
        $ids = array_values(array_unique(array_map('intval', array_filter($itemIds))));
        if (!$ids) {
            return [];
        }
        $params = [];
        $rows = DB::all(
            'SELECT i.id, i.code, i.name, i.item_type, i.unit_id, i.track_lots, i.rate, i.ink_colour_id,
                    u.code AS unit_code, u.dimension AS unit_dimension, u.to_base AS unit_to_base, u.decimals AS unit_decimals
             FROM items i JOIN units u ON u.id = i.unit_id
             WHERE i.deleted_at IS NULL AND i.id IN ' . DB::in($ids, $params),
            $params
        );
        $out = [];
        foreach ($rows as $r) {
            $out[(int) $r['id']] = $r;
        }
        return $out;
    }

    public static function ledgerLot(array $item, ?string $lot): string
    {
        return (int) $item['track_lots'] ? trim((string) $lot) : '';
    }

    /** @param array<int, array> $rows */
    public static function post(array $rows): void
    {
        foreach ($rows as $r) {
            DB::insert('stock_movements', [
                'movement_date'   => $r['movement_date'],
                'item_id'         => (int) $r['item_id'],
                'warehouse_id'    => (int) $r['warehouse_id'],
                'lot_no'          => (string) ($r['lot_no'] ?? ''),
                'owner_party_id'  => $r['owner_party_id'] ?? null,
                'qty_in'          => (string) ($r['qty_in'] ?? 0),
                'qty_out'         => (string) ($r['qty_out'] ?? 0),
                'rolls_in'        => (int) ($r['rolls_in'] ?? 0),
                'rolls_out'       => (int) ($r['rolls_out'] ?? 0),
                'rate'            => (string) ($r['rate'] ?? 0),
                'voucher_type'    => $r['voucher_type'],
                'voucher_id'      => (int) $r['voucher_id'],
                'voucher_line_id' => $r['voucher_line_id'] ?? null,
                'voucher_no'      => $r['voucher_no'],
                'party_id'        => $r['party_id'] ?? null,
                'machine_id'      => $r['machine_id'] ?? null,
                'design_id'       => $r['design_id'] ?? null,
                'created_at'      => DB::now(),
                'created_by'      => Auth::id(),
            ]);
        }
    }

    /** Deletes a voucher's ledger rows; returns the balance keys they touched. */
    public static function remove(string $voucherType, int $voucherId): array
    {
        $keys = DB::all(
            'SELECT DISTINCT item_id, warehouse_id, lot_no FROM stock_movements WHERE voucher_type = :t AND voucher_id = :id',
            ['t' => $voucherType, 'id' => $voucherId]
        );
        DB::query('DELETE FROM stock_movements WHERE voucher_type = :t AND voucher_id = :id', ['t' => $voucherType, 'id' => $voucherId]);
        return $keys;
    }

    public static function balance(int $itemId, int $warehouseId, string $lot = ''): float
    {
        return (float) DB::value(
            'SELECT COALESCE(SUM(qty_in - qty_out), 0) FROM stock_movements WHERE item_id = :i AND warehouse_id = :w AND lot_no = :l',
            ['i' => $itemId, 'w' => $warehouseId, 'l' => $lot]
        );
    }

    /**
     * Verifies no balance went negative after posting.
     * @param array $checks list of [item_id, warehouse_id, lot_no, errorKey|null, outQtyOfThisVoucher]
     * Lines that share a key are merged; the error goes on the last such line.
     */
    public static function assertNonNegative(array $checks): void
    {
        $merged = [];
        foreach ($checks as $c) {
            $k = $c[0] . '|' . $c[1] . '|' . $c[2];
            $merged[$k] = [
                'item' => (int) $c[0], 'wh' => (int) $c[1], 'lot' => (string) $c[2],
                'key' => $c[3] ?? ($merged[$k]['key'] ?? null),
                'out' => ($merged[$k]['out'] ?? 0) + (float) ($c[4] ?? 0),
            ];
        }
        $errors = [];
        foreach ($merged as $m) {
            $bal = self::balance($m['item'], $m['wh'], $m['lot']);
            if ($bal >= -self::EPS) {
                continue;
            }
            $info = DB::one(
                'SELECT i.name, u.code AS unit_code, u.decimals, w.name AS wh_name
                 FROM items i JOIN units u ON u.id = i.unit_id, warehouses w WHERE i.id = :i AND w.id = :w',
                ['i' => $m['item'], 'w' => $m['wh']]
            );
            $available = max(0, $bal + $m['out']);
            $vars = [
                'available' => self::fmt($available, (int) $info['decimals']),
                'unit'      => $info['unit_code'],
                'item'      => $info['name'],
                'warehouse' => $info['wh_name'],
                'lot'       => $m['lot'] !== '' ? ' (' . Lang::t('stock.lot') . ' ' . $m['lot'] . ')' : '',
            ];
            if ($m['key'] !== null) {
                $errors[$m['key']] = Lang::t('stock.insufficient', $vars);
            } else {
                $errors['_stock'] = Lang::t('stock.would_go_negative', $vars);
            }
        }
        if ($errors) {
            throw HttpException::validation($errors, isset($errors['_stock']) ? $errors['_stock'] : null);
        }
    }

    /** 1234.500 → "1234.5", 120.000 → "120" (never strips integer zeros). */
    public static function fmt(float $qty, int $decimals = 3): string
    {
        $s = number_format($qty, max(0, $decimals), '.', '');
        return str_contains($s, '.') ? rtrim(rtrim($s, '0'), '.') : $s;
    }

    /** Owner (job-work party) of a lot, from its inward movements. */
    public static function lotOwner(int $itemId, string $lot): ?int
    {
        if ($lot === '') {
            return null;
        }
        $v = DB::value(
            'SELECT owner_party_id FROM stock_movements WHERE item_id = :i AND lot_no = :l AND qty_in > 0 AND owner_party_id IS NOT NULL ORDER BY id LIMIT 1',
            ['i' => $itemId, 'l' => $lot]
        );
        return $v !== null ? (int) $v : null;
    }
}
