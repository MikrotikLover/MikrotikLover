-- 001: core tables - settings, security, audit, document numbering
-- Engine InnoDB, charset utf8mb4_unicode_ci (Urdu text safe)

CREATE TABLE settings (
    setting_key   VARCHAR(64)  NOT NULL,
    setting_value TEXT         NULL,
    updated_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE roles (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(60)  NOT NULL,
    description VARCHAR(255) NULL,
    is_admin    TINYINT(1)   NOT NULL DEFAULT 0,  -- admin bypasses permission matrix
    created_by  INT UNSIGNED NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  INT UNSIGNED NULL,
    updated_at  DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Permission matrix: one row per (role, module, action) that is allowed
CREATE TABLE permissions (
    role_id INT UNSIGNED NOT NULL,
    module  VARCHAR(40)  NOT NULL,
    action  ENUM('view','add','edit','delete','post','print') NOT NULL,
    PRIMARY KEY (role_id, module, action),
    CONSTRAINT fk_perm_role FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE users (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username             VARCHAR(50)  NOT NULL,
    full_name            VARCHAR(100) NOT NULL,
    email                VARCHAR(120) NULL,
    password_hash        VARCHAR(255) NOT NULL,
    role_id              INT UNSIGNED NOT NULL,
    is_active            TINYINT(1)   NOT NULL DEFAULT 1,
    must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
    last_login_at        DATETIME     NULL,
    last_login_ip        VARCHAR(45)  NULL,
    created_by           INT UNSIGNED NULL,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by           INT UNSIGNED NULL,
    updated_at           DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    KEY idx_users_role (role_id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE roles
    ADD CONSTRAINT fk_roles_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    ADD CONSTRAINT fk_roles_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE login_attempts (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username     VARCHAR(50)  NOT NULL,
    ip_address   VARCHAR(45)  NOT NULL,
    success      TINYINT(1)   NOT NULL DEFAULT 0,
    attempted_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_login_user_ip (username, ip_address, attempted_at),
    KEY idx_login_time (attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id     INT UNSIGNED NULL,
    action      VARCHAR(30)  NOT NULL,         -- create, update, delete, post, unpost, login, logout ...
    entity      VARCHAR(60)  NOT NULL,         -- table / business entity
    entity_id   BIGINT UNSIGNED NULL,
    old_values  JSON         NULL,
    new_values  JSON         NULL,
    ip_address  VARCHAR(45)  NULL,
    user_agent  VARCHAR(255) NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_audit_entity (entity, entity_id),
    KEY idx_audit_user (user_id, created_at),
    KEY idx_audit_time (created_at),
    CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Voucher numbering per document type and year
CREATE TABLE doc_sequences (
    doc_type VARCHAR(20)  NOT NULL,
    year     SMALLINT     NOT NULL,
    last_no  INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (doc_type, year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
