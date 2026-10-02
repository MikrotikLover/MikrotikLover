<?php
declare(strict_types=1);

/**
 * Small rule-based validator. Returns cleaned data or throws a 422
 * HttpException whose errors map field => message (shown beside the field).
 *
 * Rules (pipe separated):
 *   required, nullable, string, integer, numeric, bool, email, date,
 *   min:N / max:N (string length), gte:N / lte:N (numeric value),
 *   in:a,b,c, regex:/pattern/ (may appear anywhere), username, password,
 *   unique:table,column[,ignoreId], exists:table,column[,soft]
 *
 * Cleaning: strings are trimmed; empty optional values become null;
 * integer → int, bool → 0/1, numeric → normalised numeric string.
 */
final class Validator
{
    public static function make(array $input, array $rules): array
    {
        $clean = [];
        $errors = [];

        foreach ($rules as $field => $ruleString) {
            $rules = self::parse($ruleString);
            $present = array_key_exists($field, $input);
            $value = $present ? $input[$field] : null;
            if (is_string($value)) {
                $value = trim($value);
            }
            $isEmpty = $value === null || $value === '' || (is_array($value) && $value === []);

            if (isset($rules['bool'])) {
                if ($isEmpty) {
                    $clean[$field] = isset($rules['required']) ? null : 0;
                    if (isset($rules['required'])) {
                        $errors[$field] = Lang::t('validation.required');
                    }
                    continue;
                }
                $b = filter_var($value, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE);
                if ($b === null) {
                    $errors[$field] = Lang::t('validation.bool');
                    continue;
                }
                $clean[$field] = $b ? 1 : 0;
                continue;
            }

            if ($isEmpty) {
                if (isset($rules['required'])) {
                    $errors[$field] = Lang::t('validation.required');
                } else {
                    $clean[$field] = null;
                }
                continue;
            }

            $error = self::check($field, $value, $rules, $clean);
            if ($error !== null) {
                $errors[$field] = $error;
            }
        }

        if ($errors) {
            throw HttpException::validation($errors);
        }
        return $clean;
    }

    private static function check(string $field, mixed $value, array $rules, array &$clean): ?string
    {
        if (is_array($value) || is_object($value)) {
            return Lang::t('validation.string');
        }

        if (isset($rules['integer'])) {
            if (filter_var($value, FILTER_VALIDATE_INT) === false) {
                return Lang::t('validation.integer');
            }
            $value = (int) $value;
        } elseif (isset($rules['numeric'])) {
            if (!is_numeric($value)) {
                return Lang::t('validation.numeric');
            }
            // Keep the decimal string as typed (no float rounding); MySQL DECIMAL stores it exactly.
            $value = ltrim((string) $value, '+');
        } else {
            $value = (string) $value;
        }

        foreach ($rules as $rule => $arg) {
            $error = match ($rule) {
                'string'   => null,
                'min'      => mb_strlen((string) $value) < (int) $arg ? Lang::t('validation.min', ['min' => $arg]) : null,
                'max'      => mb_strlen((string) $value) > (int) $arg ? Lang::t('validation.max', ['max' => $arg]) : null,
                'gte'      => (float) $value < (float) $arg ? Lang::t('validation.min_value', ['min' => $arg]) : null,
                'lte'      => (float) $value > (float) $arg ? Lang::t('validation.max_value', ['max' => $arg]) : null,
                'email'    => filter_var($value, FILTER_VALIDATE_EMAIL) === false ? Lang::t('validation.email') : null,
                'date'     => !self::isDate((string) $value) ? Lang::t('validation.date') : null,
                'in'       => !in_array((string) $value, explode(',', (string) $arg), true) ? Lang::t('validation.in') : null,
                'regex'    => !preg_match((string) $arg, (string) $value) ? Lang::t('validation.regex') : null,
                'username' => !preg_match('/^[A-Za-z0-9._-]{3,50}$/', (string) $value) ? Lang::t('validation.username') : null,
                'password' => !self::strongPassword((string) $value) ? Lang::t('validation.password') : null,
                'unique'   => self::existsInTable((string) $arg, $value, true) ? Lang::t('validation.unique') : null,
                'exists'   => !self::existsInTable((string) $arg, $value, false) ? Lang::t('validation.exists') : null,
                default    => null,
            };
            if ($error !== null) {
                return $error;
            }
        }

        $clean[$field] = $value;
        return null;
    }

    public static function strongPassword(string $password): bool
    {
        return mb_strlen($password) >= 8
            && mb_strlen($password) <= 72 // bcrypt limit
            && preg_match('/\pL/u', $password)
            && preg_match('/\d/', $password);
    }

    public static function isDate(string $value): bool
    {
        $d = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
        return $d !== false && $d->format('Y-m-d') === $value;
    }

    /** unique: "table,column[,ignoreId]"; exists: "table,column[,soft]" */
    private static function existsInTable(string $arg, mixed $value, bool $forUnique): bool
    {
        $parts = array_map('trim', explode(',', $arg));
        [$table, $column] = [$parts[0] ?? '', $parts[1] ?? ''];
        foreach ([$table, $column] as $ident) {
            if (!preg_match('/^[a-z_][a-z0-9_]*$/', $ident)) {
                throw new InvalidArgumentException("Invalid identifier in validation rule: $ident");
            }
        }
        $sql = "SELECT 1 FROM `$table` WHERE `$column` = :v";
        $params = ['v' => $value];
        if ($forUnique && isset($parts[2]) && $parts[2] !== '' && ctype_digit($parts[2])) {
            $sql .= ' AND id <> :ignore';
            $params['ignore'] = (int) $parts[2];
        }
        if (!$forUnique && ($parts[2] ?? '') === 'soft') {
            $sql .= ' AND deleted_at IS NULL';
        }
        return DB::value($sql . ' LIMIT 1', $params) !== null;
    }

    private static function parse(string $ruleString): array
    {
        $rules = [];
        $len = strlen($ruleString);
        $i = 0;
        while ($i < $len) {
            // regex:/pattern/flags may contain "|" or ":" — read it up to its closing delimiter.
            if (substr_compare($ruleString, 'regex:', $i, 6) === 0) {
                $start = $i + 6;
                $delim = $ruleString[$start] ?? '/';
                $j = $start + 1;
                while ($j < $len && !($ruleString[$j] === $delim && $ruleString[$j - 1] !== '\\')) {
                    $j++;
                }
                $j++;
                while ($j < $len && ctype_alpha($ruleString[$j])) {
                    $j++; // flags
                }
                $rules['regex'] = substr($ruleString, $start, $j - $start);
                $i = $j + 1; // skip the "|" separator
                continue;
            }
            $next = strpos($ruleString, '|', $i);
            $rule = $next === false ? substr($ruleString, $i) : substr($ruleString, $i, $next - $i);
            $i = $next === false ? $len : $next + 1;
            if ($rule === '') {
                continue;
            }
            [$name, $arg] = array_pad(explode(':', $rule, 2), 2, true);
            $rules[$name] = $arg;
        }
        return $rules;
    }
}
