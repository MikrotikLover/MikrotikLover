<?php
declare(strict_types=1);

/**
 * Base CRUD controller for master data (soft delete + audit + auto codes).
 *
 * Subclasses describe the table and its validation rules; this class does
 * list (search / status filter / paging), show, create, update and delete.
 * Every write runs in one DB transaction together with its audit entry.
 */
abstract class MasterController
{
    /** Table name. */
    protected string $table;
    /** Audit entity name (defaults to table). */
    protected string $entity = '';
    /** Column holding the business code. */
    protected string $codeColumn = 'code';
    /** Prefix for auto-generated codes when the code is left blank (e.g. P → P0001). */
    protected string $codePrefix = '';
    /** Columns searched by ?q= (prefixed with t.). */
    protected array $searchColumns = ['code', 'name', 'name_ur'];
    /** ORDER BY clause for lists. */
    protected string $orderBy = 't.name';
    /** Columns cast to int in responses. */
    protected array $intColumns = ['id', 'is_active'];

    /** Validator rules for create ($id = null) or update. */
    abstract protected function rules(?int $id): array;

    /** SELECT list for index/show (table alias t). */
    protected function selectSql(): string
    {
        return 't.*';
    }

    /** Extra JOINs for index/show. */
    protected function joinSql(): string
    {
        return '';
    }

    /** Add entity-specific list filters from the query string. */
    protected function applyFilters(array &$where, array &$params): void
    {
    }

    /** Post-validation hook: normalise data, run cross-field checks (throw 422). */
    protected function prepare(array $data, ?array $old): array
    {
        return $data;
    }

    /** Called inside the save transaction after the main row is written (child rows). */
    protected function afterSave(int $id, array $data, ?array $old): void
    {
    }

    /** Extra data added to show() (child rows etc.). */
    protected function details(array $row): array
    {
        return $row;
    }

    /**
     * References that block deletion: [table, column, extraWhere?].
     * Rows in tables with deleted_at are only counted when not deleted.
     */
    protected function references(): array
    {
        return [];
    }

    /** Hook to enforce extra permissions per record (e.g. ink vs other items). */
    protected function authorizeWrite(array $data, ?array $old): void
    {
    }

    protected function cast(array $row): array
    {
        foreach ($this->intColumns as $col) {
            if (array_key_exists($col, $row) && $row[$col] !== null) {
                $row[$col] = (int) $row[$col];
            }
        }
        return $row;
    }

    protected function entityName(): string
    {
        return $this->entity !== '' ? $this->entity : $this->table;
    }

    /* ------------------------------------------------------------ actions */

    /** GET {entity}?q=&status=active|inactive|all&page=&per_page= */
    public function index(): array
    {
        [$page, $perPage, $offset] = Request::paging(25, 500);
        $where = ['t.deleted_at IS NULL'];
        $params = [];

        $q = (string) Request::query('q', '');
        if ($q !== '' && $this->searchColumns) {
            $like = '%' . addcslashes($q, '%_\\') . '%';
            $parts = [];
            foreach ($this->searchColumns as $i => $col) {
                $parts[] = "t.`$col` LIKE :q$i";
                $params["q$i"] = $like;
            }
            $where[] = '(' . implode(' OR ', $parts) . ')';
        }
        $status = (string) Request::query('status', 'all');
        if ($status === 'active' || $status === 'inactive') {
            $where[] = 't.is_active = :active';
            $params['active'] = $status === 'active' ? 1 : 0;
        }
        $this->applyFilters($where, $params);

        $whereSql = implode(' AND ', $where);
        $from = "FROM `{$this->table}` t {$this->joinSql()} WHERE $whereSql";
        $total = (int) DB::value("SELECT COUNT(*) $from", $params);
        $rows = DB::all(
            "SELECT {$this->selectSql()} $from ORDER BY t.is_active DESC, {$this->orderBy} LIMIT :limit OFFSET :offset",
            $params + ['limit' => $perPage, 'offset' => $offset]
        );
        return [
            'items'    => array_map([$this, 'cast'], $rows),
            'total'    => $total,
            'page'     => $page,
            'per_page' => $perPage,
        ];
    }

    /** GET {entity}/{id} */
    public function show(int $id): array
    {
        return $this->details($this->cast($this->find($id)));
    }

    /** POST {entity} */
    public function store(): never
    {
        $data = $this->prepare(Validator::make(Request::body(), $this->rules(null)), null);
        $this->authorizeWrite($data, null);
        $id = DB::transaction(function () use ($data): int {
            $row = $this->columnsOnly($data);
            if ($this->codeColumn !== '' && empty($row[$this->codeColumn])) {
                $row[$this->codeColumn] = $this->nextCode($data);
            }
            $row['created_at'] = DB::now();
            $row['created_by'] = Auth::id();
            $id = DB::insert($this->table, $row);
            $this->afterSave($id, $data, null);
            Audit::log('create', $this->entityName(), $id, null, $data + [$this->codeColumn => $row[$this->codeColumn] ?? null], (string) ($row[$this->codeColumn] ?? $id));
            return $id;
        });
        Response::ok($this->show($id), 201, Lang::t('saved'));
    }

    /** PUT {entity}/{id} */
    public function update(int $id): never
    {
        $old = $this->find($id);
        $data = $this->prepare(Validator::make(Request::body(), $this->rules($id)), $old);
        $this->authorizeWrite($data, $old);
        DB::transaction(function () use ($id, $old, $data): void {
            $row = $this->columnsOnly($data);
            if ($this->codeColumn !== '' && array_key_exists($this->codeColumn, $row) && empty($row[$this->codeColumn])) {
                unset($row[$this->codeColumn]); // blank code on edit keeps the existing code
            }
            $row['updated_at'] = DB::now();
            $row['updated_by'] = Auth::id();
            DB::update($this->table, $row, $id);
            $this->afterSave($id, $data, $old);
            Audit::log('update', $this->entityName(), $id, $this->details($this->cast($old)), $data, (string) ($old[$this->codeColumn] ?? $id));
        });
        Response::ok($this->show($id), 200, Lang::t('saved'));
    }

    /** DELETE {entity}/{id} — soft delete, refused while referenced. */
    public function destroy(int $id): never
    {
        $old = $this->find($id);
        $this->authorizeWrite($old, $old);
        foreach ($this->references() as $ref) {
            [$table, $column] = $ref;
            $extra = $ref[2] ?? '';
            $hasSoftDelete = (bool) DB::value(
                'SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :t AND column_name = :c',
                ['t' => $table, 'c' => 'deleted_at']
            );
            $sql = "SELECT COUNT(*) FROM `$table` WHERE `$column` = :id" . ($hasSoftDelete ? ' AND deleted_at IS NULL' : '') . ($extra ? " AND $extra" : '');
            if ((int) DB::value($sql, ['id' => $id]) > 0) {
                throw new HttpException(409, Lang::t('master.in_use'), [], 'in_use');
            }
        }
        DB::transaction(function () use ($id, $old): void {
            DB::update($this->table, ['is_active' => 0, 'deleted_at' => DB::now(), 'deleted_by' => Auth::id()], $id);
            Audit::log('delete', $this->entityName(), $id, $this->cast($old), null, (string) ($old[$this->codeColumn] ?? $id));
        });
        Response::ok(['id' => $id], 200, Lang::t('deleted'));
    }

    /* ------------------------------------------------------------ helpers */

    protected function find(int $id): array
    {
        $row = DB::one(
            "SELECT {$this->selectSql()} FROM `{$this->table}` t {$this->joinSql()} WHERE t.id = :id AND t.deleted_at IS NULL",
            ['id' => $id]
        );
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    /** Keeps only keys that are real columns of the table (drops child arrays, helper fields). */
    protected function columnsOnly(array $data): array
    {
        static $cache = [];
        $cols = $cache[$this->table] ??= DB::column(
            'SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = :t',
            ['t' => $this->table]
        );
        $blocked = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'deleted_by'];
        return array_filter(
            $data,
            fn ($v, $k) => in_array($k, $cols, true) && !in_array($k, $blocked, true) && !is_array($v),
            ARRAY_FILTER_USE_BOTH
        );
    }

    /** Next code like P0001 based on the highest existing numeric code with the prefix. */
    protected function nextCode(array $data): string
    {
        $prefix = $this->codePrefixFor($data);
        $col = $this->codeColumn;
        $max = (int) DB::value(
            "SELECT MAX(CAST(SUBSTRING(`$col`, :len) AS UNSIGNED)) FROM `{$this->table}` WHERE `$col` REGEXP :re",
            ['len' => strlen($prefix) + 1, 're' => '^' . preg_quote($prefix, '/') . '[0-9]+$']
        );
        return $prefix . str_pad((string) ($max + 1), 4, '0', STR_PAD_LEFT);
    }

    protected function codePrefixFor(array $data): string
    {
        return $this->codePrefix;
    }

    /** Throws 422 with the given field errors if any. */
    protected static function fail(array $errors): void
    {
        if ($errors) {
            throw HttpException::validation($errors);
        }
    }
}
