-- Demo accounts vouchers (batch 3): advances, incentives, penalty, OT voucher, two loans, one JV.
-- Applied with: php migrations/migrate.php --seed

INSERT INTO vouchers (voucher_type, vr_no, vr_date, employee_id, amount, pay_account_id, ot_hours, deduct_month, remarks, status, posted_by, posted_at, created_by) VALUES
 ('ADV', 1, '2026-09-10', 3,  5000, (SELECT id FROM accounts WHERE system_key = 'cash'), NULL, '2026-09-01', 'Medical emergency',     'posted', 1, '2026-09-10 11:00:00', 1),
 ('ADV', 2, '2026-09-18', 9,  3000, (SELECT id FROM accounts WHERE system_key = 'cash'), NULL, '2026-09-01', 'School fee',            'posted', 1, '2026-09-18 12:30:00', 1),
 ('ADV', 3, '2026-10-01', 13, 4000, (SELECT id FROM accounts WHERE system_key = 'bank'), NULL, '2026-10-01', 'Advance against salary', 'draft',  NULL, NULL, 1),
 ('INC', 1, '2026-09-30', 5,  6774, NULL, NULL, '2026-09-01', 'Production target achieved', 'posted', 1, '2026-09-30 17:00:00', 1),
 ('INC', 2, '2026-09-30', 2,  3500, NULL, NULL, '2026-09-01', 'Best supervisor of the month', 'posted', 1, '2026-09-30 17:05:00', 1),
 ('PEN', 1, '2026-09-22', 6,  500,  NULL, NULL, '2026-09-01', 'Machine damage due to negligence', 'posted', 1, '2026-09-22 10:00:00', 1),
 ('OT',  1, '2026-09-28', 11, 0,    NULL, 6.00, '2026-09-01', 'Weekend stock taking (outside punch)', 'posted', 1, '2026-09-28 18:00:00', 1),
 ('LOAN', 1, '2026-08-25', 5,  12000, (SELECT id FROM accounts WHERE system_key = 'cash'), NULL, '2026-09-01', 'House repair loan', 'posted', 1, '2026-08-25 15:00:00', 1),
 ('LOAN', 2, '2026-09-15', 8,  25000, (SELECT id FROM accounts WHERE system_key = 'bank'), NULL, '2026-10-01', 'Marriage loan',     'posted', 1, '2026-09-15 15:00:00', 1),
 ('JV',   1, '2026-09-30', NULL, 2500, NULL, NULL, NULL, 'Petty cash replenished from bank', 'posted', 1, '2026-09-30 18:00:00', 1);

INSERT INTO doc_sequences (doc_type, year, last_no) VALUES ('VR-ADV', 0, 3), ('VR-INC', 0, 2), ('VR-PEN', 0, 1), ('VR-OT', 0, 1), ('VR-LOAN', 0, 2), ('VR-JV', 0, 1);

INSERT INTO loans (voucher_id, employee_id, amount, installment, start_month, status, remarks, created_by)
SELECT id, employee_id, amount, CASE vr_no WHEN 1 THEN 2000 ELSE 4000 END, deduct_month, 'active', remarks, 1
  FROM vouchers WHERE voucher_type = 'LOAN';

-- Schedules: loan 1 (12,000 @ 2,000 from Sep 2026), loan 2 (25,000 @ 4,000 from Oct 2026, last 1,000)
INSERT INTO loan_installments (loan_id, due_month, scheduled_amount, status, created_by)
SELECT l.id, m.due_month, m.amt, 'scheduled', 1 FROM loans l JOIN vouchers v ON v.id = l.voucher_id
  JOIN (SELECT 1 n, '2026-09-01' due_month, 2000 amt UNION ALL SELECT 1, '2026-10-01', 2000 UNION ALL SELECT 1, '2026-11-01', 2000
        UNION ALL SELECT 1, '2026-12-01', 2000 UNION ALL SELECT 1, '2027-01-01', 2000 UNION ALL SELECT 1, '2027-02-01', 2000
        UNION ALL SELECT 2, '2026-10-01', 4000 UNION ALL SELECT 2, '2026-11-01', 4000 UNION ALL SELECT 2, '2026-12-01', 4000
        UNION ALL SELECT 2, '2027-01-01', 4000 UNION ALL SELECT 2, '2027-02-01', 4000 UNION ALL SELECT 2, '2027-03-01', 4000
        UNION ALL SELECT 2, '2027-04-01', 1000) m ON m.n = v.vr_no
 WHERE v.voucher_type = 'LOAN';

-- Journal lines of posted advances and loans (Dr employee advances / loans, Cr paid-from account)
INSERT INTO journal_entries (voucher_id, line_no, account_id, employee_id, debit, credit, narration)
SELECT v.id, 1, (SELECT id FROM accounts WHERE system_key = IF(v.voucher_type = 'ADV', 'employee_advances', 'employee_loans')),
       v.employee_id, v.amount, 0, CONCAT(IF(v.voucher_type = 'ADV', 'Employee Advance', 'Loan'), ' - ', e.code, ' ', e.name)
  FROM vouchers v JOIN employees e ON e.id = v.employee_id WHERE v.voucher_type IN ('ADV', 'LOAN') AND v.status = 'posted';
INSERT INTO journal_entries (voucher_id, line_no, account_id, employee_id, debit, credit, narration)
SELECT v.id, 2, v.pay_account_id, NULL, 0, v.amount, CONCAT(IF(v.voucher_type = 'ADV', 'Employee Advance', 'Loan'), ' - ', e.code, ' ', e.name)
  FROM vouchers v JOIN employees e ON e.id = v.employee_id WHERE v.voucher_type IN ('ADV', 'LOAN') AND v.status = 'posted';
INSERT INTO journal_entries (voucher_id, line_no, account_id, employee_id, debit, credit, narration)
SELECT v.id, 1, (SELECT id FROM accounts WHERE system_key = 'cash'), NULL, 2500, 0, 'Petty cash' FROM vouchers v WHERE v.voucher_type = 'JV' AND v.vr_no = 1;
INSERT INTO journal_entries (voucher_id, line_no, account_id, employee_id, debit, credit, narration)
SELECT v.id, 2, (SELECT id FROM accounts WHERE system_key = 'bank'), NULL, 0, 2500, 'Cheque #004512' FROM vouchers v WHERE v.voucher_type = 'JV' AND v.vr_no = 1;
