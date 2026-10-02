<?php
declare(strict_types=1);

namespace App\Controllers;

final class LeaveTypeController extends CrudController
{
    protected string $table = 'leave_types';
    protected string $label = 'Leave type';
    protected array $rules = [
        'code'         => 'required|code|max:10',
        'name'         => 'required|string|max:60',
        'name_ur'      => 'nullable|string|max:60',
        'yearly_quota' => 'required|num|min:0|max:366',
        'is_paid'      => 'bool',
        'is_active'    => 'bool',
    ];
    protected array $unique = ['code' => 'Code', 'name' => 'Name'];
    protected array $searchable = ['code', 'name', 'name_ur'];
    protected string $orderBy = 'code';
}
