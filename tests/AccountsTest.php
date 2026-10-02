<?php
declare(strict_types=1);

// Loan schedule rules and PKR amount in words (pure functions, no database).

use App\LoanSchedule;
use App\Money;

$plan = fn(array $p) => array_map(fn($r) => substr($r['month'], 0, 7) . '=' . (int)$r['amount'] . ($r['status'] === 'scheduled' ? '' : ':' . $r['status']), $p);

return [
    'loan schedule: equal installments with remainder last' => function () use ($plan) {
        assert_eq(['2026-10=4000', '2026-11=4000', '2026-12=4000', '2027-01=4000', '2027-02=4000', '2027-03=4000', '2027-04=1000'],
            $plan(LoanSchedule::build(25000, 4000, '2026-10-15')));
        assert_eq(['2026-10=5000', '2026-11=5000'], $plan(LoanSchedule::build(10000, 5000, '2026-10-01')));
        assert_eq(7, LoanSchedule::count(25000, 4000));
    },
    'loan schedule: skipped month pushes balance to the end' => function () use ($plan) {
        $p = LoanSchedule::build(12000, 4000, '2026-10-01', ['2026-11-01' => ['status' => 'skipped', 'amount' => 0]]);
        assert_eq(['2026-10=4000', '2026-11=0:skipped', '2026-12=4000', '2027-01=4000'], $plan($p));
    },
    'loan schedule: adjusted and deducted months are kept, rest re-spread' => function () use ($plan) {
        $p = LoanSchedule::build(25000, 4000, '2026-10-01', [
            '2026-10-01' => ['status' => 'deducted', 'amount' => 4000],
            '2026-12-01' => ['status' => 'adjusted', 'amount' => 10000],
        ]);
        assert_eq(['2026-10=4000:deducted', '2026-11=4000', '2026-12=10000:adjusted', '2027-01=4000', '2027-02=3000'], $plan($p));
        // short deduction (e.g. salary too low) leaves more for later months
        $p = LoanSchedule::build(9000, 3000, '2026-10-01', ['2026-10-01' => ['status' => 'deducted', 'amount' => 1000]]);
        assert_eq(['2026-10=1000:deducted', '2026-11=3000', '2026-12=3000', '2027-01=2000'], $plan($p));
    },
    'loan schedule: fixed months beyond the balance and over-allocation' => function () use ($plan) {
        $p = LoanSchedule::build(8000, 4000, '2026-10-01', ['2026-10-01' => ['status' => 'adjusted', 'amount' => 8000], '2026-11-01' => ['status' => 'skipped', 'amount' => 0]]);
        assert_eq(['2026-10=8000:adjusted', '2026-11=0:skipped'], $plan($p));
        assert_throws(fn() => LoanSchedule::build(5000, 1000, '2026-10-01', ['2026-10-01' => ['status' => 'adjusted', 'amount' => 6000]]), InvalidArgumentException::class);
        assert_throws(fn() => LoanSchedule::build(5000, 0, '2026-10-01'), InvalidArgumentException::class);
    },
    'month helpers' => function () {
        assert_eq('2027-01-01', LoanSchedule::addMonths('2026-12-01', 1));
        assert_eq('2026-02-01', LoanSchedule::addMonths('2026-01-31', 1));
        assert_eq('2026-10-01', LoanSchedule::month('2026-10-23'));
    },
    'amount in words (lakh / crore)' => function () {
        assert_eq('Rupees Four Thousand Six Hundred Eighty-Five Only', Money::words(4685));
        assert_eq('Rupees One Lakh Fifty Thousand Only', Money::words(150000));
        assert_eq('Rupees Twelve Lakh Thirty-Four Thousand Five Hundred Sixty-Seven Only', Money::words(1234567));
        assert_eq('Rupees One Hundred Fifty Crore Only', Money::words(1500000000));
        assert_eq('Rupees Zero Only', Money::words(0));
        assert_eq('Rupees Seven Thousand One Hundred Thirty-One Only', Money::words('7131.00'));
    },
];
