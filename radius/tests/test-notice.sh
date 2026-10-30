#!/usr/bin/env bash
# "Pehle se khabardari" tests on an installed server (needs root + the database).
#   sudo bash tests/test-notice.sh
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == $3 ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# keep the server's own settings
saved=$(db "SELECT CONCAT(k,'=',v) FROM ml_setting WHERE k LIKE 'notice\\_%'")
restore() {
    db "DELETE FROM ml_setting WHERE k LIKE 'notice\\_%'"
    while IFS='=' read -r k v; do [ -z "$k" ] || db "INSERT INTO ml_setting (k,v) VALUES ('$k', '${v//\'/\\\'}')"; done <<<"$saved"
    db "DELETE FROM ml_account WHERE username LIKE 'zn-%'; DELETE FROM ml_plan WHERE name='zn-plan'; DELETE FROM radacct WHERE username LIKE 'zn-%';
        DELETE FROM ml_contact WHERE username LIKE 'zn-%'; DELETE FROM ml_notice_sent WHERE username LIKE 'zn-%'"
}
trap restore EXIT
db "DELETE FROM ml_setting WHERE k LIKE 'notice\\_%';
    INSERT INTO ml_plan (name, quota_bytes, quota_period) VALUES ('zn-plan', 1000000000, 'monthly') ON DUPLICATE KEY UPDATE quota_bytes=1000000000, quota_period='monthly';
    REPLACE INTO ml_account (username, plan, expires_at, quota_since) VALUES
      ('zn-soon', NULL, NOW() + INTERVAL 30 HOUR, NULL), ('zn-hours', NULL, NOW() + INTERVAL 5 HOUR, NULL),
      ('zn-later', NULL, NOW() + INTERVAL 10 DAY, NULL), ('zn-gone', NULL, NOW() - INTERVAL 1 HOUR, NULL),
      ('zn-data', 'zn-plan', NULL, NOW() - INTERVAL 1 DAY), ('zn-full', 'zn-plan', NULL, NOW() - INTERVAL 1 DAY),
      ('zn-low', 'zn-plan', NULL, NOW() - INTERVAL 1 DAY);
    INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctstoptime, acctinputoctets, acctoutputoctets) VALUES
      ('zn1','zn-u1','zn-data','127.0.0.1',NOW(),NOW(),900000000,20000000), ('zn2','zn-u2','zn-full','127.0.0.1',NOW(),NOW(),1000000000,1),
      ('zn3','zn-u3','zn-low','127.0.0.1',NOW(),NOW(),100000000,0);"
n() { db "SELECT ml_notice('$1')"; }
t "expires in 30 h: warned in days"    "$(n zn-soon)"  "Aap ka package * (1 din baqi). Renew ke liye: *"
t "expires in 5 h: warned in hours"     "$(n zn-hours)" "*(4 ghante baqi)*"
t "expires in 10 days: no warning"      "$(n zn-later)" ""
t "already expired: no warning (login is refused anyway)" "$(n zn-gone)" ""
t "92% data used: warned with MB left"  "$(n zn-data)"  "Aap ka 877 MB data istemal ho chuka, sirf 76 MB baqi hai.*"
t "100% used: no warning (the quota rule applies)" "$(n zn-full)" ""
t "10% used: no warning"                "$(n zn-low)"   ""
db "INSERT INTO ml_setting (k,v) VALUES ('notice_days','0'),('notice_quota_pct','0')"
t "days 0 = off"                        "$(n zn-soon)"  ""
t "quota-pct 0 = off"                   "$(n zn-data)"  ""
db "DELETE FROM ml_setting WHERE k IN ('notice_days','notice_quota_pct'); INSERT INTO ml_setting (k,v) VALUES ('notice_days','15'),
    ('notice_expiry','{user}: renew before {date} — call {contact} ({brand})')"
t "own text with placeholders; 15 days" "$(n zn-later)" "zn-later: renew before * — call * (*)"
# CLI
chk() { if out=$(radius-admin notice "$@" 2>&1); then echo "FAIL refused: notice $*"; fails=$((fails+1)); else echo "ok   refused: notice $* ($(tail -1 <<<"$out" | cut -c1-45))"; fi; }
chk set days 100
chk set quota-pct x
chk set hours 22-6
chk set sms maybe
chk set expiry-text ""
chk gateway 'http://x.example/api?to={phone}'
chk test
chk bogus
radius-admin user phone zn-soon 03001234567 >/dev/null 2>&1; t "phone of a non-user refused" "$(db "SELECT COUNT(*) FROM ml_contact WHERE username='zn-soon'")" "0"
db "INSERT INTO ml_contact (username, phone) VALUES ('zn-hours','+923001234567'),('zn-data','+923001234568')"
db "DELETE FROM ml_setting WHERE k LIKE 'notice\\_%'"
out=$(radius-admin notice run --dry-run 2>&1)
t "dry run: users with a phone and a warning" "$(grep -c 'would send to zn-' <<<"$out")" "2"
db "INSERT INTO ml_notice_sent (username, kind, ref, result) SELECT 'zn-hours','expiry',DATE_FORMAT(expires_at,'%Y-%m-%d %H:%i'),'sms: ok' FROM ml_account WHERE username='zn-hours'"
out=$(radius-admin notice run --dry-run 2>&1)
t "already sent once: not again" "$(grep -c 'would send to zn-hours' <<<"$out")" "0"
db "UPDATE ml_notice_sent SET result='ERROR: gateway down' WHERE username='zn-hours'"
out=$(radius-admin notice run --dry-run 2>&1)
t "failed one is tried again" "$(grep -c 'would send to zn-hours' <<<"$out")" "1"
[ "$fails" = 0 ] && echo "all notice tests passed" || { echo "$fails FAILED"; exit 1; }
