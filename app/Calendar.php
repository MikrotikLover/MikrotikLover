<?php
declare(strict_types=1);

namespace App;

/**
 * Work calendar: which shift an employee works on a date (shift-group rotation), rest days,
 * holidays and the employment period. Loads shifts/groups once; holidays for a date range.
 *
 * Rotation: steps [(shift, days), ...]; day 0 = employee.shift_date (or joining date).
 * Shift on date D = step at position ((D - anchor) mod sum(days)).
 */
final class Calendar
{
    /** @var array<int,array> */
    private array $shifts = [];
    /** @var array<int,array{steps:array,total:int,rest:?array}> */
    private array $groups = [];
    /** @var array<string,array> date => holiday */
    private array $holidays = [];
    private array $companyRest;
    private ?int $defaultShift;

    public function __construct(string $from, string $to)
    {
        foreach (Database::all('SELECT * FROM shifts') as $s) {
            $this->shifts[(int)$s['id']] = $s;
        }
        foreach (Database::all('SELECT id, rest_days FROM shift_groups') as $g) {
            $this->groups[(int)$g['id']] = [
                'steps' => [],
                'total' => 0,
                'rest'  => ($g['rest_days'] === null || $g['rest_days'] === '') ? null : array_map('intval', explode(',', $g['rest_days'])),
            ];
        }
        foreach (Database::all('SELECT shift_group_id, shift_id, days FROM shift_group_steps ORDER BY shift_group_id, seq') as $st) {
            $gid = (int)$st['shift_group_id'];
            if (isset($this->groups[$gid])) {
                $this->groups[$gid]['steps'][] = [(int)$st['shift_id'], (int)$st['days']];
                $this->groups[$gid]['total'] += (int)$st['days'];
            }
        }
        $a = date('Y-m-d', strtotime("$from -2 day"));
        $b = date('Y-m-d', strtotime("$to +2 day"));
        foreach (Database::all('SELECT * FROM holidays WHERE holiday_date BETWEEN ? AND ?', [$a, $b]) as $h) {
            $this->holidays[$h['holiday_date']] = $h;
        }
        $this->companyRest = array_map('intval', (array)Settings::get('weekly_rest_days', [0]));
        $d = Settings::get('default_shift_id');
        $this->defaultShift = $d ? (int)$d : null;
    }

    public function shiftById(?int $id): ?array
    {
        return $id ? ($this->shifts[$id] ?? null) : null;
    }

    /** Shift for employee on date (rotation, else company default shift, else null). */
    public function shift(array $emp, string $date): ?array
    {
        $gid = (int)($emp['shift_group_id'] ?? 0);
        if ($gid && isset($this->groups[$gid]) && $this->groups[$gid]['total'] > 0) {
            $g = $this->groups[$gid];
            $anchor = $emp['shift_date'] ?: $emp['joining_date'];
            $diff = intdiv(strtotime($date . ' 12:00:00') - strtotime($anchor . ' 12:00:00'), 86400);
            $pos = (($diff % $g['total']) + $g['total']) % $g['total'];
            foreach ($g['steps'] as [$sid, $days]) {
                if ($pos < $days) {
                    return $this->shifts[$sid] ?? null;
                }
                $pos -= $days;
            }
        }
        return $this->shiftById($this->defaultShift);
    }

    public function restDays(array $emp): array
    {
        $gid = (int)($emp['shift_group_id'] ?? 0);
        $rest = $gid && isset($this->groups[$gid]) ? $this->groups[$gid]['rest'] : null;
        return $rest ?? $this->companyRest;
    }

    public function holiday(string $date): ?array
    {
        return $this->holidays[$date] ?? null;
    }

    public function isEmployed(array $emp, string $date): bool
    {
        return $date >= $emp['joining_date'] && (empty($emp['leaving_date']) || $date <= $emp['leaving_date']);
    }

    /** 'O' outside employment, 'H' holiday, 'R' weekly rest day, null = normal working day. */
    public function dayType(array $emp, string $date): ?string
    {
        if (!$this->isEmployed($emp, $date)) {
            return 'O';
        }
        if (isset($this->holidays[$date])) {
            return 'H';
        }
        if (in_array((int)date('w', strtotime($date)), $this->restDays($emp), true)) {
            return 'R';
        }
        return null;
    }

    /** Dates from..to inclusive. */
    public static function dates(string $from, string $to): array
    {
        $out = [];
        for ($t = strtotime($from . ' 12:00:00'), $end = strtotime($to . ' 12:00:00'); $t <= $end; $t += 86400) {
            $out[] = date('Y-m-d', $t);
        }
        return $out;
    }
}
