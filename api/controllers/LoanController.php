<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Auth;
use App\Database;
use App\LoanSchedule;
use App\PayrollLock;
use App\Request;
use App\Validator;
use App\Vouchers;

/**
 * Loan Voucher: amount, monthly installment, start month -> installment schedule. Each salary
 * deducts the installment of its month (batch 4); installments can be skipped or adjusted, and the
 * remaining balance is re-spread over the following months.
 */
final class LoanController
{
    public function index(Request $r): array
    {
        $where = ['v.deleted_at IS NULL'];
        $params = [];
        $status = (string)$r->query('status', '');
        if (in_array($status, ['active', 'closed'], true)) {
            $where[] = 'l.status = :s';
            $params['s'] = $status;
        }
        if (($q = (string)$r->query('q', '')) !== '') {
            $where[] = '(e.code LIKE :q1 OR e.name LIKE :q2)';
            $params += ['q1' => "%$q%", 'q2' => "%$q%"];
        }
        if ($e = $r->queryInt('employee_id')) {
            $where[] = 'l.employee_id = :e';
            $params['e'] = $e;
        }
        $rows = Database::all(
            "SELECT l.id, l.voucher_id, v.vr_no, v.vr_date, v.status AS voucher_status, l.employee_id, e.code, e.name, d.name AS department,
                    l.amount, l.installment, l.start_month, l.status,
                    COALESCE(SUM(li.deducted_amount), 0) AS deducted,
                    l.amount - COALESCE(SUM(li.deducted_amount), 0) AS balance,
                    MIN(CASE WHEN li.status IN ('scheduled','adjusted') THEN li.due_month END) AS next_month
               FROM loans l
               JOIN vouchers v ON v.id = l.voucher_id
               JOIN employees e ON e.id = l.employee_id
               JOIN departments d ON d.id = e.department_id
          LEFT JOIN loan_installments li ON li.loan_id = l.id
              WHERE " . implode(' AND ', $where) . '
           GROUP BY l.id ORDER BY v.vr_date DESC, v.vr_no DESC LIMIT 2000',
            $params
        );
        foreach ($rows as &$row) {
            $row['number'] = Vouchers::number('LOAN', $row['vr_no']);
        }
        return $rows;
    }

    private function loanByVoucher(int $voucherId): array
    {
        $loan = Database::one('SELECT * FROM loans WHERE voucher_id = ?', [$voucherId]);
        if (!$loan) {
            throw ApiException::notFound('Loan');
        }
        return $loan;
    }

    /** {id} = voucher id */
    public function show(Request $r): array
    {
        $v = Vouchers::find($r->id(), 'LOAN');
        $loan = $this->loanByVoucher((int)$v['id']);
        $v['loan'] = Vouchers::loanSummary((int)$loan['id']);
        $v['installments'] = Database::all(
            'SELECT li.*, s.status AS sheet_status FROM loan_installments li LEFT JOIN salary_sheets s ON s.id = li.salary_sheet_id
              WHERE li.loan_id = ? ORDER BY li.due_month',
            [$loan['id']]
        );
        foreach ($v['installments'] as &$i) {
            $i['locked'] = $i['status'] === 'deducted' || $i['salary_sheet_id'] || PayrollLock::isLocked((string)$v['emp_type'], $i['due_month']);
        }
        $v['journal'] = Vouchers::journal((int)$v['id']);
        return $v;
    }

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        $v = Vouchers::find($r->id(), 'LOAN');
        Vouchers::assertDraft($v);
        return $this->save($r, $v);
    }

    private function save(Request $r, ?array $old): array
    {
        $body = $r->body();
        if (isset($body['start_month']) && is_string($body['start_month']) && preg_match('/^\d{4}-\d{2}$/', $body['start_month'])) {
            $body['start_month'] .= '-01';
        }
        $d = Validator::make($body, [
            'vr_date'        => 'required|date',
            'employee_id'    => 'required|int|exists:employees',
            'amount'         => 'required|int|min:1|max:99999999',
            'installment'    => 'required|int|min:1|max:99999999',
            'start_month'    => 'required|date',
            'pay_account_id' => 'nullable|int|exists:accounts',
            'remarks'        => 'nullable|string|max:255',
        ], ['start_month' => 'First deduction month', 'pay_account_id' => 'Paid from', 'vr_date' => 'Date']);
        $d['start_month'] = LoanSchedule::month($d['start_month']);
        $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$d['employee_id']]);
        $errors = [];
        if ($d['installment'] > $d['amount']) {
            $errors['installment'] = 'Installment cannot be more than the loan amount.';
        }
        if ($d['vr_date'] < $emp['joining_date'] || ($emp['leaving_date'] && $d['vr_date'] > $emp['leaving_date'])) {
            $errors['employee_id'] = "{$emp['code']} {$emp['name']} is not employed on this date.";
        }
        if ($d['start_month'] < LoanSchedule::month($d['vr_date'])) {
            $errors['start_month'] = 'First deduction month cannot be before the loan date.';
        }
        if (LoanSchedule::count($d['amount'], $d['installment']) > 120) {
            $errors['installment'] = 'More than 120 installments; increase the installment.';
        }
        $d['pay_account_id'] = $d['pay_account_id'] ?? Vouchers::systemAccount('cash');
        if (Database::value('SELECT account_type FROM accounts WHERE id = ?', [$d['pay_account_id']]) !== 'asset') {
            $errors['pay_account_id'] = 'Paid-from account must be a cash / bank (asset) account.';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        if (PayrollLock::isLocked($emp['emp_type'], $d['start_month'])) {
            throw ApiException::validation(['start_month' => 'Salary for ' . date('F Y', strtotime($d['start_month'])) . ' is already posted.']);
        }

        $vid = Database::transaction(function () use ($d, $old) {
            $vData = ['vr_date' => $d['vr_date'], 'employee_id' => $d['employee_id'], 'amount' => $d['amount'], 'deduct_month' => $d['start_month'],
                      'pay_account_id' => $d['pay_account_id'], 'remarks' => $d['remarks']];
            $lData = ['employee_id' => $d['employee_id'], 'amount' => $d['amount'], 'installment' => $d['installment'],
                      'start_month' => $d['start_month'], 'remarks' => $d['remarks']];
            if ($old) {
                $vid = (int)$old['id'];
                Database::update('vouchers', $vData + ['updated_by' => Auth::id()], 'id = :id', ['id' => $vid]);
                $loan = $this->loanByVoucher($vid);
                Database::update('loans', $lData + ['updated_by' => Auth::id()], 'id = :id', ['id' => $loan['id']]);
                Database::run('DELETE FROM loan_installments WHERE loan_id = ?', [$loan['id']]); // draft: rebuild from scratch
                Audit::log('update', 'loans', (int)$loan['id'], $old, $d);
                $loanId = (int)$loan['id'];
            } else {
                $vid = Database::insert('vouchers', $vData + ['voucher_type' => 'LOAN', 'vr_no' => Vouchers::nextNo('LOAN'), 'status' => 'draft', 'created_by' => Auth::id()]);
                $loanId = Database::insert('loans', $lData + ['voucher_id' => $vid, 'status' => 'active', 'created_by' => Auth::id()]);
                Audit::log('create', 'loans', $loanId, null, $d);
            }
            Vouchers::reschedule($loanId);
            return $vid;
        });
        if ($r->input('post')) {
            Vouchers::post(Vouchers::find($vid, 'LOAN'));
        }
        $r->params['id'] = (string)$vid;
        return $this->show($r);
    }

    /** POST /loans/{id}/installments/{iid} {action: skip|adjust|reset, amount} */
    public function installment(Request $r): array
    {
        $v = Vouchers::find($r->id(), 'LOAN');
        $loan = $this->loanByVoucher((int)$v['id']);
        $inst = Database::one('SELECT * FROM loan_installments WHERE id = ? AND loan_id = ?', [$r->id('iid'), $loan['id']]);
        if (!$inst) {
            throw ApiException::notFound('Installment');
        }
        if ($inst['status'] === 'deducted' || $inst['salary_sheet_id']) {
            throw ApiException::conflict('This installment is already deducted in payroll.');
        }
        PayrollLock::assertOpen((string)$v['emp_type'], $inst['due_month'], 'The installment');
        $action = (string)$r->input('action');
        $remarks = trim((string)$r->input('remarks', ''));
        $upd = match ($action) {
            'skip' => ['status' => 'skipped', 'scheduled_amount' => 0],
            'reset' => ['status' => 'scheduled'],
            'adjust' => (function () use ($r, $loan, $inst) {
                $amt = $r->input('amount');
                if (!is_numeric($amt) || (int)$amt != $amt || (int)$amt < 1) {
                    throw ApiException::validation(['amount' => 'Enter the installment in whole rupees (at least 1).']);
                }
                $otherFixed = (float)Database::value(
                    "SELECT COALESCE(SUM(CASE WHEN status = 'deducted' THEN deducted_amount WHEN status = 'adjusted' THEN scheduled_amount ELSE 0 END), 0)
                       FROM loan_installments WHERE loan_id = ? AND id <> ?",
                    [$loan['id'], $inst['id']]
                );
                $max = (float)$loan['amount'] - $otherFixed;
                if ((int)$amt > $max) {
                    throw ApiException::validation(['amount' => 'Installment cannot exceed the remaining balance (' . number_format($max) . ').']);
                }
                return ['status' => 'adjusted', 'scheduled_amount' => (int)$amt];
            })(),
            default => throw ApiException::validation(['action' => 'Choose skip, adjust or reset.']),
        };
        if ($remarks !== '') {
            $upd['remarks'] = mb_substr($remarks, 0, 255);
        }
        Database::transaction(function () use ($inst, $upd, $loan, $action) {
            Database::update('loan_installments', $upd + ['updated_by' => Auth::id()], 'id = :id', ['id' => $inst['id']]);
            Vouchers::reschedule((int)$loan['id']);
            Audit::log('installment_' . $action, 'loan_installments', (int)$inst['id'], $inst, $upd);
        });
        return $this->show($r);
    }
}
