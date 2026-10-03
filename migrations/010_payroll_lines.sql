-- 010: payroll (batch 4)
-- Day counts become fractional with 2 decimals: short / half days are paid on actual hours
-- (worked minutes / shift net minutes), not a fixed half day.
ALTER TABLE salary_sheet_lines
    MODIFY absent_days    DECIMAL(6,2) NOT NULL DEFAULT 0,
    MODIFY leave_wp_days  DECIMAL(6,2) NOT NULL DEFAULT 0,
    MODIFY leave_wop_days DECIMAL(6,2) NOT NULL DEFAULT 0,
    MODIFY rest_days      DECIMAL(6,2) NOT NULL DEFAULT 0,
    MODIFY work_days      DECIMAL(6,2) NOT NULL DEFAULT 0,
    MODIFY paid_days      DECIMAL(6,2) NOT NULL DEFAULT 0,
    ADD COLUMN holiday_days   DECIMAL(6,2)  NOT NULL DEFAULT 0 AFTER rest_days,       -- paid holidays (included in rest days)
    ADD COLUMN unmarked_days  DECIMAL(6,2)  NOT NULL DEFAULT 0 AFTER holiday_days,    -- employed days without attendance (not paid)
    ADD COLUMN allowances     DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER daily_rate,      -- monthly allowances from salary info
    ADD COLUMN allowance_pay  DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER work_pay,        -- allowances / days x paid days
    ADD COLUMN ot_voucher_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER ot_amount,    -- fixed OT voucher amounts (included in ot_amount)
    ADD COLUMN bank_name      VARCHAR(100)  NULL AFTER payment_mode,
    ADD COLUMN warnings       VARCHAR(500)  NULL AFTER remarks;

ALTER TABLE salary_sheets
    ADD COLUMN day_basis VARCHAR(10) NOT NULL DEFAULT 'calendar' AFTER days_in_month;

-- Per-loan record of what each salary sheet deducted (supports several loans per employee).
-- Draft rows disappear when a loan is rescheduled; posting re-allocates from fresh data anyway.
CREATE TABLE salary_sheet_loans (
    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
    salary_sheet_id     INT UNSIGNED NOT NULL,
    employee_id         INT UNSIGNED NOT NULL,
    loan_installment_id INT UNSIGNED NOT NULL,
    planned             DECIMAL(12,2) NOT NULL,
    deducted            DECIMAL(12,2) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_ssl_inst (salary_sheet_id, loan_installment_id),
    CONSTRAINT fk_ssln_ss   FOREIGN KEY (salary_sheet_id) REFERENCES salary_sheets(id) ON DELETE CASCADE,
    CONSTRAINT fk_ssln_emp  FOREIGN KEY (employee_id) REFERENCES employees(id),
    CONSTRAINT fk_ssln_inst FOREIGN KEY (loan_installment_id) REFERENCES loan_installments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- HR can view and print salary sheets; Accountant already has full salary rights.
INSERT IGNORE INTO permissions (role_id, module, action)
SELECT r.id, 'salary', a.action FROM roles r JOIN (SELECT 'view' action UNION ALL SELECT 'print') a WHERE r.name = 'HR';
