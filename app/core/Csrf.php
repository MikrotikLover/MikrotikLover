<?php
declare(strict_types=1);

/**
 * Synchroniser-token CSRF protection. The token lives in the session and must
 * be echoed in the X-CSRF-Token header on every state-changing request.
 */
final class Csrf
{
    public static function token(): string
    {
        if (empty($_SESSION['csrf']) || !is_string($_SESSION['csrf'])) {
            $_SESSION['csrf'] = bin2hex(random_bytes(32));
        }
        return $_SESSION['csrf'];
    }

    public static function rotate(): string
    {
        unset($_SESSION['csrf']);
        return self::token();
    }

    public static function verify(): void
    {
        $sent = Request::header('X-CSRF-Token') ?? '';
        $expected = $_SESSION['csrf'] ?? '';
        if (!is_string($expected) || $expected === '' || !hash_equals($expected, $sent)) {
            throw new HttpException(419, Lang::t('csrf.invalid'), [], 'csrf');
        }
    }
}
