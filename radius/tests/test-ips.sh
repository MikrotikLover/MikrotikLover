#!/usr/bin/env bash
# Intrusion prevention end to end on an installed server with Suricata (radius-admin ips install):
# router-like TZSP copy -> tzsp2tap -> Suricata -> scan -> database -> block list for the routers (every minute).
#   sudo bash tests/test-ips.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-ips.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
command -v suricata >/dev/null || { echo "skipped: Suricata not installed (sudo radius-admin ips install)"; exit 0; }
S=/var/lib/mikrotiklover/router/sync.rsc EVE=/var/log/suricata/eve.json
A1=185.244.25.11 A2=185.244.25.12 A3=185.244.25.13 PC=192.168.88.21
was_on=$(db "SELECT v FROM ml_setting WHERE k='ips_on'") was_auto=$(db "SELECT v FROM ml_setting WHERE k='ips_autoblock'")
KEY=$(cat /var/lib/mikrotiklover/router/key)
live() { curl -sk "https://127.0.0.1:8443/api/public/router/live.rsc?key=$KEY"; }
clean() { db "DELETE FROM ml_ips_alert WHERE src_ip LIKE '185.244.25.%'; DELETE FROM ml_ips_block WHERE ip LIKE '185.244.25.%';
              DELETE FROM ml_ips_allow WHERE ip LIKE '185.244.25.%'; DELETE FROM ml_security_event WHERE source='ips' AND src_ip LIKE '185.244.25.%'"; }
cleanup() {
    clean; radius-admin ips rule on 9100001 >/dev/null 2>&1; radius-admin ips mirror first >/dev/null 2>&1
    radius-admin ips autoblock "$([ "${was_auto:-1}" = 0 ] && echo off || echo on)" >/dev/null 2>&1
    [ "${was_on:-0}" = 1 ] || radius-admin ips off >/dev/null 2>&1
}
trap cleanup EXIT
clean
radius-admin ips autoblock on >/dev/null
t "ips on: Suricata running" "$(radius-admin ips on >/dev/null 2>&1; sleep 12; radius-admin ips status | grep -c 'installed, running')" "1"
t "router file: copy of internet traffic (first 256 KB) + drop of blocked addresses" "$(grep -c 'action=sniff-tzsp sniff-target=.* connection-bytes=0-262144 comment="mlips:' $S) $(grep -c 'address-list=ml-ips action=drop comment="mlips:' $S)" "3 2"
t "router file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
radius-admin ips scan >/dev/null                               # start after what is already there

# an RDP password guesser and an MDaemon admin port probe arrive in the routers' copy
start=$(wc -l < $EVE 2>/dev/null || echo 0)
python3 "$HERE/tzspgen.py" $A1 $PC 3389 15
python3 "$HERE/tzspgen.py" $A2 $PC 1000 1
new() { tail -n +$((start + 1)) $EVE 2>/dev/null; }
for i in $(seq 1 20); do new | grep -q "\"$A2\"" && new | grep -q "\"$A1\"" && break; sleep 1; done
t "Suricata saw both (eve.json)" "$(new | grep -c "\"src_ip\":\"185.244.25.1[12]\"")" "2"
for i in $(seq 1 30); do [ "$(db "SELECT COUNT(*) FROM ml_ips_alert WHERE src_ip IN ('$A1','$A2')")" = 2 ] && break; sleep 0.2; done   # the real-time watcher
t "scan: alerts saved, high, blocked" "$(db "SELECT GROUP_CONCAT(CONCAT(sid,'/',severity,'/',blocked) ORDER BY sid) FROM ml_ips_alert WHERE src_ip IN ('$A1','$A2')")" "9100001/high/1,9100008/high/1"
t "scan: Security page events (source ips)" "$(db "SELECT COUNT(*) FROM ml_security_event WHERE source='ips' AND category='attack' AND src_ip IN ('$A1','$A2')")" "2"
t "routers get the block within a minute (live.rsc, with time limit)" "$(live | grep -c "list=ml-ips address=185.244.25.1[12] timeout=")" "2"
t "every-minute scan leaves it to the real-time watcher" "$(radius-admin ips scan)" "ips: the real-time watcher is running"

# a false alarm switched off
radius-admin ips rule off 9100001 >/dev/null
t "signature off: commented out, listed" "$(grep 'sid:9100001;' /var/lib/suricata/rules/suricata.rules | cut -c1-7) $(grep -c '^9100001' /etc/mikrotiklover-radius/ips-disable.conf)" "# alert 1"
sleep 4; python3 "$HERE/tzspgen.py" $A3 $PC 3389 15; sleep 6
t "  ... no alert for it any more" "$(db "SELECT COUNT(*) FROM ml_ips_alert WHERE src_ip='$A3'")" "0"
radius-admin ips rule on 9100001 >/dev/null

# by hand
t "block by hand (30 days)" "$(radius-admin ips block $A3 test 2>&1 | grep -c 'blocked on every router') $(db "SELECT DATEDIFF(until, NOW()) FROM ml_ips_block WHERE ip='$A3'")" "1 30"
t "never block: removes the block, kept out later" "$(radius-admin ips allow $A3 partner >/dev/null; db "SELECT COUNT(*) FROM ml_ips_block WHERE ip='$A3'") $(db "SELECT COUNT(*) FROM ml_ips_allow WHERE ip='$A3'")" "0 1"
t "a LAN address is not blocked (quarantine is for that)" "$(radius-admin ips block 192.168.88.5 2>&1 | grep -c quarantine)" "1"
t "unblock" "$(radius-admin ips unblock $A1 >/dev/null; live | grep -c "address=$A1 ")" "0"
radius-admin ips mirror all >/dev/null
t "copy everything: no byte limit" "$(grep -c 'sniff-tzsp.*connection-bytes' $S) $(grep -c 'sniff-tzsp' $S)" "0 3"
radius-admin ips mirror first >/dev/null
t "bad values refused" "$(radius-admin ips level low 2>&1 | grep -c usage)$(radius-admin ips hours 0 2>&1 | grep -c '1-720')$(radius-admin ips rule off x 2>&1 | grep -c usage)" "111"

# instant blocks through the router API: a fake RouterOS API (TLS) stands in for the router
FS=$(mktemp) A4=185.244.25.14 A5=185.244.25.15
radius-admin ips api del 127.0.0.1 >/dev/null 2>&1
t "api add: script with an API-only user for this server" "$(radius-admin ips api add 127.0.0.1 --port 18731 | grep -c 'policy=api,read,write\|/ip service set api-ssl certificate=ml-api port=18731')" "2"
PW=$(python3 -c "import json; print(json.load(open('/etc/mikrotiklover-radius/router-api.json'))['127.0.0.1']['password'])")
python3 "$HERE/fakeros.py" 18731 mlapi "$PW" "$FS" >/dev/null 2>&1 &
FPID=$!
sleep 2
t "api test: connected" "$(radius-admin ips api test 127.0.0.1 2>&1 | grep -c "connected as mlapi to 'FakeRouter'")" "1"
radius-admin ips restart >/dev/null; sleep 12                    # the real-time watcher
t0=$(date +%s%N); python3 "$HERE/tzspgen.py" $A4 $PC 3389 15
for i in $(seq 1 50); do grep -q "$A4" "$FS" && break; sleep 0.1; done
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
t "attack -> on the router in under 3 seconds (was up to 2 minutes)" "$(grep -c "\"address\": \"$A4\"" "$FS") $([ $ms -lt 3000 ] && echo fast)" "1 fast"
echo "     (took $ms ms)"
t "  ... with a time limit and the reason" "$(python3 -c "import json; print([(i['list'], i['timeout']) for i in json.load(open('$FS')) if i['address']=='$A4'])")" "[('ml-ips', '86400s')]"
t "unblock: taken off the router at once" "$(radius-admin ips unblock $A4 | grep -c 'unblocked now') $(grep -c "$A4" "$FS")" "1 0"
t "block by hand: on the router at once" "$(radius-admin ips block $A5 test | grep -c 'every router now') $(grep -c "$A5" "$FS")" "1 1"
radius-admin ips unblock $A5 >/dev/null
kill $FPID 2>/dev/null; sleep 1
t "router down: the block is still saved (1-minute list), the failure shown" "$(radius-admin ips block $A5 test 2>&1 | grep -c 'within a minute') $(radius-admin ips api list | grep -c 'failed')" "1 1"
radius-admin ips unblock $A5 >/dev/null

# the same for every router by auto-sync: nothing to paste on the routers
RT=/var/lib/mikrotiklover/router/sync.rsc RJ=/etc/mikrotiklover-radius/router-api.json
was_api_auto=$(db "SELECT v FROM ml_setting WHERE k='ips_api_auto'")
radius-admin ips api auto on >/dev/null
t "api auto on: the API user in sync.rsc, only from this server" "$(grep -c 'add name=mlapi group=mikrotiklover-api address=.*/32 password=' $RT)" "1"
t "  ... sync.rsc readable by root and the dashboard only (it has the password)" "$(stat -c %a $RT)" "640"
t "  ... RouterOS script check passes" "$(python3 "$HERE/lint-rsc.py" $RT | grep -c '^ok')" "1"
t "  ... every router in the server's list, the hand-made one left as it was" \
  "$(python3 -c "import json; d=json.load(open('$RJ')); print(d['127.0.0.1'].get('auto', False), all(v.get('auto') for k, v in d.items() if k != '127.0.0.1'), len(d) > 1)")" "False True True"
tag1=$(grep -o 'MikrotikLover IPS auto [0-9a-f]*' $RT | head -1)
radius-admin ips api auto new-password >/dev/null
t "new password: the routers set it again (new marker)" "$([ "$(grep -o 'MikrotikLover IPS auto [0-9a-f]*' $RT | head -1)" != "$tag1" ] && echo changed)" "changed"
radius-admin ips api auto off >/dev/null
t "api auto off: the routers remove only the auto-sync user" "$(grep -c 'remove \[find name="mlapi" comment~"^MikrotikLover IPS auto"\]' $RT) $(grep -c 'add name=mlapi' $RT)" "1 0"
t "  ... auto routers gone from the list, the hand-made one stays" "$(python3 -c "import json; print(sorted(json.load(open('$RJ'))))")" "['127.0.0.1']"
db "REPLACE INTO ml_setting (k, v) VALUES ('ips_api_auto', '${was_api_auto:-}')"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ipst.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ipst.json')); print($1)"; }
    t "API: status, switches, alerts in plain words" "$(api GET '/api/ips?days=1')$(js "d['status']['running'], d['settings']['on'], [r['words'] for r in d['rows'] if r['src_ip']=='$A2']")" "200True True ['Break-in attempt (exploit)']"
    t "API: blocked list" "$(js "[b['ip'] for b in d['blocks'] if b['ip'].startswith('185.244.25.')]")" "['$A2']"
    t "API: signature off / on" "$(api POST /api/ips/rule '{"sid":"9100008","on":false}')$(api GET '/api/ips?days=1')$(js "[t['off'] for t in d['top'] if t['sid']==9100008]")$(api POST /api/ips/rule '{"sid":"9100008","on":true}')" "200200[True]200"
    t "API: block, unblock, level, hours" "$(api POST /api/ips/block "{\"ip\":\"$A1\"}")$(api POST /api/ips/unblock "{\"ip\":\"$A1\"}")$(api POST /api/ips/level '{"level":"medium"}')$(api POST /api/ips/level '{"level":"high"}')$(api POST /api/ips/hours '{"hours":"24"}')" "200200200200200"
    t "API: bad input 400 / 404" "$(api POST /api/ips/level '{"level":"x"}')$(api POST /api/ips/block '{"ip":"a;b"}')$(api POST /api/ips/explode)" "400400404"
    t "API: instant-block routers listed with status" "$(api GET '/api/ips?days=1')$(js "[(r['ip'], r['status'][:6]) for r in d['api_routers']]")" "200[('127.0.0.1', 'failed')]"
    t "API: add a router -> the script to paste" "$(api POST /api/ips/api-add '{"router":"127.0.0.1"}')$(js "'/user add name=mlapi' in d['script']")" "200True"
    t "API: test (router down) -> 400 with why; remove" "$(api POST /api/ips/api-test '{"router":"127.0.0.1"}')$(api POST /api/ips/api-del '{"router":"127.0.0.1"}')" "400200"
    t "API: bad router address 400" "$(api POST /api/ips/api-add '{"router":"x;y"}')" "400"
    t "API: auto-sync switch on / off" "$(api POST /api/ips/api-auto '{"on":true}')$(api GET '/api/ips?days=1')$(js "str(d['settings']['api_auto']) + ' ' + str(any(r.get('auto') for r in d['api_routers']))")$(api POST /api/ips/api-auto '{"on":false}')" "200200True True200"
    db "REPLACE INTO ml_setting (k, v) VALUES ('ips_api_auto', '${was_api_auto:-}')"
    rm -f "$jar" /tmp/ipst.json
fi
radius-admin ips api del 127.0.0.1 >/dev/null 2>&1; rm -f "$FS"
[ "$fails" = 0 ] && echo "all IPS server tests passed" || { echo "$fails FAILED"; exit 1; }
