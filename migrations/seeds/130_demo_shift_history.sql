-- Demo data: initial shift-group history for the demo employees (migration 013 runs before the demo seed).
INSERT INTO employee_shift_history (employee_id, shift_group_id, shift_date, changed_by, changed_at)
SELECT e.id, e.shift_group_id, COALESCE(e.shift_date, e.joining_date), e.created_by, e.created_at
  FROM employees e
 WHERE e.shift_group_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM employee_shift_history h WHERE h.employee_id = e.id);
