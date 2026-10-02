<?php
declare(strict_types=1);

final class InkColourController extends MasterController
{
    protected string $table = 'ink_colours';
    protected string $entity = 'ink_colours';
    protected string $orderBy = 't.sort_order, t.code';
    protected array $intColumns = ['id', 'is_active', 'is_process', 'sort_order'];

    protected function rules(?int $id): array
    {
        return [
            'code'       => 'required|string|max:10|regex:/^[A-Za-z0-9]+$/|unique:ink_colours,code' . ($id ? ",$id" : ''),
            'name'       => 'required|string|max:40',
            'name_ur'    => 'nullable|string|max:40',
            'hex'        => 'required|string|regex:/^#[0-9A-Fa-f]{6}$/',
            'is_process' => 'bool',
            'sort_order' => 'nullable|integer|gte:0|lte:999',
            'is_active'  => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        $data['code'] = strtoupper((string) $data['code']);
        $data['hex'] = strtoupper((string) $data['hex']);
        $data['sort_order'] ??= 0;
        return $data;
    }

    protected function references(): array
    {
        return [['items', 'ink_colour_id'], ['design_inks', 'ink_colour_id', 'design_id IN (SELECT id FROM designs WHERE deleted_at IS NULL)']];
    }
}
