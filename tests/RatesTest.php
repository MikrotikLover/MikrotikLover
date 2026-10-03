<?php
declare(strict_types=1);

// Tax slab validation (App\Rates::normaliseSlabs) - pure, no database.

use App\Rates;

$good = [
    ['income_from' => 600000, 'income_to' => 1200000, 'fixed_amount' => 0, 'rate_percent' => 1],
    ['income_from' => 0, 'income_to' => 600000, 'fixed_amount' => '', 'rate_percent' => ''],
    ['income_from' => 1200000, 'income_to' => '', 'fixed_amount' => 6000, 'rate_percent' => 11],
];

return [
    'slabs are sorted and normalised (blank = 0 / open-ended)' => function () use ($good) {
        $r = Rates::normaliseSlabs($good);
        assert_eq(0.0, $r[0]['income_from']);
        assert_eq(0.0, $r[0]['rate_percent']);
        assert_eq(null, $r[2]['income_to']);
        assert_eq(1200000.0, $r[1]['income_to']);
    },
    'normalised slabs give the same tax as the engine examples' => function () use ($good) {
        $r = Rates::normaliseSlabs($good);
        assert_eq(6000.0, \App\PayrollEngine::annualTax(1200000, $r));
        assert_eq(28000.0, \App\PayrollEngine::annualTax(1400000, $r));
    },
    'first slab must start at 0' => function () {
        assert_throws(fn() => Rates::normaliseSlabs([['income_from' => 100, 'income_to' => null, 'fixed_amount' => 0, 'rate_percent' => 1]]), \InvalidArgumentException::class);
    },
    'gaps and overlaps are rejected' => function () {
        assert_throws(fn() => Rates::normaliseSlabs([
            ['income_from' => 0, 'income_to' => 600000, 'fixed_amount' => 0, 'rate_percent' => 0],
            ['income_from' => 700000, 'income_to' => null, 'fixed_amount' => 0, 'rate_percent' => 5],
        ]), \InvalidArgumentException::class);
    },
    'only the last slab is open-ended; to > from; rate <= 100; no negatives' => function () {
        assert_throws(fn() => Rates::normaliseSlabs([
            ['income_from' => 0, 'income_to' => null, 'fixed_amount' => 0, 'rate_percent' => 0],
            ['income_from' => 600000, 'income_to' => null, 'fixed_amount' => 0, 'rate_percent' => 5],
        ]), \InvalidArgumentException::class);
        assert_throws(fn() => Rates::normaliseSlabs([['income_from' => 0, 'income_to' => 600000, 'fixed_amount' => 0, 'rate_percent' => 0]]), \InvalidArgumentException::class);
        assert_throws(fn() => Rates::normaliseSlabs([['income_from' => 0, 'income_to' => null, 'fixed_amount' => 0, 'rate_percent' => 120]]), \InvalidArgumentException::class);
        assert_throws(fn() => Rates::normaliseSlabs([['income_from' => 0, 'income_to' => null, 'fixed_amount' => -5, 'rate_percent' => 1]]), \InvalidArgumentException::class);
        assert_throws(fn() => Rates::normaliseSlabs([]), \InvalidArgumentException::class);
    },
];
