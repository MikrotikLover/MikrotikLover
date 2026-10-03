<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\Request;
use App\Validator;
use App\Vouchers;

/**
 * Journal Voucher: double entry. Each line has an account, optional employee, and either a debit or a
 * credit. Total debit must equal total credit (enforced on save and again on posting). Salary
 * posting (batch 4) creates system JVs through Vouchers::writeJournal().
 */
final class JournalController
{
    public function index(Request $r): array
    {
        $rows = VoucherController::listRows('JV', $r);
        if ($rows) {
            $ids = implode(',', array_map(fn($x) => (int)$x['id'], $rows));
            $totals = [];
            foreach (Database::all("SELECT voucher_id, SUM(debit) dr, COUNT(*) n FROM journal_entries WHERE voucher_id IN ($ids) GROUP BY voucher_id") as $t) {
                $totals[(int)$t['voucher_id']] = $t;
            }
            foreach ($rows as &$row) {
                $row['lines'] = (int)($totals[(int)$row['id']]['n'] ?? 0);
            }
        }
        return $rows;
    }

    public function show(Request $r): array
    {
        $v = Vouchers::find($r->id(), 'JV');
        $v['lines'] = Vouchers::journal((int)$v['id']);
        return $v;
    }

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        $v = Vouchers::find($r->id(), 'JV');
        Vouchers::assertDraft($v);
        return $this->save($r, $v);
    }

    private function save(Request $r, ?array $old): array
    {
        if ($r->input('post') && !Auth::can('journal', 'post')) {
            throw ApiException::forbidden('You may save this journal voucher as a draft but not post it.');
        }
        $d = Validator::make($r->body(), ['vr_date' => 'required|date', 'remarks' => 'nullable|string|max:255', 'lines' => 'required|array'],
            ['vr_date' => 'Date', 'remarks' => 'Narration']);
        $lines = [];
        $errors = [];
        foreach (array_values($d['lines']) as $i => $l) {
            $n = $i + 1;
            $dr = is_numeric($l['debit'] ?? null) ? round((float)$l['debit'], 2) : 0.0;
            $cr = is_numeric($l['credit'] ?? null) ? round((float)$l['credit'], 2) : 0.0;
            $acc = (int)($l['account_id'] ?? 0);
            if (!$acc && $dr == 0 && $cr == 0) {
                continue; // blank row
            }
            if (!$acc || !Database::value('SELECT 1 FROM accounts WHERE id = ? AND is_active = 1', [$acc])) {
                $errors['lines'] = "Line $n: select an active account.";
                break;
            }
            if ($dr < 0 || $cr < 0 || ($dr > 0) === ($cr > 0)) {
                $errors['lines'] = "Line $n: enter either a debit or a credit amount (not both).";
                break;
            }
            $emp = isset($l['employee_id']) && $l['employee_id'] !== '' && $l['employee_id'] !== null ? (int)$l['employee_id'] : null;
            if ($emp && !Database::value('SELECT 1 FROM employees WHERE id = ?', [$emp])) {
                $errors['lines'] = "Line $n: employee not found.";
                break;
            }
            $lines[] = ['account_id' => $acc, 'employee_id' => $emp, 'debit' => $dr, 'credit' => $cr,
                        'narration' => trim((string)($l['narration'] ?? '')) ?: null];
        }
        if (!$errors && count($lines) < 2) {
            $errors['lines'] = 'A journal voucher needs at least two lines.';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        $total = round(array_sum(array_column($lines, 'debit')), 2);
        $id = Database::transaction(function () use ($d, $lines, $total, $old) {
            $data = ['vr_date' => $d['vr_date'], 'remarks' => $d['remarks'], 'amount' => $total];
            if ($old) {
                $id = (int)$old['id'];
                Database::update('vouchers', $data + ['updated_by' => Auth::id()], 'id = :id', ['id' => $id]);
            } else {
                $id = Database::insert('vouchers', $data + ['voucher_type' => 'JV', 'vr_no' => Vouchers::nextNo('JV'), 'status' => 'draft', 'created_by' => Auth::id()]);
            }
            Vouchers::writeJournal($id, $lines); // throws when debit <> credit (transaction rolls back)
            Audit::log($old ? 'update' : 'create', 'vouchers', $id, $old ? ['amount' => $old['amount']] : null, $data + ['lines' => count($lines)]);
            return $id;
        });
        if ($r->input('post')) {
            Vouchers::post(Vouchers::find($id, 'JV'));
        }
        $r->params['id'] = (string)$id;
        return $this->show($r);
    }
}
