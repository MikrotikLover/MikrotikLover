#!/usr/bin/env bash
# One LAN, every kind of login at the same time, through the real FreeRADIUS (auth 1812 + accounting 1813, like a MikroTik
# hotspot): a MAC device, a user with a password, a PIN voucher, a Social WiFi guest — each gets its own address and its own
# policy; IP binding (who keeps an address, a static address set before the first login, conflicts), PPPoE static IP,
# an address used again after a guest leaves, the router's DHCP leases (lint).
#   sudo bash tests/test-lan-logins.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
SECRET=$(. /etc/mikrotiklover-radius/radius.conf; echo "$LOCAL_SECRET")
S=/var/lib/mikrotiklover/router/sync.rsc
MACDEV=AA:BB:CC:15:00:01 GUEST=sw-923001110000
was=$(db "SELECT CONCAT(IFNULL((SELECT v FROM ml_setting WHERE k='ipbind_auto'),'0'),',',IFNULL((SELECT v FROM ml_setting WHERE k='ipbind_scope'),'users'))")
had_social=$(db "SELECT COUNT(*) FROM ml_plan WHERE name='social-free'")
cleanup() {
    for u in ln-staff ln-boss ln-ppp ln-other "$GUEST" $(db "SELECT username FROM ml_account WHERE plan='ln-plan'"); do radius-admin user del "$u" >/dev/null 2>&1; done
    radius-admin mac del $MACDEV >/dev/null 2>&1
    db "DELETE FROM ml_account WHERE plan='ln-plan'; DELETE FROM ml_voucher_batch WHERE plan='ln-plan'; DELETE FROM ml_plan WHERE name='ln-plan';
        DELETE FROM radgroupreply WHERE groupname='ln-plan'; DELETE FROM radgroupcheck WHERE groupname='ln-plan'; DELETE FROM radgroup_meta WHERE groupname='ln-plan';
        DELETE FROM radacct WHERE acctsessionid LIKE 'ln-%'; DELETE FROM ml_ip_bind WHERE ip LIKE '192.168.150.%' OR username LIKE 'ln-%'"
    [ "$had_social" != 0 ] || db "DELETE FROM ml_plan WHERE name='social-free'; DELETE FROM radgroupreply WHERE groupname='social-free'; DELETE FROM radgroupcheck WHERE groupname='social-free'"
    db "REPLACE INTO ml_setting (k, v) VALUES ('ipbind_auto', '${was%%,*}'), ('ipbind_scope', '${was##*,}')"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup 2>/dev/null

# auth like the hotspot -> "accept|<address list>|<framed ip>" or "reject"
auth() {
    local out; out=$(printf 'User-Name = "%s"\nUser-Password = "%s"\nCalling-Station-Id = "%s"\nNAS-IP-Address = 127.0.0.1\nService-Type = %s\n' "$1" "$2" "$3" "${4:-Login-User}" \
        | radclient -x -r 1 -t 3 127.0.0.1:1812 auth "$SECRET" 2>&1)
    grep -q '^Received Access-Accept' <<<"$out" || { echo reject; return; }
    echo "accept|$(grep -o 'Mikrotik-Address-List = "[^"]*"' <<<"$out" | sed 's/.*= "//; s/"$//')|$(grep -o 'Framed-IP-Address = [0-9.]*' <<<"$out" | awk '{print $3}')"
}
# accounting Start / Stop like the router (session id ln-...)
acct() { # start|stop user mac ip sid
    printf 'Acct-Status-Type = %s\nUser-Name = "%s"\nCalling-Station-Id = "%s"\nFramed-IP-Address = %s\nAcct-Session-Id = "%s"\nNAS-IP-Address = 127.0.0.1\nNAS-Port-Type = Wireless-802.11\nAcct-Session-Time = 60\n' \
        "$1" "$2" "$3" "$4" "$5" | radclient -r 1 -t 3 127.0.0.1:1813 acct "$SECRET" >/dev/null 2>&1
}
online() { db "SELECT CONCAT(username,'=',framedipaddress) FROM radacct WHERE acctsessionid LIKE 'ln-%' AND acctstoptime IS NULL ORDER BY framedipaddress" | paste -sd' ' -; }
bind() { db "SELECT CONCAT(ip,'|',mac,'|',locked) FROM ml_ip_bind WHERE username='$1'"; }

# ---- the four kinds of users, each with a policy
radius-admin user add ln-staff -p 'Ln-Pass-123' >/dev/null && radius-admin user policy ln-staff staff >/dev/null
radius-admin mac add $MACDEV -d "ln printer" --policy no-video >/dev/null
radius-admin plan add ln-plan --price 50 --validity 1d --policy kids >/dev/null
PIN=$(radius-admin voucher create ln-plan 1 --pin | awk '/^   [A-Za-z0-9]+ +[A-Za-z0-9]+$/ && $1 != "username" {print $1; exit}')
radius-admin social set minutes 60 >/dev/null 2>&1 || radius-admin plan add social-free --price 0 --daily-time 60m --quota 500M --period daily >/dev/null
radius-admin plan set social-free --policy guests >/dev/null
radius-admin user add "$GUEST" -p 'Gu3st-Pass-1' >/dev/null && radius-admin user plan "$GUEST" social-free --free >/dev/null
radius-admin ipbind auto on >/dev/null; radius-admin ipbind scope users >/dev/null

echo "-- one LAN 192.168.150.0/24, all four log in"
t "user + password: in, policy staff" "$(auth ln-staff Ln-Pass-123 AA:BB:CC:15:00:11)" "accept|policy-staff|"
t "MAC device: in, policy no-video" "$(auth $MACDEV $MACDEV $MACDEV)" "accept|policy-no-video|"
t "PIN voucher: in, the plan's policy kids" "$(auth "$PIN" "$PIN" AA:BB:CC:15:00:13)" "accept|policy-kids|"
t "Social WiFi guest: in, policy guests" "$(auth "$GUEST" Gu3st-Pass-1 AA:BB:CC:15:00:14)" "accept|policy-guests|"
acct Start ln-staff AA-BB-CC-15-00-11 192.168.150.11 ln-1
acct Start AA-BB-CC-15-00-01 AA-BB-CC-15-00-01 192.168.150.12 ln-2
acct Start "$PIN" AA-BB-CC-15-00-13 192.168.150.13 ln-3
acct Start "$GUEST" AA-BB-CC-15-00-14 192.168.150.14 ln-4
t "all four online at once, each with its own address (accounting through FreeRADIUS)" "$(online)" \
  "ln-staff=192.168.150.11 AA-BB-CC-15-00-01=192.168.150.12 $PIN=192.168.150.13 $GUEST=192.168.150.14"
t "  ... the MAC device is counted under its MAC (one device, not a person)" "$(db "SELECT COUNT(*) FROM radacct WHERE acctsessionid='ln-2' AND username='AA-BB-CC-15-00-01'")" "1"

echo "-- IP binding: who keeps the address"
radius-admin ipbind run >/dev/null
t "user with a password: keeps 192.168.150.11 on this phone" "$(bind ln-staff)" "192.168.150.11|AA-BB-CC-15-00-11|0"
t "MAC device: keeps 192.168.150.12" "$(bind AA-BB-CC-15-00-01)" "192.168.150.12|AA-BB-CC-15-00-01|0"
t "PIN voucher and guest: no reserved address (the DHCP pool stays free for the next ones)" "$(bind "$PIN")|$(bind "$GUEST")" "|"
t "router: a DHCP static lease for each kept address, none for the PIN / guest" \
  "$(grep -c 'add mac-address=AA:BB:CC:15:00:11 address=192.168.150.11 comment="mlbind: ln-staff"' $S)$(grep -c 'add mac-address=AA:BB:CC:15:00:01 address=192.168.150.12 comment="mlbind: AA-BB-CC-15-00-01"' $S)$(grep -c '192.168.150.1[34]' $S)" "110"
t "router file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
radius-admin ipbind scope all >/dev/null; radius-admin ipbind run >/dev/null
t "scope 'all': the PIN and the guest keep theirs too" "$(bind "$PIN" | cut -d'|' -f1) $(bind "$GUEST" | cut -d'|' -f1)" "192.168.150.13 192.168.150.14"
db "DELETE FROM ml_ip_bind WHERE ip IN ('192.168.150.13','192.168.150.14')"; radius-admin ipbind scope users >/dev/null; radius-admin ipbind run >/dev/null
t "  ... back to 'users': not bound again" "$(bind "$PIN")|$(bind "$GUEST")" "|"

echo "-- an address used again"
acct Stop "$GUEST" AA-BB-CC-15-00-14 192.168.150.14 ln-4
radius-admin user add ln-other -p 'Ln-Pass-123' >/dev/null
t "the guest left; a new user gets the same address from DHCP" "$(auth ln-other Ln-Pass-123 AA:BB:CC:15:00:15)" "accept||"
acct Start ln-other AA-BB-CC-15-00-15 192.168.150.14 ln-5
radius-admin ipbind run >/dev/null
t "  ... it is free (no leftover guest binding): the new user keeps it" "$(bind ln-other)" "192.168.150.14|AA-BB-CC-15-00-15|0"

echo "-- static address set before the first login"
radius-admin user add ln-boss -p 'Ln-Pass-123' >/dev/null
t "set 192.168.150.50 for a user who never logged in" "$(radius-admin ipbind set ln-boss 192.168.150.50 | grep -c 'known at the first login')$(bind ln-boss)" "1192.168.150.50||1"
t "  ... no lease on the router yet (no device known)" "$(grep -c '192.168.150.50' $S)" "0"
t "an address in use by someone online refused" "$(radius-admin ipbind set ln-boss 192.168.150.11 2>&1 | grep -c 'already bound\|in use right now')" "1"
t "an address bound to another user refused" "$(radius-admin ipbind set ln-other 192.168.150.50 2>&1 | grep -c 'already bound')" "1"
t "first login: in (DHCP gave .60 for now)" "$(auth ln-boss Ln-Pass-123 AA:BB:CC:15:00:16)" "accept||"
acct Start ln-boss AA-BB-CC-15-00-16 192.168.150.60 ln-6
radius-admin ipbind run >/dev/null
t "  ... the device is learned, the chosen address stays (.50, not .60)" "$(bind ln-boss)" "192.168.150.50|AA-BB-CC-15-00-16|1"
t "  ... the router gets the lease .50 for that phone" "$(grep -c 'add mac-address=AA:BB:CC:15:00:16 address=192.168.150.50 comment="mlbind: ln-boss"' $S)" "1"
acct Stop ln-boss AA-BB-CC-15-00-16 192.168.150.60 ln-6
acct Start ln-boss AA-BB-CC-15-00-16 192.168.150.50 ln-7
radius-admin ipbind run >/dev/null
t "next login (after the DHCP renewal) on .50: nothing changes" "$(bind ln-boss) $(db "SELECT framedipaddress FROM radacct WHERE acctsessionid='ln-7'")" "192.168.150.50|AA-BB-CC-15-00-16|1 192.168.150.50"

echo "-- PPPoE: static IP from the first login"
radius-admin user add ln-ppp -p 'Ln-Pass-123' >/dev/null; radius-admin user ip ln-ppp 10.150.0.40 >/dev/null
t "first login: the router is told 10.150.0.40" "$(auth ln-ppp Ln-Pass-123 AA:BB:CC:15:00:17 Framed-User)" "accept||10.150.0.40"
t "the same static IP for another user refused" "$(radius-admin user ip ln-other 10.150.0.40 2>&1 | grep -c 'already the static IP')" "1"
t "IP binding leaves PPPoE users alone" "$(radius-admin ipbind set ln-ppp 192.168.150.70 2>&1 | grep -c 'PPPoE static IP')" "1"

echo "-- policies stay right with all of them online"
t "every one's next login still gets its own policy" \
  "$(auth ln-staff Ln-Pass-123 AA:BB:CC:15:00:11 | cut -d'|' -f2) $(auth $MACDEV $MACDEV $MACDEV | cut -d'|' -f2) $(auth "$PIN" "$PIN" AA:BB:CC:15:00:13 | cut -d'|' -f2) $(auth "$GUEST" Gu3st-Pass-1 AA:BB:CC:15:00:14 | cut -d'|' -f2)" \
  "policy-staff policy-no-video policy-kids policy-guests"
[ "$fails" = 0 ] && echo "all LAN login tests passed" || { echo "$fails FAILED"; exit 1; }
