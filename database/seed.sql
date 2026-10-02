-- =====================================================================
--  Seed data — run once after schema.sql
--  No user is seeded: the first Admin is created from the app's
--  one-time Setup screen (only available while the users table is empty).
-- =====================================================================

SET NAMES utf8mb4;

-- ---------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------
INSERT INTO roles (code, name, name_ur, description, is_system) VALUES
('admin',        'Admin',        'ایڈمن',          'Full access to everything',                       1),
('store_keeper', 'Store Keeper', 'اسٹور کیپر',     'Stores: inward, transfers, consumption, stock',   1),
('production',   'Production',   'پروڈکشن',        'Designs, estimation, production, ink loading',    1),
('gate',         'Gate',         'گیٹ',            'Inward and outward gate passes',                  1),
('accounts',     'Accounts',     'اکاؤنٹس',        'View all, costing and reports',                   1)
ON DUPLICATE KEY UPDATE name = VALUES(name), name_ur = VALUES(name_ur), description = VALUES(description);

-- ---------------------------------------------------------------------
-- Permissions  (code = module.action)
-- ---------------------------------------------------------------------
INSERT INTO permissions (code, module, action, description, sort_order) VALUES
('dashboard.view',          'dashboard',         'view',   'View dashboard',                         10),

('users.view',              'users',             'view',   'View users',                             20),
('users.manage',            'users',             'manage', 'Create / edit / delete users',           21),
('roles.manage',            'roles',             'manage', 'Edit role permissions',                  22),
('audit.view',              'audit',             'view',   'View audit log',                         23),
('settings.manage',         'settings',          'manage', 'Edit system settings',                   24),

('parties.view',            'parties',           'view',   'View parties',                           30),
('parties.manage',          'parties',           'manage', 'Manage parties',                         31),
('warehouses.view',         'warehouses',        'view',   'View warehouses',                        32),
('warehouses.manage',       'warehouses',        'manage', 'Manage warehouses',                      33),
('units.view',              'units',             'view',   'View units',                             34),
('units.manage',            'units',             'manage', 'Manage units',                           35),
('items.view',              'items',             'view',   'View items',                             36),
('items.manage',            'items',             'manage', 'Manage items',                           37),
('machines.view',           'machines',          'view',   'View machines',                          38),
('machines.manage',         'machines',          'manage', 'Manage machines',                        39),
('designs.view',            'designs',           'view',   'View design library',                    40),
('designs.manage',          'designs',           'manage', 'Manage designs, ink & BOM',              41),
('inks.view',               'inks',              'view',   'View ink master',                        42),
('inks.manage',             'inks',              'manage', 'Manage ink master & colours',            43),

('igp.view',                'igp',               'view',   'View inward gate passes',                50),
('igp.create',              'igp',               'create', 'Create inward gate pass',                51),
('igp.edit',                'igp',               'edit',   'Edit inward gate pass',                  52),
('igp.cancel',              'igp',               'cancel', 'Cancel inward gate pass',                53),
('transfer.view',           'transfer',          'view',   'View stock transfers',                   54),
('transfer.create',         'transfer',          'create', 'Create stock transfer',                  55),
('transfer.edit',           'transfer',          'edit',   'Edit stock transfer',                    56),
('transfer.cancel',         'transfer',          'cancel', 'Cancel stock transfer',                  57),
('consumption.view',        'consumption',       'view',   'View stock consumption',                 58),
('consumption.create',      'consumption',       'create', 'Create stock consumption',               59),
('consumption.edit',        'consumption',       'edit',   'Edit stock consumption',                 60),
('consumption.cancel',      'consumption',       'cancel', 'Cancel stock consumption',               61),
('ink_load.view',           'ink_load',          'view',   'View ink loading log',                   62),
('ink_load.create',         'ink_load',          'create', 'Create ink loading entry',               63),
('ink_load.edit',           'ink_load',          'edit',   'Edit ink loading entry',                 64),
('ink_load.cancel',         'ink_load',          'cancel', 'Cancel ink loading entry',               65),
('estimation.view',         'estimation',        'view',   'View production estimations',            66),
('estimation.create',       'estimation',        'create', 'Create production estimation',           67),
('estimation.edit',         'estimation',        'edit',   'Edit production estimation',             68),
('estimation.cancel',       'estimation',        'cancel', 'Cancel production estimation',           69),
('bom_production.view',     'bom_production',    'view',   'View BOM production',                    70),
('bom_production.create',   'bom_production',    'create', 'Create BOM production',                  71),
('bom_production.edit',     'bom_production',    'edit',   'Edit BOM production',                    72),
('bom_production.cancel',   'bom_production',    'cancel', 'Cancel BOM production',                  73),
('manual_production.view',  'manual_production', 'view',   'View manual production',                 74),
('manual_production.create','manual_production', 'create', 'Create manual production',               75),
('manual_production.edit',  'manual_production', 'edit',   'Edit manual production',                 76),
('manual_production.cancel','manual_production', 'cancel', 'Cancel manual production',               77),
('chalan.view',             'chalan',            'view',   'View delivery chalans',                  78),
('chalan.create',           'chalan',            'create', 'Create delivery chalan',                 79),
('chalan.edit',             'chalan',            'edit',   'Edit delivery chalan',                   80),
('chalan.cancel',           'chalan',            'cancel', 'Cancel delivery chalan',                 81),

('reports.inward',          'reports',           'inward',      'Inward gate pass report',           90),
('reports.transfer',        'reports',           'transfer',    'Stock transfer report',             91),
('reports.consumption',     'reports',           'consumption', 'Stock consumption report',          92),
('reports.production',      'reports',           'production',  'Production reports',                93),
('reports.delivery',        'reports',           'delivery',    'Delivery chalan report',            94),
('reports.ink',             'reports',           'ink',         'Ink reports',                       95),
('reports.stock',           'reports',           'stock',       'Stock ledger & current stock',      96),
('reports.jobwork',         'reports',           'jobwork',     'Party-wise job-work balance',       97),
('reports.export',          'reports',           'export',      'Export reports (PDF / Excel)',      98)
ON DUPLICATE KEY UPDATE module = VALUES(module), action = VALUES(action),
                        description = VALUES(description), sort_order = VALUES(sort_order);

-- ---------------------------------------------------------------------
-- Role → permission matrix
-- (Admin is also granted everything in code, this keeps the matrix honest.)
-- ---------------------------------------------------------------------
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p WHERE r.code = 'admin';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view',
    'parties.view','parties.manage','warehouses.view','warehouses.manage','units.view','units.manage',
    'items.view','items.manage','machines.view','designs.view','inks.view',
    'igp.view','igp.create','igp.edit','igp.cancel',
    'transfer.view','transfer.create','transfer.edit','transfer.cancel',
    'consumption.view','consumption.create','consumption.edit','consumption.cancel',
    'ink_load.view','ink_load.create','ink_load.edit',
    'chalan.view','chalan.create','chalan.edit',
    'reports.inward','reports.transfer','reports.consumption','reports.delivery',
    'reports.ink','reports.stock','reports.jobwork','reports.export'
) WHERE r.code = 'store_keeper';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view',
    'parties.view','warehouses.view','units.view','items.view',
    'machines.view','machines.manage','designs.view','designs.manage','inks.view','inks.manage',
    'transfer.view','transfer.create',
    'consumption.view','consumption.create','consumption.edit',
    'ink_load.view','ink_load.create','ink_load.edit','ink_load.cancel',
    'estimation.view','estimation.create','estimation.edit','estimation.cancel',
    'bom_production.view','bom_production.create','bom_production.edit','bom_production.cancel',
    'manual_production.view','manual_production.create','manual_production.edit','manual_production.cancel',
    'chalan.view',
    'reports.consumption','reports.production','reports.ink','reports.stock','reports.export'
) WHERE r.code = 'production';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p ON p.code IN (
    'dashboard.view',
    'parties.view','warehouses.view','units.view','items.view','designs.view',
    'igp.view','igp.create','igp.edit',
    'chalan.view','chalan.create','chalan.edit',
    'reports.inward','reports.delivery'
) WHERE r.code = 'gate';

INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r JOIN permissions p
    ON (p.action = 'view' AND p.module NOT IN ('users'))
    OR p.module = 'reports'
    OR p.code IN ('estimation.create','estimation.edit','audit.view')
WHERE r.code = 'accounts';

-- ---------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------
INSERT INTO units (code, name, name_ur, dimension, to_base, decimals) VALUES
('m',     'Meter', 'میٹر',   'length', 1.00000000, 2),
('yd',    'Yard',  'گز',     'length', 0.91440000, 2),
('kg',    'Kilogram', 'کلو', 'mass',   1.00000000, 3),
('roll',  'Roll',  'رول',    'count',  1.00000000, 0),
('l',     'Liter', 'لیٹر',   'volume', 1.00000000, 3),
('ml',    'Milliliter', 'ملی لیٹر', 'volume', 0.00100000, 0)
ON DUPLICATE KEY UPDATE name = VALUES(name), name_ur = VALUES(name_ur);

-- ---------------------------------------------------------------------
-- Warehouses
-- ---------------------------------------------------------------------
INSERT INTO warehouses (code, name, name_ur, warehouse_type) VALUES
('GREY',  'Grey Store',      'گرے اسٹور',      'grey'),
('FLOOR', 'Printing Floor',  'پرنٹنگ فلور',    'floor'),
('FIN',   'Finished Store',  'تیار مال اسٹور', 'finished')
ON DUPLICATE KEY UPDATE name = VALUES(name), name_ur = VALUES(name_ur);

-- ---------------------------------------------------------------------
-- Ink colours (CMYK process + common specials)
-- ---------------------------------------------------------------------
INSERT INTO ink_colours (code, name, name_ur, hex, is_process, sort_order) VALUES
('C',  'Cyan',              'سیان',         '#00AEEF', 1, 1),
('M',  'Magenta',           'میجنٹا',       '#EC008C', 1, 2),
('Y',  'Yellow',            'پیلا',         '#FFF200', 1, 3),
('K',  'Black',             'کالا',         '#000000', 1, 4),
('LC', 'Light Cyan',        'ہلکا سیان',    '#7FD6F7', 0, 5),
('LM', 'Light Magenta',     'ہلکا میجنٹا',  '#F57FC5', 0, 6),
('OR', 'Orange',            'نارنجی',       '#F7941D', 0, 7),
('RD', 'Red',               'سرخ',          '#ED1C24', 0, 8),
('BL', 'Blue',              'نیلا',         '#2E3192', 0, 9),
('GY', 'Grey',              'سرمئی',        '#808285', 0, 10),
('FY', 'Fluorescent Yellow','فلورسنٹ پیلا', '#E6FF00', 0, 11),
('FP', 'Fluorescent Pink',  'فلورسنٹ گلابی','#FF4FA3', 0, 12)
ON DUPLICATE KEY UPDATE name = VALUES(name), name_ur = VALUES(name_ur), hex = VALUES(hex);

-- ---------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------
INSERT INTO settings (setting_key, setting_value, description) VALUES
('company_name',         'Digital Fabric Printing', 'Printed on vouchers and reports'),
('company_name_ur',      'ڈیجیٹل فیبرک پرنٹنگ',    'Urdu company name'),
('company_address',      '',                        'Address on vouchers'),
('company_phone',        '',                        'Phone on vouchers'),
('company_ntn',          '',                        'NTN on vouchers'),
('whatsapp_support',     '',                        'Support WhatsApp number in international format, e.g. 923001234567'),
('ink_ml_per_sqm_full',  '12',                      'ml of ONE colour per square meter at 100% coverage on reference GSM fabric'),
('ink_reference_gsm',    '100',                     'Fabric GSM the ink ml/sqm figure refers to'),
('default_wastage_pct',  '3',                       'Default wastage % used in estimation'),
('fiscal_year_start_month', '7',                    'Fiscal year start month (Pakistan = 7, July)')
ON DUPLICATE KEY UPDATE description = VALUES(description);
