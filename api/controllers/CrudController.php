<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Request;
use App\Validator;

/**
 * Generic CRUD for simple master tables (departments, designations, shifts, ...).
 * Subclasses set the table, rules, unique columns and optional hooks.
 */
abstract class CrudController
{
    protected string $table;
    protected string $label = 'Record';
    /** @var array<string,string> field => rule string */
    protected array $rules = [];
    /** @var array<string,string> unique column => label */
    protected array $unique = [];
    protected array $searchable = ['code', 'name'];
    protected string $orderBy = 'name';
    protected bool $hasActiveFlag = true;

    /** Base SELECT (override to add joins). Must expose the table as alias `t`. */
    protected function baseSelect(): string
    {
        return "SELECT t.* FROM `{$this->table}` t";
    }

    /** Hook: adjust / validate clean data before insert/update. */
    protected function beforeSave(array $data, ?array $existing, Request $r): array
    {
        return $data;
    }

    /** Hook: save child rows etc. (inside the transaction). */
    protected function afterSave(int $id, array $data, ?array $existing, Request $r): void
    {
    }

    /** Hook: decorate a single record for show(). */
    protected function decorate(array $row): array
    {
        return $row;
    }

    public function index(Request $r): array
    {
        $where = [];
        $params = [];
        $q = (string)$r->query('q', '');
        if ($q !== '') {
            $or = [];
            foreach ($this->searchable as $i => $col) {
                $or[] = "t.`$col` LIKE :q$i";
                $params["q$i"] = '%' . $q . '%';
            }
            $where[] = '(' . implode(' OR ', $or) . ')';
        }
        if ($this->hasActiveFlag && $r->query('active') === '1') {
            $where[] = 't.is_active = 1';
        }
        $sql = $this->baseSelect() . ($where ? ' WHERE ' . implode(' AND ', $where) : '') . " ORDER BY t.`{$this->orderBy}`";
        return Database::all($sql, $params);
    }

    protected function find(int $id): array
    {
        $row = Database::one($this->baseSelect() . ' WHERE t.id = ?', [$id]);
        if (!$row) {
            throw ApiException::notFound($this->label);
        }
        return $row;
    }

    public function show(Request $r): array
    {
        return $this->decorate($this->find($r->id()));
    }

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        return $this->save($r, $this->rawFind($r->id()));
    }

    protected function rawFind(int $id): array
    {
        $row = Database::one("SELECT * FROM `{$this->table}` WHERE id = ?", [$id]);
        if (!$row) {
            throw ApiException::notFound($this->label);
        }
        return $row;
    }

    protected function save(Request $r, ?array $existing): array
    {
        $data = Validator::make($r->body(), $this->rules);
        $this->checkUnique($data, $existing['id'] ?? null);
        $data = $this->beforeSave($data, $existing, $r);
        $columns = array_intersect_key($data, array_flip($this->columns()));

        $id = Database::transaction(function () use ($columns, $data, $existing, $r) {
            if ($existing) {
                $columns['updated_by'] = Auth::id();
                Database::update($this->table, $columns, 'id = :id', ['id' => $existing['id']]);
                $id = (int)$existing['id'];
                $this->afterSave($id, $data, $existing, $r);
                Audit::log('update', $this->table, $id, $existing, $columns);
            } else {
                $columns['created_by'] = Auth::id();
                $id = Database::insert($this->table, $columns);
                $this->afterSave($id, $data, null, $r);
                Audit::log('create', $this->table, $id, null, $columns);
            }
            return $id;
        });
        return $this->decorate($this->find($id));
    }

    /** Real table columns that may be written from validated data. */
    protected function columns(): array
    {
        return array_keys($this->rules);
    }

    protected function checkUnique(array $data, ?int $exceptId): void
    {
        $errors = [];
        foreach ($this->unique as $col => $label) {
            if (!isset($data[$col]) || $data[$col] === null) {
                continue;
            }
            $sql = "SELECT id FROM `{$this->table}` WHERE `$col` = :v" . ($exceptId ? ' AND id <> :id' : '');
            $params = ['v' => $data[$col]] + ($exceptId ? ['id' => $exceptId] : []);
            if (Database::value($sql, $params)) {
                $errors[$col] = "$label \"{$data[$col]}\" is already used.";
            }
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
    }

    public function destroy(Request $r): array
    {
        $row = $this->rawFind($r->id());
        try {
            Database::transaction(function () use ($row) {
                Database::run("DELETE FROM `{$this->table}` WHERE id = ?", [$row['id']]);
                Audit::log('delete', $this->table, (int)$row['id'], $row, null);
            });
        } catch (\PDOException $e) {
            if (($e->errorInfo[1] ?? 0) === 1451) {
                throw ApiException::conflict("This {$this->label} is in use and cannot be deleted."
                    . ($this->hasActiveFlag ? ' Mark it inactive instead.' : ''));
            }
            throw $e;
        }
        return ['deleted' => true];
    }
}
