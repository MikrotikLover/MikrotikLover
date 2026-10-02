<?php
declare(strict_types=1);

final class UserController
{
    private const COLUMNS = 'u.id, u.username, u.full_name, u.email, u.phone, u.lang, u.is_active,
        u.must_change_password, u.last_login_at, u.created_at, u.updated_at, u.role_id,
        r.code AS role_code, r.name AS role_name, r.name_ur AS role_name_ur';

    /** GET users?q=&role_id=&status=active|inactive&page=&per_page= */
    public function index(): array
    {
        [$page, $perPage, $offset] = Request::paging();
        $where = ['u.deleted_at IS NULL'];
        $params = [];

        $q = (string) Request::query('q', '');
        if ($q !== '') {
            $where[] = '(u.username LIKE :q1 OR u.full_name LIKE :q2 OR u.phone LIKE :q3 OR u.email LIKE :q4)';
            $like = '%' . addcslashes($q, '%_\\') . '%';
            $params += ['q1' => $like, 'q2' => $like, 'q3' => $like, 'q4' => $like];
        }
        if (($roleId = Request::queryInt('role_id')) > 0) {
            $where[] = 'u.role_id = :role_id';
            $params['role_id'] = $roleId;
        }
        $status = (string) Request::query('status', '');
        if ($status === 'active' || $status === 'inactive') {
            $where[] = 'u.is_active = :active';
            $params['active'] = $status === 'active' ? 1 : 0;
        }

        $whereSql = implode(' AND ', $where);
        $total = (int) DB::value("SELECT COUNT(*) FROM users u WHERE $whereSql", $params);
        $rows = DB::all(
            "SELECT " . self::COLUMNS . " FROM users u JOIN roles r ON r.id = u.role_id
             WHERE $whereSql ORDER BY u.is_active DESC, u.full_name LIMIT :limit OFFSET :offset",
            $params + ['limit' => $perPage, 'offset' => $offset]
        );

        return ['items' => array_map([$this, 'cast'], $rows), 'total' => $total, 'page' => $page, 'per_page' => $perPage];
    }

    /** GET users/{id} */
    public function show(int $id): array
    {
        return $this->cast($this->find($id));
    }

    /** POST users */
    public function store(): never
    {
        $data = $this->validate(null);
        $id = DB::transaction(function () use ($data): int {
            $row = $data;
            unset($row['password']);
            $row += [
                'password_hash'        => password_hash((string) $data['password'], PASSWORD_DEFAULT),
                'must_change_password' => (int) ($data['must_change_password'] ?? 1),
                'created_at'           => DB::now(),
                'created_by'           => Auth::id(),
            ];
            $id = DB::insert('users', $row);
            unset($row['password_hash']);
            Audit::log('create', 'users', $id, null, $row, $data['username']);
            return $id;
        });
        Response::ok($this->cast($this->find($id)), 201, Lang::t('saved'));
    }

    /** PUT users/{id} */
    public function update(int $id): never
    {
        $old = $this->find($id);
        $data = $this->validate($id);
        $this->guardAdminChanges($id, $old, $data);

        DB::transaction(function () use ($id, $old, $data): void {
            $row = $data + ['updated_at' => DB::now(), 'updated_by' => Auth::id()];
            DB::update('users', $row, $id);
            Audit::log('update', 'users', $id, $old, $data, $old['username']);
        });
        Response::ok($this->cast($this->find($id)), 200, Lang::t('saved'));
    }

    /** DELETE users/{id} — soft delete */
    public function destroy(int $id): never
    {
        $old = $this->find($id);
        $this->guardAdminChanges($id, $old, ['is_active' => 0]);
        DB::transaction(function () use ($id, $old): void {
            DB::update('users', ['is_active' => 0, 'deleted_at' => DB::now(), 'deleted_by' => Auth::id()], $id);
            Audit::log('delete', 'users', $id, $this->cast($old), null, $old['username']);
        });
        Response::ok(['id' => $id], 200, Lang::t('deleted'));
    }

    /** POST users/{id}/password {new_password} — admin reset; user must change at next login. */
    public function resetPassword(int $id): never
    {
        $old = $this->find($id);
        $data = Validator::make(Request::body(), ['new_password' => 'required|string|password']);
        DB::transaction(function () use ($id, $old, $data): void {
            DB::update('users', [
                'password_hash'        => password_hash((string) $data['new_password'], PASSWORD_DEFAULT),
                'must_change_password' => $id === Auth::id() ? 0 : 1,
                'password_changed_at'  => DB::now(),
                'updated_at'           => DB::now(),
                'updated_by'           => Auth::id(),
            ], $id);
            // Reset also clears any login lockout for this username.
            DB::query('DELETE FROM login_attempts WHERE username = :u AND success = 0', ['u' => $old['username']]);
            Audit::log('password_reset', 'users', $id, null, null, $old['username']);
        });
        Response::ok(['id' => $id], 200, Lang::t('saved'));
    }

    private function validate(?int $id): array
    {
        $rules = [
            'username'  => 'required|string|username|unique:users,username' . ($id ? ",$id" : ''),
            'full_name' => 'required|string|max:100',
            'email'     => 'nullable|email|max:150',
            'phone'     => 'nullable|string|max:30|regex:/^[0-9+\-\s()]{7,30}$/',
            'role_id'   => 'required|integer|exists:roles,id',
            'lang'      => 'required|in:en,ur',
            'is_active' => 'bool',
        ];
        if ($id === null) {
            $rules['password'] = 'required|string|password';
            $rules['must_change_password'] = 'bool';
        }
        return Validator::make(Request::body(), $rules);
    }

    /** Users cannot lock themselves out, and the last active Admin must stay. */
    private function guardAdminChanges(int $id, array $old, array $new): void
    {
        $deactivating = isset($new['is_active']) && (int) $new['is_active'] === 0;
        if ($id === Auth::id() && ($deactivating || (isset($new['role_id']) && (int) $new['role_id'] !== (int) $old['role_id']))) {
            throw HttpException::validation([$deactivating ? 'is_active' : 'role_id' => Lang::t('user.self_deactivate')]);
        }
        if ($old['role_code'] !== 'admin' || !(int) $old['is_active']) {
            return;
        }
        $adminRoleId = (int) DB::value("SELECT id FROM roles WHERE code = 'admin'");
        $losingAdmin = $deactivating || (isset($new['role_id']) && (int) $new['role_id'] !== $adminRoleId);
        if (!$losingAdmin) {
            return;
        }
        $otherAdmins = (int) DB::value(
            'SELECT COUNT(*) FROM users WHERE role_id = :r AND is_active = 1 AND deleted_at IS NULL AND id <> :id',
            ['r' => $adminRoleId, 'id' => $id]
        );
        if ($otherAdmins === 0) {
            throw HttpException::validation([$deactivating ? 'is_active' : 'role_id' => Lang::t('user.last_admin')]);
        }
    }

    private function find(int $id): array
    {
        $row = DB::one(
            'SELECT ' . self::COLUMNS . ' FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = :id AND u.deleted_at IS NULL',
            ['id' => $id]
        );
        if ($row === null) {
            throw HttpException::notFound();
        }
        return $row;
    }

    private function cast(array $row): array
    {
        foreach (['id', 'role_id', 'is_active', 'must_change_password'] as $k) {
            $row[$k] = (int) $row[$k];
        }
        return $row;
    }
}
