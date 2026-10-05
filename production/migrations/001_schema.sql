-- Production app schema (MySQL 8 / MariaDB 10.4+, InnoDB, utf8mb4_unicode_ci).
-- Name columns use the case-insensitive collation, so "MS" and "Ms" are the same machine.

CREATE TABLE users (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username             VARCHAR(50)  NOT NULL,
    full_name            VARCHAR(100) NOT NULL DEFAULT '',
    password_hash        VARCHAR(255) NOT NULL,
    role                 ENUM('admin','manager','entry','viewer') NOT NULL DEFAULT 'viewer',
    is_active            TINYINT(1)   NOT NULL DEFAULT 1,
    must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
    session_version      INT UNSIGNED NOT NULL DEFAULT 0,
    last_login_at        DATETIME NULL,
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE login_attempts (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    username     VARCHAR(50) NOT NULL,
    ip_address   VARCHAR(45) NOT NULL,
    success      TINYINT(1)  NOT NULL DEFAULT 0,
    attempted_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_login_user_ip (username, ip_address, attempted_at),
    KEY ix_login_ip (ip_address, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id     INT UNSIGNED NULL,
    action      VARCHAR(30)  NOT NULL,
    entity      VARCHAR(40)  NOT NULL,
    entity_id   INT UNSIGNED NULL,
    old_values  MEDIUMTEXT NULL,
    new_values  MEDIUMTEXT NULL,
    ip_address  VARCHAR(45) NOT NULL DEFAULT '',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY ix_audit_entity (entity, entity_id),
    KEY ix_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE settings (
    k VARCHAR(50) NOT NULL PRIMARY KEY,
    v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (k, v) VALUES
    ('company_name', 'Digital Printing'),
    ('default_ink_rate', '1450'),
    ('ink_high_ml', '60'),
    ('mtr_high', '5000');

-- Printing machines. Each machine has its own ink rate history (machine_rates).
CREATE TABLE machines (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(60) NOT NULL,
    is_active  TINYINT(1)  NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_machines_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ink price in Rs per litre, effective from a date until the next row of the same machine.
CREATE TABLE machine_rates (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    machine_id     INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    rate_per_litre DECIMAL(10,2) NOT NULL,
    note           VARCHAR(150) NOT NULL DEFAULT '',
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_machine_rate (machine_id, effective_from),
    CONSTRAINT fk_rate_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Simple name lists: party, quality, article, calibration, operator.
CREATE TABLE masters (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    kind       ENUM('party','quality','article','calibration','operator') NOT NULL,
    name       VARCHAR(120) NOT NULL,
    is_active  TINYINT(1)  NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_masters_kind_name (kind, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_batches (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    file_name    VARCHAR(200) NOT NULL,
    sheet_name   VARCHAR(100) NOT NULL DEFAULT '',
    mode         ENUM('append','replace') NOT NULL,
    rows_read    INT UNSIGNED NOT NULL DEFAULT 0,
    rows_added   INT UNSIGNED NOT NULL DEFAULT 0,
    rows_skipped INT UNSIGNED NOT NULL DEFAULT 0,
    rows_failed  INT UNSIGNED NOT NULL DEFAULT 0,
    rows_removed INT UNSIGNED NOT NULL DEFAULT 0,
    date_from    DATE NULL,
    date_to      DATE NULL,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One printed run. ink_ml_per_mtr is the "Ink use" column of the Excel sheet (ml per metre).
-- ink_rate is the machine's Rs/litre on entry_date, kept in step by Rates::recompute().
CREATE TABLE production_entries (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    entry_date      DATE NOT NULL,
    lot_no          VARCHAR(40)  NOT NULL DEFAULT '',
    quality_id      INT UNSIGNED NULL,
    party_id        INT UNSIGNED NULL,
    design          VARCHAR(80)  NOT NULL DEFAULT '',
    printed_mtr     DECIMAL(10,2) NOT NULL,
    calibration_id  INT UNSIGNED NULL,
    ink_ml_per_mtr  DECIMAL(10,3) NULL,
    article_id      INT UNSIGNED NULL,
    machine_id      INT UNSIGNED NOT NULL,
    shift           CHAR(1) NOT NULL DEFAULT 'A',
    operator_id     INT UNSIGNED NULL,
    remarks         VARCHAR(255) NOT NULL DEFAULT '',
    ink_rate        DECIMAL(10,2) NOT NULL DEFAULT 0,
    ink_ml          DECIMAL(16,3) AS (printed_mtr * ink_ml_per_mtr) STORED,
    ink_cost        DECIMAL(16,2) AS (printed_mtr * ink_ml_per_mtr * ink_rate / 1000) STORED,
    source          ENUM('manual','import') NOT NULL DEFAULT 'manual',
    import_batch_id INT UNSIGNED NULL,
    fingerprint     CHAR(40) NULL,
    created_by      INT UNSIGNED NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT UNSIGNED NULL,
    updated_at      DATETIME NULL ON UPDATE CURRENT_TIMESTAMP,
    KEY ix_pe_date (entry_date),
    KEY ix_pe_machine_date (machine_id, entry_date),
    KEY ix_pe_party (party_id),
    KEY ix_pe_operator (operator_id),
    KEY ix_pe_quality (quality_id),
    KEY ix_pe_lot (lot_no),
    KEY ix_pe_fingerprint (fingerprint),
    KEY ix_pe_batch (import_batch_id),
    CONSTRAINT fk_pe_machine     FOREIGN KEY (machine_id)     REFERENCES machines (id),
    CONSTRAINT fk_pe_quality     FOREIGN KEY (quality_id)     REFERENCES masters (id),
    CONSTRAINT fk_pe_party       FOREIGN KEY (party_id)       REFERENCES masters (id),
    CONSTRAINT fk_pe_calibration FOREIGN KEY (calibration_id) REFERENCES masters (id),
    CONSTRAINT fk_pe_article     FOREIGN KEY (article_id)     REFERENCES masters (id),
    CONSTRAINT fk_pe_operator    FOREIGN KEY (operator_id)    REFERENCES masters (id),
    CONSTRAINT fk_pe_batch       FOREIGN KEY (import_batch_id) REFERENCES import_batches (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
