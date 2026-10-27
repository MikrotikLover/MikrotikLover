#!/usr/bin/env bash
# Policy by MAC for Wi-Fi (WPA-Enterprise) users and MAC devices — no VLAN: real PEAP logins through FreeRADIUS
# (eapol_test, anonymous outer name, phone MACs), the MAC -> policy list in ml-live, the router's MAC|IP report into
# the open session (reports / quarantine by IP), quarantine on top, off / on, dashboard API.
#   sudo bash tests/test-wifipolicy.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-wifipolicy.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
. /etc/mikrotiklover-radius/radius.conf
WEB=${URL:-https://127.0.0.1:8443} K=$(cat /var/lib/mikrotiklover/router/key)
M1=AA:00:11:22:33:01 M2=AA:00:11:22:33:02 M3=AA:00:11:22:33:03 M4=AA:00:11:22:33:04 HS=AA:00:11:22:33:05
was=$(db "SELECT v FROM ml_setting WHERE k='wifi_policy'")
cleanup() {
    for u in wp-own wp-grp wp-none wp-hs; do radius-admin user del "$u" >/dev/null 2>&1; done
    radius-admin mac del $M4 >/dev/null 2>&1
    db "DELETE FROM radgroupreply WHERE groupname='wp-grp'; DELETE FROM radgroupcheck WHERE groupname='wp-grp'; DELETE FROM radusergroup WHERE groupname='wp-grp'"
    db "DELETE FROM ml_eap_identity WHERE mac LIKE 'AA-00-11-22-33-%' OR mac LIKE 'AA:00:11:22:33:%'; DELETE FROM ml_mac_ip WHERE mac LIKE 'AA:00:11:22:33:%';
        DELETE FROM radacct WHERE acctsessionid LIKE 'wp-%'; DELETE FROM ml_quarantine WHERE username LIKE 'wp-%'"
    db "REPLACE INTO ml_setting (k, v) VALUES ('wifi_policy', '${was:-}')"
}
trap cleanup EXIT
cleanup 2>/dev/null

peap() {   # a phone: anonymous outer name, real user inside the tunnel, its MAC as Calling-Station-Id
    local cfg; cfg=$(mktemp)
    printf 'network={\n key_mgmt=WPA-EAP\n eap=PEAP\n identity="%s"\n anonymous_identity="anonymous"\n password="%s"\n phase2="auth=MSCHAPV2"\n ca_cert="/etc/freeradius/3.0/certs/mikrotiklover/ca.pem"\n}\n' "$1" "$2" > "$cfg"
    eapol_test -c "$cfg" -a 127.0.0.1 -s "$LOCAL_SECRET" -t 10 -M "$3" >/dev/null 2>&1 && echo ok || echo failed
    rm -f "$cfg"
}
acct() {   # accounting start like the router's Wi-Fi: "anonymous", the MAC, no IP (or an IP for a hotspot)
    printf 'Acct-Status-Type = Start\nAcct-Session-Id = "%s"\nUser-Name = "%s"\nCalling-Station-Id = "%s"\nNAS-IP-Address = 127.0.0.1\n%s' "$1" "$2" "$3" "${4:+Framed-IP-Address = $4
}" | radclient -r 1 -t 3 127.0.0.1:1813 acct "$LOCAL_SECRET" >/dev/null 2>&1
}
report() { curl -sk -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: text/plain' --data-binary "$2" "$WEB/api/public/router/macip?key=$1"; }

# ---- users: own policy, group policy, no policy; a MAC device with a group policy; a hotspot user
radius-admin group add wp-grp --policy kids >/dev/null
radius-admin user add wp-own -p 'Wp-Pass-123' >/dev/null && radius-admin user policy wp-own staff >/dev/null
radius-admin user add wp-grp -p 'Wp-Pass-123' -g wp-grp >/dev/null
radius-admin user add wp-none -p 'Wp-Pass-123' >/dev/null
radius-admin user add wp-hs -p 'Wp-Pass-123' >/dev/null && radius-admin user policy wp-hs staff >/dev/null
radius-admin mac add $M4 -g wp-grp -d "wp printer" >/dev/null
radius-admin wifipolicy on >/dev/null

t "Wi-Fi logins (PEAP, anonymous outer name, phone MACs) accepted" "$(peap wp-own Wp-Pass-123 $M1) $(peap wp-grp Wp-Pass-123 $M2) $(peap wp-none Wp-Pass-123 $M3)" "ok ok ok"
t "wrong password refused" "$(peap wp-own wrong-pass $M1)" "failed"
L=$(radius-admin wifipolicy list --json)
pol() { python3 -c "import json,sys; d={r['mac']: r for r in json.load(sys.stdin)}; r=d.get('$1'); print(r['user'] + ' ' + ','.join(r['lists']) if r else '-')" <<<"$L"; }
t "own policy by MAC (real user, not 'anonymous')" "$(pol $M1)" "wp-own policy-staff"
t "group's policy by MAC" "$(pol $M2)" "wp-grp policy-kids"
t "no policy: not on the list" "$(pol $M3)" "-"
acct wp-a4 "$M4" "$M4"
L=$(radius-admin wifipolicy list --json)
t "Wi-Fi MAC device (no IP in accounting) gets its group's policy" "$(pol $M4)" "${M4//:/-} policy-kids"
acct wp-hs1 wp-hs $HS 10.66.0.9
L=$(radius-admin wifipolicy list --json)
t "hotspot session (router gave the IP and the list at login) left to the hotspot" "$(pol $HS)" "-"

live=$(curl -sk "$WEB/api/public/router/live.rsc?key=$K")
t "ml-live carries MAC -> list and MAC -> user" "$(grep -c "\"$M1\"=\"policy-staff\"" <<<"$live") $(grep -c "\"$M1\"=\"wp-own\"" <<<"$live")" "1 1"
t "  ... the router looks in DHCP, then ARP (fixed IP set on the device)" \
  "$(grep -c 'lease find where mac-address=$m and status="bound"' <<<"$live") $(grep -c '/ip arp find where mac-address=$m' <<<"$live")" "1 1"
f=$(mktemp --suffix=.rsc); echo "$live" > "$f"
t "  ... RouterOS lint ok, and it runs on RouterOS 6 too" "$(python3 "$HERE/lint-rsc.py" "$f" | grep -c '^ok') $(python3 /usr/local/lib/mikrotiklover/rosv6.py check "$f" | grep -c '^ok')" "1 1"
rm -f "$f"

# ---- the router found the IPs: one by DHCP, one by ARP — the server writes them into the open session
acct wp-a1 anonymous $M1
t "accounting of 'anonymous' booked for the real user" "$(db "SELECT username FROM radacct WHERE acctsessionid='wp-a1'")" "wp-own"
t "router report accepted (bad lines left out)" "$(report "$K" "$M1|192.168.88.201
$M4|192.168.88.204
$HS|192.168.88.205
junk|x
$M2|not-an-ip")" "200"
t "  ... the Wi-Fi session now has the IP (reports, Why blocked?, quarantine know the user)" "$(db "SELECT framedipaddress FROM radacct WHERE acctsessionid='wp-a1'")" "192.168.88.201"
t "  ... the MAC device too" "$(db "SELECT framedipaddress FROM radacct WHERE acctsessionid='wp-a4'")" "192.168.88.204"
t "  ... a hotspot session keeps the IP the router gave it" "$(db "SELECT framedipaddress FROM radacct WHERE acctsessionid='wp-hs1'")" "10.66.0.9"
L=$(radius-admin wifipolicy list --json)
t "  ... still on the list, with the IP and the router" "$(python3 -c "import json,sys; print([(r['ip'], r['router']) for r in json.load(sys.stdin) if r['mac']=='$M1'])" <<<"$L")" "[('192.168.88.201', '127.0.0.1')]"
report "$K" "$M1|192.168.88.211" >/dev/null
t "IP changed (new lease): the session follows" "$(db "SELECT framedipaddress FROM radacct WHERE acctsessionid='wp-a1'")" "192.168.88.211"
t "wrong key refused" "$(report wrong "$M1|1.2.3.4")" "403"

radius-admin security quarantine wp-own "test" >/dev/null 2>&1
L=$(radius-admin wifipolicy list --json)
t "quarantine: the MAC gets the quarantine list (no internet, warning page)" "$(pol $M1)" "wp-own ml-quarantine"
radius-admin security release wp-own >/dev/null 2>&1

radius-admin user policy wp-own no-video >/dev/null
t "policy changed: the next minute's list has the new one" "$(curl -sk "$WEB/api/public/router/live.rsc?key=$K" | grep -c "\"$M1\"=\"policy-no-video\"")" "1"

radius-admin wifipolicy off >/dev/null
live=$(curl -sk "$WEB/api/public/router/live.rsc?key=$K")
t "off: the routers take the MAC entries out, no list sent" "$(grep -c 'remove \[find where comment~"^mlmac"\]' <<<"$live") $(grep -c "$M1" <<<"$live")" "1 0"
radius-admin wifipolicy on >/dev/null

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/wp.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: on, the users with policy and IP" "$(api GET /api/wifipolicy)$(python3 -c "import json; d=json.load(open('/tmp/wp.json')); print(d['on'], [(r['user'], r['ip']) for r in d['rows'] if r['mac']=='$M1'])")" "200True [('wp-own', '192.168.88.211')]"
    t "API: off / on" "$(api POST /api/wifipolicy '{"on":false}')$(db "SELECT v FROM ml_setting WHERE k='wifi_policy'")$(api POST /api/wifipolicy '{"on":true}')$(db "SELECT v FROM ml_setting WHERE k='wifi_policy'")" "20002001"
    rm -f "$jar" /tmp/wp.json
fi
[ "$fails" = 0 ] && echo "all Wi-Fi policy-by-MAC tests passed" || { echo "$fails FAILED"; exit 1; }
