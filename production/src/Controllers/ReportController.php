<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\ApiException;
use Prod\Csv;
use Prod\Masters;
use Prod\Reports;
use Prod\Request;
use Prod\Text;

final class ReportController
{
    public function dashboard(Request $r): array
    {
        $to = Text::date($r->query('to', '')) ?? date('Y-m-d');
        $from = Text::date($r->query('from', '')) ?? date('Y-m-01', strtotime($to));
        if ($from > $to) {
            throw ApiException::validation(['from' => 'From date is after To date.']);
        }
        if ((strtotime($to) - strtotime($from)) / 86400 > 3660) {
            throw ApiException::validation(['from' => 'Choose a range of at most 10 years.']);
        }
        return Reports::dashboard($from, $to, $r->queryInt('machine_id'));
    }

    public function summary(Request $r): array
    {
        return Reports::summary($_GET, (string)$r->query('group', 'party'), (string)$r->query('group2', ''), (string)$r->query('sort', 'key'));
    }

    public function summaryCsv(Request $r): never
    {
        $s = Reports::summary($_GET, (string)$r->query('group', 'party'), (string)$r->query('group2', ''), (string)$r->query('sort', 'key'));
        $head = array_values(array_filter([$s['labels'][0], $s['labels'][1]]));
        $head = array_merge($head, ['Entries', 'Lots', 'Printed Mtr', 'Ink (L)', 'Avg Ink (ml/m)', 'Ink Cost (Rs)', 'Cost per Mtr (Rs)']);
        $line = fn(array $x, array $keys) => array_merge($keys, [$x['entries'], $x['lots'], $x['meters'], $x['ink_litres'], $x['avg_ml'], $x['ink_cost'], $x['cost_per_mtr']]);
        $rows = (function () use ($s, $line) {
            foreach ($s['rows'] as $x) {
                yield $line($x, $s['group2'] ? [$x['k1'], $x['k2']] : [$x['k1']]);
            }
            yield $line($s['totals'], $s['group2'] ? ['Total', ''] : ['Total']);
        })();
        Csv::send('production-summary-' . $s['group1'] . ($s['group2'] ? '-' . $s['group2'] : '') . '-' . date('Ymd') . '.csv', $head, $rows);
    }

    public function checks(Request $r): array
    {
        $similar = [];
        foreach (array_keys(Masters::KINDS) as $kind) {
            $similar[$kind] = Masters::similar($kind);
        }
        return ['counts' => Reports::checks($_GET), 'similar' => $similar];
    }
}
