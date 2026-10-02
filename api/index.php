<?php
/**
 * Single API entry point: api/index.php?r=<route>
 * Every response is JSON with no-cache headers (LiteSpeed safe).
 */
declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

Response::noCache();

try {
    Session::start();
    /** @var Router $router */
    $router = require APP_DIR . '/routes.php';
    $router->dispatch(Request::method(), Request::route());
} catch (HttpException $e) {
    Response::error($e->getMessage(), $e->status, $e->errors, $e->errorCode);
} catch (PDOException $e) {
    Logger::error('DB error: ' . $e->getMessage(), ['route' => Request::route()]);
    // 23000 = integrity constraint (duplicate key / record in use)
    if ($e->getCode() === '23000') {
        Response::error(Lang::t('error.constraint'), 409, [], 'constraint');
    }
    Response::error(Config::get('app.debug') ? $e->getMessage() : Lang::t('error.server'), 500, [], 'server');
} catch (Throwable $e) {
    Logger::error(get_class($e) . ': ' . $e->getMessage(), ['file' => $e->getFile() . ':' . $e->getLine(), 'route' => Request::route()]);
    Response::error(Config::get('app.debug') ? $e->getMessage() : Lang::t('error.server'), 500, [], 'server');
}
