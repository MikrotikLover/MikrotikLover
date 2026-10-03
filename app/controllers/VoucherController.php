<?php
declare(strict_types=1);

/**
 * Base for every stock voucher (IGP, STV, SCV, INK; later BOM, MPV, DCV).
 *
 * Save = ONE transaction: lock items → number → header → lines → stock rows →
 * negative-stock check → audit. Any failure rolls everything back.
 * Edit replaces the voucher's lines and stock rows; cancel removes its stock
 * rows (refused if that would make any balance negative). Vouchers are never
 * hard-deleted.
 *
 * Request body: { voucher_date, remarks, ...header, lines: [{_row, ...}] }
 * `_row` is the grid row index; line errors come back as "lines.<_row>.<field>".
 */
abstract class VoucherController
{
    /** Voucher type code used in stock_movements and numbering (e.g. IGP). */
    protected string $type;
    protected string $table;
    protected string $linesTable;
    /** FK column in the lines table. */
    protected string $fk;
    /** Columns cast to int in output. */
    protected array $intColumns = ['id'];
    protected array $lineIntColumns = ['id', 'line_no', 'item_id', 'unit_id', 'rolls'];
    /** false = lines are computed by buildLines() from the header (e.g. estimation), not entered. */
    protected bool $linesFromBody = true;
    /** false = a voucher may be saved without entered lines (e.g. production: lines come from the BOM / fabric only). */
    protected bool $requireLines = true;

    abstract protected function headerRules(): array;

    abstract protected function lineRules(): array;

    /**
     * Enrich/validate parsed lines (unit, rate, amount …). Use $err($row, $field, $msg)
     * for line errors. $items = Stock::items() of all line items.
     */
    abstract protected function buildLines(array $h, array $lines, array $items, callable $err): array;

    /** Header total columns from the built lines. */
    abstract protected function totals(array $lines): array;

    /**
     * Ledger rows for the voucher. Each row may carry '_err' = error key used if
     * that outflow makes stock negative.
     */
    abstract protected function movements(array $h, int $id, string $no, array $lines, array $items): array;

    /** Extra WHERE for tables shared by several voucher types (alias v), e.g. production_type. */
    protected function scopeSql(): string
    {
        return '';
    }

    /** Items moved by the voucher that are not on its lines (e.g. production fabric) — locked too. */
    protected function extraLockItems(array $h): array
    {
        return [];
    }

    /** Header values always written (e.g. production_type). */
    protected function fixedHeader(): array
    {
        return [];
    }

    /** Extra header checks → [field => message]. */
    protected function checkHeader(array $h, ?array $old): array
    {
        return [];
    }

    /** SELECT/JOIN for list + show (alias v). */
    protected function selectSql(): string
    {
        return 'v.*';
    }

    protected function joinSql(): string
    {
        return '';
    }

    /** Columns searched by ?q= besides voucher_no. */
    protected function searchColumns(): array
    {
        return [];
    }

    protected function lineSelectSql(): string
    {
        return 'l.*, i.code AS item_code, i.name AS item_name, i.name_ur AS item_name_ur, i.item_type, u.code AS unit_code, u.decimals AS unit_decimals';
    }

    protected function lineJoinSql(): string
    {
        return 'JOIN items i ON i.id = l.item_id JOIN units u ON u.id = i.unit_id';
    }

    /* =============================================================== list */

    /** GET <type>?date_from=&date_to=&status=&q=&party_id=&warehouse_id=&item_id=&page= */
    public function index(): array
    {
        [$page, $perPage, $offset] = Request::paging(25, 200);
        $where = ['v.deleted_at IS NULL'];
        if ($this->scopeSql() !== '') {
            $where[] = $this->scopeSql();
        }
        $params = [];
        $from = (string) Request::query('date_from', '');
        $to = (string) Request::query('date_to', '');
        if ($from !== '' && Validator::isDate($from)) {
            $where[] = 'v.voucher_date >= :df';
            $params['df'] = $from;
        }
        if ($to !== '' && Validator::isDate($to)) {
            $where[] = 'v.voucher_date <= :dt';
            $params['dt'] = $to;
        }
        $status = (string) Request::query('status', '');
        if (in_array($status, ['posted', 'cancelled'], true)) {
            $where[] = 'v.status = :st';
            $params['st'] = $status;
        }
        $cols = $this->columns($this->table);
        foreach (['party_id', 'machine_id', 'design_id'] as $col) {
            if (in_array($col, $cols, true) && ($val = Request::queryInt($col)) > 0) {
                $where[] = "v.$col = :$col";
                $params[$col] = $val;
            }
        }
        if (($wh = Request::queryInt('warehouse_id')) > 0) {
            $whCols = array_values(array_filter($cols, fn ($c) => str_ends_with($c, 'warehouse_id')));
            if ($whCols) {
                $parts = [];
                foreach ($whCols as $i => $c) {
                    $parts[] = "v.$c = :wh$i";
                    $params["wh$i"] = $wh;
                }
                $where[] = '(' . implode(' OR ', $parts) . ')';
            }
        }
        if (($item = Request::queryInt('item_id')) > 0) {
            $where[] = "EXISTS (SELECT 1 FROM `{$this->linesTable}` li WHERE li.`{$this->fk}` = v.id AND li.item_id = :item)";
            $params['item'] = $item;
        }
        $q = (string) Request::query('q', '');
        if ($q !== '') {
            $like = '%' . addcslashes($q, '%_\\') . '%';
            $parts = ['v.voucher_no LIKE :q0'];
            $params['q0'] = $like;
            foreach ($this->searchColumns() as $i => $col) {
                $parts[] = "$col LIKE :q" . ($i + 1);
                $params['q' . ($i + 1)] = $like;
            }
            $where[] = '(' . implode(' OR ', $parts) . ')';
        }

        $whereSql = implode(' AND ', $where);
        $base = "FROM `{$this->table}` v {$this->joinSql()} WHERE $whereSql";
        $total = (int) DB::value("SELECT COUNT(*) $base", $params);
        $rows = DB::all(
            "SELECT {$this->selectSql()} $base ORDER BY v.voucher_date DESC, v.id DESC LIMIT :limit OFFSET :offset",
            $params + ['limit' => $perPage, 'offset' => $offset]
        );
        return ['items' => array_map([$this, 'castHeader'], $rows), 'total' => $total, 'page' => $page, 'per_page' => $perPage];
    }

    /* =============================================================== show */

    /** GET <type>/{id} */
    public function show(int $id): array
    {
        $h = $this->castHeader($this->find($id));
        $lines = DB::all(
            "SELECT {$this->lineSelectSql()} FROM `{$this->linesTable}` l {$this->lineJoinSql()} WHERE l.`{$this->fk}` = :id ORDER BY l.line_no",
            ['id' => $id]
        );
        $h['lines'] = array_map(function (array $l): array {
            foreach ($this->lineIntColumns as $c) {
                if (isset($l[$c])) {
                    $l[$c] = (int) $l[$c];
                }
            }
            return $l;
        }, $lines);
        return $h;
    }

    /* =============================================================== save */

    /** POST <type> */
    public function store(): never
    {
        [$h, $lines] = $this->validateRequest(null);
        $id = DB::transaction(function () use ($h, $lines): int {
            $items = $this->lockAndLoad(array_merge(array_column($lines, 'item_id'), $this->extraLockItems($h)));
            $lines = $this->runBuildLines($h, $lines, $items);
            $no = VoucherNumber::next($this->type, $h['voucher_date']);
            // Computed values (totals, resolved defaults) override what was entered.
            $row = array_replace($this->headerRow($h), $this->totals($lines)) + [
                'voucher_no' => $no,
                'status'     => 'posted',
                'created_at' => DB::now(),
                'created_by' => Auth::id(),
            ];
            $id = DB::insert($this->table, $row);
            $this->writeLinesAndStock($h, $id, $no, $lines, $items, []);
            Audit::log('create', $this->table, $id, null, $this->auditPayload($h, $lines), $no);
            return $id;
        });
        Response::ok($this->show($id), 201, Lang::t('voucher.saved', ['no' => DB::value("SELECT voucher_no FROM `{$this->table}` WHERE id = :id", ['id' => $id])]));
    }

    /** PUT <type>/{id} */
    public function update(int $id): never
    {
        $old = $this->show($id);
        $this->assertEditable($old);
        [$h, $lines] = $this->validateRequest($old);
        DB::transaction(function () use ($id, $old, $h, $lines): void {
            $items = $this->lockAndLoad(array_merge(
                array_column($lines, 'item_id'), array_column($old['lines'], 'item_id'),
                $this->extraLockItems($h), $this->extraLockItems($old)
            ));
            // Re-read under lock: someone may have cancelled it meanwhile.
            $this->assertEditable($this->lockRow($id));
            $lines = $this->runBuildLines($h, $lines, $items);
            $removed = Stock::remove($this->type, $id);
            DB::query("DELETE FROM `{$this->linesTable}` WHERE `{$this->fk}` = :id", ['id' => $id]);
            DB::update($this->table, array_replace($this->headerRow($h), $this->totals($lines)) + [
                'updated_at' => DB::now(),
                'updated_by' => Auth::id(),
            ], $id);
            $this->writeLinesAndStock($h, $id, $old['voucher_no'], $lines, $items, $removed);
            Audit::log('update', $this->table, $id, $this->auditPayload($old, $old['lines']), $this->auditPayload($h, $lines), $old['voucher_no']);
        });
        Response::ok($this->show($id), 200, Lang::t('voucher.saved', ['no' => $old['voucher_no']]));
    }

    /** POST <type>/{id}/cancel {reason} */
    public function cancel(int $id): never
    {
        $old = $this->show($id);
        $this->assertEditable($old);
        $data = Validator::make(Request::body(), ['reason' => 'required|string|max:255']);
        DB::transaction(function () use ($id, $old, $data): void {
            $this->lockAndLoad(array_merge(array_column($old['lines'], 'item_id'), $this->extraLockItems($old)));
            $this->assertEditable($this->lockRow($id));
            $removed = Stock::remove($this->type, $id);
            Stock::assertNonNegative(array_map(fn ($k) => [$k['item_id'], $k['warehouse_id'], $k['lot_no'], null, 0], $removed));
            DB::update($this->table, [
                'status'        => 'cancelled',
                'cancelled_at'  => DB::now(),
                'cancelled_by'  => Auth::id(),
                'cancel_reason' => $data['reason'],
            ], $id);
            Audit::log('cancel', $this->table, $id, ['status' => 'posted'], ['status' => 'cancelled', 'reason' => $data['reason']], $old['voucher_no']);
        });
        Response::ok($this->show($id), 200, Lang::t('voucher.cancelled', ['no' => $old['voucher_no']]));
    }

    /* ============================================================ helpers */

    /** @return array{0: array, 1: array} [header, lines] */
    private function validateRequest(?array $old): array
    {
        $body = Request::body();
        $errors = [];
        $h = [];
        try {
            $h = Validator::make($body, [
                'voucher_date' => 'required|date',
                'remarks'      => 'nullable|string|max:500',
            ] + $this->headerRules());
        } catch (HttpException $e) {
            $errors = $e->errors;
        }
        if (isset($h['voucher_date']) && $h['voucher_date'] > date('Y-m-d')) {
            $errors['voucher_date'] = Lang::t('voucher.future_date');
        }
        if ($h) {
            $errors += $this->checkHeader($h, $old);
        }

        $lines = [];
        foreach ($this->linesFromBody ? array_values(is_array($body['lines'] ?? null) ? $body['lines'] : []) : [] as $i => $line) {
            if (!is_array($line) || ($line['item_id'] ?? '') === '' || ($line['item_id'] ?? null) === null) {
                continue;
            }
            $row = isset($line['_row']) && is_numeric($line['_row']) ? (int) $line['_row'] : $i;
            try {
                $clean = Validator::make($line, $this->lineRules());
                $clean['_row'] = $row;
                $lines[] = $clean;
            } catch (HttpException $e) {
                foreach ($e->errors as $f => $m) {
                    $errors["lines.$row.$f"] = $m;
                }
            }
        }
        if ($this->linesFromBody && $this->requireLines && !$lines && !array_filter(array_keys($errors), fn ($k) => str_starts_with((string) $k, 'lines.'))) {
            $errors['lines'] = Lang::t('voucher.no_lines');
        }
        if ($errors) {
            throw HttpException::validation($errors, isset($errors['lines']) && count($errors) === 1 ? $errors['lines'] : null);
        }
        if (array_key_exists('voucher_time', $this->headerRules()) && empty($h['voucher_time'])) {
            $h['voucher_time'] = $old['voucher_time'] ?? date('H:i:s');
        }
        return [$h, $lines];
    }

    private function lockAndLoad(array $itemIds): array
    {
        Stock::lockItems($itemIds);
        return Stock::items($itemIds);
    }

    private function runBuildLines(array $h, array $lines, array $items): array
    {
        $errors = [];
        $err = function (int $row, string $field, string $msg) use (&$errors): void {
            $errors["lines.$row.$field"] ??= $msg;
        };
        foreach ($lines as $l) {
            if (!isset($items[(int) $l['item_id']])) {
                $err($l['_row'], 'item_id', Lang::t('validation.exists'));
            }
        }
        if ($errors) {
            throw HttpException::validation($errors);
        }
        $built = $this->buildLines($h, $lines, $items, $err);
        if ($errors) {
            throw HttpException::validation($errors);
        }
        return $built;
    }

    /** Inserts lines + ledger rows and verifies stock. $removed = keys from the old ledger rows. */
    private function writeLinesAndStock(array $h, int $id, string $no, array &$lines, array $items, array $removed): void
    {
        $lineCols = $this->columns($this->linesTable);
        foreach ($lines as $n => &$l) {
            $row = array_filter($l, fn ($v, $k) => in_array($k, $lineCols, true) && !in_array($k, ['id', $this->fk, 'line_no'], true), ARRAY_FILTER_USE_BOTH);
            $row[$this->fk] = $id;
            $row['line_no'] = $n + 1;
            $l['id'] = DB::insert($this->linesTable, $row);
        }
        unset($l);

        $rows = $this->movements($h, $id, $no, $lines, $items);
        foreach ($rows as &$r) {
            $r += ['voucher_type' => $this->type, 'voucher_id' => $id, 'voucher_no' => $no, 'movement_date' => $h['voucher_date']];
        }
        unset($r);
        Stock::post($rows);

        $checks = array_map(fn ($k) => [$k['item_id'], $k['warehouse_id'], $k['lot_no'], null, 0], $removed);
        foreach ($rows as $r) {
            if ((float) ($r['qty_out'] ?? 0) > 0) {
                $checks[] = [$r['item_id'], $r['warehouse_id'], $r['lot_no'] ?? '', $r['_err'] ?? null, $r['qty_out']];
            }
        }
        Stock::assertNonNegative($checks);
    }

    /** Header values that are real columns of the table. */
    private function headerRow(array $h): array
    {
        $cols = $this->columns($this->table);
        $blocked = ['id', 'voucher_no', 'status', 'created_at', 'created_by', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'deleted_at', 'deleted_by'];
        return array_filter($this->fixedHeader() + $h, fn ($v, $k) => in_array($k, $cols, true) && !in_array($k, $blocked, true) && !is_array($v), ARRAY_FILTER_USE_BOTH);
    }

    private function auditPayload(array $h, array $lines): array
    {
        $out = array_intersect_key($h, array_flip(array_merge(array_keys($this->headerRules()), ['voucher_date', 'remarks'])));
        $out['lines'] = array_map(fn ($l) => array_intersect_key($l, array_flip(array_merge(array_keys($this->lineRules()), ['qty', 'rate', 'amount']))), $lines);
        return $out;
    }

    protected function assertEditable(array $v): void
    {
        if ($v['status'] !== 'posted') {
            throw new HttpException(409, Lang::t('voucher.not_editable'), [], 'not_editable');
        }
    }

    /** Locks only the voucher row (not joined masters) and returns its status. */
    private function lockRow(int $id): array
    {
        $scope = $this->scopeSql() !== '' ? ' AND ' . str_replace('v.', '', $this->scopeSql()) : '';
        $row = DB::one("SELECT id, status FROM `{$this->table}` WHERE id = :id AND deleted_at IS NULL$scope FOR UPDATE", ['id' => $id]);
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    protected function find(int $id): array
    {
        $row = DB::one(
            "SELECT {$this->selectSql()} FROM `{$this->table}` v {$this->joinSql()} WHERE v.id = :id AND v.deleted_at IS NULL"
            . ($this->scopeSql() !== '' ? ' AND ' . $this->scopeSql() : ''),
            ['id' => $id]
        );
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    protected function castHeader(array $row): array
    {
        foreach (array_merge(['id', 'created_by', 'updated_by', 'cancelled_by'], $this->intColumns) as $c) {
            if (isset($row[$c])) {
                $row[$c] = (int) $row[$c];
            }
        }
        return $row;
    }

    protected function columns(string $table): array
    {
        static $cache = [];
        return $cache[$table] ??= DB::column(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :t',
            ['t' => $table]
        );
    }

    /** Shared rule fragments. */
    protected const PHONE = 'nullable|string|max:30|regex:/^[0-9+\-\s()]{7,30}$/';
    protected const TIME = 'nullable|string|regex:/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/';
    protected const QTY = 'required|numeric|gte:0.001|lte:99999999999';
    protected const LOT = 'nullable|string|max:40';

    /** Lot is required on lines for lot-tracked items. */
    protected function requireLot(array $l, array $item, callable $err): void
    {
        if ((int) $item['track_lots'] && trim((string) ($l['lot_no'] ?? '')) === '') {
            $err($l['_row'], 'lot_no', Lang::t('stock.lot_required'));
        }
    }
}
