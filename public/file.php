<?php
declare(strict_types=1);

/**
 * Streams files from persistent storage after an auth check.
 *   file.php?t=photo&emp=12   employee photo (requires employees.view)
 *   file.php?t=logo           company logo (any logged-in user)
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\Auth;
use App\Database;
use App\Settings;
use App\Storage;

Auth::startSession();
$user = Auth::user();
if (!$user) {
    http_response_code(401);
    exit;
}

$type = $_GET['t'] ?? '';
$path = null;
if ($type === 'photo' && Auth::can('employees', 'view')) {
    $name = Database::value('SELECT photo_file FROM employees WHERE id = ?', [(int)($_GET['emp'] ?? 0)]);
    $path = Storage::file('photos', $name ? (string)$name : null);
} elseif ($type === 'logo') {
    $logo = Settings::get('company_logo');
    $path = Storage::file('logos', is_string($logo) ? $logo : null);
}

if (!$path) {
    http_response_code(404);
    exit;
}

$mime = match (strtolower(pathinfo($path, PATHINFO_EXTENSION))) {
    'png'  => 'image/png',
    'gif'  => 'image/gif',
    'webp' => 'image/webp',
    default => 'image/jpeg',
};
// File names are random per upload (cache-busted with ?v=), so private caching is safe.
header('Content-Type: ' . $mime);
header('Content-Length: ' . filesize($path));
header('Cache-Control: private, max-age=86400');
header('X-LiteSpeed-Cache-Control: no-cache');
header('X-Content-Type-Options: nosniff');
readfile($path);
