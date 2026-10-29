#!/usr/bin/env bash
# Inline IPS in a small lab on this server: two network namespaces ("MikroTik side" and "LAN side") joined only
# through two cards of this server, with Suricata in between. Checks: alert-only mode, drop mode (the first packet
# of an attack stopped), the guard joining the cards when Suricata dies (internet keeps working), back to inline,
# hand bypass, router file, and back to copy mode.
#   sudo bash tests/test-inline.sh        (needs Suricata: radius-admin ips install; network namespaces)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
command -v suricata >/dev/null || { echo "skipped: Suricata not installed"; exit 0; }
ip netns add mlt-probe 2>/dev/null && ip netns del mlt-probe || { echo "skipped: no network namespaces here"; exit 0; }
S=/var/lib/mikrotiklover/router/sync.rsc EVE=/var/log/suricata/eve.json
was_on=$(db "SELECT v FROM ml_setting WHERE k='ips_on'")
lab_down() {
    ip netns del mlt-wan 2>/dev/null; ip netns del mlt-lan 2>/dev/null
    ip link del mltw 2>/dev/null; ip link del mltl 2>/dev/null; ip link del br-mlbypass 2>/dev/null
}
cleanup() {
    [ -n "${LPID:-}" ] && kill "$LPID" 2>/dev/null
    radius-admin ips inline off >/dev/null 2>&1
    [ "${was_on:-0}" = 1 ] || radius-admin ips off >/dev/null 2>&1
    lab_down
}
trap cleanup EXIT
lab_down
ip netns add mlt-wan; ip netns add mlt-lan
ip link add mltw type veth peer name mltw0; ip link add mltl type veth peer name mltl0
ip link set mltw0 netns mlt-wan; ip link set mltl0 netns mlt-lan
# outside: a public-like address; inside: a LAN address (one cable, two networks: routes on the link)
ip -n mlt-wan addr add 203.0.113.2/32 dev mltw0; ip -n mlt-lan addr add 192.168.77.10/32 dev mltl0
for n in mlt-wan mlt-lan; do ip -n $n link set lo up; done
ip -n mlt-wan link set mltw0 up; ip -n mlt-lan link set mltl0 up
ip -n mlt-wan route add 192.168.77.10/32 dev mltw0; ip -n mlt-lan route add 203.0.113.2/32 dev mltl0
ip netns exec mlt-wan ethtool -K mltw0 tx off rx off >/dev/null 2>&1; ip netns exec mlt-lan ethtool -K mltl0 tx off rx off >/dev/null 2>&1
ip netns exec mlt-lan python3 -c "
import socket, threading, time
for p in (80, 1000):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('0.0.0.0', p)); s.listen(50)
    threading.Thread(target=lambda s=s: [s.accept() for _ in range(10000)], daemon=True).start()
time.sleep(900)" &
LPID=$!
conn() { ip netns exec mlt-wan python3 -c "
import socket; s = socket.socket(); s.settimeout(2)
try: s.connect(('192.168.77.10', $1)); print('open')
except Exception: print('closed')"; }
waitfor() { for i in $(seq 1 ${3:-60}); do [ "$(eval "$1")" = "$2" ] && return 0; sleep 1; done; return 1; }
guard() { python3 -c "import json; d=json.load(open('/run/mikrotiklover/inline.json')); print(d.get('$1'))" 2>/dev/null; }
engine() { python3 -I /usr/local/lib/mikrotiklover/ips.py status | python3 -c "import json,sys; print(json.load(sys.stdin)['running'])"; }

t "lab: no path without the server" "$(conn 80)" "closed"
t "card with an IP address refused" "$(ip addr add 10.99.99.1/32 dev mltw; radius-admin ips inline on mltw mltl 2>&1 | grep -c 'has an IP address'; ip addr del 10.99.99.1/32 dev mltw)" "1"
radius-admin ips inline on mltw mltl alert >/dev/null
waitfor "guard bypass" False 60; waitfor engine True 30
sleep 3
t "inline alert-only: normal traffic passes through Suricata" "$(conn 80)" "open"
start=$(wc -l < $EVE)
t "  ... the MDaemon admin port only alerts" "$(conn 1000)" "open"
sleep 2
t "  ... alert written, action allowed" "$(tail -n +$((start + 1)) $EVE | grep '"dest_port":1000' | grep -c '"action":"allowed"' | awk '{print ($1 > 0)}')" "1"
t "router file: no copy needed in inline mode, blocked list still dropped" "$(grep -c 'sniff-tzsp' $S) $(grep -c 'address-list=ml-ips action=drop' $S)" "0 2"

radius-admin ips inline drop >/dev/null
sleep 4
t "inline drop: rules that stop traffic" "$(grep -c '^drop .*sid:9100008;' /var/lib/suricata/rules/suricata.rules)" "1"
start=$(wc -l < $EVE)
t "  ... the first packet to the admin port is stopped" "$(conn 1000)" "closed"
t "  ... normal traffic still passes" "$(conn 80)" "open"
sleep 2
t "  ... written as blocked" "$(tail -n +$((start + 1)) $EVE | grep '"dest_port":1000' | grep -c '"action":"blocked"' | awk '{print ($1 > 0)}')" "1"

# Suricata dies: the guard joins the two cards within seconds
kill -9 "$(cat /run/mikrotiklover-suricata.pid)"
t0=$(date +%s)
waitfor "guard bypass" True 10
t "Suricata killed: bypass on by itself, reason said" "$(guard bypass) $(guard reason)" "True Suricata stopped"
t "  ... within 3 seconds" "$([ $(( $(date +%s) - t0 )) -le 3 ] && echo yes)" "yes"
t "  ... the internet keeps working (unchecked)" "$(conn 80) $(conn 1000)" "open open"
waitfor "guard bypass" False 90
t "Suricata back by itself: bypass off" "$(guard bypass) $(engine)" "False True"
sleep 2
t "  ... and stops attacks again" "$(conn 1000) $(conn 80)" "closed open"

# Suricata stuck (running, passing nothing): seen from the cards' counters, bypass, fresh start
sp=$(cat /run/mikrotiklover-suricata.pid); kill -STOP "$sp"
ip netns exec mlt-wan ping -i 0.05 -c 400 -W 1 192.168.77.10 >/dev/null 2>&1 &   # 20 s of traffic: a busy server sees the stall later
waitfor "guard reason" "Suricata stuck (packets in, none out)" 25
t "Suricata stuck: bypass on by itself" "$(guard bypass) $(guard reason)" "True Suricata stuck (packets in, none out)"
t "  ... internet keeps working" "$(conn 80)" "open"
kill -CONT "$sp" 2>/dev/null
waitfor "guard bypass" False 90
t "  ... fresh Suricata, bypass off, attacks stopped again" "$(guard bypass) $(conn 1000)" "False closed"

radius-admin ips bypass on >/dev/null; sleep 2
t "bypass by hand: traffic unchecked, stays on" "$(conn 1000) $(sleep 3; guard bypass) $(guard reason)" "open True turned on by hand"
radius-admin ips bypass off >/dev/null; sleep 2
t "bypass off by hand: checked again" "$(conn 1000)" "closed"

radius-admin ips inline off >/dev/null
t "inline off: copy mode again, router copy back" "$(python3 -I /usr/local/lib/mikrotiklover/ips.py mode | grep -c '"copy"') $(grep -c 'sniff-tzsp' $S)" "1 3"
[ "$fails" = 0 ] && echo "all inline IPS tests passed" || { echo "$fails FAILED"; exit 1; }
