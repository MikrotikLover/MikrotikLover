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
