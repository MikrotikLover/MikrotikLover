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

// --- Master data (Batch 2) ---------------------------------------------
$crud = static function (Router $r, string $path, string $class, string|array $view, string|array $manage): void {
    $r->get($path, [$class, 'index'], ['perm' => $view]);
    $r->post($path, [$class, 'store'], ['perm' => $manage]);
    $r->get("$path/{id}", [$class, 'show'], ['perm' => $view]);
    $r->put("$path/{id}", [$class, 'update'], ['perm' => $manage]);
    $r->delete("$path/{id}", [$class, 'destroy'], ['perm' => $manage]);
};
$crud($r, 'units', UnitController::class, 'units.view', 'units.manage');
$crud($r, 'warehouses', WarehouseController::class, 'warehouses.view', 'warehouses.manage');
$crud($r, 'parties', PartyController::class, 'parties.view', 'parties.manage');
$crud($r, 'machines', MachineController::class, 'machines.view', 'machines.manage');
$crud($r, 'ink-colours', InkColourController::class, 'inks.view', 'inks.manage');
// Items double as the Ink Master (item_type=ink); ink-vs-other rights are checked per record.
$crud($r, 'items', ItemController::class, ['items.view', 'inks.view'], ['items.manage', 'inks.manage']);
$crud($r, 'designs', DesignController::class, 'designs.view', 'designs.manage');
$r->get('designs/{id}/image', [DesignController::class, 'image'], ['perm' => 'designs.view']);
$r->post('designs/{id}/image', [DesignController::class, 'uploadImage'], ['perm' => 'designs.manage']);
$r->delete('designs/{id}/image', [DesignController::class, 'deleteImage'], ['perm' => 'designs.manage']);

$r->get('lookups', [LookupController::class, 'index']);
$r->get('settings', [SettingsController::class, 'index'], ['perm' => 'settings.manage']);
$r->put('settings', [SettingsController::class, 'update'], ['perm' => 'settings.manage']);

// --- Stock vouchers (Batch 3) ------------------------------------------
$voucher = static function (Router $r, string $path, string $class, string $perm): void {
    $r->get($path, [$class, 'index'], ['perm' => "$perm.view"]);
    $r->post($path, [$class, 'store'], ['perm' => "$perm.create"]);
    $r->get("$path/{id}", [$class, 'show'], ['perm' => "$perm.view"]);
    $r->put("$path/{id}", [$class, 'update'], ['perm' => "$perm.edit"]);
    $r->post("$path/{id}/cancel", [$class, 'cancel'], ['perm' => "$perm.cancel"]);
};
$voucher($r, 'igp', InwardGatePassController::class, 'igp');
$voucher($r, 'transfers', StockTransferController::class, 'transfer');
$voucher($r, 'consumptions', StockConsumptionController::class, 'consumption');
$voucher($r, 'ink-loads', InkLoadController::class, 'ink_load');
$voucher($r, 'estimations', EstimationController::class, 'estimation');
$r->post('estimations/calc', [EstimationController::class, 'calc'], ['perm' => ['estimation.create', 'estimation.edit']]);
$voucher($r, 'productions-bom', BomProductionController::class, 'bom_production');
$voucher($r, 'productions-manual', ManualProductionController::class, 'manual_production');
$r->post('production/requirements', [BomProductionController::class, 'requirements'], ['perm' => [
    'bom_production.create', 'bom_production.edit', 'manual_production.create', 'manual_production.edit',
]]);
$voucher($r, 'chalans', DeliveryChalanController::class, 'chalan');
$r->get('chalans/party-summary', [DeliveryChalanController::class, 'partySummary'], ['perm' => ['chalan.view', 'chalan.create', 'chalan.edit']]);
$r->get('chalans/party-lots', [DeliveryChalanController::class, 'partyLots'], ['perm' => ['chalan.create', 'chalan.edit']]);
$r->get('stock/balance', [StockController::class, 'balance'], ['perm' => [
    'igp.create', 'igp.edit', 'transfer.create', 'transfer.edit', 'consumption.create', 'consumption.edit',
    'ink_load.create', 'ink_load.edit', 'reports.stock',
    'bom_production.create', 'bom_production.edit', 'manual_production.create', 'manual_production.edit',
    'chalan.create', 'chalan.edit',
]]);

return $r;
