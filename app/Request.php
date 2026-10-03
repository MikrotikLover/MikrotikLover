<?php
declare(strict_types=1);

namespace App;

final class Request
{
    /** Largest JSON body accepted (a full salary sheet of ~2,000 employees is well below this). */
    private const MAX_JSON = 4 * 1024 * 1024;

    public readonly string $method;
    public readonly string $path;
    /** @var array<string,string> route parameters */
    public array $params = [];
    private ?array $body = null;

    public function __construct(?string $path = null)
    {
        $this->method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $uri = $path ?? (parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
        $this->path = '/' . trim($uri, '/');
    }

    public function query(string $key, mixed $default = null): mixed
    {
        $v = $_GET[$key] ?? $default;
        return is_string($v) ? trim($v) : $v;
    }

    public function queryInt(string $key, ?int $default = null): ?int
    {
        $v = $_GET[$key] ?? null;
        return ($v === null || $v === '' || !is_numeric($v)) ? $default : (int)$v;
    }

    /** Decoded JSON body (or form POST fields for multipart requests). */
    public function body(): array
    {
        if ($this->body === null) {
            $type = $_SERVER['CONTENT_TYPE'] ?? '';
            if (str_contains($type, 'application/json')) {
                if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > self::MAX_JSON) {
                    throw new ApiException('Request is too large.', 413);
                }
                $raw = file_get_contents('php://input', false, null, 0, self::MAX_JSON + 1) ?: '';
                if (strlen($raw) > self::MAX_JSON) {
                    throw new ApiException('Request is too large.', 413);
                }
                $decoded = $raw === '' ? [] : json_decode($raw, true);
                if (!is_array($decoded)) {
                    throw new ApiException('Invalid JSON body.', 400);
                }
                $this->body = $decoded;
            } else {
                $this->body = $_POST;
            }
        }
        return $this->body;
    }

    public function input(string $key, mixed $default = null): mixed
    {
        return $this->body()[$key] ?? $default;
    }

    public function param(string $key): string
    {
        return $this->params[$key] ?? '';
    }

    public function id(string $key = 'id'): int
    {
        $v = $this->params[$key] ?? '';
        if (!ctype_digit($v)) {
            throw ApiException::notFound();
        }
        return (int)$v;
    }

    public static function ip(): string
    {
        return substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 45);
    }
}
