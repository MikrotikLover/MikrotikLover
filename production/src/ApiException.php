<?php
declare(strict_types=1);

namespace Prod;

/** Thrown by controllers; rendered by the router as a JSON error response. */
class ApiException extends \RuntimeException
{
    /** @param array<string,string> $errors field => message */
    public function __construct(string $message, private int $status = 400, private array $errors = [])
    {
        parent::__construct($message);
    }

    public function status(): int
    {
        return $this->status;
    }

    public function errors(): array
    {
        return $this->errors;
    }

    public static function notFound(string $what = 'Record'): self
    {
        return new self("$what not found.", 404);
    }

    public static function forbidden(string $msg = 'You do not have permission for this action.'): self
    {
        return new self($msg, 403);
    }

    public static function conflict(string $msg): self
    {
        return new self($msg, 409);
    }

    public static function validation(array $errors, string $msg = 'Please correct the highlighted fields.'): self
    {
        return new self($msg, 422, $errors);
    }
}
