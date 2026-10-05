<?php
declare(strict_types=1);

namespace Prod;

/** Writes the audit trail: who changed what, with the changed fields only as old/new JSON. */
final class Audit
{
    private const IGNORE = ['created_at', 'updated_at', 'created_by', 'updated_by', 'password_hash', 'session_version'];

    public static function log(string $action, string $entity, ?int $entityId = null, ?array $old = null, ?array $new = null, ?int $userId = null): void
    {
        if ($old !== null && $new !== null) {
            $o = $n = [];
            foreach ($new as $k => $v) {
                if (in_array($k, self::IGNORE, true)) {
                    continue;
                }
                $ov = $old[$k] ?? null;
                $same = (is_numeric($ov) && is_numeric($v)) ? (float)$ov === (float)$v : (string)$ov === (string)$v;
                if (!$same) {
                    $o[$k] = $ov;
                    $n[$k] = $v;
                }
            }
            if (!$n && $action === 'update') {
                return;
            }
            [$old, $new] = [$o, $n];
        }
        $enc = fn(?array $a) => $a === null ? null : json_encode(array_diff_key($a, array_flip(self::IGNORE)), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        Database::insert('audit_log', [
            'user_id'    => $userId ?? Auth::id(),
            'action'     => $action,
            'entity'     => $entity,
            'entity_id'  => $entityId,
            'old_values' => $enc($old),
            'new_values' => $enc($new),
            'ip_address' => Request::ip(),
        ]);
    }
}
