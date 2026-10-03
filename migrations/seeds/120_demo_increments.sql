-- Demo data: salary increments for the demo employees (same backfill as migration 012, which runs
-- before the demo seed on a fresh install). Only employees without increment rows are touched.

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
 WHERE (x.rn = 1 OR x.amount <> x.prev_amount)
   AND NOT EXISTS (SELECT 1 FROM salary_increments i WHERE i.employee_id = x.employee_id);

INSERT INTO salary_increments (employee_id, increment_type, increment_value, old_salary, new_salary, effective_date, reason, created_by)
SELECT e.id, 'joining', 0, 0, 0, e.joining_date, 'Joining (no salary record at migration)',
       COALESCE(e.created_by, (SELECT MIN(u.id) FROM users u))
  FROM employees e
 WHERE NOT EXISTS (SELECT 1 FROM salary_increments i WHERE i.employee_id = e.id);

UPDATE employees e
   SET e.basic_salary = COALESCE((SELECT i.new_salary FROM salary_increments i
                                   WHERE i.employee_id = e.id AND i.effective_date <= CURDATE()
                                   ORDER BY i.effective_date DESC, i.id DESC LIMIT 1), 0);
