<?php
declare(strict_types=1);

/**
 * JSON API route table and dispatcher. Reached through public/api.php (/api/* is rewritten there).
 * [METHOD, pattern, [Controller, method], permission]  permission: null = public, 'auth' = logged in.
 * Every non-GET request must carry the X-CSRF-Token header.
 */

use Prod\ApiException;
use Prod\Auth;
use Prod\Config;
use Prod\Http;
use Prod\Request;
use Prod\Controllers\AdminController as Admin;
use Prod\Controllers\AuthController as AuthC;
use Prod\Controllers\EntryController as Entry;
use Prod\Controllers\ImportController as Import;
use Prod\Controllers\MasterController as Master;
use Prod\Controllers\ReportController as Report;

const PROD_ROUTES = [
    ['GET',    '/auth/me',                    [AuthC::class, 'me'],             null],
    ['POST',   '/auth/login',                 [AuthC::class, 'login'],          null],
    ['POST',   '/auth/logout',                [AuthC::class, 'logout'],         null],
    ['POST',   '/auth/password',              [AuthC::class, 'password'],       'auth'],

    ['GET',    '/lookups',                    [Master::class, 'lookups'],       'view'],
    ['GET',    '/dashboard',                  [Report::class, 'dashboard'],     'view'],
    ['GET',    '/reports/summary',            [Report::class, 'summary'],       'view'],
    ['GET',    '/reports/summary.csv',        [Report::class, 'summaryCsv'],    'view'],
    ['GET',    '/reports/checks',             [Report::class, 'checks'],        'view'],

    ['GET',    '/entries',                    [Entry::class, 'index'],          'view'],
    ['GET',    '/entries.csv',                [Entry::class, 'csv'],            'view'],
    ['GET',    '/entries/last',               [Entry::class, 'last'],           'entries.add'],
    ['POST',   '/entries/bulk-delete',        [Entry::class, 'bulkDelete'],     'import'],
    ['GET',    '/entries/{id}',               [Entry::class, 'show'],           'view'],
    ['POST',   '/entries',                    [Entry::class, 'store'],          'entries.add'],
    ['PUT',    '/entries/{id}',               [Entry::class, 'update'],         'entries.edit'],
    ['DELETE', '/entries/{id}',               [Entry::class, 'destroy'],        'entries.delete'],

    ['POST',   '/import/upload',              [Import::class, 'upload'],        'import'],
    ['POST',   '/import/preview',             [Import::class, 'preview'],       'import'],
    ['POST',   '/import/commit',              [Import::class, 'commit'],        'import'],
    ['GET',    '/import/batches',             [Import::class, 'batches'],       'view'],

    ['GET',    '/machines',                   [Master::class, 'machines'],      'view'],
    ['POST',   '/machines',                   [Master::class, 'machineStore'],  'masters.edit'],
    ['PUT',    '/machines/{id}',              [Master::class, 'machineUpdate'], 'masters.edit'],
    ['POST',   '/machines/{id}/merge',        [Master::class, 'machineMerge'],  'masters.edit'],
    ['DELETE', '/machines/{id}',              [Master::class, 'machineDestroy'],'masters.edit'],
    ['POST',   '/machines/{id}/rates',        [Master::class, 'rateStore'],     'rates.edit'],
    ['DELETE', '/machines/{id}/rates/{rid}',  [Master::class, 'rateDestroy'],   'rates.edit'],
    ['POST',   '/machines/{id}/inks',         [Master::class, 'inkStore'],      'rates.edit'],
    ['DELETE', '/machines/{id}/inks/{iid}',   [Master::class, 'inkDestroy'],    'rates.edit'],

    ['GET',    '/ink-companies',              [Master::class, 'inkCompanies'],      'view'],
    ['POST',   '/ink-companies',              [Master::class, 'inkCompanyStore'],   'rates.edit'],
    ['PUT',    '/ink-companies/{id}',         [Master::class, 'inkCompanyUpdate'],  'rates.edit'],
    ['DELETE', '/ink-companies/{id}',         [Master::class, 'inkCompanyDestroy'], 'rates.edit'],
    ['POST',   '/ink-companies/{id}/rates',   [Master::class, 'inkRateStore'],      'rates.edit'],
    ['DELETE', '/ink-companies/{id}/rates/{rid}', [Master::class, 'inkRateDestroy'], 'rates.edit'],

    ['GET',    '/masters/{kind}',             [Master::class, 'index'],         'view'],
    ['POST',   '/masters/{kind}',             [Master::class, 'store'],         'masters.edit'],
    ['PUT',    '/master/{id}',                [Master::class, 'update'],        'masters.edit'],
    ['POST',   '/master/{id}/merge',          [Master::class, 'merge'],         'masters.edit'],
    ['DELETE', '/master/{id}',                [Master::class, 'destroy'],       'masters.edit'],

    ['GET',    '/users',                      [Admin::class, 'users'],          'users'],
    ['POST',   '/users',                      [Admin::class, 'userStore'],      'users'],
    ['PUT',    '/users/{id}',                 [Admin::class, 'userUpdate'],     'users'],
    ['GET',    '/settings',                   [Admin::class, 'settings'],       'view'],
    ['PUT',    '/settings',                   [Admin::class, 'saveSettings'],   'settings'],
    ['GET',    '/audit',                      [Admin::class, 'audit'],          'audit'],
];

/** Finds the route for a request. @return array{0:array,1:?string,2:array} handler, permission, params */
function prod_match(string $method, string $path): array
{
    $methodMismatch = false;
    foreach (PROD_ROUTES as [$rm, $pattern, $handler, $perm]) {
        $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', str_replace('.', '\.', $pattern)) . '$#';
        if (!preg_match($regex, $path, $m)) {
            continue;
        }
        if ($rm !== $method) {
            $methodMismatch = true;
            continue;
        }
        return [$handler, $perm, array_filter($m, 'is_string', ARRAY_FILTER_USE_KEY)];
    }
    throw new ApiException($methodMismatch ? 'Method not allowed.' : 'Endpoint not found.', $methodMismatch ? 405 : 404);
}

function prod_dispatch(): never
{
    Http::securityHeaders();
    try {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        if (preg_match('#/api(?:\.php)?(/.*)?$#', $uri, $m)) {
            $uri = $m[1] ?? '/';
        }
        $request = new Request($uri);
        [[$class, $action], $perm, $params] = prod_match($request->method, $request->path);
        $request->params = $params;

        Auth::startSession();
        if ($request->method !== 'GET') {
            Auth::verifyCsrf();
        }
        if ($perm === 'auth') {
            Auth::require();
        } elseif ($perm !== null) {
            Auth::authorize($perm);
        }
        // Reads do not need the session lock; release it so parallel requests are not serialised.
        if ($request->method === 'GET') {
            session_write_close();
        }
        Http::ok((new $class())->$action($request));
    } catch (ApiException $e) {
        Http::error($e->getMessage(), $e->status(), $e->errors());
    } catch (PDOException $e) {
        error_log('[api] ' . $e->getMessage());
        $code = $e->errorInfo[1] ?? 0;
        if ($code === 1062) {
            Http::error('A record with the same value already exists.', 409);
        }
        if ($code === 1451) {
            Http::error('This record is in use and cannot be deleted.', 409);
        }
        Http::error(Config::get('debug') ? $e->getMessage() : 'Database error. The problem has been logged.', 500);
    } catch (Throwable $e) {
        error_log('[api] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
        Http::error(Config::get('debug') ? $e->getMessage() : 'Unexpected server error. The problem has been logged.', 500);
    }
}
