<?php
declare(strict_types=1);

namespace App;

/** Writes the audit trail: who changed what, with old/new values as JSON. */
final class Audit
{
    private const IGNORE = ['created_at', 'updated_at', 'created_by', 'updated_by', 'password_hash'];

    public static function log(
        string $action,
        string $entity,
        ?int $entityId = null,
        ?array $old = null,
        ?array $new = null,
        ?int $userId = null
    ): void {
        if ($old !== null && $new !== null) {
            // Keep only the fields that actually changed.
            $changedOld = [];
            $changedNew = [];
            foreach ($new as $k => $v) {
                if (in_array($k, self::IGNORE, true)) {
                    continue;
                }
                $ov = $old[$k] ?? null;
                if (!self::same($ov, $v)) {
                    $changedOld[$k] = $ov;
                    $changedNew[$k] = $v;
                }
            }
            if (!$changedNew && $action === 'update') {
                return;
            }
            [$old, $new] = [$changedOld, $changedNew];
        }
        Database::insert('audit_log', [
            'user_id'    => $userId ?? Auth::id(),
            'action'     => $action,
            'entity'     => $entity,
            'entity_id'  => $entityId,
            'old_values' => $old === null ? null : json_encode(self::clean($old), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'new_values' => $new === null ? null : json_encode(self::clean($new), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            'ip_address' => Request::ip(),
            'user_agent' => mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255),
        ]);
    }

    private static function same(mixed $a, mixed $b): bool
    {
        if (is_array($a) || is_array($b)) {
            return json_encode($a) === json_encode($b);
        }
        if (is_numeric($a) && is_numeric($b)) {
            return (float)$a === (float)$b;
        }
        return (string)$a === (string)$b;
    }

    private static function clean(array $a): array
    {
        foreach (self::IGNORE as $k) {
            unset($a[$k]);
        }
        return $a;
    }
}
