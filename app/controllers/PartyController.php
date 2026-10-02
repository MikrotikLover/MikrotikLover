<?php
declare(strict_types=1);

final class PartyController extends MasterController
{
    protected string $table = 'parties';
    protected string $codePrefix = 'P';
    protected array $searchColumns = ['code', 'name', 'name_ur', 'phone', 'city', 'contact_person'];
    protected array $intColumns = ['id', 'is_active', 'is_customer', 'is_supplier', 'is_fabric_owner'];

    protected function rules(?int $id): array
    {
        $phone = 'nullable|string|max:30|regex:/^[0-9+\-\s()]{7,30}$/';
        return [
            'code'            => 'nullable|string|max:20|regex:/^[A-Za-z0-9._-]+$/|unique:parties,code' . ($id ? ",$id" : ''),
            'name'            => 'required|string|max:120',
            'name_ur'         => 'nullable|string|max:120',
            'is_customer'     => 'bool',
            'is_supplier'     => 'bool',
            'is_fabric_owner' => 'bool',
            'contact_person'  => 'nullable|string|max:100',
            'phone'           => $phone,
            'whatsapp'        => $phone,
            'email'           => 'nullable|email|max:150',
            'address'         => 'nullable|string|max:255',
            'city'            => 'nullable|string|max:60',
            'ntn'             => 'nullable|string|max:30',
            'strn'            => 'nullable|string|max:30',
            'remarks'         => 'nullable|string|max:255',
            'is_active'       => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        if (!$data['is_customer'] && !$data['is_supplier'] && !$data['is_fabric_owner']) {
            self::fail(['is_customer' => Lang::t('party.type_required')]);
        }
        return $data;
    }

    protected function applyFilters(array &$where, array &$params): void
    {
        $map = ['customer' => 'is_customer', 'supplier' => 'is_supplier', 'fabric_owner' => 'is_fabric_owner'];
        $type = (string) Request::query('type', '');
        if (isset($map[$type])) {
            $where[] = "t.{$map[$type]} = 1";
        }
    }

    protected function references(): array
    {
        return [
            ['designs', 'party_id'], ['stock_movements', 'party_id'], ['stock_movements', 'owner_party_id'],
            ['inward_gate_passes', 'party_id'], ['delivery_chalans', 'party_id'], ['productions', 'party_id'],
            ['production_estimations', 'party_id'],
        ];
    }
}
