-- MikrotikLover additions to the FreeRADIUS schema (safe to re-run)
CREATE TABLE IF NOT EXISTS macdevice (
  mac CHAR(17) NOT NULL PRIMARY KEY,
  description VARCHAR(128) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Data usage per client IP / user / website, hourly (filled by the traffic collector)
CREATE TABLE IF NOT EXISTS traffic_site (
  bucket DATETIME NOT NULL,
  client_ip VARCHAR(45) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  site VARCHAR(253) NOT NULL,
  bytes_down BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_up BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flows INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, client_ip, site),
  KEY idx_user (username, bucket),
  KEY idx_site (site, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
