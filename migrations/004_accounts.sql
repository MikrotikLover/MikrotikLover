-- 004: Accounts - chart of accounts, typed vouchers, loans, installments, journal entries

CREATE TABLE accounts (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code         VARCHAR(20)  NOT NULL,
    name         VARCHAR(100) NOT NULL,
    account_type ENUM('asset','liability','equity','income','expense') NOT NULL,
    system_key   VARCHAR(40)  NULL,          -- used by automatic postings (salary_expense, salary_payable ...)
    is_active    TINYINT(1)   NOT NULL DEFAULT 1,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT UNSIGNED NULL,
    updated_at   DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_acc_code (code),
    UNIQUE KEY uq_acc_syskey (system_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Typed vouchers: ADV advance, LOAN loan, INC incentive, PEN penalty, OT overtime, JV journal
CREATE TABLE vouchers (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_type    ENUM('ADV','LOAN','INC','PEN','OT','JV') NOT NULL,
    vr_no           INT UNSIGNED NOT NULL,
    vr_date         DATE         NOT NULL,
    employee_id     INT UNSIGNED NULL,          -- NULL for JV
    amount          DECIMAL(12,2) NOT NULL DEFAULT 0,
    ot_hours        DECIMAL(6,2) NULL,          -- OT voucher
    deduct_month    DATE         NULL,          -- ADV/INC/PEN: salary month (1st of month) it applies to
    salary_sheet_id INT UNSIGNED NULL,          -- set when consumed by a posted salary sheet
    remarks         VARCHAR(255) NULL,
    status          ENUM('draft','posted') NOT NULL DEFAULT 'draft',
    is_system       TINYINT(1)   NOT NULL DEFAULT 0,   -- auto-generated (salary JV)
    posted_by       INT UNSIGNED NULL,
    posted_at       DATETIME     NULL,
    deleted_at      DATETIME     NULL,          -- soft delete (posted data is never hard-deleted)
    deleted_by      INT UNSIGNED NULL,
    created_by      INT UNSIGNED NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by      INT UNSIGNED NULL,
    updated_at      DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_vr (voucher_type, vr_no),
    KEY idx_vr_date (vr_date, voucher_type),
    KEY idx_vr_emp (employee_id, voucher_type, status),
    KEY idx_vr_month (deduct_month, voucher_type),
    CONSTRAINT fk_vr_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_vr_pb  FOREIGN KEY (posted_by)  REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_vr_db  FOREIGN KEY (deleted_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_vr_cb  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_vr_ub  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loans (
    id           INT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_id   INT UNSIGNED NOT NULL,
    employee_id  INT UNSIGNED NOT NULL,
    amount       DECIMAL(12,2) NOT NULL,
    installment  DECIMAL(12,2) NOT NULL,
    start_month  DATE         NOT NULL,          -- 1st of first deduction month
    status       ENUM('active','closed') NOT NULL DEFAULT 'active',
    remarks      VARCHAR(255) NULL,
    created_by   INT UNSIGNED NULL,
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by   INT UNSIGNED NULL,
    updated_at   DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_loan_voucher (voucher_id),
    KEY idx_loan_emp (employee_id, status),
    CONSTRAINT fk_loan_vr  FOREIGN KEY (voucher_id) REFERENCES vouchers(id),
    CONSTRAINT fk_loan_emp FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_loan_cb  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_loan_ub  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loan_installments (
    id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
    loan_id          INT UNSIGNED NOT NULL,
    due_month        DATE         NOT NULL,       -- 1st of month
    scheduled_amount DECIMAL(12,2) NOT NULL,
    deducted_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
    status           ENUM('scheduled','deducted','skipped','adjusted') NOT NULL DEFAULT 'scheduled',
    salary_sheet_id  INT UNSIGNED NULL,
    remarks          VARCHAR(255) NULL,
    created_by       INT UNSIGNED NULL,
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by       INT UNSIGNED NULL,
    updated_at       DATETIME     NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_li_month (loan_id, due_month),
    KEY idx_li_month (due_month, status),
    CONSTRAINT fk_li_loan FOREIGN KEY (loan_id) REFERENCES loans(id) ON DELETE CASCADE,
    CONSTRAINT fk_li_cb   FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_li_ub   FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Double-entry lines of a JV (sum(debit) = sum(credit) enforced by the app inside a transaction)
CREATE TABLE journal_entries (
    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    voucher_id  INT UNSIGNED NOT NULL,
    line_no     SMALLINT UNSIGNED NOT NULL,
    account_id  INT UNSIGNED NOT NULL,
    employee_id INT UNSIGNED NULL,
    debit       DECIMAL(14,2) NOT NULL DEFAULT 0,
    credit      DECIMAL(14,2) NOT NULL DEFAULT 0,
    narration   VARCHAR(255) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_je_line (voucher_id, line_no),
    KEY idx_je_account (account_id),
    KEY idx_je_emp (employee_id),
    CONSTRAINT fk_je_vr  FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE CASCADE,
    CONSTRAINT fk_je_acc FOREIGN KEY (account_id) REFERENCES accounts(id),
    CONSTRAINT fk_je_emp FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
