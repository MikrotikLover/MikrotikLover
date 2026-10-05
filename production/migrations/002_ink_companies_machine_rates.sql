-- Ink is priced by the ink company (supplier); machines have their own running rate in Rs per metre.
--   ink_companies / ink_rates   Rs per litre of each company's ink, effective from a date
--   machine_inks                which company's ink a machine uses from a date
--   machine_rates               (re-created) machine rate in Rs per printed metre, effective from a date
-- An entry takes its ink company from its machine on the entry date unless one was picked by hand
-- (ink_company_manual = 1). ink_rate and machine_rate on the entry are kept in step by Pricing::recompute().

CREATE TABLE ink_companies (
    id         INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name       VARCHAR(80) NOT NULL,
    is_active  TINYINT(1)  NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ink_companies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ink_companies (name) VALUES ('Default ink');

CREATE TABLE ink_rates (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    ink_company_id INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    rate_per_litre DECIMAL(10,2) NOT NULL,
    note           VARCHAR(150) NOT NULL DEFAULT '',
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ink_rate (ink_company_id, effective_from),
    CONSTRAINT fk_ink_rate_company FOREIGN KEY (ink_company_id) REFERENCES ink_companies (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ink_rates (ink_company_id, effective_from, rate_per_litre, note)
    SELECT c.id, '2000-01-01', CAST(COALESCE((SELECT v FROM settings WHERE k = 'default_ink_rate'), '1450') AS DECIMAL(10,2)), 'Opening rate'
      FROM ink_companies c;

CREATE TABLE machine_inks (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    machine_id     INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    ink_company_id INT UNSIGNED NOT NULL,
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_machine_ink (machine_id, effective_from),
    CONSTRAINT fk_mi_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE,
    CONSTRAINT fk_mi_company FOREIGN KEY (ink_company_id) REFERENCES ink_companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO machine_inks (machine_id, effective_from, ink_company_id)
    SELECT m.id, '2000-01-01', c.id FROM machines m CROSS JOIN ink_companies c;

DROP TABLE machine_rates;

CREATE TABLE machine_rates (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    machine_id     INT UNSIGNED NOT NULL,
    effective_from DATE NOT NULL,
    rate_per_mtr   DECIMAL(10,3) NOT NULL,
    note           VARCHAR(150) NOT NULL DEFAULT '',
    created_by     INT UNSIGNED NULL,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_machine_rate (machine_id, effective_from),
    CONSTRAINT fk_rate_machine FOREIGN KEY (machine_id) REFERENCES machines (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE production_entries
    ADD COLUMN ink_company_id     INT UNSIGNED NULL AFTER ink_ml_per_mtr,
    ADD COLUMN ink_company_manual TINYINT(1) NOT NULL DEFAULT 0 AFTER ink_company_id,
    ADD COLUMN machine_rate       DECIMAL(10,3) NOT NULL DEFAULT 0 AFTER ink_cost,
    ADD COLUMN machine_cost       DECIMAL(16,2) AS (printed_mtr * machine_rate) STORED AFTER machine_rate,
    ADD KEY ix_pe_ink_company (ink_company_id),
    ADD CONSTRAINT fk_pe_ink_company FOREIGN KEY (ink_company_id) REFERENCES ink_companies (id);

UPDATE production_entries SET ink_company_id = (SELECT MIN(id) FROM ink_companies);

INSERT INTO settings (k, v) SELECT 'default_ink_company_id', CAST(MIN(id) AS CHAR) FROM ink_companies;
DELETE FROM settings WHERE k = 'default_ink_rate';
