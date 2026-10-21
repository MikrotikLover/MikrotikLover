#!/usr/bin/env bash
# "Only these apps": several allow-only profiles in one policy, editable profiles, learning from the DNS log.
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-allowonly.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
AO=/var/lib/mikrotiklover/allowonly S=/var/lib/mikrotiklover/router/sync.rsc DNSLOG=/var/log/mikrotik/dns.log DEV=10.99.0.33
cleanup() {
    radius-admin user del ao-user >/dev/null 2>&1
    rm -f /var/lib/mikrotiklover/policies/ao-test.txt "$AO/ao-cams.txt" "$AO/ao-learned.txt"
    [ -f "$DNSLOG" ] && sed -i "/ from $DEV\$/d" "$DNSLOG"
    db "DELETE FROM radacct WHERE acctuniqueid='aot-1'"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
t "shipped profiles are editable copies" "$(ls $AO | grep -c '^\(whatsapp\|hikconnect\)\.txt$')" "2"
t "list shows who uses them" "$(radius-admin allowonly list | grep -c 'hikconnect .*used by: whatsapp-hikconnect')" "1"
printf '# Profile: cameras at the shop\ndomain hik-connect.com\nnet @lan\nnet 203.0.113.25\nhost shopnvr.ddns.net\n' | radius-admin allowonly set ao-cams >/dev/null
t "own profile saved" "$(grep -c 'host shopnvr.ddns.net' $AO/ao-cams.txt)" "1"
t "bad line refused, old text kept" "$(printf 'domain bad_name\n' | radius-admin allowonly set ao-cams 2>&1 | grep -c 'bad domain')$(grep -c 'host shopnvr' $AO/ao-cams.txt)" "11"
t "bad directive refused" "$(printf 'open everything\n' | radius-admin allowonly set ao-cams 2>&1 | grep -c 'unknown directive')" "1"
printf '# test\nallow-only whatsapp\nallow-only ao-cams\n' | radius-admin policy set ao-test >/dev/null
t "policy: both apps, then the rest refused" "$(grep -c 'chain=wfp-ao-test action=jump jump-target=ao-ao-cams' $S)$(grep -c 'chain=wfp-ao-test action=jump jump-target=ao-whatsapp' $S)$(grep -c 'chain=wfp-ao-test protocol=tcp action=reject reject-with=tcp-reset comment="wfpolicy:ao-test allow-only: block rest"' $S)" "111"
t "app chains return (do not refuse) inside a policy" "$(grep -c 'add chain=ao-ao-cams action=return' $S)" "1"
t "domain line: one router DNS entry per name fills mlname-NAME (every subdomain)" "$(grep -c 'add name=hik-connect.com match-subdomain=yes type=FWD forward-to=$up address-list=mlname-hik-connect.com' $S)" "1"
t "  ... and the app chain lets that list through" "$(grep -c 'add chain=ao-ao-cams dst-address-list=mlname-hik-connect.com action=accept' $S)" "1"
t "@lan, net and host in the list" "$(grep -c 'list=ao-cams-servers address=192.168.0.0/16' $S)$(grep -c 'list=ao-cams-servers address=203.0.113.25' $S)$(grep -c 'list=ao-cams-servers address=shopnvr.ddns.net' $S)" "111"
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
t "used profile cannot be deleted" "$(radius-admin allowonly del ao-cams 2>&1 | grep -c 'used by policy')" "1"
# learning from the DNS log
now=$(date -u +%Y-%m-%dT%H:%M:%S.00+00:00)
for n in api.hik-connect.com litedev.sgp.hik-connect.com connectivitycheck.gstatic.com api.hik-connect.com; do
    echo "$now 127.0.0.1 dnsmasq[1]: query[A] $n from $DEV" >> "$DNSLOG"
done
echo "$(date -u -d '-3 hours' +%Y-%m-%dT%H:%M:%S.00+00:00) 127.0.0.1 dnsmasq[1]: query[A] old.example.org from $DEV" >> "$DNSLOG"
out=$(radius-admin allowonly learn $DEV 10)
t "learn: the app's site, with its names and count" "$(grep -c '^\* hik-connect.com .* 3x  api.hik-connect.com, litedev.sgp.hik-connect.com' <<<"$out")" "1"
t "learn: phone background marked, not starred" "$(grep -c '^  gstatic.com' <<<"$out")" "1"
t "learn: only the asked time" "$(grep -c old.example.org <<<"$out")" "0"
t "learn: unknown user refused" "$(radius-admin allowonly learn nosuchuser9 2>&1 | grep -c 'not online')" "1"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ao.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ao.json')); print($1)"; }
    t "API: profiles with users" "$(api GET /api/allowonly)$(js "[p['used_by'] for p in d['profiles'] if p['name']=='ao-cams']")" "200[['ao-test']]"
    t "API: learn" "$(api GET "/api/allowonly/learn?who=$DEV&minutes=10")$(js "[(g['site'], g['background']) for g in d['sites']]")" "200[('hik-connect.com', False), ('gstatic.com', True)]"
    t "API: save a learned profile" "$(api POST /api/allowonly '{"name":"ao-learned","text":"# Profile: learned\ndomain hik-connect.com\n"}')$(grep -c 'domain hik-connect.com' $AO/ao-learned.txt)" "2001"
    t "API: bad text 400" "$(api POST /api/allowonly '{"name":"ao-learned","text":"domain x\u0000"}')" "400"
    t "API: bad name 400" "$(api POST /api/allowonly '{"name":"../x","text":"domain a.com"}')" "400"
    t "API: delete unused" "$(api DELETE /api/allowonly/ao-learned)$(ls $AO/ao-learned.txt 2>/dev/null | wc -l)" "2000"
    radius-admin user add ao-user -p Pass1234 >/dev/null; radius-admin user policy ao-user ao-test >/dev/null
    t "API finder: camera cloud allowed for the two-app policy" "$(api GET '/api/why?site=api.hik-connect.com&user=ao-user')$(js "d['verdict']")" "200allowed"
    t "API finder: the rest blocked, both apps named" "$(api GET '/api/why?site=www.youtube.com&user=ao-user')$(js "d['verdict'], 'whatsapp + ao-cams' in d['summary']")" "200blocked True"
    rm -f "$jar" /tmp/ao.json
fi
[ "$fails" = 0 ] && echo "all allow-only tests passed" || { echo "$fails FAILED"; exit 1; }
