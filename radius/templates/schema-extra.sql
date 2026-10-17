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

-- Ports & protocols per device / app (hourly, filled by the traffic collector)
CREATE TABLE IF NOT EXISTS traffic_port (
  bucket DATETIME NOT NULL,
  client_ip VARCHAR(45) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  site VARCHAR(253) NOT NULL,
  proto TINYINT UNSIGNED NOT NULL,
  port SMALLINT UNSIGNED NOT NULL,
  direction ENUM('out','in','p2p') NOT NULL,
  bytes_down BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_up BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flows INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, client_ip, site, proto, port, direction),
  KEY idx_port (proto, port, bucket),
  KEY idx_dir (direction, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Long-term memory: which ports/protocols every app uses (kept after traffic data expires)
CREATE TABLE IF NOT EXISTS ml_app_port (
  site VARCHAR(253) NOT NULL,
  proto TINYINT UNSIGNED NOT NULL,
  port SMALLINT UNSIGNED NOT NULL,
  direction ENUM('out','in','p2p') NOT NULL,
  first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  flows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (site, proto, port, direction)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- App inventory: every app seen on the network (tools/appinv.py, hourly). Kept for good.
CREATE TABLE IF NOT EXISTS ml_app (
  site VARCHAR(253) NOT NULL PRIMARY KEY,
  app VARCHAR(64) NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'other',
  source ENUM('builtin','local','discovered') NOT NULL DEFAULT 'builtin',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  KEY idx_first (first_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- App use per day and device (APP_DAYS, default 180 days)
CREATE TABLE IF NOT EXISTS ml_app_day (
  day DATE NOT NULL,
  site VARCHAR(253) NOT NULL,
  client_ip VARCHAR(45) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  queries INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, site, client_ip),
  KEY idx_site (site, day),
  KEY idx_user (username, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- VPN watch (tools/vpn.py hourly + traffic collector): who tried a VPN, and the automatic VPN lists
CREATE TABLE IF NOT EXISTS ml_vpn_event (
  bucket DATETIME NOT NULL,
  client_ip VARCHAR(45) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  source ENUM('dns','blocked','flow') NOT NULL,
  what VARCHAR(253) NOT NULL,
  kind VARCHAR(64) NOT NULL DEFAULT '',
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  PRIMARY KEY (bucket, client_ip, source, what),
  KEY idx_user (username, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_vpn_server (
  ip VARCHAR(45) NOT NULL PRIMARY KEY,
  kind VARCHAR(64) NOT NULL DEFAULT '',
  why VARCHAR(128) NOT NULL DEFAULT '',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_vpn_domain (
  domain VARCHAR(253) NOT NULL PRIMARY KEY,
  kind VARCHAR(64) NOT NULL DEFAULT '',
  why VARCHAR(64) NOT NULL DEFAULT '',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every website name (domain + subdomain) ever looked up (tools/appinv.py, hourly). Kept for good.
CREATE TABLE IF NOT EXISTS ml_domain (
  host VARCHAR(253) NOT NULL PRIMARY KEY,
  base VARCHAR(253) NOT NULL,
  app VARCHAR(64) NOT NULL DEFAULT '',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  ips VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_base (base),
  KEY idx_last (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_domain_day (
  day DATE NOT NULL,
  host VARCHAR(253) NOT NULL,
  lookups INT UNSIGNED NOT NULL DEFAULT 0,
  devices INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (day, host),
  KEY idx_host (host, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Security detective (tools/sentinel.py + traffic collector): virus / hacker attack / DDoS events
CREATE TABLE IF NOT EXISTS ml_security_event (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  day DATE NOT NULL,
  category ENUM('virus','attack','ddos') NOT NULL,
  type VARCHAR(64) NOT NULL,
  severity ENUM('low','medium','high') NOT NULL DEFAULT 'medium',
  source ENUM('flow','dns','log') NOT NULL,
  src_ip VARCHAR(45) NOT NULL DEFAULT '',
  dst_ip VARCHAR(45) NOT NULL DEFAULT '',
  username VARCHAR(64) NOT NULL DEFAULT '',
  detail VARCHAR(255) NOT NULL DEFAULT '',
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  UNIQUE KEY uq_event (day, category, type, source, src_ip, dst_ip),
  KEY idx_last (last_seen),
  KEY idx_src (src_ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quarantine: infected devices cut off from the internet (they only see a warning page)
CREATE TABLE IF NOT EXISTS ml_quarantine (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL DEFAULT '',
  username VARCHAR(64) NOT NULL DEFAULT '',
  prev_list VARCHAR(64) NOT NULL DEFAULT '',
  reason VARCHAR(255) NOT NULL DEFAULT '',
  auto TINYINT(1) NOT NULL DEFAULT 0,
  since DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at DATETIME NULL,
  released_by VARCHAR(64) NOT NULL DEFAULT '',
  KEY idx_active (released_at),
  KEY idx_ip (ip),
  KEY idx_user (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alerts sent to Telegram / WhatsApp / email (history for the dashboard)
CREATE TABLE IF NOT EXISTS ml_alert (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind VARCHAR(32) NOT NULL DEFAULT '',
  title VARCHAR(255) NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  result VARCHAR(255) NOT NULL DEFAULT '',
  KEY idx_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bandwidth scheduling: a different speed at certain hours (night boost, peak-hour limit)
CREATE TABLE IF NOT EXISTS ml_speed_schedule (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  target_type ENUM('all','group','plan','user') NOT NULL DEFAULT 'all',
  target VARCHAR(64) NOT NULL DEFAULT '',
  days VARCHAR(40) NOT NULL DEFAULT 'all',            -- 'all' or mon,tue,... (the day the window starts)
  start_min SMALLINT UNSIGNED NOT NULL,               -- minutes after midnight; start > end = over midnight
  end_min SMALLINT UNSIGNED NOT NULL,                 -- start = end: the whole day
  rate VARCHAR(64) NOT NULL,                          -- Mikrotik-Rate-Limit, e.g. 20M/20M
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_name (name),
  KEY idx_target (target_type, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Speed last sent to a running session by the enforcer (so a change is sent once)
CREATE TABLE IF NOT EXISTS ml_rate_applied (
  acctuniqueid VARCHAR(32) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  rate VARCHAR(64) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Users' phone numbers (warning SMS before the package / data runs out)
CREATE TABLE IF NOT EXISTS ml_contact (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  phone VARCHAR(20) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Warnings already sent to users (each once per expiry date / quota period)
CREATE TABLE IF NOT EXISTS ml_notice_sent (
  username VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  ref VARCHAR(64) NOT NULL,
  phone VARCHAR(20) NOT NULL DEFAULT '',
  text VARCHAR(255) NOT NULL DEFAULT '',
  result VARCHAR(255) NOT NULL DEFAULT '',
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (username, kind, ref),
  KEY idx_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
