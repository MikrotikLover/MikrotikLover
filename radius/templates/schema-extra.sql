-- MikrotikLover additions to the FreeRADIUS schema (safe to re-run)
CREATE TABLE IF NOT EXISTS macdevice (
  mac CHAR(17) NOT NULL PRIMARY KEY,
  description VARCHAR(128) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
