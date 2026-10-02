<?php
declare(strict_types=1);

// JSON API entry (/api/* is rewritten here by .htaccess; /api.php/... also works).
require dirname(__DIR__) . '/app/bootstrap.php';
require APP_ROOT . '/api/router.php';
