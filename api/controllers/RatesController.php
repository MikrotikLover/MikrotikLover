<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Rates;
use App\Request;
use App\Validator;

/**
 * Statutory rates (EOBI / PESSI / SESSI) and income tax slabs. Effective-dated; rows used by posted
 * salary are locked (App\Rates::assertEditable) so history never changes.
 */
final class RatesController
{
    public function index(Request $r): array
    {
        $sets = [];
        foreach (Database::all('SELECT * FROM tax_slabs ORDER BY effective_from DESC, income_from') as $s) {
            $k = $s['effective_from'];
            $sets[$k] ??= ['effective_from' => $k, 'tax_year' => $s['tax_year'], 'slabs' => []];
            $sets[$k]['slabs'][] = $s;
        }
        return [
            'locked_until' => Rates::lockedUntil(),
            'statutory' => Database::all('SELECT * FROM statutory_rates ORDER BY code, effective_from DESC'),
            'tax_sets' => array_values($sets),
        ];
    }

    private function statutoryData(Request $r): array
    {
        $d = Validator::make($r->body(), [
            'code' => 'required|in:' . implode(',', Rates::CODES),
            'effective_from' => 'required|date',
            'calc_method' => 'required|in:' . implode(',', Rates::METHODS),
            'employee_share' => 'required|num|min:0|max:100000',
            'employer_share' => 'required|num|min:0|max:100000',
            'min_wage' => 'nullable|num|min:0|max:100000000',
            'wage_ceiling' => 'nullable|num|min:0|max:100000000',
            'remarks' => 'nullable|string|max:255',
        ], ['code' => 'Scheme', 'effective_from' => 'Effective from', 'calc_method' => 'Method', 'employee_share' => 'Employee share',
            'employer_share' => 'Employer share', 'min_wage' => 'Minimum wage', 'wage_ceiling' => 'Wage ceiling']);
        if ($d['calc_method'] !== 'fixed' && ((float)$d['employee_share'] > 100 || (float)$d['employer_share'] > 100)) {
            throw ApiException::validation(['employee_share' => 'A percentage cannot exceed 100.']);
        }
        if ($d['calc_method'] === 'percent_of_min_wage' && empty($d['min_wage'])) {
            throw ApiException::validation(['min_wage' => 'Enter the minimum wage this percentage applies to.']);
        }
        return $d;
    }

    public function storeStatutory(Request $r): array
    {
        $d = $this->statutoryData($r);
        $this->assertUnique($d['code'], $d['effective_from'], null);
        $id = Database::insert('statutory_rates', $d + ['created_by' => Auth::id()]);
        Audit::log('create', 'statutory_rates', $id, null, $d);
        return Database::one('SELECT * FROM statutory_rates WHERE id = ?', [$id]);
    }

    public function updateStatutory(Request $r): array
    {
        $old = $this->findStatutory($r->id());
        Rates::assertEditable($old['effective_from'], $old['created_at']);
        $d = $this->statutoryData($r);
        $this->assertUnique($d['code'], $d['effective_from'], (int)$old['id']);
        Database::update('statutory_rates', $d + ['updated_by' => Auth::id()], 'id = :id', ['id' => $old['id']]);
        Audit::log('update', 'statutory_rates', (int)$old['id'], $old, $d);
        return $this->findStatutory((int)$old['id']);
    }

    public function destroyStatutory(Request $r): array
    {
        $old = $this->findStatutory($r->id());
        Rates::assertEditable($old['effective_from'], $old['created_at']);
        Database::run('DELETE FROM statutory_rates WHERE id = ?', [$old['id']]);
        Audit::log('delete', 'statutory_rates', (int)$old['id'], $old, null);
        return ['deleted' => true];
    }

    private function findStatutory(int $id): array
    {
        return Database::one('SELECT * FROM statutory_rates WHERE id = ?', [$id]) ?? throw ApiException::notFound('Rate');
    }

    private function assertUnique(string $code, string $from, ?int $except): void
    {
        $dup = Database::value('SELECT id FROM statutory_rates WHERE code = ? AND effective_from = ?' . ($except ? ' AND id <> ?' : ''),
            $except ? [$code, $from, $except] : [$code, $from]);
        if ($dup) {
            throw ApiException::validation(['effective_from' => "$code already has a rate effective from this date."]);
        }
    }

    /**
     * Create or replace a slab set: {effective_from, tax_year, original_effective_from?, slabs:[...]}.
     * original_effective_from identifies the set being edited (it may move to a new date).
     */
    public function saveTaxSlabs(Request $r): array
    {
        $d = Validator::make($r->body(), [
            'effective_from' => 'required|date', 'tax_year' => 'required|string|max:9',
            'original_effective_from' => 'nullable|date', 'slabs' => 'required|array',
        ], ['effective_from' => 'Effective from', 'tax_year' => 'Tax year']);
        if (!preg_match('/^\d{4}-\d{2}$/', $d['tax_year'])) {
            throw ApiException::validation(['tax_year' => 'Tax year looks like 2026-27.']);
        }
        try {
            $slabs = Rates::normaliseSlabs($d['slabs']);
        } catch (\InvalidArgumentException $e) {
            throw ApiException::validation(['slabs' => $e->getMessage()], $e->getMessage());
        }
        $orig = $d['original_effective_from'] ?? null;
        if ($orig) {
            $created = Database::value('SELECT MIN(created_at) FROM tax_slabs WHERE effective_from = ?', [$orig]);
            if (!$created) {
                throw ApiException::notFound('Slab set');
            }
            Rates::assertEditable($orig, (string)$created, 'This slab set');
        }
        if ($d['effective_from'] !== $orig && Database::value('SELECT 1 FROM tax_slabs WHERE effective_from = ? LIMIT 1', [$d['effective_from']])) {
            throw ApiException::validation(['effective_from' => 'A slab set with this effective date already exists. Edit that set instead.']);
        }
        Database::transaction(function () use ($d, $slabs, $orig) {
            $old = $orig ? Database::all('SELECT income_from, income_to, fixed_amount, rate_percent FROM tax_slabs WHERE effective_from = ? ORDER BY income_from', [$orig]) : null;
            if ($orig) {
                Database::run('DELETE FROM tax_slabs WHERE effective_from = ?', [$orig]);
            }
            foreach ($slabs as $s) {
                Database::insert('tax_slabs', $s + ['effective_from' => $d['effective_from'], 'tax_year' => $d['tax_year'], 'created_by' => Auth::id()]);
            }
            Audit::log($orig ? 'update' : 'create', 'tax_slabs', null,
                $orig ? ['effective_from' => $orig, 'slabs' => $old] : null,
                ['effective_from' => $d['effective_from'], 'tax_year' => $d['tax_year'], 'slabs' => $slabs]);
        });
        return $this->index($r);
    }

    public function destroyTaxSlabs(Request $r): array
    {
        $from = (string)$r->query('effective_from', '');
        $old = Database::all('SELECT income_from, income_to, fixed_amount, rate_percent, tax_year FROM tax_slabs WHERE effective_from = ? ORDER BY income_from', [$from]);
        if (!$old) {
            throw ApiException::notFound('Slab set');
        }
        Rates::assertEditable($from, (string)Database::value('SELECT MIN(created_at) FROM tax_slabs WHERE effective_from = ?', [$from]), 'This slab set');
        Database::run('DELETE FROM tax_slabs WHERE effective_from = ?', [$from]);
        Audit::log('delete', 'tax_slabs', null, ['effective_from' => $from, 'slabs' => $old], null);
        return $this->index($r);
    }
}
