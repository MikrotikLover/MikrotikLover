<?php
declare(strict_types=1);

namespace App\Controllers;

final class DesignationController extends CrudController
{
    protected string $table = 'designations';
    protected string $label = 'Designation';
    protected array $rules = [
        'code'      => 'required|code|max:20',
        'name'      => 'required|string|max:100',
        'name_ur'   => 'nullable|string|max:100',
        'remarks'   => 'nullable|string|max:255',
        'is_active' => 'bool',
    ];
    protected array $unique = ['code' => 'Code', 'name' => 'Name'];
    protected array $searchable = ['code', 'name', 'name_ur'];

    protected function baseSelect(): string
    {
        return 'SELECT t.*, (SELECT COUNT(*) FROM employees e WHERE e.designation_id = t.id AND e.status = \'active\') AS employee_count
                  FROM designations t';
    }
}
