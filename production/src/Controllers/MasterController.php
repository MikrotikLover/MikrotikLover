<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\Database;
use Prod\InkCompanies;
use Prod\Machines;
use Prod\Masters;
use Prod\Request;
use Prod\Text;

final class MasterController
{
    /** Active names of every list (for the entry form and filters). */
    public function lookups(Request $r): array
    {
        $out = [
            'machines'      => Database::all('SELECT id, name, is_active FROM machines ORDER BY name'),
            'ink_companies' => Database::all('SELECT id, name, is_active FROM ink_companies ORDER BY name'),
        ];
        foreach (array_keys(Masters::KINDS) as $kind) {
            $out[$kind] = Database::all('SELECT id, name, is_active FROM masters WHERE kind = ? ORDER BY name', [$kind]);
        }
        return $out;
    }

    public function index(Request $r): array
    {
        $kind = (string)($r->params['kind'] ?? '');
        Masters::assertKind($kind);
        return ['rows' => Masters::list($kind), 'similar' => Masters::similar($kind)];
    }

    public function store(Request $r): array
    {
        $kind = (string)($r->params['kind'] ?? '');
        Masters::assertKind($kind);
        $name = Text::clean($r->input('name', ''));
        if ($name === '') {
            throw \Prod\ApiException::validation(['name' => 'Name is required.']);
        }
        if (Database::value('SELECT id FROM masters WHERE kind = ? AND name = ?', [$kind, $name])) {
            throw \Prod\ApiException::conflict("\"$name\" already exists.");
        }
        $id = Masters::resolve($kind, $name);
        \Prod\Audit::log('create', 'masters', $id, null, ['kind' => $kind, 'name' => $name]);
        return Masters::find($id);
    }

    public function update(Request $r): array
    {
        $id = $r->id();
        if ($r->input('name') !== null) {
            Masters::rename($id, $r->input('name'));
        }
        if ($r->input('is_active') !== null) {
            Masters::setActive($id, (bool)$r->input('is_active'));
        }
        return Masters::find($id);
    }

    public function merge(Request $r): array
    {
        return ['moved' => Masters::merge($r->id(), (int)$r->input('target_id', 0))];
    }

    public function destroy(Request $r): array
    {
        Masters::delete($r->id());
        return ['deleted' => 1];
    }

    // ---- machines -------------------------------------------------------------------------

    public function machines(Request $r): array
    {
        return Machines::list();
    }

    public function machineStore(Request $r): array
    {
        $raw = $r->input('rate_per_mtr');
        $rate = Text::number($raw);
        if (($rate === null && Text::clean($raw ?? '') !== '') || ($rate !== null && $rate < 0)) {
            throw \Prod\ApiException::validation(['rate_per_mtr' => 'Enter the machine rate in Rs per metre (or leave it empty).']);
        }
        $ink = (string)$r->input('ink_company_id', '');
        return Machines::find(Machines::create($r->input('name', ''), ctype_digit($ink) ? (int)$ink : null, $rate));
    }

    public function machineUpdate(Request $r): array
    {
        $id = $r->id();
        if ($r->input('name') !== null) {
            Machines::rename($id, $r->input('name'));
        }
        if ($r->input('is_active') !== null) {
            Machines::setActive($id, (bool)$r->input('is_active'));
        }
        return Machines::find($id);
    }

    public function machineMerge(Request $r): array
    {
        return ['moved' => Machines::merge($r->id(), (int)$r->input('target_id', 0))];
    }

    public function machineDestroy(Request $r): array
    {
        Machines::delete($r->id());
        return ['deleted' => 1];
    }

    public function rateStore(Request $r): array
    {
        Machines::saveRate($r->id(), $r->input('effective_from'), $r->input('rate_per_mtr'), $r->input('note', ''));
        return ['ok' => 1];
    }

    public function rateDestroy(Request $r): array
    {
        Machines::deleteRate($r->id(), $r->id('rid'));
        return ['ok' => 1];
    }

    public function inkStore(Request $r): array
    {
        Machines::saveInk($r->id(), $r->input('effective_from'), $r->input('ink_company_id'));
        return ['ok' => 1];
    }

    public function inkDestroy(Request $r): array
    {
        Machines::deleteInk($r->id(), $r->id('iid'));
        return ['ok' => 1];
    }

    // ---- ink companies --------------------------------------------------------------------

    public function inkCompanies(Request $r): array
    {
        return InkCompanies::list();
    }

    public function inkCompanyStore(Request $r): array
    {
        return InkCompanies::find(InkCompanies::create($r->input('name', ''), $r->input('rate_per_litre')));
    }

    public function inkCompanyUpdate(Request $r): array
    {
        InkCompanies::update($r->id(), $r->body());
        return InkCompanies::find($r->id());
    }

    public function inkCompanyDestroy(Request $r): array
    {
        InkCompanies::delete($r->id());
        return ['deleted' => 1];
    }

    public function inkRateStore(Request $r): array
    {
        InkCompanies::saveRate($r->id(), $r->input('effective_from'), $r->input('rate_per_litre'), $r->input('note', ''));
        return ['ok' => 1];
    }

    public function inkRateDestroy(Request $r): array
    {
        InkCompanies::deleteRate($r->id(), $r->id('rid'));
        return ['ok' => 1];
    }
}
