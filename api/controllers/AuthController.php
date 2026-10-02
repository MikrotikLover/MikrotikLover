<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Request;
use App\Settings;

final class AuthController
{
    /** Session bootstrap for the SPA: CSRF token always, user + permissions when logged in. */
    public function me(Request $r): array
    {
        $user = Auth::user();
        return [
            'csrf'            => Auth::csrfToken(),
            'user'            => $user ? $this->publicUser($user) : null,
            'permissions'     => $user ? Auth::permissions() : new \stdClass(),
            'timeout_seconds' => Auth::timeoutSeconds(),
            'company'         => ['name' => Settings::get('company_name', ''), 'name_ur' => Settings::get('company_name_ur', '')],
            'server_time'     => date('Y-m-d H:i:s'),
        ];
    }

    public function login(Request $r): array
    {
        $username = (string)$r->input('username', '');
        $password = (string)$r->input('password', '');
        if ($username === '' || $password === '') {
            throw ApiException::validation(['username' => 'Enter username and password.']);
        }
        $user = Auth::attempt($username, $password);
        return [
            'csrf'        => Auth::csrfToken(),
            'user'        => $this->publicUser($user),
            'permissions' => Auth::permissions(),
        ];
    }

    public function logout(Request $r): array
    {
        Auth::logout();
        Auth::startSession();
        return ['csrf' => Auth::csrfToken()];
    }

    /** Keeps the session alive while the operator is working. */
    public function ping(Request $r): array
    {
        return ['server_time' => date('Y-m-d H:i:s')];
    }

    public function password(Request $r): array
    {
        $user = Auth::require();
        $current = (string)$r->input('current_password', '');
        $new = (string)$r->input('new_password', '');
        $confirm = (string)$r->input('confirm_password', '');

        $hash = (string)Database::value('SELECT password_hash FROM users WHERE id = ?', [$user['id']]);
        if (!password_verify($current, $hash)) {
            throw ApiException::validation(['current_password' => 'Current password is incorrect.']);
        }
        if ($msg = Auth::validatePasswordStrength($new)) {
            throw ApiException::validation(['new_password' => $msg]);
        }
        if ($new !== $confirm) {
            throw ApiException::validation(['confirm_password' => 'Passwords do not match.']);
        }
        if (password_verify($new, $hash)) {
            throw ApiException::validation(['new_password' => 'New password must be different from the current one.']);
        }
        Database::update(
            'users',
            ['password_hash' => password_hash($new, PASSWORD_DEFAULT), 'must_change_password' => 0, 'updated_by' => $user['id']],
            'id = :id',
            ['id' => $user['id']]
        );
        Audit::log('password_change', 'users', (int)$user['id']);
        return ['changed' => true];
    }

    private function publicUser(array $u): array
    {
        return [
            'id'                   => (int)$u['id'],
            'username'             => $u['username'],
            'full_name'            => $u['full_name'],
            'role'                 => $u['role_name'],
            'is_admin'             => (bool)$u['is_admin'],
            'must_change_password' => (bool)$u['must_change_password'],
        ];
    }
}
