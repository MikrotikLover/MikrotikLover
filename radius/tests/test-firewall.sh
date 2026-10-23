#!/usr/bin/env bash
# Firewall on an installed server: objects, policies in order, port forwards, countries, router files, hits, logs.
# Only touches its own objects (names starting with ft-).
#   sudo bash tests/test-firewall.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-firewall.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
S=/var/lib/mikrotiklover/router/sync.rsc G=/var/lib/mikrotiklover/router/geo.rsc GD=/var/lib/mikrotiklover/geo
WFL=/var/log/mikrotik/webfilter.log TMP=$(mktemp -d)
FW="radius-admin firewall"
id_of() { db "SELECT id FROM ml_fw_rule WHERE name='$1'"; }
cp -a "$GD" "$TMP/geo.bak" 2>/dev/null || true
cleanup() {
    db "DELETE FROM ml_fw_rule WHERE name LIKE 'ft-%'; DELETE FROM ml_fw_vip WHERE name LIKE 'ft-%'; DELETE FROM ml_fw_addr WHERE name LIKE 'ft-%';
        DELETE FROM ml_fw_service WHERE name LIKE 'ft-%'; DELETE FROM ml_fw_schedule WHERE name LIKE 'ft-%'; DELETE FROM ml_router_status WHERE identity='ft-router'"
    sed -i '/ft-test-line/d' "$WFL" 2>/dev/null
    if [ -d "$TMP/geo.bak" ]; then rm -rf "$GD"; cp -a "$TMP/geo.bak" "$GD"; fi
    radius-admin policy build >/dev/null 2>&1; rm -rf "$TMP"
}
trap cleanup EXIT
db "DELETE FROM ml_fw_rule WHERE name LIKE 'ft-%'; DELETE FROM ml_fw_vip WHERE name LIKE 'ft-%'; DELETE FROM ml_fw_addr WHERE name LIKE 'ft-%'"

# ---- objects
t "address: IPs, range, website, country" "$($FW addr set ft-office 192.168.77.0/24 10.77.0.5-10.77.0.9 vpn.example.com 2>&1 | grep -c "3 entries")" "1"
$FW addr set ft-bad geo:CN geo:RU >/dev/null
t "address: bad entry refused" "$($FW addr set ft-x 300.1.1.1 2>&1 | grep -c 'is not an IP')" "1"
t "service: own ports" "$($FW service set ft-cam tcp/37777 udp/37778 2>&1 | grep -c saved)" "1"
t "service: built-in name refused" "$($FW service set RDP tcp/1 2>&1 | grep -c 'built in')" "1"
t "schedule: days + time" "$($FW schedule set ft-lunch mon,tue,wed 13:00-14:00 2>&1 | grep -c saved)" "1"

# ---- policies, in order
$FW rule add ft-risky --dir in --service RDP,SMB --action deny --log >/dev/null
$FW rule add ft-winbox-office --dir router --src ft-office --service WINBOX --action allow >/dev/null
$FW rule add ft-winbox-others --dir wan --service WINBOX --action reject >/dev/null
$FW rule add ft-countries --dir wan --src ft-bad --action deny --log --top >/dev/null
$FW rule add ft-cam-lunch --dir out --service ft-cam --schedule ft-lunch --action reject >/dev/null
R1=$(id_of ft-risky) R4=$(id_of ft-countries) R5=$(id_of ft-cam-lunch)
t "--top puts the policy first" "$($FW list | awk 'NR==2 {print $4}')" "ft-countries"
t "router file: RDP + SMB from the internet dropped and logged" "$(grep -c "comment=\"mlfw:$R1 ft-risky\"" $S)$(grep "mlfw:$R1 " $S | grep -c 'log-prefix="WF-fw-'$R1'"')" "44"
t "router file: countries forward + router, own object list" "$(grep -c "mlfw:$R4 " $S) $(grep -c 'add list=mlfw-ft-office' $S)" "4 3"
t "router file: schedule as RouterOS time" "$(grep "mlfw:$R5 " $S | grep -c 'time=13h-14h,mon,tue,wed')" "2"
t "router file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
$FW rule move "$R5" top >/dev/null
t "move to top" "$($FW list | awk 'NR==2 {print $4}')" "ft-cam-lunch"
$FW rule move "$R5" bottom >/dev/null
$FW rule off "$R1" >/dev/null
t "off: no router rules, kept in the list" "$(grep -c "mlfw:$R1 " $S) $($FW list | grep -c ' off ft-risky')" "0 1"
$FW rule on "$R1" >/dev/null
t "in use: object cannot be deleted" "$($FW addr del ft-office 2>&1 | grep -c 'used by')" "1"
t "bad direction / unknown object refused" "$($FW rule add ft-y --dir up 2>&1 | grep -c direction)$($FW rule add ft-y --src nope 2>&1 | grep -c 'no address')" "11"

# ---- port forwards
t "port forward open to all on RDP: saved with a warning" "$($FW vip add ft-pc 3389 192.168.77.21 2>&1 | grep -c WARNING)" "1"
$FW vip add ft-dvr 37777 192.168.77.20:37777 --proto both --src ft-office,geo:PK >/dev/null
t "port forward: tcp + udp for each allowed source" "$(grep -c 'comment="mlfw-vip:[0-9]* ft-dvr"' $S) $(grep 'ft-dvr' $S | grep -c 'src-address-list=mlgeo-PK')" "4 2"
t "port forward: public inside address refused" "$($FW vip add ft-z 80 8.8.8.8 2>&1 | grep -c private)" "1"

# ---- countries
printf 'apnic|CN|ipv4|1.0.1.0|256|2011|allocated\napnic|PK|ipv4|39.32.0.0|768|2008|allocated\nripencc|RU|ipv4|5.3.0.0|65536|2010|allocated\n' > "$TMP/del.txt"
t "country lists from a registry file" "$($FW geo import "$TMP/del.txt" 2>&1 | grep -c '3 countries')" "1"
t "router country file: the 3 used countries" "$(grep -c 'add list=mlgeo-' $G) $(python3 "$HERE/lint-rsc.py" $G | head -1)" "4 ok   geo.rsc"
t "sync.rsc fetches it only when it changes" "$(grep -c "mlGeoVer != \"$(cut -d' ' -f1 /var/lib/mikrotiklover/router/geo.version)\"" $S)" "1"
KEY=$(cat /var/lib/mikrotiklover/router/key)
t "routers get the country file with the key, not without" "$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:8443/api/public/router/geo.rsc?key=$KEY")$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:8443/api/public/router/geo.rsc?key=x")" "200403"
t "policy lookup (CLI): China -> country policy" "$($FW lookup router 1.0.1.9 203.0.113.1 tcp 22 | tail -1 | grep -c "policy #$R4")" "1"

# ---- hits from the routers, logs
curl -sk -o /dev/null --data-binary "id=ft-router
fw=mlfw:$R4 ft-countries|700|42000
fw=mlfw:$R4 ft-countries|300|18000
fwn=mlfw-vip:$(db "SELECT id FROM ml_fw_vip WHERE name='ft-dvr'") ft-dvr|5|500" "https://127.0.0.1:8443/api/public/router/report?key=$KEY"
ts=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
echo "$ts 10.0.0.1 firewall,info: WF-fw-$R4 input: in:ether1 out:(unknown 0), connection-state:new proto TCP (SYN), 1.0.1.77:4000->203.0.113.1:8291, len 52 ft-test-line" >> $WFL
t "logs (CLI): the deny line" "$($FW logs --n 500 | grep -c "#$R4 .* deny .*1.0.1.77")" "1"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/fwt.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/fwt.json')); print($1)"; }
    t "API: policies in order with hits summed over the router's rules" "$(api GET /api/firewall)$(js "[(r['hits'][0], r['router_rules']) for r in d['rules'] if r['name']=='ft-countries']")" "200[(1000, 4)]"
    t "API: port forward risk + open to all warning" "$(js "[(v['risk'], v['open_all']) for v in d['vips'] if v['name']=='ft-pc'], any('ft-pc' in w['text'] for w in d['warnings'])")" "[('RDP', True)] True"
    t "API: address types and where used" "$(js "[(a['kind'], len(a['used'])) for a in d['addrs'] if a['name']=='ft-office']")" "[(['fqdn', 'net', 'range'], 2)]"
    t "API: countries in use with their lists" "$(js "sorted(set(d['geo']['used']) & {'CN','PK','RU'}), d['geo']['counts'].get('PK')")" "['CN', 'PK', 'RU'] 2"
    t "API: new policy" "$(api POST /api/firewall/rule '{"name":"ft-api","dir":"out","src":["ft-office"],"dst":["geo:RU"],"service":["WEB"],"action":"reject","log":true}')$(id_of ft-api | grep -c .)" "2001"
    RA=$(id_of ft-api)
    t "API: edit keeps the id" "$(api POST /api/firewall/rule "{\"id\":$RA,\"name\":\"ft-api\",\"dir\":\"out\",\"service\":[\"DNS\"],\"action\":\"deny\"}")$(db "SELECT CONCAT(service,'/',action) FROM ml_fw_rule WHERE id=$RA")" "200DNS/deny"
    t "API: bad policy refused with the reason" "$(api POST /api/firewall/rule '{"name":"ft-b","dir":"out","service":["NOPE"],"action":"deny"}')$(js "'no service' in d['error']")" "400True"
    t "API: move up / off / delete" "$(api POST /api/firewall/rule/$RA/up)$(api POST /api/firewall/rule/$RA/off)$(api POST /api/firewall/rule/$RA/del)$(id_of ft-api | grep -c .)" "2002002000"
    t "API: bad action 404" "$(api POST /api/firewall/rule/1/explode)$(api POST /api/firewall/nope)" "404404"
    t "API: address, service, schedule save + delete" "$(api POST /api/firewall/addr '{"name":"ft-a2","entries":["10.9.9.0/24"]}')$(api POST /api/firewall/service '{"name":"ft-s2","entries":["tcp/9000"]}')$(api POST /api/firewall/schedule '{"name":"ft-t2","days":["sun"],"start":"22:00","end":"06:00"}')$(api POST /api/firewall/addr/ft-a2/del)$(api POST /api/firewall/service/ft-s2/del)$(api POST /api/firewall/schedule/ft-t2/del)" "200200200200200200"
    t "API: port forward save, off, delete" "$(api POST /api/firewall/vip '{"name":"ft-web","proto":"tcp","port":"8080","to":"192.168.77.30","to_port":"80","src":["geo:PK"]}')$(grep -c 'ft-web' $S)$(api POST /api/firewall/vip/$(db "SELECT id FROM ml_fw_vip WHERE name='ft-web'")/off)$(grep -c 'ft-web' $S)" "20012000"
    t "API lookup: from China to the router's Winbox" "$(api GET "/api/firewall/lookup?dir=router&src=1.0.1.9&dst=203.0.113.1&proto=tcp&port=8291")$(js "d['verdict'], d['rule'] == $R4, d['countries']")" "200deny True ['CN', 'LAN']"
    t "API lookup: bad input 400" "$(api GET "/api/firewall/lookup?dir=router&src=x&dst=1.1.1.1&proto=tcp")$(api GET "/api/firewall/lookup?dir=up&src=1.1.1.1&dst=1.1.1.1&proto=tcp")" "400400"
    t "API logs: line with its policy and country" "$(api GET "/api/firewall/logs?days=1&rule=$R4")$(js "[(r['policy'], r['country']) for r in d['rows'] if r['src']=='1.0.1.77']")" "200[('ft-countries', 'CN')]"
    t "API: blocking logs say firewall" "$(api GET '/api/blocked?days=1')$(js "[r['policy'] + ' / ' + r['reason'] for r in d['rows'] if r['ip']=='1.0.1.77'][:1]")" "200['firewall / firewall policy #$R4']"
    rm -f "$jar" /tmp/fwt.json
fi
[ "$fails" = 0 ] && echo "all firewall server tests passed" || { echo "$fails FAILED"; exit 1; }
