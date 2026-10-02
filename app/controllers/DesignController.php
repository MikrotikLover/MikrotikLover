<?php
declare(strict_types=1);

/**
 * Design library: design header + ink per colour (design_inks) + non-ink BOM
 * (design_bom) + design image stored OUTSIDE the deploy folder.
 *
 * Body for create/update:
 *   { ...header fields,
 *     inks: [{ink_colour_id, coverage_pct, is_manual, ml_per_meter, item_id}],
 *     bom:  [{item_id, qty_per_meter, wastage_pct}] }
 * Line errors are returned as "inks.<row>.<field>" / "bom.<row>.<field>".
 */
final class DesignController extends MasterController
{
    private const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
    private const MAX_PIXELS = 60_000_000;
    private const FULL_MAX_EDGE = 2400;
    private const THUMB_MAX_EDGE = 360;

    protected string $table = 'designs';
    protected string $codeColumn = 'design_code';
    protected string $codePrefix = 'D';
    protected array $searchColumns = ['design_code', 'name'];
    protected string $orderBy = 't.design_code';
    protected array $intColumns = ['id', 'is_active', 'party_id', 'colour_count', 'finished_item_id', 'default_machine_id'];

    protected function selectSql(): string
    {
        return 't.*, p.name AS party_name, p.name_ur AS party_name_ur, m.name AS machine_name,
                fi.code AS finished_item_code, fi.name AS finished_item_name';
    }

    protected function joinSql(): string
    {
        return 'LEFT JOIN parties p ON p.id = t.party_id
                LEFT JOIN machines m ON m.id = t.default_machine_id
                LEFT JOIN items fi ON fi.id = t.finished_item_id';
    }

    protected function cast(array $row): array
    {
        $row = parent::cast($row);
        $v = $row['image_path'] ? substr(md5((string) $row['image_path']), 0, 10) : null;
        $row['image_url'] = $v ? "api/index.php?r=designs/{$row['id']}/image&size=full&v=$v" : null;
        $row['thumb_url'] = $v ? "api/index.php?r=designs/{$row['id']}/image&size=thumb&v=$v" : null;
        unset($row['image_path'], $row['thumb_path']);
        return $row;
    }

    protected function rules(?int $id): array
    {
        return [
            'design_code'        => 'nullable|string|max:30|regex:/^[A-Za-z0-9._\/-]+$/|unique:designs,design_code' . ($id ? ",$id" : ''),
            'name'               => 'required|string|max:120',
            'party_id'           => 'nullable|integer|exists:parties,id,soft',
            'process_type'       => 'required|in:sublimation,reactive,pigment',
            'repeat_width_cm'    => 'nullable|numeric|gte:0|lte:10000',
            'repeat_height_cm'   => 'nullable|numeric|gte:0|lte:10000',
            'colour_count'       => 'nullable|integer|gte:0|lte:30',
            'ink_coverage_pct'   => 'nullable|numeric|gte:0|lte:3000',
            'basis_gsm'          => 'nullable|numeric|gte:0|lte:5000',
            'basis_width_inch'   => 'nullable|numeric|gte:0|lte:1000',
            'finished_item_id'   => 'nullable|integer|exists:items,id,soft',
            'default_machine_id' => 'nullable|integer|exists:machines,id,soft',
            'remarks'            => 'nullable|string|max:255',
            'is_active'          => 'bool',
        ];
    }

    protected function prepare(array $data, ?array $old): array
    {
        $body = Request::body();
        $errors = [];

        if ($data['finished_item_id'] !== null
            && DB::value('SELECT item_type FROM items WHERE id = :id', ['id' => $data['finished_item_id']]) !== 'finished_fabric') {
            $errors['finished_item_id'] = Lang::t('design.finished_item_type');
        }

        // ---- ink per colour
        $inks = [];
        $seen = [];
        $params = InkService::params();
        foreach (array_values(is_array($body['inks'] ?? null) ? $body['inks'] : []) as $i => $line) {
            if (!is_array($line) || self::blank($line['ink_colour_id'] ?? null)) {
                continue; // empty grid row
            }
            $p = 'inks.' . (isset($line['_row']) && is_numeric($line['_row']) ? (int) $line['_row'] : $i) . '.';
            $colourId = filter_var($line['ink_colour_id'], FILTER_VALIDATE_INT);
            if ($colourId === false || !DB::value('SELECT 1 FROM ink_colours WHERE id = :id AND deleted_at IS NULL', ['id' => $colourId])) {
                $errors[$p . 'ink_colour_id'] = Lang::t('validation.exists');
                continue;
            }
            if (isset($seen[$colourId])) {
                $errors[$p . 'ink_colour_id'] = Lang::t('design.duplicate_colour');
                continue;
            }
            $seen[$colourId] = true;

            $coverage = $line['coverage_pct'] ?? '';
            if (!is_numeric($coverage) || $coverage < 0 || $coverage > 100) {
                $errors[$p . 'coverage_pct'] = Lang::t('validation.max_value', ['max' => 100]);
                continue;
            }
            $manual = filter_var($line['is_manual'] ?? false, FILTER_VALIDATE_BOOLEAN);
            $ml = $line['ml_per_meter'] ?? null;
            if ($manual && (!is_numeric($ml) || $ml < 0 || $ml > 100000)) {
                $errors[$p . 'ml_per_meter'] = Lang::t('validation.numeric');
                continue;
            }
            $itemId = null;
            if (!self::blank($line['item_id'] ?? null)) {
                $itemId = filter_var($line['item_id'], FILTER_VALIDATE_INT);
                $item = $itemId ? DB::one("SELECT ink_colour_id FROM items WHERE id = :id AND item_type = 'ink' AND deleted_at IS NULL", ['id' => $itemId]) : null;
                if ($item === null) {
                    $errors[$p . 'item_id'] = Lang::t('validation.exists');
                    continue;
                }
                if ((int) $item['ink_colour_id'] !== $colourId) {
                    $errors[$p . 'item_id'] = Lang::t('design.ink_colour_mismatch');
                    continue;
                }
            }
            $inks[] = [
                'ink_colour_id' => $colourId,
                'item_id'       => $itemId,
                'coverage_pct'  => (string) $coverage,
                'is_manual'     => $manual ? 1 : 0,
                'ml_per_meter'  => $manual ? (string) $ml : null,
            ];
        }

        $needsBasis = (bool) array_filter($inks, fn ($l) => !$l['is_manual'] && (float) $l['coverage_pct'] > 0);
        if ($needsBasis) {
            foreach (['basis_gsm', 'basis_width_inch'] as $f) {
                if (empty($data[$f]) || (float) $data[$f] <= 0) {
                    $errors[$f] = Lang::t('design.basis_required');
                }
            }
        }
        foreach ($inks as &$l) {
            if (!$l['is_manual']) {
                $l['ml_per_meter'] = (string) InkService::mlPerMeter((float) $l['coverage_pct'], (float) ($data['basis_gsm'] ?? 0), (float) ($data['basis_width_inch'] ?? 0), $params);
            }
        }
        unset($l);

        // ---- non-ink BOM
        $bom = [];
        $seenItems = [];
        foreach (array_values(is_array($body['bom'] ?? null) ? $body['bom'] : []) as $i => $line) {
            if (!is_array($line) || self::blank($line['item_id'] ?? null)) {
                continue;
            }
            $p = 'bom.' . (isset($line['_row']) && is_numeric($line['_row']) ? (int) $line['_row'] : $i) . '.';
            $itemId = filter_var($line['item_id'], FILTER_VALIDATE_INT);
            $type = $itemId ? DB::value('SELECT item_type FROM items WHERE id = :id AND deleted_at IS NULL', ['id' => $itemId]) : null;
            if ($type === null) {
                $errors[$p . 'item_id'] = Lang::t('validation.exists');
                continue;
            }
            if (!in_array($type, ['paper', 'chemical', 'other'], true)) {
                $errors[$p . 'item_id'] = Lang::t('design.bom_item_type');
                continue;
            }
            if (isset($seenItems[$itemId])) {
                $errors[$p . 'item_id'] = Lang::t('design.duplicate_item');
                continue;
            }
            $seenItems[$itemId] = true;
            $qty = $line['qty_per_meter'] ?? '';
            if (!is_numeric($qty) || $qty <= 0 || $qty > 100000) {
                $errors[$p . 'qty_per_meter'] = Lang::t('validation.min_value', ['min' => '> 0']);
                continue;
            }
            $wastage = self::blank($line['wastage_pct'] ?? null) ? '0' : $line['wastage_pct'];
            if (!is_numeric($wastage) || $wastage < 0 || $wastage > 100) {
                $errors[$p . 'wastage_pct'] = Lang::t('validation.max_value', ['max' => 100]);
                continue;
            }
            $bom[] = ['item_id' => $itemId, 'qty_per_meter' => (string) $qty, 'wastage_pct' => (string) $wastage];
        }

        self::fail($errors);

        if ($inks) {
            $data['colour_count'] = count($inks);
            $data['ink_coverage_pct'] = (string) round(array_sum(array_map(fn ($l) => (float) $l['coverage_pct'], $inks)), 2);
        }
        $data['colour_count'] ??= 0;
        $data['ink_coverage_pct'] ??= 0;
        $data['inks'] = $inks;
        $data['bom'] = $bom;
        return $data;
    }

    protected function afterSave(int $id, array $data, ?array $old): void
    {
        DB::query('DELETE FROM design_inks WHERE design_id = :d', ['d' => $id]);
        foreach ($data['inks'] as $l) {
            DB::insert('design_inks', ['design_id' => $id] + $l);
        }
        DB::query('DELETE FROM design_bom WHERE design_id = :d', ['d' => $id]);
        foreach ($data['bom'] as $l) {
            DB::insert('design_bom', ['design_id' => $id] + $l);
        }
    }

    protected function details(array $row): array
    {
        $ink = InkService::designInkCost((int) $row['id']);
        $bom = DB::all(
            'SELECT b.id, b.item_id, b.qty_per_meter, b.wastage_pct, i.code AS item_code, i.name AS item_name,
                    i.item_type, i.rate, u.code AS unit_code
             FROM design_bom b JOIN items i ON i.id = b.item_id JOIN units u ON u.id = i.unit_id
             WHERE b.design_id = :d ORDER BY b.id',
            ['d' => (int) $row['id']]
        );
        $bomCost = 0.0;
        foreach ($bom as &$b) {
            $b['id'] = (int) $b['id'];
            $b['item_id'] = (int) $b['item_id'];
            $b['cost_per_meter'] = round((float) $b['qty_per_meter'] * (1 + (float) $b['wastage_pct'] / 100) * (float) $b['rate'], 4);
            $bomCost += $b['cost_per_meter'];
        }
        unset($b);

        $row['inks'] = $ink['lines'];
        $row['bom'] = $bom;
        $row['costs'] = [
            'ink_ml_per_meter'   => $ink['ml_per_meter'],
            'ink_cost_per_meter' => $ink['cost_per_meter'],
            'bom_cost_per_meter' => round($bomCost, 4),
            'material_cost_per_meter' => round($ink['cost_per_meter'] + $bomCost, 4),
        ];
        return $row;
    }

    protected function applyFilters(array &$where, array &$params): void
    {
        if (($party = Request::queryInt('party_id')) > 0) {
            $where[] = 't.party_id = :party';
            $params['party'] = $party;
        }
        $process = (string) Request::query('process_type', '');
        if (in_array($process, ['sublimation', 'reactive', 'pigment'], true)) {
            $where[] = 't.process_type = :pt';
            $params['pt'] = $process;
        }
    }

    protected function references(): array
    {
        return [
            ['stock_movements', 'design_id'], ['production_estimations', 'design_id'], ['productions', 'design_id'],
            ['stock_consumptions', 'design_id'], ['delivery_chalan_lines', 'design_id'],
        ];
    }

    /* ------------------------------------------------------------- images */

    /** POST designs/{id}/image (multipart field "image") */
    public function uploadImage(int $id): never
    {
        $design = DB::one('SELECT id, design_code, image_path, thumb_path FROM designs WHERE id = :id AND deleted_at IS NULL', ['id' => $id]);
        if ($design === null) {
            throw HttpException::notFound();
        }
        $file = $_FILES['image'] ?? null;
        if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($file['tmp_name'])) {
            $code = is_array($file) ? (int) $file['error'] : UPLOAD_ERR_NO_FILE;
            self::fail(['image' => Lang::t(in_array($code, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) ? 'upload.too_large' : 'upload.failed')]);
        }
        if ($file['size'] > self::MAX_UPLOAD_BYTES) {
            self::fail(['image' => Lang::t('upload.too_large')]);
        }
        $info = @getimagesize($file['tmp_name']);
        $types = [IMAGETYPE_JPEG => 'jpg', IMAGETYPE_PNG => 'png', IMAGETYPE_WEBP => 'webp'];
        if ($info === false || !isset($types[$info[2]])) {
            self::fail(['image' => Lang::t('upload.bad_type')]);
        }
        if ($info[0] * $info[1] > self::MAX_PIXELS) {
            self::fail(['image' => Lang::t('upload.too_many_pixels')]);
        }

        $dir = Config::path('uploads/designs');
        if ($dir === null) {
            throw new HttpException(500, Lang::t('upload.storage'), [], 'storage');
        }
        $base = sprintf('%d-%s', $id, bin2hex(random_bytes(6)));
        [$fullName, $thumbName] = $this->storeImage($file['tmp_name'], $info, $dir, $base, $types[$info[2]]);

        DB::transaction(function () use ($id, $design, $fullName, $thumbName): void {
            DB::update('designs', [
                'image_path' => 'designs/' . $fullName,
                'thumb_path' => 'designs/' . $thumbName,
                'updated_at' => DB::now(),
                'updated_by' => Auth::id(),
            ], $id);
            Audit::log('update', 'designs', $id, ['image' => $design['image_path']], ['image' => 'designs/' . $fullName], $design['design_code']);
        });
        $this->removeFiles($design);
        Response::ok($this->show($id), 200, Lang::t('saved'));
    }

    /** DELETE designs/{id}/image */
    public function deleteImage(int $id): never
    {
        $design = DB::one('SELECT id, design_code, image_path, thumb_path FROM designs WHERE id = :id AND deleted_at IS NULL', ['id' => $id]);
        if ($design === null) {
            throw HttpException::notFound();
        }
        DB::transaction(function () use ($id, $design): void {
            DB::update('designs', ['image_path' => null, 'thumb_path' => null, 'updated_at' => DB::now(), 'updated_by' => Auth::id()], $id);
            Audit::log('update', 'designs', $id, ['image' => $design['image_path']], ['image' => null], $design['design_code']);
        });
        $this->removeFiles($design);
        Response::ok($this->show($id), 200, Lang::t('deleted'));
    }

    /** GET designs/{id}/image?size=thumb|full — streams the file from the private folder. */
    public function image(int $id): never
    {
        $row = DB::one('SELECT image_path, thumb_path FROM designs WHERE id = :id AND deleted_at IS NULL', ['id' => $id]);
        $rel = (Request::query('size') === 'full' ? $row['image_path'] ?? null : $row['thumb_path'] ?? null) ?? null;
        $root = Config::path('uploads');
        $path = $rel && $root ? realpath($root . '/' . $rel) : false;
        // Never serve anything outside the uploads folder.
        if ($path === false || !str_starts_with($path, (string) realpath($root)) || !is_file($path)) {
            throw HttpException::notFound();
        }
        $mime = match (strtolower(pathinfo($path, PATHINFO_EXTENSION))) {
            'png'  => 'image/png',
            'webp' => 'image/webp',
            default => 'image/jpeg',
        };
        header_remove('Pragma');
        header_remove('Expires');
        // URL carries a content version (?v=), so the browser may keep it privately.
        header('Cache-Control: private, max-age=2592000, immutable');
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($path));
        header('Content-Disposition: inline; filename="design-' . $id . '.' . pathinfo($path, PATHINFO_EXTENSION) . '"');
        readfile($path);
        exit;
    }

    /**
     * Re-encodes the upload with GD (strips metadata / embedded payloads),
     * limits its size and writes a JPEG thumbnail. Falls back to storing the
     * validated original when GD is not available.
     * @return array{0: string, 1: string} [full file name, thumb file name]
     */
    private function storeImage(string $tmp, array $info, string $dir, string $base, string $ext): array
    {
        if (!function_exists('imagecreatetruecolor')) {
            $full = "$base.$ext";
            if (!move_uploaded_file($tmp, "$dir/$full")) {
                throw new HttpException(500, Lang::t('upload.storage'), [], 'storage');
            }
            return [$full, $full];
        }
        @ini_set('memory_limit', '512M');
        $src = match ($info[2]) {
            IMAGETYPE_PNG  => @imagecreatefrompng($tmp),
            IMAGETYPE_WEBP => function_exists('imagecreatefromwebp') ? @imagecreatefromwebp($tmp) : false,
            default        => @imagecreatefromjpeg($tmp),
        };
        if (!$src) {
            self::fail(['image' => Lang::t('upload.bad_type')]);
        }
        $keepPng = $info[2] === IMAGETYPE_PNG;
        $full = $base . ($keepPng ? '.png' : '.jpg');
        $thumb = $base . '-t.jpg';

        $fullImg = $this->resize($src, self::FULL_MAX_EDGE, $keepPng);
        $ok = $keepPng ? imagepng($fullImg, "$dir/$full", 6) : imagejpeg($fullImg, "$dir/$full", 86);
        $thumbImg = $this->resize($src, self::THUMB_MAX_EDGE, false);
        $ok = $ok && imagejpeg($thumbImg, "$dir/$thumb", 80);
        if (!$ok) {
            @unlink("$dir/$full");
            @unlink("$dir/$thumb");
            throw new HttpException(500, Lang::t('upload.storage'), [], 'storage');
        }
        return [$full, $thumb];
    }

    /** Fit within $maxEdge; JPEG output gets a white background (no black transparency). */
    private function resize(GdImage $src, int $maxEdge, bool $keepAlpha): GdImage
    {
        $w = imagesx($src);
        $h = imagesy($src);
        $scale = min(1.0, $maxEdge / max($w, $h));
        $nw = max(1, (int) round($w * $scale));
        $nh = max(1, (int) round($h * $scale));
        $dst = imagecreatetruecolor($nw, $nh);
        if ($keepAlpha) {
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
        } else {
            imagefill($dst, 0, 0, imagecolorallocate($dst, 255, 255, 255));
        }
        imagecopyresampled($dst, $src, 0, 0, 0, 0, $nw, $nh, $w, $h);
        return $dst;
    }

    private function removeFiles(array $design): void
    {
        $root = Config::path('uploads');
        foreach (array_unique(array_filter([$design['image_path'] ?? null, $design['thumb_path'] ?? null])) as $rel) {
            $path = realpath($root . '/' . $rel);
            if ($path && str_starts_with($path, (string) realpath($root))) {
                @unlink($path);
            }
        }
    }

    private static function blank(mixed $v): bool
    {
        return $v === null || $v === '' || (is_array($v) && $v === []);
    }
}
