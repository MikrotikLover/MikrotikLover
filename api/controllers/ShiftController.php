<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Request;

final class ShiftController extends CrudController
{
    protected string $table = 'shifts';
    protected string $label = 'Shift';
    protected array $rules = [
        'code'             => 'required|code|max:20',
        'name'             => 'required|string|max:60',
        'start_time'       => 'required|time',
        'end_time'         => 'required|time',
        'break_minutes'    => 'required|int|min:0|max:600',
        'grace_minutes'    => 'required|int|min:0|max:240',
        'half_day_minutes' => 'required|int|min:0|max:1440',
        'min_ot_minutes'   => 'required|int|min:0|max:600',
        'remarks'          => 'nullable|string|max:255',
        'is_active'        => 'bool',
    ];
    protected array $unique = ['code' => 'Code'];
    protected string $orderBy = 'start_time';

    protected function columns(): array
    {
        return [...array_keys($this->rules), 'is_overnight', 'duration_minutes'];
    }

    /** Gross span of a shift in minutes; end <= start means it crosses midnight. */
    public static function spanMinutes(string $start, string $end): int
    {
        $s = self::toMinutes($start);
        $e = self::toMinutes($end);
        return $e > $s ? $e - $s : 1440 - $s + $e;
    }

    public static function toMinutes(string $t): int
    {
        [$h, $m] = array_map('intval', explode(':', $t));
        return $h * 60 + $m;
    }

    protected function beforeSave(array $data, ?array $existing, Request $r): array
    {
        $span = self::spanMinutes($data['start_time'], $data['end_time']);
        $errors = [];
        if ($data['break_minutes'] >= $span) {
            $errors['break_minutes'] = 'Break must be shorter than the shift.';
        }
        $net = $span - $data['break_minutes'];
        if (!$errors && $data['half_day_minutes'] > $net) {
            $errors['half_day_minutes'] = 'Half-day threshold cannot exceed the net shift length (' . $net . ' min).';
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        $data['is_overnight'] = self::toMinutes($data['end_time']) <= self::toMinutes($data['start_time']) ? 1 : 0;
        $data['duration_minutes'] = $net;
        return $data;
    }
}
