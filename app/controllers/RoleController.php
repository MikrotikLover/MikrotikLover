<?php
declare(strict_types=1);

final class RoleController
{
    /** GET roles — for dropdowns (any logged-in user with users.view). */
    public function index(): array
    {
        $rows = DB::all(
            'SELECT r.id, r.code, r.name, r.name_ur, r.description, r.is_system,
                    (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id AND u.deleted_at IS NULL) AS user_count
             FROM roles r ORDER BY r.id'
        );
        return array_map(static function (array $r): array {
            $r['id'] = (int) $r['id'];
            $r['is_system'] = (int) $r['is_system'];
            $r['user_count'] = (int) $r['user_count'];
            return $r;
        }, $rows);
    }

    /** GET roles/matrix — all permissions grouped by module + codes granted per role. */
    public function matrix(): array
    {
        $permissions = DB::all('SELECT id, code, module, action, description FROM permissions ORDER BY sort_order, code');
        $grants = [];
        foreach (DB::all('SELECT rp.role_id, p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id') as $g) {
            $grants[(int) $g['role_id']][] = $g['code'];
        }
        $roles = $this->index();
        foreach ($roles as &$role) {
            $role['permissions'] = $role['code'] === 'admin'
                ? array_column($permissions, 'code')
                : ($grants[$role['id']] ?? []);
        }
        unset($role);

        $modules = [];
        foreach ($permissions as $p) {
            $modules[$p['module']][] = ['code' => $p['code'], 'action' => $p['action'], 'description' => $p['description']];
        }
        return ['roles' => $roles, 'modules' => $modules];
    }

    /** PUT roles/{id}/permissions {codes: string[]} */
    public function updatePermissions(int $id): never
    {
        $role = DB::one('SELECT id, code, name FROM roles WHERE id = :id', ['id' => $id]);
        if ($role === null) {
            throw HttpException::notFound();
        }
        if ($role['code'] === 'admin') {
            throw HttpException::validation(['codes' => Lang::t('role.admin_locked')]);
        }
        $codes = Request::input('codes', []);
        if (!is_array($codes)) {
            throw HttpException::validation(['codes' => Lang::t('validation.in')]);
        }
        $codes = array_values(array_unique(array_filter($codes, 'is_string')));

        $params = [];
        $valid = $codes ? DB::all('SELECT id, code FROM permissions WHERE code IN ' . DB::in($codes, $params), $params) : [];
        if (count($valid) !== count($codes)) {
            throw HttpException::validation(['codes' => Lang::t('validation.in')]);
        }

        DB::transaction(function () use ($id, $role, $valid): void {
            $before = DB::column(
                'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = :r ORDER BY p.code',
                ['r' => $id]
            );
            DB::query('DELETE FROM role_permissions WHERE role_id = :r', ['r' => $id]);
            foreach ($valid as $p) {
                DB::insert('role_permissions', ['role_id' => $id, 'permission_id' => (int) $p['id']]);
            }
            $after = array_column($valid, 'code');
            sort($after);
            Audit::log('permissions_update', 'roles', $id,
                ['removed' => array_values(array_diff($before, $after))],
                ['added' => array_values(array_diff($after, $before))],
                $role['code']);
        });
        Response::ok(['id' => $id, 'codes' => array_column($valid, 'code')], 200, Lang::t('saved'));
    }
}
