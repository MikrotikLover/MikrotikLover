<?php
declare(strict_types=1);

final class Session
{
    public static function start(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        // Keep sessions in the private folder so other sites on the shared
        // host cannot garbage-collect them (falls back to PHP default).
        $dir = Config::path('sessions');
        if ($dir !== null && is_writable($dir)) {
            session_save_path($dir);
        }
        $idle = max(5, (int) Config::get('app.session_idle_minutes', 120));

        ini_set('session.use_strict_mode', '1');
        ini_set('session.use_only_cookies', '1');
        ini_set('session.gc_maxlifetime', (string) ($idle * 60));
        session_name('FPMSSID');
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => self::cookiePath(),
            'secure'   => Request::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();

        $now = time();
        $last = (int) ($_SESSION['_last_seen'] ?? $now);
        if (isset($_SESSION['uid']) && $now - $last > $idle * 60) {
            $_SESSION = [];
            session_regenerate_id(true);
            $_SESSION['_expired'] = true;
        }
        $_SESSION['_last_seen'] = $now;
    }

    public static function regenerate(): void
    {
        session_regenerate_id(true);
    }

    public static function destroy(): void
    {
        $_SESSION = [];
        if (session_status() === PHP_SESSION_ACTIVE) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires'  => time() - 3600,
                'path'     => $p['path'],
                'secure'   => $p['secure'],
                'httponly' => $p['httponly'],
                'samesite' => $p['samesite'] ?: 'Lax',
            ]);
            session_destroy();
        }
    }

    /** Cookie scoped to the app folder (…/api/index.php → …/). */
    private static function cookiePath(): string
    {
        $script = str_replace('\\', '/', (string) ($_SERVER['SCRIPT_NAME'] ?? '/'));
        $base = rtrim(dirname($script, 2), '/');
        return $base === '' ? '/' : $base . '/';
    }
}
