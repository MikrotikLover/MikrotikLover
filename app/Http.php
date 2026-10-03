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

    public static function isHttps(): bool
    {
        return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    }

    public static function securityHeaders(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('X-Frame-Options: SAMEORIGIN');
        header('Referrer-Policy: same-origin');
        header('Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()');
        header('Cross-Origin-Opener-Policy: same-origin');
        if (self::isHttps()) {
            header('Strict-Transport-Security: max-age=31536000');
        }
    }

    /**
     * Content-Security-Policy for HTML pages. With a nonce only scripts carrying it (and same-origin
     * modules) run; without one, inline scripts are allowed (print pages, kiosk, TV) but nothing external.
     */
    public static function csp(?string $nonce = null): void
    {
        $script = $nonce !== null ? "'self' 'nonce-$nonce'" : "'self' 'unsafe-inline'";
        header("Content-Security-Policy: default-src 'self'; script-src $script; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            . "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; "
            . "base-uri 'self'; form-action 'self'; frame-ancestors 'self'");
    }

    /** Random value for a CSP nonce. */
    public static function nonce(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
    }

    public static function json(mixed $payload, int $status = 200): never
    {
        http_response_code($status);
        self::noStore();
        header('Content-Type: application/json; charset=utf-8');
        header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
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
