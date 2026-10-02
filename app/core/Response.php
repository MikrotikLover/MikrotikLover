<?php
declare(strict_types=1);

final class Response
{
    /**
     * Headers that keep browsers, proxies and LiteSpeed Cache (Hostinger)
     * from caching any API/JSON response.
     */
    public static function noCache(): void
    {
        if (headers_sent()) {
            return;
        }
        header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private');
        header('Pragma: no-cache');
        header('Expires: Thu, 01 Jan 1970 00:00:00 GMT');
        header('X-LiteSpeed-Cache-Control: no-cache');
        header('X-LiteSpeed-Tag: fpms-api');
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
    }

    public static function json(mixed $payload, int $status = 200): never
    {
        self::noCache();
        if (!headers_sent()) {
            http_response_code($status);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PRESERVE_ZERO_FRACTION
        );
        exit;
    }

    public static function ok(mixed $data = null, int $status = 200, ?string $message = null): never
    {
        $payload = ['ok' => true, 'data' => $data];
        if ($message !== null) {
            $payload['message'] = $message;
        }
        self::json($payload, $status);
    }

    public static function error(string $message, int $status, array $errors = [], ?string $code = null): never
    {
        $payload = ['ok' => false, 'message' => $message];
        if ($errors) {
            $payload['errors'] = $errors;
        }
        if ($code !== null) {
            $payload['code'] = $code;
        }
        self::json($payload, $status);
    }
}
