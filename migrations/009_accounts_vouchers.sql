-- 009: accounts vouchers (batch 3)
--  * pay_account_id: cash / bank account an Advance or Loan is paid from (credit side of its journal)
--  * fixed_amount for OT vouchers is `amount`; ot_hours are paid at the employee's OT rate in payroll
ALTER TABLE vouchers
    ADD COLUMN pay_account_id INT UNSIGNED NULL AFTER amount,
    ADD KEY idx_vr_status (status, voucher_type, vr_date),
    ADD CONSTRAINT fk_vr_acc FOREIGN KEY (pay_account_id) REFERENCES accounts(id);

-- Installment rows remember the planned amount separately from what payroll actually deducted.
ALTER TABLE loan_installments
    ADD KEY idx_li_loan_status (loan_id, status);

-- Accountant also maintains the chart of accounts (journal module) - already granted;
-- HR may view advances / loans of employees.
INSERT IGNORE INTO permissions (role_id, module, action)
SELECT r.id, x.module, x.action FROM roles r
JOIN (SELECT 'vouchers' module, 'view' action UNION ALL SELECT 'loans', 'view' UNION ALL SELECT 'vouchers', 'print'
      UNION ALL SELECT 'loans', 'print') x
WHERE r.name = 'HR';
