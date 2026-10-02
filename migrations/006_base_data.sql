-- 006: base data required by the application (roles, permissions, admin user, settings,
--      leave types, chart of accounts, statutory rates, tax slabs)
-- Setting values are JSON encoded.

INSERT INTO roles (id, name, description, is_admin) VALUES
 (1, 'Admin',               'Full access to everything',                         1),
 (2, 'HR',                  'Employees, setup, leave',                           0),
 (3, 'Attendance Operator', 'Attendance entry, posting, devices',                0),
 (4, 'Accountant',          'Vouchers, loans, journal, salary',                  0),
 (5, 'Viewer',              'Read-only access and printing',                     0);

-- Default admin. Username: admin  Password: admin123  (forced change on first login)
INSERT INTO users (id, username, full_name, password_hash, role_id, must_change_password) VALUES
 (1, 'admin', 'System Administrator', '$2y$10$mOw6z3LARRmwayVHMSjnE.GwQlRPuj0a40h3QtGnL/vUQA/6oyQK6', 1, 1);

-- HR
INSERT INTO permissions (role_id, module, action)
SELECT 2, m.module, a.action FROM
 (SELECT 'employees' module UNION ALL SELECT 'departments' UNION ALL SELECT 'designations'
  UNION ALL SELECT 'shifts' UNION ALL SELECT 'shift_groups' UNION ALL SELECT 'holidays' UNION ALL SELECT 'leave') m
 CROSS JOIN (SELECT 'view' action UNION ALL SELECT 'add' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete' UNION ALL SELECT 'print') a;
INSERT INTO permissions (role_id, module, action) VALUES (2,'leave','post');
INSERT INTO permissions (role_id, module, action)
SELECT 2, m.module, a.action FROM
 (SELECT 'dashboard' module UNION ALL SELECT 'attendance' UNION ALL SELECT 'overtime' UNION ALL SELECT 'salary' UNION ALL SELECT 'reports') m
 CROSS JOIN (SELECT 'view' action UNION ALL SELECT 'print') a;

-- Attendance Operator
INSERT INTO permissions (role_id, module, action)
SELECT 3, 'attendance', a.action FROM
 (SELECT 'view' action UNION ALL SELECT 'add' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete' UNION ALL SELECT 'print') a;
INSERT INTO permissions (role_id, module, action) VALUES
 (3,'attendance_post','view'), (3,'attendance_post','post'),
 (3,'overtime','view'), (3,'overtime','add'), (3,'overtime','edit'), (3,'overtime','print'),
 (3,'leave','view'), (3,'leave','add'), (3,'leave','print'),
 (3,'devices','view'),
 (3,'employees','view'), (3,'employees','print'),
 (3,'dashboard','view'), (3,'reports','view'), (3,'reports','print');

-- Accountant
INSERT INTO permissions (role_id, module, action)
SELECT 4, m.module, a.action FROM
 (SELECT 'vouchers' module UNION ALL SELECT 'loans' UNION ALL SELECT 'journal' UNION ALL SELECT 'salary') m
 CROSS JOIN (SELECT 'view' action UNION ALL SELECT 'add' UNION ALL SELECT 'edit' UNION ALL SELECT 'delete'
             UNION ALL SELECT 'post' UNION ALL SELECT 'print') a;
INSERT INTO permissions (role_id, module, action) VALUES
 (4,'employees','view'), (4,'attendance','view'), (4,'overtime','view'),
 (4,'dashboard','view'), (4,'reports','view'), (4,'reports','print');

-- Viewer
INSERT INTO permissions (role_id, module, action)
SELECT 5, m.module, a.action FROM
 (SELECT 'dashboard' module UNION ALL SELECT 'employees' UNION ALL SELECT 'departments' UNION ALL SELECT 'designations'
  UNION ALL SELECT 'shifts' UNION ALL SELECT 'shift_groups' UNION ALL SELECT 'holidays' UNION ALL SELECT 'attendance'
  UNION ALL SELECT 'overtime' UNION ALL SELECT 'leave' UNION ALL SELECT 'vouchers' UNION ALL SELECT 'loans'
  UNION ALL SELECT 'journal' UNION ALL SELECT 'salary' UNION ALL SELECT 'reports') m
 CROSS JOIN (SELECT 'view' action UNION ALL SELECT 'print') a;

INSERT INTO settings (setting_key, setting_value) VALUES
 ('company_name',          '"Your Company (Pvt) Ltd"'),
 ('company_name_ur',       '""'),
 ('company_address',       '""'),
 ('company_address_ur',    '""'),
 ('company_phone',         '""'),
 ('company_email',         '""'),
 ('company_ntn',           '""'),
 ('company_logo',          'null'),
 ('salary_day_basis',      '"calendar"'),      -- calendar = actual days in month; fixed30; fixed26
 ('rounding_rule',         '"half_up"'),       -- half_up | up | down
 ('ot_multiplier',         '2'),               -- OT rate = basic / days / shift hours x multiplier
 ('default_shift_hours',   '8'),
 ('weekly_rest_days',      '[0]'),             -- 0 = Sunday ... 6 = Saturday
 ('social_security',       '"PESSI"'),         -- PESSI (Punjab) or SESSI (Sindh)
 ('max_daily_hours',       '16'),              -- attendance outlier flag threshold (hard cap 24)
 ('id_card_valid_months',  '12'),
 ('id_card_back_note',     '"This card is the property of the company. If found, please return to the address above."');

INSERT INTO leave_types (code, name, name_ur, yearly_quota, is_paid) VALUES
 ('CL',  'Casual Leave',      'اتفاقیہ رخصت',   10, 1),
 ('SL',  'Sick Leave',        'بیماری کی رخصت', 8,  1),
 ('AL',  'Annual Leave',      'سالانہ رخصت',    14, 1),
 ('LWP', 'Leave Without Pay', 'بلا تنخواہ رخصت', 0, 0);

INSERT INTO accounts (code, name, account_type, system_key) VALUES
 ('1001', 'Cash in Hand',                  'asset',     'cash'),
 ('1002', 'Bank',                          'asset',     'bank'),
 ('1101', 'Employee Advances',             'asset',     'employee_advances'),
 ('1102', 'Employee Loans',                'asset',     'employee_loans'),
 ('2001', 'Salaries Payable',              'liability', 'salary_payable'),
 ('2002', 'EOBI Payable',                  'liability', 'eobi_payable'),
 ('2003', 'Social Security Payable',       'liability', 'pessi_payable'),
 ('2004', 'Income Tax Payable',            'liability', 'tax_payable'),
 ('4001', 'Fines & Penalties Recovered',   'income',    'penalty_income'),
 ('5001', 'Salaries & Wages Expense',      'expense',   'salary_expense'),
 ('5002', 'Overtime Expense',              'expense',   'overtime_expense'),
 ('5003', 'Incentive Expense',             'expense',   'incentive_expense');

-- Sample statutory rates (VERIFY against current notifications before use; editable by Admin)
INSERT INTO statutory_rates (code, effective_from, calc_method, employee_share, employer_share, min_wage, wage_ceiling, remarks) VALUES
 ('EOBI',  '2025-07-01', 'percent_of_min_wage', 1.0000, 5.0000, 40000.00, NULL, 'Employee 1% / employer 5% of minimum wage (sample)'),
 ('PESSI', '2025-07-01', 'percent_of_wage',     0.0000, 6.0000, NULL, 40000.00, 'Employer 6% of wages up to ceiling (sample)'),
 ('SESSI', '2025-07-01', 'percent_of_wage',     0.0000, 6.0000, NULL, 40000.00, 'Employer 6% of wages up to ceiling (sample)');

-- Sample salaried tax slabs tax year 2025-26 (VERIFY with FBR before use; editable by Admin)
INSERT INTO tax_slabs (effective_from, tax_year, income_from, income_to, fixed_amount, rate_percent) VALUES
 ('2025-07-01', '2025-26',       0.00,  600000.00,      0.00,  0.000),
 ('2025-07-01', '2025-26',  600000.00, 1200000.00,      0.00,  1.000),
 ('2025-07-01', '2025-26', 1200000.00, 2200000.00,   6000.00, 11.000),
 ('2025-07-01', '2025-26', 2200000.00, 3200000.00, 116000.00, 23.000),
 ('2025-07-01', '2025-26', 3200000.00, 4100000.00, 346000.00, 30.000),
 ('2025-07-01', '2025-26', 4100000.00,       NULL, 616000.00, 35.000);
