<?php
declare(strict_types=1);

// PayrollEngine: the verified examples from the specification plus the confirmed batch 4 decisions.

use App\PayrollEngine;

$e = new PayrollEngine('half_up', 2.0, 8.0);
$feb = ['type' => 'permanent', 'days' => 28, 'rest_days' => 0, 'paid_leave' => 0];

return [
    'spec: Feb 28 days - 9,000 / 28 x 14 = 4,500' => function () use ($e, $feb) {
        $r = $e->calculate($feb + ['basic' => 9000, 'work_days' => 14]);
        assert_eq(14.0, $r['paid_days']);
        assert_eq(4500.0, $r['work_pay']);
    },
    'spec: 10,000 / 28 x 11 = 3,929 (rounded half up)' => function () use ($e, $feb) {
        assert_eq(3929.0, $e->calculate($feb + ['basic' => 10000, 'work_days' => 11])['work_pay']);
    },
    'spec: 15,000 / 28 x 10 = 5,357' => function () use ($e, $feb) {
        assert_eq(5357.0, $e->calculate($feb + ['basic' => 15000, 'work_days' => 10])['work_pay']);
    },
    'spec: Paid Days = Work Days + Rest Days + Paid Leave' => function () use ($e, $feb) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 28, 'basic' => 9000, 'work_days' => 10, 'rest_days' => 3, 'paid_leave' => 1]);
        assert_eq(14.0, $r['paid_days']);
        assert_eq(4500.0, $r['work_pay']);
    },
    'spec: Net = Work Pay 6,857 - Advance 2,172 = 4,685' => function () use ($e, $feb) {
        $r = $e->calculate($feb + ['basic' => 12000, 'work_days' => 16, 'advance' => 2172]);
        assert_eq(6857.0, $r['work_pay']);
        assert_eq(6857.0, $r['gross']);
        assert_eq(4685.0, $r['net_salary']);
    },
    'spec: Net = 5,357 + Incentive 6,774 - Advance 3,000 - Loan 2,000 = 7,131' => function () use ($e, $feb) {
        $r = $e->calculate($feb + ['basic' => 15000, 'work_days' => 10, 'incentive' => 6774, 'advance' => 3000, 'loan_planned' => 2000]);
        assert_eq(5357.0, $r['work_pay']);
        assert_eq(2000.0, $r['loan_deduction']);
        assert_eq(7131.0, $r['net_salary']);
    },
    'spec: Overtime = OT hours x OT rate (basic / days / shift hours x multiplier)' => function () use ($e) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 9000, 'work_days' => 30, 'ot_minutes' => 600]);
        assert_eq(75.0, $r['ot_rate']);       // 9000 / 30 / 8 x 2
        assert_eq(10.0, $r['ot_hours']);
        assert_eq(750.0, $r['ot_amount']);
        assert_eq(9750.0, $r['gross']);       // Gross = Work Pay + Overtime
    },
    'spec: daily wages - Pay = Daily Rate x Present Days + OT' => function () use ($e) {
        $r = $e->calculate(['type' => 'daily_wages', 'days' => 30, 'daily_rate' => 1500, 'work_days' => 22, 'rest_days' => 4, 'ot_minutes' => 120]);
        assert_eq(33000.0, $r['work_pay']);
        assert_eq(22.0, $r['paid_days']);     // rest days are not paid to daily wagers
        assert_eq(375.0, $r['ot_rate']);      // 1500 / 8 x 2
        assert_eq(750.0, $r['ot_amount']);
        assert_eq(33750.0, $r['gross']);
    },
    'decision: half / short day paid on actual hours, not a fixed half' => function () use ($e) {
        assert_eq(0.57, PayrollEngine::dayFraction(240, 420));   // 4 h of a 7 h shift
        assert_eq(1.0, PayrollEngine::dayFraction(500, 420));    // capped at 1
        assert_eq(0.0, PayrollEngine::dayFraction(0, 420));
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 20.57, 'rest_days' => 4]);
        assert_eq(24.57, $r['paid_days']);
        assert_eq(24570.0, $r['work_pay']);
    },
    'decision: allowances added to gross, prorated by paid days' => function () use ($e) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'allowances' => 6000, 'work_days' => 15]);
        assert_eq(15000.0, $r['work_pay']);
        assert_eq(3000.0, $r['allowance_pay']);
        assert_eq(18000.0, $r['gross']);
        $r = $e->calculate(['type' => 'daily_wages', 'days' => 30, 'daily_rate' => 1000, 'allowances' => 3000, 'work_days' => 10]);
        assert_eq(1000.0, $r['allowance_pay']);
    },
    'OT rate override, OT not applicable, fixed OT voucher amount' => function () use ($e) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 30, 'ot_minutes' => 90, 'ot_rate' => 200, 'ot_voucher_hours' => 2.5, 'ot_voucher_amount' => 500]);
        assert_eq(4.0, $r['ot_hours']);
        assert_eq(1300.0, $r['ot_amount']);   // 4 h x 200 + 500 fixed
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 30, 'ot_minutes' => 600, 'ot_applicable' => false]);
        assert_eq(0.0, $r['ot_amount']);
        assert_true(count($r['warnings']) === 1);
    },
    'all deductions: penalty, fine, EOBI, PESSI employee share, tax' => function () use ($e) {
        $eobi = ['calc_method' => 'percent_of_min_wage', 'employee_share' => 1, 'min_wage' => 40000, 'wage_ceiling' => null];
        $pessi = ['calc_method' => 'percent_of_wage', 'employee_share' => 2, 'min_wage' => null, 'wage_ceiling' => 30000];
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 50000, 'work_days' => 30, 'penalty' => 500, 'fine' => 250,
            'eobi_rate' => $eobi, 'pessi_rate' => $pessi]);
        assert_eq(400.0, $r['eobi']);   // 1% of minimum wage 40,000
        assert_eq(600.0, $r['pessi']);  // 2% of wages capped at 30,000
        assert_eq(50000.0 - 500 - 250 - 400 - 600, $r['net_salary']);
    },
    'income tax from slabs (annualised monthly salary)' => function () use ($e) {
        $slabs = [
            ['income_from' => 0, 'income_to' => 600000, 'fixed_amount' => 0, 'rate_percent' => 0],
            ['income_from' => 600000, 'income_to' => 1200000, 'fixed_amount' => 0, 'rate_percent' => 1],
            ['income_from' => 1200000, 'income_to' => 2200000, 'fixed_amount' => 6000, 'rate_percent' => 11],
            ['income_from' => 2200000, 'income_to' => null, 'fixed_amount' => 116000, 'rate_percent' => 23],
        ];
        assert_eq(0.0, PayrollEngine::annualTax(600000, $slabs));
        assert_eq(6000.0, PayrollEngine::annualTax(1200000, $slabs));
        assert_eq(28000.0, PayrollEngine::annualTax(1400000, $slabs));     // 6,000 + 11% of 200,000
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 160000, 'work_days' => 30, 'tax_slabs' => $slabs]);
        assert_eq(7100.0, $r['income_tax']); // 1,920,000 a year -> 6,000 + 11% x 720,000 = 85,200 -> 7,100 a month
    },
    'loan installment reduced when salary is not enough (carry forward); net never negative' => function () use ($e) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 3, 'advance' => 1000, 'loan_planned' => 4000]);
        assert_eq(3000.0, $r['work_pay']);
        assert_eq(2000.0, $r['loan_deduction']);
        assert_eq(0.0, $r['net_salary']);
        assert_true(str_contains(implode(' ', $r['warnings']), 'carried forward'));
        // net is never negative: the advance not covered is carried forward
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 1, 'advance' => 5000]);
        assert_eq(0.0, $r['net_salary']);
        assert_eq(1000.0, $r['advance']);
        assert_eq(4000.0, $r['advance_carried']);
        assert_true(str_contains(implode(' ', $r['warnings']), 'carried forward'));
    },
    'paid days capped at the divisor; day basis' => function () use ($e) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 26, 'basic' => 26000, 'work_days' => 26, 'rest_days' => 4]);
        assert_eq(26.0, $r['paid_days']);
        assert_eq(26000.0, $r['work_pay']);
        assert_eq(28, PayrollEngine::daysInMonth('calendar', '2026-02-01', '2026-02-28'));
        assert_eq(31, PayrollEngine::daysInMonth('calendar', '2026-08-26', '2026-09-25'));
        assert_eq(30, PayrollEngine::daysInMonth('fixed30', '2026-02-01', '2026-02-28'));
    },
    'fixed 30-day basis: a full February is the full basic' => function () use ($e) {
        // 24 work + 4 rest in a 28-day February, nothing unpaid
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basis' => 'fixed30', 'unpaid_days' => 0, 'basic' => 30000, 'work_days' => 24, 'rest_days' => 4]);
        assert_eq(30.0, $r['paid_days']);
        assert_eq(30000.0, $r['work_pay']);
    },
    'fixed 26-day basis: absences are deducted even in a 31-day month' => function () use ($e) {
        // 23 work + 5 rest + 3 absent in 31 days: 26 - 3 = 23 paid days
        $r = $e->calculate(['type' => 'permanent', 'days' => 26, 'basis' => 'fixed26', 'unpaid_days' => 3, 'basic' => 26000, 'work_days' => 23, 'rest_days' => 5]);
        assert_eq(23.0, $r['paid_days']);
        assert_eq(23000.0, $r['work_pay']);
        // a half day worked 50%: 0.5 unpaid
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basis' => 'fixed30', 'unpaid_days' => 0.5, 'basic' => 30000, 'work_days' => 25.5, 'rest_days' => 4]);
        assert_eq(29500.0, $r['work_pay']);
        // more unpaid days than the divisor never goes negative
        $r = $e->calculate(['type' => 'permanent', 'days' => 26, 'basis' => 'fixed26', 'unpaid_days' => 31, 'basic' => 26000, 'work_days' => 0]);
        assert_eq(0.0, $r['work_pay']);
    },
    'rounding modes' => function () {
        assert_eq(3929.0, (new PayrollEngine('half_up'))->round(3928.57));
        assert_eq(3928.0, (new PayrollEngine('down'))->round(3928.57));
        assert_eq(3929.0, (new PayrollEngine('up'))->round(3928.01));
        assert_eq(4500.0, (new PayrollEngine('up'))->round(4500.0000000001));
        assert_eq(-3.0, (new PayrollEngine('half_up'))->round(-2.5));
    },
    'net never negative: loan capped first, then advance, penalty, fine carried forward' => function () use ($e) {
        // work pay 3,000; deductions: fine 500, penalty 1,000, advance 2,000, loan 1,500
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 3,
            'fine' => 500, 'penalty' => 1000, 'advance' => 2000, 'loan_planned' => 1500]);
        assert_eq(0.0, $r['loan_deduction']);    // loan gives way first
        assert_eq(1500.0, $r['advance']);        // then the advance: 500 carried
        assert_eq(500.0, $r['advance_carried']);
        assert_eq(1000.0, $r['penalty']);
        assert_eq(500.0, $r['fine']);
        assert_eq(0.0, $r['net_salary']);
        // only the penalty and fine exceed the pay: advance fully carried, fine deducted first
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 1, 'fine' => 600, 'penalty' => 700, 'advance' => 100]);
        assert_eq(600.0, $r['fine']);
        assert_eq(400.0, $r['penalty']);
        assert_eq(300.0, $r['penalty_carried']);
        assert_eq(100.0, $r['advance_carried']);
        assert_eq(0.0, $r['net_salary']);
        // enough pay: nothing carried
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basic' => 30000, 'work_days' => 30, 'fine' => 600, 'advance' => 1000, 'loan_planned' => 2000]);
        assert_eq(26400.0, $r['net_salary']);
        assert_eq(0.0, $r['advance_carried'] + $r['penalty_carried'] + $r['fine_carried']);
    },
];
