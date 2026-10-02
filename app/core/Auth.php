<?php
declare(strict_types=1);

/**
 * Session-based authentication + role/permission checks.
 *
 * The current user is reloaded from the database on every request, so
 * deactivating a user, changing their role or resetting their password takes
 * effect immediately (a password change invalidates all other sessions via
 * the password signature stored in the session).
 */
final class Auth
{
    private static ?array $user = null;
    private static bool $loaded = false;
    private static ?array $permissions = null;

    public static function user(): ?array
    {
        if (self::$loaded) {
            return self::$user;
        }
        self::$loaded = true;
        $uid = $_SESSION['uid'] ?? null;
        if (!is_int($uid)) {
            return null;
        }
        $row = DB::one(
            'SELECT u.id, u.username, u.full_name, u.email, u.phone, u.lang, u.is_active,
                    u.must_change_password, u.password_hash, u.role_id,
                    r.code AS role_code, r.name AS role_name, r.name_ur AS role_name_ur
             FROM users u JOIN roles r ON r.id = u.role_id
             WHERE u.id = :id AND u.deleted_at IS NULL',
            ['id' => $uid]
        );
        if ($row === null || !(int) $row['is_active']
            || !hash_equals((string) ($_SESSION['pwd_sig'] ?? ''), self::passwordSignature($row['password_hash']))) {
            unset($_SESSION['uid'], $_SESSION['pwd_sig']);
            return null;
        }
        unset($row['password_hash']);
        $row['id'] = (int) $row['id'];
        $row['role_id'] = (int) $row['role_id'];
        $row['is_active'] = (int) $row['is_active'];
        $row['must_change_password'] = (int) $row['must_change_password'];
        self::$user = $row;
        return self::$user;
    }

    public static function id(): ?int
    {
        return self::user()['id'] ?? null;
    }

    public static function isAdmin(): bool
    {
        return (self::user()['role_code'] ?? null) === 'admin';
    }

    /** @return string[] permission codes of the current user */
    public static function permissions(): array
    {
        if (self::$permissions !== null) {
            return self::$permissions;
        }
        $user = self::user();
        if ($user === null) {
            return [];
        }
        self::$permissions = self::isAdmin()
            ? DB::column('SELECT code FROM permissions ORDER BY sort_order, code')
            : DB::column(
                'SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
                 WHERE rp.role_id = :rid ORDER BY p.sort_order, p.code',
                ['rid' => $user['role_id']]
            );
        return self::$permissions;
    }

    /** True if the user has ANY of the given permission codes. */
    public static function can(string|array $perms): bool
    {
        if (self::user() === null) {
            return false;
        }
        if (self::isAdmin()) {
            return true;
        }
        $mine = self::permissions();
        foreach ((array) $perms as $perm) {
            if (in_array($perm, $mine, true)) {
                return true;
            }
        }
        return false;
    }

    public static function requirePermission(string|array $perms): void
    {
        if (!self::can($perms)) {
            throw HttpException::forbidden();
        }
    }

    public static function attempt(string $username, string $password): array
    {
        $ip = Request::ip();
        $window = max(1, (int) Config::get('security.lockout_minutes', 15));
        $since = date('Y-m-d H:i:s', time() - $window * 60);

        // Failures since the last success (within the window) for this username.
        $lastSuccess = DB::value(
            'SELECT MAX(attempted_at) FROM login_attempts WHERE username = :u AND success = 1 AND attempted_at >= :s',
            ['u' => $username, 's' => $since]
        );
        $userFailures = (int) DB::value(
            'SELECT COUNT(*) FROM login_attempts WHERE username = :u AND success = 0 AND attempted_at >= :s',
            ['u' => $username, 's' => $lastSuccess ?? $since]
        );
        $ipFailures = (int) DB::value(
            'SELECT COUNT(*) FROM login_attempts WHERE ip = :ip AND success = 0 AND attempted_at >= :s',
            ['ip' => $ip, 's' => $since]
        );
        if ($userFailures >= (int) Config::get('security.max_login_attempts', 5)
            || $ipFailures >= (int) Config::get('security.max_ip_attempts', 25)) {
            throw new HttpException(429, Lang::t('auth.locked', ['minutes' => $window]), [], 'locked');
        }

        $user = DB::one(
            'SELECT id, username, full_name, password_hash, is_active, lang FROM users
             WHERE username = :u AND deleted_at IS NULL',
            ['u' => $username]
        );

        // Always run password_verify so response time does not reveal whether the username exists.
        $hash = $user['password_hash'] ?? '$2y$10$ynpTZByK9.Ng.cEQFyadT.EafBj8hinFWz8m3PtQiqSsyFapMF1Gu';
        $valid = password_verify($password, $hash) && $user !== null;

        DB::insert('login_attempts', [
            'username'     => mb_substr($username, 0, 50),
            'ip'           => $ip,
            'success'      => $valid ? 1 : 0,
            'attempted_at' => DB::now(),
        ]);

        if (!$valid) {
            Audit::log('login_failed', 'users', $user !== null ? (int) $user['id'] : null, null, ['username' => $username], $username, ['id' => null, 'username' => null]);
            throw new HttpException(401, Lang::t('auth.invalid'), [], 'invalid_credentials');
        }
        if (!(int) $user['is_active']) {
            throw new HttpException(403, Lang::t('auth.inactive'), [], 'inactive');
        }

        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $user['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
            DB::update('users', ['password_hash' => $user['password_hash']], (int) $user['id']);
        }

        self::loginAs((int) $user['id'], $user['password_hash']);
        DB::update('users', ['last_login_at' => DB::now(), 'last_login_ip' => $ip], (int) $user['id']);
        Audit::log('login', 'users', (int) $user['id'], null, null, $user['username']);
        return self::user() ?? [];
    }

    /** Starts an authenticated session for the given user (new session id + CSRF token). */
    public static function loginAs(int $userId, string $passwordHash): void
    {
        Session::regenerate();
        $_SESSION['uid'] = $userId;
        $_SESSION['pwd_sig'] = self::passwordSignature($passwordHash);
        unset($_SESSION['_expired']);
        Csrf::rotate();
        self::$loaded = false;
        self::$user = null;
        self::$permissions = null;
    }

    /** Called after the current user changes their own password, keeping this session valid. */
    public static function refreshPasswordSignature(string $passwordHash): void
    {
        $_SESSION['pwd_sig'] = self::passwordSignature($passwordHash);
        Session::regenerate();
    }

    public static function logout(): void
    {
        if (self::user() !== null) {
            Audit::log('logout', 'users', self::id(), null, null, self::user()['username']);
        }
        Session::destroy();
        self::$loaded = true;
        self::$user = null;
        self::$permissions = null;
    }

    private static function passwordSignature(string $hash): string
    {
        return hash('sha256', $hash);
    }
}
