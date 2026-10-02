<?php
declare(strict_types=1);

/**
 * Thrown anywhere in a request to produce a JSON error response.
 * $errors maps field names to messages (shown beside the field by the UI).
 */
final class HttpException extends RuntimeException
{
    public function __construct(
        public readonly int $status,
        string $message,
        public readonly array $errors = [],
        public readonly ?string $errorCode = null,
    ) {
        parent::__construct($message, $status);
    }

    public static function validation(array $errors, ?string $message = null): self
    {
        return new self(422, $message ?? Lang::t('validation.failed'), $errors, 'validation');
    }

    public static function notFound(?string $message = null): self
    {
        return new self(404, $message ?? Lang::t('error.not_found'), [], 'not_found');
    }

    public static function forbidden(?string $message = null): self
    {
        return new self(403, $message ?? Lang::t('error.forbidden'), [], 'forbidden');
    }
}
