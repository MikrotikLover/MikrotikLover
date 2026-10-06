<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\Csv;
use Prod\Database;
use Prod\Entries;
use Prod\Request;

final class EntryController
{
    public function index(Request $r): array
    {
        return Entries::list($_GET, $r->queryInt('page', 1), $r->queryInt('per_page', 100));
    }

    public function csv(Request $r): never
    {
        [$where, $p] = Entries::where($_GET);
        $stmt = Database::run('SELECT ' . Entries::SELECT . ' FROM ' . Entries::FROM . " WHERE $where ORDER BY e.entry_date, e.id", $p);
        Csv::send('production-entries-' . date('Ymd-His') . '.csv',
            ['Date', 'Lot #', 'Quality', 'Party Name', 'Design', 'Printed Mtr', 'Calibration', 'Ink use (ml/m)', 'Article', 'Machine', 'Shift',
                'Operator', 'Total Ink (ml)', 'Ink Company', 'Ink Rate (Rs/L)', 'Ink Cost (Rs)', 'Machine Rate (Rs/m)', 'Machine Cost (Rs)', 'Total Cost (Rs)', 'Remarks', 'Source'],
            (function () use ($stmt) {
                while ($e = $stmt->fetch()) {
                    yield [$e['entry_date'], $e['lot_no'], $e['quality'], $e['party'], $e['design'], $e['printed_mtr'], $e['calibration'],
                        $e['ink_ml_per_mtr'], $e['article'], $e['machine'], $e['shift'], $e['operator'], $e['ink_ml'], $e['ink_company'], $e['ink_rate'],
                        $e['ink_cost'], $e['machine_rate'], $e['machine_cost'], $e['total_cost'], $e['remarks'], $e['source']];
                }
            })()
        );
    }

    public function show(Request $r): array
    {
        return Entries::find($r->id());
    }

    public function store(Request $r): array
    {
        return Entries::create($r->body());
    }

    public function update(Request $r): array
    {
        return Entries::update($r->id(), $r->body());
    }

    public function destroy(Request $r): array
    {
        Entries::delete($r->id());
        return ['deleted' => 1];
    }

    public function bulkDelete(Request $r): array
    {
        return ['deleted' => Entries::deleteMatching($r->body())];
    }

    /** Last entry of the current user: the form copies date, machine, shift, operator from it. */
    public function last(Request $r): ?array
    {
        $id = Database::value("SELECT id FROM production_entries WHERE source = 'manual' AND created_by = ? ORDER BY id DESC LIMIT 1", [\Prod\Auth::id()]);
        return $id ? Entries::find((int)$id) : null;
    }
}
