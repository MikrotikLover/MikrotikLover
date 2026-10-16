-- MikrotikLover business rules, used by FreeRADIUS (policy mikrotiklover_limits) and the dashboard.
-- ml_check(user) -> 'reject:<reason>'  or  'ok:<seconds_left>:<bytes_left_low32>:<bytes_left_gigawords>:<quota_applies>'
--   seconds_left 0 = no time limit. Bytes are split for Mikrotik-Total-Limit / -Gigawords.
DELIMITER //
CREATE OR REPLACE FUNCTION ml_check(u VARCHAR(64)) RETURNS VARCHAR(100)
    READS SQL DATA
BEGIN
    DECLARE found INT DEFAULT 1;
    DECLARE v_exp, v_since DATETIME;
    DECLARE v_quota, v_used, v_left BIGINT DEFAULT 0;
    DECLARE v_period VARCHAR(10);
    DECLARE v_daily, v_valid, v_today BIGINT DEFAULT 0;
    DECLARE v_secs BIGINT DEFAULT 0;
    DECLARE v_start DATETIME;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET found = 0;

    SELECT a.expires_at, COALESCE(a.quota_since, '1970-01-01'), COALESCE(a.quota_bytes, p.quota_bytes, 0),
           COALESCE(p.quota_period, 'total'), COALESCE(p.daily_seconds, 0),
           IF(a.first_login IS NULL, COALESCE(p.validity_seconds, 0), 0)
      INTO v_exp, v_since, v_quota, v_period, v_daily, v_valid
      FROM ml_account a LEFT JOIN ml_plan p ON p.name = a.plan
     WHERE a.username = u;
    IF found = 0 THEN
        RETURN 'ok:0:0:0:0';
    END IF;

    -- expiry (fixed date, or validity counted from the first login)
    IF v_exp IS NOT NULL THEN
        IF v_exp <= NOW() THEN RETURN 'reject:Your package has expired'; END IF;
        SET v_secs = TIMESTAMPDIFF(SECOND, NOW(), v_exp);
    ELSEIF v_valid > 0 THEN
        SET v_secs = v_valid;
    END IF;

    -- data quota
    IF v_quota > 0 THEN
        SET v_start = GREATEST(v_since, CASE v_period WHEN 'daily' THEN CURDATE()
                                                      WHEN 'monthly' THEN DATE_FORMAT(NOW(), '%Y-%m-01')
                                                      ELSE '1970-01-01' END);
        SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0) INTO v_used
          FROM radacct WHERE username = u AND acctstarttime >= v_start;
        IF v_used >= v_quota THEN RETURN 'reject:Your data quota is used up'; END IF;
        SET v_left = v_quota - v_used;
    END IF;

    -- online time per day
    IF v_daily > 0 THEN
        SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, GREATEST(acctstarttime, CURDATE()), COALESCE(acctstoptime, NOW()))), 0)
          INTO v_today
          FROM radacct WHERE username = u AND (acctstoptime IS NULL OR acctstoptime >= CURDATE());
        IF v_today >= v_daily THEN RETURN 'reject:Daily time limit reached'; END IF;
        SET v_secs = IF(v_secs = 0, v_daily - v_today, LEAST(v_secs, v_daily - v_today));
    END IF;

    RETURN CONCAT('ok:', v_secs, ':', v_left MOD 4294967296, ':', v_left DIV 4294967296, ':', IF(v_quota > 0, 1, 0));
END //

DELIMITER ;
