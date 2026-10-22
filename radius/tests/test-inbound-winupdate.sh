#!/usr/bin/env bash
# "From outside": the doors a router opens to the internet (port forwards, UPnP, its own services) from the
# router report, who came in from outside (traffic collector -> ml_inbound), and Windows Update on / off.
#   sudo bash tests/test-inbound-winupdate.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-inbound-winupdate.sh    (+ dashboard API)
#   KEEP=1 ...   leave the sample data (for screenshots)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
S=/var/lib/mikrotiklover/router/webfilter-policies.rsc LIB=/usr/local/lib/mikrotiklover
DVR=10.96.0.20 PC=10.96.0.21 BAD=198.51.100.66 GOOD=198.51.100.10
was_wu=$(db "SELECT v FROM ml_setting WHERE k='winupdate'")
cleanup() {
    [ -n "${KEEP:-}" ] && return
    db "DELETE FROM ml_inbound WHERE lan_ip IN ('$DVR','$PC'); DELETE FROM ml_router_status WHERE identity='ib-router';
        DELETE FROM ml_security_event WHERE src_ip='$BAD' AND type='ib-test'"
    radius-admin user del ib-user >/dev/null 2>&1; radius-admin policy del ib-noupdate >/dev/null 2>&1
    radius-admin winupdate "${was_wu:-on}" >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

# ---- 1. the router report: port forwards (one by UPnP), its own services
KEY=$(radius-admin policy sync 2>/dev/null | grep -o 'key=[A-Za-z0-9]*' | head -1 | cut -d= -f2)
REPORT="id=ib-router
ver=7.15
nat=tcp|37777|$DVR|37777|ether1|||false|false|DVR from outside
nat=tcp|3389|$PC|3389|ether1|||false|false|office PC
nat=udp|5060|10.96.0.30|5060|ether1||203.0.113.0/24|false|false|voip
nat=tcp|51413|10.96.0.40|51413|ether1|||false|true|upnp torrent
nat=tcp|8080|10.96.0.50|80|ether1|||true|false|old cam (disabled)
svc=winbox|8291|
svc=ssh|22|192.168.88.0/24
svc=bad name|1|"
code=$(curl -sk -o /dev/null -w '%{http_code}' --data-binary "$REPORT" "https://127.0.0.1:8443/api/public/router/report?key=$KEY")
t "router report with nat= and svc= lines accepted" "$code" "200"
ex=$(db "SELECT exposed FROM ml_router_status WHERE identity='ib-router'")
J() { python3 -c "import json,sys; d=json.loads(sys.argv[1]); print($1)" "$ex"; }
t "  ... 5 port forwards saved" "$(J "len(d['nat'])")" "5"
t "  ... the UPnP one marked dynamic, the old cam disabled" "$(J "[n['dynamic'] for n in d['nat']].count(True), [n['disabled'] for n in d['nat']].count(True)")" "1 1"
t "  ... services: a bad name dropped" "$(J "[s['name'] for s in d['services']]")" "['winbox', 'ssh']"
t "  ... bad report refused (no identity)" "$(curl -sk -o /dev/null -w '%{http_code}' --data-binary 'nat=tcp|1|2|3' "https://127.0.0.1:8443/api/public/router/report?key=$KEY")" "400"
t "  ... wrong key refused" "$(curl -sk -o /dev/null -w '%{http_code}' --data-binary "$REPORT" "https://127.0.0.1:8443/api/public/router/report?key=nope")" "403"

# ---- 2. who came in: the traffic collector's writer (same code as the live collector)
bucket=$(date '+%Y-%m-%d %H:%M:00')
python3 - "$LIB" "$bucket" <<EOF
import sys; sys.path.insert(0, sys.argv[1])
import flowcollector as fc
s = fc.Store(fc.read_conf())
rows = [(sys.argv[2], "$BAD", "$PC", "", 6, 3389, 40, 90000, 20000),
        (sys.argv[2], "$GOOD", "$DVR", "", 6, 37777, 3, 10000, 9000000),
        (sys.argv[2], "198.51.100.11", "$DVR", "", 6, 37777, 2, 5000, 4000000)]
s.write_inbound(rows, 30)
s.write_inbound(rows[:1], 30)       # the next minute: added up, not replaced
EOF
t "collector: inbound flows saved and added up" "$(db "SELECT CONCAT(flows,'/',bytes_in) FROM ml_inbound WHERE lan_ip='$PC' AND remote_ip='$BAD'")" "80/180000"
t "  ... one row per outside address" "$(db "SELECT COUNT(*) FROM ml_inbound WHERE lan_ip='$DVR'")" "2"
db "INSERT INTO ml_security_event (day, category, type, severity, source, src_ip, detail, hits, first_seen, last_seen)
    VALUES (CURDATE(), 'attack', 'ib-test', 'high', 'flow', '$BAD', 'port scan', 1, NOW(), NOW())"

# ---- 3. Windows Update on / off for everyone
rsc() { grep -c 'comment="wfpolicy:global windows-update"' "$S"; }
radius-admin winupdate off >/dev/null
t "off: one global rule first, for everyone except the exempt list" "$(grep 'wfpolicy:global windows-update' "$S" | grep -c 'src-address-list=!web-filter-exempt .*jump-target=wf-windows-update comment')" "1"
t "  ... the Windows Update names in their own chain" "$([ "$(grep -c 'chain=wf-windows-update ' "$S")" -ge 10 ] && echo yes)" "yes"
t "  ... before every policy" "$(grep -n 'jump-target=wf' "$S" | head -1 | grep -c 'global windows-update')" "1"
t "  ... status says off" "$(radius-admin winupdate status | grep -c 'windows update: off')" "1"
radius-admin winupdate office >/dev/null
t "office: same rule with office hours" "$(grep 'wfpolicy:global windows-update' "$S" | grep -c 'time=9h-17h,mon,tue,wed,thu,fri,sat')" "1"
t "  ... the file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" "$S" | head -1)" "ok   webfilter-policies.rsc"
radius-admin winupdate on >/dev/null
t "on: the rule is gone" "$(rsc)" "0"
t "bad mode refused" "$(radius-admin winupdate maybe 2>&1 | grep -c usage)" "1"
# per policy: only some users, with its own time
printf '# test: no Windows Update in the day\nblock windows-update time=8h-18h\n' | radius-admin policy set ib-noupdate >/dev/null
t "per policy: block windows-update with time" "$(grep -c 'chain=wfp-ib-noupdate .*jump-target=wf-windows-update.*time=8h-18h' "$S")" "1"
t "  ... no global rule" "$(rsc)" "0"
radius-admin user add ib-user -p Pass1234 >/dev/null; radius-admin user policy ib-user ib-noupdate >/dev/null

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ib.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ib.json')); print($1)"; }
    door() { js "[(x['open_to'], x['risk'], x['dynamic'], x['disabled']) for x in d['doors'] if x['router']=='ib-router' and x['port']=='$1']"; }
    t "API doors: the DVR open to everyone, flagged" "$(api GET /api/inbound?days=1)$(door 37777)" "200[('everyone', 'Dahua DVR', False, False)]"
    t "API doors: RDP flagged with advice" "$(js "[x['advice'][:10] for x in d['doors'] if x['port']=='3389' and x['router']=='ib-router']")" "['ransomware']"
    t "API doors: VoIP open only to one network" "$(door 5060)" "[('203.0.113.0/24', '', False, False)]"
    t "API doors: UPnP marked" "$(door 51413)" "[('everyone', '', True, False)]"
    t "API services: winbox open to all with a fix, ssh limited" "$(js "[(s['name'], bool(s['advice'])) for s in d['services'] if s['router']=='ib-router']")" "[('winbox', True), ('ssh', False)]"
    t "API who came in: RDP to the PC by a port forward, from 1 attacker" "$(js "[(r['proto'], r['risk'], r['via'], r['outside'], r['bad_outside']) for r in d['rows'] if r['lan_ip']=='$PC']")" "[('tcp', 'RDP (remote desktop)', 'port forward', 1, 1)]"
    t "API who came in: the DVR from 2 outside addresses" "$(js "[(r['port'], r['outside'], r['bytes_out']) for r in d['rows'] if r['lan_ip']=='$DVR']")" "[(37777, 2, 13000000)]"
    t "API outside addresses: the attacker marked" "$(js "[r['threat'][:13] for r in d['remotes'] if r['remote_ip']=='$BAD']")" "['seen attackin']"
    t "API: router reported its doors" "$(js "d['reported']")" "True"
    t "API detail: every outside address for DVR:37777" "$(api GET "/api/inbound/detail?lan=$DVR&port=37777&days=1")$(js "sorted(r['remote_ip'] for r in d['rows'])")" "200['198.51.100.10', '198.51.100.11']"
    t "API detail: bad address 400" "$(api GET '/api/inbound/detail?lan=x;y&port=1')" "400"
    t "API winupdate: off" "$(api POST /api/winupdate '{"mode":"off"}')$(rsc)" "2001"
    t "API summary: says off" "$(api GET /api/blocking/summary)$(js "d['winupdate']")" "200off"
    t "API finder: a Windows Update name blocked, with why" "$(api GET '/api/why?site=fe3.delivery.mp.microsoft.com')$(js "d['verdict'], 'Windows Update is OFF' in d['summary']")" "200blocked True"
    t "API finder: Office not hit" "$(api GET '/api/why?site=outlook.office365.com')$(js "'Windows Update' in d['summary']")" "200False"
    t "API winupdate: bad mode 400" "$(api POST /api/winupdate '{"mode":"x"}')" "400"
    t "API winupdate: on" "$(api POST /api/winupdate '{"mode":"on"}')$(rsc)" "2000"
    t "API finder: per-policy user still blocked in the day" "$(api GET '/api/why?site=fe3.delivery.mp.microsoft.com&user=ib-user')$(js "d['verdict'] in ('blocked', 'blocked-other-times')")" "200True"
    rm -f "$jar" /tmp/ib.json
fi
[ "$fails" = 0 ] && echo "all from-outside + windows update tests passed" || { echo "$fails FAILED"; exit 1; }
