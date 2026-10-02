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
 * Employee vouchers: /vouchers/{adv|inc|pen|ot}
 *   ADV  Employee Advance  - deducted in full from the salary of its deduct month
 *   INC  Incentive         - added to that month's salary
 *   PEN  Penalty           - deducted from that month's salary
 *   OT   Overtime voucher  - extra OT hours (paid at the employee's OT rate) and/or a fixed amount
 * Shared post / unpost / delete / neighbor endpoints also serve LOAN and JV (by id).
 */
class VoucherController
{
    protected const EMPLOYEE_TYPES = ['adv' => 'ADV', 'inc' => 'INC', 'pen' => 'PEN', 'ot' => 'OT'];

    protected function type(Request $r): string
    {
        $t = self::EMPLOYEE_TYPES[strtolower($r->param('type'))] ?? null;
        if (!$t) {
            throw ApiException::notFound('Voucher type');
        }
        return $t;
    }

    public function index(Request $r): array
    {
        $type = $this->type($r);
        return self::listRows($type, $r);
    }

    public static function listRows(string $type, Request $r): array
    {
        $where = ['v.voucher_type = :t', 'v.deleted_at IS NULL'];
        $params = ['t' => $type];
        $from = (string)$r->query('from', '');
        $to = (string)$r->query('to', '');
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $from)) {
            $where[] = 'v.vr_date >= :f';
            $params['f'] = $from;
        }
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $to)) {
            $where[] = 'v.vr_date <= :to';
            $params['to'] = $to;
        }
        $month = (string)$r->query('month', '');
        if (preg_match('/^\d{4}-\d{2}$/', $month)) {
            $where[] = 'v.deduct_month = :m';
            $params['m'] = "$month-01";
        }
        $status = (string)$r->query('status', '');
        if (in_array($status, ['draft', 'posted'], true)) {
            $where[] = 'v.status = :s';
            $params['s'] = $status;
        }
        if ($e = $r->queryInt('employee_id')) {
            $where[] = 'v.employee_id = :e';
            $params['e'] = $e;
        }
        if (($q = (string)$r->query('q', '')) !== '') {
            $where[] = '(e.code LIKE :q1 OR e.name LIKE :q2 OR v.remarks LIKE :q3 OR v.vr_no = :q4)';
            $params += ['q1' => "%$q%", 'q2' => "%$q%", 'q3' => "%$q%", 'q4' => ctype_digit($q) ? (int)$q : -1];
        }
        $rows = Database::all(
            'SELECT v.id, v.voucher_type, v.vr_no, v.vr_date, v.employee_id, e.code, e.name, d.name AS department, v.amount, v.ot_hours,
                    v.deduct_month, v.status, v.salary_sheet_id, v.remarks, v.is_system
               FROM vouchers v
          LEFT JOIN employees e ON e.id = v.employee_id
          LEFT JOIN departments d ON d.id = e.department_id
              WHERE ' . implode(' AND ', $where) . ' ORDER BY v.vr_date DESC, v.vr_no DESC LIMIT 2000',
            $params
        );
        foreach ($rows as &$row) {
            $row['number'] = Vouchers::number($row['voucher_type'], $row['vr_no']);
        }
        return $rows;
    }

    public function show(Request $r): array
    {
        return Vouchers::find($r->id(), $this->type($r));
    }

    public function store(Request $r): array
    {
        return $this->save($r, null);
    }

    public function update(Request $r): array
    {
        $type = $this->type($r);
        $v = Vouchers::find($r->id(), $type);
        Vouchers::assertDraft($v);
        return $this->save($r, $v);
    }

    protected function save(Request $r, ?array $old): array
    {
        $type = $this->type($r);
        $body = $r->body();
        if (isset($body['deduct_month']) && is_string($body['deduct_month']) && preg_match('/^\d{4}-\d{2}$/', $body['deduct_month'])) {
            $body['deduct_month'] .= '-01';
        }
        $rules = [
            'vr_date'      => 'required|date',
            'employee_id'  => 'required|int|exists:employees',
            'deduct_month' => 'required|date',
            'remarks'      => 'nullable|string|max:255',
        ];
        $rules['amount'] = $type === 'OT' ? 'required|int|min:0|max:99999999' : 'required|int|min:1|max:99999999';
        if ($type === 'OT') {
            $rules['ot_hours'] = 'required|num|min:0|max:744';
        }
        if ($type === 'ADV') {
            $rules['pay_account_id'] = 'nullable|int|exists:accounts';
        }
        $d = Validator::make($body, $rules, ['deduct_month' => 'Salary month', 'vr_date' => 'Date', 'ot_hours' => 'OT hours', 'pay_account_id' => 'Paid from']);
        $d['deduct_month'] = substr($d['deduct_month'], 0, 8) . '01';
        $emp = Database::one('SELECT * FROM employees WHERE id = ?', [$d['employee_id']]);
        $errors = [];
        if ($d['vr_date'] < $emp['joining_date'] || ($emp['leaving_date'] && $d['vr_date'] > $emp['leaving_date'])) {
            $errors['employee_id'] = "{$emp['code']} {$emp['name']} is not employed on " . date('d-m-Y', strtotime($d['vr_date'])) . '.';
        }
        if ($d['deduct_month'] < substr($d['vr_date'], 0, 8) . '01') {
            $errors['deduct_month'] = 'Salary month cannot be before the voucher month.';
        }
        if ($type === 'OT' && (float)$d['ot_hours'] <= 0 && (int)$d['amount'] <= 0) {
            $errors['ot_hours'] = 'Enter OT hours or a fixed amount.';
        }
        if ($type === 'ADV') {
            $d['pay_account_id'] = $d['pay_account_id'] ?? Vouchers::systemAccount('cash');
            $acc = Database::one('SELECT account_type FROM accounts WHERE id = ?', [$d['pay_account_id']]);
            if (!$acc || $acc['account_type'] !== 'asset') {
                $errors['pay_account_id'] = 'Paid-from account must be a cash / bank (asset) account.';
            }
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        Vouchers::assertMonthOpen($emp, $d['deduct_month']);

        $id = Database::transaction(function () use ($type, $d, $old) {
            if ($old) {
                Database::update('vouchers', $d + ['updated_by' => Auth::id()], 'id = :id', ['id' => $old['id']]);
                Audit::log('update', 'vouchers', (int)$old['id'], $old, $d);
                return (int)$old['id'];
            }
            $id = Database::insert('vouchers', $d + ['voucher_type' => $type, 'vr_no' => Vouchers::nextNo($type), 'status' => 'draft', 'created_by' => Auth::id()]);
            Audit::log('create', 'vouchers', $id, null, $d + ['voucher_type' => $type]);
            return $id;
        });
        $v = Vouchers::find($id, $type);
        if ($r->input('post')) {
            Vouchers::post($v);
            $v = Vouchers::find($id, $type);
        }
        return $v;
    }

    // ---- shared actions by id (all voucher types); permission is checked per type here

    protected static function moduleFor(string $type): string
    {
        return Vouchers::TYPES[$type]['module'];
    }

    protected function byId(Request $r, string $action): array
    {
        $v = Vouchers::find($r->id());
        if (!Auth::can(self::moduleFor($v['voucher_type']), $action)) {
            throw ApiException::forbidden();
        }
        return $v;
    }

    public function post(Request $r): array
    {
        $v = $this->byId($r, 'post');
        Vouchers::post($v);
        return Vouchers::find((int)$v['id']);
    }

    public function unpost(Request $r): array
    {
        $v = $this->byId($r, 'post');
        Vouchers::unpost($v);
        return Vouchers::find((int)$v['id']);
    }

    public function destroy(Request $r): array
    {
        $v = $this->byId($r, 'delete');
        return ['result' => Vouchers::delete($v)];
    }

    /** Previous / next voucher of the same type by number. */
    public function neighbor(Request $r): ?array
    {
        $type = strtoupper($r->param('type'));
        if (!isset(Vouchers::TYPES[$type])) {
            throw ApiException::notFound('Voucher type');
        }
        if (!Auth::can(self::moduleFor($type), 'view')) {
            throw ApiException::forbidden();
        }
        $no = (int)$r->query('vr_no', 0);
        $prev = $r->query('dir') === 'prev';
        $sql = 'SELECT id FROM vouchers WHERE voucher_type = ? AND deleted_at IS NULL AND '
            . ($no === 0 ? '1 = 1' : ($prev ? 'vr_no < ?' : 'vr_no > ?'))
            . ' ORDER BY vr_no ' . ($prev ? 'DESC' : 'ASC') . ' LIMIT 1';
        $id = Database::value($sql, $no === 0 ? [$type] : [$type, $no]);
        return $id ? Vouchers::find((int)$id) : null;
    }
}
