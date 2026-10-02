<?php
declare(strict_types=1);

/** GET health — deployment check (DB reachable, private folders writable). */
final class HealthController
{
    public function index(): array
    {
        $dbOk = false;
        $dbTime = null;
        try {
            $dbTime = DB::value('SELECT NOW()');
            $dbOk = true;
        } catch (Throwable) {
        }
        $writable = [];
        foreach (['uploads', 'logs', 'sessions'] as $dir) {
            $path = Config::path($dir);
            $writable[$dir] = $path !== null && is_writable($path);
        }
        return [
            'ok'          => $dbOk && !in_array(false, $writable, true),
            'db'          => $dbOk,
            'db_time'     => $dbTime,
            'php_time'    => date('Y-m-d H:i:s'),
            'php_version' => Auth::isAdmin() ? PHP_VERSION : null,
            'config_file' => Config::get('config_file') !== null,
            'writable'    => $writable,
            'version'     => APP_VERSION,
        ];
    }
}
