#!/usr/bin/env bash
# Mail server protection on an installed server: settings, router rules, safe doors, checklist, logs, dashboard API.
# Does not run on a server whose mail server is already set up (it would change it).
#   sudo bash tests/test-mail.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-mail.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
S=/var/lib/mikrotiklover/router/sync.rsc WFL=/var/log/mikrotik/webfilter.log MIP=192.168.77.30
cur=$(db "SELECT v FROM ml_setting WHERE k='mail_ip'")
[ -z "$cur" ] || [ "$cur" = "$MIP" ] || [ "$cur" = 127.0.0.1 ] || { echo "skipped: a mail server is set up here ($cur)"; exit 0; }
cleanup() {
    radius-admin mail remove >/dev/null 2>&1
    db "DELETE FROM ml_fw_vip WHERE name LIKE 'mail-%' AND to_ip='$MIP'; DELETE FROM ml_setting WHERE k IN ('mail_guard','mail_smtp_out','mail_rate','mail_trusted','mail_checklist')"
    db "DELETE FROM ml_fw_addr WHERE name='mt-office'"
    sed -i '/mt-test-line/d' "$WFL" 2>/dev/null; rm -f /var/lib/mikrotiklover/mail.json
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup

t "set: bad address / domain refused" "$(radius-admin mail set ip 999.1.1.1 domain x.com 2>&1 | grep -c ERROR)$(radius-admin mail set ip $MIP domain 'bad domain' 2>&1 | grep -c "bad domain")" "11"
radius-admin mail set ip $MIP domain Example.COM dkim MDaemon webmail 3000 >/dev/null
t "set: saved (domain in small letters)" "$(db "SELECT GROUP_CONCAT(v ORDER BY k) FROM ml_setting WHERE k IN ('mail_ip','mail_domain','mail_dkim')")" "MDaemon,example.com,$MIP"
t "router: guessers dropped, logins counted (webmail port too), port 25 out only from the mail server" \
  "$(grep -c "src-address-list=ml-mail-brute dst-address=$MIP action=drop" $S) $(grep -c "dst-port=110,143,443,465,587,993,995,3000 .*jump-target=mlmail" $S) $(grep -c "dst-port=25 src-address=!$MIP .*WF-spambot" $S)" "1 1 1"
t "router: 30 a minute (burst 60) then blocked 1 hour, logged" "$(grep -c 'chain=mlmail dst-limit=30/1m,60,src-address/1m action=return' $S) $(grep -c 'address-list=ml-mail-brute address-list-timeout=1h log=yes log-prefix="WF-mailbrute"' $S)" "1 1"
t "router file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
radius-admin mail rate 60 >/dev/null
t "rate 60" "$(grep -c 'dst-limit=60/1m,120' $S)" "1"
t "rate out of range refused" "$(radius-admin mail rate 2 2>&1 | grep -c '5-1000')" "1"
radius-admin firewall addr set mt-office 203.0.113.0/24 >/dev/null
radius-admin mail trusted mt-office >/dev/null
t "trusted addresses are not counted" "$(grep -c 'jump-target=mlmail' $S) $(grep 'jump-target=mlmail' $S | grep -c 'src-address-list=!mlfw-mt-office')" "1 1"
t "unknown trusted object refused" "$(radius-admin mail trusted nope 2>&1 | grep -c 'no address object')" "1"
radius-admin mail trusted none >/dev/null
radius-admin mail guard off >/dev/null; radius-admin mail smtp-out off >/dev/null
t "guard + smtp-out off: no mail rules" "$(grep -c 'comment="mlmail:' $S)" "0"
radius-admin mail guard on >/dev/null; radius-admin mail smtp-out on >/dev/null
out=$(radius-admin mail doors)
t "doors: 25 587 465 993 995 + webmail 443 -> the mail server" "$(db "SELECT GROUP_CONCAT(CONCAT(port,'>',to_port) ORDER BY port+0) FROM ml_fw_vip WHERE to_ip='$MIP'")" "25>25,443>443,465>465,587>587,993>993,995>995"
t "doors: never the admin port" "$(db "SELECT COUNT(*) FROM ml_fw_vip WHERE to_ip='$MIP' AND port IN ('1000','3000')")" "0"
radius-admin mail doors >/dev/null
t "doors twice: not doubled" "$(db "SELECT COUNT(*) FROM ml_fw_vip WHERE to_ip='$MIP'")" "6"
t "router: the doors are port forwards" "$(grep -c "action=dst-nat to-addresses=$MIP" $S)" "6"
radius-admin mail checklist dynamic_screening on >/dev/null; radius-admin mail checklist backup on >/dev/null; radius-admin mail checklist backup off >/dev/null
t "checklist kept as ticked" "$(db "SELECT v FROM ml_setting WHERE k='mail_checklist'")" '{"dynamic_screening": true, "backup": false}'
radius-admin mail check >/dev/null
t "hourly check saved for the dashboard + health" "$(python3 -c "import json; d=json.load(open('/var/lib/mikrotiklover/mail.json')); print(d['configured'], {c['group'] for c in d['checks']} >= {'DNS records', 'Open doors', 'Protection'})")" "True True"
ts=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
echo "$ts 10.0.0.1 firewall,info: WF-mailbrute forward: in:ether1 out:bridge, connection-state:new proto TCP (SYN), 92.63.197.99:5111->$MIP:993, len 52 mt-test-line" >> $WFL
echo "$ts 10.0.0.1 firewall,info: WF-spambot forward: in:bridge out:ether1, connection-state:new proto TCP (SYN), 192.168.77.57:51000->91.215.85.20:25, len 52 mt-test-line" >> $WFL
t "logs: guesser + spam bot" "$(radius-admin mail logs | grep -c '92.63.197.99\|192.168.77.57')" "2"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/mt.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/mt.json')); print($1)"; }
    t "API: settings, checks, guessers, spam bots, checklist" "$(api GET '/api/mail?days=1')$(js "d['settings']['ip'], d['result']['configured'], [x['ip'] for x in d['brute'] if x['ip']=='92.63.197.99'], [x['ip'] for x in d['bots'] if x['ip']=='192.168.77.57'], sum(c['done'] for c in d['checklist'])")" "200$MIP True ['92.63.197.99'] ['192.168.77.57'] 1"
    t "API: checklist tick" "$(api POST /api/mail/checklist '{"key":"backup","done":true}')$(db "SELECT v LIKE '%\"backup\": true%' FROM ml_setting WHERE k='mail_checklist'")" "2001"
    t "API: unknown checklist item 400" "$(api POST /api/mail/checklist '{"key":"nope","done":true}')" "400"
    t "API: guard off / on" "$(api POST /api/mail/guard '{"on":false}')$(grep -c 'jump-target=mlmail' $S)$(api POST /api/mail/guard '{"on":true}')$(grep -c 'jump-target=mlmail' $S)" "20002001"
    t "API: rate, trusted none" "$(api POST /api/mail/rate '{"rate":"20"}')$(grep -c 'dst-limit=20/1m' $S)$(api POST /api/mail/trusted '{"name":""}')" "2001200"
    t "API: settings saved + checked" "$(api POST /api/mail/settings "{\"ip\":\"$MIP\",\"domain\":\"example.com\",\"webmail\":\"3000\"}")" "200"
    t "API: bad settings 400, bad action 404" "$(api POST /api/mail/settings '{"ip":"x","domain":"example.com"}')$(api POST /api/mail/explode '{}')" "400404"
    rm -f "$jar" /tmp/mt.json
fi
[ "$fails" = 0 ] && echo "all mail server protection tests passed" || { echo "$fails FAILED"; exit 1; }
