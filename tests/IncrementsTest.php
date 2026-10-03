<?php
declare(strict_types=1);

// Salary increments: integer-paisa money maths, the three increment formulas, and pro-rata / per-date OT
// in the payroll engine. Pure (no database).

use App\Increments;
use App\Money;
use App\PayrollEngine;

$e = new PayrollEngine('half_up', 2.0, 8.0);
$seg = fn(string $salary, float $work, float $rest = 0, float $leave = 0, float $unpaid = 0, int $len = 0) =>
    ['salary' => $salary, 'work_days' => $work, 'rest_days' => $rest, 'paid_leave' => $leave, 'unpaid_days' => $unpaid, 'len' => $len];

return [
    'paisa: parse and format exactly, no float' => function () {
        assert_eq(4500050, Money::toPaisa('45000.5'));
        assert_eq(4500005, Money::toPaisa('45000.05'));
        assert_eq(4500000, Money::toPaisa('45000'));
        assert_eq(-150, Money::toPaisa('-1.50'));
        assert_eq('45000.50', Money::fromPaisa(4500050));
        assert_eq('-1.05', Money::fromPaisa(-105));
        assert_throws(fn() => Money::toPaisa('1.005'), InvalidArgumentException::class);
        assert_eq('0.00', Money::fromPaisa(0));
    },
    'paisa: divRound half up / up / down, negatives' => function () {
        assert_eq(3, Money::divRound(5, 2));          // 2.5 -> 3
        assert_eq(-3, Money::divRound(-5, 2));        // half away from zero
        assert_eq(2, Money::divRound(5, 2, 'down'));
        assert_eq(3, Money::divRound(41, 20, 'up'));  // 2.05 -> 3
        assert_eq(-3, Money::divRound(-41, 20, 'down'));
        assert_eq(7, Money::divRound(14, 2, 'up'));   // exact stays exact
    },
    'increment formulas: percentage, fixed, direct new salary (whole rupees)' => function () {
        assert_eq('49500.00', Increments::compute('percentage', '45000.00', '10'));
        assert_eq('45465.00', Increments::compute('percentage', '44000.00', '3.33'));   // 45,465.20
        assert_eq('41925.00', Increments::compute('percentage', '39000.00', '7.5'));
        assert_eq('10050.00', Increments::compute('percentage', '10000.00', '0.5'));
        assert_eq('10001.00', Increments::compute('percentage', '10000.00', '0.01'));    // 10,001.00 exactly
        assert_eq('10001.00', Increments::compute('percentage', '10010.00', '-0.09'));   // 10,000.99 -> 10,001 (half up)
    },
    'increment formulas: fixed and new_salary round half up' => function () {
        assert_eq('46000.00', Increments::compute('fixed', '43000.00', '3000'));
        assert_eq('43001.00', Increments::compute('fixed', '43000.00', '0.50'));
        assert_eq('43000.00', Increments::compute('fixed', '43000.00', '0.49'));
        assert_eq('47500.00', Increments::compute('new_salary', '42000.00', '47500.40'));
        assert_eq('47501.00', Increments::compute('new_salary', '42000.00', '47500.50'));
        assert_eq('1600.00', Increments::compute('percentage', '1500.00', '6.66')); // daily rate 1,599.90 -> 1,600
    },
    'value parsing: 2 decimals max, no negatives' => function () {
        assert_eq('10.00', Increments::decimal('10'));
        assert_eq('7.50', Increments::decimal(7.5));
        assert_eq('5000.00', Increments::decimal('5,000'));
        assert_eq(null, Increments::decimal('12.345'));
        assert_eq(null, Increments::decimal('-5'));
        assert_eq(null, Increments::decimal('abc'));
        assert_eq(null, Increments::decimal(null));
    },
    'pro-rata: increment mid-month splits the month' => function () use ($e, $seg) {
        // 30 days; 1-15 at 52,000 (14 paid: 1 LWP), 16-30 at 60,000 (14 paid: 1 absent)
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'work_days' => 23, 'rest_days' => 5,
            'segments' => [$seg('52000.00', 12, 2), $seg('60000.00', 11, 3)]]);
        assert_eq(28.0, $r['paid_days']);
        assert_eq(52267.0, $r['work_pay']);           // 24,266.67 + 28,000 = 52,266.67
        assert_eq([14.0, 14.0], $r['segment_paid_days']);
    },
    'pro-rata: single segment equals the old formula' => function () use ($e, $seg) {
        $a = $e->calculate(['type' => 'permanent', 'days' => 28, 'basic' => 10000, 'work_days' => 11]);
        $b = $e->calculate(['type' => 'permanent', 'days' => 28, 'work_days' => 11, 'segments' => [$seg('10000.00', 11)]]);
        assert_eq(3929.0, $a['work_pay']);
        assert_eq($a['work_pay'], $b['work_pay']);
    },
    'pro-rata: paid-day cap applied across segments' => function () use ($e, $seg) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 26, 'work_days' => 26, 'rest_days' => 4,
            'segments' => [$seg('26000.00', 13, 2), $seg('52000.00', 13, 2)]]);
        assert_eq(26.0, $r['paid_days']);
        assert_eq([15.0, 11.0], $r['segment_paid_days']); // the later segment is cut
        assert_eq(37000.0, $r['work_pay']);               // 26,000/26x15 + 52,000/26x11
    },
    'pro-rata: fixed 30-day basis, 31-day month, full attendance = blend of both salaries' => function () use ($e, $seg) {
        // 31 calendar days, increment on the 16th: 15 days old, 16 days new; the last segment absorbs 30 - 31
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basis' => 'fixed30', 'work_days' => 31,
            'segments' => [$seg('30000.00', 15, 0, 0, 0, 15), $seg('36000.00', 16, 0, 0, 0, 16)]]);
        assert_eq(30.0, $r['paid_days']);
        assert_eq([15.0, 15.0], $r['segment_paid_days']);
        assert_eq(33000.0, $r['work_pay']);
        // February (28 days) on fixed30 with one absent day in the new segment
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'basis' => 'fixed30', 'work_days' => 27,
            'segments' => [$seg('30000.00', 14, 0, 0, 0, 14), $seg('36000.00', 13, 0, 0, 1, 14)]]);
        assert_eq(29.0, $r['paid_days']);                 // 14 + (13 + 2 absorbed)
        assert_eq(32000.0, $r['work_pay']);               // 30,000/30x14 + 36,000/30x15
    },
    'pro-rata: daily wages pay each segment rate x present days' => function () use ($e, $seg) {
        $r = $e->calculate(['type' => 'daily_wages', 'days' => 30, 'work_days' => 22, 'rest_days' => 4,
            'segments' => [$seg('1500.00', 10, 2), $seg('1600.00', 12, 2)]]);
        assert_eq(22.0, $r['paid_days']);
        assert_eq(34200.0, $r['work_pay']);               // 15,000 + 19,200
    },
    'OT priced with the salary of each OT date' => function () use ($e, $seg) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'work_days' => 30, 'segments' => [$seg('9000.00', 30)],
            'ot_items' => [['minutes' => 120, 'hours' => 0, 'salary' => '9000.00'], ['minutes' => 120, 'hours' => 0, 'salary' => '12000.00']]]);
        // 9,000/30/8x2 = 75; 12,000/30/8x2 = 100 -> 2x75 + 2x100 = 350
        assert_eq(4.0, $r['ot_hours']);
        assert_eq(350.0, $r['ot_amount']);
        assert_eq(87.5, $r['ot_rate']);                   // blended, so hours x rate = amount
        assert_eq([['rate' => 100.0, 'hours' => 2.0], ['rate' => 75.0, 'hours' => 2.0]], $r['ot_rates']);
    },
    'OT: voucher hours use their own date; fixed OT rate override ignores increments' => function () use ($e, $seg) {
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'work_days' => 30, 'segments' => [$seg('9000.00', 30)],
            'ot_items' => [['minutes' => 0, 'hours' => 2.5, 'salary' => '12000.00']], 'ot_voucher_amount' => 100]);
        assert_eq(350.0, $r['ot_amount']);                // 2.5 x 100 + 100 fixed
        $r = $e->calculate(['type' => 'permanent', 'days' => 30, 'work_days' => 30, 'ot_rate' => 200, 'segments' => [$seg('9000.00', 30)],
            'ot_items' => [['minutes' => 60, 'hours' => 0, 'salary' => '9000.00'], ['minutes' => 60, 'hours' => 0, 'salary' => '12000.00']]]);
        assert_eq(400.0, $r['ot_amount']);
        assert_eq(200.0, $r['ot_rate']);
    },
    'OT: multiplier from settings (1x, 1.5x, 2x) and daily wages' => function () use ($seg) {
        foreach (['1' => 37.5, '1.5' => 56.25, '2' => 75.0] as $m => $rate) {
            $r = (new PayrollEngine('half_up', (float)$m, 8.0))->calculate(['type' => 'permanent', 'days' => 30, 'work_days' => 30,
                'segments' => [$seg('9000.00', 30)], 'ot_items' => [['minutes' => 60, 'hours' => 0, 'salary' => '9000.00']]]);
            assert_eq($rate, $r['ot_rate'], "multiplier $m");
        }
        $r = (new PayrollEngine('half_up', 2.0, 8.0))->calculate(['type' => 'daily_wages', 'days' => 30, 'work_days' => 20,
            'segments' => [$seg('1600.00', 20)], 'ot_items' => [['minutes' => 60, 'hours' => 0, 'salary' => '1500.00'], ['minutes' => 60, 'hours' => 0, 'salary' => '1600.00']]]);
        assert_eq(775.0, $r['ot_amount']);                // 1,500/8x2 = 375 + 1,600/8x2 = 400
    },
];
