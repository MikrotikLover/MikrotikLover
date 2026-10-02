<?php
declare(strict_types=1);

final class UnitController extends MasterController
{
    protected string $table = 'units';
    protected string $orderBy = 't.dimension, t.to_base DESC, t.code';
    protected array $intColumns = ['id', 'is_active', 'decimals'];

    protected function rules(?int $id): array
    {
        return [
            'code'      => 'required|string|max:10|regex:/^[A-Za-z0-9._-]+$/|unique:units,code' . ($id ? ",$id" : ''),
            'name'      => 'required|string|max:40',
            'name_ur'   => 'nullable|string|max:40',
            'dimension' => 'required|in:length,mass,volume,count',
            'to_base'   => 'required|numeric|gte:0.00000001|lte:1000000',
            'decimals'  => 'required|integer|gte:0|lte:4',
            'is_active' => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        // Changing the dimension of a unit already used by items would corrupt conversions.
        if ($old !== null && $old['dimension'] !== $data['dimension']
            && (int) DB::value('SELECT COUNT(*) FROM items WHERE unit_id = :id AND deleted_at IS NULL', ['id' => (int) $old['id']]) > 0) {
            self::fail(['dimension' => Lang::t('unit.dimension_locked')]);
        }
        return $data;
    }

    protected function references(): array
    {
        return [['items', 'unit_id'], ['inward_gate_pass_lines', 'unit_id'], ['delivery_chalan_lines', 'unit_id'], ['production_estimation_lines', 'unit_id']];
    }
}
