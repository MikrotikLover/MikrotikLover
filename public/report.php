<?php
declare(strict_types=1);

/**
 * Print-ready report pages (opened in a new tab by the SPA).
 *   report.php?r=employee_list&department_id=&status=&emp_type=[&format=csv]
 *   report.php?r=id_cards&ids=1,2,3&layout=sheet|cr80
 */
require dirname(__DIR__) . '/app/bootstrap.php';

use App\Auth;
use App\Http;
use App\Request;
use App\Reports;

const REPORTS = [
    'employee_list' => Reports\EmployeeListReport::class,
    'id_cards'      => Reports\IdCardReport::class,
];

Http::noStore();
Http::securityHeaders();
Auth::startSession();

$user = Auth::user();
if (!$user) {
    header('Location: ./#/login');
    exit;
}

$key = (string)($_GET['r'] ?? '');
$class = REPORTS[$key] ?? null;
if (!$class) {
    http_response_code(404);
    exit('Unknown report.');
}

try {
    /** @var Reports\Report $report */
    $report = new $class();
    [$module, $action] = $report->permission();
    if (!Auth::can($module, $action) && !(Auth::can('reports', 'print') && Auth::can($module, 'view'))) {
        http_response_code(403);
        exit('You do not have permission to print this report.');
    }
    $report->load(new Request());
    if (($_GET['format'] ?? '') === 'csv' && $report->supportsCsv()) {
        $report->outputCsv($key . '_' . date('Ymd_His') . '.csv');
    }
    header('Content-Type: text/html; charset=utf-8');
    echo $report->renderHtml();
} catch (Throwable $e) {
    error_log('[report] ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
    http_response_code(500);
    echo App\Config::get('debug') ? Http::e($e->getMessage()) : 'Report could not be generated. The problem has been logged.';
}
