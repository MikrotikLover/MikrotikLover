<?php
declare(strict_types=1);

/** Inward Gate Pass: material received at the gate → stock IN to (normally) the Grey Store. */
final class InwardGatePassController extends VoucherController
{
    protected string $type = 'IGP';
    protected string $table = 'inward_gate_passes';
    protected string $linesTable = 'inward_gate_pass_lines';
    protected string $fk = 'igp_id';
    protected array $intColumns = ['party_id', 'warehouse_id', 'total_rolls'];

    protected function headerRules(): array
    {
        return [
            'voucher_time'     => self::TIME,
            'party_id'         => 'required|integer|exists:parties,id,soft',
            'warehouse_id'     => 'required|integer|exists:warehouses,id,soft',
            'ownership'        => 'required|in:own,job_work',
            'party_challan_no' => 'nullable|string|max:40',
            'vehicle_no'       => 'nullable|string|max:20',
            'driver_name'      => 'nullable|string|max:80',
            'driver_phone'     => self::PHONE,
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

    protected function buildLines(array $h, array $lines, array $items, callable $err): array
    {
        foreach ($lines as &$l) {
            $item = $items[(int) $l['item_id']];
            $this->requireLot($l, $item, $err);
            $l['unit_id'] = (int) $item['unit_id'];
            $l['rolls'] = (int) ($l['rolls'] ?? 0);
            $l['lot_no'] = trim((string) ($l['lot_no'] ?? ''));
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
        $owner = $h['ownership'] === 'job_work' ? (int) $h['party_id'] : null;
        return array_map(fn ($l) => [
            'item_id'         => $l['item_id'],
            'warehouse_id'    => $h['warehouse_id'],
            'lot_no'          => Stock::ledgerLot($items[(int) $l['item_id']], $l['lot_no']),
            'qty_in'          => $l['qty'],
            'rolls_in'        => $l['rolls'],
            'rate'            => $items[(int) $l['item_id']]['rate'],
            'party_id'        => $h['party_id'],
            'owner_party_id'  => $owner,
            'voucher_line_id' => $l['id'],
        ], $lines);
    }

    protected function selectSql(): string
    {
        return 'v.*, p.code AS party_code, p.name AS party_name, p.name_ur AS party_name_ur, w.name AS warehouse_name, w.name_ur AS warehouse_name_ur';
    }

    protected function joinSql(): string
    {
        return 'JOIN parties p ON p.id = v.party_id JOIN warehouses w ON w.id = v.warehouse_id';
    }

    protected function searchColumns(): array
    {
        return ['p.name', 'v.vehicle_no', 'v.party_challan_no'];
    }
}
