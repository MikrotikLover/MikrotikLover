#!/usr/bin/env bash
# Block page tests on an installed server (root, database, nginx). A second address on lo plays the user's device.
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-blockpage.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
DEV=10.99.0.7 OTHER=10.99.0.8
ip addr add $DEV/32 dev lo 2>/dev/null; ip addr add $OTHER/32 dev lo 2>/dev/null
was=$(db "SELECT v FROM ml_setting WHERE k='blockpage_on'"); sip=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")
cleanup() {
    radius-admin user del bp-user >/dev/null 2>&1
    db "DELETE FROM radacct WHERE acctuniqueid LIKE 'bpt-%'; DELETE FROM ml_block_event WHERE ip IN ('$DEV','$OTHER');
        REPLACE INTO ml_setting (k, v) VALUES ('blockpage_on', '${was:-0}')"
    rm -f /var/lib/mikrotiklover/policies/bp-test.txt
    sed -i '/bp-allowed.example/d' /etc/hosts
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
radius-admin user add bp-user -p Pass1234 >/dev/null
printf '# test\nblock-app TikTok\nblock gaming time=0s-1s\n' > /var/lib/mikrotiklover/policies/bp-test.txt
radius-admin user policy bp-user bp-test >/dev/null 2>&1 || db "INSERT INTO radreply (username, attribute, op, value) VALUES ('bp-user','Mikrotik-Address-List',':=','policy-bp-test')"
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctupdatetime) VALUES ('b1','bpt-1','bp-user','127.0.0.1','$DEV',NOW(),NOW())"
echo "93.184.215.14 bp-allowed.example" >> /etc/hosts
req() { curl -s --interface "$1" -m 15 -H "Host: $2" -H "Accept: ${4:-text/html}" -o /tmp/bp.out -w '%{http_code}' "http://127.0.0.1:8082${3:-/}"; }

# ---- router part
[ -n "$sip" ] || radius-admin security quarantine-server 192.168.88.10 >/dev/null
radius-admin blockpage off >/dev/null
t "off: no redirect on the routers" "$(grep -c 'to-ports=8082' /var/lib/mikrotiklover/router/sync.rsc)" "0"
radius-admin blockpage on >/dev/null
S=/var/lib/mikrotiklover/router/sync.rsc
t "on: port 80 of the policy's users to :8082" "$(grep -c 'src-address-list=policy-bp-test dst-address-list=!ml-private protocol=tcp dst-port=80 action=dst-nat' $S)" "1"
t "LAN / private addresses never redirected" "$(grep -c 'list=ml-private address=192.168.0.0/16' $S)" "1"
t "netwatch turns it off when the server is down" "$(grep -c 'down-script="/ip firewall nat disable \[find comment=\\"mlblockpage\\"\]"' $S)" "1"
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"

# ---- the proxy
t "blocked site: block page (403)" "$(req $DEV www.tiktok.com /@x)" "403"
code=$(grep -o 'class="ref">[A-Z0-9]*' /tmp/bp.out | cut -d'>' -f2)
t "  ... with reason, rule and a 6-letter code" "$(grep -c 'belongs to the app TikTok' /tmp/bp.out)$(grep -c 'block-app TikTok' /tmp/bp.out)${#code}" "116"
t "  ... code saved for the admin" "$(db "SELECT CONCAT(username,'|',host,'|',path,'|',policy) FROM ml_block_event WHERE code='$code'")" "bp-user|www.tiktok.com|/@x|bp-test"
req $DEV www.tiktok.com /again >/dev/null
t "same site again soon: same code (no flood)" "$(grep -o 'class="ref">[A-Z0-9]*' /tmp/bp.out | cut -d'>' -f2)" "$code"
t "image of a blocked site: short answer, no page" "$(req $DEV www.tiktok.com /x.png image/png)$(cat /tmp/bp.out)" "403blocked"
t "page shows the user's network name / logo area" "$(req $DEV www.tiktok.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/bp.out)" "1"
t "rule outside its time: not blocked (goes on)" "$(req $DEV www.pubg.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/bp.out)" "0"
t "device without a policy: not blocked" "$(req $OTHER www.tiktok.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/bp.out)" "0"
t "allowed site goes on to the real server (not our page)" "$(req $OTHER bp-allowed.example / >/dev/null; grep -c 'Yeh website band hai\|cannot be opened' /tmp/bp.out)" "0"
t "Host: localhost refused (no way into the server)" "$(req $DEV localhost /)$(grep -c 'cannot be opened' /tmp/bp.out)" "4031"
t "Host: private address refused" "$(req $DEV 10.0.0.1 /)" "403"
t "Host: server's own port refused" "$(req $DEV 127.0.0.1:8099 /api/health)" "403"
if [ -n "${URL:-}" ]; then
    t "check endpoint needs nginx's key" "$(curl -sk -o /dev/null -w '%{http_code}' -H 'X-ML-Host: www.tiktok.com' "$URL/internal/blockcheck")" "404"
    t "page endpoint needs nginx's key" "$(curl -sk -o /dev/null -w '%{http_code}' -H 'X-ML-Block: wrong' "$URL/internal/blockpage")" "404"
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/bp.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: look up the code" "$(api GET /api/why/ref/${code,,})$(python3 -c 'import json; e=json.load(open("/tmp/bp.json"))["event"]; print(e["username"], e["rule"])')" "200bp-user block-app TikTok"
    t "API: unknown code 404" "$(api GET /api/why/ref/ZZZZZ9)" "404"
    t "API: bad code 400" "$(api GET /api/why/ref/abc)" "400"
    t "API: status" "$(api GET /api/blockpage)$(python3 -c 'import json; d=json.load(open("/tmp/bp.json")); print(d["on"], d["today"] >= 1)')" "200True True"
    t "API: preview page" "$(api GET /api/blockpage/preview)$(grep -c 'class="ref">AB3K7Q' /tmp/bp.json)" "2001"
    t "API: turn off" "$(api POST /api/blockpage '{"on":false}')$(db "SELECT v FROM ml_setting WHERE k='blockpage_on'")" "2000"
    rm -f "$jar"
fi
t "CLI: blockpage ref" "$(radius-admin blockpage ref $code | grep -c 'www.tiktok.com')" "1"
t "CLI: bad code refused" "$(radius-admin blockpage ref 12 2>&1 | grep -c usage)" "1"
rm -f /tmp/bp.out /tmp/bp.json
[ "$fails" = 0 ] && echo "all block page tests passed" || { echo "$fails FAILED"; exit 1; }
