<?php
declare(strict_types=1);

final class AuthController
{
    /**
     * GET auth/bootstrap — public. CSRF token + app info + whether the
     * one-time setup (first admin) is still pending + current user if any.
     */
    public function bootstrap(): array
    {
        $needsSetup = (int) DB::value('SELECT COUNT(*) FROM users') === 0;
        $user = Auth::user();
        return [
            'csrf'        => Csrf::token(),
            'needs_setup' => $needsSetup,
            'setup_key_required' => $needsSetup && Config::get('app.setup_key') !== '',
            'expired'     => $user === null && !empty($_SESSION['_expired']),
            'user'        => $user,
            'permissions' => $user ? Auth::permissions() : [],
            'app'         => self::appInfo(),
        ];
    }

    /** POST auth/login {username, password} */
    public function login(): array
    {
        $data = Validator::make(Request::body(), [
            'username' => 'required|string|max:50',
            'password' => 'required|string|max:200',
        ]);
        $user = Auth::attempt($data['username'], (string) $data['password']);
        return [
            'user'        => $user,
            'permissions' => Auth::permissions(),
            'csrf'        => Csrf::token(),
        ];
    }

    /** POST auth/logout */
    public function logout(): array
    {
        Auth::logout();
        Session::start();
        return ['csrf' => Csrf::token(), 'message' => Lang::t('auth.logged_out')];
    }

    /** GET auth/me */
    public function me(): array
    {
        return [
            'user'        => Auth::user(),
            'permissions' => Auth::permissions(),
            'csrf'        => Csrf::token(),
        ];
    }

    /** POST auth/password {current_password, new_password, confirm_password} */
    public function changePassword(): array
    {
        $data = Validator::make(Request::body(), [
            'current_password' => 'required|string|max:200',
            'new_password'     => 'required|string|password',
            'confirm_password' => 'required|string|max:200',
        ]);
        $errors = [];
        if ($data['new_password'] !== $data['confirm_password']) {
            $errors['confirm_password'] = Lang::t('validation.confirmed');
        }
        $userId = (int) Auth::id();
        $hash = (string) DB::value('SELECT password_hash FROM users WHERE id = :id', ['id' => $userId]);
        if (!password_verify((string) $data['current_password'], $hash)) {
            $errors = ['current_password' => Lang::t('auth.current_wrong')] + $errors;
        } elseif (password_verify((string) $data['new_password'], $hash)) {
            $errors['new_password'] = Lang::t('validation.password_same');
        }
        if ($errors) {
            throw HttpException::validation($errors);
        }

        $newHash = password_hash((string) $data['new_password'], PASSWORD_DEFAULT);
        DB::transaction(function () use ($userId, $newHash): void {
            DB::update('users', [
                'password_hash'        => $newHash,
                'must_change_password' => 0,
                'password_changed_at'  => DB::now(),
                'updated_at'           => DB::now(),
                'updated_by'           => $userId,
            ], $userId);
            Audit::log('password_change', 'users', $userId, null, null, Auth::user()['username'] ?? null);
        });
        Auth::refreshPasswordSignature($newHash);

        return ['message' => Lang::t('auth.password_changed'), 'csrf' => Csrf::token()];
    }

    /** POST auth/lang {lang} — saves the user's UI language preference. */
    public function setLang(): array
    {
        $data = Validator::make(Request::body(), ['lang' => 'required|in:en,ur']);
        DB::update('users', ['lang' => $data['lang']], (int) Auth::id());
        return ['lang' => $data['lang']];
    }

    public static function appInfo(): array
    {
        $settings = [];
        try {
            foreach (DB::all("SELECT setting_key, setting_value FROM settings
                              WHERE setting_key IN ('company_name','company_name_ur','whatsapp_support','company_address','company_phone','company_ntn')") as $row) {
                $settings[$row['setting_key']] = (string) $row['setting_value'];
            }
        } catch (PDOException) {
            // settings table missing (seed not imported yet) — fall back to config values
        }
        return [
            'name'      => ($settings['company_name'] ?? '') ?: Config::get('app.name'),
            'name_ur'   => $settings['company_name_ur'] ?? '',
            'whatsapp'  => preg_replace('/\D+/', '', ($settings['whatsapp_support'] ?? '') ?: (string) Config::get('app.whatsapp_number')),
            'address'   => $settings['company_address'] ?? '',
            'phone'     => $settings['company_phone'] ?? '',
            'ntn'       => $settings['company_ntn'] ?? '',
            'currency'  => Config::get('app.currency', 'PKR'),
            'timezone'  => 'Asia/Karachi',
            'today'     => date('Y-m-d'),
            'version'   => APP_VERSION,
        ];
    }
}
