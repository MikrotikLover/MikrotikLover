-- 013: full-scope gaps
--   * attendance day posting (a verified date is locked; admin unpost is audit-logged)
--   * employee shift-group history
--   * daily-wages salary sheets may be weekly / fortnightly (several per month)
--   * net salary never negative: unrecovered advance / penalty / fine are carried to the next period
--   * salary sheet unpost (admin): loan installments remember their status before posting
--   * company late grace minutes, 2-minute barcode repeat window, Data Entry role

-- Attendance dates verified and locked by an admin.
CREATE TABLE attendance_day_posts (
    att_date   DATE         NOT NULL,
    remarks    VARCHAR(255) NULL,
    posted_by  INT UNSIGNED NULL,
    posted_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (att_date),
    CONSTRAINT fk_adp_pb FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shift group assignments over time (the employee row holds the current one).
CREATE TABLE employee_shift_history (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    employee_id    INT UNSIGNED NOT NULL,
    shift_group_id INT UNSIGNED NULL,
    shift_date     DATE         NULL,          -- rotation anchor / start of this assignment
    changed_by     INT UNSIGNED NULL,
    changed_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_esh_emp (employee_id, changed_at),
    CONSTRAINT fk_eshh_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_eshh_sg  FOREIGN KEY (shift_group_id) REFERENCES shift_groups(id),
    CONSTRAINT fk_eshh_cb  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO employee_shift_history (employee_id, shift_group_id, shift_date, changed_by, changed_at)
SELECT id, shift_group_id, COALESCE(shift_date, joining_date), created_by, created_at FROM employees WHERE shift_group_id IS NOT NULL;

-- Several daily-wages sheets per month (weekly / fortnightly); one permanent sheet per month is kept by the app.
ALTER TABLE salary_sheets
    ADD UNIQUE KEY uq_ss_from (sheet_type, period_from),
    DROP INDEX uq_ss,
    ADD KEY idx_ss_month (sheet_type, salary_month);

-- Net salary is never negative: what could not be deducted is carried forward.
--   advance / penalty / fine = amounts actually deducted; fine_entered = fine typed on the sheet
ALTER TABLE salary_sheet_lines
    ADD COLUMN fine_entered    DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER fine,
    ADD COLUMN advance_carried DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER advance,
    ADD COLUMN penalty_carried DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER penalty,
    ADD COLUMN fine_carried    DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER fine_entered;
UPDATE salary_sheet_lines SET fine_entered = fine;

-- System vouchers created when posting carries an unrecovered advance / penalty / fine forward.
ALTER TABLE vouchers
    ADD COLUMN carried_from_sheet_id INT UNSIGNED NULL AFTER salary_sheet_id,
    ADD CONSTRAINT fk_vr_carry FOREIGN KEY (carried_from_sheet_id) REFERENCES salary_sheets(id);

-- Unpost restores an installment's status (scheduled / adjusted) as it was before posting.
ALTER TABLE loan_installments
    ADD COLUMN pre_post_status VARCHAR(10) NULL AFTER status;

ALTER TABLE salary_sheets
    ADD COLUMN unposted_by INT UNSIGNED NULL AFTER posted_at,
    ADD COLUMN unposted_at DATETIME     NULL AFTER unposted_by;

-- Settings
INSERT INTO settings (setting_key, setting_value) VALUES ('late_grace_minutes', '10')
    ON DUPLICATE KEY UPDATE setting_key = setting_key;
UPDATE settings SET setting_value = '120' WHERE setting_key = 'scan_repeat_seconds' AND setting_value = '60';

-- Data Entry: setup, attendance and vouchers; no posting / unposting, no increments (admin only), no users.
INSERT INTO roles (name, description, is_admin)
SELECT 'Data Entry', 'Setup, attendance and vouchers; no posting / unposting', 0 FROM DUAL
 WHERE NOT EXISTS (SELECT 1 FROM roles WHERE name = 'Data Entry');
INSERT IGNORE INTO permissions (role_id, module, action)
SELECT r.id, m.module, a.action FROM roles r
  JOIN (SELECT 'employees' module UNION ALL SELECT 'departments' UNION ALL SELECT 'designations' UNION ALL SELECT 'shifts'
        UNION ALL SELECT 'shift_groups' UNION ALL SELECT 'holidays' UNION ALL SELECT 'attendance' UNION ALL SELECT 'vouchers'
        UNION ALL SELECT 'loans' UNION ALL SELECT 'journal') m
  JOIN (SELECT 'view' action UNION ALL SELECT 'add' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete' UNION ALL SELECT 'print') a
 WHERE r.name = 'Data Entry';
INSERT IGNORE INTO permissions (role_id, module, action)
SELECT r.id, x.module, x.action FROM roles r
  JOIN (SELECT 'overtime' module, 'view' action UNION ALL SELECT 'overtime', 'print'
        UNION ALL SELECT 'leave', 'view' UNION ALL SELECT 'leave', 'add' UNION ALL SELECT 'leave', 'edit' UNION ALL SELECT 'leave', 'delete'
        UNION ALL SELECT 'leave', 'print' UNION ALL SELECT 'attendance_post', 'view' UNION ALL SELECT 'devices', 'view'
        UNION ALL SELECT 'salary', 'view' UNION ALL SELECT 'salary', 'add' UNION ALL SELECT 'salary', 'print'
        UNION ALL SELECT 'dashboard', 'view' UNION ALL SELECT 'reports', 'view' UNION ALL SELECT 'reports', 'print') x
 WHERE r.name = 'Data Entry';

-- Overtime: manual entries are flagged; their entered minutes are the approval ceiling (approval only lowers).
ALTER TABLE overtime ADD COLUMN is_manual TINYINT(1) NOT NULL DEFAULT 0 AFTER computed_minutes;
UPDATE overtime SET is_manual = 1, computed_minutes = approved_minutes WHERE computed_minutes = 0 AND approved_minutes > 0;
