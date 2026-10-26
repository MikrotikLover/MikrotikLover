#!/usr/bin/env bash
# RouterOS 6 and 7 on an installed server: the v6 copy of the router rules (sync6.rsc), the router picks its copy
# by version, the address lists RouterOS 6 cannot fill from DNS come from the server's DNS log, health check.
#   sudo bash tests/test-ros6.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
RD=/var/lib/mikrotiklover/router WEB=${URL:-https://127.0.0.1:8443}
K=$(cat $RD/key)
# a name some policy allows through an address list (FWD + address-list): its sub-name seen in the DNS log
NAME=$(grep -o 'name=[a-z0-9.-]* match-subdomain=yes type=FWD forward-to=$up address-list=[a-z0-9.-]*' $RD/sync.rsc | head -1)
HOST=$(sed 's/^name=\([^ ]*\) .*/\1/' <<<"$NAME"); LIST=$(sed 's/.*address-list=//' <<<"$NAME")
[ -n "$HOST" ] || { echo "FAIL no policy with a name -> address list in sync.rsc (needs an allow-only policy)"; exit 1; }
cleanup() { db "DELETE FROM ml_domain WHERE host='cdn.$HOST'"; db "DELETE FROM ml_router_fetch WHERE router_ip='127.0.0.1'"; radius-admin policy build >/dev/null 2>&1; }
trap cleanup EXIT
db "REPLACE INTO ml_domain (host, base, first_seen, last_seen, ips) VALUES ('cdn.$HOST', '$HOST', NOW(), NOW(), '31.13.70.36,31.13.70.37,192.168.1.5')"
radius-admin policy build >/dev/null
t "policy build makes the RouterOS 6 copy and its version" "$([ -s $RD/sync6.rsc ] && [ -s $RD/version6 ] && echo yes) $(stat -c %a $RD/sync6.rsc)" "yes 640"
t "  ... nothing RouterOS-7-only in it, lint ok" "$(python3 /usr/local/lib/mikrotiklover/rosv6.py check $RD/sync6.rsc | grep -c '^ok') $(python3 "$HERE/lint-rsc.py" $RD/sync6.rsc | grep -c '^ok')" "1 1"
t "  ... the RouterOS 7 file is unchanged (match-subdomain, address list from DNS)" "$(grep -c "name=$HOST match-subdomain=yes type=FWD" $RD/sync.rsc)" "1"
t "name -> list on RouterOS 6: the addresses from the DNS log (public ones only)" \
  "$(grep -c "address-list add list=$LIST address=31.13.70.3[67] timeout=1d" $RD/sync6.rsc) $(grep -c "list=$LIST address=192.168.1.5" $RD/sync6.rsc)" "2 0"
t "every minute list: a big one goes through a file (output=user is 4 KB on RouterOS 6)" "$(grep -c 'dst-path=ml-live.rsc; :delay 1s; /import file-name=ml-live.rsc' $RD/sync.rsc)" "1"
v7=$(curl -sk "$WEB/api/public/router/version?key=$K"); v6=$(curl -sk "$WEB/api/public/router/version?key=$K&v=6")
t "version: RouterOS 7 and 6 get their own" "$v7 $v6" "$(cat $RD/version) $(cat $RD/version6)"
t "sync.rsc?v=6 is the v6 copy, without v6 the v7 file" \
  "$(curl -sk "$WEB/api/public/router/sync.rsc?key=$K&v=6" | cmp -s - $RD/sync6.rsc && echo v6) $(curl -sk "$WEB/api/public/router/sync.rsc?key=$K" | cmp -s - $RD/sync.rsc && echo v7)" "v6 v7"
t "wrong key still refused" "$(curl -sk -o /dev/null -w '%{http_code}' "$WEB/api/public/router/sync.rsc?key=x&v=6")" "403"
curl -sk "$WEB/api/public/router/version?key=$K&v=6" >/dev/null; curl -sk "$WEB/api/public/router/sync.rsc?key=$K&v=6" >/dev/null
t "the server notes the router took the v6 copy" "$(db "SELECT version FROM ml_router_fetch WHERE router_ip='127.0.0.1' AND what='sync'")" "v6:$(cat $RD/version6)"
t "health check: a RouterOS 6 router with the newest v6 rules is up to date" "$(radius-admin doctor 2>&1 | grep -c 'Router 127.0.0.1 takes the rules: asked just now, has the newest rules')" "1"
AS=/usr/local/lib/mikrotiklover/web/autosync.rsc
t "auto-sync script: asks for the v6 copy on RouterOS 6 (version by the router itself)" \
  "$(grep -c ':if (\[:pick \[/system resource get version\] 0 1\] = "6") do={ :set q "&v=6" }' $AS) $(grep -c 'version?key=$key$q\|sync.rsc?key=$key$q' $AS)" "1 2"
t "  ... itself runs on RouterOS 6 too" "$(python3 /usr/local/lib/mikrotiklover/rosv6.py check $AS | grep -c '^ok')" "1"
[ "$fails" = 0 ] && echo "all RouterOS 6 / 7 server tests passed" || { echo "$fails FAILED"; exit 1; }
