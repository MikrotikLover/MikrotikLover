<?php
declare(strict_types=1);

final class Request
{
    private static ?array $body = null;

    public static function method(): string
    {
        return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    }

    /** Route comes from ?r=users/5 so the API works without URL rewriting. */
    public static function route(): string
    {
        $route = (string) ($_GET['r'] ?? '');
        if ($route === '' && !empty($_SERVER['PATH_INFO'])) {
            $route = (string) $_SERVER['PATH_INFO'];
        }
        return trim($route, '/');
    }

    /** Decoded JSON body (or form body as a fallback). */
    public static function body(): array
    {
        if (self::$body === null) {
            $raw = file_get_contents('php://input') ?: '';
            $type = $_SERVER['CONTENT_TYPE'] ?? '';
            if ($raw !== '' && str_contains($type, 'application/json')) {
                try {
                    $decoded = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
                } catch (JsonException) {
                    throw new HttpException(400, Lang::t('error.bad_json'), [], 'bad_json');
                }
                self::$body = is_array($decoded) ? $decoded : [];
            } else {
                self::$body = $_POST;
            }
        }
        return self::$body;
    }

    public static function input(string $key, mixed $default = null): mixed
    {
        return self::body()[$key] ?? $default;
    }

    public static function query(string $key, mixed $default = null): mixed
    {
        $value = $_GET[$key] ?? $default;
        return is_string($value) ? trim($value) : $value;
    }

    public static function queryInt(string $key, int $default = 0): int
    {
        $value = $_GET[$key] ?? null;
        return is_numeric($value) ? (int) $value : $default;
    }

    public static function header(string $name): ?string
    {
        $key = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
        $value = $_SERVER[$key] ?? null;
        return is_string($value) ? $value : null;
    }

    public static function ip(): string
    {
        // REMOTE_ADDR is the only value a client cannot forge. Hostinger's
        // LiteSpeed sets it to the real visitor address.
        return substr((string) ($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
    }

    public static function userAgent(): string
    {
        return mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);
    }

    public static function isHttps(): bool
    {
        return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || (int) ($_SERVER['SERVER_PORT'] ?? 0) === 443
            || strtolower((string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')) === 'https';
    }

    /** Page / per-page from the query string with sane limits. */
    public static function paging(int $defaultPerPage = 25, int $maxPerPage = 200): array
    {
        $page = max(1, self::queryInt('page', 1));
        $perPage = min($maxPerPage, max(1, self::queryInt('per_page', $defaultPerPage)));
        return [$page, $perPage, ($page - 1) * $perPage];
    }
}
