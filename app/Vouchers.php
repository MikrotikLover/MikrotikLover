<?php
declare(strict_types=1);

namespace App;

/**
 * Typed vouchers: ADV advance, INC incentive, PEN penalty, OT overtime, LOAN loan, JV journal.
 *
 * Life cycle: Draft (editable, hard delete) -> Posted (locked). A posted voucher can be unposted
 * or deleted (soft delete) only while payroll has not consumed it and its salary month is not
 * posted. Accounting on posting:
 *   ADV   Dr Employee Advances / Cr cash or bank (pay account)
 *   LOAN  Dr Employee Loans    / Cr cash or bank
 *   JV    the operator's balanced lines (Dr = Cr)
 *   INC / PEN / OT are salary adjustments: accounted in the salary JV when the sheet is posted.
 * Payroll (batch 4) picks posted ADV / INC / PEN / OT vouchers by their salary (deduct) month
 * and loan installments by due month.
 */
final class Vouchers
{
    public const TYPES = [
        'ADV'  => ['label' => 'Employee Advance', 'module' => 'vouchers', 'prefix' => 'ADV'],
        'INC'  => ['label' => 'Incentive',        'module' => 'vouchers', 'prefix' => 'INC'],
        'PEN'  => ['label' => 'Penalty',          'module' => 'vouchers', 'prefix' => 'PEN'],
        'OT'   => ['label' => 'Overtime',         'module' => 'vouchers', 'prefix' => 'OT'],
        'LOAN' => ['label' => 'Loan',             'module' => 'loans',    'prefix' => 'LN'],
        'JV'   => ['label' => 'Journal Voucher',  'module' => 'journal',  'prefix' => 'JV'],
    ];

    public static function label(string $type): string
    {
        return self::TYPES[$type]['label'] ?? $type;
    }

    public static function number(string $type, int|string $no): string
    {
        return (self::TYPES[$type]['prefix'] ?? $type) . '-' . str_pad((string)$no, 4, '0', STR_PAD_LEFT);
    }

    public static function nextNo(string $type): int
    {
        return Database::nextSequence('VR-' . $type, 0);
    }

    public static function find(int $id, ?string $type = null): array
    {
        $v = Database::one(
            'SELECT v.*, e.code, e.name, e.name_ur, e.emp_type, e.department_id, d.name AS department, g.name AS designation,
                    a.code AS pay_account_code, a.name AS pay_account,
                    cu.full_name AS created_by_name, pu.full_name AS posted_by_name
               FROM vouchers v
          LEFT JOIN employees e ON e.id = v.employee_id
          LEFT JOIN departments d ON d.id = e.department_id
          LEFT JOIN designations g ON g.id = e.designation_id
          LEFT JOIN accounts a ON a.id = v.pay_account_id
          LEFT JOIN users cu ON cu.id = v.created_by
          LEFT JOIN users pu ON pu.id = v.posted_by
              WHERE v.id = ? AND v.deleted_at IS NULL' . ($type ? ' AND v.voucher_type = ?' : ''),
            $type ? [$id, $type] : [$id]
        );
        if (!$v) {
            throw ApiException::notFound(($type ? self::label($type) : 'Voucher'));
        }
        $v['number'] = self::number($v['voucher_type'], $v['vr_no']);
        $v['locked_reason'] = self::lockReason($v);
        return $v;
    }

    /** Why a posted voucher can no longer be changed (null = can be unposted / deleted). */
    public static function lockReason(array $v): ?string
    {
        if ($v['salary_sheet_id']) {
            return 'Used in a salary sheet.';
        }
        if ($v['voucher_type'] === 'LOAN') {
            $n = (int)Database::value(
                "SELECT COUNT(*) FROM loan_installments li JOIN loans l ON l.id = li.loan_id
                  WHERE l.voucher_id = ? AND (li.status = 'deducted' OR li.salary_sheet_id IS NOT NULL)",
                [$v['id']]
            );
            if ($n) {
                return "$n installment(s) already deducted in payroll.";
            }
        }
        if ($v['employee_id'] && $v['deduct_month'] && PayrollLock::isLocked((string)$v['emp_type'], $v['deduct_month'])) {
            return 'Salary month ' . date('M Y', strtotime($v['deduct_month'])) . ' is posted.';
        }
        return null;
    }

    public static function assertDraft(array $v): void
    {
        if ($v['is_system']) {
            throw ApiException::conflict('System vouchers (salary posting) cannot be changed here.');
        }
        if ($v['status'] !== 'draft') {
            throw ApiException::conflict('Posted vouchers cannot be edited. Unpost it first.');
        }
    }

    /** Salary month must not be posted already for this employee type. */
    public static function assertMonthOpen(?array $emp, ?string $month): void
    {
        if ($emp && $month && PayrollLock::isLocked($emp['emp_type'], $month)) {
            throw ApiException::validation(['deduct_month' => 'Salary for ' . date('F Y', strtotime($month)) . ' is already posted. Choose a later month.']);
        }
    }

    public static function systemAccount(string $key): int
    {
        $id = Database::value('SELECT id FROM accounts WHERE system_key = ?', [$key]);
        if (!$id) {
            throw ApiException::conflict("Account with system key \"$key\" is missing from the chart of accounts.");
        }
        return (int)$id;
    }

    /** Replace journal lines of a voucher. @param list<array{account_id:int,employee_id?:?int,debit:float,credit:float,narration?:?string}> $lines */
    public static function writeJournal(int $voucherId, array $lines): void
    {
        $dr = round(array_sum(array_column($lines, 'debit')), 2);
        $cr = round(array_sum(array_column($lines, 'credit')), 2);
        if ($dr <= 0 || abs($dr - $cr) > 0.001) {
            throw ApiException::validation(['lines' => sprintf('Debit (%s) must equal credit (%s).', number_format($dr, 2), number_format($cr, 2))]);
        }
        Database::run('DELETE FROM journal_entries WHERE voucher_id = ?', [$voucherId]);
        foreach (array_values($lines) as $i => $l) {
            Database::insert('journal_entries', [
                'voucher_id' => $voucherId, 'line_no' => $i + 1, 'account_id' => (int)$l['account_id'],
                'employee_id' => $l['employee_id'] ?? null, 'debit' => round((float)$l['debit'], 2), 'credit' => round((float)$l['credit'], 2),
                'narration' => isset($l['narration']) && $l['narration'] !== '' ? mb_substr((string)$l['narration'], 0, 255) : null,
            ]);
        }
    }

    public static function journal(int $voucherId): array
    {
        return Database::all(
            'SELECT j.line_no, j.account_id, a.code AS account_code, a.name AS account, j.employee_id, e.code AS employee_code,
                    e.name AS employee, j.debit, j.credit, j.narration
               FROM journal_entries j JOIN accounts a ON a.id = j.account_id LEFT JOIN employees e ON e.id = j.employee_id
              WHERE j.voucher_id = ? ORDER BY j.line_no',
            [$voucherId]
        );
    }

    /** Post: lock + accounting entries for ADV / LOAN; JV must already balance. */
    public static function post(array $v): void
    {
        self::assertDraft($v);
        if ($v['employee_id']) {
            $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$v['employee_id']]);
            self::assertMonthOpen($emp, $v['deduct_month']);
        }
        Database::transaction(function () use ($v) {
            $type = $v['voucher_type'];
            if ($type === 'ADV' || $type === 'LOAN') {
                $acc = self::systemAccount($type === 'ADV' ? 'employee_advances' : 'employee_loans');
                $pay = $v['pay_account_id'] ? (int)$v['pay_account_id'] : self::systemAccount('cash');
                $text = self::label($type) . ' ' . self::number($type, $v['vr_no']) . ' - ' . $v['code'] . ' ' . $v['name'];
                self::writeJournal((int)$v['id'], [
                    ['account_id' => $acc, 'employee_id' => (int)$v['employee_id'], 'debit' => (float)$v['amount'], 'credit' => 0, 'narration' => $text],
                    ['account_id' => $pay, 'employee_id' => null, 'debit' => 0, 'credit' => (float)$v['amount'], 'narration' => $text],
                ]);
            } elseif ($type === 'JV') {
                $t = Database::one('SELECT COUNT(*) n, SUM(debit) dr, SUM(credit) cr FROM journal_entries WHERE voucher_id = ?', [$v['id']]);
                if ((int)$t['n'] < 2 || abs((float)$t['dr'] - (float)$t['cr']) > 0.001 || (float)$t['dr'] <= 0) {
                    throw ApiException::validation(['lines' => 'The journal voucher is not balanced.']);
                }
            }
            Database::update('vouchers', ['status' => 'posted', 'posted_by' => Auth::id(), 'posted_at' => date('Y-m-d H:i:s'), 'updated_by' => Auth::id()],
                'id = :id', ['id' => $v['id']]);
            if ($type === 'LOAN') {
                Database::run("UPDATE loans SET status = 'active', updated_by = ? WHERE voucher_id = ?", [Auth::id(), $v['id']]);
            }
            Audit::log('post', 'vouchers', (int)$v['id'], ['status' => 'draft'], ['status' => 'posted', 'number' => self::number($type, $v['vr_no'])]);
        });
    }

    public static function unpost(array $v): void
    {
        if ($v['status'] !== 'posted' || $v['is_system']) {
            throw ApiException::conflict('Only posted, non-system vouchers can be unposted.');
        }
        if ($reason = self::lockReason($v)) {
            throw ApiException::conflict("Cannot unpost: $reason");
        }
        Database::transaction(function () use ($v) {
            if (in_array($v['voucher_type'], ['ADV', 'LOAN'], true)) {
                Database::run('DELETE FROM journal_entries WHERE voucher_id = ?', [$v['id']]);
            }
            Database::update('vouchers', ['status' => 'draft', 'posted_by' => null, 'posted_at' => null, 'updated_by' => Auth::id()], 'id = :id', ['id' => $v['id']]);
            Audit::log('unpost', 'vouchers', (int)$v['id'], ['status' => 'posted'], ['status' => 'draft']);
        });
    }

    /** Draft: hard delete. Posted: soft delete (kept for the audit trail, excluded everywhere). */
    public static function delete(array $v): string
    {
        if ($v['is_system']) {
            throw ApiException::conflict('System vouchers (salary posting) cannot be deleted here.');
        }
        if ($v['status'] === 'posted' && ($reason = self::lockReason($v))) {
            throw ApiException::conflict("Cannot delete: $reason");
        }
        return Database::transaction(function () use ($v) {
            if ($v['status'] === 'draft') {
                Database::run('DELETE li FROM loan_installments li JOIN loans l ON l.id = li.loan_id WHERE l.voucher_id = ?', [$v['id']]);
                Database::run('DELETE FROM loans WHERE voucher_id = ?', [$v['id']]);
                Database::run('DELETE FROM vouchers WHERE id = ?', [$v['id']]); // journal lines cascade
                Audit::log('delete', 'vouchers', (int)$v['id'], self::snapshot($v), null);
                return 'deleted';
            }
            Database::update('vouchers', ['deleted_at' => date('Y-m-d H:i:s'), 'deleted_by' => Auth::id()], 'id = :id', ['id' => $v['id']]);
            Database::run("UPDATE loans SET status = 'closed', remarks = CONCAT(COALESCE(remarks,''), ' [voucher deleted]') WHERE voucher_id = ?", [$v['id']]);
            Audit::log('soft_delete', 'vouchers', (int)$v['id'], self::snapshot($v), ['deleted_at' => date('Y-m-d H:i:s')]);
            return 'soft_deleted';
        });
    }

    private static function snapshot(array $v): array
    {
        return array_intersect_key($v, array_flip(['voucher_type', 'vr_no', 'vr_date', 'employee_id', 'amount', 'ot_hours', 'deduct_month', 'status', 'remarks']));
    }

    // ------------------------------------------------------------------ loans

    /** Rebuild the 'scheduled' installments of a loan around its fixed (deducted / adjusted / skipped) months. */
    public static function reschedule(int $loanId): void
    {
        $loan = Database::one('SELECT * FROM loans WHERE id = ?', [$loanId]);
        $fixed = [];
        foreach (Database::all("SELECT * FROM loan_installments WHERE loan_id = ? AND status <> 'scheduled'", [$loanId]) as $r) {
            $fixed[$r['due_month']] = [
                'status' => $r['status'],
                'amount' => $r['status'] === 'deducted' ? (float)$r['deducted_amount'] : ($r['status'] === 'skipped' ? 0.0 : (float)$r['scheduled_amount']),
            ];
        }
        try {
            $plan = LoanSchedule::build((float)$loan['amount'], (float)$loan['installment'], $loan['start_month'], $fixed);
        } catch (\InvalidArgumentException $e) {
            throw ApiException::validation(['amount' => $e->getMessage()]);
        }
        Database::run("DELETE FROM loan_installments WHERE loan_id = ? AND status = 'scheduled'", [$loanId]);
        foreach ($plan as $p) {
            if ($p['status'] === 'scheduled') {
                Database::insert('loan_installments', [
                    'loan_id' => $loanId, 'due_month' => $p['month'], 'scheduled_amount' => $p['amount'], 'status' => 'scheduled', 'created_by' => Auth::id(),
                ]);
            }
        }
        $balance = (float)$loan['amount'] - (float)Database::value('SELECT COALESCE(SUM(deducted_amount),0) FROM loan_installments WHERE loan_id = ?', [$loanId]);
        Database::run('UPDATE loans SET status = ? WHERE id = ?', [$balance <= 0.001 ? 'closed' : 'active', $loanId]);
    }

    public static function loanSummary(int $loanId): array
    {
        return Database::one(
            "SELECT l.*, COALESCE(SUM(li.deducted_amount),0) AS deducted,
                    l.amount - COALESCE(SUM(li.deducted_amount),0) AS balance,
                    MIN(CASE WHEN li.status IN ('scheduled','adjusted') THEN li.due_month END) AS next_month,
                    COUNT(CASE WHEN li.status IN ('scheduled','adjusted') THEN 1 END) AS remaining_installments
               FROM loans l LEFT JOIN loan_installments li ON li.loan_id = l.id WHERE l.id = ? GROUP BY l.id",
            [$loanId]
        ) ?? [];
    }
}
