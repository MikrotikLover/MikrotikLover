<?php
declare(strict_types=1);

/**
 * Items: grey fabric, finished fabric, inks, paper, chemicals, other.
 * The Ink Master screen uses this same endpoint with item_type=ink; ink rate
 * can be entered per liter (rate_per_liter) and is stored per item unit.
 */
final class ItemController extends MasterController
{
    public const TYPES = ['grey_fabric', 'finished_fabric', 'ink', 'paper', 'chemical', 'other'];
    private const PREFIX = [
        'grey_fabric' => 'GF', 'finished_fabric' => 'FF', 'ink' => 'INK',
        'paper' => 'PAP', 'chemical' => 'CHM', 'other' => 'OTH',
    ];
    /** Which optional columns apply to which item type. */
    private const TYPE_FIELDS = [
        'grey_fabric'     => ['quality', 'gsm', 'width_inch'],
        'finished_fabric' => ['quality', 'gsm', 'width_inch'],
        'ink'             => ['ink_colour_id', 'brand', 'process_type'],
        'paper'           => ['gsm', 'width_inch', 'brand', 'process_type'],
        'chemical'        => ['brand', 'process_type'],
        'other'           => ['brand'],
    ];

    protected string $table = 'items';
    protected array $searchColumns = ['code', 'name', 'name_ur', 'quality', 'brand'];
    protected string $orderBy = 't.item_type, t.name';
    protected array $intColumns = ['id', 'is_active', 'unit_id', 'ink_colour_id', 'track_lots'];

    protected function selectSql(): string
    {
        return 't.*, u.code AS unit_code, u.name AS unit_name, u.name_ur AS unit_name_ur, u.dimension AS unit_dimension,
                u.to_base AS unit_to_base, u.decimals AS unit_decimals,
                c.code AS colour_code, c.name AS colour_name, c.name_ur AS colour_name_ur, c.hex AS colour_hex';
    }

    protected function joinSql(): string
    {
        return 'JOIN units u ON u.id = t.unit_id LEFT JOIN ink_colours c ON c.id = t.ink_colour_id';
    }

    protected function cast(array $row): array
    {
        $row = parent::cast($row);
        $row['rate_per_liter'] = null;
        if (($row['unit_dimension'] ?? null) === 'volume' && (float) $row['unit_to_base'] > 0) {
            $row['rate_per_liter'] = round((float) $row['rate'] / (float) $row['unit_to_base'], 4);
        }
        return $row;
    }

    protected function rules(?int $id): array
    {
        return [
            'code'           => 'nullable|string|max:30|regex:/^[A-Za-z0-9._\/-]+$/|unique:items,code' . ($id ? ",$id" : ''),
            'name'           => 'required|string|max:150',
            'name_ur'        => 'nullable|string|max:150',
            'item_type'      => 'required|in:' . implode(',', self::TYPES),
            'unit_id'        => 'required|integer|exists:units,id,soft',
            'quality'        => 'nullable|string|max:80',
            'gsm'            => 'nullable|numeric|gte:0|lte:5000',
            'width_inch'     => 'nullable|numeric|gte:0|lte:1000',
            'ink_colour_id'  => 'nullable|integer|exists:ink_colours,id,soft',
            'brand'          => 'nullable|string|max:60',
            'process_type'   => 'nullable|in:sublimation,reactive,pigment,any',
            'rate'           => 'nullable|numeric|gte:0|lte:100000000',
            'rate_per_liter' => 'nullable|numeric|gte:0|lte:100000000',
            'reorder_level'  => 'nullable|numeric|gte:0|lte:100000000',
            'track_lots'     => 'bool',
            'remarks'        => 'nullable|string|max:255',
            'is_active'      => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        $type = $data['item_type'];
        $unit = DB::one('SELECT dimension, to_base FROM units WHERE id = :id', ['id' => $data['unit_id']]);
        $errors = [];

        // Clear columns that do not apply to this type.
        $optional = ['quality', 'gsm', 'width_inch', 'ink_colour_id', 'brand', 'process_type'];
        foreach (array_diff($optional, self::TYPE_FIELDS[$type]) as $col) {
            $data[$col] = null;
        }

        if ($type === 'ink') {
            if (empty($data['ink_colour_id'])) {
                $errors['ink_colour_id'] = Lang::t('validation.required');
            }
            if (empty($data['process_type'])) {
                $errors['process_type'] = Lang::t('validation.required');
            }
            if (($unit['dimension'] ?? '') !== 'volume') {
                $errors['unit_id'] = Lang::t('item.ink_unit');
            }
            // Ink rate is entered per liter; store it per item unit (e.g. per ml = /1000).
            if ($data['rate_per_liter'] !== null && $unit && $unit['dimension'] === 'volume') {
                $data['rate'] = round((float) $data['rate_per_liter'] * (float) $unit['to_base'], 4);
            }
        }
        if (in_array($type, ['grey_fabric', 'finished_fabric'], true) && $unit && !in_array($unit['dimension'], ['length', 'mass'], true)) {
            $errors['unit_id'] = Lang::t('item.fabric_unit');
        }

        // Type or unit cannot change once stock exists (balances would be meaningless).
        if ($old !== null && ($old['item_type'] !== $type || (int) $old['unit_id'] !== (int) $data['unit_id'])
            && (int) DB::value('SELECT COUNT(*) FROM stock_movements WHERE item_id = :id', ['id' => (int) $old['id']]) > 0) {
            $errors[$old['item_type'] !== $type ? 'item_type' : 'unit_id'] = Lang::t('item.locked_by_stock');
        }
        self::fail($errors);

        unset($data['rate_per_liter']);
        $data['rate'] ??= 0;
        $data['reorder_level'] ??= 0;
        return $data;
    }

    protected function authorizeWrite(array $data, ?array $old): void
    {
        $isInk = ($data['item_type'] ?? null) === 'ink' || ($old['item_type'] ?? null) === 'ink';
        $allInk = ($data['item_type'] ?? 'ink') === 'ink' && ($old['item_type'] ?? 'ink') === 'ink';
        // Ink items: inks.manage or items.manage. Any other item: items.manage.
        Auth::requirePermission($allInk ? ['inks.manage', 'items.manage'] : 'items.manage');
        if ($isInk && !$allInk) {
            Auth::requirePermission('items.manage');
        }
    }

    /** Users with only ink rights (inks.view) see ink items only. */
    public function show(int $id): array
    {
        $row = parent::show($id);
        if ($row['item_type'] !== 'ink' && !Auth::can('items.view')) {
            throw HttpException::forbidden();
        }
        return $row;
    }

    protected function applyFilters(array &$where, array &$params): void
    {
        if (!Auth::can('items.view')) {
            $where[] = "t.item_type = 'ink'";
        }
        $types = array_values(array_intersect(explode(',', (string) Request::query('item_type', '')), self::TYPES));
        if ($types) {
            $where[] = 't.item_type IN ' . DB::in($types, $params, 'it');
        }
        if (($colour = Request::queryInt('ink_colour_id')) > 0) {
            $where[] = 't.ink_colour_id = :colour';
            $params['colour'] = $colour;
        }
        $process = (string) Request::query('process_type', '');
        if (in_array($process, ['sublimation', 'reactive', 'pigment'], true)) {
            $where[] = "(t.process_type = :pt OR t.process_type = 'any' OR t.process_type IS NULL)";
            $params['pt'] = $process;
        }
    }

    protected function codePrefixFor(array $data): string
    {
        return self::PREFIX[$data['item_type']] ?? 'IT';
    }

    protected function references(): array
    {
        return [
            ['stock_movements', 'item_id'],
            ['design_inks', 'item_id', 'design_id IN (SELECT id FROM designs WHERE deleted_at IS NULL)'],
            ['design_bom', 'item_id', 'design_id IN (SELECT id FROM designs WHERE deleted_at IS NULL)'],
            ['designs', 'finished_item_id'],
        ];
    }
}
