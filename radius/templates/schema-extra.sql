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

-- Groups that exist without any limit yet, plus a description (radius-admin / dashboard)
CREATE TABLE IF NOT EXISTS radgroup_meta (
  groupname VARCHAR(64) NOT NULL PRIMARY KEY,
  description VARCHAR(128) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Web dashboard: administrators and audit trail
CREATE TABLE IF NOT EXISTS web_admin (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin','viewer') NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS web_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  admin VARCHAR(64) NOT NULL,
  ip VARCHAR(45) NOT NULL DEFAULT '',
  action VARCHAR(255) NOT NULL,
  result VARCHAR(16) NOT NULL,
  KEY idx_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- hotspot business
-- A plan is also a RADIUS group with the same name (speed limit, devices per user).
CREATE TABLE IF NOT EXISTS ml_plan (
  name VARCHAR(64) NOT NULL PRIMARY KEY,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  validity_seconds INT UNSIGNED NOT NULL DEFAULT 0,     -- counted from the first login; 0 = no expiry
  quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,       -- 0 = unlimited
  quota_period ENUM('total','monthly','daily') NOT NULL DEFAULT 'total',
  daily_seconds INT UNSIGNED NOT NULL DEFAULT 0,        -- online time per day; 0 = unlimited
  description VARCHAR(128) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Per-user subscription state (users without a row have no business limits)
CREATE TABLE IF NOT EXISTS ml_account (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  plan VARCHAR(64) NULL,
  first_login DATETIME NULL,
  expires_at DATETIME NULL,
  quota_bytes BIGINT UNSIGNED NULL,                     -- per-user override of the plan quota
  quota_since DATETIME NULL,                            -- usage is counted from here (renewal resets it)
  voucher_batch INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_plan (plan), KEY idx_batch (voucher_batch), KEY idx_exp (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_voucher_batch (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan VARCHAR(64) NOT NULL,
  count INT UNSIGNED NOT NULL,
  price DECIMAL(10,2) NOT NULL DEFAULT 0,
  note VARCHAR(128) NOT NULL DEFAULT '',
  created_by VARCHAR(64) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Money in: voucher activations are added by FreeRADIUS on first login, renewals by radius-admin
CREATE TABLE IF NOT EXISTS ml_sale (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  username VARCHAR(64) NOT NULL,
  plan VARCHAR(64) NOT NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  kind ENUM('voucher','renew','new') NOT NULL,
  KEY idx_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Business / branding settings edited in the dashboard (voucher cards, connect page)
CREATE TABLE IF NOT EXISTS ml_setting (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v VARCHAR(512) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- PPPoE / FUP (added later: safe on existing installs)
ALTER TABLE ml_plan ADD COLUMN IF NOT EXISTS fup_rate VARCHAR(64) NOT NULL DEFAULT '' AFTER daily_seconds;

-- Sessions already slowed down to the FUP speed by the enforcer (CoA), so it is sent once
CREATE TABLE IF NOT EXISTS ml_fup (
  acctuniqueid VARCHAR(32) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- WPA-Enterprise: real user behind an anonymous outer identity, by device MAC (for accounting)
CREATE TABLE IF NOT EXISTS ml_eap_identity (
  mac CHAR(17) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
