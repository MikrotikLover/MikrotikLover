<?php
declare(strict_types=1);

/**
 * Database backup download (.sql.gz), for administrators (settings.edit). Pure PHP, no exec().
 *   backup.php            gzip-compressed SQL
 * Restore: hPanel → Databases → phpMyAdmin → Import, or `gunzip -c file.sql.gz | mysql dbname`.
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\Audit;
use App\Auth;
use App\Backup;
use App\Http;

Http::noStore();
Http::securityHeaders();
Auth::startSession();
if (!Auth::user()) {
    header('Location: ./#/login');
    exit;
}
if (!Auth::can('settings', 'edit')) {
    http_response_code(403);
    exit('Only administrators can download backups.');
}

@set_time_limit(300);
while (ob_get_level()) {
    ob_end_clean();
}
Audit::log('backup', 'database', null, null, ['format' => 'sql.gz']);
session_write_close(); // do not block the user's other requests while streaming

$name = 'payroll-backup-' . date('Y-m-d_His') . '.sql.gz';
header('Content-Type: application/gzip');
header('Content-Disposition: attachment; filename="' . $name . '"');
header('X-Content-Type-Options: nosniff');

$z = deflate_init(ZLIB_ENCODING_GZIP, ['level' => 6]);
Backup::dump(function (string $sql) use ($z) {
    echo deflate_add($z, $sql, ZLIB_NO_FLUSH);
});
echo deflate_add($z, '', ZLIB_FINISH);
