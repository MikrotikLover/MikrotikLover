<?php
declare(strict_types=1);

namespace App\Reports;

use App\Barcode;
use App\Controllers\EmployeeController;
use App\Database;
use App\Settings;

/**
 * Employee ID cards, CR80 size (85.6 x 54 mm).
 *   layout=sheet  A4 sheets, 10 cards per page; fronts page then backs page (mirrored for duplex)
 *   layout=cr80   one card face per page (for PVC card printers): front, back, front, back ...
 * Selection: ids=1,2,3 or the Employee List filters (department_id, status, emp_type ...).
 */
final class IdCardReport extends Report
{
    private const TYPES = ['permanent' => 'Permanent', 'daily_wages' => 'Daily Wages', 'contract' => 'Contract'];
    private const TYPES_UR = ['permanent' => 'مستقل', 'daily_wages' => 'دیہاڑی دار', 'contract' => 'کنٹریکٹ'];

    public function permission(): array
    {
        return ['employees', 'print'];
    }

    public function title(): string
    {
        return 'Employee ID Cards';
    }

    private function layout(): string
    {
        return $this->request->query('layout') === 'cr80' ? 'cr80' : 'sheet';
    }

    protected function pageCss(): string
    {
        return $this->layout() === 'cr80'
            ? '@page { size: 85.6mm 54mm; margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }'
            : '@page { size: A4 portrait; margin: 8mm; @bottom-left { content: none; } @bottom-right { content: none; } }';
    }

    private function employees(): array
    {
        [$where, $params] = EmployeeController::filters($this->request);
        return Database::all(
            'SELECT e.*, d.name AS department, d.name_ur AS department_ur, g.name AS designation, g.name_ur AS designation_ur
               FROM employees e
               JOIN departments d ON d.id = e.department_id
               JOIN designations g ON g.id = e.designation_id'
            . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
            . ' ORDER BY d.name, e.code LIMIT 1000',
            $params
        );
    }

    /** ID cards use their own full-page layout instead of the tabular report frame. */
    public function renderHtml(): string
    {
        $emps = $this->employees();
        $company = Settings::company();
        $issue = $this->request->query('issue_date');
        $issueTs = is_string($issue) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $issue) ? strtotime($issue) : time();
        $validTs = strtotime('+' . (int)Settings::get('id_card_valid_months', 12) . ' months', $issueTs);
        $note = (string)Settings::get('id_card_back_note', '');

        $fronts = [];
        $backs = [];
        foreach ($emps as $e) {
            $fronts[] = $this->front($e, $company, $validTs);
            $backs[] = $this->back($e, $company, $issueTs, $validTs, $note);
        }

        if (!$emps) {
            $pages = '<p class="empty">No employees selected.</p>';
        } elseif ($this->layout() === 'cr80') {
            $pages = '';
            foreach ($fronts as $i => $f) {
                $pages .= '<div class="cr80-page">' . $f . '</div><div class="cr80-page">' . $backs[$i] . '</div>';
            }
        } else {
            $pages = '';
            foreach (array_chunk(array_keys($fronts), 10) as $chunk) {
                $pages .= '<div class="card-sheet">';
                foreach ($chunk as $i) {
                    $pages .= $fronts[$i];
                }
                $pages .= '</div><div class="card-sheet backs">';
                // Mirror each row (swap left/right) so backs line up with fronts on long-edge duplex printing.
                foreach (array_chunk($chunk, 2) as $pair) {
                    $pages .= ($pair[1] ?? null) !== null ? $backs[$pair[1]] : '<div class="idcard blank"></div>';
                    $pages .= $backs[$pair[0]];
                }
                $pages .= '</div>';
            }
        }

        $count = count($emps);
        $title = self::e($this->title());
        $css = $this->pageCss();
        $layout = $this->layout();
        return <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{$title}</title>
<link rel="icon" href="data:,">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Noto+Nastaliq+Urdu:wght@400;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/css/report.css">
<link rel="stylesheet" href="assets/css/idcard.css">
<style>{$css}</style>
</head>
<body class="idcards layout-{$layout}">
<div class="rpt-toolbar no-print">
  <button class="btn primary" onclick="window.print()">Print / PDF (F9)</button>
  <button class="btn" onclick="window.close()">Close (Esc)</button>
  <span class="hint">{$count} card(s). Print at 100% scale ("Actual size"), margins as set by the page. Backs follow each sheet of fronts (mirrored for duplex).</span>
</div>
{$pages}
<script>
document.addEventListener('keydown', function (e) {
  if (e.key === 'F9') { e.preventDefault(); window.print(); }
  if (e.key === 'Escape') { window.close(); }
});
</script>
</body>
</html>
HTML;
    }

    private function front(array $e, array $c, int $validTs): string
    {
        $logo = $c['logo'] ? '<img class="c-logo" src="file.php?t=logo&amp;v=' . rawurlencode((string)$c['logo']) . '" alt="">' : '';
        $photo = $e['photo_file']
            ? '<img src="file.php?t=photo&amp;emp=' . (int)$e['id'] . '&amp;v=' . rawurlencode($e['photo_file']) . '" alt="">'
            : '<div class="c-nophoto">PHOTO</div>';
        $nameUr = $e['name_ur'] ? '<div class="c-name-ur urdu">' . self::e($e['name_ur']) . '</div>' : '';
        $father = trim((string)$e['father_name']) !== ''
            ? '<tr><th>' . self::e($e['relation']) . '</th><td>' . self::e($e['father_name']) . '</td></tr>' : '';
        $type = self::e(self::TYPES[$e['emp_type']] ?? $e['emp_type']);
        $typeUr = self::TYPES_UR[$e['emp_type']] ?? '';
        return '<div class="idcard front">'
            . '<div class="c-head">' . $logo . '<div class="c-company"><div class="c-co-en">' . self::e($c['name']) . '</div>'
            . ($c['name_ur'] !== '' ? '<div class="c-co-ur urdu">' . self::e($c['name_ur']) . '</div>' : '') . '</div></div>'
            . '<div class="c-body"><div class="c-photo">' . $photo . '<div class="c-code">' . self::e($e['code']) . '</div></div>'
            . '<div class="c-info"><div class="c-name">' . self::e($e['name']) . '</div>' . $nameUr
            . '<table>' . $father
            . '<tr><th>Dept</th><td>' . self::e($e['department'])
            . ($e['department_ur'] ? ' <span class="urdu">' . self::e($e['department_ur']) . '</span>' : '') . '</td></tr>'
            . '<tr><th>Desig</th><td>' . self::e($e['designation'])
            . ($e['designation_ur'] ? ' <span class="urdu">' . self::e($e['designation_ur']) . '</span>' : '') . '</td></tr>'
            . '<tr><th>Type</th><td>' . $type . ($typeUr ? ' <span class="urdu">' . $typeUr . '</span>' : '') . '</td></tr>'
            . '<tr><th>ID</th><td>' . (int)$e['id'] . '</td></tr>'
            . '</table></div></div>'
            . '<div class="c-foot"><span>Valid upto: ' . date('d-m-Y', $validTs) . '</span><span class="c-sign">Authorized Signature</span></div>'
            . '</div>';
    }

    private function back(array $e, array $c, int $issueTs, int $validTs, string $note): string
    {
        $barcode = Barcode::svg((string)$e['code'], 40);
        $addr = trim($c['address'] . ($c['phone'] !== '' ? ' · Ph: ' . $c['phone'] : ''));
        return '<div class="idcard back">'
            . '<table class="b-info">'
            . '<tr><th>Address</th><td>' . self::e($e['address']) . ($e['city'] ? ', ' . self::e($e['city']) : '') . '</td></tr>'
            . '<tr><th>CNIC</th><td>' . self::e($e['cnic']) . '</td></tr>'
            . '<tr><th>Cell</th><td>' . self::e($e['cell']) . '</td></tr>'
            . '<tr><th>Joined</th><td>' . self::date($e['joining_date']) . ' &nbsp; <b>Issued:</b> ' . date('d-m-Y', $issueTs) . '</td></tr>'
            . '</table>'
            . '<div class="b-barcode">' . $barcode . '<div class="b-code">' . self::e($e['code']) . '</div></div>'
            . ($note !== '' ? '<div class="b-note">' . self::e($note) . '</div>' : '')
            . '<div class="b-company"><b>' . self::e($c['name']) . '</b>' . ($addr !== '' ? '<br>' . self::e($addr) : '') . '</div>'
            . '</div>';
    }

    protected function body(): string
    {
        return '';
    }
}
