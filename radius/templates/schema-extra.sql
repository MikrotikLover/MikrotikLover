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
-- ransomware (Security → Ransomware): the category added later, also on servers installed before
ALTER TABLE ml_security_event MODIFY category ENUM('virus','attack','ddos','ransomware') NOT NULL;

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

-- Network control: what every router reports each minute (autosync.rsc, script ml-stats)
CREATE TABLE IF NOT EXISTS ml_router_status (
  router_ip VARCHAR(45) NOT NULL,                 -- as the server sees it (several routers behind one NAT: identity tells them apart)
  identity VARCHAR(64) NOT NULL DEFAULT '',
  board VARCHAR(64) NOT NULL DEFAULT '',
  version VARCHAR(64) NOT NULL DEFAULT '',
  uptime VARCHAR(32) NOT NULL DEFAULT '',
  cpu TINYINT UNSIGNED NOT NULL DEFAULT 0,
  mem_free BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mem_total BIGINT UNSIGNED NOT NULL DEFAULT 0,
  hdd_free BIGINT UNSIGNED NOT NULL DEFAULT 0,
  hdd_total BIGINT UNSIGNED NOT NULL DEFAULT 0,
  users_hotspot INT UNSIGNED NOT NULL DEFAULT 0,
  users_ppp INT UNSIGNED NOT NULL DEFAULT 0,
  dhcp_leases INT UNSIGNED NOT NULL DEFAULT 0,
  interfaces MEDIUMTEXT NOT NULL,        -- JSON: [{name, type, running, disabled, rx, tx, rx_bps, tx_bps}]
  links TEXT NOT NULL,                   -- JSON: [{host, status, comment}] (netwatch)
  last_seen DATETIME NOT NULL,
  PRIMARY KEY (router_ip, identity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- History for the charts (kept 7 days)
CREATE TABLE IF NOT EXISTS ml_router_stat (
  router_ip VARCHAR(45) NOT NULL,
  identity VARCHAR(64) NOT NULL DEFAULT '',
  at DATETIME NOT NULL,
  cpu TINYINT UNSIGNED NOT NULL DEFAULT 0,
  mem_pct TINYINT UNSIGNED NOT NULL DEFAULT 0,
  rx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,      -- busiest running interface
  tx_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
  users INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (router_ip, identity, at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Social WiFi (cafe): customers who logged in with their phone number (OTP)
CREATE TABLE IF NOT EXISTS ml_social_user (
  phone VARCHAR(20) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT '',
  consent TINYINT(1) NOT NULL DEFAULT 0,          -- may we send offers?
  visits INT UNSIGNED NOT NULL DEFAULT 0,          -- logins on different days
  first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_mac VARCHAR(17) NOT NULL DEFAULT '',
  last_offer DATETIME NULL,
  KEY idx_last (last_seen)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time codes sent by SMS / WhatsApp (only a hash is kept)
CREATE TABLE IF NOT EXISTS ml_social_otp (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(20) NOT NULL,
  mac VARCHAR(17) NOT NULL DEFAULT '',
  ip VARCHAR(45) NOT NULL DEFAULT '',
  code_hash CHAR(64) NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used TINYINT(1) NOT NULL DEFAULT 0,
  created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_phone (phone, created),
  KEY idx_mac (mac, created)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Router setup page: the script made for one router, fetched once by the router with a one-hour token
CREATE TABLE IF NOT EXISTS ml_router_setup (
  token CHAR(32) NOT NULL PRIMARY KEY,
  router_ip VARCHAR(45) NOT NULL DEFAULT '',
  script MEDIUMTEXT NOT NULL,
  fetched INT UNSIGNED NOT NULL DEFAULT 0,
  created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires DATETIME NOT NULL,
  KEY (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- the same set-up written for RouterOS 6 (the router asks for it with ?v=6)
ALTER TABLE ml_router_setup ADD COLUMN IF NOT EXISTS script6 MEDIUMTEXT NULL;

-- IP binding: every user keeps the address DHCP gave them (or the one the admin chose); routers get DHCP static leases
CREATE TABLE IF NOT EXISTS ml_ip_bind (
  username VARCHAR(64) NOT NULL PRIMARY KEY,
  ip VARCHAR(15) NOT NULL,
  mac VARCHAR(17) NOT NULL DEFAULT '',
  locked TINYINT(1) NOT NULL DEFAULT 0,
  router_ip VARCHAR(45) NOT NULL DEFAULT '',
  created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY (ip),
  KEY (mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Traffic graphs: bytes per 5 minutes (kept 3 days) and per hour (kept 90 days)
--   kind 'if'   name 'ROUTER_IP|IDENTITY|INTERFACE'   rx = bytes the router received on it, tx = sent
--   kind 'user' name USERNAME                         rx = download, tx = upload (RADIUS accounting)
CREATE TABLE IF NOT EXISTS ml_traffic (
  kind VARCHAR(8) NOT NULL,
  name VARCHAR(200) NOT NULL,
  res SMALLINT UNSIGNED NOT NULL,           -- minutes per bucket: 5 or 60
  bucket DATETIME NOT NULL,
  rx BIGINT UNSIGNED NOT NULL DEFAULT 0,
  tx BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, res, name, bucket),
  KEY (kind, res, bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- last counters seen per accounting session (to turn totals into per-5-minute amounts)
CREATE TABLE IF NOT EXISTS ml_acct_snap (
  acctuniqueid VARCHAR(32) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL DEFAULT '',
  inb BIGINT UNSIGNED NOT NULL DEFAULT 0,
  outb BIGINT UNSIGNED NOT NULL DEFAULT 0,
  seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Departments: one shared speed for all their users (router queue tree + PCQ)
CREATE TABLE IF NOT EXISTS ml_department (
  name VARCHAR(32) NOT NULL PRIMARY KEY,
  title VARCHAR(80) NOT NULL DEFAULT '',
  down_kbps INT UNSIGNED NOT NULL DEFAULT 0,
  up_kbps INT UNSIGNED NOT NULL DEFAULT 0,
  created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_dept_member (
  dept VARCHAR(32) NOT NULL,
  kind VARCHAR(8) NOT NULL,                 -- user | group
  name VARCHAR(64) NOT NULL,
  PRIMARY KEY (kind, name),                 -- a user / group is in one department
  KEY (dept)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Block page: every page shown to a user gets a reference code the admin can look up (Blocking -> Why blocked?)
CREATE TABLE IF NOT EXISTS ml_block_event (
  code CHAR(6) NOT NULL PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip VARCHAR(45) NOT NULL DEFAULT '',
  username VARCHAR(64) NOT NULL DEFAULT '',
  host VARCHAR(253) NOT NULL DEFAULT '',
  path VARCHAR(255) NOT NULL DEFAULT '',
  policy VARCHAR(40) NOT NULL DEFAULT '',
  rule VARCHAR(160) NOT NULL DEFAULT '',
  why VARCHAR(255) NOT NULL DEFAULT '',
  KEY (at),
  KEY (ip, host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Unblock requests from the block page, and temporary exceptions the admin gave (router: ml-live, every minute)
CREATE TABLE IF NOT EXISTS ml_unblock (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ip VARCHAR(45) NOT NULL DEFAULT '',
  username VARCHAR(64) NOT NULL DEFAULT '',
  host VARCHAR(253) NOT NULL,
  policy VARCHAR(40) NOT NULL DEFAULT '',
  code CHAR(6) NOT NULL DEFAULT '',
  note VARCHAR(200) NOT NULL DEFAULT '',
  status VARCHAR(10) NOT NULL DEFAULT 'pending',    -- pending | allowed | always | denied | ended
  until DATETIME NULL,
  decided_by VARCHAR(64) NOT NULL DEFAULT '',
  decided_at DATETIME NULL,
  KEY (status, until),
  KEY (ip, host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Server addresses of every app (from the DNS answers its names got) — tools/appinv.py, hourly
CREATE TABLE IF NOT EXISTS ml_app_server (
  site VARCHAR(253) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  host VARCHAR(253) NOT NULL DEFAULT '',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  lookups INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (site, ip),
  KEY (ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- What kind of device an address is (Android, iPhone / Apple, Windows), from the names its system asks
-- by itself (connectivity checks, store, updates) — tools/appinv.py, hourly
CREATE TABLE IF NOT EXISTS ml_device (
  client_ip VARCHAR(45) NOT NULL PRIMARY KEY,
  os VARCHAR(16) NOT NULL DEFAULT '',
  evidence VARCHAR(255) NOT NULL DEFAULT '',
  username VARCHAR(64) NOT NULL DEFAULT '',
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  KEY (os)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- When each router last fetched its auto-sync files (health check: did the router take the new rules?)
CREATE TABLE IF NOT EXISTS ml_router_fetch (
  router_ip VARCHAR(45) NOT NULL,
  what VARCHAR(16) NOT NULL,
  at DATETIME NOT NULL,
  version VARCHAR(64) NOT NULL DEFAULT '',
  PRIMARY KEY (router_ip, what)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- From outside into the network: which outside address reached which inside device and port, per hour
-- (traffic collector, connections whose service port is on the inside device)
CREATE TABLE IF NOT EXISTS ml_inbound (
  bucket DATETIME NOT NULL,
  remote_ip VARCHAR(45) NOT NULL,
  lan_ip VARCHAR(45) NOT NULL,
  username VARCHAR(64) NOT NULL DEFAULT '',
  proto TINYINT UNSIGNED NOT NULL,
  port SMALLINT UNSIGNED NOT NULL,
  flows INT UNSIGNED NOT NULL DEFAULT 0,
  bytes_in BIGINT UNSIGNED NOT NULL DEFAULT 0,
  bytes_out BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, remote_ip, lan_ip, proto, port),
  KEY (lan_ip, port),
  KEY (remote_ip)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- what each router opens to the internet: port forwards (dst-nat) and its own services (router report)
ALTER TABLE ml_router_status ADD COLUMN IF NOT EXISTS exposed TEXT NULL;

-- Firewall (dashboard → Firewall, radius-admin firewall): policies, objects, port forwards
CREATE TABLE IF NOT EXISTS ml_fw_rule (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  pos INT NOT NULL DEFAULT 0,
  name VARCHAR(64) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  dir VARCHAR(8) NOT NULL DEFAULT 'out',
  src TEXT NULL,
  dst TEXT NULL,
  service TEXT NULL,
  schedule VARCHAR(32) NOT NULL DEFAULT 'always',
  action VARCHAR(8) NOT NULL DEFAULT 'deny',
  log TINYINT(1) NOT NULL DEFAULT 0,
  comment VARCHAR(255) NOT NULL DEFAULT '',
  created DATETIME NULL,
  updated DATETIME NULL,
  KEY (pos)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_fw_addr (
  name VARCHAR(32) NOT NULL PRIMARY KEY,
  entries MEDIUMTEXT NULL,
  comment VARCHAR(255) NOT NULL DEFAULT '',
  updated DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_fw_service (
  name VARCHAR(32) NOT NULL PRIMARY KEY,
  entries TEXT NULL,
  comment VARCHAR(255) NOT NULL DEFAULT '',
  updated DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_fw_schedule (
  name VARCHAR(32) NOT NULL PRIMARY KEY,
  days VARCHAR(40) NOT NULL DEFAULT '',
  start VARCHAR(5) NOT NULL DEFAULT '',
  end VARCHAR(5) NOT NULL DEFAULT '',
  comment VARCHAR(255) NOT NULL DEFAULT '',
  updated DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_fw_vip (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(32) NOT NULL UNIQUE,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  proto VARCHAR(4) NOT NULL DEFAULT 'tcp',
  port VARCHAR(11) NOT NULL,
  to_ip VARCHAR(45) NOT NULL,
  to_port VARCHAR(11) NOT NULL,
  src TEXT NULL,
  wan VARCHAR(32) NOT NULL DEFAULT '',
  comment VARCHAR(255) NOT NULL DEFAULT '',
  created DATETIME NULL,
  updated DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Intrusion prevention (Suricata, tools/ips.py)
ALTER TABLE ml_security_event MODIFY source ENUM('flow','dns','log','ips') NOT NULL;
CREATE TABLE IF NOT EXISTS ml_ips_alert (
  bucket DATETIME NOT NULL,
  sid INT UNSIGNED NOT NULL,
  src_ip VARCHAR(45) NOT NULL,
  dst_ip VARCHAR(45) NOT NULL,
  dst_port SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  proto VARCHAR(8) NOT NULL DEFAULT '',
  signature VARCHAR(255) NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  severity ENUM('low','medium','high') NOT NULL DEFAULT 'low',
  kind VARCHAR(16) NOT NULL DEFAULT '',
  direction VARCHAR(8) NOT NULL DEFAULT '',
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  first_seen DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  blocked TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, sid, src_ip, dst_ip, dst_port),
  KEY (last_seen),
  KEY (src_ip),
  KEY (sid)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_ips_block (
  ip VARCHAR(45) NOT NULL PRIMARY KEY,
  reason VARCHAR(255) NOT NULL DEFAULT '',
  sid INT UNSIGNED NOT NULL DEFAULT 0,
  hits INT UNSIGNED NOT NULL DEFAULT 0,
  auto TINYINT(1) NOT NULL DEFAULT 1,
  created DATETIME NOT NULL,
  until DATETIME NOT NULL,
  KEY (until)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_ips_allow (
  ip VARCHAR(45) NOT NULL PRIMARY KEY,
  comment VARCHAR(255) NOT NULL DEFAULT '',
  created DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A policy for a whole network / IP range / one IP, no login needed (Blocking → Give a policy → Network)
CREATE TABLE IF NOT EXISTS ml_policy_net (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  policy VARCHAR(40) NOT NULL,
  target VARCHAR(64) NOT NULL,
  comment VARCHAR(100) NOT NULL DEFAULT '',
  created DATETIME NOT NULL,
  UNIQUE KEY (policy, target)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SNMP: devices on the LAN (switches, UPS, printers, MikroTik, servers, cameras) and their traps (tools/snmp.py).
-- Communities / v3 passwords are not here: /etc/mikrotiklover-radius/snmp-secrets.json (root only).
CREATE TABLE IF NOT EXISTS ml_snmp_device (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(64) NOT NULL,
  ip VARCHAR(45) NOT NULL,
  port SMALLINT UNSIGNED NOT NULL DEFAULT 161,
  version ENUM('1','2c','3') NOT NULL DEFAULT '2c',
  kind VARCHAR(16) NOT NULL DEFAULT 'other',
  kind_auto TINYINT(1) NOT NULL DEFAULT 1,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  alerts TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('new','up','down') NOT NULL DEFAULT 'new',
  last_ok DATETIME NULL,
  last_poll DATETIME NULL,
  last_error VARCHAR(255) NOT NULL DEFAULT '',
  sysname VARCHAR(128) NOT NULL DEFAULT '',
  sysdescr VARCHAR(500) NOT NULL DEFAULT '',
  sysobjectid VARCHAR(128) NOT NULL DEFAULT '',
  location VARCHAR(128) NOT NULL DEFAULT '',
  uptime BIGINT UNSIGNED NOT NULL DEFAULT 0,
  line VARCHAR(255) NOT NULL DEFAULT '',
  info MEDIUMTEXT NULL,
  created DATETIME NOT NULL,
  UNIQUE KEY (ip, port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_snmp_if (
  device_id INT UNSIGNED NOT NULL,
  ifindex INT UNSIGNED NOT NULL,
  name VARCHAR(64) NOT NULL DEFAULT '',
  alias VARCHAR(128) NOT NULL DEFAULT '',
  type SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  speed INT UNSIGNED NOT NULL DEFAULT 0,
  admin VARCHAR(8) NOT NULL DEFAULT '',
  oper VARCHAR(8) NOT NULL DEFAULT '',
  in_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
  out_bps BIGINT UNSIGNED NOT NULL DEFAULT 0,
  in_err BIGINT UNSIGNED NOT NULL DEFAULT 0,
  out_err BIGINT UNSIGNED NOT NULL DEFAULT 0,
  watch TINYINT(1) NOT NULL DEFAULT 0,
  changed DATETIME NULL,
  PRIMARY KEY (device_id, ifindex)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_snmp_sample (
  device_id INT UNSIGNED NOT NULL,
  ts DATETIME NOT NULL,
  k VARCHAR(40) NOT NULL,
  v DOUBLE NOT NULL,
  KEY (device_id, k, ts),
  KEY (ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_snmp_event (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL,
  device_id INT UNSIGNED NULL,
  ip VARCHAR(45) NOT NULL DEFAULT '',
  severity ENUM('high','medium','info') NOT NULL DEFAULT 'info',
  text VARCHAR(500) NOT NULL,
  KEY (ts),
  KEY (device_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_snmp_trap (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME NOT NULL,
  src_ip VARCHAR(45) NOT NULL,
  device_id INT UNSIGNED NULL,
  version VARCHAR(3) NOT NULL DEFAULT '2c',
  trap_oid VARCHAR(128) NOT NULL DEFAULT '',
  severity ENUM('high','medium','info') NOT NULL DEFAULT 'info',
  words VARCHAR(255) NOT NULL DEFAULT '',
  vars TEXT NULL,
  alerted TINYINT(1) NOT NULL DEFAULT 0,
  KEY (ts),
  KEY (device_id, ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- Network map: an SNMP device (AP, printer, switch …) belongs to a department ('' = core / none)
ALTER TABLE ml_snmp_device ADD COLUMN IF NOT EXISTS dept VARCHAR(32) NOT NULL DEFAULT '';
-- Whole-network map: each device's own MACs, the switches' MAC tables (which MAC behind which port) and LLDP neighbours
ALTER TABLE ml_snmp_device ADD COLUMN IF NOT EXISTS macs TEXT NULL;
CREATE TABLE IF NOT EXISTS ml_snmp_fdb (
  device_id INT UNSIGNED NOT NULL,
  ifindex INT UNSIGNED NOT NULL,
  mac CHAR(17) NOT NULL,
  vlan SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  seen DATETIME NOT NULL,
  PRIMARY KEY (device_id, mac, ifindex),
  KEY (mac)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS ml_snmp_lldp (
  device_id INT UNSIGNED NOT NULL,
  ifindex INT UNSIGNED NOT NULL DEFAULT 0,
  name VARCHAR(64) NOT NULL DEFAULT '',
  port VARCHAR(64) NOT NULL DEFAULT '',
  chassis CHAR(17) NOT NULL DEFAULT '',
  ip VARCHAR(45) NOT NULL DEFAULT '',
  seen DATETIME NOT NULL,
  KEY (device_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- "Remember this device": a phone that logged in with a password logs in by its MAC next time, as that user
-- (random / private MACs: one password login per new MAC). radius-admin remember ...
CREATE TABLE IF NOT EXISTS ml_remember (
  mac CHAR(17) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  created DATETIME NOT NULL,
  last_seen DATETIME NOT NULL,
  KEY (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
