<?php
declare(strict_types=1);

namespace Prod\Controllers;

use Prod\ApiException;
use Prod\Database;
use Prod\Importer;
use Prod\Request;

final class ImportController
{
    public function upload(Request $r): array
    {
        $f = $_FILES['file'] ?? null;
        if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            $err = is_array($f) ? (int)$f['error'] : UPLOAD_ERR_NO_FILE;
            throw ApiException::validation(['file' => match ($err) {
                UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE => 'The file is larger than the server allows (upload_max_filesize = ' . ini_get('upload_max_filesize') . ').',
                UPLOAD_ERR_NO_FILE => 'Choose a file.',
                default => 'Upload failed. Please try again.',
            }]);
        }
        $token = Importer::stash($f['tmp_name'], (string)$f['name']);
        return Importer::preview($token);
    }

    public function preview(Request $r): array
    {
        return Importer::preview((string)$r->input('token', ''), (string)$r->input('sheet', ''));
    }

    public function commit(Request $r): array
    {
        return Importer::commit((string)$r->input('token', ''), (string)$r->input('mode', ''));
    }

    public function batches(Request $r): array
    {
        return Database::all(
            'SELECT b.*, u.username, (SELECT COUNT(*) FROM production_entries e WHERE e.import_batch_id = b.id) AS rows_now
               FROM import_batches b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 100'
        );
    }
}
