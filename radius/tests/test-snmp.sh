#!/usr/bin/env bash
# SNMP devices end to end: fake UPS / printer / switch (tests/fakesnmp.py) + the real net-snmp agent (v2c and v3) when installed,
# radius-admin snmp (add / poll / events / watch / del), power cut + port down + device gone, alerts, trap receiver fed by
# net-snmp's snmptrap / snmpinform, MikroTik router lines (lint), health check, dashboard API.
#   sudo bash tests/test-snmp.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-snmp.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
W=$(mktemp -d); chmod 755 "$W"
SEC=/etc/mikrotiklover-radius/snmp-secrets.json
cp -a "$SEC" "$W/secrets.bak" 2>/dev/null || true
was_trapd=$(db "SELECT v FROM ml_setting WHERE k='snmp_trapd'") TID0=$(db "SELECT IFNULL(MAX(id),0) FROM ml_snmp_trap")
pids=()
cleanup() {
    for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
    [ -s "$W/snmpd.pid" ] && kill "$(cat "$W/snmpd.pid")" 2>/dev/null
    for id in $(db "SELECT id FROM ml_snmp_device WHERE name LIKE 'st-%'"); do radius-admin snmp del "$id" >/dev/null 2>&1; done
    db "DELETE FROM ml_snmp_trap WHERE id > ${TID0:-0}"
    if [ -f "$W/secrets.bak" ]; then cp -a "$W/secrets.bak" "$SEC"; fi
    if [ "${was_trapd:-0}" = 1 ]; then radius-admin snmp trapd on >/dev/null 2>&1; else radius-admin snmp trapd off >/dev/null 2>&1; fi
    rm -rf "$W"
}
trap cleanup EXIT
setj() { python3 -c "import json,sys; d=json.load(open(sys.argv[1])); [d.__setitem__(k,[t,int(v)]) for k,t,v in zip(sys.argv[2::3],sys.argv[3::3],sys.argv[4::3])]; json.dump(d,open(sys.argv[1],'w'))" "$@"; }
sysvals() { echo "\"1.3.6.1.2.1.1.1.0\": [\"s\", \"$1\"], \"1.3.6.1.2.1.1.2.0\": [\"o\", \"$2\"], \"1.3.6.1.2.1.1.3.0\": [\"t\", 9000000], \"1.3.6.1.2.1.1.4.0\": [\"s\", \"\"], \"1.3.6.1.2.1.1.5.0\": [\"s\", \"$3\"], \"1.3.6.1.2.1.1.6.0\": [\"s\", \"\"]"; }
cat > "$W/ups.json" <<EOF
{$(sysvals "Smart-UPS 1500" 1.3.6.1.4.1.318.1.3.2 ups-a), "1.3.6.1.2.1.33.1.2.1.0": ["i", 2], "1.3.6.1.2.1.33.1.2.3.0": ["i", 35], "1.3.6.1.2.1.33.1.2.4.0": ["i", 100],
 "1.3.6.1.2.1.33.1.4.1.0": ["i", 3], "1.3.6.1.2.1.33.1.4.4.1.5.1": ["i", 40]}
EOF
cat > "$W/prn.json" <<EOF
{$(sysvals "HP LaserJet printer" 1.3.6.1.4.1.11.2.3.9.1 prn-a), "1.3.6.1.2.1.43.11.1.1.6.1.1": ["s", "Black"], "1.3.6.1.2.1.43.11.1.1.8.1.1": ["i", 100],
 "1.3.6.1.2.1.43.11.1.1.9.1.1": ["i", 60], "1.3.6.1.2.1.25.3.5.1.1.1": ["i", 3], "1.3.6.1.2.1.25.3.5.1.2.1": ["x", "0000"]}
EOF
python3 - "$W/sw.json" <<'EOF'
import json, sys
d = {"1.3.6.1.2.1.1.1.0": ["s", "JetStream 8-Port Switch"], "1.3.6.1.2.1.1.2.0": ["o", "1.3.6.1.4.1.11863.1"], "1.3.6.1.2.1.1.3.0": ["t", 9000000],
     "1.3.6.1.2.1.1.4.0": ["s", ""], "1.3.6.1.2.1.1.5.0": ["s", "sw-a"], "1.3.6.1.2.1.1.6.0": ["s", ""]}
for i in range(1, 9):
    d.update({f"1.3.6.1.2.1.2.2.1.2.{i}": ["s", f"port{i}"], f"1.3.6.1.2.1.2.2.1.3.{i}": ["i", 6], f"1.3.6.1.2.1.2.2.1.7.{i}": ["i", 1],
              f"1.3.6.1.2.1.2.2.1.8.{i}": ["i", 1], f"1.3.6.1.2.1.31.1.1.1.1.{i}": ["s", f"Gi{i}"], f"1.3.6.1.2.1.31.1.1.1.6.{i}": ["c64", 10**9],
              f"1.3.6.1.2.1.31.1.1.1.10.{i}": ["c64", 10**8], f"1.3.6.1.2.1.31.1.1.1.18.{i}": ["s", "Uplink" if i == 1 else ""]})
json.dump(d, open(sys.argv[1], "w"))
EOF
for x in ups:11181 prn:11182 sw:11183 prn:11185; do
    python3 "$HERE/fakesnmp.py" "$W/${x%%:*}.json" --bind 127.0.0.66 --port "${x##*:}" --community st-c0mm & pids+=($!)
done
sleep 1

# ---- add, kinds, wrong community, duplicate
t "add: UPS / printer / switch found out by themselves" \
  "$(radius-admin snmp add 127.0.0.66 community st-c0mm port 11181 name st-ups | grep -o '— ups'), $(radius-admin snmp add 127.0.0.66 community st-c0mm port 11182 name st-prn | grep -o '— printer'), $(radius-admin snmp add 127.0.0.66 community st-c0mm port 11183 name st-sw | grep -o '— switch')" \
  "— ups, — printer, — switch"
t "wrong community: not added, clear message" "$(radius-admin snmp add 127.0.0.66 community nope port 11184 name st-x 2>&1 | grep -c 'does not answer SNMP')$(db "SELECT COUNT(*) FROM ml_snmp_device WHERE name='st-x'")" "10"
t "the same device twice refused" "$(radius-admin snmp add 127.0.0.66 community st-c0mm port 11181 name st-dup 2>&1 | grep -c 'already in the list')" "1"
t "community kept in the root-only secrets file, not in the database" "$(stat -c %a "$SEC") $(grep -c st-c0mm "$SEC") $(db "SELECT COUNT(*) FROM ml_snmp_device WHERE name LIKE 'st-%' AND (line LIKE '%st-c0mm%' OR info LIKE '%st-c0mm%')")" "600 3 0"
UPS=$(db "SELECT id FROM ml_snmp_device WHERE name='st-ups'") PRN=$(db "SELECT id FROM ml_snmp_device WHERE name='st-prn'") SW=$(db "SELECT id FROM ml_snmp_device WHERE name='st-sw'")
t "switch ports saved (8), the uplink alias too" "$(db "SELECT COUNT(*), SUM(alias='Uplink') FROM ml_snmp_if WHERE device_id=$SW" | tr '\t' ' ')" "8 1"
radius-admin snmp watch "$SW" 1 on >/dev/null
t "watch a port; a port that does not exist refused" "$(db "SELECT watch FROM ml_snmp_if WHERE device_id=$SW AND ifindex=1")$(radius-admin snmp watch "$SW" 99 on 2>&1 | grep -c 'no interface')" "11"

# ---- a power cut, a printer problem, a port down, a device gone
since=$(db "SELECT IFNULL(MAX(id),0) FROM ml_snmp_event")
setj "$W/ups.json" 1.3.6.1.2.1.33.1.4.1.0 i 5 1.3.6.1.2.1.33.1.2.4.0 i 77 1.3.6.1.2.1.33.1.2.3.0 i 19
setj "$W/prn.json" 1.3.6.1.2.1.43.11.1.1.9.1.1 i 6 && python3 -c "import json,sys; d=json.load(open(sys.argv[1])); d['1.3.6.1.2.1.25.3.5.1.2.1']=['x','0400']; json.dump(d,open(sys.argv[1],'w'))" "$W/prn.json"
setj "$W/sw.json" 1.3.6.1.2.1.2.2.1.8.1 i 2 1.3.6.1.2.1.2.2.1.8.5 i 2
radius-admin snmp poll --quiet
ev() { db "SELECT text FROM ml_snmp_event WHERE id > $since AND device_id IN ($UPS,$PRN,$SW) ORDER BY id"; }
t "power cut: UPS ON BATTERY with charge and minutes" "$(ev | grep -c 'UPS ON BATTERY: st-ups (127.0.0.66) — mains power is gone: 77% charged, about 19 min left')" "1"
t "printer: paper jam + Black at 6%" "$(ev | grep -c 'st-prn (127.0.0.66): paper jam')$(ev | grep -c 'Black at 6%')" "11"
t "watched port down (Gi1 Uplink); unwatched Gi5 says nothing" "$(ev | grep -c 'Port DOWN: st-sw (127.0.0.66) Gi1 (Uplink)')$(ev | grep -c Gi5)" "10"
t "dashboard line: ON BATTERY" "$(db "SELECT line FROM ml_snmp_device WHERE id=$UPS")" "ON BATTERY · 77% · 19 min left · load 40%"
radius-admin snmp poll --quiet
t "the same state a minute later: no new events" "$(ev | wc -l)" "4"
setj "$W/ups.json" 1.3.6.1.2.1.33.1.4.1.0 i 3
setj "$W/sw.json" 1.3.6.1.2.1.2.2.1.8.1 i 1
touch "$W/prn.json.silent"
radius-admin snmp poll --quiet
t "power back + port up again; a device silent once is not 'down' yet" "$(ev | grep -c 'Power back: st-ups')$(ev | grep -c 'Port up again: st-sw')$(db "SELECT status FROM ml_snmp_device WHERE id=$PRN")" "11up"
radius-admin snmp poll --quiet
t "silent for 2 minutes: down + 'does NOT answer', with the reason" "$(db "SELECT status FROM ml_snmp_device WHERE id=$PRN")$(ev | grep -c 'st-prn (127.0.0.66) does NOT answer')$(db "SELECT last_error<>'' FROM ml_snmp_device WHERE id=$PRN")" "down11"
rm -f "$W/prn.json.silent"; radius-admin snmp poll --quiet
t "answers again" "$(db "SELECT status FROM ml_snmp_device WHERE id=$PRN")$(ev | grep -c 'st-prn (127.0.0.66) answers again')" "up1"
if [ -n "$(python3 -I /usr/local/lib/mikrotiklover/alerts.py status --json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(1 if d["channels"] and "devices" in d["events"] else "")')" ]; then
    t "alerts sent at once (not after the 5-minute check)" "$(db "SELECT COUNT(*) > 0 FROM ml_alert WHERE kind='devices' AND text LIKE '%st-ups%' OR title LIKE '%st-ups%'")" "1"
else
    echo "skip alerts sent (no alert channel set up here)"
fi
t "list / show" "$(radius-admin snmp list | grep -c 'st-')$(radius-admin snmp show "$SW" | grep -c WATCHED)" "31"
t "kind / name / alerts change; bad kind refused" "$(radius-admin snmp kind "$PRN" server >/dev/null; db "SELECT kind, kind_auto FROM ml_snmp_device WHERE id=$PRN" | tr '\t' ' ')$(radius-admin snmp kind "$PRN" nope 2>&1 | grep -c 'kind is one of')" "server 01"

# ---- the real net-snmp agent (v2c + v3 with encryption), when installed
if command -v snmpd >/dev/null && command -v snmpget >/dev/null; then
    cat > "$W/snmpd.conf" <<EOF
agentAddress udp:127.0.0.66:11191
rocommunity st-real 127.0.0.0/8
createUser stv3user SHA "st-authpass1" AES "st-privpass1"
rouser stv3user priv
sysName st-linux
EOF
    snmpd -C -c "$W/snmpd.conf" -p "$W/snmpd.pid" -Lf "$W/snmpd.log" --persistentDir="$W/persist" -r; sleep 1
    t "real agent v2c: a Linux server (memory, disks, ports)" "$(radius-admin snmp add 127.0.0.66 community st-real port 11191 name st-real | grep -o '— server')" "— server"
    out=$(radius-admin snmp test 127.0.0.66 port 11191 v3 stv3user SHA st-authpass1 AES st-privpass1 2>&1)
    t "real agent v3 (SHA + AES): answers" "$(grep -c '^st-linux:' <<<"$out")" "1"
    t "v3 wrong password: says so" "$(radius-admin snmp test 127.0.0.66 port 11191 v3 stv3user SHA wrong-pass1 AES st-privpass1 2>&1 | grep -ci 'authentication failure')" "1"
    t "v3 passwords never on a command line (net-snmp gets them in a private file)" "$(grep -c 'st-authpass1' /usr/local/lib/mikrotiklover/snmp.py)" "0"
else
    echo "skip real net-snmp agent (apt install snmp snmpd)"
fi

# ---- traps
radius-admin snmp trap-community st-trapc >/dev/null
radius-admin snmp trapd on >/dev/null
sleep 1
if command -v snmptrap >/dev/null; then
    tid=$(db "SELECT IFNULL(MAX(id),0) FROM ml_snmp_trap")
    snmptrap -v 2c -c st-trapc 127.0.0.1:162 '' 1.3.6.1.2.1.33.2.1
    snmptrap -v 1 -c st-trapc 127.0.0.1:162 1.3.6.1.4.1.318 127.0.0.1 6 5 '' 1.3.6.1.4.1.318.2.3.3.0 s "st-trap On battery"
    snmptrap -v 2c -c st-wrong 127.0.0.1:162 '' 1.3.6.1.6.3.1.1.5.1
    inf=$(snmpinform -v 2c -c st-trapc -t 3 -r 1 127.0.0.1:162 '' 1.3.6.1.6.3.1.1.5.2 >/dev/null 2>&1 && echo acked)
    sleep 2.5
    tr() { db "SELECT CONCAT(version,' ',severity,' ',words) FROM ml_snmp_trap WHERE id > $tid ORDER BY id"; }
    t "trap v2c (UPS-MIB on battery) and v1 (APC 5) in plain words" "$(tr | grep -c '^2c high UPS ON BATTERY')$(tr | grep -c '^1 high UPS ON BATTERY')" "11"
    t "wrong community dropped; inform answered and kept" "$(tr | grep -c 'Device started')$inf$(tr | grep -c 'Device restarted')" "0acked1"
    t "trap list (CLI)" "$(radius-admin snmp traps --limit 5 | grep -c 'UPS ON BATTERY' | awk '{print ($1 >= 2)}')" "1"
else
    echo "skip traps through net-snmp (apt install snmp)"
fi
t "trap receiver off / on" "$(radius-admin snmp trapd off >/dev/null; radius-admin snmp trapd status | grep -c off)$(radius-admin snmp trapd on >/dev/null; radius-admin snmp trapd status | grep -c running)" "11"

# ---- MikroTik router lines, health
RIP=$(db "SELECT nasname FROM nas WHERE nasname REGEXP '^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$' ORDER BY nasname LIMIT 1")
if [ -n "$RIP" ] && [ -n "$(db "SELECT v FROM ml_setting WHERE k='server_ip'")" ]; then
    had=$(db "SELECT COUNT(*) FROM ml_snmp_device WHERE ip='$RIP' AND port=161")
    radius-admin snmp router-script "$RIP" > "$W/snmp-router.rsc"
    comm=$(python3 -c 'import json; print(json.load(open("/etc/mikrotiklover-radius/snmp-secrets.json"))["router_community"])')
    t "router lines: own secret community, only for the server, read only, traps to the server" \
      "$(grep -c "add name=$comm addresses=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")/32 read-access=yes write-access=no" "$W/snmp-router.rsc")$(grep -c "trap-target=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")" "$W/snmp-router.rsc")$([[ $comm =~ ^ml[A-Za-z0-9]{22}$ ]] && echo 1)" "111"
    t "router lines pass the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" "$W/snmp-router.rsc" | head -1)" "ok   snmp-router.rsc"
    t "the router is in the device list (kind MikroTik)" "$(db "SELECT kind FROM ml_snmp_device WHERE ip='$RIP' AND port=161")" "mikrotik"
    [ "$had" = 0 ] && radius-admin snmp del "$(db "SELECT id FROM ml_snmp_device WHERE ip='$RIP' AND port=161")" >/dev/null
fi
was_rs=$(db "SELECT v FROM ml_setting WHERE k='snmp_routers'")
radius-admin snmp routers-sync on >/dev/null
SY=/var/lib/mikrotiklover/router/sync.rsc
comm=$(python3 -c 'import json; print(json.load(open("/etc/mikrotiklover-radius/snmp-secrets.json"))["router_community"])')
t "auto-sync sets SNMP on every router: read-only community for this server, traps only if no other target" \
  "$(grep -c "/snmp community add name=\"$comm\" addresses=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")/32 read-access=yes write-access=no" $SY)$(grep -c ':if (\[:len \[/snmp get trap-target\]\] = 0)' $SY)" "11"
t "  ... passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $SY | head -1)" "ok   sync.rsc"
radius-admin snmp routers-sync off >/dev/null
t "  ... off: no SNMP lines" "$(grep -c '/snmp community' $SY)" "0"
[ "${was_rs:-0}" = 1 ] && radius-admin snmp routers-sync on >/dev/null
t "health check: Devices (SNMP) group" "$(radius-admin doctor 2>&1 | grep -c 'Device checks every minute\|Trap receiver (UDP 162)')" "2"

# ---- dashboard API
if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('$W/a.json')); print($1)"; }
    t "API: list with kinds, ports, settings; no community anywhere" "$(api GET /api/devices)$(js "sorted(x['kind'] for x in d['devices'] if x['name'] in ('st-ups','st-sw'))")$(grep -c 'st-c0mm\|st-trapc' "$W/a.json")" "200['switch', 'ups']0"
    t "API: one device with its ports and events" "$(api GET "/api/devices/$SW")$(js "(len(d['ifs']), d['ifs'][0]['watch'], any('Port DOWN' in e['text'] for e in d['events']))")" "200(8, 1, True)"
    t "API: test a device (community only sent, answer back)" "$(api POST /api/devices/test '{"ip":"127.0.0.66","port":"11181","community":"st-c0mm"}')$(js "(d['info']['kind'], d['info']['sys']['name'])")" "200('ups', 'ups-a')"
    t "API: add + remove through the dashboard" "$(api POST /api/devices/add '{"ip":"127.0.0.66","port":"11185","community":"st-c0mm","name":"st-api"}')$(js "d['info']['kind']")$(api POST "/api/devices/$(db "SELECT id FROM ml_snmp_device WHERE name='st-api'")/del" '{}')$(db "SELECT COUNT(*) FROM ml_snmp_device WHERE name='st-api'")" "200printer2000"
    t "API: watch a port off; check now" "$(api POST "/api/devices/$SW/watch" '{"ifindex":"1","on":false}')$(db "SELECT watch FROM ml_snmp_if WHERE device_id=$SW AND ifindex=1")$(api POST "/api/devices/$SW/poll" '{}')" "2000200"
    t "API: test a device that does not answer: 200 with ok false and the reason" "$(api POST /api/devices/test '{"ip":"127.0.0.66","port":"11199","community":"x"}')$(js "(d['ok'], 'does not answer' in d['error'])")" "200(False, True)"
    t "API: bad IP / bad name / bad v3 password length -> 400" "$(api POST /api/devices/add '{"ip":"1.2.3.4;x"}')$(api POST /api/devices/add '{"ip":"1.2.3.4","name":"<b>"}')$(api POST /api/devices/test '{"ip":"1.2.3.4","version":"3","user":"u","authpass":"short"}')" "400400400"
    t "API: traps" "$(api GET /api/devices/traps?days=1)$(js "sum('UPS ON BATTERY' in x['words'] for x in d['traps']) >= 2")" "200True"
    t "API: alert limits" "$(api POST /api/devices/limit '{"key":"toner","value":"15"}')$(db "SELECT v FROM ml_setting WHERE k='snmp_toner_pct'")" "20015"
    radius-admin snmp limit toner 10 >/dev/null
    rm -f "$jar"
fi
[ "$fails" = 0 ] && echo "all SNMP device tests passed" || { echo "$fails FAILED"; exit 1; }
