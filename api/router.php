<?php
declare(strict_types=1);

/**
 * JSON API front controller. Reached through public/api.php (rewritten from /api/*).
 *
 * Route table: [METHOD, pattern, [Controller, method], permission|null|'auth']
 *   permission 'module.action' -> authorize; 'auth' -> logged in only; null -> public.
 * All non-GET requests require the X-CSRF-Token header.
 */

use App\ApiException;
use App\Auth;
use App\Http;
use App\Request;
use App\Controllers\AuthController;
use App\Controllers\DashboardController;
use App\Controllers\DepartmentController;
use App\Controllers\DesignationController;
use App\Controllers\EmployeeController;
use App\Controllers\HolidayController;
use App\Controllers\LookupController;
use App\Controllers\RoleController;
use App\Controllers\SettingsController;
use App\Controllers\ShiftController;
use App\Controllers\ShiftGroupController;
use App\Controllers\UserController;

/** Standard CRUD routes for a master table. */
function resource(string $base, string $controller, string $module): array
{
    return [
        ['GET',    $base,           [$controller, 'index'],   "$module.view"],
        ['GET',    "$base/{id}",    [$controller, 'show'],    "$module.view"],
        ['POST',   $base,           [$controller, 'store'],   "$module.add"],
        ['PUT',    "$base/{id}",    [$controller, 'update'],  "$module.edit"],
        ['DELETE', "$base/{id}",    [$controller, 'destroy'], "$module.delete"],
    ];
}

$routes = array_merge(
    [
        ['GET',  '/auth/me',        [AuthController::class, 'me'],       null],
        ['POST', '/auth/login',     [AuthController::class, 'login'],    null],
        ['POST', '/auth/logout',    [AuthController::class, 'logout'],   null],
        ['POST', '/auth/password',  [AuthController::class, 'password'], 'auth'],
        ['GET',  '/auth/ping',      [AuthController::class, 'ping'],     'auth'],

        ['GET',  '/lookups',            [LookupController::class, 'index'],   'auth'],
        ['GET',  '/dashboard/summary',  [DashboardController::class, 'summary'], 'dashboard.view'],

        // Employees (custom routes before the resource so /next-code is not taken as {id})
        ['GET',    '/employees/next-code',              [EmployeeController::class, 'nextCode'],      'employees.view'],
        ['GET',    '/employees/{id}/neighbor',          [EmployeeController::class, 'neighbor'],      'employees.view'],
        ['POST',   '/employees/{id}/photo',             [EmployeeController::class, 'uploadPhoto'],   'employees.edit'],
        ['DELETE', '/employees/{id}/photo',             [EmployeeController::class, 'deletePhoto'],   'employees.edit'],
        ['GET',    '/employees/{id}/salary',            [EmployeeController::class, 'salaryIndex'],   'employees.view'],
        ['POST',   '/employees/{id}/salary',            [EmployeeController::class, 'salaryStore'],   'employees.edit'],
        ['PUT',    '/employees/{id}/salary/{sid}',      [EmployeeController::class, 'salaryUpdate'],  'employees.edit'],
        ['DELETE', '/employees/{id}/salary/{sid}',      [EmployeeController::class, 'salaryDestroy'], 'employees.edit'],

        ['GET',    '/settings/company',  [SettingsController::class, 'company'],       'auth'],
        ['PUT',    '/settings/company',  [SettingsController::class, 'saveCompany'],   'settings.edit'],
        ['POST',   '/settings/logo',     [SettingsController::class, 'uploadLogo'],    'settings.edit'],
        ['DELETE', '/settings/logo',     [SettingsController::class, 'deleteLogo'],    'settings.edit'],
        ['PUT',    '/settings/rest-days', [SettingsController::class, 'restDays'],     'holidays.edit'],

        ['GET',    '/roles/modules',     [RoleController::class, 'modules'],           'users.view'],
    ],
    resource('/employees',    EmployeeController::class,    'employees'),
    resource('/departments',  DepartmentController::class,  'departments'),
    resource('/designations', DesignationController::class, 'designations'),
    resource('/shifts',       ShiftController::class,       'shifts'),
    resource('/shift-groups', ShiftGroupController::class,  'shift_groups'),
    resource('/holidays',     HolidayController::class,     'holidays'),
    resource('/users',        UserController::class,        'users'),
    resource('/roles',        RoleController::class,        'users'),
);

// ---------------------------------------------------------------------------

Http::securityHeaders();

try {
    // Path after ".../api" (works with rewrite /api/x and with /api.php/x)
    $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    if (preg_match('#/api(?:\.php)?(/.*)?$#', $uri, $m)) {
        $uri = $m[1] ?? '/';
    }
    $request = new Request($uri);
    $method = $request->method;
    if ($method === 'POST' && !empty($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE'])) {
        $override = strtoupper($_SERVER['HTTP_X_HTTP_METHOD_OVERRIDE']);
        if (in_array($override, ['PUT', 'DELETE', 'PATCH'], true)) {
            $method = $override;
        }
    }

    $matched = null;
    $methodMismatch = false;
    foreach ($routes as [$rm, $pattern, $handler, $perm]) {
        $regex = '#^' . preg_replace('#\{(\w+)\}#', '(?P<$1>[^/]+)', $pattern) . '$#';
        if (!preg_match($regex, $request->path, $pm)) {
            continue;
        }
        if ($rm !== $method) {
            $methodMismatch = true;
            continue;
        }
        $request->params = array_filter($pm, 'is_string', ARRAY_FILTER_USE_KEY);
        $matched = [$handler, $perm];
        break;
    }
    if (!$matched) {
        throw new ApiException($methodMismatch ? 'Method not allowed.' : 'Endpoint not found.', $methodMismatch ? 405 : 404);
    }

    Auth::startSession();
    if ($method !== 'GET') {
        Auth::verifyCsrf();
    }
    [[$class, $action], $perm] = $matched;
    if ($perm === 'auth') {
        Auth::require();
    } elseif (is_string($perm)) {
        [$module, $act] = explode('.', $perm, 2);
        Auth::authorize($module, $act);
    }

    $result = (new $class())->$action($request);
    Http::ok($result);
} catch (ApiException $e) {
    Http::error($e->getMessage(), $e->status(), $e->errors());
} catch (PDOException $e) {
    error_log('[api] ' . $e->getMessage());
    $code = $e->errorInfo[1] ?? 0;
    if ($code === 1062) {
        Http::error('A record with the same value already exists.', 409);
    }
    if ($code === 1451) {
        Http::error('This record is in use by other records and cannot be deleted. Mark it inactive instead.', 409);
    }
    Http::error(App\Config::get('debug') ? $e->getMessage() : 'Database error. The problem has been logged.', 500);
} catch (Throwable $e) {
    error_log('[api] ' . $e::class . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    Http::error(App\Config::get('debug') ? $e->getMessage() : 'Unexpected server error. The problem has been logged.', 500);
}
