<?php
declare(strict_types=1);

namespace App\Controllers;

use App\ApiException;
use App\Database;
use App\Request;

/**
 * Shift group = rotation of shifts. steps: [{shift_id, days}, ...] in order.
 * An employee's shift on date D = step at ((D - employee.shift_date) mod sum(days)).
 */
final class ShiftGroupController extends CrudController
{
    protected string $table = 'shift_groups';
    protected string $label = 'Shift group';
    protected array $rules = [
        'code'      => 'required|code|max:20',
        'name'      => 'required|string|max:60',
        'rest_days' => 'nullable|array',
        'remarks'   => 'nullable|string|max:255',
        'is_active' => 'bool',
        'steps'     => 'required|array',
    ];
    protected array $unique = ['code' => 'Code'];

    protected function columns(): array
    {
        return ['code', 'name', 'rest_days', 'remarks', 'is_active'];
    }

    protected function baseSelect(): string
    {
        return 'SELECT t.*,
                       (SELECT COUNT(*) FROM employees e WHERE e.shift_group_id = t.id AND e.status = \'active\') AS employee_count,
                       (SELECT GROUP_CONCAT(CONCAT(s.code, \' x\', g.days) ORDER BY g.seq SEPARATOR \' → \')
                          FROM shift_group_steps g JOIN shifts s ON s.id = g.shift_id WHERE g.shift_group_id = t.id) AS rotation
                  FROM shift_groups t';
    }

    protected function beforeSave(array $data, ?array $existing, Request $r): array
    {
        $errors = [];
        $steps = [];
        foreach (array_values($data['steps']) as $i => $s) {
            $shiftId = (int)($s['shift_id'] ?? 0);
            $days = (int)($s['days'] ?? 0);
            if (!$shiftId || !Database::value('SELECT 1 FROM shifts WHERE id = ?', [$shiftId])) {
                $errors['steps'] = 'Row ' . ($i + 1) . ': select a valid shift.';
                break;
            }
            if ($days < 1 || $days > 366) {
                $errors['steps'] = 'Row ' . ($i + 1) . ': days must be between 1 and 366.';
                break;
            }
            $steps[] = ['shift_id' => $shiftId, 'days' => $days];
        }
        if (!$steps && !$errors) {
            $errors['steps'] = 'Add at least one shift to the rotation.';
        }
        $rest = [];
        foreach ((array)($data['rest_days'] ?? []) as $d) {
            if (!is_numeric($d) || (int)$d < 0 || (int)$d > 6) {
                $errors['rest_days'] = 'Invalid weekday.';
                break;
            }
            $rest[] = (int)$d;
        }
        if ($errors) {
            throw ApiException::validation($errors);
        }
        sort($rest);
        $data['rest_days'] = $rest ? implode(',', array_unique($rest)) : null;
        $data['steps'] = $steps;
        return $data;
    }

    protected function afterSave(int $id, array $data, ?array $existing, Request $r): void
    {
        Database::run('DELETE FROM shift_group_steps WHERE shift_group_id = ?', [$id]);
        foreach ($data['steps'] as $i => $s) {
            Database::insert('shift_group_steps', [
                'shift_group_id' => $id, 'seq' => $i + 1, 'shift_id' => $s['shift_id'], 'days' => $s['days'],
            ]);
        }
    }

    protected function decorate(array $row): array
    {
        $row['steps'] = Database::all(
            'SELECT g.seq, g.shift_id, g.days, s.code AS shift_code, s.name AS shift_name, s.start_time, s.end_time
               FROM shift_group_steps g JOIN shifts s ON s.id = g.shift_id
              WHERE g.shift_group_id = ? ORDER BY g.seq',
            [$row['id']]
        );
        $row['rest_days'] = $row['rest_days'] === null || $row['rest_days'] === ''
            ? [] : array_map('intval', explode(',', $row['rest_days']));
        return $row;
    }
}
