<?php
declare(strict_types=1);

// JSON API entry (/api/* is rewritten here by .htaccess; /api.php/... also works).
require dirname(__DIR__) . '/src/bootstrap.php';
require PROD_ROOT . '/src/routes.php';
prod_dispatch();
