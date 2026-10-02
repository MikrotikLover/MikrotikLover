<?php
declare(strict_types=1);

final class WarehouseController extends MasterController
{
    protected string $table = 'warehouses';
    protected string $codePrefix = 'WH';
    protected string $orderBy = 't.name';
    protected array $intColumns = ['id', 'is_active', 'allow_negative'];

    protected function rules(?int $id): array
    {
        return [
            'code'           => 'nullable|string|max:20|regex:/^[A-Za-z0-9._-]+$/|unique:warehouses,code' . ($id ? ",$id" : ''),
            'name'           => 'required|string|max:80',
            'name_ur'        => 'nullable|string|max:80',
            'warehouse_type' => 'required|in:grey,floor,finished,general',
            'address'        => 'nullable|string|max:255',
            'is_active'      => 'bool',
        ];
    }

    protected function applyFilters(array &$where, array &$params): void
    {
        $type = (string) Request::query('warehouse_type', '');
        if (in_array($type, ['grey', 'floor', 'finished', 'general'], true)) {
            $where[] = 't.warehouse_type = :wt';
            $params['wt'] = $type;
        }
    }

    protected function references(): array
    {
        return [['machines', 'warehouse_id'], ['stock_movements', 'warehouse_id']];
    }
}
