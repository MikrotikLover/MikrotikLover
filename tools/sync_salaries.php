<?php
declare(strict_types=1);

/**
 * Optional hPanel cron job: make scheduled salary increments the current salary (employees.basic_salary)
 * right after midnight. Without it the first API request of the day does the same.
 *   hPanel -> Advanced -> Cron Jobs:  5 0 * * *  /usr/bin/php /home/USER/payroll/tools/sync_salaries.php
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
require dirname(__DIR__) . '/app/bootstrap.php';

$n = App\Increments::syncBasicSalaries();
App\Settings::set('salary_synced_on', date('Y-m-d'));
echo date('Y-m-d H:i'), " basic salary synced ($n employee(s) changed)", PHP_EOL;
