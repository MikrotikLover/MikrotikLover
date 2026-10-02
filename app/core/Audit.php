<?php
declare(strict_types=1);

/**
 * Audit trail. Call inside the same DB transaction as the change so the log
 * and the data can never disagree.
 */
final class Audit
{
    private const HIDDEN = ['password', 'password_hash', 'new_password', 'current_password', 'confirm_password', 'setup_key'];

    public static function log(
        string $action,
        string $entity,
        ?int $entityId = null,
        ?array $old = null,
        ?array $new = null,
        ?string $reference = null,
        ?array $actor = null,
    ): void {
        $user = $actor ?? Auth::user();
        // For updates keep only changed fields (plus nothing else) to keep the log readable.
        if ($old !== null && $new !== null) {
            [$old, $new] = self::diff($old, $new);
        }
        DB::insert('audit_log', [
            'user_id'    => $user['id'] ?? null,
            'username'   => $user['username'] ?? null,
            'action'     => $action,
            'entity'     => $entity,
            'entity_id'  => $entityId,
            'reference'  => $reference !== null ? mb_substr($reference, 0, 60) : null,
            'old_values' => $old !== null ? self::encode($old) : null,
            'new_values' => $new !== null ? self::encode($new) : null,
            'ip'         => Request::ip(),
            'user_agent' => Request::userAgent(),
            'created_at' => DB::now(),
        ]);
    }

    /** @return array{0: array, 1: array} */
    private static function diff(array $old, array $new): array
    {
        $o = [];
        $n = [];
        foreach ($new as $key => $value) {
            $before = $old[$key] ?? null;
            if (self::normalise($before) !== self::normalise($value)) {
                $o[$key] = $before;
                $n[$key] = $value;
            }
        }
        return [$o, $n];
    }

    private static function normalise(mixed $v): string
    {
        if (is_array($v)) {
            return json_encode($v, JSON_UNESCAPED_UNICODE) ?: '';
        }
        if (is_bool($v)) {
            return $v ? '1' : '0';
        }
        if (is_numeric($v)) {
            return rtrim(rtrim(number_format((float) $v, 6, '.', ''), '0'), '.');
        }
        return (string) $v;
    }

    private static function encode(array $data): string
    {
        foreach (self::HIDDEN as $key) {
            if (array_key_exists($key, $data)) {
                $data[$key] = '***';
            }
        }
        return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) ?: '{}';
    }
}
