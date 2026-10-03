-- 011: security hardening (final review)
-- Attendance devices: the ADMS push protocol identifies a device only by its serial number, which is
-- printed on the device and travels over plain HTTP. allowed_ips restricts which addresses may push
-- for that serial (the factory's internet IP); last_ip shows where it was last seen from.
ALTER TABLE devices
    ADD COLUMN allowed_ips VARCHAR(255) NULL AFTER location,
    ADD COLUMN last_ip     VARCHAR(45)  NULL AFTER last_seen_at;

-- Sessions end when the password changes (own change or admin reset).
ALTER TABLE users
    ADD COLUMN session_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER must_change_password;
