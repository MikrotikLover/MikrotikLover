-- =====================================================================
--  Digital Fabric Printing Management System — Database Schema
--  Target: MySQL 8.0+ / MariaDB 10.6+ (Hostinger), InnoDB, utf8mb4
--  Timezone: the application sets the session time_zone to +05:00
--  (Asia/Karachi, no DST) on every connection.
--
--  Import order: schema.sql, then seed.sql (phpMyAdmin → Import).
--
--  Conventions
--  * Master tables: is_active flag + soft delete (deleted_at/deleted_by).
--  * Voucher tables: status (posted / cancelled) + soft delete; numbers
--    come from voucher_sequences (per voucher type and fiscal year).
--  * Stock is NEVER stored as a balance. Every stock-affecting voucher
--    writes rows to stock_movements; balances are SUM(qty_in - qty_out).
--  * Every create / edit / cancel / delete is written to audit_log.
--  * Quantities DECIMAL(14,3), rates DECIMAL(14,4), amounts DECIMAL(16,2).
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
--  1. SECURITY: roles, permissions, users, login attempts, audit log
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS roles (
    id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code          VARCHAR(30)  NOT NULL,
    name          VARCHAR(60)  NOT NULL,
    name_ur       VARCHAR(60)  NULL,
    description   VARCHAR(255) NULL,
    is_system     TINYINT(1)   NOT NULL DEFAULT 0,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_roles_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
    id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code          VARCHAR(60)  NOT NULL,
    module        VARCHAR(40)  NOT NULL,
    action        VARCHAR(20)  NOT NULL,
    description   VARCHAR(120) NOT NULL,
    sort_order    SMALLINT     NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_permissions_code (code),
    KEY ix_permissions_module (module)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       SMALLINT UNSIGNED NOT NULL,
    permission_id SMALLINT UNSIGNED NOT NULL,
    PRIMARY KEY (role_id, permission_id),
    KEY ix_rp_permission (permission_id),
    CONSTRAINT fk_rp_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
    CONSTRAINT fk_rp_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id                   INT UNSIGNED NOT NULL AUTO_INCREMENT,
    username             VARCHAR(50)  NOT NULL,
    full_name            VARCHAR(100) NOT NULL,
    email                VARCHAR(150) NULL,
    phone                VARCHAR(30)  NULL,
    password_hash        VARCHAR(255) NOT NULL,
    role_id              SMALLINT UNSIGNED NOT NULL,
    lang                 ENUM('en','ur') NOT NULL DEFAULT 'en',
    is_active            TINYINT(1)   NOT NULL DEFAULT 1,
    must_change_password TINYINT(1)   NOT NULL DEFAULT 0,
    password_changed_at  DATETIME     NULL,
    last_login_at        DATETIME     NULL,
    last_login_ip        VARCHAR(45)  NULL,
    created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by           INT UNSIGNED NULL,
    updated_at           DATETIME     NULL,
    updated_by           INT UNSIGNED NULL,
    deleted_at           DATETIME     NULL,
    deleted_by           INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_username (username),
    KEY ix_users_role (role_id),
    CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_attempts (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    username      VARCHAR(50)  NOT NULL,
    ip            VARCHAR(45)  NOT NULL,
    success       TINYINT(1)   NOT NULL DEFAULT 0,
    attempted_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_la_username_time (username, attempted_at),
    KEY ix_la_ip_time (ip, attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_log (
    id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id       INT UNSIGNED NULL,
    username      VARCHAR(50)  NULL,
    action        VARCHAR(30)  NOT NULL COMMENT 'create, update, delete, cancel, login, login_failed, logout, password_change, password_reset, permissions_update, setup',
    entity        VARCHAR(50)  NOT NULL COMMENT 'table / module name',
    entity_id     BIGINT UNSIGNED NULL,
    reference     VARCHAR(60)  NULL COMMENT 'voucher no / code for quick search',
    old_values    LONGTEXT     NULL COMMENT 'JSON',
    new_values    LONGTEXT     NULL COMMENT 'JSON',
    ip            VARCHAR(45)  NULL,
    user_agent    VARCHAR(255) NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY ix_audit_entity (entity, entity_id),
    KEY ix_audit_user (user_id, created_at),
    KEY ix_audit_created (created_at),
    KEY ix_audit_reference (reference)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  2. SYSTEM: settings, voucher numbering
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS settings (
    setting_key   VARCHAR(60)  NOT NULL,
    setting_value TEXT         NULL,
    description   VARCHAR(255) NULL,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    updated_by    INT UNSIGNED NULL,
    PRIMARY KEY (setting_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per voucher type per fiscal year (Pakistan FY: 1 Jul – 30 Jun).
-- Next number is taken with SELECT ... FOR UPDATE inside the save transaction.
CREATE TABLE IF NOT EXISTS voucher_sequences (
    voucher_type  VARCHAR(20)  NOT NULL COMMENT 'IGP, STV, SCV, INK, PEV, BOM, MPV, DCV',
    fiscal_year   CHAR(4)      NOT NULL COMMENT 'e.g. 2627 for FY 2026-27',
    prefix        VARCHAR(10)  NOT NULL,
    last_no       INT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (voucher_type, fiscal_year)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  3. MASTER DATA
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS units (
    id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code          VARCHAR(10)  NOT NULL,
    name          VARCHAR(40)  NOT NULL,
    name_ur       VARCHAR(40)  NULL,
    dimension     ENUM('length','mass','volume','count') NOT NULL,
    to_base       DECIMAL(18,8) NOT NULL DEFAULT 1 COMMENT 'factor to base unit of dimension: meter, kg, liter, piece',
    decimals      TINYINT UNSIGNED NOT NULL DEFAULT 2,
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL,
    updated_by    INT UNSIGNED NULL,
    deleted_at    DATETIME     NULL,
    deleted_by    INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_units_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouses (
    id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code          VARCHAR(20)  NOT NULL,
    name          VARCHAR(80)  NOT NULL,
    name_ur       VARCHAR(80)  NULL,
    warehouse_type ENUM('grey','floor','finished','general') NOT NULL DEFAULT 'general',
    address       VARCHAR(255) NULL,
    allow_negative TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'kept 0; negative stock is blocked',
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL,
    updated_by    INT UNSIGNED NULL,
    deleted_at    DATETIME     NULL,
    deleted_by    INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_warehouses_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parties (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code           VARCHAR(20)  NOT NULL,
    name           VARCHAR(120) NOT NULL,
    name_ur        VARCHAR(120) NULL,
    is_customer    TINYINT(1)   NOT NULL DEFAULT 0,
    is_supplier    TINYINT(1)   NOT NULL DEFAULT 0,
    is_fabric_owner TINYINT(1)  NOT NULL DEFAULT 0 COMMENT 'job-work client who owns the grey fabric',
    contact_person VARCHAR(100) NULL,
    phone          VARCHAR(30)  NULL,
    whatsapp       VARCHAR(30)  NULL,
    email          VARCHAR(150) NULL,
    address        VARCHAR(255) NULL,
    city           VARCHAR(60)  NULL,
    ntn            VARCHAR(30)  NULL,
    strn           VARCHAR(30)  NULL,
    remarks        VARCHAR(255) NULL,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_parties_code (code),
    KEY ix_parties_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ink_colours (
    id            SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code          VARCHAR(10)  NOT NULL COMMENT 'C, M, Y, K, LC, LM, OR, RD, BL, GR, FY, FP ...',
    name          VARCHAR(40)  NOT NULL,
    name_ur       VARCHAR(40)  NULL,
    hex           CHAR(7)      NOT NULL DEFAULT '#000000',
    is_process    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '1 = CMYK process colour, 0 = special',
    sort_order    SMALLINT     NOT NULL DEFAULT 0,
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL,
    updated_by    INT UNSIGNED NULL,
    deleted_at    DATETIME     NULL,
    deleted_by    INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ink_colours_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One table for every stock item. Type-specific columns are NULL when not relevant:
--   grey_fabric / finished_fabric : quality, gsm, width_inch
--   ink                            : ink_colour_id, brand, process_type (rate is per item unit, normally liter)
--   paper                          : gsm, width_inch, brand
--   chemical                       : brand, process_type
CREATE TABLE IF NOT EXISTS items (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code           VARCHAR(30)  NOT NULL,
    name           VARCHAR(150) NOT NULL,
    name_ur        VARCHAR(150) NULL,
    item_type      ENUM('grey_fabric','finished_fabric','ink','paper','chemical','other') NOT NULL,
    unit_id        SMALLINT UNSIGNED NOT NULL,
    quality        VARCHAR(80)  NULL COMMENT 'fabric quality e.g. Lawn 60x60, Polyester Micro',
    gsm            DECIMAL(8,2) NULL,
    width_inch     DECIMAL(8,2) NULL,
    ink_colour_id  SMALLINT UNSIGNED NULL,
    brand          VARCHAR(60)  NULL,
    process_type   ENUM('sublimation','reactive','pigment','any') NULL,
    rate           DECIMAL(14,4) NOT NULL DEFAULT 0 COMMENT 'standard cost per item unit (PKR)',
    reorder_level  DECIMAL(14,3) NOT NULL DEFAULT 0,
    track_lots     TINYINT(1)   NOT NULL DEFAULT 0,
    remarks        VARCHAR(255) NULL,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_items_code (code),
    KEY ix_items_type (item_type),
    KEY ix_items_colour (ink_colour_id),
    CONSTRAINT fk_items_unit FOREIGN KEY (unit_id) REFERENCES units (id),
    CONSTRAINT fk_items_colour FOREIGN KEY (ink_colour_id) REFERENCES ink_colours (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS machines (
    id             SMALLINT UNSIGNED NOT NULL AUTO_INCREMENT,
    code           VARCHAR(20)  NOT NULL,
    name           VARCHAR(80)  NOT NULL,
    name_ur        VARCHAR(80)  NULL,
    machine_type   ENUM('sublimation','reactive','pigment') NOT NULL,
    make_model     VARCHAR(80)  NULL,
    speed_m_per_hr DECIMAL(10,2) NOT NULL DEFAULT 0,
    print_width_inch DECIMAL(8,2) NULL,
    hourly_cost    DECIMAL(14,2) NOT NULL DEFAULT 0 COMMENT 'power + labour + depreciation per hour (PKR)',
    warehouse_id   SMALLINT UNSIGNED NULL COMMENT 'floor location the machine draws consumables from',
    remarks        VARCHAR(255) NULL,
    is_active      TINYINT(1)   NOT NULL DEFAULT 1,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_machines_code (code),
    CONSTRAINT fk_machines_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS designs (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    design_code      VARCHAR(30)  NOT NULL,
    name             VARCHAR(120) NOT NULL,
    party_id         INT UNSIGNED NULL COMMENT 'customer the design belongs to',
    process_type     ENUM('sublimation','reactive','pigment') NOT NULL DEFAULT 'sublimation',
    image_path       VARCHAR(255) NULL COMMENT 'relative to private uploads dir',
    thumb_path       VARCHAR(255) NULL,
    repeat_width_cm  DECIMAL(8,2) NULL,
    repeat_height_cm DECIMAL(8,2) NULL,
    colour_count     TINYINT UNSIGNED NOT NULL DEFAULT 4,
    ink_coverage_pct DECIMAL(5,2) NOT NULL DEFAULT 0 COMMENT 'total ink coverage %',
    basis_gsm        DECIMAL(8,2) NULL COMMENT 'fabric GSM the ink ml/m figures are based on',
    basis_width_inch DECIMAL(8,2) NULL COMMENT 'fabric width the ink ml/m figures are based on',
    finished_item_id INT UNSIGNED NULL COMMENT 'default finished fabric item produced',
    default_machine_id SMALLINT UNSIGNED NULL,
    remarks          VARCHAR(255) NULL,
    is_active        TINYINT(1)   NOT NULL DEFAULT 1,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by       INT UNSIGNED NULL,
    updated_at       DATETIME     NULL,
    updated_by       INT UNSIGNED NULL,
    deleted_at       DATETIME     NULL,
    deleted_by       INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_designs_code (design_code),
    KEY ix_designs_party (party_id),
    CONSTRAINT fk_designs_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_designs_finished FOREIGN KEY (finished_item_id) REFERENCES items (id),
    CONSTRAINT fk_designs_machine FOREIGN KEY (default_machine_id) REFERENCES machines (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ink per design: ml of each ink per meter of printed fabric.
-- ml_per_meter is calculated from coverage_pct, fabric GSM and width
-- (settings: ink_ml_per_sqm_full, ink_reference_gsm) unless is_manual = 1.
CREATE TABLE IF NOT EXISTS design_inks (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    design_id     INT UNSIGNED NOT NULL,
    ink_colour_id SMALLINT UNSIGNED NOT NULL,
    item_id       INT UNSIGNED NULL COMMENT 'default ink item to consume; resolved by colour + process if NULL',
    coverage_pct  DECIMAL(5,2) NOT NULL DEFAULT 0,
    ml_per_meter  DECIMAL(12,4) NOT NULL DEFAULT 0,
    is_manual     TINYINT(1)   NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_design_ink (design_id, ink_colour_id),
    CONSTRAINT fk_di_design FOREIGN KEY (design_id) REFERENCES designs (id) ON DELETE CASCADE,
    CONSTRAINT fk_di_colour FOREIGN KEY (ink_colour_id) REFERENCES ink_colours (id),
    CONSTRAINT fk_di_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Non-ink Bill of Materials per meter of printed fabric (paper, chemicals, other).
CREATE TABLE IF NOT EXISTS design_bom (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    design_id     INT UNSIGNED NOT NULL,
    item_id       INT UNSIGNED NOT NULL,
    qty_per_meter DECIMAL(14,6) NOT NULL DEFAULT 0 COMMENT 'in item unit',
    wastage_pct   DECIMAL(5,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uq_design_bom (design_id, item_id),
    CONSTRAINT fk_bom_design FOREIGN KEY (design_id) REFERENCES designs (id) ON DELETE CASCADE,
    CONSTRAINT fk_bom_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  4. VOUCHERS (transactions)
--  Common header columns: voucher_no, voucher_date, status, remarks,
--  cancel info, audit columns, soft delete.
-- ---------------------------------------------------------------------

-- 4.1 Inward Gate Pass (IGP) — receipt at gate into Grey Store
CREATE TABLE IF NOT EXISTS inward_gate_passes (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    voucher_time   TIME         NULL,
    party_id       INT UNSIGNED NOT NULL,
    warehouse_id   SMALLINT UNSIGNED NOT NULL,
    ownership      ENUM('own','job_work') NOT NULL DEFAULT 'job_work',
    party_challan_no VARCHAR(40) NULL,
    vehicle_no     VARCHAR(20)  NULL,
    driver_name    VARCHAR(80)  NULL,
    driver_phone   VARCHAR(30)  NULL,
    total_rolls    INT          NOT NULL DEFAULT 0,
    total_qty      DECIMAL(14,3) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_igp_no (voucher_no),
    KEY ix_igp_date (voucher_date),
    KEY ix_igp_party (party_id),
    CONSTRAINT fk_igp_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_igp_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inward_gate_pass_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    igp_id         INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    item_id        INT UNSIGNED NOT NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    rolls          INT          NOT NULL DEFAULT 0,
    qty            DECIMAL(14,3) NOT NULL,
    unit_id        SMALLINT UNSIGNED NOT NULL,
    remarks        VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY ix_igpl_igp (igp_id),
    KEY ix_igpl_item (item_id),
    CONSTRAINT fk_igpl_igp FOREIGN KEY (igp_id) REFERENCES inward_gate_passes (id) ON DELETE CASCADE,
    CONSTRAINT fk_igpl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_igpl_unit FOREIGN KEY (unit_id) REFERENCES units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.2 Stock Transfer Voucher (STV)
CREATE TABLE IF NOT EXISTS stock_transfers (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    from_warehouse_id SMALLINT UNSIGNED NOT NULL,
    to_warehouse_id   SMALLINT UNSIGNED NOT NULL,
    total_rolls    INT          NOT NULL DEFAULT 0,
    total_qty      DECIMAL(14,3) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_stv_no (voucher_no),
    KEY ix_stv_date (voucher_date),
    CONSTRAINT fk_stv_from FOREIGN KEY (from_warehouse_id) REFERENCES warehouses (id),
    CONSTRAINT fk_stv_to FOREIGN KEY (to_warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    transfer_id    INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    item_id        INT UNSIGNED NOT NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    owner_party_id INT UNSIGNED NULL,
    rolls          INT          NOT NULL DEFAULT 0,
    qty            DECIMAL(14,3) NOT NULL,
    remarks        VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY ix_stvl_transfer (transfer_id),
    KEY ix_stvl_item (item_id),
    CONSTRAINT fk_stvl_transfer FOREIGN KEY (transfer_id) REFERENCES stock_transfers (id) ON DELETE CASCADE,
    CONSTRAINT fk_stvl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_stvl_owner FOREIGN KEY (owner_party_id) REFERENCES parties (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.3 Stock Consumption Voucher (SCV) — issue inks / paper / chemicals
CREATE TABLE IF NOT EXISTS stock_consumptions (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    warehouse_id   SMALLINT UNSIGNED NOT NULL,
    machine_id     SMALLINT UNSIGNED NULL,
    party_id       INT UNSIGNED NULL,
    design_id      INT UNSIGNED NULL,
    production_id  INT UNSIGNED NULL COMMENT 'job this issue is charged to',
    purpose        ENUM('production','sampling','maintenance','cleaning','other') NOT NULL DEFAULT 'production',
    total_amount   DECIMAL(16,2) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_scv_no (voucher_no),
    KEY ix_scv_date (voucher_date),
    KEY ix_scv_machine (machine_id),
    CONSTRAINT fk_scv_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
    CONSTRAINT fk_scv_machine FOREIGN KEY (machine_id) REFERENCES machines (id),
    CONSTRAINT fk_scv_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_scv_design FOREIGN KEY (design_id) REFERENCES designs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_consumption_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    consumption_id INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    item_id        INT UNSIGNED NOT NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    qty            DECIMAL(14,3) NOT NULL,
    rate           DECIMAL(14,4) NOT NULL DEFAULT 0,
    amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
    remarks        VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY ix_scvl_consumption (consumption_id),
    KEY ix_scvl_item (item_id),
    CONSTRAINT fk_scvl_consumption FOREIGN KEY (consumption_id) REFERENCES stock_consumptions (id) ON DELETE CASCADE,
    CONSTRAINT fk_scvl_item FOREIGN KEY (item_id) REFERENCES items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.4 Machine-wise Ink Loading (INK) — ink filled into a machine's tanks.
-- Reduces ink stock of the floor warehouse; feeds actual ink consumption.
CREATE TABLE IF NOT EXISTS ink_loads (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    voucher_time   TIME         NULL,
    machine_id     SMALLINT UNSIGNED NOT NULL,
    warehouse_id   SMALLINT UNSIGNED NOT NULL,
    total_ml       DECIMAL(14,3) NOT NULL DEFAULT 0,
    total_amount   DECIMAL(16,2) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ink_no (voucher_no),
    KEY ix_ink_date_machine (voucher_date, machine_id),
    CONSTRAINT fk_ink_machine FOREIGN KEY (machine_id) REFERENCES machines (id),
    CONSTRAINT fk_ink_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ink_load_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    ink_load_id    INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    item_id        INT UNSIGNED NOT NULL COMMENT 'ink item (carries the colour)',
    ink_colour_id  SMALLINT UNSIGNED NOT NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    ml_filled      DECIMAL(14,3) NOT NULL,
    qty            DECIMAL(14,3) NOT NULL COMMENT 'ml_filled converted to the item unit',
    rate           DECIMAL(14,4) NOT NULL DEFAULT 0,
    amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY ix_inkl_load (ink_load_id),
    KEY ix_inkl_colour (ink_colour_id),
    CONSTRAINT fk_inkl_load FOREIGN KEY (ink_load_id) REFERENCES ink_loads (id) ON DELETE CASCADE,
    CONSTRAINT fk_inkl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_inkl_colour FOREIGN KEY (ink_colour_id) REFERENCES ink_colours (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.5 Production Estimation Voucher (PEV) — no stock effect
CREATE TABLE IF NOT EXISTS production_estimations (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    party_id       INT UNSIGNED NULL,
    order_ref      VARCHAR(40)  NULL,
    design_id      INT UNSIGNED NOT NULL,
    machine_id     SMALLINT UNSIGNED NULL,
    fabric_item_id INT UNSIGNED NULL,
    fabric_gsm     DECIMAL(8,2) NULL,
    fabric_width_inch DECIMAL(8,2) NULL,
    meters         DECIMAL(14,3) NOT NULL,
    wastage_pct    DECIMAL(5,2) NOT NULL DEFAULT 0,
    machine_hours  DECIMAL(10,2) NOT NULL DEFAULT 0,
    ink_ml_total   DECIMAL(14,3) NOT NULL DEFAULT 0,
    ink_cost       DECIMAL(16,2) NOT NULL DEFAULT 0,
    paper_cost     DECIMAL(16,2) NOT NULL DEFAULT 0,
    chemical_cost  DECIMAL(16,2) NOT NULL DEFAULT 0,
    other_cost     DECIMAL(16,2) NOT NULL DEFAULT 0,
    machine_cost   DECIMAL(16,2) NOT NULL DEFAULT 0,
    total_cost     DECIMAL(16,2) NOT NULL DEFAULT 0,
    cost_per_meter DECIMAL(14,4) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_pev_no (voucher_no),
    KEY ix_pev_date (voucher_date),
    KEY ix_pev_design (design_id),
    CONSTRAINT fk_pev_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_pev_design FOREIGN KEY (design_id) REFERENCES designs (id),
    CONSTRAINT fk_pev_machine FOREIGN KEY (machine_id) REFERENCES machines (id),
    CONSTRAINT fk_pev_fabric FOREIGN KEY (fabric_item_id) REFERENCES items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_estimation_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    estimation_id  INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    line_type      ENUM('ink','paper','chemical','fabric','other') NOT NULL,
    item_id        INT UNSIGNED NULL,
    ink_colour_id  SMALLINT UNSIGNED NULL,
    qty            DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'ink lines: ml; others: item unit',
    unit_id        SMALLINT UNSIGNED NULL,
    rate           DECIMAL(14,4) NOT NULL DEFAULT 0,
    amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY ix_pevl_estimation (estimation_id),
    CONSTRAINT fk_pevl_estimation FOREIGN KEY (estimation_id) REFERENCES production_estimations (id) ON DELETE CASCADE,
    CONSTRAINT fk_pevl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_pevl_colour FOREIGN KEY (ink_colour_id) REFERENCES ink_colours (id),
    CONSTRAINT fk_pevl_unit FOREIGN KEY (unit_id) REFERENCES units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.6 / 4.7 Production Vouchers — BOM (BOM) and Manual (MPV)
CREATE TABLE IF NOT EXISTS productions (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
    production_type     ENUM('bom','manual') NOT NULL,
    manual_reason       ENUM('job','sampling','reprint','non_standard') NULL,
    voucher_no          VARCHAR(30)  NOT NULL,
    voucher_date        DATE         NOT NULL,
    party_id            INT UNSIGNED NULL,
    design_id           INT UNSIGNED NULL,
    machine_id          SMALLINT UNSIGNED NOT NULL,
    estimation_id       INT UNSIGNED NULL,
    start_time          DATETIME     NULL,
    end_time            DATETIME     NULL,
    machine_hours       DECIMAL(10,2) NOT NULL DEFAULT 0,
    operator_name       VARCHAR(80)  NULL,
    fabric_item_id      INT UNSIGNED NULL,
    fabric_warehouse_id SMALLINT UNSIGNED NULL,
    fabric_lot_no       VARCHAR(40)  NOT NULL DEFAULT '',
    fabric_issued_qty   DECIMAL(14,3) NOT NULL DEFAULT 0,
    finished_item_id    INT UNSIGNED NULL,
    finished_warehouse_id SMALLINT UNSIGNED NULL,
    finished_lot_no     VARCHAR(40)  NOT NULL DEFAULT '',
    produced_qty        DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'good meters added to finished store',
    produced_rolls      INT          NOT NULL DEFAULT 0,
    wastage_qty         DECIMAL(14,3) NOT NULL DEFAULT 0,
    rejected_qty        DECIMAL(14,3) NOT NULL DEFAULT 0,
    ink_ml_estimated    DECIMAL(14,3) NOT NULL DEFAULT 0,
    ink_ml_actual       DECIMAL(14,3) NOT NULL DEFAULT 0,
    material_cost       DECIMAL(16,2) NOT NULL DEFAULT 0,
    ink_cost            DECIMAL(16,2) NOT NULL DEFAULT 0,
    machine_cost        DECIMAL(16,2) NOT NULL DEFAULT 0,
    total_cost          DECIMAL(16,2) NOT NULL DEFAULT 0,
    cost_per_meter      DECIMAL(14,4) NOT NULL DEFAULT 0,
    remarks             VARCHAR(500) NULL,
    status              ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at        DATETIME     NULL,
    cancelled_by        INT UNSIGNED NULL,
    cancel_reason       VARCHAR(255) NULL,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by          INT UNSIGNED NULL,
    updated_at          DATETIME     NULL,
    updated_by          INT UNSIGNED NULL,
    deleted_at          DATETIME     NULL,
    deleted_by          INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_prod_no (voucher_no),
    KEY ix_prod_type_date (production_type, voucher_date),
    KEY ix_prod_machine (machine_id, voucher_date),
    KEY ix_prod_design (design_id),
    KEY ix_prod_party (party_id),
    CONSTRAINT fk_prod_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_prod_design FOREIGN KEY (design_id) REFERENCES designs (id),
    CONSTRAINT fk_prod_machine FOREIGN KEY (machine_id) REFERENCES machines (id),
    CONSTRAINT fk_prod_estimation FOREIGN KEY (estimation_id) REFERENCES production_estimations (id),
    CONSTRAINT fk_prod_fabric FOREIGN KEY (fabric_item_id) REFERENCES items (id),
    CONSTRAINT fk_prod_fabric_wh FOREIGN KEY (fabric_warehouse_id) REFERENCES warehouses (id),
    CONSTRAINT fk_prod_finished FOREIGN KEY (finished_item_id) REFERENCES items (id),
    CONSTRAINT fk_prod_finished_wh FOREIGN KEY (finished_warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raw material lines consumed by a production voucher (ink, paper, chemical, other).
CREATE TABLE IF NOT EXISTS production_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    production_id  INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    line_type      ENUM('ink','paper','chemical','other') NOT NULL,
    item_id        INT UNSIGNED NOT NULL,
    ink_colour_id  SMALLINT UNSIGNED NULL,
    warehouse_id   SMALLINT UNSIGNED NOT NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    est_qty        DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'from BOM, item unit',
    actual_qty     DECIMAL(14,3) NOT NULL DEFAULT 0 COMMENT 'deducted from stock, item unit',
    rate           DECIMAL(14,4) NOT NULL DEFAULT 0,
    amount         DECIMAL(16,2) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    KEY ix_pl_production (production_id),
    KEY ix_pl_item (item_id),
    CONSTRAINT fk_pl_production FOREIGN KEY (production_id) REFERENCES productions (id) ON DELETE CASCADE,
    CONSTRAINT fk_pl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_pl_colour FOREIGN KEY (ink_colour_id) REFERENCES ink_colours (id),
    CONSTRAINT fk_pl_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4.8 Outward Gate Pass / Delivery Chalan (DCV)
CREATE TABLE IF NOT EXISTS delivery_chalans (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_no     VARCHAR(30)  NOT NULL,
    voucher_date   DATE         NOT NULL,
    voucher_time   TIME         NULL,
    party_id       INT UNSIGNED NOT NULL,
    warehouse_id   SMALLINT UNSIGNED NOT NULL,
    party_ref      VARCHAR(40)  NULL COMMENT 'customer PO / order ref',
    delivery_address VARCHAR(255) NULL,
    vehicle_no     VARCHAR(20)  NULL,
    driver_name    VARCHAR(80)  NULL,
    driver_phone   VARCHAR(30)  NULL,
    receiver_name  VARCHAR(80)  NULL,
    total_rolls    INT          NOT NULL DEFAULT 0,
    total_qty      DECIMAL(14,3) NOT NULL DEFAULT 0,
    remarks        VARCHAR(500) NULL,
    status         ENUM('posted','cancelled') NOT NULL DEFAULT 'posted',
    cancelled_at   DATETIME     NULL,
    cancelled_by   INT UNSIGNED NULL,
    cancel_reason  VARCHAR(255) NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL,
    updated_by     INT UNSIGNED NULL,
    deleted_at     DATETIME     NULL,
    deleted_by     INT UNSIGNED NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dcv_no (voucher_no),
    KEY ix_dcv_date (voucher_date),
    KEY ix_dcv_party (party_id),
    CONSTRAINT fk_dcv_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_dcv_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_chalan_lines (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    chalan_id      INT UNSIGNED NOT NULL,
    line_no        SMALLINT UNSIGNED NOT NULL,
    item_id        INT UNSIGNED NOT NULL,
    design_id      INT UNSIGNED NULL,
    production_id  INT UNSIGNED NULL,
    lot_no         VARCHAR(40)  NOT NULL DEFAULT '',
    rolls          INT          NOT NULL DEFAULT 0,
    qty            DECIMAL(14,3) NOT NULL,
    unit_id        SMALLINT UNSIGNED NOT NULL,
    remarks        VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY ix_dcvl_chalan (chalan_id),
    KEY ix_dcvl_item (item_id),
    CONSTRAINT fk_dcvl_chalan FOREIGN KEY (chalan_id) REFERENCES delivery_chalans (id) ON DELETE CASCADE,
    CONSTRAINT fk_dcvl_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_dcvl_design FOREIGN KEY (design_id) REFERENCES designs (id),
    CONSTRAINT fk_dcvl_production FOREIGN KEY (production_id) REFERENCES productions (id),
    CONSTRAINT fk_dcvl_unit FOREIGN KEY (unit_id) REFERENCES units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
--  5. STOCK LEDGER — single source of truth for stock
--  Rows are written only by voucher save services inside the voucher's
--  DB transaction. On edit, a voucher's rows are replaced; on cancel
--  they are removed (the voucher itself and the audit log keep history).
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS stock_movements (
    id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    movement_date   DATE         NOT NULL,
    item_id         INT UNSIGNED NOT NULL,
    warehouse_id    SMALLINT UNSIGNED NOT NULL,
    lot_no          VARCHAR(40)  NOT NULL DEFAULT '',
    owner_party_id  INT UNSIGNED NULL COMMENT 'job-work fabric owner',
    qty_in          DECIMAL(14,3) NOT NULL DEFAULT 0,
    qty_out         DECIMAL(14,3) NOT NULL DEFAULT 0,
    rolls_in        INT          NOT NULL DEFAULT 0,
    rolls_out       INT          NOT NULL DEFAULT 0,
    rate            DECIMAL(14,4) NOT NULL DEFAULT 0,
    voucher_type    VARCHAR(20)  NOT NULL COMMENT 'IGP, STV, SCV, INK, BOM, MPV, DCV, OPN',
    voucher_id      INT UNSIGNED NOT NULL,
    voucher_line_id INT UNSIGNED NULL,
    voucher_no      VARCHAR(30)  NOT NULL,
    party_id        INT UNSIGNED NULL,
    machine_id      SMALLINT UNSIGNED NULL,
    design_id       INT UNSIGNED NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_by      INT UNSIGNED NULL,
    PRIMARY KEY (id),
    KEY ix_sm_balance (item_id, warehouse_id, lot_no),
    KEY ix_sm_voucher (voucher_type, voucher_id),
    KEY ix_sm_date (movement_date),
    KEY ix_sm_wh_item (warehouse_id, item_id),
    KEY ix_sm_party (party_id),
    KEY ix_sm_owner (owner_party_id),
    KEY ix_sm_machine (machine_id),
    CONSTRAINT fk_sm_item FOREIGN KEY (item_id) REFERENCES items (id),
    CONSTRAINT fk_sm_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
    CONSTRAINT fk_sm_owner FOREIGN KEY (owner_party_id) REFERENCES parties (id),
    CONSTRAINT fk_sm_party FOREIGN KEY (party_id) REFERENCES parties (id),
    CONSTRAINT fk_sm_machine FOREIGN KEY (machine_id) REFERENCES machines (id),
    CONSTRAINT fk_sm_design FOREIGN KEY (design_id) REFERENCES designs (id),
    CONSTRAINT ck_sm_qty CHECK (qty_in >= 0 AND qty_out >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Current stock per item / warehouse / lot (always derived from the ledger).
CREATE OR REPLACE VIEW v_stock_balance AS
SELECT  sm.item_id,
        sm.warehouse_id,
        sm.lot_no,
        SUM(sm.qty_in - sm.qty_out)     AS qty,
        SUM(sm.rolls_in - sm.rolls_out) AS rolls
FROM    stock_movements sm
GROUP BY sm.item_id, sm.warehouse_id, sm.lot_no;

SET FOREIGN_KEY_CHECKS = 1;
