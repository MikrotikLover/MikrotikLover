<?php
declare(strict_types=1);

final class SettingsController
{
    /** Editable keys and their validation rules. */
    private const RULES = [
        'company_name'        => 'required|string|max:120',
        'company_name_ur'     => 'nullable|string|max:120',
        'company_address'     => 'nullable|string|max:255',
        'company_phone'       => 'nullable|string|max:60',
        'company_ntn'         => 'nullable|string|max:30',
        'whatsapp_support'    => 'nullable|string|max:20|regex:/^\+?[0-9]{10,15}$/',
        'ink_ml_per_sqm_full' => 'required|numeric|gte:0.01|lte:1000',
        'ink_reference_gsm'   => 'required|numeric|gte:1|lte:5000',
        'default_wastage_pct' => 'required|numeric|gte:0|lte:100',
        'chalan_copies'       => 'required|integer|gte:1|lte:3',
        'chalan_terms'        => 'nullable|string|max:500',
    ];

    /** GET settings */
    public function index(): array
    {
        $all = Settings::all();
        $out = [];
        foreach (array_keys(self::RULES) as $key) {
            $out[$key] = $all[$key] ?? ($key === 'chalan_copies' ? '2' : '');
        }
        return $out;
    }

    /** PUT settings */
    public function update(): never
    {
        // Keys not sent keep their current value (partial updates, older clients).
        $data = Validator::make(Request::body() + $this->index(), self::RULES);
        if ($data['whatsapp_support'] !== null) {
            $data['whatsapp_support'] = ltrim((string) $data['whatsapp_support'], '+');
        }
        $old = $this->index();
        DB::transaction(function () use ($data, $old): void {
            foreach ($data as $key => $value) {
                Settings::set($key, $value === null ? '' : (string) $value);
            }
            Audit::log('update', 'settings', null, $old, array_map(fn ($v) => $v === null ? '' : (string) $v, $data), 'settings');
        });
        Response::ok($this->index(), 200, Lang::t('saved'));
    }
}
