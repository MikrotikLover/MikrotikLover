<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Database;
use App\Request;

final class HolidayController extends CrudController
{
    protected string $table = 'holidays';
    protected string $label = 'Holiday';
    protected array $rules = [
        'holiday_date' => 'required|date',
        'name'         => 'required|string|max:100',
        'name_ur'      => 'nullable|string|max:100',
        'holiday_type' => 'required|in:gazetted,company,other',
        'is_paid'      => 'bool',
    ];
    protected array $unique = ['holiday_date' => 'Date'];
    protected array $searchable = ['name', 'name_ur'];
    protected string $orderBy = 'holiday_date';
    protected bool $hasActiveFlag = false;

    public function index(Request $r): array
    {
        $year = $r->queryInt('year');
        if ($year) {
            return Database::all(
                'SELECT t.* FROM holidays t WHERE t.holiday_date BETWEEN :a AND :b ORDER BY t.holiday_date',
                ['a' => "$year-01-01", 'b' => "$year-12-31"]
            );
        }
        return parent::index($r);
    }
}
