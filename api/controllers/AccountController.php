<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Database;
use App\Request;

/** Chart of accounts. Accounts with a system key are used by automatic postings and cannot be deleted. */
final class AccountController extends CrudController
{
    protected string $table = 'accounts';
    protected string $label = 'Account';
    protected array $rules = [
        'code'         => 'required|code|max:20',
        'name'         => 'required|string|max:100',
        'account_type' => 'required|in:asset,liability,equity,income,expense',
        'is_active'    => 'bool',
    ];
    protected array $unique = ['code' => 'Code'];
    protected string $orderBy = 'code';

    protected function baseSelect(): string
    {
        return 'SELECT t.*, (SELECT COALESCE(SUM(j.debit - j.credit), 0) FROM journal_entries j
                               JOIN vouchers v ON v.id = j.voucher_id
                              WHERE j.account_id = t.id AND v.status = \'posted\' AND v.deleted_at IS NULL) AS balance
                  FROM accounts t';
    }

    protected function beforeSave(array $data, ?array $existing, Request $r): array
    {
        if ($existing && $existing['system_key']) {
            if ($data['account_type'] !== $existing['account_type']) {
                throw ApiException::validation(['account_type' => 'The type of a system account cannot be changed.']);
            }
            if (!$data['is_active']) {
                throw ApiException::validation(['is_active' => 'System accounts are used by automatic postings and must stay active.']);
            }
        }
        return $data;
    }

    public function destroy(Request $r): array
    {
        $row = $this->rawFind($r->id());
        if ($row['system_key']) {
            throw ApiException::conflict('System accounts are used by automatic postings and cannot be deleted.');
        }
        if (Database::value('SELECT 1 FROM journal_entries WHERE account_id = ? LIMIT 1', [$row['id']])
            || Database::value('SELECT 1 FROM vouchers WHERE pay_account_id = ? LIMIT 1', [$row['id']])) {
            throw ApiException::conflict('This account has entries and cannot be deleted. Mark it inactive instead.');
        }
        return parent::destroy($r);
    }
}
