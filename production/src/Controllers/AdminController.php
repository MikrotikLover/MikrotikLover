<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\ApiException;
use Prod\Audit;
use Prod\Auth;
use Prod\Database;
use Prod\Request;
use Prod\Settings;
use Prod\Text;

final class AdminController
{
    public function users(Request $r): array
    {
        return Database::all('SELECT id, username, full_name, role, is_active, must_change_password, last_login_at, created_at FROM users ORDER BY username');
    }

    private function userInput(Request $r, ?array $old): array
    {
        $errors = [];
        $data = [
            'username'  => Text::clean($r->input('username', $old['username'] ?? '')),
            'full_name' => mb_substr(Text::clean($r->input('full_name', $old['full_name'] ?? '')), 0, 100),
            'role'      => (string)$r->input('role', $old['role'] ?? 'viewer'),
            'is_active' => (int)(bool)$r->input('is_active', $old['is_active'] ?? 1),
        ];
        if (!preg_match('/^[A-Za-z0-9._-]{3,50}$/', $data['username'])) {
            $errors['username'] = '3–50 letters, digits, dot, dash or underscore.';
        }
        if (!in_array($data['role'], Auth::ROLES, true)) {
            $errors['role'] = 'Choose a role.';
        }
        $password = (string)$r->input('password', '');
        if ($old === null || $password !== '') {
            if ($problem = Auth::passwordProblem($password)) {
                $errors['password'] = $problem;
            }
        }
        if ($old !== null && (int)$old['id'] === Auth::id() && ($data['role'] !== 'admin' || !$data['is_active'])) {
            $errors['role'] = 'You cannot remove your own admin access.';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        if ($password !== '') {
            $data['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
            $data['must_change_password'] = 1;
        }
        return $data;
    }

    public function userStore(Request $r): array
    {
        $data = $this->userInput($r, null);
        if (Database::value('SELECT id FROM users WHERE username = ?', [$data['username']])) {
            throw ApiException::validation(['username' => 'This username is taken.']);
        }
        $id = Database::insert('users', $data);
        Audit::log('create', 'users', $id, null, $data);
        return ['id' => $id];
    }

    public function userUpdate(Request $r): array
    {
        $id = $r->id();
        $old = Database::one('SELECT * FROM users WHERE id = ?', [$id]) ?? throw ApiException::notFound('User');
        $data = $this->userInput($r, $old);
        if (Database::value('SELECT id FROM users WHERE username = ? AND id <> ?', [$data['username'], $id])) {
            throw ApiException::validation(['username' => 'This username is taken.']);
        }
        Database::transaction(function () use ($id, $old, $data) {
            Database::update('users', $data, 'id = :id', ['id' => $id]);
            if (isset($data['password_hash']) || !$data['is_active'] || $data['role'] !== $old['role']) {
                Auth::bumpSessionVersion($id, $id === Auth::id());
            }
            Audit::log('update', 'users', $id, $old, $data);
        });
        return ['id' => $id];
    }

    public function settings(Request $r): array
    {
        return Settings::all();
    }

    public function saveSettings(Request $r): array
    {
        $in = $r->body();
        $errors = [];
        if (array_key_exists('company_name', $in) && Text::clean($in['company_name']) === '') {
            $errors['company_name'] = 'Company name is required.';
        }
        if (array_key_exists('default_ink_company_id', $in) && !Database::value('SELECT id FROM ink_companies WHERE id = ?', [(int)$in['default_ink_company_id']])) {
            $errors['default_ink_company_id'] = 'Choose an ink company.';
        }
        foreach (['ink_high_ml', 'mtr_high'] as $k) {
            if (array_key_exists($k, $in) && (Text::number($in[$k]) === null || Text::number($in[$k]) < 0)) {
                $errors[$k] = 'Enter a number.';
            }
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        $old = Settings::all();
        Settings::save($in);
        Audit::log('update', 'settings', null, $old, Settings::all());
        return Settings::all();
    }

    public function audit(Request $r): array
    {
        $page = max(1, (int)$r->queryInt('page', 1));
        $w = ['1 = 1'];
        $p = [];
        if (($entity = Text::clean($r->query('entity', ''))) !== '') {
            $w[] = 'a.entity = :entity';
            $p['entity'] = $entity;
        }
        if (($id = $r->queryInt('entity_id')) !== null) {
            $w[] = 'a.entity_id = :eid';
            $p['eid'] = $id;
        }
        $where = implode(' AND ', $w);
        $total = (int)Database::value("SELECT COUNT(*) FROM audit_log a WHERE $where", $p);
        $rows = Database::all("SELECT a.*, u.username FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE $where ORDER BY a.id DESC LIMIT 100 OFFSET " . (($page - 1) * 100), $p);
        return ['rows' => $rows, 'page' => $page, 'pages' => max(1, (int)ceil($total / 100))];
    }
}
