<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Auth;
use App\Config;
use App\Database;
use App\Request;
use App\Storage;

/**
 * System health: everything a deployment needs, checked from the browser (no SSH on shared hosting).
 * Each check: {name, status: ok|warn|fail, detail}.
 */
final class SystemController
{
    public function status(Request $r): array
    {
        if (!Auth::isAdmin()) {
            throw ApiException::forbidden('System Health is for administrators.');
        }
        $checks = [];
        $add = function (string $name, string $status, string $detail) use (&$checks) {
            $checks[] = compact('name', 'status', 'detail');
        };

        $add('PHP version', version_compare(PHP_VERSION, '8.2.0', '>=') ? 'ok' : 'fail', PHP_VERSION . ' (8.2 or newer required, 8.5 recommended)');
        foreach (['pdo_mysql' => 'database', 'mbstring' => 'Urdu text', 'gd' => 'photos and logo', 'zip' => 'Excel (.xlsx) import',
                     'simplexml' => 'Excel (.xlsx) import', 'fileinfo' => 'upload type checks', 'json' => 'API'] as $ext => $why) {
            $add("Extension $ext", extension_loaded($ext) ? 'ok' : ($ext === 'pdo_mysql' || $ext === 'json' ? 'fail' : 'warn'),
                extension_loaded($ext) ? 'loaded' : "missing — needed for $why");
        }

        $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        $add('HTTPS', $https ? 'ok' : 'warn', $https ? 'secure connection' : 'not HTTPS — enable the free SSL certificate and force HTTPS (devices may still push over HTTP)');
        $add('Debug mode', Config::get('debug') ? 'fail' : 'ok', Config::get('debug') ? 'debug is ON — set \'debug\' => false in config.php' : 'off');
        $add('Browser setup key', (string)Config::get('security.setup_key', '') !== '' ? 'warn' : 'ok',
            (string)Config::get('security.setup_key', '') !== '' ? 'security.setup_key is set — clear it once migrations are done' : 'not set (CLI / admin only)');

        // storage
        $root = Storage::root();
        $public = realpath(APP_ROOT . '/public') ?: APP_ROOT . '/public';
        $real = realpath($root) ?: $root;
        $writable = is_dir($root) && is_writable($root);
        $add('Storage folder writable', $writable ? 'ok' : 'fail', $root);
        $add('Storage outside web root', str_starts_with($real, $public) ? 'fail' : 'ok',
            str_starts_with($real, $public) ? 'storage is inside /public — uploads could be downloaded directly' : 'not web-accessible');
        $inDeploy = str_starts_with($real, realpath(APP_ROOT) ?: APP_ROOT);
        $add('Storage survives redeploy', $inDeploy ? 'warn' : 'ok',
            $inDeploy ? 'storage is inside the deploy folder — Git deploy may wipe photos; set storage_path to a folder outside it' : 'outside the deploy folder');

        // database
        $ver = (string)Database::value('SELECT VERSION()');
        $add('Database server', 'ok', $ver);
        $dbNow = (string)Database::value('SELECT NOW()');
        $drift = abs(strtotime($dbNow) - time());
        $add('Time zone (Asia/Karachi)', $drift <= 120 ? 'ok' : 'fail', 'PHP ' . date('Y-m-d H:i') . ' · DB ' . substr($dbNow, 0, 16));
        require_once APP_ROOT . '/migrations/migrate.php';
        $pending = (new \Migrator(false))->pending();
        $add('Database migrations', $pending ? 'fail' : 'ok', $pending ? 'pending: ' . implode(', ', $pending) : 'up to date');
        $defaultAdmin = Database::one("SELECT must_change_password FROM users WHERE username = 'admin'");
        if ($defaultAdmin && (int)$defaultAdmin['must_change_password']) {
            $add('Default admin password', 'warn', 'the admin account still has the initial password');
        }
        $limits = ['upload_max_filesize' => ini_get('upload_max_filesize'), 'post_max_size' => ini_get('post_max_size'),
                   'memory_limit' => ini_get('memory_limit'), 'max_execution_time' => ini_get('max_execution_time')];
        $bytes = function (string $v): int {
            $n = (int)$v;
            return match (strtolower(substr(trim($v), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
        };
        $photoMax = (int)Config::get('uploads.photo_max_bytes', 3 * 1024 * 1024);
        $uploadMax = min($bytes((string)$limits['upload_max_filesize']), $bytes((string)$limits['post_max_size']));
        $add('PHP limits', $uploadMax < $photoMax ? 'warn' : 'ok',
            ($uploadMax < $photoMax ? 'upload limit is below the ' . round($photoMax / 1048576, 1) . ' MB photo size (raise upload_max_filesize in hPanel → PHP Configuration) · ' : '') . implode(' · ', array_map(fn($k, $v) => "$k $v", array_keys($limits), $limits)));

        $sizes = Database::all(
            "SELECT table_name AS name, table_rows AS rows_approx, ROUND((data_length + index_length) / 1048576, 2) AS mb
               FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY (data_length + index_length) DESC LIMIT 12"
        );
        $worst = in_array('fail', array_column($checks, 'status'), true) ? 'fail' : (in_array('warn', array_column($checks, 'status'), true) ? 'warn' : 'ok');
        return ['overall' => $worst, 'checks' => $checks, 'tables' => $sizes, 'server_time' => date('Y-m-d H:i:s'),
                'app_version' => (string)Config::get('app_version', '')];
    }
}
