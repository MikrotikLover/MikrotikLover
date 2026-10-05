<?php
declare(strict_types=1);

namespace Prod;

/**
 * Session authentication, login throttling, idle timeout, CSRF and role permissions.
 *
 * Roles (fixed):  admin    everything, including users, settings and the audit log
 *                 manager  entries, import, masters, machine ink rates, data check
 *                 entry    add and edit production entries
 *                 viewer   dashboard, entries list and reports (read only)
 */
final class Auth
{
    public const ROLES = ['admin', 'manager', 'entry', 'viewer'];

    private const PERMS = [
        'view'          => ['admin', 'manager', 'entry', 'viewer'],
        'entries.add'   => ['admin', 'manager', 'entry'],
        'entries.edit'  => ['admin', 'manager', 'entry'],
        'entries.delete'=> ['admin', 'manager'],
        'import'        => ['admin', 'manager'],
        'masters.edit'  => ['admin', 'manager'],
        'rates.edit'    => ['admin', 'manager'],
        'users'         => ['admin'],
        'settings'      => ['admin'],
        'audit'         => ['admin'],
    ];

    private static ?array $user = null;

    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        session_name((string)Config::get('session.name', 'PRODSESSID'));
        session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => Http::isHttps(), 'httponly' => true, 'samesite' => 'Lax']);
        ini_set('session.use_strict_mode', '1');
        ini_set('session.gc_maxlifetime', (string)((self::timeoutMinutes() + 5) * 60));
        session_start();
    }

    public static function timeoutMinutes(): int
    {
        return (int)Config::get('session.timeout_minutes', 60);
    }

    /** Logged in user (or null), enforcing the idle timeout and session version. */
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
        if ($last && time() - $last > self::timeoutMinutes() * 60) {
            self::logout();
            return null;
        }
        $user = Database::one('SELECT id, username, full_name, role, is_active, must_change_password, session_version FROM users WHERE id = ?', [$uid]);
        if (!$user || !(int)$user['is_active'] || (int)($_SESSION['sv'] ?? -1) !== (int)$user['session_version']) {
            self::logout();
            return null;
        }
        $_SESSION['last_activity'] = time();
        return self::$user = $user;
    }

    /** Test hook: act as this user without a session. */
    public static function actAs(?array $user): void
    {
        self::$user = $user;
    }

    public static function id(): ?int
    {
        return self::$user ? (int)self::$user['id'] : null;
    }

    public static function require(): array
    {
        $u = self::user();
        if (!$u) {
            throw new ApiException('Your session has expired. Please log in again.', 401);
        }
        return $u;
    }

    public static function can(string $perm): bool
    {
        $u = self::user();
        return $u !== null && in_array($u['role'], self::PERMS[$perm] ?? [], true);
    }

    /** @return string[] permissions held by the current user (sent to the client to show/hide UI) */
    public static function permissions(): array
    {
        return array_values(array_filter(array_keys(self::PERMS), fn($p) => self::can($p)));
    }

    public static function authorize(string $perm): void
    {
        self::require();
        if (!self::can($perm)) {
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
        $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
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

        // Record first (as failed) so parallel bursts are counted, then check user+IP and per-IP limits.
        $attemptId = Database::insert('login_attempts', ['username' => mb_substr($username, 0, 50), 'ip_address' => $ip, 'success' => 0]);
        $pair = (int)Database::value(
            'SELECT COUNT(*) FROM login_attempts WHERE username = :u AND ip_address = :ip AND success = 0
                AND attempted_at > NOW() - INTERVAL :w MINUTE
                AND id > COALESCE((SELECT MAX(id) FROM login_attempts WHERE username = :u2 AND ip_address = :ip2 AND success = 1), 0)',
            ['u' => $username, 'ip' => $ip, 'u2' => $username, 'ip2' => $ip, 'w' => $window]
        );
        $perIp = (int)Database::value('SELECT COUNT(*) FROM login_attempts WHERE ip_address = :ip AND success = 0 AND attempted_at > NOW() - INTERVAL :w MINUTE',
            ['ip' => $ip, 'w' => $window]);
        if ($pair > $max || $perIp > $max * 4) {
            throw new ApiException("Too many failed attempts. Try again in $window minutes.", 429);
        }

        $user = Database::one('SELECT id, password_hash, is_active, session_version FROM users WHERE username = ?', [$username]);
        if (!$user || !password_verify($password, $user['password_hash'])) {
            throw new ApiException('Invalid username or password.', 401);
        }
        Database::run('UPDATE login_attempts SET success = 1 WHERE id = ?', [$attemptId]);
        if (!(int)$user['is_active']) {
            throw new ApiException('This user account is disabled.', 403);
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            Database::update('users', ['password_hash' => password_hash($password, PASSWORD_DEFAULT)], 'id = :id', ['id' => $user['id']]);
        }

        self::startSession();
        session_regenerate_id(true);
        $_SESSION = ['uid' => (int)$user['id'], 'sv' => (int)$user['session_version'], 'last_activity' => time(), 'csrf' => bin2hex(random_bytes(32))];
        Database::update('users', ['last_login_at' => date('Y-m-d H:i:s')], 'id = :id', ['id' => $user['id']]);
        self::$user = null;
        $u = self::user();
        Audit::log('login', 'users', (int)$user['id']);
        Database::run('DELETE FROM login_attempts WHERE attempted_at < NOW() - INTERVAL 30 DAY');
        return $u;
    }

    public static function logout(): void
    {
        self::startSession();
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', $p['secure'], $p['httponly']);
        }
        session_destroy();
        self::$user = null;
    }

    /** Ends every session of a user (password change/reset). With $keepCurrent the caller stays logged in. */
    public static function bumpSessionVersion(int $userId, bool $keepCurrent = false): void
    {
        Database::run('UPDATE users SET session_version = session_version + 1 WHERE id = ?', [$userId]);
        if ($keepCurrent && session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION['sv'] = (int)Database::value('SELECT session_version FROM users WHERE id = ?', [$userId]);
            session_regenerate_id(true);
        }
        self::$user = null;
    }

    public static function passwordProblem(string $password): ?string
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
