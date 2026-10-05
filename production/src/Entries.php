<?php
declare(strict_types=1);

namespace Prod;

/** Production entries: filtering, listing, saving. */
final class Entries
{
    /** Joins that give every entry its names. Aliases are used by filters and reports. */
    public const FROM = 'production_entries e
        JOIN machines mc ON mc.id = e.machine_id
        LEFT JOIN masters pa ON pa.id = e.party_id
        LEFT JOIN masters qu ON qu.id = e.quality_id
        LEFT JOIN masters ar ON ar.id = e.article_id
        LEFT JOIN masters ca ON ca.id = e.calibration_id
        LEFT JOIN masters op ON op.id = e.operator_id
        LEFT JOIN ink_companies ic ON ic.id = e.ink_company_id';

    public const SELECT = 'e.id, e.entry_date, e.lot_no, e.design, e.printed_mtr, e.ink_ml_per_mtr, e.shift, e.remarks, e.ink_rate, e.ink_ml, e.ink_cost,
        e.ink_company_id, e.ink_company_manual, ic.name AS ink_company, e.machine_rate, e.machine_cost,
        COALESCE(e.ink_cost, 0) + e.machine_cost AS total_cost, e.source, e.machine_id, mc.name AS machine, pa.name AS party, qu.name AS quality, ar.name AS article, ca.name AS calibration, op.name AS operator';

    /** Data-check flags usable as ?flag= */
    public const FLAGS = ['no_ink', 'high_ink', 'high_mtr', 'no_operator', 'no_party', 'no_article', 'no_quality'];

    /**
     * WHERE clause from query filters.
     * @param array<string,mixed> $q from, to, machine_id, shift, party_id, operator_id, quality_id, article_id,
     *                              calibration_id, lot, design, search, source, batch_id, flag
     * @return array{0:string,1:array}
     */
    public static function where(array $q): array
    {
        $w = ['1 = 1'];
        $p = [];
        $date = fn($v) => Text::date($v);
        if ($d = $date($q['from'] ?? '')) {
            $w[] = 'e.entry_date >= :from';
            $p['from'] = $d;
        }
        if ($d = $date($q['to'] ?? '')) {
            $w[] = 'e.entry_date <= :to';
            $p['to'] = $d;
        }
        foreach (['machine_id', 'party_id', 'operator_id', 'quality_id', 'article_id', 'calibration_id', 'ink_company_id', 'import_batch_id'] as $col) {
            $key = $col === 'import_batch_id' ? 'batch_id' : $col;
            $v = $q[$key] ?? '';
            if (is_scalar($v) && ctype_digit((string)$v)) {
                $w[] = "e.$col = :$key";
                $p[$key] = (int)$v;
            }
        }
        $shift = strtoupper(Text::clean($q['shift'] ?? ''));
        if (in_array($shift, ['A', 'B', 'C'], true)) {
            $w[] = 'e.shift = :shift';
            $p['shift'] = $shift;
        }
        if (in_array($q['source'] ?? '', ['manual', 'import'], true)) {
            $w[] = 'e.source = :source';
            $p['source'] = $q['source'];
        }
        if (($lot = Text::clean($q['lot'] ?? '')) !== '') {
            $w[] = 'e.lot_no = :lot';
            $p['lot'] = $lot;
        }
        if (($design = Text::clean($q['design'] ?? '')) !== '') {
            $w[] = 'e.design LIKE :design';
            $p['design'] = '%' . self::like($design) . '%';
        }
        if (($s = Text::clean($q['search'] ?? '')) !== '') {
            $w[] = '(e.lot_no LIKE :s1 OR e.design LIKE :s2 OR pa.name LIKE :s3 OR qu.name LIKE :s4 OR e.remarks LIKE :s5)';
            foreach (['s1', 's2', 's3', 's4', 's5'] as $k) {
                $p[$k] = '%' . self::like($s) . '%';
            }
        }
        switch ($q['flag'] ?? '') {
            case 'no_ink':
                $w[] = 'e.ink_ml_per_mtr IS NULL';
                break;
            case 'high_ink':
                $w[] = 'e.ink_ml_per_mtr > :hi';
                $p['hi'] = (float)Settings::get('ink_high_ml', 60);
                break;
            case 'high_mtr':
                $w[] = 'e.printed_mtr > :hm';
                $p['hm'] = (float)Settings::get('mtr_high', 5000);
                break;
            case 'no_operator':
            case 'no_party':
            case 'no_article':
            case 'no_quality':
                $w[] = 'e.' . substr($q['flag'], 3) . '_id IS NULL';
                break;
        }
        return [implode(' AND ', $w), $p];
    }

    private static function like(string $s): string
    {
        return addcslashes($s, '%_\\');
    }

    /** One page of entries plus totals for all matching rows. */
    public static function list(array $q, int $page = 1, int $perPage = 100): array
    {
        [$where, $p] = self::where($q);
        $perPage = max(10, min(500, $perPage));
        $totals = Reports::totals($where, $p);
        $pages = max(1, (int)ceil($totals['entries'] / $perPage));
        $page = max(1, min($page, $pages));
        $sort = match ($q['sort'] ?? '') {
            'oldest' => 'e.entry_date ASC, e.id ASC',
            'mtr'    => 'e.printed_mtr DESC, e.id DESC',
            'ink'    => 'e.ink_ml_per_mtr DESC, e.id DESC',
            default  => 'e.entry_date DESC, e.id DESC',
        };
        $rows = Database::all(
            'SELECT ' . self::SELECT . ' FROM ' . self::FROM . " WHERE $where ORDER BY $sort LIMIT $perPage OFFSET " . (($page - 1) * $perPage),
            $p
        );
        return ['rows' => $rows, 'page' => $page, 'pages' => $pages, 'per_page' => $perPage, 'totals' => $totals];
    }

    public static function find(int $id): array
    {
        return Database::one('SELECT ' . self::SELECT . ', e.created_at, e.updated_at, e.import_batch_id FROM ' . self::FROM . ' WHERE e.id = ?', [$id])
            ?? throw ApiException::notFound('Entry');
    }

    /** Validates input and returns the column values. */
    public static function validate(array $in, bool $isNew): array
    {
        $errors = [];
        $date = Text::date($in['entry_date'] ?? '');
        if ($date === null) {
            $errors['entry_date'] = 'Enter a valid date.';
        } elseif ($date > date('Y-m-d', strtotime('+1 day'))) {
            $errors['entry_date'] = 'Date cannot be in the future.';
        }
        $mtr = Text::number($in['printed_mtr'] ?? null);
        if ($mtr === null || $mtr <= 0 || $mtr > 1e7) {
            $errors['printed_mtr'] = 'Enter printed metres.';
        }
        $inkRaw = $in['ink_ml_per_mtr'] ?? null;
        $ink = Text::number($inkRaw);
        if ($ink === null && $inkRaw !== null && Text::clean($inkRaw) !== '') {
            $errors['ink_ml_per_mtr'] = 'Ink use must be a number (ml per metre).';
        } elseif ($ink !== null && ($ink < 0 || $ink >= 1e7)) {
            $errors['ink_ml_per_mtr'] = 'Ink use is out of range.';
        }
        $machineId = (int)($in['machine_id'] ?? 0);
        $machine = $machineId ? Database::one('SELECT id, is_active FROM machines WHERE id = ?', [$machineId]) : null;
        if (!$machine) {
            $errors['machine_id'] = 'Choose a machine.';
        } elseif ($isNew && !(int)$machine['is_active']) {
            $errors['machine_id'] = 'This machine is inactive.';
        }
        $shift = strtoupper(Text::clean($in['shift'] ?? ''));
        if (!in_array($shift, ['A', 'B', 'C'], true)) {
            $errors['shift'] = 'Choose shift A, B or C.';
        }
        // Ink company: empty = the one the machine uses on that date
        $inkCompany = (string)($in['ink_company_id'] ?? '');
        $inkCompany = ctype_digit($inkCompany) && $inkCompany !== '0' ? (int)$inkCompany : null;
        if ($inkCompany !== null && !Database::value('SELECT id FROM ink_companies WHERE id = ?', [$inkCompany])) {
            $errors['ink_company_id'] = 'Choose an ink company.';
        }
        foreach (['lot_no' => 40, 'design' => 80, 'remarks' => 255] as $f => $max) {
            if (mb_strlen(Text::clean($in[$f] ?? '')) > $max) {
                $errors[$f] = "At most $max characters.";
            }
        }
        foreach (array_keys(Masters::KINDS) as $kind) {
            if (mb_strlen(Text::clean($in[$kind] ?? '')) > 120) {
                $errors[$kind] = 'At most 120 characters.';
            }
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        return [
            'entry_date'     => $date,
            'lot_no'         => Text::clean($in['lot_no'] ?? ''),
            'design'         => Text::clean($in['design'] ?? ''),
            'printed_mtr'    => round($mtr, 2),
            'ink_ml_per_mtr' => $ink === null ? null : round($ink, 3),
            'machine_id'     => $machineId,
            'shift'          => $shift,
            'remarks'        => Text::clean($in['remarks'] ?? ''),
            'quality_id'     => Masters::resolve('quality', $in['quality'] ?? ''),
            'party_id'       => Masters::resolve('party', $in['party'] ?? ''),
            'calibration_id' => Masters::resolve('calibration', $in['calibration'] ?? ''),
            'article_id'     => Masters::resolve('article', $in['article'] ?? ''),
            'operator_id'    => Masters::resolve('operator', $in['operator'] ?? ''),
        ] + Pricing::forEntry($machineId, $date, $inkCompany);
    }

    public static function create(array $in): array
    {
        return Database::transaction(function () use ($in) {
            $data = self::validate($in, true);
            $id = Database::insert('production_entries', $data + ['source' => 'manual', 'created_by' => Auth::id()]);
            Audit::log('create', 'production_entries', $id, null, $data);
            return self::find($id);
        });
    }

    public static function update(int $id, array $in): array
    {
        return Database::transaction(function () use ($id, $in) {
            $old = Database::one('SELECT * FROM production_entries WHERE id = ? FOR UPDATE', [$id]) ?? throw ApiException::notFound('Entry');
            $data = self::validate($in, false);
            Database::update('production_entries', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            Audit::log('update', 'production_entries', $id, $old, $data);
            return self::find($id);
        });
    }

    public static function delete(int $id): void
    {
        $old = Database::one('SELECT * FROM production_entries WHERE id = ?', [$id]) ?? throw ApiException::notFound('Entry');
        Database::run('DELETE FROM production_entries WHERE id = ?', [$id]);
        Audit::log('delete', 'production_entries', $id, $old);
    }

    /** Deletes every entry matching the filters (used after a wrong import). Requires a date range. */
    public static function deleteMatching(array $q): int
    {
        if (!Text::date($q['from'] ?? '') && !ctype_digit((string)($q['batch_id'] ?? ''))) {
            throw ApiException::validation(['from' => 'Choose a date range or an import batch first.']);
        }
        [$where, $p] = self::where($q);
        $ids = Database::column('SELECT e.id FROM ' . self::FROM . " WHERE $where", $p);
        foreach (array_chunk($ids, 1000) as $chunk) {
            Database::run('DELETE FROM production_entries WHERE id IN (' . implode(',', array_map('intval', $chunk)) . ')');
        }
        Audit::log('bulk_delete', 'production_entries', null, null, ['filters' => array_filter($q, 'is_scalar'), 'deleted' => count($ids)]);
        return count($ids);
    }
}
