#!/usr/bin/env bash
# The four ways to log in, each with its policy, through the real FreeRADIUS (radclient, like a MikroTik hotspot):
#   1 MAC address (device, no typing)   2 username + password   3 PIN voucher (code = user = password)   4 guest (Social WiFi)
# Checks the answer carries the right policy (Mikrotik-Address-List = policy-NAME), who wins (own > group / plan), that a
# changed policy reaches the next login, that quarantine beats every policy, and that the routers have rules for each list.
#   sudo bash tests/test-login-policies.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-login-policies.sh    (+ dashboard API)
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
SECRET=$(. /etc/mikrotiklover-radius/radius.conf; echo "$LOCAL_SECRET")
P=/var/lib/mikrotiklover/router/webfilter-policies.rsc
MAC1=AA:BB:CC:10:00:01 MAC2=AA:BB:CC:10:00:02 MAC3=AA:BB:CC:10:00:03 GUEST=sw-923009998877
was_social=$(db "SELECT IFNULL((SELECT value FROM radgroupreply WHERE groupname='social-free' AND attribute='Mikrotik-Address-List' LIMIT 1),'')")
had_social=$(db "SELECT COUNT(*) FROM ml_plan WHERE name='social-free'")
# the policy "kids" these checks use (made when the server has none)
. "$(dirname "$0")/lib-kids.sh"
cleanup() {
    kids_cleanup
    for u in lp-pass lp-grpuser lp-own "$GUEST" $(db "SELECT username FROM ml_account WHERE plan='lp-plan'"); do radius-admin user del "$u" >/dev/null 2>&1; done
    for m in $MAC1 $MAC2 $MAC3 AA:BB:CC:10:00:04 AA:BB:CC:10:00:05; do radius-admin mac del "$m" >/dev/null 2>&1; done
    db "DELETE FROM ml_account WHERE plan='lp-plan'; DELETE FROM ml_voucher_batch WHERE plan='lp-plan'; DELETE FROM ml_plan WHERE name='lp-plan'"
    db "DELETE FROM radgroupreply WHERE groupname IN ('lp-plan','lp-grp'); DELETE FROM radgroupcheck WHERE groupname IN ('lp-plan','lp-grp');
        DELETE FROM radusergroup WHERE groupname IN ('lp-plan','lp-grp'); DELETE FROM radacct WHERE nasipaddress='127.0.0.1' AND username LIKE 'lp-%'"
    db "DELETE FROM radgroupreply WHERE groupname='social-free' AND attribute='Mikrotik-Address-List'"
    [ -z "$was_social" ] || db "INSERT INTO radgroupreply (groupname,attribute,op,value) VALUES ('social-free','Mikrotik-Address-List','=','$was_social')"
    if [ "$had_social" = 0 ]; then db "DELETE FROM ml_plan WHERE name='social-free'; DELETE FROM radgroupreply WHERE groupname='social-free'; DELETE FROM radgroupcheck WHERE groupname='social-free'"; fi
}
trap cleanup EXIT
cleanup 2>/dev/null

# login like the hotspot: PAP with the device's MAC; -> "Access-Accept|<address list>" or "Access-Reject"
login() {
    local out; out=$(printf 'User-Name = "%s"\nUser-Password = "%s"\nCalling-Station-Id = "%s"\nNAS-IP-Address = 127.0.0.1\nService-Type = Login-User\n' "$1" "$2" "${3:-AA:BB:CC:99:99:99}" \
        | radclient -x -r 1 -t 3 127.0.0.1:1812 auth "$SECRET" 2>&1)
    if grep -q '^Received Access-Accept' <<<"$out"; then
        echo "Access-Accept|$(grep -o 'Mikrotik-Address-List = "[^"]*"' <<<"$out" | sed 's/.*= "//; s/"$//' | paste -sd, -)"
    else echo "Access-Reject"; fi
}

# ---- set up: a group with a policy, users, MAC devices, a plan with a policy + PIN vouchers, the guest plan with a policy
radius-admin group add lp-grp --policy kids >/dev/null
radius-admin user add lp-pass -p 'Lp-Pass-123' >/dev/null && radius-admin user policy lp-pass staff >/dev/null
radius-admin user add lp-grpuser -p 'Lp-Pass-123' -g lp-grp >/dev/null
radius-admin user add lp-own -p 'Lp-Pass-123' -g lp-grp >/dev/null && radius-admin user policy lp-own no-video >/dev/null
radius-admin mac add $MAC1 -g lp-grp -d "lp printer" >/dev/null
radius-admin mac add $MAC2 -d "lp tv" >/dev/null; mp=$(radius-admin mac policy $MAC2 no-internet 2>&1 | grep -c "policy 'no-internet'")
radius-admin mac add $MAC3 -d "lp camera" >/dev/null
MAC4=AA:BB:CC:10:00:04; radius-admin mac add $MAC4 -g lp-grp -d "lp cctv" --policy whatsapp-hikconnect >/dev/null
radius-admin plan add lp-plan --price 50 --validity 1d --rate 2M/2M --policy no-tiktok-pubg >/dev/null
PIN=$(radius-admin voucher create lp-plan 2 --pin | awk '/^   [A-Za-z0-9]+ +[A-Za-z0-9]+$/ && $1 != "username" {print $1; exit}')
radius-admin social set minutes 60 >/dev/null 2>&1 || radius-admin plan add social-free --price 0 --daily-time 60m --quota 500M --period daily >/dev/null
radius-admin plan set social-free --policy guests >/dev/null
radius-admin user add "$GUEST" -p 'Gu3st-Pass-1' >/dev/null && radius-admin user plan "$GUEST" social-free --free >/dev/null

echo "-- 1 MAC address"
t "MAC in a group: in, with the group's policy (kids)" "$(login $MAC1 $MAC1 $MAC1)" "Access-Accept|policy-kids"
t "MAC with its own policy (mac policy MAC no-internet)" "$mp|$(login $MAC2 $MAC2 $MAC2)" "1|Access-Accept|policy-no-internet"
t "MAC added with --policy, in a group: its own policy wins" "$(login $MAC4 $MAC4 $MAC4)" "Access-Accept|policy-whatsapp-hikconnect"
t "MAC written any way (aa-bb.., AABB.CCDD..) is the same device" "$(radius-admin mac policy aabb.cc10.0002 no-video >/dev/null; login $MAC2 $MAC2 $MAC2)" "Access-Accept|policy-no-video"
radius-admin mac policy $MAC2 no-internet >/dev/null
t "mac list shows the policy" "$(radius-admin mac list | grep -c 'AA-BB-CC-10-00-02.*no-internet')" "1"
t "MAC without a group or policy: in, no policy (filter base only)" "$(login $MAC3 $MAC3 $MAC3)" "Access-Accept|"
t "MAC typed as a username on another device: refused" "$(login $MAC1 $MAC1 AA:BB:CC:66:66:66)" "Access-Reject"
echo "-- 2 username + password"
t "own policy (staff)" "$(login lp-pass Lp-Pass-123)" "Access-Accept|policy-staff"
t "group policy (kids)" "$(login lp-grpuser Lp-Pass-123)" "Access-Accept|policy-kids"
t "own policy beats the group's (no-video, only one list)" "$(login lp-own Lp-Pass-123)" "Access-Accept|policy-no-video"
t "wrong password refused" "$(login lp-pass wrong-pass)" "Access-Reject"
echo "-- 3 PIN voucher"
t "PIN made (code = user = password)" "$([[ $PIN =~ ^[A-Za-z0-9]{6}$ ]] && echo yes)" "yes"
t "PIN login: the plan's policy (no-tiktok-pubg) with the plan's speed" "$(login "$PIN" "$PIN")" "Access-Accept|policy-no-tiktok-pubg"
t "  ... first login started the voucher's time" "$(db "SELECT first_login IS NOT NULL FROM ml_account WHERE username='$PIN'")" "1"
t "wrong PIN refused" "$(login "$PIN" 000000)" "Access-Reject"
echo "-- 4 guest (Social WiFi)"
t "guest: the free plan's policy (guests)" "$(login "$GUEST" Gu3st-Pass-1)" "Access-Accept|policy-guests"
radius-admin social set minutes 45 >/dev/null 2>&1
t "  ... the guest policy stays when the Social WiFi settings change" "$(login "$GUEST" Gu3st-Pass-1)" "Access-Accept|policy-guests"
echo "-- changes, quarantine, router rules"
radius-admin group set lp-grp --policy students >/dev/null 2>&1 || radius-admin group add lp-grp --policy students >/dev/null
t "group policy changed: the next login of a group user and a group MAC gets it" "$(login lp-grpuser Lp-Pass-123) $(login $MAC1 $MAC1 $MAC1)" "Access-Accept|policy-students Access-Accept|policy-students"
radius-admin user policy lp-own - >/dev/null
t "own policy removed: back to the group's" "$(login lp-own Lp-Pass-123)" "Access-Accept|policy-students"
radius-admin plan set lp-plan --policy whatsapp-only >/dev/null
t "plan policy changed: the PIN's next login gets it" "$(login "$PIN" "$PIN")" "Access-Accept|policy-whatsapp-only"
radius-admin security quarantine lp-pass "lp test" >/dev/null 2>&1
t "quarantine beats the user's policy" "$(login lp-pass Lp-Pass-123)" "Access-Accept|ml-quarantine"
radius-admin security release lp-pass >/dev/null 2>&1
t "  ... released: own policy back" "$(login lp-pass Lp-Pass-123)" "Access-Accept|policy-staff"
radius-admin policy build >/dev/null
for p in staff kids no-video no-internet no-tiktok-pubg whatsapp-only students guests; do
    n=$(grep -c "src-address-list=policy-$p\b" $P)
    t "routers have rules for the list policy-$p" "$([ "$n" -gt 0 ] && echo yes)" "yes"
done
t "who has which policy: counted in the policy list (MAC, user, group, plan, guest plan)" \
  "$(radius-admin policy list | grep -A2 '^no-internet ' | grep -c 'used by [1-9]')$(radius-admin policy list | grep -A2 '^guests ' | grep -c 'used by [1-9]')" "11"
if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/lp.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: add a MAC with a policy" "$(api POST /api/macs '{"mac":"aa:bb:cc:10:00:05","policy":"kids","description":"lp api"}')$(login AA:BB:CC:10:00:05 x AA:BB:CC:10:00:05)" "200Access-Accept|policy-kids"
    t "API: MAC list shows own and group policy" "$(api GET /api/macs)$(python3 -c "import json; d=json.load(open('/tmp/lp.json')); m={x['mac']:x for x in d['macs']}; print(m['AA-BB-CC-10-00-05']['policy'], m['AA-BB-CC-10-00-01']['policy'] or '-', m['AA-BB-CC-10-00-01']['group_policy'])")" "200kids - students"
    t "API: change it; empty = follow the group / none" "$(api POST /api/macs/AA-BB-CC-10-00-05/policy '{"policy":"no-vpn"}')$(login AA:BB:CC:10:00:05 x AA:BB:CC:10:00:05) $(api POST /api/macs/AA-BB-CC-10-00-05/policy '{"policy":""}')$(login AA:BB:CC:10:00:05 x AA:BB:CC:10:00:05)" "200Access-Accept|policy-no-vpn 200Access-Accept|"
    t "API: plan policy from the Plans page (all PINs of the plan)" "$(api POST /api/plans '{"name":"lp-plan","policy":"kids","edit":true}')$(login "$PIN" "$PIN") $(api GET /api/plans)$(python3 -c "import json; print([p['policy'] for p in json.load(open('/tmp/lp.json'))['plans'] if p['name']=='lp-plan'][0])")" "200Access-Accept|policy-kids 200kids"
    t "API: unknown policy refused" "$(api POST /api/macs/AA-BB-CC-10-00-05/policy '{"policy":"nosuch"}')" "400"
    rm -f "$jar" /tmp/lp.json
fi
[ "$fails" = 0 ] && echo "all login + policy tests passed" || { echo "$fails FAILED"; exit 1; }
