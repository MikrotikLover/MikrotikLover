<?php
declare(strict_types=1);

final class MachineController extends MasterController
{
    protected string $table = 'machines';
    protected string $codePrefix = 'M';
    protected array $searchColumns = ['code', 'name', 'name_ur', 'make_model'];
    protected array $intColumns = ['id', 'is_active', 'warehouse_id'];

    protected function selectSql(): string
    {
        return 't.*, w.name AS warehouse_name, w.name_ur AS warehouse_name_ur';
    }

    protected function joinSql(): string
    {
        return 'LEFT JOIN warehouses w ON w.id = t.warehouse_id';
    }

    protected function rules(?int $id): array
    {
        return [
            'code'             => 'nullable|string|max:20|regex:/^[A-Za-z0-9._-]+$/|unique:machines,code' . ($id ? ",$id" : ''),
            'name'             => 'required|string|max:80',
            'name_ur'          => 'nullable|string|max:80',
            'machine_type'     => 'required|in:sublimation,reactive,pigment',
            'make_model'       => 'nullable|string|max:80',
            'speed_m_per_hr'   => 'required|numeric|gte:0|lte:100000',
            'print_width_inch' => 'nullable|numeric|gte:0|lte:1000',
            'hourly_cost'      => 'nullable|numeric|gte:0|lte:100000000',
            'warehouse_id'     => 'nullable|integer|exists:warehouses,id,soft',
            'remarks'          => 'nullable|string|max:255',
            'is_active'        => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        $data['hourly_cost'] ??= 0;
        return $data;
    }

    protected function applyFilters(array &$where, array &$params): void
    {
        $type = (string) Request::query('machine_type', '');
        if (in_array($type, ['sublimation', 'reactive', 'pigment'], true)) {
            $where[] = 't.machine_type = :mt';
            $params['mt'] = $type;
        }
    }

    protected function references(): array
    {
        return [['designs', 'default_machine_id'], ['stock_movements', 'machine_id'], ['productions', 'machine_id'], ['ink_loads', 'machine_id']];
    }
}
