<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Request;
use App\Validator;

final class UserController
{
    private const RULES = [
        'username'             => 'required|code|min:3|max:50',
        'full_name'            => 'required|string|max:100',
        'email'                => 'nullable|email|max:120',
        'role_id'              => 'required|int|exists:roles',
        'is_active'            => 'bool',
        'must_change_password' => 'bool',
    ];

    public function index(Request $r): array
    {
        return Database::all(
            'SELECT u.id, u.username, u.full_name, u.email, u.role_id, r.name AS role, u.is_active,
                    u.must_change_password, u.last_login_at, u.last_login_ip
               FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.username'
        );
    }

    public function show(Request $r): array
    {
        return $this->find($r->id());
    }

    private function find(int $id): array
    {
        $u = Database::one(
            'SELECT u.id, u.username, u.full_name, u.email, u.role_id, r.name AS role, u.is_active,
                    u.must_change_password, u.last_login_at, u.last_login_ip
               FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
            [$id]
        );
        if (!$u) {
            throw ApiException::notFound('User');
        }
        return $u;
    }

    public function store(Request $r): array
    {
        $data = Validator::make($r->body(), self::RULES);
        $this->unique($data['username'], null);
        $password = (string)$r->input('password', '');
        if ($msg = Auth::validatePasswordStrength($password)) {
            throw ApiException::validation(['password' => $msg]);
        }
        $id = Database::transaction(function () use ($data, $password) {
            $id = Database::insert('users', $data + [
                'password_hash' => password_hash($password, PASSWORD_DEFAULT),
                'created_by'    => Auth::id(),
            ]);
            Audit::log('create', 'users', $id, null, $data);
            return $id;
        });
        return $this->find($id);
    }

    public function update(Request $r): array
    {
        $id = $r->id();
        $old = Database::one('SELECT * FROM users WHERE id = ?', [$id]);
        if (!$old) {
            throw ApiException::notFound('User');
        }
        $data = Validator::make($r->body(), self::RULES);
        $this->unique($data['username'], $id);

        if ($id === Auth::id() && (!$data['is_active'] || (int)$data['role_id'] !== (int)$old['role_id'])) {
            throw ApiException::validation(['role_id' => 'You cannot disable yourself or change your own role.']);
        }
        if ($this->isAdminRole((int)$old['role_id']) && (!$data['is_active'] || !$this->isAdminRole((int)$data['role_id']))) {
            $this->ensureAnotherAdmin($id);
        }
        $password = (string)$r->input('password', '');
        if ($password !== '') {
            if ($msg = Auth::validatePasswordStrength($password)) {
                throw ApiException::validation(['password' => $msg]);
            }
            $data['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
        }
        Database::transaction(function () use ($id, $data, $old) {
            Database::update('users', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            $logged = $data;
            if (isset($logged['password_hash'])) {
                unset($logged['password_hash']);
                $logged['password'] = '(reset)';
            }
            Audit::log('update', 'users', $id, $old, $logged);
        });
        return $this->find($id);
    }

    public function destroy(Request $r): array
    {
        $id = $r->id();
        $old = Database::one('SELECT * FROM users WHERE id = ?', [$id]);
        if (!$old) {
            throw ApiException::notFound('User');
        }
        if ($id === Auth::id()) {
            throw ApiException::conflict('You cannot delete your own account.');
        }
        if ($this->isAdminRole((int)$old['role_id'])) {
            $this->ensureAnotherAdmin($id);
        }
        Database::transaction(function () use ($id, $old) {
            Database::run('DELETE FROM users WHERE id = ?', [$id]);
            Audit::log('delete', 'users', $id, $old, null);
        });
        return ['deleted' => true];
    }

    private function unique(string $username, ?int $except): void
    {
        $dup = Database::value('SELECT id FROM users WHERE username = ?' . ($except ? ' AND id <> ?' : ''),
            $except ? [$username, $except] : [$username]);
        if ($dup) {
            throw ApiException::validation(['username' => 'This username is already taken.']);
        }
    }

    private function isAdminRole(int $roleId): bool
    {
        return (bool)Database::value('SELECT is_admin FROM roles WHERE id = ?', [$roleId]);
    }

    private function ensureAnotherAdmin(int $exceptUserId): void
    {
        $others = (int)Database::value(
            'SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id WHERE r.is_admin = 1 AND u.is_active = 1 AND u.id <> ?',
            [$exceptUserId]
        );
        if ($others === 0) {
            throw ApiException::conflict('At least one active Admin user must remain.');
        }
    }
}
