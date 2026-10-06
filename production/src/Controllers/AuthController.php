<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\ApiException;
use Prod\Audit;
use Prod\Auth;
use Prod\Config;
use Prod\Database;
use Prod\Request;
use Prod\Settings;

final class AuthController
{
    /** Session state for the SPA: user (or null), CSRF token, permissions. */
    public function me(Request $r): array
    {
        $u = Auth::user();
        return [
            'user'        => $u,
            'csrf'        => Auth::csrfToken(),
            'permissions' => $u ? Auth::permissions() : [],
            'company'     => $u ? Settings::get('company_name', '') : '',
            'timeout_min' => Auth::timeoutMinutes(),
            'app_name'    => Config::get('app_name', 'Production'),
        ];
    }

    public function login(Request $r): array
    {
        Auth::attempt((string)$r->input('username', ''), (string)$r->input('password', ''));
        return $this->me($r);
    }

    public function logout(Request $r): array
    {
        Auth::logout();
        return ['csrf' => Auth::csrfToken()];
    }

    public function password(Request $r): array
    {
        $u = Auth::require();
        $hash = (string)Database::value('SELECT password_hash FROM users WHERE id = ?', [$u['id']]);
        if (!password_verify((string)$r->input('current', ''), $hash)) {
            throw ApiException::validation(['current' => 'Current password is wrong.']);
        }
        $new = (string)$r->input('password', '');
        if ($problem = Auth::passwordProblem($new)) {
            throw ApiException::validation(['password' => $problem]);
        }
        if (password_verify($new, $hash)) {
            throw ApiException::validation(['password' => 'Choose a password different from the current one.']);
        }
        Database::update('users', ['password_hash' => password_hash($new, PASSWORD_DEFAULT), 'must_change_password' => 0], 'id = :id', ['id' => $u['id']]);
        Auth::bumpSessionVersion((int)$u['id'], true);
        Audit::log('password', 'users', (int)$u['id']);
        return $this->me($r);
    }
}
