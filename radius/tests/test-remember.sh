#!/usr/bin/env bash
# "Remember this device" through the real FreeRADIUS (radclient like a MikroTik hotspot with login-by=mac,http-chap):
# a password login remembers the phone's MAC; next time the MAC login is that user (plan, policy, quota, expiry, speed);
# accounting is booked for the user; a MAC typed on another device, an unknown / forgotten / old MAC, a disabled or
# expired user and the switch being off all fall back to the login page; devices per user; password change forgets.
#   sudo bash tests/test-remember.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-remember.sh    (+ dashboard API)
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
SECRET=$(. /etc/mikrotiklover-radius/radius.conf; echo "$LOCAL_SECRET")
P1=5E:11:22:33:44:01 P2=5E:11:22:33:44:02 P3=5E:11:22:33:44:03 PV=5E:11:22:33:44:09
was=$(db "SELECT CONCAT(IFNULL((SELECT v FROM ml_setting WHERE k='remember_on'),'0'),',',IFNULL((SELECT v FROM ml_setting WHERE k='remember_days'),'30'),',',IFNULL((SELECT v FROM ml_setting WHERE k='remember_max'),'2'))")
cleanup() {
    for u in rm-ali rm-old $(db "SELECT username FROM ml_account WHERE plan='rm-plan'"); do radius-admin user del "$u" >/dev/null 2>&1; done
    radius-admin mac del AA:BB:CC:17:00:01 >/dev/null 2>&1
    db "DELETE FROM ml_account WHERE plan='rm-plan'; DELETE FROM ml_voucher_batch WHERE plan='rm-plan'; DELETE FROM ml_plan WHERE name='rm-plan';
        DELETE FROM radgroupreply WHERE groupname='rm-plan'; DELETE FROM radgroupcheck WHERE groupname='rm-plan'; DELETE FROM radgroup_meta WHERE groupname='rm-plan';
        DELETE FROM ml_remember WHERE mac LIKE '5E-11-22-33-44-%'; DELETE FROM radacct WHERE acctsessionid LIKE 'rm-%'; DELETE FROM ml_sale WHERE plan='rm-plan'"
    IFS=, read -r a b c <<<"$was"; db "REPLACE INTO ml_setting (k, v) VALUES ('remember_on','$a'), ('remember_days','$b'), ('remember_max','$c')"
}
trap cleanup EXIT
cleanup

# hotspot request -> "accept|<User-Name in reply>|<address list>|<rate>" or "reject|<message>"
req() { # user password calling-station-id
    local out; out=$(printf 'User-Name = "%s"\nUser-Password = "%s"\nCalling-Station-Id = "%s"\nNAS-IP-Address = 127.0.0.1\nService-Type = Login-User\n' "$1" "$2" "$3" \
        | radclient -x -r 1 -t 3 127.0.0.1:1812 auth "$SECRET" 2>&1)
    if grep -q '^Received Access-Accept' <<<"$out"; then
        echo "accept|$(sed -n '/^Received/,$p' <<<"$out" | grep -o 'User-Name = "[^"]*"' | sed 's/.*= "//; s/"$//')|$(grep -o 'Mikrotik-Address-List = "[^"]*"' <<<"$out" | sed 's/.*= "//; s/"$//')|$(grep -o 'Mikrotik-Rate-Limit = "[^"]*"' <<<"$out" | sed 's/.*= "//; s/"$//')"
    else echo "reject|$(grep -o 'Reply-Message = "[^"]*"' <<<"$out" | sed 's/.*= "//; s/"$//')"; fi
}
mac() { req "$1" "" "$1"; }    # a MAC login: the router sends the MAC as the name (mac-as-username)
acct() { printf 'Acct-Status-Type = Start\nUser-Name = "%s"\nCalling-Station-Id = "%s"\nFramed-IP-Address = 192.168.170.%s\nAcct-Session-Id = "rm-%s"\nNAS-IP-Address = 127.0.0.1\n' "$1" "$2" "$3" "$3" \
           | radclient -r 1 -t 3 127.0.0.1:1813 acct "$SECRET" >/dev/null 2>&1; }

radius-admin plan add rm-plan --price 100 --validity 30d --rate 4M/4M --policy no-video >/dev/null
radius-admin user add rm-ali -p 'Rm-Pass-123' >/dev/null && radius-admin user plan rm-ali rm-plan --free >/dev/null
radius-admin remember max 2 >/dev/null; radius-admin remember days 30 >/dev/null

echo "-- off"
radius-admin remember off >/dev/null
t "switch off: a password login works, nothing is remembered" "$(req rm-ali Rm-Pass-123 $P1 | cut -d'|' -f1)$(db "SELECT COUNT(*) FROM ml_remember WHERE username='rm-ali'")" "accept0"
t "switch off: the MAC login is refused (login page shows)" "$(mac $P1 | cut -d'|' -f1)" "reject"

echo "-- on"
radius-admin remember on >/dev/null
t "unknown phone: MAC login refused -> the login page" "$(mac $P1 | cut -d'|' -f1)" "reject"
t "one login with the password: in, and the phone is remembered" "$(req rm-ali Rm-Pass-123 $P1 | cut -d'|' -f1) $(db "SELECT username FROM ml_remember WHERE mac='5E-11-22-33-44-01'")" "accept rm-ali"
t "next time by MAC: in as rm-ali, with the plan's policy and speed" "$(mac $P1)" "accept|rm-ali|policy-no-video|4M/4M"
t "the MAC in any format (aabb.ccdd.eeff) is the same phone" "$(req 5e11.2233.4401 "" $P1 | cut -d'|' -f1-2)" "accept|rm-ali"
t "the MAC typed as a name on another device: refused" "$(req $P1 "" 5E:99:99:99:99:99 | cut -d'|' -f1)" "reject"
acct 5E-11-22-33-44-01 5E-11-22-33-44-01 21
t "accounting of the MAC session is booked for rm-ali (quota, data, online)" "$(db "SELECT username FROM radacct WHERE acctsessionid='rm-21'")" "rm-ali"

echo "-- devices per user"
req rm-ali Rm-Pass-123 $P2 >/dev/null; sleep 1; req rm-ali Rm-Pass-123 $P3 >/dev/null
t "a 3rd phone with max 2: the oldest is forgotten" "$(db "SELECT GROUP_CONCAT(RIGHT(mac,2) ORDER BY mac) FROM ml_remember WHERE username='rm-ali'")" "02,03"
t "  ... the forgotten phone sees the login page again" "$(mac $P1 | cut -d'|' -f1)" "reject"
t "remember list shows them, random MAC marked" "$(radius-admin remember list rm-ali | grep -c 'random')" "2"

echo "-- when the user may not be online"
radius-admin user disable rm-ali >/dev/null
t "disabled user: the remembered phone is refused too" "$(mac $P2 | cut -d'|' -f1)" "reject"
radius-admin user enable rm-ali >/dev/null
radius-admin user expiry rm-ali "$(date -d 'yesterday' +%F)" >/dev/null 2>&1 || db "UPDATE ml_account SET expires_at=NOW() - INTERVAL 1 DAY WHERE username='rm-ali'"
t "expired package: refused with the reason (hotspot shows it)" "$(mac $P2)" "reject|$(req rm-ali Rm-Pass-123 $P2 | cut -d'|' -f2)"
t "  ... (and the reason is the expiry)" "$(mac $P2 | grep -ci 'expired')" "1"
db "UPDATE ml_account SET expires_at=NOW() + INTERVAL 10 DAY WHERE username='rm-ali'"
db "UPDATE ml_remember SET last_seen=NOW() - INTERVAL 31 DAY WHERE mac='5E-11-22-33-44-03'"
t "not seen for more than 30 days: password once more" "$(mac $P3 | cut -d'|' -f1)" "reject"
radius-admin user passwd rm-ali -p 'Rm-New-456' >/dev/null
t "password changed: all remembered phones forgotten" "$(db "SELECT COUNT(*) FROM ml_remember WHERE username='rm-ali'") $(mac $P2 | cut -d'|' -f1)" "0 reject"

echo "-- other kinds of login are not touched"
radius-admin mac add AA:BB:CC:17:00:01 -d "rm printer" >/dev/null
t "a MAC device (mac add) logs in as itself, never remembered for a user" "$(mac AA:BB:CC:17:00:01 | cut -d'|' -f1-2)$(db "SELECT COUNT(*) FROM ml_remember WHERE mac='AA-BB-CC-17-00-01'")" "accept|0"
PIN=$(radius-admin voucher create rm-plan 1 --pin | awk '/^   [A-Za-z0-9]+ +[A-Za-z0-9]+$/ && $1 != "username" {print $1; exit}')
t "a PIN voucher remembers its phone too; the MAC login is that voucher (its first login was counted once)" \
  "$(req "$PIN" "$PIN" $PV | cut -d'|' -f1) $(mac $PV | cut -d'|' -f2) $(db "SELECT COUNT(*) FROM ml_sale WHERE username='$PIN'")" "accept $PIN 1"
t "wrong password does not remember anything" "$(req rm-ali wrong-pass 5E:11:22:33:44:07 | cut -d'|' -f1)$(db "SELECT COUNT(*) FROM ml_remember WHERE mac='5E-11-22-33-44-07'")" "reject0"
t "forget by user / by MAC" "$(radius-admin remember forget "$PIN" | grep -c forgotten)$(radius-admin remember forget 5E:11:22:33:44:09 2>&1 | grep -c 'not remembered')" "11"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/rm.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    req rm-ali Rm-New-456 $P1 >/dev/null
    t "API: settings + the user's remembered phones" "$(api GET /api/remember)$(python3 -c "import json; d=json.load(open('/tmp/rm.json')); print(d['on'], d['max'], d['days'], [x['mac'] for x in d['devices'] if x['username']=='rm-ali'])")" "200True 2 30 ['5E-11-22-33-44-01']"
    t "API: change settings" "$(api POST /api/remember '{"on":true,"days":"14","max":"3"}')$(db "SELECT CONCAT(v) FROM ml_setting WHERE k='remember_days'")$(db "SELECT v FROM ml_setting WHERE k='remember_max'")" "200143"
    t "API: forget one phone" "$(api POST /api/remember/forget '{"mac":"5E-11-22-33-44-01"}')$(db "SELECT COUNT(*) FROM ml_remember WHERE username='rm-ali'")" "2000"
    t "API: bad values 400" "$(api POST /api/remember '{"days":"0"}')$(api POST /api/remember/forget '{"mac":"x;y"}')" "400400"
    t "API: the user page lists its phones" "$(req rm-ali Rm-New-456 $P2 >/dev/null; api GET /api/users/rm-ali)$(python3 -c "import json; d=json.load(open('/tmp/rm.json')); print([x['mac'] for x in d.get('remembered', [])])")" "200['5E-11-22-33-44-02']"
    rm -f "$jar" /tmp/rm.json
fi
[ "$fails" = 0 ] && echo "all remember-device tests passed" || { echo "$fails FAILED"; exit 1; }
