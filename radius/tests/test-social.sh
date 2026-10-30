#!/usr/bin/env bash
# Social WiFi tests on an installed server (needs root + the database). No SMS is sent: the test writes
# the one-time codes itself (same hash as radius-admin) and checks verify, limits and the customer list.
#   sudo bash tests/test-social.sh
set -uo pipefail
. /etc/mikrotiklover-radius/radius.conf
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == $3 ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
hash() { printf '%s:%s:%s' "$LOCAL_SECRET" "$1" "$2" | sha256sum | cut -c1-64; }
code() { db "INSERT INTO ml_social_otp (phone, mac, code_hash, created) VALUES ('$1', '${3:-}', '$(hash "$1" "$2")', NOW() - INTERVAL ${4:-0} MINUTE)"; }
was_on=$(db "SELECT v FROM ml_setting WHERE k='social_on'")
cleanup() {
    for u in sw-923009990001 sw-923009990002; do radius-admin user del "$u" >/dev/null 2>&1; done
    db "DELETE FROM ml_social_user WHERE phone LIKE '+92300999000%'; DELETE FROM ml_social_otp WHERE phone LIKE '+92300999000%';
        DELETE FROM radacct WHERE username LIKE 'sw-92300999000%'"
    db "REPLACE INTO ml_setting (k, v) VALUES ('social_on', '${was_on:-0}')"
}
trap cleanup EXIT
cleanup; db "REPLACE INTO ml_setting (k, v) VALUES ('social_on', '1')"
radius-admin plan show social-free >/dev/null 2>&1 || radius-admin social set minutes 60 >/dev/null
P=+923009990001
code $P 123456 AA:BB:CC:00:99:01
out=$(radius-admin social verify 0300-999-0001 123456 AA:BB:CC:00:99:01 Sara 1 2>&1)
t "right code: account made" "$(grep -c '^user=sw-923009990001$' <<<"$out")$(grep -c '^pass=' <<<"$out")" "11"
t "account is on the free plan" "$(db "SELECT plan FROM ml_account WHERE username='sw-923009990001'")" "social-free"
t "customer saved with name and consent" "$(db "SELECT CONCAT(name,'/',consent,'/',visits) FROM ml_social_user WHERE phone='$P'")" "Sara/1/1"
t "same code twice: refused" "$(radius-admin social verify $P 123456 AA:BB:CC:00:99:01 2>&1 | tail -1)" "*naya code*"
code $P 222222 AA:BB:CC:00:99:01
t "wrong code" "$(radius-admin social verify $P 999999 AA:BB:CC:00:99:01 2>&1 | tail -1)" "*Code ghalat*"
t "right code after a wrong one; no consent given = kept" "$(radius-admin social verify $P 222222 AA:BB:CC:00:99:01 2>&1 | grep -c '^user=')$(db "SELECT consent FROM ml_social_user WHERE phone='$P'")" "11"
t "same day: visits stay 1" "$(db "SELECT visits FROM ml_social_user WHERE phone='$P'")" "1"
db "UPDATE ml_social_user SET last_seen = NOW() - INTERVAL 1 DAY WHERE phone='$P'"
code $P 333333 ""
radius-admin social verify $P 333333 AA:BB:CC:00:99:01 >/dev/null 2>&1
t "next day: visits 2" "$(db "SELECT visits FROM ml_social_user WHERE phone='$P'")" "2"
code $P 444444 AA:BB:CC:00:99:01 6
t "code older than 5 minutes refused" "$(radius-admin social verify $P 444444 AA:BB:CC:00:99:01 2>&1 | tail -1)" "*purana*"
code $P 555555 AA:BB:CC:00:99:01
t "code from another device refused" "$(radius-admin social verify $P 555555 AA:BB:CC:00:99:77 2>&1 | tail -1)" "*purana*"
for i in 1 2 3 4 5; do radius-admin social verify $P 000000 AA:BB:CC:00:99:01 >/dev/null 2>&1; done
t "5 wrong tries: even the right code is refused" "$(radius-admin social verify $P 555555 AA:BB:CC:00:99:01 2>&1 | tail -1)" "*Bahut ghalat*"
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime, acctstoptime, acctsessiontime, acctinputoctets, acctoutputoctets)
    VALUES ('zs1','zs-u1','sw-923009990001','127.0.0.1',NOW(),NOW(),60,999999999,0)"
code $P 666666 ""
t "daily free data used: told to come tomorrow" "$(radius-admin social verify $P 666666 "" 2>&1 | tail -1)" "*kal phir*"
t "bad phone refused" "$(radius-admin social verify 12345 123456 '' 2>&1 | tail -1)" "*Number ghalat*"
t "bad code format refused" "$(radius-admin social verify $P 12ab56 '' 2>&1 | tail -1)" "*6 digits*"
code +923009990002 777777 ""
radius-admin social verify +923009990002 777777 "" "Ali<script>" 0 >/dev/null 2>&1
t "name cleaned" "$(db "SELECT name FROM ml_social_user WHERE phone='+923009990002'")" "Alis*"
t "offer dry run counts only consenting" "$(radius-admin social offer 'Test offer' --dry-run 2>&1 | grep -o 'go to [0-9]*')" "go to *"
radius-admin social forget $P >/dev/null
t "forget: customer and account gone" "$(db "SELECT COUNT(*) FROM ml_social_user WHERE phone='$P'")$(db "SELECT COUNT(*) FROM radcheck WHERE username='sw-923009990001'")" "00"
db "REPLACE INTO ml_setting (k, v) VALUES ('social_on', '0')"
code +923009990002 888888 ""
t "social off: refused" "$(radius-admin social otp 03009990002 2>&1 | tail -1)" "*off*"
[ "$fails" = 0 ] && echo "all social tests passed" || { echo "$fails FAILED"; exit 1; }
