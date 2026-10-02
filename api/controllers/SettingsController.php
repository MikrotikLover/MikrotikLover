<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Audit;
use App\Database;
use App\Request;
use App\Settings;
use App\Storage;
use App\Validator;

final class SettingsController
{
    public function company(Request $r): array
    {
        $all = Settings::all();
        $out = [];
        foreach (array_keys(Settings::COMPANY_RULES) as $k) {
            $out[$k] = $all[$k] ?? null;
        }
        $out['company_logo'] = $all['company_logo'] ?? null;
        $out['logo_url'] = !empty($all['company_logo']) ? 'file.php?t=logo&v=' . rawurlencode($all['company_logo']) : null;
        return $out;
    }

    public function saveCompany(Request $r): array
    {
        $data = Validator::make($r->body(), Settings::COMPANY_RULES, [
            'company_ntn' => 'NTN', 'salary_day_basis' => 'Salary day basis', 'id_card_valid_months' => 'ID card validity',
        ]);
        $data['weekly_rest_days'] = $this->cleanDays($data['weekly_rest_days'] ?? []);
        $old = Settings::all();
        Database::transaction(function () use ($data, $old) {
            foreach ($data as $k => $v) {
                Settings::set($k, $v);
            }
            Audit::log('update', 'settings', null, array_intersect_key($old, $data), $data);
        });
        return $this->company($r);
    }

    /** Weekly rest days, edited from the Holidays screen. */
    public function restDays(Request $r): array
    {
        $days = $this->cleanDays($r->input('weekly_rest_days', []));
        $old = Settings::get('weekly_rest_days', []);
        Settings::set('weekly_rest_days', $days);
        Audit::log('update', 'settings', null, ['weekly_rest_days' => $old], ['weekly_rest_days' => $days]);
        return ['weekly_rest_days' => $days];
    }

    private function cleanDays(mixed $days): array
    {
        if (!is_array($days)) {
            throw ApiException::validation(['weekly_rest_days' => 'Invalid weekdays.']);
        }
        $out = [];
        foreach ($days as $d) {
            if (!is_numeric($d) || (int)$d < 0 || (int)$d > 6) {
                throw ApiException::validation(['weekly_rest_days' => 'Invalid weekday.']);
            }
            $out[] = (int)$d;
        }
        $out = array_values(array_unique($out));
        sort($out);
        return $out;
    }

    public function uploadLogo(Request $r): array
    {
        if (empty($_FILES['logo'])) {
            throw ApiException::validation(['logo' => 'Choose an image.']);
        }
        $name = Storage::storeImage($_FILES['logo'], 'logos', 'logo', 600, 300, true);
        $old = Settings::get('company_logo');
        Settings::set('company_logo', $name);
        Storage::delete('logos', $old);
        Audit::log('update', 'settings', null, ['company_logo' => $old], ['company_logo' => $name]);
        return $this->company($r);
    }

    public function deleteLogo(Request $r): array
    {
        $old = Settings::get('company_logo');
        Settings::set('company_logo', null);
        Storage::delete('logos', $old);
        Audit::log('update', 'settings', null, ['company_logo' => $old], ['company_logo' => null]);
        return $this->company($r);
    }
}
