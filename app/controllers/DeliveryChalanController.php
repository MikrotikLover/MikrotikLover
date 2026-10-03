<?php
declare(strict_types=1);

/**
 * Outward Gate Pass / Delivery Chalan (DCV): dispatch fabric to a party.
 * Stock OUT of the dispatch warehouse (normally the Finished Store).
 *
 * Job-work protection: a lot that belongs to another party (owner recorded on
 * its inward / production stock) cannot be delivered to this party.
 * Design / production of each line are filled from the production that made
 * the lot when not given, so the chalan shows the design.
 */
final class DeliveryChalanController extends VoucherController
{
    protected string $type = 'DCV';
    protected string $table = 'delivery_chalans';
    protected string $linesTable = 'delivery_chalan_lines';
    protected string $fk = 'chalan_id';
    protected array $intColumns = ['party_id', 'warehouse_id', 'total_rolls'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'unit_id', 'rolls', 'design_id', 'production_id'];

    protected function headerRules(): array
    {
        return [
            'voucher_time'     => self::TIME,
            'party_id'         => 'required|integer|exists:parties,id,soft',
            'warehouse_id'     => 'required|integer|exists:warehouses,id,soft',
            'party_ref'        => 'nullable|string|max:40',
            'delivery_address' => 'nullable|string|max:255',
            'vehicle_no'       => 'nullable|string|max:20',
            'driver_name'      => 'nullable|string|max:80',
            'driver_phone'     => self::PHONE,
            'receiver_name'    => 'nullable|string|max:80',
        ];
    }

    protected function lineRules(): array
    {
        return [
            'item_id'   => 'required|integer',
            'design_id' => 'nullable|integer|exists:designs,id,soft',
            'lot_no'    => self::LOT,
            'rolls'     => 'nullable|integer|gte:0|lte:100000',
            'qty'       => self::QTY,
            'remarks'   => 'nullable|string|max:255',
        ];
    }

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        foreach ($lines as &$l) {
            $item = $items[(int) $l['item_id']];
            if (!in_array($item['item_type'], ['finished_fabric', 'grey_fabric'], true)) {
                $err($l['_row'], 'item_id', Lang::t('chalan.fabric_only'));
                continue;
            }
            $this->requireLot($l, $item, $err);
            $l['lot_no'] = trim((string) ($l['lot_no'] ?? ''));
            $l['rolls'] = (int) ($l['rolls'] ?? 0);
            $l['unit_id'] = (int) $item['unit_id'];
            $lot = Stock::ledgerLot($item, $l['lot_no']);

            // A job-work lot may only go back to its owner.
            $owner = Stock::lotOwner((int) $item['id'], $lot);
            if ($owner !== null && $owner !== (int) $h['party_id']) {
                $name = (string) DB::value('SELECT name FROM parties WHERE id = :id', ['id' => $owner]);
                $err($l['_row'], 'lot_no', Lang::t('chalan.lot_other_owner', ['party' => $name]));
                continue;
            }

            // Design / production from the production that made this lot.
            if ($lot !== '') {
                $prod = DB::one(
                    "SELECT id, design_id FROM productions
                     WHERE finished_item_id = :i AND finished_lot_no = :l AND status = 'posted' AND deleted_at IS NULL
                     ORDER BY voucher_date DESC, id DESC LIMIT 1",
                    ['i' => (int) $item['id'], 'l' => $lot]
                );
                if ($prod !== null) {
                    $l['production_id'] = (int) $prod['id'];
                    $l['design_id'] ??= $prod['design_id'] !== null ? (int) $prod['design_id'] : null;
                }
            }
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
        return array_map(fn ($l) => [
            'item_id'         => $l['item_id'],
            'warehouse_id'    => $h['warehouse_id'],
            'lot_no'          => Stock::ledgerLot($items[(int) $l['item_id']], $l['lot_no']),
            'qty_out'         => $l['qty'],
            'rolls_out'       => $l['rolls'],
            'rate'            => $items[(int) $l['item_id']]['rate'],
            'party_id'        => $h['party_id'],
            'owner_party_id'  => Stock::lotOwner((int) $l['item_id'], Stock::ledgerLot($items[(int) $l['item_id']], $l['lot_no'])),
            'design_id'       => $l['design_id'] ?? null,
            'voucher_line_id' => $l['id'],
            '_err'            => "lines.{$l['_row']}.qty",
        ], $lines);
    }

    protected function selectSql(): string
    {
        return 'v.*, p.code AS party_code, p.name AS party_name, p.name_ur AS party_name_ur, p.phone AS party_phone,
                p.ntn AS party_ntn, p.address AS party_address, p.city AS party_city,
                w.name AS warehouse_name, w.name_ur AS warehouse_name_ur';
    }

    protected function joinSql(): string
    {
        return 'JOIN parties p ON p.id = v.party_id JOIN warehouses w ON w.id = v.warehouse_id';
    }

    protected function lineSelectSql(): string
    {
        return parent::lineSelectSql() . ', d.design_code, d.name AS design_name';
    }

    protected function lineJoinSql(): string
    {
        return parent::lineJoinSql() . ' LEFT JOIN designs d ON d.id = l.design_id';
    }

    protected function searchColumns(): array
    {
        return ['p.name', 'v.vehicle_no', 'v.party_ref'];
    }

    /**
     * GET chalans/party-summary?party_id= — job-work position of a party (meters, fabric items):
     * received (IGP, job work), printed for them (good meters), delivered (chalans),
     * and their fabric still in stock per warehouse.
     */
    public function partySummary(): array
    {
        $party = Request::queryInt('party_id');
        if ($party <= 0) {
            throw HttpException::validation(['party_id' => Lang::t('validation.required')]);
        }
        $fabric = "i.item_type IN ('grey_fabric','finished_fabric')";
        $received = (float) DB::value(
            "SELECT COALESCE(SUM(l.qty), 0) FROM inward_gate_pass_lines l JOIN inward_gate_passes v ON v.id = l.igp_id
             JOIN items i ON i.id = l.item_id
             WHERE v.party_id = :p AND v.ownership = 'job_work' AND v.status = 'posted' AND v.deleted_at IS NULL AND $fabric",
            ['p' => $party]
        );
        $produced = (float) DB::value(
            "SELECT COALESCE(SUM(produced_qty), 0) FROM productions WHERE party_id = :p AND status = 'posted' AND deleted_at IS NULL",
            ['p' => $party]
        );
        $delivered = (float) DB::value(
            "SELECT COALESCE(SUM(l.qty), 0) FROM delivery_chalan_lines l JOIN delivery_chalans v ON v.id = l.chalan_id
             JOIN items i ON i.id = l.item_id
             WHERE v.party_id = :p AND v.status = 'posted' AND v.deleted_at IS NULL AND $fabric",
            ['p' => $party]
        );
        $stock = DB::all(
            "SELECT w.id AS warehouse_id, w.name AS warehouse_name, i.item_type, SUM(sm.qty_in - sm.qty_out) AS qty
             FROM stock_movements sm JOIN items i ON i.id = sm.item_id JOIN warehouses w ON w.id = sm.warehouse_id
             WHERE sm.owner_party_id = :p AND $fabric
             GROUP BY w.id, w.name, i.item_type HAVING ABS(qty) > 0.0005 ORDER BY w.id",
            ['p' => $party]
        );
        return [
            'received'  => round($received, 3),
            'produced'  => round($produced, 3),
            'delivered' => round($delivered, 3),
            'pending'   => round(max(0, $received - $delivered), 3),
            'stock'     => array_map(fn ($r) => ['warehouse_id' => (int) $r['warehouse_id'], 'warehouse_name' => $r['warehouse_name'],
                'item_type' => $r['item_type'], 'qty' => round((float) $r['qty'], 3)], $stock),
        ];
    }

    /**
     * GET chalans/party-lots?party_id=&warehouse_id= — lots in the warehouse that
     * belong to the party (job work) with design and roll count, for "add all".
     */
    public function partyLots(): array
    {
        $party = Request::queryInt('party_id');
        $wh = Request::queryInt('warehouse_id');
        if ($party <= 0 || $wh <= 0) {
            throw HttpException::validation(['party_id' => Lang::t('validation.required')]);
        }
        $rows = DB::all(
            "SELECT sm.item_id, sm.lot_no, SUM(sm.qty_in - sm.qty_out) AS qty, SUM(sm.rolls_in - sm.rolls_out) AS rolls,
                    i.code AS item_code, i.name AS item_name, u.code AS unit_code
             FROM stock_movements sm JOIN items i ON i.id = sm.item_id JOIN units u ON u.id = i.unit_id
             WHERE sm.warehouse_id = :w AND sm.owner_party_id = :p AND i.item_type IN ('finished_fabric','grey_fabric')
             GROUP BY sm.item_id, sm.lot_no, i.code, i.name, u.code HAVING qty > 0.0005 ORDER BY sm.lot_no",
            ['w' => $wh, 'p' => $party]
        );
        foreach ($rows as &$r) {
            $r['item_id'] = (int) $r['item_id'];
            $r['qty'] = round((float) $r['qty'], 3);
            $r['rolls'] = max(0, (int) $r['rolls']);
            $r['design_id'] = $r['lot_no'] !== '' ? DB::value(
                "SELECT design_id FROM productions WHERE finished_item_id = :i AND finished_lot_no = :l AND status = 'posted' AND deleted_at IS NULL
                 ORDER BY id DESC LIMIT 1",
                ['i' => $r['item_id'], 'l' => $r['lot_no']]
            ) : null;
            $r['design_id'] = $r['design_id'] !== null ? (int) $r['design_id'] : null;
        }
        unset($r);
        return $rows;
    }
}
