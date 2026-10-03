-- 012: salary increment module
-- salary_increments is the single source of the pay rate over time:
--   permanent / contract  -> monthly basic salary
--   daily wages           -> rate per day
-- Payroll reads it through App\Increments::getSalaryOnDate(). employee_salary_history keeps the other
-- salary terms (allowances, OT applicability / fixed OT rate, EOBI / PESSI / tax flags, payment mode, bank).
-- Its basic_salary / daily_rate columns are no longer read by payroll.

CREATE TABLE salary_increments (
    id              INT UNSIGNED  NOT NULL AUTO_INCREMENT,
    employee_id     INT UNSIGNED  NOT NULL,
    increment_type  ENUM('joining','percentage','fixed','new_salary') NOT NULL,
    increment_value DECIMAL(12,2) NOT NULL,          -- percent, rupees added, or the new salary itself
    old_salary      DECIMAL(12,2) NOT NULL,          -- salary effective the day before effective_date
    new_salary      DECIMAL(12,2) NOT NULL,          -- whole rupees (migrated history rows keep their stored value)
    effective_date  DATE          NOT NULL,
    reason          VARCHAR(255)  NULL,
    approved_by     INT UNSIGNED  NULL,
    created_by      INT UNSIGNED  NOT NULL,
    created_at      DATETIME      DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_emp_date (employee_id, effective_date),
    INDEX idx_emp_date (employee_id, effective_date),
    KEY idx_si_date (effective_date),
    CONSTRAINT fk_si_emp FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_si_ab  FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_si_cb  FOREIGN KEY (created_by)  REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill from the existing effective-dated salary history so old months keep their old salary:
--   the first record becomes the 'joining' row (dated on the joining date);
--   every later record whose rate changed becomes a 'new_salary' increment.
INSERT INTO salary_increments (employee_id, increment_type, increment_value, old_salary, new_salary, effective_date, reason, created_by, created_at)
SELECT x.employee_id,
       IF(x.rn = 1, 'joining', 'new_salary'),
       x.amount,
       IF(x.rn = 1, 0, x.prev_amount),
       x.amount,
       IF(x.rn = 1, x.joining_date, x.effective_from),
       IF(x.rn = 1, 'Joining salary (migrated from salary history)',
          LEFT(CONCAT('Migrated from salary history', IF(x.reason IS NULL OR x.reason = '', '', CONCAT(': ', x.reason))), 255)),
       COALESCE(x.created_by, x.emp_created_by, (SELECT MIN(u.id) FROM users u)),
       COALESCE(x.created_at, NOW())
  FROM (
        SELECT h.employee_id, h.effective_from, h.reason, h.created_by, h.created_at,
               e.joining_date, e.created_by AS emp_created_by,
               IF(e.emp_type = 'daily_wages', h.daily_rate, h.basic_salary) AS amount,
               ROW_NUMBER() OVER (PARTITION BY h.employee_id ORDER BY h.effective_from) AS rn,
               LAG(IF(e.emp_type = 'daily_wages', h.daily_rate, h.basic_salary))
                   OVER (PARTITION BY h.employee_id ORDER BY h.effective_from) AS prev_amount
          FROM employee_salary_history h
          JOIN employees e ON e.id = h.employee_id
       ) x
 WHERE x.rn = 1 OR x.amount <> x.prev_amount;

-- Employees without any salary record still get their joining row (salary 0, set it with a 'new salary' increment).
INSERT INTO salary_increments (employee_id, increment_type, increment_value, old_salary, new_salary, effective_date, reason, created_by)
SELECT e.id, 'joining', 0, 0, 0, e.joining_date, 'Joining (no salary record at migration)',
       COALESCE(e.created_by, (SELECT MIN(u.id) FROM users u))
  FROM employees e
 WHERE NOT EXISTS (SELECT 1 FROM salary_increments i WHERE i.employee_id = e.id);

-- Current rate cache (salary effective today). Kept in sync by App\Increments::syncBasicSalaries()
-- after every increment write and once a day (first request of the day, or the optional hPanel cron).
ALTER TABLE employees
    ADD COLUMN basic_salary DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER emp_type;

UPDATE employees e
   SET e.basic_salary = COALESCE((SELECT i.new_salary FROM salary_increments i
                                   WHERE i.employee_id = e.id AND i.effective_date <= CURDATE()
                                   ORDER BY i.effective_date DESC, i.id DESC LIMIT 1), 0);

INSERT INTO settings (setting_key, setting_value) VALUES ('salary_synced_on', CONCAT('"', CURDATE(), '"'))
    ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);

-- Salary sheet rows remember the mid-period increment split (shown as a marker / tooltip).
ALTER TABLE salary_sheet_lines
    ADD COLUMN increment_note VARCHAR(255) NULL AFTER warnings;
