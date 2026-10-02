<?php
declare(strict_types=1);

/**
 * One-time setup: creates the first Admin. Permanently disabled as soon as
 * any user row exists (including soft-deleted ones).
 */
final class SetupController
{
    /** POST setup/admin {setup_key?, full_name, username, password, confirm_password} */
    public function createAdmin(): array
    {
        $result = DB::transaction(function (): array {
            // FOR UPDATE takes a range lock on the (empty) table, so a second
            // concurrent setup request blocks here and then sees the new admin.
            if ((int) DB::value('SELECT COUNT(*) FROM users FOR UPDATE') > 0) {
                throw new HttpException(409, Lang::t('setup.done'), [], 'setup_done');
            }

            $body = Request::body();
            $expectedKey = (string) Config::get('app.setup_key', '');
            if ($expectedKey !== '' && !hash_equals($expectedKey, (string) ($body['setup_key'] ?? ''))) {
                throw HttpException::validation(['setup_key' => Lang::t('setup.bad_key')]);
            }

            $data = Validator::make($body, [
                'full_name'        => 'required|string|max:100',
                'username'         => 'required|string|username',
                'password'         => 'required|string|password',
                'confirm_password' => 'required|string|max:200',
                'lang'             => 'nullable|in:en,ur',
            ]);
            if ($data['password'] !== $data['confirm_password']) {
                throw HttpException::validation(['confirm_password' => Lang::t('validation.confirmed')]);
            }

            $roleId = (int) DB::value("SELECT id FROM roles WHERE code = 'admin'");
            $hash = password_hash((string) $data['password'], PASSWORD_DEFAULT);
            $id = DB::insert('users', [
                'username'            => $data['username'],
                'full_name'           => $data['full_name'],
                'password_hash'       => $hash,
                'role_id'             => $roleId,
                'lang'                => $data['lang'] ?? 'en',
                'is_active'           => 1,
                'password_changed_at' => DB::now(),
                'created_at'          => DB::now(),
            ]);
            $actor = ['id' => $id, 'username' => $data['username']];
            Audit::log('setup', 'users', $id, null, ['username' => $data['username'], 'full_name' => $data['full_name'], 'role' => 'admin'], $data['username'], $actor);
            return ['id' => $id, 'hash' => $hash];
        });

        Auth::loginAs($result['id'], $result['hash']);
        return [
            'user'        => Auth::user(),
            'permissions' => Auth::permissions(),
            'csrf'        => Csrf::token(),
        ];
    }
}
