<?php
declare(strict_types=1);

/**
 * Reports. Every report returns the same shape so the SPA can render, print
 * and export any of them generically:
 *
 *   { report, view, filters, columns: [{key, type}], rows: [...], totals: {key: n}, truncated }
 *
 * Column labels are translated on the client (i18n key "rcol.<key>").
 * Types: date, text, int, qty (3 dp), money (2 dp), pct, num.
 * Only posted (not cancelled / deleted) vouchers are counted.
 *
 * Common filters: date_from, date_to (default: this month), party_id, item_id,
 * design_id, warehouse_id, machine_id, ink_colour_id, item_type, view, type.
 */
final class ReportController
{
    private const ROW_LIMIT = 5000;
    private const FABRIC = "('grey_fabric','finished_fabric')";

    /* ============================================================ helpers */

    private function filters(): array
    {
        $from = (string) Request::query('date_from', '');
        $to = (string) Request::query('date_to', '');
        $from = Validator::isDate($from) ? $from : date('Y-m-01');
        $to = Validator::isDate($to) ? $to : date('Y-m-d');
        if ($from > $to) {
            throw HttpException::validation(['date_to' => Lang::t('report.date_order')]);
        }
        $f = ['date_from' => $from, 'date_to' => $to];
        foreach (['party_id', 'item_id', 'design_id', 'warehouse_id', 'machine_id', 'ink_colour_id'] as $k) {
            $f[$k] = Request::queryInt($k) ?: null;
        }
        $f['item_type'] = (string) Request::query('item_type', '');
        $f['view'] = (string) Request::query('view', '');
        $f['type'] = (string) Request::query('type', '');
        $f['lot_no'] = (string) Request::query('lot_no', '');
        return $f;
    }

    /** Adds "AND col = :p" for each set filter. $map: filterKey => SQL column. */
    private function where(array $f, array $map, array &$params): string
    {
        $sql = '';
        foreach ($map as $key => $col) {
            if (!empty($f[$key])) {
                $p = 'f_' . $key;
                $sql .= " AND $col = :$p";
                $params[$p] = $f[$key];
            }
        }
        return $sql;
    }

    /**
     * @param list<array{0:string,1:string}> $columns [key, type]
     * @param list<string> $sum keys summed into totals
     * @param ?callable $finish (totals) => totals, for ratio columns
     */
    private function out(string $report, string $view, array $f, array $columns, array $rows, array $sum = [], ?callable $finish = null): array
    {
        $truncated = count($rows) > self::ROW_LIMIT;
        $rows = array_slice($rows, 0, self::ROW_LIMIT);
        $types = [];
        foreach ($columns as [$k, $type]) {
            $types[$k] = $type;
        }
        foreach ($rows as &$r) {
            foreach ($types as $k => $type) {
                if (!array_key_exists($k, $r)) {
                    $r[$k] = null;
                } elseif ($r[$k] !== null && in_array($type, ['int', 'qty', 'money', 'pct', 'num'], true)) {
                    $r[$k] = $type === 'int' ? (int) $r[$k] : round((float) $r[$k], $type === 'money' ? 2 : 4);
                }
            }
        }
        unset($r);
        $totals = [];
        foreach ($sum as $k) {
            $totals[$k] = round(array_sum(array_map(fn ($r) => (float) ($r[$k] ?? 0), $rows)), 4);
        }
        if ($finish) {
            $totals = $finish($totals);
        }
        return [
            'report'    => $report,
            'view'      => $view,
            'filters'   => $f,
            'columns'   => array_map(fn ($c) => ['key' => $c[0], 'type' => $c[1]], $columns),
            'rows'      => $rows,
            'totals'    => $totals ?: null,
            'truncated' => $truncated,
        ];
    }

    private static function pct(float $part, float $whole): ?float
    {
        return $whole != 0.0 ? round($part / $whole * 100, 2) : null;
    }

    private function view(array $f, array $allowed): string
    {
        if ($f['view'] === '') {
            return $allowed[0];
        }
        if (!in_array($f['view'], $allowed, true)) {
            throw HttpException::validation(['view' => Lang::t('validation.in')]);
        }
        return $f['view'];
    }

    /* ============================================================ inward */

    /** GET reports/inward — Inward Gate Pass lines. */
    public function inward(): array
    {
        $f = $this->filters();
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['party_id' => 'v.party_id', 'item_id' => 'l.item_id', 'warehouse_id' => 'v.warehouse_id'], $p);
        if (in_array($f['type'], ['own', 'job_work'], true)) {
            $w .= ' AND v.ownership = :own';
            $p['own'] = $f['type'];
        }
        $rows = DB::all(
            "SELECT v.voucher_date, v.voucher_no, p.name AS party, v.ownership, v.vehicle_no, w.name AS warehouse,
                    i.name AS item, l.lot_no, l.rolls, l.qty, u.code AS unit
             FROM inward_gate_pass_lines l JOIN inward_gate_passes v ON v.id = l.igp_id
             JOIN parties p ON p.id = v.party_id JOIN warehouses w ON w.id = v.warehouse_id
             JOIN items i ON i.id = l.item_id JOIN units u ON u.id = l.unit_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w
             ORDER BY v.voucher_date, v.id, l.line_no",
            $p
        );
        return $this->out('inward', 'detail', $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['party', 'text'], ['ownership', 'text'],
            ['vehicle_no', 'text'], ['warehouse', 'text'], ['item', 'text'], ['lot_no', 'text'], ['rolls', 'int'], ['qty', 'qty'], ['unit', 'text']],
            $rows, ['rolls', 'qty']);
    }

    /* ============================================================ transfer */

    /** GET reports/transfer — Stock Transfer lines. */
    public function transfer(): array
    {
        $f = $this->filters();
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['item_id' => 'l.item_id'], $p);
        if ($f['warehouse_id']) {
            $w .= ' AND (v.from_warehouse_id = :wh1 OR v.to_warehouse_id = :wh2)';
            $p += ['wh1' => $f['warehouse_id'], 'wh2' => $f['warehouse_id']];
        }
        $rows = DB::all(
            "SELECT v.voucher_date, v.voucher_no, wf.name AS from_warehouse, wt.name AS to_warehouse, i.name AS item,
                    l.lot_no, l.rolls, l.qty, u.code AS unit
             FROM stock_transfer_lines l JOIN stock_transfers v ON v.id = l.transfer_id
             JOIN warehouses wf ON wf.id = v.from_warehouse_id JOIN warehouses wt ON wt.id = v.to_warehouse_id
             JOIN items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w
             ORDER BY v.voucher_date, v.id, l.line_no",
            $p
        );
        return $this->out('transfer', 'detail', $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['from_warehouse', 'text'],
            ['to_warehouse', 'text'], ['item', 'text'], ['lot_no', 'text'], ['rolls', 'int'], ['qty', 'qty'], ['unit', 'text']],
            $rows, ['rolls', 'qty']);
    }

    /* ============================================================ consumption */

    /** GET reports/consumption?view=detail|item|machine|job */
    public function consumption(): array
    {
        $f = $this->filters();
        $view = $this->view($f, ['detail', 'item', 'machine', 'job']);
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['item_id' => 'l.item_id', 'machine_id' => 'v.machine_id', 'design_id' => 'v.design_id',
            'party_id' => 'v.party_id', 'warehouse_id' => 'v.warehouse_id'], $p);
        $from = "FROM stock_consumption_lines l JOIN stock_consumptions v ON v.id = l.consumption_id
                 JOIN items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id JOIN warehouses w ON w.id = v.warehouse_id
                 LEFT JOIN machines m ON m.id = v.machine_id LEFT JOIN designs d ON d.id = v.design_id LEFT JOIN parties p ON p.id = v.party_id
                 WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w";
        return match ($view) {
            'item' => $this->out('consumption', $view, $f, [['item', 'text'], ['unit', 'text'], ['qty', 'qty'], ['amount', 'money'], ['vouchers', 'int']],
                DB::all("SELECT i.name AS item, u.code AS unit, SUM(l.qty) AS qty, SUM(l.amount) AS amount, COUNT(DISTINCT v.id) AS vouchers
                         $from GROUP BY i.id, i.name, u.code ORDER BY amount DESC", $p), ['amount']),
            'machine' => $this->out('consumption', $view, $f, [['machine', 'text'], ['amount', 'money'], ['vouchers', 'int']],
                DB::all("SELECT COALESCE(m.name, '—') AS machine, SUM(l.amount) AS amount, COUNT(DISTINCT v.id) AS vouchers
                         $from GROUP BY m.id, m.name ORDER BY amount DESC", $p), ['amount', 'vouchers']),
            'job' => $this->out('consumption', $view, $f, [['design', 'text'], ['party', 'text'], ['amount', 'money'], ['vouchers', 'int']],
                DB::all("SELECT COALESCE(d.design_code, '—') AS design, COALESCE(p.name, '—') AS party, SUM(l.amount) AS amount, COUNT(DISTINCT v.id) AS vouchers
                         $from GROUP BY d.id, d.design_code, p.id, p.name ORDER BY amount DESC", $p), ['amount', 'vouchers']),
            default => $this->out('consumption', $view, $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['warehouse', 'text'], ['machine', 'text'],
                ['design', 'text'], ['party', 'text'], ['purpose', 'text'], ['item', 'text'], ['lot_no', 'text'], ['qty', 'qty'], ['unit', 'text'],
                ['rate', 'money'], ['amount', 'money']],
                DB::all("SELECT v.voucher_date, v.voucher_no, w.name AS warehouse, m.name AS machine, d.design_code AS design, p.name AS party,
                                v.purpose, i.name AS item, l.lot_no, l.qty, u.code AS unit, l.rate, l.amount
                         $from ORDER BY v.voucher_date, v.id, l.line_no", $p), ['amount']),
        };
    }

    /* ============================================================ production */

    /** GET reports/production?type=all|bom|manual&view=vouchers|materials|machine */
    public function production(): array
    {
        $f = $this->filters();
        $view = $this->view($f, ['vouchers', 'materials', 'machine']);
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['party_id' => 'v.party_id', 'design_id' => 'v.design_id', 'machine_id' => 'v.machine_id'], $p);
        if (in_array($f['type'], ['bom', 'manual'], true)) {
            $w .= ' AND v.production_type = :pt';
            $p['pt'] = $f['type'];
        }
        $base = "FROM productions v JOIN machines m ON m.id = v.machine_id LEFT JOIN designs d ON d.id = v.design_id
                 LEFT JOIN parties p ON p.id = v.party_id
                 WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w";
        $printed = '(v.produced_qty + v.wastage_qty + v.rejected_qty)';

        if ($view === 'materials') {
            if ($f['item_id']) {
                $w2 = ' AND l.item_id = :it';
                $p['it'] = $f['item_id'];
            }
            $rows = DB::all(
                "SELECT i.name AS item, l.line_type, u.code AS unit, SUM(l.est_qty) AS est_qty, SUM(l.actual_qty) AS actual_qty,
                        SUM(l.actual_qty) - SUM(l.est_qty) AS variance_qty, SUM(l.amount) AS amount
                 FROM production_lines l JOIN productions v ON v.id = l.production_id JOIN items i ON i.id = l.item_id
                 JOIN units u ON u.id = i.unit_id
                 WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w " . ($w2 ?? '') . "
                 GROUP BY i.id, i.name, l.line_type, u.code ORDER BY l.line_type, i.name",
                $p
            );
            foreach ($rows as &$r) {
                $r['variance_pct'] = self::pct((float) $r['variance_qty'], (float) $r['est_qty']);
            }
            unset($r);
            return $this->out('production', $view, $f, [['item', 'text'], ['line_type', 'text'], ['unit', 'text'], ['est_qty', 'qty'],
                ['actual_qty', 'qty'], ['variance_qty', 'qty'], ['variance_pct', 'pct'], ['amount', 'money']], $rows, ['amount']);
        }

        if ($view === 'machine') {
            $rows = DB::all(
                "SELECT m.name AS machine, COUNT(*) AS vouchers, SUM($printed) AS printed_qty, SUM(v.produced_qty) AS produced_qty,
                        SUM(v.wastage_qty + v.rejected_qty) AS waste_qty, SUM(v.machine_hours) AS machine_hours, SUM(v.total_cost) AS total_cost
                 $base GROUP BY m.id, m.name ORDER BY produced_qty DESC",
                $p
            );
            foreach ($rows as &$r) {
                $r['wastage_pct'] = self::pct((float) $r['waste_qty'], (float) $r['printed_qty']);
                $r['meters_per_hour'] = (float) $r['machine_hours'] > 0 ? round((float) $r['printed_qty'] / (float) $r['machine_hours'], 2) : null;
                $r['cost_per_meter'] = (float) $r['produced_qty'] > 0 ? round((float) $r['total_cost'] / (float) $r['produced_qty'], 4) : null;
            }
            unset($r);
            return $this->out('production', $view, $f, [['machine', 'text'], ['vouchers', 'int'], ['printed_qty', 'qty'], ['produced_qty', 'qty'],
                ['waste_qty', 'qty'], ['wastage_pct', 'pct'], ['machine_hours', 'num'], ['meters_per_hour', 'num'], ['total_cost', 'money'],
                ['cost_per_meter', 'money']], $rows, ['vouchers', 'printed_qty', 'produced_qty', 'waste_qty', 'machine_hours', 'total_cost'],
                fn ($t) => $t + ['wastage_pct' => self::pct($t['waste_qty'], $t['printed_qty']),
                    'cost_per_meter' => $t['produced_qty'] > 0 ? round($t['total_cost'] / $t['produced_qty'], 4) : null]);
        }

        $rows = DB::all(
            "SELECT v.voucher_date, v.voucher_no, v.production_type, d.design_code AS design, p.name AS party, m.name AS machine,
                    $printed AS printed_qty, v.produced_qty, v.wastage_qty, v.rejected_qty,
                    v.ink_ml_estimated, v.ink_ml_actual, v.material_cost, v.ink_cost, v.machine_cost, v.total_cost, v.cost_per_meter
             $base ORDER BY v.voucher_date, v.id",
            $p
        );
        foreach ($rows as &$r) {
            $r['wastage_pct'] = self::pct((float) $r['wastage_qty'] + (float) $r['rejected_qty'], (float) $r['printed_qty']);
            $r['ink_variance_pct'] = self::pct((float) $r['ink_ml_actual'] - (float) $r['ink_ml_estimated'], (float) $r['ink_ml_estimated']);
        }
        unset($r);
        return $this->out('production', 'vouchers', $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['production_type', 'text'],
            ['design', 'text'], ['party', 'text'], ['machine', 'text'], ['printed_qty', 'qty'], ['produced_qty', 'qty'], ['wastage_qty', 'qty'],
            ['rejected_qty', 'qty'], ['wastage_pct', 'pct'], ['ink_ml_estimated', 'num'], ['ink_ml_actual', 'num'], ['ink_variance_pct', 'pct'],
            ['material_cost', 'money'], ['ink_cost', 'money'], ['machine_cost', 'money'], ['total_cost', 'money'], ['cost_per_meter', 'money']],
            $rows, ['printed_qty', 'produced_qty', 'wastage_qty', 'rejected_qty', 'ink_ml_estimated', 'ink_ml_actual', 'material_cost', 'ink_cost',
                'machine_cost', 'total_cost'],
            fn ($t) => $t + [
                'wastage_pct' => self::pct($t['wastage_qty'] + $t['rejected_qty'], $t['printed_qty']),
                'ink_variance_pct' => self::pct($t['ink_ml_actual'] - $t['ink_ml_estimated'], $t['ink_ml_estimated']),
                'cost_per_meter' => $t['produced_qty'] > 0 ? round($t['total_cost'] / $t['produced_qty'], 4) : null,
            ]);
    }

    /* ============================================================ delivery */

    /** GET reports/delivery?view=vouchers|party — chalans, or party-wise pending vs delivered meters. */
    public function delivery(): array
    {
        $f = $this->filters();
        $view = $this->view($f, ['vouchers', 'party']);
        if ($view === 'party') {
            $p = ['df' => $f['date_from'], 'dt' => $f['date_to'], 'dt2' => $f['date_to'], 'dt3' => $f['date_to'], 'dt4' => $f['date_to']];
            $w = $this->where($f, ['party_id' => 'pa.id'], $p);
            $rows = DB::all(
                "SELECT pa.name AS party,
                        (SELECT COALESCE(SUM(l.qty),0) FROM delivery_chalan_lines l JOIN delivery_chalans v ON v.id = l.chalan_id JOIN items i ON i.id = l.item_id
                          WHERE v.party_id = pa.id AND v.status = 'posted' AND v.deleted_at IS NULL AND i.item_type IN " . self::FABRIC . "
                            AND v.voucher_date BETWEEN :df AND :dt) AS delivered_period,
                        (SELECT COALESCE(SUM(sm.qty_in),0) FROM stock_movements sm WHERE sm.owner_party_id = pa.id AND sm.voucher_type = 'IGP' AND sm.movement_date <= :dt2) AS received_total,
                        (SELECT COALESCE(SUM(sm.qty_out),0) FROM stock_movements sm WHERE sm.owner_party_id = pa.id AND sm.voucher_type = 'DCV' AND sm.movement_date <= :dt3) AS delivered_total,
                        (SELECT COALESCE(SUM(sm.qty_in - sm.qty_out),0) FROM stock_movements sm JOIN items i ON i.id = sm.item_id
                          WHERE sm.owner_party_id = pa.id AND i.item_type = 'finished_fabric' AND sm.movement_date <= :dt4) AS ready_qty
                 FROM parties pa WHERE pa.deleted_at IS NULL AND (pa.is_customer = 1 OR pa.is_fabric_owner = 1) $w
                 ORDER BY pa.name",
                $p
            );
            $rows = array_values(array_filter(array_map(function ($r) {
                $r['pending_qty'] = round((float) $r['received_total'] - (float) $r['delivered_total'], 3);
                return $r;
            }, $rows), fn ($r) => (float) $r['delivered_period'] || (float) $r['received_total'] || (float) $r['ready_qty']));
            return $this->out('delivery', $view, $f, [['party', 'text'], ['delivered_period', 'qty'], ['received_total', 'qty'],
                ['delivered_total', 'qty'], ['pending_qty', 'qty'], ['ready_qty', 'qty']], $rows,
                ['delivered_period', 'received_total', 'delivered_total', 'pending_qty', 'ready_qty']);
        }
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['party_id' => 'v.party_id', 'item_id' => 'l.item_id', 'design_id' => 'l.design_id', 'warehouse_id' => 'v.warehouse_id'], $p);
        $rows = DB::all(
            "SELECT v.voucher_date, v.voucher_no, p.name AS party, v.vehicle_no, i.name AS item, d.design_code AS design, l.lot_no, l.rolls, l.qty, u.code AS unit
             FROM delivery_chalan_lines l JOIN delivery_chalans v ON v.id = l.chalan_id JOIN parties p ON p.id = v.party_id
             JOIN items i ON i.id = l.item_id JOIN units u ON u.id = l.unit_id LEFT JOIN designs d ON d.id = l.design_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w
             ORDER BY v.voucher_date, v.id, l.line_no",
            $p
        );
        return $this->out('delivery', 'vouchers', $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['party', 'text'], ['vehicle_no', 'text'],
            ['item', 'text'], ['design', 'text'], ['lot_no', 'text'], ['rolls', 'int'], ['qty', 'qty'], ['unit', 'text']], $rows, ['rolls', 'qty']);
    }

    /* ============================================================ job work */

    /**
     * GET reports/jobwork — fabric of each job-work party, from the stock ledger (owner):
     * opening + received − delivered − printing loss (wastage + rejection) = closing;
     * compared with the party's fabric actually in stock (difference should be 0).
     */
    public function jobwork(): array
    {
        $f = $this->filters();
        $p = [];
        $w = $this->where($f, ['party_id' => 'pa.id'], $p);
        $parties = DB::all("SELECT pa.id, pa.name FROM parties pa WHERE pa.deleted_at IS NULL AND pa.is_fabric_owner = 1 $w ORDER BY pa.name", $p);
        $fab = self::FABRIC;
        // Per party and period part: received (IGP in), delivered (DCV out), production out/in.
        // $from === null → everything before $to (the opening balance); else $from..$to inclusive.
        $sum = function (int $party, ?string $from, string $to): array {
            $range = $from !== null ? 'sm.movement_date BETWEEN :df AND :dt' : 'sm.movement_date < :dt';
            $p = ['p' => $party, 'dt' => $to] + ($from !== null ? ['df' => $from] : []);
            return DB::one(
                "SELECT COALESCE(SUM(CASE WHEN sm.voucher_type = 'IGP' THEN sm.qty_in ELSE 0 END),0) AS received,
                        COALESCE(SUM(CASE WHEN sm.voucher_type = 'DCV' THEN sm.qty_out ELSE 0 END),0) AS delivered,
                        COALESCE(SUM(CASE WHEN sm.voucher_type IN ('BOM','MPV') THEN sm.qty_out - sm.qty_in ELSE 0 END),0) AS loss
                 FROM stock_movements sm JOIN items i ON i.id = sm.item_id
                 WHERE sm.owner_party_id = :p AND i.item_type IN " . self::FABRIC . " AND $range",
                $p
            );
        };
        $rows = [];
        foreach ($parties as $pa) {
            $pid = (int) $pa['id'];
            $open = $sum($pid, null, $f['date_from']);
            $per = $sum($pid, $f['date_from'], $f['date_to']);
            $stock = DB::one(
                "SELECT COALESCE(SUM(CASE WHEN i.item_type = 'grey_fabric' THEN sm.qty_in - sm.qty_out ELSE 0 END),0) AS grey,
                        COALESCE(SUM(CASE WHEN i.item_type = 'finished_fabric' THEN sm.qty_in - sm.qty_out ELSE 0 END),0) AS finished
                 FROM stock_movements sm JOIN items i ON i.id = sm.item_id
                 WHERE sm.owner_party_id = :p AND i.item_type IN $fab AND sm.movement_date <= :dt",
                ['p' => $pid, 'dt' => $f['date_to']]
            );
            $opening = (float) $open['received'] - (float) $open['delivered'] - (float) $open['loss'];
            $closing = $opening + (float) $per['received'] - (float) $per['delivered'] - (float) $per['loss'];
            if (!$opening && !(float) $per['received'] && !(float) $per['delivered'] && !(float) $per['loss'] && !$closing) {
                continue;
            }
            $inStock = (float) $stock['grey'] + (float) $stock['finished'];
            $rows[] = [
                'party' => $pa['name'], 'opening_qty' => $opening, 'received_qty' => $per['received'], 'delivered_qty' => $per['delivered'],
                'loss_qty' => $per['loss'], 'closing_qty' => $closing, 'grey_stock' => $stock['grey'], 'finished_stock' => $stock['finished'],
                'difference_qty' => round($closing - $inStock, 3),
            ];
        }
        return $this->out('jobwork', 'party', $f, [['party', 'text'], ['opening_qty', 'qty'], ['received_qty', 'qty'], ['delivered_qty', 'qty'],
            ['loss_qty', 'qty'], ['closing_qty', 'qty'], ['grey_stock', 'qty'], ['finished_stock', 'qty'], ['difference_qty', 'qty']], $rows,
            ['opening_qty', 'received_qty', 'delivered_qty', 'loss_qty', 'closing_qty', 'grey_stock', 'finished_stock', 'difference_qty']);
    }

    /* ============================================================ ink */

    /** GET reports/ink?view=colour|machine|design|cost|ledger|reorder */
    public function ink(): array
    {
        $f = $this->filters();
        $view = $this->view($f, ['colour', 'machine', 'design', 'cost', 'ledger', 'reorder']);
        return match ($view) {
            'machine' => $this->inkByMachine($f),
            'design'  => $this->inkByDesign($f),
            'cost'    => $this->inkCostPerMeter($f),
            'ledger'  => $this->stockLedger($f, 'ink', 'ledger'),
            'reorder' => $this->reorder($f),
            default   => $this->inkByColour($f),
        };
    }

    /** Loaded ml (ink loading) vs estimated / recorded ml in production, per colour. */
    private function inkByColour(array $f): array
    {
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['machine_id' => 'v.machine_id', 'ink_colour_id' => 'l.ink_colour_id'], $p);
        $loaded = DB::all(
            "SELECT l.ink_colour_id, SUM(l.ml_filled) AS loaded_ml, SUM(l.amount) AS loaded_cost
             FROM ink_load_lines l JOIN ink_loads v ON v.id = l.ink_load_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w GROUP BY l.ink_colour_id",
            $p
        );
        $p2 = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w2 = $this->where($f, ['machine_id' => 'v.machine_id', 'ink_colour_id' => 'l.ink_colour_id', 'design_id' => 'v.design_id'], $p2);
        $used = DB::all(
            "SELECT l.ink_colour_id, SUM(l.est_qty * u.to_base * 1000) AS est_ml, SUM(l.actual_qty * u.to_base * 1000) AS actual_ml
             FROM production_lines l JOIN productions v ON v.id = l.production_id JOIN items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id
             WHERE l.line_type = 'ink' AND v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w2
             GROUP BY l.ink_colour_id",
            $p2
        );
        $by = [];
        foreach ($loaded as $r) {
            $by[(int) $r['ink_colour_id']] = ['loaded_ml' => $r['loaded_ml'], 'loaded_cost' => $r['loaded_cost']];
        }
        foreach ($used as $r) {
            $by[(int) $r['ink_colour_id']] = ($by[(int) $r['ink_colour_id']] ?? []) + ['est_ml' => $r['est_ml'], 'actual_ml' => $r['actual_ml']];
        }
        $colours = DB::all('SELECT id, code, name FROM ink_colours ORDER BY sort_order, code');
        $rows = [];
        foreach ($colours as $c) {
            if (!isset($by[(int) $c['id']])) {
                continue;
            }
            $r = $by[(int) $c['id']] + ['loaded_ml' => 0, 'loaded_cost' => 0, 'est_ml' => 0, 'actual_ml' => 0];
            $rows[] = ['colour' => "{$c['code']} · {$c['name']}"] + $r
                + ['load_variance_pct' => self::pct((float) $r['loaded_ml'] - (float) $r['est_ml'], (float) $r['est_ml'])];
        }
        return $this->out('ink', 'colour', $f, [['colour', 'text'], ['loaded_ml', 'num'], ['loaded_cost', 'money'], ['est_ml', 'num'],
            ['actual_ml', 'num'], ['load_variance_pct', 'pct']], $rows, ['loaded_ml', 'loaded_cost', 'est_ml', 'actual_ml'],
            fn ($t) => $t + ['load_variance_pct' => self::pct($t['loaded_ml'] - $t['est_ml'], $t['est_ml'])]);
    }

    /** Per machine: ink loaded vs meters printed and estimated ink. */
    private function inkByMachine(array $f): array
    {
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to'], 'df2' => $f['date_from'], 'dt2' => $f['date_to']];
        $w = $this->where($f, ['machine_id' => 'm.id'], $p);
        $rows = DB::all(
            "SELECT m.name AS machine,
                    (SELECT COALESCE(SUM(v.total_ml),0) FROM ink_loads v WHERE v.machine_id = m.id AND v.status = 'posted' AND v.deleted_at IS NULL
                       AND v.voucher_date BETWEEN :df AND :dt) AS loaded_ml,
                    (SELECT COALESCE(SUM(v.total_amount),0) FROM ink_loads v WHERE v.machine_id = m.id AND v.status = 'posted' AND v.deleted_at IS NULL
                       AND v.voucher_date BETWEEN :df3 AND :dt3) AS loaded_cost,
                    pr.printed_qty, pr.est_ml
             FROM machines m
             LEFT JOIN (SELECT machine_id, SUM(produced_qty + wastage_qty + rejected_qty) AS printed_qty, SUM(ink_ml_estimated) AS est_ml
                        FROM productions WHERE status = 'posted' AND deleted_at IS NULL AND voucher_date BETWEEN :df2 AND :dt2 GROUP BY machine_id) pr
               ON pr.machine_id = m.id
             WHERE m.deleted_at IS NULL $w ORDER BY m.name",
            $p + ['df3' => $f['date_from'], 'dt3' => $f['date_to']]
        );
        $rows = array_values(array_filter($rows, fn ($r) => (float) $r['loaded_ml'] || (float) $r['printed_qty']));
        foreach ($rows as &$r) {
            $r['ml_per_meter'] = (float) $r['printed_qty'] > 0 ? round((float) $r['loaded_ml'] / (float) $r['printed_qty'], 3) : null;
            $r['est_ml_per_meter'] = (float) $r['printed_qty'] > 0 ? round((float) $r['est_ml'] / (float) $r['printed_qty'], 3) : null;
            $r['load_variance_pct'] = self::pct((float) $r['loaded_ml'] - (float) $r['est_ml'], (float) $r['est_ml']);
        }
        unset($r);
        return $this->out('ink', 'machine', $f, [['machine', 'text'], ['loaded_ml', 'num'], ['loaded_cost', 'money'], ['printed_qty', 'qty'],
            ['est_ml', 'num'], ['ml_per_meter', 'num'], ['est_ml_per_meter', 'num'], ['load_variance_pct', 'pct']], $rows,
            ['loaded_ml', 'loaded_cost', 'printed_qty', 'est_ml'],
            fn ($t) => $t + ['load_variance_pct' => self::pct($t['loaded_ml'] - $t['est_ml'], $t['est_ml']),
                'ml_per_meter' => $t['printed_qty'] > 0 ? round($t['loaded_ml'] / $t['printed_qty'], 3) : null]);
    }

    /** Per design: production meters, ink est / recorded ml, ink cost per meter vs the design standard. */
    private function inkByDesign(array $f): array
    {
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['design_id' => 'v.design_id', 'machine_id' => 'v.machine_id', 'party_id' => 'v.party_id'], $p);
        $rows = DB::all(
            "SELECT d.id AS design_id, d.design_code AS design, d.name AS design_name, SUM(v.produced_qty) AS produced_qty,
                    SUM(v.ink_ml_estimated) AS est_ml, SUM(v.ink_ml_actual) AS actual_ml, SUM(v.ink_cost) AS ink_cost
             FROM productions v JOIN designs d ON d.id = v.design_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w
             GROUP BY d.id, d.design_code, d.name ORDER BY produced_qty DESC",
            $p
        );
        foreach ($rows as &$r) {
            $r['ink_cost_per_meter'] = (float) $r['produced_qty'] > 0 ? round((float) $r['ink_cost'] / (float) $r['produced_qty'], 4) : null;
            $r['standard_cost_per_meter'] = InkService::designInkCost((int) $r['design_id'])['cost_per_meter'];
            $r['variance_pct'] = self::pct((float) $r['actual_ml'] - (float) $r['est_ml'], (float) $r['est_ml']);
            unset($r['design_id']);
        }
        unset($r);
        return $this->out('ink', 'design', $f, [['design', 'text'], ['design_name', 'text'], ['produced_qty', 'qty'], ['est_ml', 'num'],
            ['actual_ml', 'num'], ['variance_pct', 'pct'], ['ink_cost', 'money'], ['ink_cost_per_meter', 'money'], ['standard_cost_per_meter', 'money']],
            $rows, ['produced_qty', 'est_ml', 'actual_ml', 'ink_cost'],
            fn ($t) => $t + ['ink_cost_per_meter' => $t['produced_qty'] > 0 ? round($t['ink_cost'] / $t['produced_qty'], 4) : null,
                'variance_pct' => self::pct($t['actual_ml'] - $t['est_ml'], $t['est_ml'])]);
    }

    /** Ink cost per meter for each production in the period. */
    private function inkCostPerMeter(array $f): array
    {
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['design_id' => 'v.design_id', 'machine_id' => 'v.machine_id', 'party_id' => 'v.party_id'], $p);
        $rows = DB::all(
            "SELECT v.voucher_date, v.voucher_no, d.design_code AS design, m.name AS machine, v.produced_qty, v.ink_ml_actual AS actual_ml, v.ink_cost,
                    CASE WHEN v.produced_qty > 0 THEN v.ink_cost / v.produced_qty END AS ink_cost_per_meter
             FROM productions v JOIN machines m ON m.id = v.machine_id LEFT JOIN designs d ON d.id = v.design_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND v.voucher_date BETWEEN :df AND :dt $w ORDER BY v.voucher_date, v.id",
            $p
        );
        return $this->out('ink', 'cost', $f, [['voucher_date', 'date'], ['voucher_no', 'text'], ['design', 'text'], ['machine', 'text'],
            ['produced_qty', 'qty'], ['actual_ml', 'num'], ['ink_cost', 'money'], ['ink_cost_per_meter', 'money']], $rows,
            ['produced_qty', 'actual_ml', 'ink_cost'],
            fn ($t) => $t + ['ink_cost_per_meter' => $t['produced_qty'] > 0 ? round($t['ink_cost'] / $t['produced_qty'], 4) : null]);
    }

    /** Items at or below their reorder level (all warehouses). item_type filter; ink by default from the ink report. */
    private function reorder(array $f): array
    {
        $p = [];
        $types = $f['item_type'] === 'all' ? null : ($f['item_type'] !== '' ? [$f['item_type']] : ['ink']);
        $w = $types ? ' AND i.item_type IN ' . DB::in($types, $p, 'ty') : '';
        $w .= $this->where($f, ['ink_colour_id' => 'i.ink_colour_id', 'item_id' => 'i.id'], $p);
        $rows = DB::all(
            "SELECT i.code AS item_code, i.name AS item, i.item_type, c.code AS colour, u.code AS unit, i.reorder_level,
                    COALESCE((SELECT SUM(sm.qty_in - sm.qty_out) FROM stock_movements sm WHERE sm.item_id = i.id), 0) AS stock_qty
             FROM items i JOIN units u ON u.id = i.unit_id LEFT JOIN ink_colours c ON c.id = i.ink_colour_id
             WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.reorder_level > 0 $w
             HAVING stock_qty <= i.reorder_level ORDER BY (stock_qty / i.reorder_level), i.name",
            $p
        );
        foreach ($rows as &$r) {
            $r['shortfall_qty'] = round((float) $r['reorder_level'] - (float) $r['stock_qty'], 3);
        }
        unset($r);
        return $this->out('ink', 'reorder', $f, [['item_code', 'text'], ['item', 'text'], ['item_type', 'text'], ['colour', 'text'],
            ['stock_qty', 'qty'], ['reorder_level', 'qty'], ['shortfall_qty', 'qty'], ['unit', 'text']], $rows);
    }

    /* ============================================================ stock */

    /** GET reports/stock?view=current|ledger|reorder */
    public function stock(): array
    {
        $f = $this->filters();
        $view = $this->view($f, ['current', 'ledger', 'reorder']);
        if ($view === 'ledger') {
            return $this->stockLedger($f, null, 'ledger');
        }
        if ($view === 'reorder') {
            $f['item_type'] = $f['item_type'] ?: 'all';
            $r = $this->reorder($f);
            $r['report'] = 'stock';
            return $r;
        }
        $p = ['dt' => $f['date_to']];
        $w = $this->where($f, ['item_id' => 'sm.item_id', 'warehouse_id' => 'sm.warehouse_id', 'party_id' => 'sm.owner_party_id'], $p);
        if ($f['item_type'] !== '' && $f['item_type'] !== 'all') {
            $w .= ' AND i.item_type = :ity';
            $p['ity'] = $f['item_type'];
        }
        if ($f['lot_no'] !== '') {
            $w .= ' AND sm.lot_no = :lot';
            $p['lot'] = $f['lot_no'];
        }
        $rows = DB::all(
            "SELECT i.code AS item_code, i.name AS item, i.item_type, w.name AS warehouse, sm.lot_no, pa.name AS owner,
                    SUM(sm.rolls_in - sm.rolls_out) AS rolls, SUM(sm.qty_in - sm.qty_out) AS qty, u.code AS unit, i.rate,
                    SUM(sm.qty_in - sm.qty_out) * i.rate AS value
             FROM stock_movements sm JOIN items i ON i.id = sm.item_id JOIN units u ON u.id = i.unit_id
             JOIN warehouses w ON w.id = sm.warehouse_id LEFT JOIN parties pa ON pa.id = sm.owner_party_id
             WHERE sm.movement_date <= :dt $w
             GROUP BY i.id, i.code, i.name, i.item_type, w.id, w.name, sm.lot_no, pa.name, u.code, i.rate
             HAVING ABS(qty) > 0.0005 ORDER BY i.item_type, i.name, w.name, sm.lot_no",
            $p
        );
        return $this->out('stock', 'current', $f, [['item_code', 'text'], ['item', 'text'], ['item_type', 'text'], ['warehouse', 'text'],
            ['lot_no', 'text'], ['owner', 'text'], ['rolls', 'int'], ['qty', 'qty'], ['unit', 'text'], ['rate', 'money'], ['value', 'money']],
            $rows, ['value']);
    }

    /**
     * Stock ledger: opening balance, every movement with running balance, per item
     * (and warehouse / lot when filtered). $itemType limits to e.g. ink items.
     */
    private function stockLedger(array $f, ?string $itemType, string $view): array
    {
        $p = ['df' => $f['date_from'], 'dt' => $f['date_to']];
        $w = $this->where($f, ['item_id' => 'sm.item_id', 'warehouse_id' => 'sm.warehouse_id', 'ink_colour_id' => 'i.ink_colour_id'], $p);
        if ($itemType !== null) {
            $w .= ' AND i.item_type = :ity';
            $p['ity'] = $itemType;
        } elseif (!$f['item_id']) {
            throw HttpException::validation(['item_id' => Lang::t('report.item_required')]);
        }
        if ($f['lot_no'] !== '') {
            $w .= ' AND sm.lot_no = :lot';
            $p['lot'] = $f['lot_no'];
        }
        $openParams = $p;
        unset($openParams['dt']);
        $openings = [];
        foreach (DB::all(
            "SELECT sm.item_id, SUM(sm.qty_in - sm.qty_out) AS qty FROM stock_movements sm JOIN items i ON i.id = sm.item_id
             WHERE sm.movement_date < :df $w GROUP BY sm.item_id",
            $openParams
        ) as $o) {
            $openings[(int) $o['item_id']] = (float) $o['qty'];
        }
        $moves = DB::all(
            "SELECT sm.item_id, i.name AS item, u.code AS unit, sm.movement_date, sm.voucher_type, sm.voucher_no, w.name AS warehouse,
                    sm.lot_no, COALESCE(pa.name, m.name) AS reference, sm.qty_in, sm.qty_out
             FROM stock_movements sm JOIN items i ON i.id = sm.item_id JOIN units u ON u.id = i.unit_id JOIN warehouses w ON w.id = sm.warehouse_id
             LEFT JOIN parties pa ON pa.id = sm.party_id LEFT JOIN machines m ON m.id = sm.machine_id
             WHERE sm.movement_date BETWEEN :df AND :dt $w ORDER BY i.name, sm.item_id, sm.movement_date, sm.id",
            $p
        );
        // Items with an opening balance but no movement in the period still get their opening row.
        $names = [];
        foreach ($moves as $m) {
            $names[(int) $m['item_id']] = [$m['item'], $m['unit']];
        }
        foreach (array_keys($openings) as $iid) {
            if (!isset($names[$iid])) {
                $it = DB::one('SELECT i.name, u.code FROM items i JOIN units u ON u.id = i.unit_id WHERE i.id = :id', ['id' => $iid]);
                $names[$iid] = [$it['name'], $it['code']];
            }
        }
        $rows = [];
        $current = null;
        $bal = 0.0;
        $byItem = [];
        foreach ($moves as $m) {
            $byItem[(int) $m['item_id']][] = $m;
        }
        foreach ($names as $iid => [$name, $unit]) {
            $bal = $openings[$iid] ?? 0.0;
            $rows[] = ['movement_date' => $f['date_from'], 'item' => $name, 'voucher_type' => 'OPENING', 'voucher_no' => '', 'warehouse' => '',
                'lot_no' => '', 'reference' => '', 'qty_in' => null, 'qty_out' => null, 'balance' => $bal, 'unit' => $unit];
            foreach ($byItem[$iid] ?? [] as $m) {
                $bal += (float) $m['qty_in'] - (float) $m['qty_out'];
                $rows[] = ['movement_date' => $m['movement_date'], 'item' => $name, 'voucher_type' => $m['voucher_type'], 'voucher_no' => $m['voucher_no'],
                    'warehouse' => $m['warehouse'], 'lot_no' => $m['lot_no'], 'reference' => $m['reference'],
                    'qty_in' => $m['qty_in'], 'qty_out' => $m['qty_out'], 'balance' => round($bal, 3), 'unit' => $unit];
            }
        }
        unset($current);
        return $this->out($itemType === 'ink' ? 'ink' : 'stock', $view, $f, [['movement_date', 'date'], ['item', 'text'], ['voucher_type', 'text'],
            ['voucher_no', 'text'], ['warehouse', 'text'], ['lot_no', 'text'], ['reference', 'text'], ['qty_in', 'qty'], ['qty_out', 'qty'],
            ['balance', 'qty'], ['unit', 'text']], $rows, ['qty_in', 'qty_out']);
    }

    /* ============================================================ dashboard */

    /** GET dashboard — today's activity, production by machine, low stock, pending deliveries, top customers. */
    public function dashboard(): array
    {
        $today = date('Y-m-d');
        $week = date('Y-m-d', strtotime('-6 days'));
        $month = date('Y-m-d', strtotime('-29 days'));
        $fab = self::FABRIC;
        $todayQty = fn (string $sql) => round((float) DB::value($sql, ['d' => $today]), 3);

        $byMachine = DB::all(
            "SELECT m.name AS machine,
                    COALESCE(SUM(CASE WHEN v.voucher_date = :d1 THEN v.produced_qty END), 0) AS today_qty,
                    COALESCE(SUM(v.produced_qty), 0) AS week_qty
             FROM machines m LEFT JOIN productions v ON v.machine_id = m.id AND v.status = 'posted' AND v.deleted_at IS NULL
               AND v.voucher_date BETWEEN :w AND :d2
             WHERE m.deleted_at IS NULL AND m.is_active = 1 GROUP BY m.id, m.name ORDER BY week_qty DESC, m.name",
            ['d1' => $today, 'w' => $week, 'd2' => $today]
        );
        $lowStock = DB::all(
            "SELECT i.name AS item, i.item_type, c.hex AS colour_hex, u.code AS unit, i.reorder_level,
                    COALESCE((SELECT SUM(sm.qty_in - sm.qty_out) FROM stock_movements sm WHERE sm.item_id = i.id), 0) AS stock_qty
             FROM items i JOIN units u ON u.id = i.unit_id LEFT JOIN ink_colours c ON c.id = i.ink_colour_id
             WHERE i.deleted_at IS NULL AND i.is_active = 1 AND i.reorder_level > 0 AND i.item_type IN ('ink','paper')
             HAVING stock_qty <= i.reorder_level ORDER BY (stock_qty / i.reorder_level), i.name LIMIT 12"
        );
        $pending = DB::all(
            "SELECT pa.name AS party,
                    -- Same meaning as the Delivery Chalan screen / delivery report: received − delivered.
                    COALESCE(SUM(CASE WHEN sm.voucher_type = 'IGP' THEN sm.qty_in WHEN sm.voucher_type = 'DCV' THEN -sm.qty_out ELSE 0 END), 0) AS pending_qty,
                    COALESCE(SUM(CASE WHEN i.item_type = 'finished_fabric' THEN sm.qty_in - sm.qty_out ELSE 0 END), 0) AS ready_qty
             FROM stock_movements sm JOIN items i ON i.id = sm.item_id JOIN parties pa ON pa.id = sm.owner_party_id
             WHERE i.item_type IN $fab GROUP BY pa.id, pa.name HAVING pending_qty > 0.0005 ORDER BY ready_qty DESC, pending_qty DESC LIMIT 8"
        );
        $top = DB::all(
            "SELECT p.name AS party, SUM(l.qty) AS delivered_qty, COUNT(DISTINCT v.id) AS chalans
             FROM delivery_chalan_lines l JOIN delivery_chalans v ON v.id = l.chalan_id JOIN parties p ON p.id = v.party_id JOIN items i ON i.id = l.item_id
             WHERE v.status = 'posted' AND v.deleted_at IS NULL AND i.item_type IN $fab AND v.voucher_date BETWEEN :m AND :d
             GROUP BY p.id, p.name ORDER BY delivered_qty DESC LIMIT 5",
            ['m' => $month, 'd' => $today]
        );
        $num = fn (array $rows, array $keys) => array_map(function ($r) use ($keys) {
            foreach ($keys as $k) {
                $r[$k] = round((float) $r[$k], 3);
            }
            return $r;
        }, $rows);

        return [
            'date'  => $today,
            'today' => [
                'inward_qty'   => $todayQty("SELECT COALESCE(SUM(l.qty),0) FROM inward_gate_pass_lines l JOIN inward_gate_passes v ON v.id = l.igp_id JOIN items i ON i.id = l.item_id
                                             WHERE v.voucher_date = :d AND v.status = 'posted' AND v.deleted_at IS NULL AND i.item_type IN $fab"),
                'outward_qty'  => $todayQty("SELECT COALESCE(SUM(l.qty),0) FROM delivery_chalan_lines l JOIN delivery_chalans v ON v.id = l.chalan_id JOIN items i ON i.id = l.item_id
                                             WHERE v.voucher_date = :d AND v.status = 'posted' AND v.deleted_at IS NULL AND i.item_type IN $fab"),
                'produced_qty' => $todayQty("SELECT COALESCE(SUM(produced_qty),0) FROM productions WHERE voucher_date = :d AND status = 'posted' AND deleted_at IS NULL"),
                'ink_ml'       => $todayQty("SELECT COALESCE(SUM(total_ml),0) FROM ink_loads WHERE voucher_date = :d AND status = 'posted' AND deleted_at IS NULL"),
            ],
            'production_by_machine' => $num($byMachine, ['today_qty', 'week_qty']),
            'low_stock'             => $num($lowStock, ['reorder_level', 'stock_qty']),
            'pending_deliveries'    => $num($pending, ['pending_qty', 'ready_qty']),
            'top_customers'         => array_map(fn ($r) => ['party' => $r['party'], 'delivered_qty' => round((float) $r['delivered_qty'], 3), 'chalans' => (int) $r['chalans']], $top),
        ];
    }
}
