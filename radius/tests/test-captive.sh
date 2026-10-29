#!/usr/bin/env bash
# Captive portal API (RFC 8908 / 8910): the phone gets the API address by DHCP (option 114 on the hotspot networks, set by
# auto-sync), asks it before and after the login, and is sent to the hotspot login page by an https page. Only with a
# public certificate (phones only follow an https address they trust).
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-captive.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
. /etc/mikrotiklover-radius/radius.conf
WEB=https://127.0.0.1:${WEB_PORT:-8443} R=/var/lib/mikrotiklover/router/sync.rsc DOM=wifi.ml-test.org W=$(mktemp -d)
was_sip=$(db "SELECT v FROM ml_setting WHERE k='server_ip'"); was_on=$(db "SELECT v FROM ml_setting WHERE k='captive_api'")
cleanup() {
    radius-admin user del cp-user >/dev/null 2>&1; radius-admin plan del cp-plan >/dev/null 2>&1
    db "DELETE FROM radacct WHERE acctsessionid LIKE 'cp-%'; REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '${was_sip:-}'), ('captive_api', '${was_on:-}')"
    radius-admin cert own >/dev/null 2>&1; db "DELETE FROM ml_setting WHERE k IN ('public_domain','acme_method','cert_mode')"
    rm -rf "$W" /etc/freeradius/3.0/certs/mikrotiklover/public; radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
db "REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '192.168.88.10')"; db "DELETE FROM ml_setting WHERE k='captive_api'"
api() { curl -sk "$WEB/api/public/captive"; }
js() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# ---- own certificate: no option 114 (phones would not trust the https address)
radius-admin cert own >/dev/null 2>&1; radius-admin policy build >/dev/null
t "own certificate: routers get no option 114, an old one is taken away" "$(grep -c 'add name=ml-captive' $R) $(grep -c 'option remove \[find name="ml-captive"\]' $R)" "0 1"
t "  ... the API has no https login address to give" "$(api | js "d['captive'], 'user-portal-url' in d")" "True False"

# ---- public certificate (here a self-made one stands in for Let's Encrypt)
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=$DOM -addext subjectAltName=DNS:$DOM -keyout "$W/k.pem" -out "$W/c.pem" 2>/dev/null
radius-admin cert import "$W/c.pem" "$W/k.pem" >/dev/null; radius-admin policy build >/dev/null
t "public certificate: option 114 = the https API on the hotspot networks" "$(grep -c "add name=ml-captive code=114 value=\"'https://$DOM:${WEB_PORT:-8443}/api/public/captive'\"" $R) $(grep -c 'dhcp-option=($s . "ml-captive")' $R)" "1 1"
t "  ... the phone may reach the API before login (walled garden)" "$(grep -c "add action=accept dst-address=192.168.88.10 protocol=tcp dst-port=${WEB_PORT:-8443} comment=\"mlcaptive\"" $R)" "1"
t "  ... an existing DHCP option list is kept (ml-captive added to it)" "$(grep -c ':foreach x in=$o do={ :set s ($s . $x . ",") }' $R)" "1"
f=$W/s.rsc; cp $R "$f"
t "  ... RouterOS lint ok, RouterOS 6 copy ok" "$(python3 "$HERE/lint-rsc.py" "$f" | grep -c '^ok') $(python3 /usr/local/lib/mikrotiklover/rosv6.py check /var/lib/mikrotiklover/router/sync6.rsc | grep -c '^ok')" "1 1"
out=$(curl -sk -D "$W/h" "$WEB/api/public/captive")
t "not logged in: captive, the login page (https) and the connect guide" \
  "$(js "d['captive'], d['user-portal-url'], d['venue-info-url']" <<<"$out")" "True https://$DOM:${WEB_PORT:-8443}/portal https://$DOM:${WEB_PORT:-8443}/connect"
t "  ... RFC 8908 type, not cached" "$(grep -ci '^content-type: application/captive+json' "$W/h") $(grep -ci '^cache-control:.*no-store' "$W/h")" "1 1"
t "the https login page sends the phone on to the hotspot login" "$(curl -sk "$WEB/portal" | grep -c 'url=http://[^"]*/login')" "1"

# ---- logged in (hotspot session from this address): not captive, time and data left
radius-admin plan add cp-plan --price 1 --validity 1d --quota 2G >/dev/null
radius-admin user add cp-user -p 'Cp-Pass-123' >/dev/null && radius-admin user plan cp-user cp-plan --free >/dev/null
db "UPDATE ml_account SET first_login=NOW(), expires_at=NOW() + INTERVAL 1 DAY, quota_since=NOW() - INTERVAL 1 MINUTE WHERE username='cp-user'"
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctinputoctets, acctoutputoctets)
    VALUES ('cp-1', 'cp-1', 'cp-user', '127.0.0.1', '127.0.0.1', NOW(), 500000000, 500000000)"
out=$(api)
t "logged in: not captive" "$(js "d['captive']" <<<"$out")" "False"
t "  ... time left (about a day) and data left (2 GB - 1 GB used)" "$(js "80000 < d['seconds-remaining'] <= 86400, d['bytes-remaining'] == 2*1024**3 - 1000000000" <<<"$out")" "True True"
db "UPDATE radacct SET acctinputoctets=3000000000 WHERE acctsessionid='cp-1'"
t "data used up: captive again (login page)" "$(api | js "d['captive']")" "True"
db "DELETE FROM radacct WHERE acctsessionid='cp-1'"

# ---- off
t "off: routers take option 114 away" "$(radius-admin captive off | grep -c 'captive portal API off') $(grep -c 'add name=ml-captive' $R) $(grep -c 'option remove \[find name="ml-captive"\]' $R)" "1 0 1"
t "status" "$(radius-admin captive status | grep -c 'Captive portal API : off')" "1"
radius-admin captive on >/dev/null
if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    capi() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: switch off / on (shown with the certificate)" \
      "$(capi POST /api/captive '{"on":false}')$(capi GET /api/cert)$(python3 -c "import json; print(json.load(open('$W/a.json'))['captive'])")$(capi POST /api/captive '{"on":true}')$(capi GET /api/cert)$(python3 -c "import json; print(json.load(open('$W/a.json'))['captive'])")" "200200False200200True"
    rm -f "$jar"
fi
[ "$fails" = 0 ] && echo "all captive portal tests passed" || { echo "$fails FAILED"; exit 1; }
