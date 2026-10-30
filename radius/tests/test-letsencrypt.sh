#!/usr/bin/env bash
# Public certificate (Let's Encrypt) end to end against Pebble, Let's Encrypt's own test server: a real ACME order with
# the HTTP-01 check through nginx port 80, the certificate in nginx (public name) and FreeRADIUS (Wi-Fi login checked
# like a phone with "Use system certificates"), routers still on the own CA, connect guide, router DNS name, renew,
# import of a bought certificate, back to own.
#   PEBBLE_DIR=/path/with/pebble+pebble-challtestsrv PEBBLE_CERTS=/path/to/pebble/test/certs sudo -E bash tests/test-letsencrypt.sh
#   (skipped when Pebble is not there)
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
PD=${PEBBLE_DIR:-} PC=${PEBBLE_CERTS:-}
[ -x "$PD/pebble" ] && [ -x "$PD/pebble-challtestsrv" ] && [ -f "$PC/pebble.minica.pem" ] || { echo "skip: Pebble not found (PEBBLE_DIR, PEBBLE_CERTS)"; echo "all Let's Encrypt tests passed (skipped)"; exit 0; }
# shellcheck disable=SC1091
. /etc/mikrotiklover-radius/radius.conf
DOM=wifi.ml-test.org WEB=https://127.0.0.1:${WEB_PORT:-8443} CD=/etc/freeradius/3.0/certs/mikrotiklover
W=$(mktemp -d); ROOTF=/usr/local/share/ca-certificates/ml-test-pebble.crt
was_sip=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")
cleanup() {
    radius-admin cert own >/dev/null 2>&1
    db "DELETE FROM ml_setting WHERE k IN ('public_domain','acme_email','acme_method','acme_server','cert_mode')"
    radius-admin user del le-test >/dev/null 2>&1
    rm -rf /etc/mikrotiklover-radius/acme "$CD/public" "$ROOTF"; update-ca-certificates --fresh >/dev/null 2>&1
    [ -n "${PPID1:-}" ] && kill "$PPID1" "$PPID2" 2>/dev/null
    radius-admin policy build >/dev/null 2>&1; rm -rf "$W"
}
trap cleanup EXIT
rm -rf /etc/mikrotiklover-radius/acme

# ---- Pebble: ACME server on :14000, its DNS answers every name with 127.0.0.1, HTTP-01 checks go to port 80
cat > "$W/pebble.json" <<J
{"pebble": {"listenAddress": "127.0.0.1:14000", "managementListenAddress": "127.0.0.1:15000",
 "certificate": "$PC/localhost/cert.pem", "privateKey": "$PC/localhost/key.pem", "httpPort": 80, "tlsPort": 5001,
 "ocspResponderURL": "", "externalAccountBindingRequired": false}}
J
"$PD/pebble-challtestsrv" -defaultIPv4 127.0.0.1 -defaultIPv6 "" -dns01 127.0.0.1:8053 -http01 "" -https01 "" -tlsalpn01 "" -doh "" -management :8055 >/dev/null 2>&1 & PPID2=$!
PEBBLE_VA_NOSLEEP=1 "$PD/pebble" -config "$W/pebble.json" -dnsserver 127.0.0.1:8053 >"$W/pebble.log" 2>&1 & PPID1=$!
for i in $(seq 1 30); do curl -s --cacert "$PC/pebble.minica.pem" https://localhost:14000/dir >/dev/null && break; sleep 0.5; done
export LEGO_CA_CERTIFICATES=$PC/pebble.minica.pem

t "bad name / email / no method refused" \
  "$(radius-admin cert letsencrypt 'x;y' --email a@b.co --http 2>&1 | grep -c usage)$(radius-admin cert letsencrypt $DOM --email bad --http 2>&1 | grep -c email)$(radius-admin cert letsencrypt $DOM --email it@ml-test.org 2>&1 | grep -c 'choose how')" "111"
out=$(radius-admin cert letsencrypt $DOM --email it@ml-test.org --http --server https://localhost:14000/dir 2>&1)
t "Let's Encrypt (Pebble): HTTP-01 check through nginx port 80, certificate in use" "$(grep -c "certificate for $DOM from Let's Encrypt is in use" <<<"$out")" "1"
[ "$fails" = 0 ] || { echo "$out" | tail -5; tail -5 "$W/pebble.log"; }
st=$(radius-admin cert status)
t "status: public, issued by Pebble, for the name" "$(grep -c "public — $DOM" <<<"$st") $(grep -c 'Issued by.*Pebble' <<<"$st") $(grep -c "Names *: $DOM" <<<"$st")" "1 1 1"
iss() { echo | openssl s_client -connect 127.0.0.1:${WEB_PORT:-8443} -servername "$1" 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null; }
t "dashboard by the public name: the public certificate" "$(iss $DOM | grep -c Pebble)" "1"
t "routers' name (auto-sync): still the own CA — nothing changes on the routers" "$(iss "$RADIUS_DOMAIN" | grep -c 'MikrotikLover RADIUS CA\|RADIUS CA')" "1"
t "FreeRADIUS gives Wi-Fi clients the public certificate" "$(readlink "$CD/eap.pem")" "public/fullchain.pem"
# a phone with "Use system certificates": Pebble's root stands in for a public root in the system list
curl -s --cacert "$PC/pebble.minica.pem" https://localhost:15000/roots/0 > "$ROOTF"; update-ca-certificates >/dev/null 2>&1
radius-admin user add le-test -p 'Le-Test-123' >/dev/null
t "Wi-Fi login (PEAP) checked like Android 'Use system certificates' + Domain $DOM" "$(radius-admin test le-test 'Le-Test-123' --peap 2>&1 | grep -c 'PEAP-MSCHAPv2 login OK')" "1"
t "connect guide: system certificates, Domain = the public name" "$(curl -sk $WEB/api/public/connect | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["cert_public"], d["radius_domain"])')" "True $DOM"
db "REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '192.168.88.10')"; radius-admin policy build >/dev/null
t "routers point the public name to this server (LAN DNS)" "$(grep -c "add name=$DOM address=192.168.88.10 comment=\"mlsync: public name\"" /var/lib/mikrotiklover/router/sync.rsc)" "1"
t "health check: the Wi-Fi / dashboard certificate and the routers' own one" "$(radius-admin doctor 2>&1 | grep -c "Certificate (Wi-Fi login, dashboard): valid .* (public)\|Certificate (routers' auto-sync, own CA): valid")" "2"
s1=$(openssl x509 -in "$CD/public/fullchain.pem" -noout -serial)
t "renew (forced): new certificate, in use" "$(radius-admin cert renew --force 2>&1 | grep -c "renewed: $DOM") $([ "$s1" != "$(openssl x509 -in "$CD/public/fullchain.pem" -noout -serial)" ] && echo new)" "1 new"
t "  ... Wi-Fi login still fine" "$(radius-admin test le-test 'Le-Test-123' --peap 2>&1 | grep -c 'login OK')" "1"
t "account unknown to the ACME server (moved to another one): a new account, certificate still issued" \
  "$(echo '{"x":1}' > /dev/null; sed -i 's|"uri": "[^"]*"|"uri": "https://localhost:14000/my-account/gone"|' /etc/mikrotiklover-radius/acme/accounts/*/it@ml-test.org/account.json 2>/dev/null; radius-admin cert letsencrypt $DOM --email it@ml-test.org --http --server https://localhost:14000/dir 2>&1 | grep -c 'is in use')" "1"
t "renew when not due: nothing done" "$(radius-admin cert renew 2>&1 | grep -c 'not due yet')" "1"
# a bought certificate: the one Pebble gave, imported by hand; a key that does not belong is refused
cp /etc/mikrotiklover-radius/acme/certificates/$DOM.crt "$W/c.pem"; cp /etc/mikrotiklover-radius/acme/certificates/$DOM.key "$W/k.pem"
openssl genrsa -out "$W/other.key" 2048 2>/dev/null
t "import: wrong key refused" "$(radius-admin cert import "$W/c.pem" "$W/other.key" 2>&1 | grep -c 'does not belong')" "1"
t "import: certificate + chain + key in use" "$(radius-admin cert import "$W/c.pem" "$W/k.pem" 2>&1 | grep -c "certificate for $DOM in use") $(radius-admin cert status | grep -c 'renew it yourself\|by you')" "1 1"
t "back to own CA: Wi-Fi + dashboard on the own certificate again" "$(radius-admin cert own 2>&1 | grep -c 'back to the own') $(readlink "$CD/eap.pem") $(iss $DOM | grep -c Pebble)" "1 server.pem 0"
t "  ... connect guide back to the own CA" "$(curl -sk $WEB/api/public/connect | python3 -c 'import json,sys; print(json.load(sys.stdin)["cert_public"])')" "False"
db "REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '${was_sip:-}')"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: status (own)" "$(api GET /api/cert)$(python3 -c "import json; print(json.load(open('$W/a.json'))['mode'])")" "200own"
    body=$(python3 -c "import json; print(json.dumps({'fullchain': open('$W/c.pem').read(), 'key': open('$W/k.pem').read()}))")
    t "API: import a certificate, then back to own" "$(api POST /api/cert/import "$body")$(api GET /api/cert)$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['mode'], d['domain'])")$(api POST /api/cert/own '{}')" "200200public ${DOM}200"
    t "API: bad input refused" "$(api POST /api/cert/import '{"fullchain":"x","key":"y"}')$(api POST /api/cert/letsencrypt '{"domain":"a;b","email":"x@y.co","method":"http"}')$(api POST /api/cert/letsencrypt "{\"domain\":\"$DOM\",\"email\":\"x@y.co\",\"method\":\"ftp\"}")" "400400400"
    rm -f "$jar"
fi
[ "$fails" = 0 ] && echo "all Let's Encrypt tests passed" || { echo "$fails FAILED"; exit 1; }
