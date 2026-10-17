-- literals in the functions use the same collation as the tables
SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;
-- MikrotikLover business rules, used by FreeRADIUS (policy mikrotiklover_limits), the enforcer
-- ("radius-admin enforce", every 5 minutes) and the dashboard.
--
-- ml_check(user) returns one of
--   'reject:<reason>'
--   'ok:<seconds_left>:<bytes_left_low32>:<bytes_left_gigawords>:<quota_applies>'
--   'fup:<seconds_left>:<rate>'      data quota used up, plan has a fair-usage speed: stay online, slower
-- seconds_left 0 = no time limit. Bytes are split for Mikrotik-Total-Limit / -Gigawords (hotspot).
-- Plans with a FUP speed never send Total-Limit (the user must not be cut off); the enforcer
-- lowers the speed of running sessions with RADIUS CoA instead.
DELIMITER //
CREATE OR REPLACE FUNCTION ml_check(u VARCHAR(64)) RETURNS VARCHAR(120)
    READS SQL DATA
BEGIN
    DECLARE found INT DEFAULT 1;
    DECLARE v_exp, v_since DATETIME;
    DECLARE v_quota, v_used, v_left BIGINT DEFAULT 0;
    DECLARE v_period VARCHAR(10);
    DECLARE v_fup VARCHAR(64) DEFAULT '';
    DECLARE v_daily, v_valid, v_today BIGINT DEFAULT 0;
    DECLARE v_secs BIGINT DEFAULT 0;
    DECLARE v_start DATETIME;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET found = 0;

    SELECT a.expires_at, COALESCE(a.quota_since, '1970-01-01'), COALESCE(a.quota_bytes, p.quota_bytes, 0),
           COALESCE(p.quota_period, 'total'), COALESCE(p.daily_seconds, 0),
           IF(a.first_login IS NULL, COALESCE(p.validity_seconds, 0), 0), COALESCE(p.fup_rate, '')
      INTO v_exp, v_since, v_quota, v_period, v_daily, v_valid, v_fup
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

    -- online time per day
    IF v_daily > 0 THEN
        SELECT COALESCE(SUM(TIMESTAMPDIFF(SECOND, GREATEST(acctstarttime, CURDATE()), COALESCE(acctstoptime, NOW()))), 0)
          INTO v_today
          FROM radacct WHERE username = u AND (acctstoptime IS NULL OR acctstoptime >= CURDATE());
        IF v_today >= v_daily THEN RETURN 'reject:Daily time limit reached'; END IF;
        SET v_secs = IF(v_secs = 0, v_daily - v_today, LEAST(v_secs, v_daily - v_today));
    END IF;

    -- data quota
    IF v_quota > 0 THEN
        SET v_start = GREATEST(v_since, CASE v_period WHEN 'daily' THEN CURDATE()
                                                      WHEN 'monthly' THEN DATE_FORMAT(NOW(), '%Y-%m-01')
                                                      ELSE '1970-01-01' END);
        SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0) INTO v_used
          FROM radacct WHERE username = u AND acctstarttime >= v_start;
        IF v_used >= v_quota THEN
            IF v_fup <> '' THEN RETURN CONCAT('fup:', v_secs, ':', v_fup); END IF;
            RETURN 'reject:Your data quota is used up';
        END IF;
        SET v_left = v_quota - v_used;
        IF v_fup <> '' THEN    -- no Total-Limit: the enforcer slows the session down when the quota runs out
            RETURN CONCAT('ok:', v_secs, ':0:0:0');
        END IF;
    END IF;

    RETURN CONCAT('ok:', v_secs, ':', v_left MOD 4294967296, ':', v_left DIV 4294967296, ':', IF(v_quota > 0, 1, 0));
END //
DELIMITER ;

-- Bandwidth scheduling: the scheduled speed for a user at a time ('' = no schedule then).
-- Most specific rule wins: user > plan > group > all; then the newest rule.
-- A window over midnight (22:00-06:00) belongs to the day it starts.
DELIMITER //
CREATE OR REPLACE FUNCTION ml_sched_rate(u VARCHAR(64), t DATETIME) RETURNS VARCHAR(64)
    READS SQL DATA
BEGIN
    DECLARE v_rate VARCHAR(64) DEFAULT '';
    DECLARE m INT DEFAULT HOUR(t) * 60 + MINUTE(t);
    DECLARE d_now VARCHAR(3) DEFAULT LOWER(LEFT(DAYNAME(t), 3));
    DECLARE d_prev VARCHAR(3) DEFAULT LOWER(LEFT(DAYNAME(t - INTERVAL 1 DAY), 3));
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_rate = '';
    SELECT s.rate INTO v_rate
      FROM ml_speed_schedule s
     WHERE s.enabled = 1
       AND (s.target_type = 'all'
            OR (s.target_type = 'user' AND s.target = u)
            OR (s.target_type = 'plan' AND s.target = (SELECT a.plan FROM ml_account a WHERE a.username = u))
            OR (s.target_type = 'group' AND s.target IN (SELECT g.groupname FROM radusergroup g WHERE g.username = u)))
       AND (   (s.start_min = s.end_min AND (s.days = 'all' OR FIND_IN_SET(d_now, s.days)))
            OR (s.start_min < s.end_min AND m >= s.start_min AND m < s.end_min AND (s.days = 'all' OR FIND_IN_SET(d_now, s.days)))
            OR (s.start_min > s.end_min AND m >= s.start_min AND (s.days = 'all' OR FIND_IN_SET(d_now, s.days)))
            OR (s.start_min > s.end_min AND m < s.end_min AND (s.days = 'all' OR FIND_IN_SET(d_prev, s.days))))
     ORDER BY FIELD(s.target_type, 'user', 'plan', 'group', 'all'), s.id DESC
     LIMIT 1;
    RETURN COALESCE(v_rate, '');
END //

-- The normal (not scheduled) speed: the user's own, else the group's ('' = no limit)
CREATE OR REPLACE FUNCTION ml_base_rate(u VARCHAR(64)) RETURNS VARCHAR(64)
    READS SQL DATA
BEGIN
    DECLARE v_rate VARCHAR(64) DEFAULT '';
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_rate = '';
    SELECT value INTO v_rate FROM radreply WHERE username = u AND attribute = 'Mikrotik-Rate-Limit' LIMIT 1;
    IF v_rate = '' THEN
        SELECT r.value INTO v_rate FROM radusergroup g JOIN radgroupreply r ON r.groupname = g.groupname
         WHERE g.username = u AND r.attribute = 'Mikrotik-Rate-Limit' ORDER BY g.priority LIMIT 1;
    END IF;
    RETURN COALESCE(v_rate, '');
END //
DELIMITER ;

-- "Pehle se khabardari": a warning shown to the user before the package or the data runs out.
-- Settings (ml_setting): notice_days (2), notice_quota_pct (90), notice_expiry / notice_quota (text with
-- {user} {date} {left} {used} {quota} {contact} {brand}). '' = nothing to say.
DELIMITER //
CREATE OR REPLACE FUNCTION ml_setting_get(p_k VARCHAR(64), p_def VARCHAR(512)) RETURNS VARCHAR(512)
    READS SQL DATA
BEGIN
    DECLARE v VARCHAR(512) DEFAULT NULL;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v = NULL;
    SELECT s.v INTO v FROM ml_setting s WHERE s.k = p_k LIMIT 1;
    RETURN IF(v IS NULL OR v = '', p_def, v);
END //

CREATE OR REPLACE FUNCTION ml_bytes(n BIGINT) RETURNS VARCHAR(16) DETERMINISTIC
    RETURN IF(n >= 1073741824, CONCAT(ROUND(n / 1073741824, 1), ' GB'), CONCAT(ROUND(n / 1048576), ' MB')) //

CREATE OR REPLACE FUNCTION ml_fill(t VARCHAR(512), u VARCHAR(64)) RETURNS VARCHAR(512)
    READS SQL DATA
    RETURN REPLACE(REPLACE(REPLACE(t, '{user}', u), '{contact}', ml_setting_get('contact', 'staff')),
                   '{brand}', ml_setting_get('brand', 'WiFi')) //

-- expiry within notice_days
CREATE OR REPLACE FUNCTION ml_notice_expiry(u VARCHAR(64)) RETURNS VARCHAR(255)
    READS SQL DATA
BEGIN
    DECLARE v_exp DATETIME DEFAULT NULL;
    DECLARE v_days INT DEFAULT 2;
    DECLARE v_secs BIGINT;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET v_exp = NULL;
    SET v_days = CAST(ml_setting_get('notice_days', '2') AS UNSIGNED);
    IF v_days = 0 THEN RETURN ''; END IF;
    SELECT expires_at INTO v_exp FROM ml_account WHERE username = u;
    IF v_exp IS NULL OR v_exp <= NOW() OR v_exp > NOW() + INTERVAL v_days DAY THEN RETURN ''; END IF;
    SET v_secs = TIMESTAMPDIFF(SECOND, NOW(), v_exp);
    RETURN LEFT(REPLACE(REPLACE(ml_fill(ml_setting_get('notice_expiry',
                'Aap ka package {date} ko khatam ho ga ({left} baqi). Renew ke liye: {contact}'), u),
           '{date}', DATE_FORMAT(v_exp, '%d %b %H:%i')),
           '{left}', IF(v_secs >= 86400, CONCAT(v_secs DIV 86400, ' din'), CONCAT(GREATEST(1, v_secs DIV 3600), ' ghante'))), 250);
END //

-- data used past notice_quota_pct of the quota (not yet used up: then the plan's rule applies)
CREATE OR REPLACE FUNCTION ml_notice_quota(u VARCHAR(64)) RETURNS VARCHAR(255)
    READS SQL DATA
BEGIN
    DECLARE found INT DEFAULT 1;
    DECLARE v_since, v_start DATETIME;
    DECLARE v_quota, v_used BIGINT DEFAULT 0;
    DECLARE v_period VARCHAR(10);
    DECLARE v_pct INT DEFAULT 90;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET found = 0;
    SET v_pct = CAST(ml_setting_get('notice_quota_pct', '90') AS UNSIGNED);
    IF v_pct = 0 OR v_pct >= 100 THEN RETURN ''; END IF;
    SELECT COALESCE(a.quota_since, '1970-01-01'), COALESCE(a.quota_bytes, p.quota_bytes, 0), COALESCE(p.quota_period, 'total')
      INTO v_since, v_quota, v_period
      FROM ml_account a LEFT JOIN ml_plan p ON p.name = a.plan WHERE a.username = u;
    IF found = 0 OR v_quota = 0 THEN RETURN ''; END IF;
    SET v_start = GREATEST(v_since, CASE v_period WHEN 'daily' THEN CURDATE()
                                                  WHEN 'monthly' THEN DATE_FORMAT(NOW(), '%Y-%m-01')
                                                  ELSE '1970-01-01' END);
    SELECT COALESCE(SUM(acctinputoctets + acctoutputoctets), 0) INTO v_used
      FROM radacct WHERE username = u AND acctstarttime >= v_start;
    IF v_used < v_quota * v_pct / 100 OR v_used >= v_quota THEN RETURN ''; END IF;
    RETURN LEFT(REPLACE(REPLACE(REPLACE(ml_fill(ml_setting_get('notice_quota',
                'Aap ka {used} data istemal ho chuka, sirf {left} baqi hai. Renew ke liye: {contact}'), u),
           '{used}', ml_bytes(v_used)), '{quota}', ml_bytes(v_quota)), '{left}', ml_bytes(v_quota - v_used)), 250);
END //

CREATE OR REPLACE FUNCTION ml_notice(u VARCHAR(64)) RETURNS VARCHAR(255)
    READS SQL DATA
    RETURN LEFT(CONCAT_WS(' | ', NULLIF(ml_notice_expiry(u), ''), NULLIF(ml_notice_quota(u), '')), 250) //
DELIMITER ;
