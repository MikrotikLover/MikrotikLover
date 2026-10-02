-- 002: Setup module - departments, designations, shifts, shift groups, holidays, employees

CREATE TABLE departments (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code        VARCHAR(20)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    name_ur     VARCHAR(100) NULL,
    remarks     VARCHAR(255) NULL,
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_by  INT UNSIGNED NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  INT UNSIGNED NULL,
    updated_at  DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_dept_code (code),
    UNIQUE KEY uq_dept_name (name),
    CONSTRAINT fk_dept_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_dept_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE designations (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code        VARCHAR(20)  NOT NULL,
    name        VARCHAR(100) NOT NULL,
    name_ur     VARCHAR(100) NULL,
    remarks     VARCHAR(255) NULL,
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_by  INT UNSIGNED NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  INT UNSIGNED NULL,
    updated_at  DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_desig_code (code),
    UNIQUE KEY uq_desig_name (name),
    CONSTRAINT fk_desig_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_desig_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shift timings. Overnight shift: end_time <= start_time (e.g. 20:00 -> 08:00).
CREATE TABLE shifts (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code              VARCHAR(20)  NOT NULL,
    name              VARCHAR(60)  NOT NULL,
    start_time        TIME         NOT NULL,
    end_time          TIME         NOT NULL,
    is_overnight      TINYINT(1)   NOT NULL DEFAULT 0,
    break_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    grace_minutes     SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- late allowed without marking late
    half_day_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 0,   -- worked minutes below this => Half Day (0 = disabled)
    min_ot_minutes    SMALLINT UNSIGNED NOT NULL DEFAULT 30,  -- extra minutes below this are not OT candidates
    duration_minutes  SMALLINT UNSIGNED NOT NULL,             -- net shift length (end - start - break), computed by app
    remarks           VARCHAR(255) NULL,
    is_active         TINYINT(1)   NOT NULL DEFAULT 1,
    created_by        INT UNSIGNED NULL,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by        INT UNSIGNED NULL,
    updated_at        DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_shift_code (code),
    CONSTRAINT fk_shift_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_shift_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shift group = rotation of shifts. Employee has shift_group_id + shift_date (rotation anchor).
-- Shift on a date = step at position ((date - shift_date) mod total rotation days).
CREATE TABLE shift_groups (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code        VARCHAR(20)  NOT NULL,
    name        VARCHAR(60)  NOT NULL,
    rest_days   VARCHAR(20)  NULL,          -- comma list of weekdays 0=Sun..6=Sat; NULL = company default
    remarks     VARCHAR(255) NULL,
    is_active   TINYINT(1)   NOT NULL DEFAULT 1,
    created_by  INT UNSIGNED NULL,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  INT UNSIGNED NULL,
    updated_at  DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sg_code (code),
    CONSTRAINT fk_sg_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_sg_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shift_group_steps (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    shift_group_id INT UNSIGNED NOT NULL,
    seq            SMALLINT UNSIGNED NOT NULL,
    shift_id       INT UNSIGNED NOT NULL,
    days           SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sgs (shift_group_id, seq),
    KEY idx_sgs_shift (shift_id),
    CONSTRAINT fk_sgs_group FOREIGN KEY (shift_group_id) REFERENCES shift_groups(id) ON DELETE CASCADE,
    CONSTRAINT fk_sgs_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE holidays (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    holiday_date DATE         NOT NULL,
    name         VARCHAR(100) NOT NULL,
    name_ur      VARCHAR(100) NULL,
    holiday_type ENUM('gazetted','company','other') NOT NULL DEFAULT 'gazetted',
    is_paid      TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT UNSIGNED NULL,
    updated_at   DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_holiday_date (holiday_date),
    CONSTRAINT fk_hol_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_hol_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employees (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,          -- "Auto ID"
    code            VARCHAR(20)  NOT NULL,                          -- printed on ID card + barcode
    name            VARCHAR(100) NOT NULL,
    name_ur         VARCHAR(100) NULL,
    relation        ENUM('S/O','W/O','D/O') NOT NULL DEFAULT 'S/O',
    father_name     VARCHAR(100) NULL,
    father_name_ur  VARCHAR(100) NULL,
    gender          ENUM('M','F') NOT NULL DEFAULT 'M',
    address         VARCHAR(255) NULL,
    city            VARCHAR(60)  NULL,
    dob             DATE         NULL,
    cell            VARCHAR(20)  NULL,
    phone_res       VARCHAR(20)  NULL,
    reference       VARCHAR(100) NULL,
    qualification   VARCHAR(100) NULL,
    cnic            CHAR(15)     NULL,                              -- 00000-0000000-0
    email           VARCHAR(120) NULL,
    department_id   INT UNSIGNED NOT NULL,
    designation_id  INT UNSIGNED NOT NULL,
    emp_type        ENUM('permanent','daily_wages','contract') NOT NULL DEFAULT 'permanent',
    joining_date    DATE         NOT NULL,
    leaving_date    DATE         NULL,
    shift_group_id  INT UNSIGNED NULL,
    shift_date      DATE         NULL,                              -- rotation anchor date
    status          ENUM('active','inactive') NOT NULL DEFAULT 'active',
    machine_id      INT UNSIGNED NULL,                              -- biometric enrollment number
    photo_file      VARCHAR(120) NULL,                              -- file name inside storage/photos
    remarks         VARCHAR(255) NULL,
    created_by      INT UNSIGNED NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT UNSIGNED NULL,
    updated_at      DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_emp_code (code),
    UNIQUE KEY uq_emp_cnic (cnic),
    UNIQUE KEY uq_emp_machine (machine_id),
    KEY idx_emp_dept (department_id, status),
    KEY idx_emp_desig (designation_id),
    KEY idx_emp_sg (shift_group_id),
    KEY idx_emp_name (name),
    KEY idx_emp_type (emp_type, status),
    CONSTRAINT fk_emp_dept  FOREIGN KEY (department_id)  REFERENCES departments(id),
    CONSTRAINT fk_emp_desig FOREIGN KEY (designation_id) REFERENCES designations(id),
    CONSTRAINT fk_emp_sg    FOREIGN KEY (shift_group_id) REFERENCES shift_groups(id),
    CONSTRAINT fk_emp_cb    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_emp_ub    FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Effective-dated salary info; increments add a new row, history is kept.
CREATE TABLE employee_salary_history (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id     INT UNSIGNED NOT NULL,
    effective_from  DATE         NOT NULL,
    basic_salary    DECIMAL(12,2) NOT NULL DEFAULT 0,   -- monthly (permanent / contract)
    daily_rate      DECIMAL(10,2) NOT NULL DEFAULT 0,   -- daily wages
    allowances      DECIMAL(12,2) NOT NULL DEFAULT 0,   -- fixed monthly allowances
    ot_applicable   TINYINT(1)   NOT NULL DEFAULT 1,
    ot_rate         DECIMAL(10,2) NULL,                 -- per hour; NULL = auto (basic/days/shift hrs x multiplier)
    eobi_applicable  TINYINT(1)  NOT NULL DEFAULT 0,
    pessi_applicable TINYINT(1)  NOT NULL DEFAULT 0,    -- PESSI (Punjab) / SESSI (Sindh) per company setting
    tax_applicable   TINYINT(1)  NOT NULL DEFAULT 0,
    payment_mode    ENUM('cash','bank') NOT NULL DEFAULT 'cash',
    bank_name       VARCHAR(100) NULL,
    bank_account    VARCHAR(40)  NULL,
    reason          VARCHAR(100) NULL,                  -- Appointment / Increment / Promotion ...
    remarks         VARCHAR(255) NULL,
    created_by      INT UNSIGNED NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT UNSIGNED NULL,
    updated_at      DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_esh (employee_id, effective_from),
    CONSTRAINT fk_esh_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_esh_cb  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_esh_ub  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employee_qualifications (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id  INT UNSIGNED NOT NULL,
    degree       VARCHAR(100) NOT NULL,
    institute    VARCHAR(150) NULL,
    passing_year SMALLINT UNSIGNED NULL,
    grade        VARCHAR(20)  NULL,
    remarks      VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY idx_eq_emp (employee_id),
    CONSTRAINT fk_eq_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE employee_experiences (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id  INT UNSIGNED NOT NULL,
    organization VARCHAR(150) NOT NULL,
    designation  VARCHAR(100) NULL,
    from_date    DATE         NULL,
    to_date      DATE         NULL,
    reason_left  VARCHAR(150) NULL,
    remarks      VARCHAR(255) NULL,
    PRIMARY KEY (id),
    KEY idx_ex_emp (employee_id),
    CONSTRAINT fk_ex_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
