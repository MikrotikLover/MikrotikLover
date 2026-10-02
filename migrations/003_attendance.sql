-- 003: Attendance - devices, raw punches, vouchers, daily attendance, leave, overtime

-- ZKTeco devices pushing via ADMS (/iclock/cdata)
CREATE TABLE devices (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    serial_no     VARCHAR(50)  NOT NULL,
    name          VARCHAR(60)  NOT NULL,
    location      VARCHAR(100) NULL,
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    last_seen_at  DATETIME     NULL,
    last_stamp    VARCHAR(30)  NULL,            -- ATTLOG stamp acknowledged to device
    created_by    INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_device_sn (serial_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Raw punches from machine push, barcode kiosk or CSV import. Never edited, only posted.
CREATE TABLE attendance_punches (
    id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    machine_id   INT UNSIGNED NULL,                 -- enrollment no. on device
    employee_id  INT UNSIGNED NULL,                 -- resolved via employees.machine_id / code
    punch_time   DATETIME     NOT NULL,
    punch_state  TINYINT      NULL,                 -- device state: 0 in, 1 out, 4 OT in, 5 OT out ...
    verify_mode  TINYINT      NULL,
    source       ENUM('machine','barcode','csv','manual') NOT NULL,
    person_key   VARCHAR(30)  NOT NULL,             -- 'M<machine_id>' or 'E<employee_id>' (dedupe key, never NULL)
    device_sn    VARCHAR(50)  NULL,
    is_processed TINYINT(1)   NOT NULL DEFAULT 0,
    raw_line     VARCHAR(255) NULL,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_punch (person_key, punch_time, source),
    KEY idx_punch_emp_time (employee_id, punch_time),
    KEY idx_punch_time (punch_time),
    KEY idx_punch_machine (machine_id, punch_time),
    CONSTRAINT fk_punch_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_punch_cb  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Manual attendance voucher (date + department grid)
CREATE TABLE attendance_vouchers (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    vr_no         INT UNSIGNED NOT NULL,
    vr_date       DATE         NOT NULL,
    department_id INT UNSIGNED NULL,
    remarks       VARCHAR(255) NULL,
    created_by    INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_av_no (vr_no),
    UNIQUE KEY uq_av_date_dept (vr_date, department_id),
    CONSTRAINT fk_av_dept FOREIGN KEY (department_id) REFERENCES departments(id),
    CONSTRAINT fk_av_cb   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_av_ub   FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per employee per date (enforced by unique key).
-- Status: P Present, A Absent, L Leave (paid), LW Leave without pay, S Shift start/joined,
--         R Rest day, H Holiday, HD Half day, O Off / not yet joined
CREATE TABLE attendance_daily (
    id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id    INT UNSIGNED NOT NULL,
    att_date       DATE         NOT NULL,
    shift_id       INT UNSIGNED NULL,
    status         ENUM('P','A','L','LW','S','R','H','HD','O') NOT NULL,
    time_in        DATETIME     NULL,
    time_out       DATETIME     NULL,
    work_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- always computed from time_in/time_out
    late_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    early_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    ot_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- OT candidate, approved in `overtime`
    source         ENUM('manual','machine','barcode','csv','system') NOT NULL DEFAULT 'manual',
    voucher_id     INT UNSIGNED NULL,
    is_flagged     TINYINT(1)   NOT NULL DEFAULT 0,        -- outlier / missing punch etc.
    flag_reason    VARCHAR(150) NULL,
    remarks        VARCHAR(255) NULL,
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_att_emp_date (employee_id, att_date),
    KEY idx_att_date_status (att_date, status),
    KEY idx_att_voucher (voucher_id),
    CONSTRAINT fk_att_emp     FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_att_shift   FOREIGN KEY (shift_id) REFERENCES shifts(id),
    CONSTRAINT fk_att_voucher FOREIGN KEY (voucher_id) REFERENCES attendance_vouchers(id) ON DELETE SET NULL,
    CONSTRAINT fk_att_cb      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_att_ub      FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leave_types (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code         VARCHAR(10)  NOT NULL,
    name         VARCHAR(60)  NOT NULL,
    name_ur      VARCHAR(60)  NULL,
    yearly_quota DECIMAL(5,1) NOT NULL DEFAULT 0,
    is_paid      TINYINT(1)   NOT NULL DEFAULT 1,
    is_active    TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT UNSIGNED NULL,
    updated_at   DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_lt_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leave_register (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id   INT UNSIGNED NOT NULL,
    leave_type_id INT UNSIGNED NOT NULL,
    from_date     DATE         NOT NULL,
    to_date       DATE         NOT NULL,
    days          DECIMAL(5,1) NOT NULL,
    reason        VARCHAR(255) NULL,
    status        ENUM('pending','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
    approved_by   INT UNSIGNED NULL,
    approved_at   DATETIME     NULL,
    created_by    INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_lr_emp (employee_id, from_date),
    KEY idx_lr_status (status),
    CONSTRAINT fk_lr_emp  FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_lr_type FOREIGN KEY (leave_type_id) REFERENCES leave_types(id),
    CONSTRAINT fk_lr_appr FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_lr_cb   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_lr_ub   FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OT candidates from daily post (or manual); supervisor approves before payroll.
CREATE TABLE overtime (
    id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id        INT UNSIGNED NOT NULL,
    ot_date            DATE         NOT NULL,
    attendance_id      BIGINT UNSIGNED NULL,
    computed_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    approved_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    status             ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    approved_by        INT UNSIGNED NULL,
    approved_at        DATETIME     NULL,
    salary_sheet_id    INT UNSIGNED NULL,           -- set when consumed by a posted salary sheet
    remarks            VARCHAR(255) NULL,
    created_by         INT UNSIGNED NULL,
    created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by         INT UNSIGNED NULL,
    updated_at         DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ot_emp_date (employee_id, ot_date),
    KEY idx_ot_status (status, ot_date),
    CONSTRAINT fk_ot_emp  FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_ot_att  FOREIGN KEY (attendance_id) REFERENCES attendance_daily(id) ON DELETE SET NULL,
    CONSTRAINT fk_ot_appr FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_ot_cb   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_ot_ub   FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
