<?php
declare(strict_types=1);

namespace App;

final class Http
{
    /** Headers that stop browsers, proxies and LiteSpeed Cache from caching dynamic responses. */
    public static function noStore(): void
    {
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
        header('Pragma: no-cache');
        header('Expires: 0');
        header('X-LiteSpeed-Cache-Control: no-cache');
    }

    public static function securityHeaders(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
    }

    public static function json(mixed $payload, int $status = 200): never
    {
        http_response_code($status);
        self::noStore();
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        exit;
    }

    public static function ok(mixed $data = null, array $extra = []): never
    {
        self::json(['ok' => true, 'data' => $data] + $extra);
    }

    public static function error(string $message, int $status = 400, array $errors = []): never
    {
        $payload = ['ok' => false, 'error' => $message];
        if ($errors) {
            $payload['errors'] = $errors;
        }
        self::json($payload, $status);
    }

    public static function e(?string $s): string
    {
        return htmlspecialchars((string)$s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    }
}
