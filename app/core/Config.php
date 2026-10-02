<?php
declare(strict_types=1);

/**
 * Loads configuration from the private folder that lives OUTSIDE the deploy
 * folder (Hostinger redeploys wipe the deploy folder).
 *
 * Lookup order for the config file:
 *   1. FPMS_CONFIG env var (full path to a config.php)
 *   2. <private_dir>/config.php  where private_dir = FPMS_PRIVATE_DIR env var
 *      or the sibling folder "../fabric_private" of the deploy folder
 */
final class Config
{
    private static array $config = [];

    public static function load(): void
    {
        $privateDir = getenv('FPMS_PRIVATE_DIR') ?: dirname(APP_ROOT) . '/fabric_private';
        $file = getenv('FPMS_CONFIG') ?: $privateDir . '/config.php';

        $local = [];
        if (is_file($file)) {
            $loaded = require $file;
            if (is_array($loaded)) {
                $local = $loaded;
            }
        }

        $defaults = [
            'db' => [
                'host' => 'localhost',
                'port' => 3306,
                'name' => '',
                'user' => '',
                'pass' => '',
            ],
            'app' => [
                'name'                 => 'Fabric Printing Management',
                'debug'                => false,
                'session_idle_minutes' => 120,
                'whatsapp_number'      => '',
                'setup_key'            => '',
                'timezone'             => 'Asia/Karachi',
                'currency'             => 'PKR',
            ],
            'security' => [
                'max_login_attempts' => 5,
                'max_ip_attempts'    => 25,
                'lockout_minutes'    => 15,
            ],
        ];

        self::$config = array_replace_recursive($defaults, $local);
        self::$config['config_file'] = is_file($file) ? $file : null;
        self::$config['private_dir'] = rtrim((string) ($local['private_dir'] ?? $privateDir), '/\\');
    }

    /** Dot-notation getter: Config::get('db.host'). */
    public static function get(string $key, mixed $default = null): mixed
    {
        $value = self::$config;
        foreach (explode('.', $key) as $part) {
            if (!is_array($value) || !array_key_exists($part, $value)) {
                return $default;
            }
            $value = $value[$part];
        }
        return $value;
    }

    /**
     * Absolute path of a folder inside the private dir (uploads, logs, sessions),
     * created on first use. Returns null if it cannot be created.
     */
    public static function path(string $name): ?string
    {
        $dir = self::$config['private_dir'] . '/' . $name;
        if (!is_dir($dir) && !@mkdir($dir, 0750, true) && !is_dir($dir)) {
            return null;
        }
        return $dir;
    }

    public static function isConfigured(): bool
    {
        return self::get('db.name') !== '' && self::get('db.user') !== '';
    }
}
