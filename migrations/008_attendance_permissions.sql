-- 008: batch 2 permission defaults (editable later in Roles & Permissions)
-- HR acts as the overtime approver (supervisor) by default.
INSERT IGNORE INTO permissions (role_id, module, action)
SELECT r.id, x.module, x.action FROM roles r
JOIN (SELECT 'overtime' module, 'edit' action UNION ALL SELECT 'overtime', 'post'
      UNION ALL SELECT 'devices', 'view' UNION ALL SELECT 'attendance', 'view' UNION ALL SELECT 'attendance', 'print') x
WHERE r.name = 'HR';
