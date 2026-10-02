<?php
declare(strict_types=1);

/**
 * API route table. Later batches append their routes here.
 * Options: auth (default true), perm, csrf (default non-GET), pwd_ok.
 */
$r = new Router();

// --- Public -------------------------------------------------------------
$r->get('health', [HealthController::class, 'index'], ['auth' => false]);
$r->get('auth/bootstrap', [AuthController::class, 'bootstrap'], ['auth' => false]);
$r->post('auth/login', [AuthController::class, 'login'], ['auth' => false]);
$r->post('setup/admin', [SetupController::class, 'createAdmin'], ['auth' => false]);

// --- Session ------------------------------------------------------------
$r->post('auth/logout', [AuthController::class, 'logout'], ['auth' => false]);
$r->get('auth/me', [AuthController::class, 'me'], ['pwd_ok' => true]);
$r->post('auth/password', [AuthController::class, 'changePassword'], ['pwd_ok' => true]);
$r->post('auth/lang', [AuthController::class, 'setLang'], ['pwd_ok' => true]);

// --- Users & roles ------------------------------------------------------
$r->get('users', [UserController::class, 'index'], ['perm' => 'users.view']);
$r->post('users', [UserController::class, 'store'], ['perm' => 'users.manage']);
$r->get('users/{id}', [UserController::class, 'show'], ['perm' => 'users.view']);
$r->put('users/{id}', [UserController::class, 'update'], ['perm' => 'users.manage']);
$r->delete('users/{id}', [UserController::class, 'destroy'], ['perm' => 'users.manage']);
$r->post('users/{id}/password', [UserController::class, 'resetPassword'], ['perm' => 'users.manage']);

$r->get('roles', [RoleController::class, 'index'], ['perm' => ['users.view', 'roles.manage']]);
$r->get('roles/matrix', [RoleController::class, 'matrix'], ['perm' => 'roles.manage']);
$r->put('roles/{id}/permissions', [RoleController::class, 'updatePermissions'], ['perm' => 'roles.manage']);

// --- Audit --------------------------------------------------------------
$r->get('audit', [AuditController::class, 'index'], ['perm' => 'audit.view']);

return $r;
