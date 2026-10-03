<?php
declare(strict_types=1);

namespace App\Reports;

use App\Money;
use App\Settings;

/**
 * Payslips (English / Urdu), two per A4 portrait page. ?id=sheet [&employee_id=] [&department_id=]
 */
final class PayslipReport extends SalaryReport
{
    public function title(): string
    {
        return 'Payslips — ' . $this->monthName();
    }

    protected function showHeader(): bool
    {
        return false;
    }

    protected function pageCss(): string
    {
        return '@page { margin: 7mm 9mm 10mm 9mm; }
            .rpt { padding: 0; }
            .slip { height: 134mm; box-sizing: border-box; border: 1px solid #000; padding: 4mm 5mm; margin-bottom: 6mm;
                    break-inside: avoid; page-break-inside: avoid; font-size: 8.3pt; display: flex; flex-direction: column; }
            .slip.brk { break-after: page; page-break-after: always; margin-bottom: 0; }
            .slip-h { display: flex; align-items: center; gap: 8px; border-bottom: 1.5px solid #000; padding-bottom: 2mm; }
            .slip-h img { max-height: 12mm; max-width: 28mm; }
            .slip-h .co { flex: 1; text-align: center; }
            .slip-h .co b { font-size: 12pt; display: block; }
            .slip-h .ttl { font-size: 9.5pt; font-weight: 700; letter-spacing: .5px; }
            .slip .urdu { font-size: 8.3pt; line-height: 1.7; }
            .info { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 6mm; margin: 2mm 0; }
            .info div { display: flex; justify-content: space-between; gap: 4px; border-bottom: 1px dotted #999; }
            .info span:first-child { color: #333; }
            .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 4mm; }
            .cols table { width: 100%; border-collapse: collapse; }
            .cols th, .cols td { border: 1px solid #777; padding: 0 3px; }
            .cols th { background: #e5e5e5; }
            .cols td.num { text-align: right; white-space: nowrap; }
            .cols tr.t td { font-weight: 700; background: #f2f2f2; }
            .lbl { display: flex; justify-content: space-between; gap: 4px; }
            .net { margin-top: 2mm; border: 1.5px solid #000; padding: 1.5mm 3mm; display: flex; justify-content: space-between; align-items: center; }
            .net b { font-size: 12pt; }
            .words { font-size: 8pt; }
            .warn { font-size: 7.3pt; color: #444; margin-top: 1mm; }
            .slip-s { margin-top: auto; display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10mm; }
            .slip-s div { border-top: 1px solid #000; text-align: center; padding-top: 1px; font-size: 7.5pt; }';
    }

    /** "English  اردو" label cell */
    private static function lbl(string $en, string $ur): string
    {
        return '<span class="lbl"><span>' . self::e($en) . '</span><span class="urdu">' . self::e($ur) . '</span></span>';
    }

    private static function rows(array $rows, string $totalEn, string $totalUr, float $total): string
    {
        $h = '';
        foreach ($rows as [$en, $ur, $v, $fmt]) {
            $h .= '<tr><td>' . self::lbl($en, $ur) . '</td><td class="num">' . ($fmt === 'money' ? self::money($v) : self::days($v)) . '</td></tr>';
        }
        if ($totalEn !== '') {
            $h .= '<tr class="t"><td>' . self::lbl($totalEn, $totalUr) . '</td><td class="num">' . self::money($total) . '</td></tr>';
        }
        return $h;
    }

    private function slip(array $l, bool $pageBreak): string
    {
        $s = $this->sheet();
        $c = Settings::company();
        $daily = $this->isDaily();
        $ss = (string)Settings::get('social_security', 'PESSI');
        $logo = $c['logo'] ? '<img src="file.php?t=logo&amp;v=' . rawurlencode((string)$c['logo']) . '" alt="">' : '';

        $info = [
            ['Code', 'کوڈ', $l['code']], ['Name', 'نام', $l['name']], ['Father', 'ولدیت', $l['father_name'] ?? ''],
            ['Department', 'شعبہ', $l['department']], ['Designation', 'عہدہ', $l['designation']], ['CNIC', 'شناختی کارڈ', $l['cnic'] ?? ''],
            [$daily ? 'Rate / Day' : 'Basic Salary', $daily ? 'یومیہ اجرت' : 'بنیادی تنخواہ', self::money($daily ? $l['daily_rate'] : $l['basic_salary'])],
            ['Payment', 'ادائیگی', $l['payment_mode'] === 'bank' ? 'Bank ' . trim(($l['bank_name'] ?? '') . ' ' . ($l['bank_account'] ?? '')) : 'Cash'],
            ['Paid Date', 'تاریخ ادائیگی', $s['paid_date'] ? self::date($s['paid_date']) : ''],
        ];
        $infoH = '';
        foreach ($info as [$en, $ur, $v]) {
            $infoH .= '<div><span>' . self::e($en) . ' <span class="urdu">' . self::e($ur) . '</span></span><b>' . self::e((string)$v) . '</b></div>';
        }
        if ($l['name_ur']) {
            $infoH .= '<div style="grid-column: span 3; justify-content: flex-end"><span class="urdu"><b>' . self::e($l['name_ur']) . '</b></span></div>';
        }

        $att = self::rows([
            ['Days in month', 'مہینے کے دن', $s['days_in_month'], 'days'],
            ['Work days', 'کام کے دن', $l['work_days'], 'days'],
            ['Rest days', 'آرام کے دن', $l['rest_days'], 'days'],
            ['Leave with pay', 'رخصت بمع تنخواہ', $l['leave_wp_days'], 'days'],
            ['Leave without pay', 'رخصت بلا تنخواہ', $l['leave_wop_days'], 'days'],
            ['Absent', 'غیر حاضری', $l['absent_days'], 'days'],
            ['Paid days', 'قابلِ ادائیگی دن', $l['paid_days'], 'days'],
            ['OT hours', 'اوور ٹائم گھنٹے', $l['ot_hours'], 'days'],
        ], '', '', 0);
        $earn = [
            ['Work pay', 'کام کی اجرت', $l['work_pay'], 'money'],
            ['Allowances', 'الاؤنس', $l['allowance_pay'], 'money'],
            ['Overtime', 'اوور ٹائم', $l['ot_amount'], 'money'],
        ];
        $gross = (float)$l['gross'];
        $earnH = self::rows($earn, 'Gross', 'کل تنخواہ', $gross)
            . self::rows([['Incentive', 'انعام', $l['incentive'], 'money']], 'Total earnings', 'کل آمدن', $gross + (float)$l['incentive']);
        $ded = [
            ['Advance', 'ایڈوانس', $l['advance'], 'money'],
            ['Loan installment', 'قرض کی قسط', $l['loan_deduction'], 'money'],
            ['Penalty', 'جرمانہ', $l['penalty'], 'money'],
            ['Fine', 'فائن', $l['fine'], 'money'],
            ['EOBI', 'ای او بی آئی', $l['eobi'], 'money'],
            [$ss, 'سوشل سیکیورٹی', $l['pessi'], 'money'],
            ['Income tax', 'انکم ٹیکس', $l['income_tax'], 'money'],
        ];
        $totalDed = array_sum(array_map(fn($r) => (float)$r[2], $ded));
        $dedH = self::rows($ded, 'Total deductions', 'کل کٹوتیاں', $totalDed);
        if ((float)$l['loan_balance'] > 0) {
            $dedH .= '<tr><td>' . self::lbl('Loan balance', 'بقایا قرض') . '</td><td class="num">' . self::money($l['loan_balance']) . '</td></tr>';
        }

        $net = (float)$l['net_salary'];
        $draft = $s['status'] === 'posted' ? '' : ' — DRAFT';
        return '<section class="slip' . ($pageBreak ? ' brk' : '') . '">'
            . '<div class="slip-h">' . $logo . '<div class="co"><b>' . self::e($c['name']) . '</b>'
            . ($c['name_ur'] !== '' ? '<span class="urdu">' . self::e($c['name_ur']) . '</span>' : '')
            . '<div class="ttl">PAYSLIP <span class="urdu">تنخواہ کی پرچی</span> — ' . self::e($this->monthName()) . self::e($draft) . '</div>'
            . '<div style="font-size:7.5pt">Period ' . self::date($s['period_from']) . ' to ' . self::date($s['period_to']) . '</div></div></div>'
            . '<div class="info">' . $infoH . '</div>'
            . '<div class="cols">'
            . '<table><tr><th colspan="2">' . self::lbl('Attendance', 'حاضری') . '</th></tr>' . $att . '</table>'
            . '<table><tr><th colspan="2">' . self::lbl('Earnings', 'آمدن') . '</th></tr>' . $earnH . '</table>'
            . '<table><tr><th colspan="2">' . self::lbl('Deductions', 'کٹوتیاں') . '</th></tr>' . $dedH . '</table>'
            . '</div>'
            . '<div class="net"><span>Net Salary <span class="urdu">خالص تنخواہ</span></span><b>Rs. ' . self::money($net) . '/-</b></div>'
            . '<div class="words">' . self::e(Money::words($net)) . '</div>'
            . ($l['remarks'] ? '<div class="warn">Remarks: ' . self::e($l['remarks']) . '</div>' : '')
            . '<div class="slip-s"><div>Prepared by</div><div>Accounts</div><div>Employee signature <span class="urdu">دستخط ملازم</span></div></div>'
            . '</section>';
    }

    protected function body(): string
    {
        $lines = $this->lines();
        if (!$lines) {
            return $this->emptyMsg();
        }
        $h = '';
        $n = count($lines);
        foreach ($lines as $i => $l) {
            $h .= $this->slip($l, $i % 2 === 1 && $i < $n - 1);
        }
        return $h;
    }
}
