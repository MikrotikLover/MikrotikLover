<?php
declare(strict_types=1);

namespace App;

/**
 * Persistent file storage OUTSIDE the deploy directory (config: storage_path).
 * Files are never served directly; public/file.php streams them after an auth check.
 */
final class Storage
{
    public const DIRS = ['photos', 'logos', 'exports', 'logs'];

    public static function root(): string
    {
        $root = rtrim((string)Config::get('storage_path', APP_ROOT . '/storage'), '/\\');
        if (!is_dir($root)) {
            @mkdir($root, 0750, true);
        }
        return $root;
    }

    public static function path(string $dir): string
    {
        if (!in_array($dir, self::DIRS, true)) {
            throw new \InvalidArgumentException("Unknown storage dir $dir");
        }
        $p = self::root() . '/' . $dir;
        if (!is_dir($p)) {
            @mkdir($p, 0750, true);
        }
        return $p;
    }

    /** Resolve a stored file name safely (no traversal). Returns null if missing. */
    public static function file(string $dir, ?string $name): ?string
    {
        if ($name === null || $name === '' || !preg_match('/^[A-Za-z0-9_.-]+$/', $name) || str_contains($name, '..')) {
            return null;
        }
        $full = self::path($dir) . '/' . $name;
        return is_file($full) ? $full : null;
    }

    public static function delete(string $dir, ?string $name): void
    {
        $f = self::file($dir, $name);
        if ($f) {
            @unlink($f);
        }
    }

    /**
     * Validate an uploaded image, normalise it to a JPEG of the given box size
     * (cover-crop, EXIF stripped) and store it. Returns the stored file name.
     *
     * @param array $upload one entry of $_FILES
     */
    public static function storeImage(array $upload, string $dir, string $prefix, int $w, int $h, bool $keepPng = false): string
    {
        if (($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file($upload['tmp_name'] ?? '')) {
            throw new ApiException('Upload failed. Please try again.', 400);
        }
        $max = (int)Config::get('uploads.photo_max_bytes', 3 * 1024 * 1024);
        if (($upload['size'] ?? 0) > $max) {
            throw new ApiException('File is too large (max ' . round($max / 1048576, 1) . ' MB).', 413);
        }
        $info = @getimagesize($upload['tmp_name']);
        if (!$info || !in_array($info[2], [IMAGETYPE_JPEG, IMAGETYPE_PNG, IMAGETYPE_WEBP, IMAGETYPE_GIF], true)) {
            throw new ApiException('Only JPEG, PNG, WEBP or GIF images are allowed.', 415);
        }

        $name = $prefix . '_' . bin2hex(random_bytes(6));
        $target = self::path($dir);

        if (!function_exists('imagecreatetruecolor')) {
            // GD not available: store the validated original as-is.
            $ext = image_type_to_extension($info[2], false);
            $name .= '.' . ($ext === 'jpeg' ? 'jpg' : $ext);
            if (!move_uploaded_file($upload['tmp_name'], "$target/$name")) {
                throw new ApiException('Could not save the file.', 500);
            }
            return $name;
        }

        $src = match ($info[2]) {
            IMAGETYPE_JPEG => imagecreatefromjpeg($upload['tmp_name']),
            IMAGETYPE_PNG  => imagecreatefrompng($upload['tmp_name']),
            IMAGETYPE_WEBP => imagecreatefromwebp($upload['tmp_name']),
            IMAGETYPE_GIF  => imagecreatefromgif($upload['tmp_name']),
        };
        if (!$src) {
            throw new ApiException('The image could not be read.', 415);
        }
        [$sw, $sh] = [imagesx($src), imagesy($src)];

        if ($keepPng) {
            // Logos: fit inside box, keep transparency.
            $scale = min($w / $sw, $h / $sh, 1);
            $dw = max(1, (int)round($sw * $scale));
            $dh = max(1, (int)round($sh * $scale));
            $dst = imagecreatetruecolor($dw, $dh);
            imagealphablending($dst, false);
            imagesavealpha($dst, true);
            imagefill($dst, 0, 0, imagecolorallocatealpha($dst, 0, 0, 0, 127));
            imagecopyresampled($dst, $src, 0, 0, 0, 0, $dw, $dh, $sw, $sh);
            $name .= '.png';
            imagepng($dst, "$target/$name", 6);
        } else {
            // Photos: cover-crop to exact box (client normally sends a pre-cropped image).
            $scale = max($w / $sw, $h / $sh);
            $cw = (int)round($w / $scale);
            $ch = (int)round($h / $scale);
            $cx = (int)max(0, ($sw - $cw) / 2);
            $cy = (int)max(0, ($sh - $ch) / 2);
            $dst = imagecreatetruecolor($w, $h);
            imagefill($dst, 0, 0, imagecolorallocate($dst, 255, 255, 255));
            imagecopyresampled($dst, $src, 0, 0, $cx, $cy, $w, $h, $cw, $ch);
            $name .= '.jpg';
            imagejpeg($dst, "$target/$name", 88);
        }
        return $name; // GD images are freed automatically (imagedestroy is deprecated in PHP 8.5)
    }
}
