<?php
// Local development router for PHP's built-in server (mimics public/.htaccess):
//   php -S localhost:8080 -t public tools/devserver.php
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (preg_match('#^/api(/|$)#', $path)) {
    require __DIR__ . '/../public/api.php';
    return true;
}
return false; // serve static files / php files from public/
