<?php
declare(strict_types=1);

namespace App;

/**
 * Rule-string validator that also normalises values.
 *
 *   $clean = Validator::make($input, [
 *       'name'  => 'required|string|max:100',
 *       'cnic'  => 'nullable|cnic',
 *       'dob'   => 'nullable|date|before:joining_date',
 *       'type'  => 'required|in:permanent,daily_wages,contract',
 *       'department_id' => 'required|int|exists:departments',
 *   ]);
 *
 * Rules: required, nullable, string, int, num, bool, date, time, email, cnic, phone, code,
 *        in:a,b, min:n, max:n, exists:table, array, before:field, after_or_equal:field
 * Throws ApiException(422) with field errors. Empty strings become null.
 */
final class Validator
{
    public const CNIC_REGEX = '/^\d{5}-\d{7}-\d$/';

    private array $errors = [];
    private array $clean = [];

    private function __construct(private array $data, private array $rules, private array $labels)
    {
    }

    public static function make(array $data, array $rules, array $labels = []): array
    {
        $v = new self($data, $rules, $labels);
        $v->run();
        if ($v->errors) {
            throw ApiException::validation($v->errors);
        }
        return $v->clean;
    }

    private function label(string $field): string
    {
        return $this->labels[$field] ?? ucfirst(str_replace(['_id', '_'], ['', ' '], $field));
    }

    private function run(): void
    {
        // pass 1: type normalisation & per-field rules
        foreach ($this->rules as $field => $ruleStr) {
            $rules = $this->parse($ruleStr);
            $present = array_key_exists($field, $this->data);
            $value = $this->data[$field] ?? null;
            if (is_string($value)) {
                $value = trim($value);
                if ($value === '') {
                    $value = null;
                }
            }

            if ($value === null || $value === []) {
                if (isset($rules['required'])) {
                    $this->errors[$field] = $this->label($field) . ' is required.';
                } elseif ($present || isset($rules['nullable'])) {
                    $this->clean[$field] = isset($rules['bool']) ? 0 : (isset($rules['array']) ? [] : null);
                }
                continue;
            }

            $error = $this->check($field, $value, $rules);
            if ($error !== null) {
                $this->errors[$field] = $error;
                continue;
            }
            $this->clean[$field] = $value;
        }

        // pass 2: cross-field rules
        foreach ($this->rules as $field => $ruleStr) {
            if (isset($this->errors[$field]) || ($this->clean[$field] ?? null) === null) {
                continue;
            }
            $rules = $this->parse($ruleStr);
            foreach (['before' => '<', 'after_or_equal' => '>='] as $r => $op) {
                if (!isset($rules[$r])) {
                    continue;
                }
                $other = $this->clean[$rules[$r]] ?? null;
                if ($other === null) {
                    continue;
                }
                $ok = $op === '<' ? $this->clean[$field] < $other : $this->clean[$field] >= $other;
                if (!$ok) {
                    $this->errors[$field] = $this->label($field) . ($op === '<' ? ' must be before ' : ' must be on or after ')
                        . $this->label($rules[$r]) . '.';
                }
            }
        }
    }

    private function parse(string $ruleStr): array
    {
        $out = [];
        foreach (explode('|', $ruleStr) as $r) {
            if ($r === '') {
                continue;
            }
            [$name, $arg] = array_pad(explode(':', $r, 2), 2, true);
            $out[$name] = $arg;
        }
        return $out;
    }

    /** Validates and normalises $value in place. Returns an error message or null. */
    private function check(string $field, mixed &$value, array $rules): ?string
    {
        $label = $this->label($field);

        if (isset($rules['array'])) {
            if (!is_array($value)) {
                return "$label is invalid.";
            }
            return null;
        }
        if (is_array($value)) {
            return "$label is invalid.";
        }

        if (isset($rules['int'])) {
            if (!is_int($value) && !(is_string($value) && preg_match('/^-?\d+$/', $value))) {
                return "$label must be a whole number.";
            }
            $value = (int)$value;
        } elseif (isset($rules['num'])) {
            if (is_string($value)) {
                $value = str_replace(',', '', $value);
            }
            if (!is_numeric($value)) {
                return "$label must be a number.";
            }
            $value = round((float)$value, 4);
        } elseif (isset($rules['bool'])) {
            $value = in_array($value, [true, 1, '1', 'true', 'on', 'yes'], true) ? 1 : 0;
        } else {
            $value = (string)$value;
        }

        if (isset($rules['date'])) {
            $d = \DateTimeImmutable::createFromFormat('!Y-m-d', $value);
            if (!$d || $d->format('Y-m-d') !== $value) {
                return "$label must be a valid date (YYYY-MM-DD).";
            }
        }
        if (isset($rules['time'])) {
            if (!preg_match('/^([01]?\d|2[0-3]):([0-5]\d)(:([0-5]\d))?$/', $value, $m)) {
                return "$label must be a valid time (HH:MM).";
            }
            $value = sprintf('%02d:%s:%s', (int)$m[1], $m[2], ($m[4] ?? '') !== '' ? $m[4] : '00');
        }
        if (isset($rules['email']) && !filter_var($value, FILTER_VALIDATE_EMAIL)) {
            return "$label must be a valid email address.";
        }
        if (isset($rules['cnic'])) {
            $digits = preg_replace('/\D/', '', $value);
            if (strlen($digits) === 13) {
                $value = substr($digits, 0, 5) . '-' . substr($digits, 5, 7) . '-' . substr($digits, 12);
            }
            if (!preg_match(self::CNIC_REGEX, $value)) {
                return "$label must be in the format 00000-0000000-0.";
            }
        }
        if (isset($rules['phone']) && !preg_match('/^\+?[0-9][0-9 \-]{6,18}$/', $value)) {
            return "$label must be a valid phone number.";
        }
        if (isset($rules['code']) && !preg_match('/^[A-Za-z0-9][A-Za-z0-9_\-\/]*$/', $value)) {
            return "$label may contain only letters, digits, - _ /.";
        }
        if (isset($rules['in'])) {
            $allowed = explode(',', (string)$rules['in']);
            if (!in_array((string)$value, $allowed, true)) {
                return "$label has an invalid value.";
            }
        }
        $numeric = isset($rules['int']) || isset($rules['num']);
        if (isset($rules['min'])) {
            $min = (float)$rules['min'];
            if ($numeric ? $value < $min : mb_strlen((string)$value) < $min) {
                return $numeric ? "$label must be at least {$rules['min']}." : "$label must be at least {$rules['min']} characters.";
            }
        }
        if (isset($rules['max'])) {
            $max = (float)$rules['max'];
            if ($numeric ? $value > $max : mb_strlen((string)$value) > $max) {
                return $numeric ? "$label must not exceed {$rules['max']}." : "$label must not exceed {$rules['max']} characters.";
            }
        }
        if (isset($rules['exists'])) {
            $table = (string)$rules['exists'];
            if (!preg_match('/^[a-z_]+$/', $table)) {
                throw new \LogicException('Bad exists rule');
            }
            if (!Database::value("SELECT 1 FROM `$table` WHERE id = ?", [(int)$value])) {
                return "Selected $label does not exist.";
            }
        }
        return null;
    }

    /** Standalone CNIC check (used by tests and other modules). */
    public static function isCnic(string $s): bool
    {
        return (bool)preg_match(self::CNIC_REGEX, $s);
    }
}
