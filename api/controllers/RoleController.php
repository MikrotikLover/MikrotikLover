<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Permissions;
use App\Request;
use App\Validator;

final class RoleController
{
    public function modules(Request $r): array
    {
        $out = [];
        foreach (Permissions::MODULES as $key => [$label, $group, $actions]) {
            $out[] = ['key' => $key, 'label' => $label, 'group' => $group, 'actions' => $actions];
        }
        return ['modules' => $out, 'actions' => Permissions::ACTIONS];
    }

    public function index(Request $r): array
    {
        return Database::all(
            'SELECT r.id, r.name, r.description, r.is_admin, COUNT(u.id) AS user_count
               FROM roles r LEFT JOIN users u ON u.role_id = r.id
           GROUP BY r.id, r.name, r.description, r.is_admin ORDER BY r.id'
        );
    }

    public function show(Request $r): array
    {
        return $this->find($r->id());
    }

    private function find(int $id): array
    {
        $role = Database::one('SELECT id, name, description, is_admin FROM roles WHERE id = ?', [$id]);
        if (!$role) {
            throw ApiException::notFound('Role');
        }
        $role['permissions'] = Permissions::forRole($id) ?: new \stdClass();
        return $role;
    }

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        $old = $this->find($r->id());
        return $this->save($r, $old);
    }

    private function save(Request $r, ?array $old): array
    {
        $data = Validator::make($r->body(), ['name' => 'required|string|max:60', 'description' => 'nullable|string|max:255']);
        $dup = Database::value('SELECT id FROM roles WHERE name = ?' . ($old ? ' AND id <> ?' : ''),
            $old ? [$data['name'], $old['id']] : [$data['name']]);
        if ($dup) {
            throw ApiException::validation(['name' => 'A role with this name already exists.']);
        }
        if ($old && !Auth::isAdmin()) {
            Auth::assertCanGrantRole((int)$old['id']); // not the admin role, not your own role
        }
        $perms = [];
        foreach ((array)$r->input('permissions', []) as $module => $actions) {
            foreach ((array)$actions as $action) {
                if (Permissions::valid((string)$module, (string)$action)) {
                    $perms[$module][] = $action;
                }
            }
        }
        if (!Auth::holdsAll($perms)) {
            throw ApiException::forbidden('You can only grant permissions you have yourself.');
        }
        $id = Database::transaction(function () use ($data, $old, $perms) {
            if ($old) {
                $id = (int)$old['id'];
                Database::update('roles', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            } else {
                $id = Database::insert('roles', $data + ['created_by' => Auth::id()]);
            }
            if (!$old || !(int)$old['is_admin']) { // admin role always has everything
                Database::run('DELETE FROM permissions WHERE role_id = ?', [$id]);
                foreach ($perms as $module => $actions) {
                    foreach (array_unique($actions) as $action) {
                        Database::insert('permissions', ['role_id' => $id, 'module' => $module, 'action' => $action]);
                    }
                }
            }
            Audit::log($old ? 'update' : 'create', 'roles', $id,
                $old ? ['name' => $old['name'], 'description' => $old['description'], 'permissions' => (array)$old['permissions']] : null,
                $data + ['permissions' => $perms]);
            return $id;
        });
        return $this->find($id);
    }

    public function destroy(Request $r): array
    {
        $role = $this->find($r->id());
        if ((int)$role['is_admin']) {
            throw ApiException::conflict('The Admin role cannot be deleted.');
        }
        Auth::assertCanGrantRole((int)$role['id']);
        if ((int)Database::value('SELECT COUNT(*) FROM users WHERE role_id = ?', [$role['id']]) > 0) {
            throw ApiException::conflict('Users are assigned to this role. Move them to another role first.');
        }
        Database::transaction(function () use ($role) {
            Database::run('DELETE FROM roles WHERE id = ?', [$role['id']]);
            Audit::log('delete', 'roles', (int)$role['id'], ['name' => $role['name']], null);
        });
        return ['deleted' => true];
    }
}
