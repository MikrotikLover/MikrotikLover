#!/usr/bin/env bash
# Traffic graphs + departments on an installed server (needs root + the database).
#   sudo bash tests/test-traffic.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-traffic.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
sess() { # id user in out [minutes ago] [nas]
    db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctupdatetime, acctinputoctets, acctoutputoctets)
        VALUES ('$1', '$1', '$2', '${6:-10.10.10.1}', '192.168.90.$((RANDOM % 200 + 10))', NOW() - INTERVAL ${5:-2} MINUTE, NOW(), $3, $4)"; }
upd() { db "UPDATE radacct SET acctinputoctets=$2, acctoutputoctets=$3, acctupdatetime=NOW() WHERE acctuniqueid='$1'"; }
tot() { db "SELECT CONCAT(COALESCE(SUM(rx),0),'/',COALESCE(SUM(tx),0)) FROM ml_traffic WHERE kind='user' AND res=$2 AND name='$1'"; }
cleanup() {
    for u in tr-a tr-b tr-c tr-d; do radius-admin user del "$u" >/dev/null 2>&1; done
    radius-admin group del tr-grp >/dev/null 2>&1
    for d in tr-sales tr-acc tr-x; do radius-admin dept del "$d" >/dev/null 2>&1; done
    db "DELETE FROM radacct WHERE acctuniqueid LIKE 'trs%'; DELETE FROM ml_acct_snap WHERE acctuniqueid LIKE 'trs%';
        DELETE FROM ml_traffic WHERE name LIKE 'tr-%' OR name LIKE '%|tr-router|%'; DELETE FROM ml_router_status WHERE identity='tr-router';
        DELETE FROM ml_dept_member WHERE name LIKE 'tr-%'"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
for u in tr-a tr-b tr-c tr-d; do radius-admin user add "$u" -p Pass1234 >/dev/null; done
radius-admin group add tr-grp rate 4M/4M >/dev/null 2>&1 || true
radius-admin user group tr-c tr-grp >/dev/null 2>&1; radius-admin user group tr-d tr-grp >/dev/null 2>&1

# ---- traffic counting from accounting
sess trs1 tr-a 1000 5000
radius-admin traffic-collect >/dev/null
t "new session: all its bytes counted (download/upload)" "$(tot tr-a 5)" "5000/1000"
t "  ... also in the hourly table" "$(tot tr-a 60)" "5000/1000"
upd trs1 3000 13000
radius-admin traffic-collect >/dev/null
t "next 5 minutes: only the difference added" "$(tot tr-a 5)" "13000/3000"
radius-admin traffic-collect >/dev/null
t "no change: nothing added" "$(tot tr-a 60)" "13000/3000"
sess trs2 tr-b 900000 900000 120
radius-admin traffic-collect >/dev/null
t "old session seen first time: only a starting point" "$(tot tr-b 5)" "0/0"
upd trs2 900100 900400
db "UPDATE radacct SET acctstoptime=NOW() WHERE acctuniqueid='trs2'"
radius-admin traffic-collect >/dev/null
t "stopped session: last bytes counted" "$(tot tr-b 5)" "400/100"
upd trs1 10 10
radius-admin traffic-collect >/dev/null
t "counter went down (router restart): nothing negative" "$(tot tr-a 5)" "13000/3000"

# ---- departments
t "bad speed refused" "$(radius-admin dept add tr-sales 10X 5M 2>&1 | grep -c 'Speed like')" "1"
t "bad name refused" "$(radius-admin dept add 'Tr Sales' 10M 5M 2>&1 | grep -c 'Department name')" "1"
t "quote in title refused" "$(radius-admin dept add tr-sales 10M 5M 'a"b' 2>&1 | grep -c 'Title')" "1"
radius-admin dept add tr-sales 10M 2.5M "Sales team" >/dev/null
t "speeds stored in kbit/s" "$(db "SELECT CONCAT(down_kbps,'/',up_kbps,'/',title) FROM ml_department WHERE name='tr-sales'")" "10000/2500/Sales team"
t "same name twice refused" "$(radius-admin dept add tr-sales 1M 1M 2>&1 | grep -c 'already exists')" "1"
radius-admin dept add tr-acc 512k 0 >/dev/null
t "512k and 0 (no limit)" "$(db "SELECT CONCAT(down_kbps,'/',up_kbps) FROM ml_department WHERE name='tr-acc'")" "512/0"
S=/var/lib/mikrotiklover/router/sync.rsc
t "router: shared download queue with PCQ" "$(grep -c 'name="dept tr-sales down" parent=global packet-mark=mld-tr-sales-down max-limit=10000k queue=ml-pcq-down' $S)" "1"
t "router: no upload queue when 0" "$(grep -c 'dept tr-acc up' $S)" "0"
t "router: PCQ types, marks, fasttrack bypass, 1-minute member script" "$(grep -c 'pcq-classifier=dst-address pcq-rate=0' $S)$(grep -c 'src-address-list=ml-dept-tr-sales action=mark-packet' $S)$(grep -c 'connection-state=established,related src-address-list=ml-dept-all' $S)$(grep -c 'name=ml-live interval=1m' $S)" "1111"
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
t "member: unknown user refused" "$(radius-admin dept member tr-sales user nosuch9 2>&1 | grep -c 'No such user')" "1"
t "member: unknown department refused" "$(radius-admin dept member tr-x user tr-a 2>&1 | grep -c 'No department')" "1"
radius-admin dept member tr-sales user tr-a >/dev/null
radius-admin dept member tr-sales group tr-grp >/dev/null
radius-admin dept member tr-acc user tr-c >/dev/null
out=$(radius-admin dept member tr-acc user tr-a 2>&1)
t "user moved to another department (told)" "$(grep -c "was in 'tr-sales'" <<<"$out")" "1"
radius-admin dept member tr-sales user tr-a >/dev/null
db "DELETE FROM radacct WHERE acctuniqueid LIKE 'trs%'"
sess trs3 tr-a 0 0 1 127.0.0.1; sess trs4 tr-c 0 0 1 127.0.0.1; sess trs5 tr-d 0 0 1 127.0.0.1
sess trs6 tr-b 0 0 1 127.0.0.1; sess trs7 tr-a 0 0 1 10.10.10.99
db "UPDATE radacct SET framedipaddress=CONCAT('192.168.91.', SUBSTRING(acctuniqueid, 4)) WHERE acctuniqueid LIKE 'trs%'"   # distinct addresses
KEY=$(cat /var/lib/mikrotiklover/router/key)
if [ -n "${URL:-}" ]; then
    D=$(curl -sk "$URL/api/public/router/dept.rsc?key=$KEY")
    ipa=$(db "SELECT framedipaddress FROM radacct WHERE acctuniqueid='trs3'"); ipc=$(db "SELECT framedipaddress FROM radacct WHERE acctuniqueid='trs4'")
    ipd=$(db "SELECT framedipaddress FROM radacct WHERE acctuniqueid='trs5'"); ipb=$(db "SELECT framedipaddress FROM radacct WHERE acctuniqueid='trs6'")
    t "router list: direct member" "$(grep -c "\"$ipa\"=\"tr-sales\"" <<<"$D")" "1"
    t "router list: user's own entry wins over the group" "$(grep -c "\"$ipc\"=\"tr-acc\"" <<<"$D")" "1"
    t "router list: member through the group" "$(grep -c "\"$ipd\"=\"tr-sales\"" <<<"$D")" "1"
    t "router list: user in no department left out" "$(grep -c "\"$ipb\"" <<<"$D")" "0"
    ipo=$(db "SELECT framedipaddress FROM radacct WHERE acctuniqueid='trs7'")
    t "router list: only this router's sessions" "$(grep -c "\"$ipo\"" <<<"$D")" "0"
    t "router list: needs the key" "$(curl -sk -o /dev/null -w '%{http_code}' "$URL/api/public/router/dept.rsc?key=wrong")" "403"
    db "UPDATE radacct SET acctupdatetime=NOW() - INTERVAL 1 HOUR, acctstarttime=NOW() - INTERVAL 2 HOUR WHERE acctuniqueid='trs5'"
    t "router list: stale session left out" "$(curl -sk "$URL/api/public/router/dept.rsc?key=$KEY" | grep -c "\"$ipd\"")" "0"
    printf '%s\n' "$D" > /tmp/ml-dept-test.rsc
    t "router list passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" /tmp/ml-dept-test.rsc | head -1)" "ok   ml-dept-test.rsc"

    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/tr.out -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/tr.out')); print($1)"; }
    db "INSERT INTO ml_traffic (kind,name,res,bucket,rx,tx) VALUES
          ('user','tr-a',5,FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(NOW() - INTERVAL 1 HOUR)/300)*300),600000000,60000000),
          ('user','tr-d',5,FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(NOW() - INTERVAL 1 HOUR)/300)*300),300000000,30000000)
        ON DUPLICATE KEY UPDATE rx=rx+VALUES(rx), tx=tx+VALUES(tx)"
    t "API: user graph" "$(api GET '/api/traffic/series?kind=user&name=tr-a&range=6h')$(js 'd["total_rx"], len(d["points"]), d["step"]')" "200600013000 36 600"
    t "API: department = its users, with the limit" "$(api GET '/api/traffic/series?kind=dept&name=tr-sales&range=6h')$(js 'd["total_rx"], d["members"], d["limit"]["down_bps"], [r["name"] for r in d["top"]]')" "200900013000 2 10000000 ['tr-a', 'tr-d']"
    t "API: group = its users" "$(api GET '/api/traffic/series?kind=group&name=tr-grp&range=24h')$(js 'd["total_rx"], d["members"]')" "200300000000 2"
    t "API: average speed per step" "$(js 'max(p["rx_bps"] for p in d["points"])')" "1333333"
    t "API: bad kind 400" "$(api GET '/api/traffic/series?kind=x&name=a&range=6h')" "400"
    t "API: bad range 400" "$(api GET '/api/traffic/series?kind=user&name=tr-a&range=1y')" "400"
    t "API: unknown department 404" "$(api GET '/api/traffic/series?kind=dept&name=nope9&range=6h')" "404"
    # interfaces from the router's minute report
    rep() { printf 'id=tr-router\nver=7.16\ncpu=5\nif=ether1|true|false|%s|%s|ether\n' "$1" "$2"; }
    curl -sk -o /dev/null -X POST --data-binary "$(rep 1000000 200000)" -H 'Content-Type: text/plain' "$URL/api/public/router/report?key=$KEY"
    sleep 2
    curl -sk -o /dev/null -X POST --data-binary "$(rep 1600000 260000)" -H 'Content-Type: text/plain' "$URL/api/public/router/report?key=$KEY"
    t "interface bytes between two reports saved" "$(db "SELECT CONCAT(SUM(rx),'/',SUM(tx)) FROM ml_traffic WHERE kind='if' AND res=5 AND name LIKE '%|tr-router|ether1'")" "600000/60000"
    curl -sk -o /dev/null -X POST --data-binary "$(rep 100 100)" -H 'Content-Type: text/plain' "$URL/api/public/router/report?key=$KEY"
    t "router restart (counters lower): nothing added" "$(db "SELECT SUM(rx) FROM ml_traffic WHERE kind='if' AND res=60 AND name LIKE '%|tr-router|ether1'")" "600000"
    ifk=$(db "SELECT name FROM ml_traffic WHERE kind='if' AND name LIKE '%|tr-router|ether1' LIMIT 1")
    t "API: interface in the list and its graph" "$(api GET /api/traffic/items)$(js "any(i['key']=='$ifk' for i in d['interfaces'])")$(api GET "/api/traffic/series?kind=if&name=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$ifk")&range=6h")$(js 'd["total_rx"]')" "200True200600000"
    t "API: departments page data" "$(api GET /api/departments)$(js "[(x['name'], x['users'], x['online']) for x in d['departments'] if x['name']=='tr-sales']")" "200[('tr-sales', ['tr-a', 'tr-d'], ['tr-a'])]"
    t "API: new department" "$(api POST /api/departments '{"name":"tr-x","down":"20M","up":"0","title":"Lab","new":true}')$(db "SELECT down_kbps FROM ml_department WHERE name='tr-x'")" "20020000"
    t "API: add a member" "$(api POST /api/departments/tr-x/member '{"kind":"user","name":"tr-b"}')$(db "SELECT dept FROM ml_dept_member WHERE name='tr-b'")" "200tr-x"
    t "API: bad speed 400" "$(api POST /api/departments '{"name":"tr-x","down":"20;reboot","up":"0"}')" "400"
    t "API: remove member" "$(api POST /api/departments/unmember '{"kind":"user","name":"tr-b"}')$(db "SELECT COUNT(*) FROM ml_dept_member WHERE name='tr-b'")" "2000"
    t "API: delete department" "$(api DELETE /api/departments/tr-x)$(db "SELECT COUNT(*) FROM ml_department WHERE name='tr-x'")" "2000"
    rm -f "$jar" /tmp/ml-dept-test.rsc
fi
radius-admin group del tr-grp >/dev/null 2>&1
t "group deleted: its department entry gone" "$(db "SELECT COUNT(*) FROM ml_dept_member WHERE kind='group' AND name='tr-grp'")" "0"
radius-admin user del tr-a >/dev/null
t "user deleted: department entry gone" "$(db "SELECT COUNT(*) FROM ml_dept_member WHERE kind='user' AND name='tr-a'")" "0"
radius-admin dept del tr-sales >/dev/null; radius-admin dept del tr-acc >/dev/null
if [ "$(db "SELECT COUNT(*) FROM ml_department")" = 0 ]; then
    t "no departments: router removes queues and the member script" "$(grep -c 'remove \[find name="ml-dept"\]' $S)$(grep -c 'queue tree add' $S)" "20"
fi
[ "$fails" = 0 ] && echo "all traffic + department tests passed" || { echo "$fails FAILED"; exit 1; }
