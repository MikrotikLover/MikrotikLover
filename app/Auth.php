<?php
declare(strict_types=1);

namespace App;

/**
 * Session authentication, login throttling, idle timeout, CSRF and permission checks.
 */
final class Auth
{
    private static ?array $user = null;
    private static ?array $perms = null;

    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        $https = Http::isHttps();
        session_name((string)Config::get('session.name', 'PAYROLLSESSID'));
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'secure'   => $https,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        ini_set('session.use_strict_mode', '1');
        ini_set('session.gc_maxlifetime', (string)(((int)Config::get('session.timeout_minutes', 30) + 5) * 60));
        session_start();
    }

    public static function timeoutSeconds(): int
    {
        return (int)Config::get('session.timeout_minutes', 30) * 60;
    }

    /** Returns the logged in user (or null), enforcing idle timeout. */
    public static function user(): ?array
    {
        if (self::$user !== null) {
            return self::$user;
        }
        self::startSession();
        $uid = $_SESSION['uid'] ?? null;
        if (!$uid) {
            return null;
        }
        $last = (int)($_SESSION['last_activity'] ?? 0);
        if ($last && time() - $last > self::timeoutSeconds()) {
            self::logout('timeout');
            return null;
        }
        $user = Database::one(
            'SELECT u.id, u.username, u.full_name, u.email, u.role_id, u.is_active, u.must_change_password, u.session_version,
                    r.name AS role_name, r.is_admin
               FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?',
            [$uid]
        );
        if (!$user || !(int)$user['is_active']) {
            self::logout('inactive');
            return null;
        }
        if ((int)($_SESSION['sv'] ?? 0) !== (int)$user['session_version']) { // password changed / reset elsewhere
            self::logout('password_changed');
            return null;
        }
        $_SESSION['last_activity'] = time();
        self::$user = $user;
        return $user;
    }

    public static function id(): ?int
    {
        $u = self::$user ?? (session_status() === PHP_SESSION_ACTIVE && isset($_SESSION['uid']) ? self::user() : null);
        return $u ? (int)$u['id'] : null;
    }

    public static function require(): array
    {
        $u = self::user();
        if (!$u) {
            throw new ApiException('Your session has expired. Please log in again.', 401);
        }
        return $u;
    }

    public static function permissions(): array
    {
        if (self::$perms === null) {
            $u = self::user();
            self::$perms = $u ? Permissions::forRole((int)$u['role_id']) : [];
        }
        return self::$perms;
    }

    public static function can(string $module, string $action): bool
    {
        return in_array($action, self::permissions()[$module] ?? [], true);
    }

    /**
     * End every session of a user after a password change / reset. With $keepCurrent the caller's own
     * session stays valid (own password change).
     */
    public static function bumpSessionVersion(int $userId, bool $keepCurrent = false): void
    {
        Database::run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [$userId]);
        if ($keepCurrent && session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION['sv'] = (int)Database::value('SELECT session_version FROM users WHERE id = ?', [$userId]);
            session_regenerate_id(true);
            self::$user = null;
        }
    }

    public static function isAdmin(): bool
    {
        $u = self::user();
        return $u !== null && (int)($u['is_admin'] ?? 0) === 1;
    }

    /** True when every permission in $perms is one the current user holds (no privilege escalation). */
    public static function holdsAll(array $perms): bool
    {
        if (self::isAdmin()) {
            return true;
        }
        foreach ($perms as $module => $actions) {
            foreach ((array)$actions as $a) {
                if (!self::can((string)$module, (string)$a)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Non-admins may only manage users / roles at or below their own level: never an admin role, never
     * their own role, and never a role with permissions they do not hold themselves.
     */
    public static function assertCanGrantRole(int $roleId): void
    {
        if (self::isAdmin()) {
            return;
        }
        $role = Database::one('SELECT id, is_admin FROM roles WHERE id = ?', [$roleId]);
        if (!$role || (int)$role['is_admin'] === 1 || (int)$role['id'] === (int)(self::user()['role_id'] ?? 0)
            || !self::holdsAll(Permissions::forRole((int)$role['id']))) {
            throw ApiException::forbidden('Only an administrator can assign or change this role.');
        }
    }

    public static function authorize(string $module, string $action): void
    {
        self::require();
        if (!self::can($module, $action)) {
            throw ApiException::forbidden();
        }
    }

    public static function csrfToken(): string
    {
        self::startSession();
        if (empty($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['csrf'];
    }

    public static function verifyCsrf(): void
    {
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['_csrf'] ?? '');
        if (!is_string($sent) || !hash_equals(self::csrfToken(), $sent)) {
            throw new ApiException('Security token mismatch. Please reload the page.', 419);
        }
    }

    public static function attempt(string $username, string $password): array
    {
        $username = trim($username);
        $ip = Request::ip();
        $max = (int)Config::get('security.login_max_attempts', 5);
        $window = (int)Config::get('security.login_window_min', 15);

        // Record the attempt first (as failed) so parallel bursts are counted, then check three limits:
        //   user + IP (since its last success) · one IP across all usernames (spraying) · one username across all IPs.
        $attemptId = Database::insert('login_attempts', ['username' => mb_substr($username, 0, 50), 'ip_address' => $ip, 'success' => 0]);
        $since = ['w' => $window];
        $pair = (int)Database::value(
            'SELECT COUNT(*) FROM login_attempts
              WHERE username = :u AND ip_address = :ip AND success = 0
                AND attempted_at > NOW() - INTERVAL :w MINUTE
                AND id > COALESCE((SELECT MAX(id) FROM login_attempts
                     WHERE username = :u2 AND ip_address = :ip2 AND success = 1), 0)',
            ['u' => $username, 'ip' => $ip, 'u2' => $username, 'ip2' => $ip] + $since
        );
        $perIp = (int)Database::value('SELECT COUNT(*) FROM login_attempts WHERE ip_address = :ip AND success = 0 AND attempted_at > NOW() - INTERVAL :w MINUTE',
            ['ip' => $ip] + $since);
        $perUser = (int)Database::value('SELECT COUNT(*) FROM login_attempts WHERE username = :u AND success = 0 AND attempted_at > NOW() - INTERVAL :w MINUTE',
            ['u' => $username] + $since);
        if ($pair > $max || $perIp > $max * 4 || $perUser > $max * 3) {
            throw new ApiException("Too many failed attempts. Try again in $window minutes.", 429);
        }

        $user = Database::one('SELECT id, password_hash, is_active, session_version FROM users WHERE username = ?', [$username]);
        $ok = $user && password_verify($password, $user['password_hash']);
        if ($ok) {
            Database::run('UPDATE login_attempts SET success = 1 WHERE id = ?', [$attemptId]);
        }

        if (!$ok) {
            // Same message for unknown user and wrong password.
            throw new ApiException('Invalid username or password.', 401);
        }
        if (!(int)$user['is_active']) {
            throw new ApiException('This user account is disabled.', 403);
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            Database::update('users', ['password_hash' => password_hash($password, PASSWORD_DEFAULT)], 'id = :id', ['id' => $user['id']]);
        }

        self::startSession();
        session_regenerate_id(true);
        $_SESSION = ['uid' => (int)$user['id'], 'sv' => (int)$user['session_version'], 'last_activity' => time(), 'csrf' => bin2hex(random_bytes(32))];
        Database::update('users', ['last_login_at' => date('Y-m-d H:i:s'), 'last_login_ip' => $ip], 'id = :id', ['id' => $user['id']]);
        self::$user = null;
        self::$perms = null;
        $u = self::user();
        Audit::log('login', 'users', (int)$user['id']);
        // Housekeeping: drop old attempts.
        Database::run('DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL 30 DAY');
        return $u;
    }

    public static function logout(string $reason = 'logout'): void
    {
        self::startSession();
        if (!empty($_SESSION['uid']) && $reason === 'logout') {
            Audit::log('logout', 'users', (int)$_SESSION['uid'], null, null, (int)$_SESSION['uid']);
        }
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', $p['secure'], $p['httponly']);
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
        self::$user = null;
        self::$perms = null;
    }

    public static function validatePasswordStrength(string $password): ?string
    {
        if (mb_strlen($password) < 8) {
            return 'Password must be at least 8 characters.';
        }
        if (!preg_match('/[A-Za-z]/', $password) || !preg_match('/\d/', $password)) {
            return 'Password must contain letters and numbers.';
        }
        return null;
    }
}
