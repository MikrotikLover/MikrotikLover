-- 005: Payroll - statutory rates, tax slabs, salary sheets

-- EOBI / PESSI / SESSI, effective-dated, admin-editable (never hard-coded in code)
CREATE TABLE statutory_rates (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code             ENUM('EOBI','PESSI','SESSI') NOT NULL,
    effective_from   DATE         NOT NULL,
    calc_method      ENUM('percent_of_min_wage','percent_of_wage','fixed') NOT NULL,
    employee_share   DECIMAL(10,4) NOT NULL DEFAULT 0,   -- % or fixed amount (per calc_method)
    employer_share   DECIMAL(10,4) NOT NULL DEFAULT 0,
    min_wage         DECIMAL(12,2) NULL,                 -- base for percent_of_min_wage
    wage_ceiling     DECIMAL(12,2) NULL,                 -- wage above this is not covered (NULL = no cap)
    remarks          VARCHAR(255) NULL,
    created_by       INT UNSIGNED NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by       INT UNSIGNED NULL,
    updated_at       DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_sr (code, effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- FBR salaried-person slabs: tax = fixed_amount + rate% x (annual income - income_from)
CREATE TABLE tax_slabs (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    effective_from DATE          NOT NULL,      -- start of tax year (e.g. 2025-07-01)
    tax_year       VARCHAR(9)    NOT NULL,      -- '2025-26'
    income_from    DECIMAL(14,2) NOT NULL,      -- annual taxable income lower bound (exclusive)
    income_to      DECIMAL(14,2) NULL,          -- upper bound inclusive (NULL = no limit)
    fixed_amount   DECIMAL(14,2) NOT NULL DEFAULT 0,
    rate_percent   DECIMAL(6,3)  NOT NULL DEFAULT 0,
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by     INT UNSIGNED NULL,
    updated_at     DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ts (effective_from, income_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE salary_sheets (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    sheet_type    ENUM('permanent','daily_wages') NOT NULL,
    period_from   DATE         NOT NULL,
    period_to     DATE         NOT NULL,
    salary_month  DATE         NOT NULL,           -- 1st of month (lock key)
    days_in_month TINYINT UNSIGNED NOT NULL,
    status        ENUM('draft','posted') NOT NULL DEFAULT 'draft',
    paid_date     DATE         NULL,
    jv_id         INT UNSIGNED NULL,
    remarks       VARCHAR(255) NULL,
    posted_by     INT UNSIGNED NULL,
    posted_at     DATETIME     NULL,
    created_by    INT UNSIGNED NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by    INT UNSIGNED NULL,
    updated_at    DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ss (sheet_type, salary_month),
    KEY idx_ss_status (status),
    CONSTRAINT fk_ss_jv FOREIGN KEY (jv_id) REFERENCES vouchers(id),
    CONSTRAINT fk_ss_pb FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_ss_cb FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_ss_ub FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE salary_sheet_lines (
    id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
    salary_sheet_id   INT UNSIGNED NOT NULL,
    employee_id       INT UNSIGNED NOT NULL,
    department_id     INT UNSIGNED NOT NULL,      -- snapshot at time of sheet
    designation_id    INT UNSIGNED NOT NULL,
    basic_salary      DECIMAL(12,2) NOT NULL DEFAULT 0,
    daily_rate        DECIMAL(10,2) NOT NULL DEFAULT 0,
    absent_days       DECIMAL(5,1) NOT NULL DEFAULT 0,
    leave_wp_days     DECIMAL(5,1) NOT NULL DEFAULT 0,   -- leave with pay
    leave_wop_days    DECIMAL(5,1) NOT NULL DEFAULT 0,   -- leave without pay
    rest_days         DECIMAL(5,1) NOT NULL DEFAULT 0,
    work_days         DECIMAL(5,1) NOT NULL DEFAULT 0,
    paid_days         DECIMAL(5,1) NOT NULL DEFAULT 0,
    work_pay          DECIMAL(12,2) NOT NULL DEFAULT 0,
    ot_hours          DECIMAL(7,2) NOT NULL DEFAULT 0,
    ot_rate           DECIMAL(10,2) NOT NULL DEFAULT 0,
    ot_amount         DECIMAL(12,2) NOT NULL DEFAULT 0,
    gross             DECIMAL(12,2) NOT NULL DEFAULT 0,
    fine              DECIMAL(12,2) NOT NULL DEFAULT 0,
    advance           DECIMAL(12,2) NOT NULL DEFAULT 0,
    loan_deduction    DECIMAL(12,2) NOT NULL DEFAULT 0,
    loan_balance      DECIMAL(12,2) NOT NULL DEFAULT 0,   -- remaining after this deduction
    incentive         DECIMAL(12,2) NOT NULL DEFAULT 0,
    penalty           DECIMAL(12,2) NOT NULL DEFAULT 0,
    eobi              DECIMAL(12,2) NOT NULL DEFAULT 0,
    pessi             DECIMAL(12,2) NOT NULL DEFAULT 0,
    income_tax        DECIMAL(12,2) NOT NULL DEFAULT 0,
    net_salary        DECIMAL(12,2) NOT NULL DEFAULT 0,
    payment_mode      ENUM('cash','bank') NOT NULL DEFAULT 'cash',
    bank_account      VARCHAR(40)  NULL,
    remarks           VARCHAR(255) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ssl (salary_sheet_id, employee_id),
    KEY idx_ssl_emp (employee_id),
    CONSTRAINT fk_ssl_ss    FOREIGN KEY (salary_sheet_id) REFERENCES salary_sheets(id) ON DELETE CASCADE,
    CONSTRAINT fk_ssl_emp   FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_ssl_dept  FOREIGN KEY (department_id) REFERENCES departments(id),
    CONSTRAINT fk_ssl_desig FOREIGN KEY (designation_id) REFERENCES designations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE overtime
    ADD CONSTRAINT fk_ot_ss FOREIGN KEY (salary_sheet_id) REFERENCES salary_sheets(id) ON DELETE SET NULL;
ALTER TABLE vouchers
    ADD CONSTRAINT fk_vr_ss FOREIGN KEY (salary_sheet_id) REFERENCES salary_sheets(id) ON DELETE SET NULL;
ALTER TABLE loan_installments
    ADD CONSTRAINT fk_li_ss FOREIGN KEY (salary_sheet_id) REFERENCES salary_sheets(id) ON DELETE SET NULL;
