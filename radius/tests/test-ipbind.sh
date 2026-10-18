#!/usr/bin/env bash
# IP binding tests on an installed server (needs root + the database). Fake sessions are written into
# radacct; the router part of sync.rsc is checked with tests/lint-rsc.py.
#   sudo bash tests/test-ipbind.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-ipbind.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
sess() { # user ip mac [PPP]
    db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, callingstationid, framedprotocol, acctstarttime)
        VALUES ('ib$RANDOM', 'ib-$1-$RANDOM$RANDOM', '$1', '10.10.10.1', '$2', '$3', '${4:-}', NOW())"; }
stop() { db "UPDATE radacct SET acctstoptime=NOW() WHERE username='$1' AND acctstoptime IS NULL"; }
bind() { db "SELECT CONCAT(ip,'|',mac,'|',locked) FROM ml_ip_bind WHERE username='$1'"; }
was_auto=$(db "SELECT v FROM ml_setting WHERE k='ipbind_auto'"); was_days=$(db "SELECT v FROM ml_setting WHERE k='ipbind_days'")
cleanup() {
    for u in ib-a ib-b ib-c ib-p; do radius-admin user del "$u" >/dev/null 2>&1; done
    db "DELETE FROM radacct WHERE username LIKE 'ib-%'; DELETE FROM ml_ip_bind WHERE username LIKE 'ib-%';
        REPLACE INTO ml_setting (k, v) VALUES ('ipbind_auto', '${was_auto:-0}'), ('ipbind_days', '${was_days:-7}')"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
for u in ib-a ib-b ib-c ib-p; do radius-admin user add "$u" -p Pass1234 >/dev/null; done
radius-admin user ip ib-p 10.20.9.9 >/dev/null 2>&1

radius-admin ipbind auto off >/dev/null
sess ib-a 192.168.77.11 AA-BB-CC-00-77-11
radius-admin ipbind run >/dev/null
t "auto off: nothing bound" "$(bind ib-a)" ""
radius-admin ipbind auto on >/dev/null
out=$(radius-admin ipbind run -v)
t "auto on: user bound to the address DHCP gave" "$(bind ib-a)" "192.168.77.11|AA-BB-CC-00-77-11|0"
t "run tells what it did" "$(grep -c 'bind ib-a -> 192.168.77.11' <<<"$out")" "1"
t "router lease made (MAC with colons)" "$(grep -c 'add mac-address=AA:BB:CC:00:77:11 address=192.168.77.11 comment="mlbind: ib-a"' /var/lib/mikrotiklover/router/sync.rsc)" "1"
stop ib-a; sess ib-a 192.168.77.99 3A-11-22-33-44-55
out=$(radius-admin ipbind run -v)
t "new random MAC: the address stays with the user" "$(bind ib-a)" "192.168.77.11|3A-11-22-33-44-55|0"
t "  ... told as a move" "$(grep -c 'move ib-a 192.168.77.11' <<<"$out")" "1"
t "  ... lease moved to the new MAC, old one gone" "$(grep -c 'mac-address=3A:11:22:33:44:55 address=192.168.77.11' /var/lib/mikrotiklover/router/sync.rsc)$(grep -c 'AA:BB:CC:00:77:11' /var/lib/mikrotiklover/router/sync.rsc)" "20"
t "random MAC shown in the list" "$(radius-admin ipbind list | grep ib-a | grep -c random)" "1"
stop ib-a; sess ib-b 192.168.77.11 AA-BB-CC-00-77-22
radius-admin ipbind run >/dev/null
t "someone else's address: not bound twice" "$(bind ib-b)" ""
stop ib-b; sess ib-c 192.168.77.33 3A-11-22-33-44-55
radius-admin ipbind run >/dev/null
t "same phone, other user: the device moves to the new user" "$(bind ib-c)|$(bind ib-a)" "192.168.77.33|3A-11-22-33-44-55|0|192.168.77.11||0"
t "user without a device gets no lease" "$(grep -c 'mlbind: ib-a' /var/lib/mikrotiklover/router/sync.rsc)" "0"
sess ib-p 10.20.9.9 AA-BB-CC-00-77-44 PPP
radius-admin ipbind run >/dev/null
t "PPPoE session not bound (has its own static IP)" "$(bind ib-p)" ""
t "admin set: PPPoE user refused" "$(radius-admin ipbind set ib-p 192.168.77.70 2>&1 | grep -c 'PPPoE static IP')" "1"
t "admin set: bound address refused" "$(radius-admin ipbind set ib-b 192.168.77.11 2>&1 | grep -c "already bound to 'ib-a'")" "1"
t "admin set: address in use now refused" "$(radius-admin ipbind set ib-b 10.20.9.9 2>&1 | grep -c 'in use right now')" "1"
t "admin set: bad address refused" "$(radius-admin ipbind set ib-b 192.168.77.300 2>&1 | grep -c 'Invalid IPv4')" "1"
t "admin set: subnet refused" "$(radius-admin ipbind set ib-b 192.168.77.0/24 2>&1 | grep -c 'single IPv4')" "1"
t "admin set: unknown user refused" "$(radius-admin ipbind set nosuchuser9 192.168.77.70 2>&1 | grep -c 'No such user')" "1"
radius-admin ipbind set ib-b 192.168.77.50 >/dev/null
t "admin set: locked, device from the last login" "$(bind ib-b)" "192.168.77.50|AA-BB-CC-00-77-22|1"
t "  ... in sync.rsc at once" "$(grep -c 'mac-address=AA:BB:CC:00:77:22 address=192.168.77.50' /var/lib/mikrotiklover/router/sync.rsc)" "2"
sess ib-b 192.168.77.12 AA-BB-CC-00-77-22
radius-admin ipbind run >/dev/null
t "locked address not changed by auto" "$(bind ib-b)" "192.168.77.50|AA-BB-CC-00-77-22|1"
stop ib-b; stop ib-c
db "UPDATE ml_ip_bind SET last_seen = NOW() - INTERVAL 10 DAY WHERE username IN ('ib-b','ib-c')"
radius-admin ipbind days 7 >/dev/null
radius-admin ipbind run >/dev/null
t "unused 10 days: auto freed, admin kept" "$(bind ib-c)|$(bind ib-b)" "|192.168.77.50|AA-BB-CC-00-77-22|1"
radius-admin ipbind unlock ib-b >/dev/null
t "unlock: back to auto" "$(bind ib-b)" "192.168.77.50|AA-BB-CC-00-77-22|0"
radius-admin ipbind del ib-b >/dev/null
t "del: binding and lease gone" "$(bind ib-b)$(grep -c 'mlbind: ib-b' /var/lib/mikrotiklover/router/sync.rsc)" "0"
radius-admin user del ib-a >/dev/null
t "user deleted: binding deleted" "$(bind ib-a)" ""
t "days: bad value refused" "$(radius-admin ipbind days abc 2>&1 | grep -c 'must be a number')" "1"
radius-admin ipbind set ib-c 192.168.77.60 >/dev/null
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" /var/lib/mikrotiklover/router/sync.rsc | head -1)" "ok   sync.rsc"
t "router part is one block (locals survive the import)" "$(sed -n '/# IP binding/{n;p}' /var/lib/mikrotiklover/router/sync.rsc)" ":do {"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp); trap 'rm -f "$jar"; cleanup' EXIT
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ib.out -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: list" "$(api GET /api/ipbind)$(python3 -c 'import json; d=json.load(open("/tmp/ib.out")); print([b["ip"] for b in d["bindings"] if b["username"]=="ib-c"])')" "200['192.168.77.60']"
    t "API: change address" "$(api POST /api/ipbind '{"user":"ib-c","ip":"192.168.77.61"}')$(bind ib-c | cut -d'|' -f1)" "200192.168.77.61"
    t "API: bad address 400" "$(api POST /api/ipbind '{"user":"ib-c","ip":"192.168.77.1;reboot"}')" "400"
    t "API: settings days 0" "$(api POST /api/ipbind/settings '{"days":0}')$(db "SELECT v FROM ml_setting WHERE k='ipbind_days'")" "2000"
    t "API: remove" "$(api POST /api/ipbind/del '{"user":"ib-c"}')$(bind ib-c)" "200"
    t "API: unknown action 404" "$(api POST /api/ipbind/reboot '{}')" "404"
fi
[ "$fails" = 0 ] && echo "all IP binding tests passed" || { echo "$fails FAILED"; exit 1; }
