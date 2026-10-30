#!/usr/bin/env bash
# Apps on the network with their names, server addresses, ports and the kind of device (Android / iPhone /
# Windows), and the hourly self-check (health: router rules, policies self-test, routers taking the rules).
#   sudo bash tests/test-apps-health.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-apps-health.sh    (+ dashboard API)
#   KEEP=1 ...   leave the sample data (for screenshots)
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
DNSLOG=/var/log/mikrotik/dns.log PD=/var/lib/mikrotiklover/policies HJ=/var/lib/mikrotiklover/health.json
AND=10.98.0.11 IPH=10.98.0.12 WIN=10.98.0.13
had_port=$(db "SELECT COUNT(*) FROM ml_app_port WHERE site='whatsapp.com' AND proto=17 AND port=3478")
cleanup() {
    [ -n "${KEEP:-}" ] && return
    for d in $AND $IPH $WIN; do sed -i "/ $d\/5000 /d" "$DNSLOG"; done
    db "DELETE FROM ml_device WHERE client_ip IN ('$AND','$IPH','$WIN'); DELETE FROM ml_app_day WHERE client_ip IN ('$AND','$IPH','$WIN');
        DELETE FROM ml_app_server WHERE ip LIKE '203.0.113.%'; DELETE FROM ml_router_fetch WHERE router_ip='127.0.0.1'"
    [ "$had_port" = 0 ] && db "DELETE FROM ml_app_port WHERE site='whatsapp.com' AND proto=17 AND port=3478"
    rm -f "$PD/ah-direct.txt"; radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
n=500
look() { # client name ip
    n=$((n+1)); local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
    printf '%s 127.0.0.1 dnsmasq[1]: %s %s/5000 query[A] %s from %s\n%s 127.0.0.1 dnsmasq[1]: %s %s/5000 reply %s is %s\n' \
        "$ts" "$n" "$1" "$2" "$1" "$ts" "$n" "$1" "$2" "$3" >> "$DNSLOG"
}
# an Android phone, an iPhone and a Windows laptop: each one's system asks its own names by itself
look $AND connectivitycheck.gstatic.com 203.0.113.1; look $AND play.googleapis.com 203.0.113.2
look $AND g.whatsapp.net 203.0.113.31; look $AND mmg.whatsapp.net 203.0.113.32; look $AND v16-webapp.tiktokcdn.com 203.0.113.41
look $IPH captive.apple.com 203.0.113.5; look $IPH g.whatsapp.net 203.0.113.31; look $IPH scontent.cdninstagram.com 203.0.113.51
look $WIN www.msftconnecttest.com 203.0.113.6; look $WIN settings-win.data.microsoft.com 203.0.113.7; look $WIN rr1---sn-x.googlevideo.com 203.0.113.61
[ "$had_port" = 0 ] && db "INSERT INTO ml_app_port (site, proto, port, direction, bytes, flows) VALUES ('whatsapp.com',17,3478,'out',40000000,20)"
radius-admin apps update >/dev/null 2>&1
t "device kind: Android, Apple, Windows" "$(db "SELECT GROUP_CONCAT(os ORDER BY client_ip) FROM ml_device WHERE client_ip IN ('$AND','$IPH','$WIN')")" "android,apple,windows"
t "  ... with the names that showed it" "$(db "SELECT evidence FROM ml_device WHERE client_ip='$AND'" | grep -c connectivitycheck.gstatic.com)" "1"
t "app servers: WhatsApp's addresses from the DNS answers" "$(db "SELECT GROUP_CONCAT(ip ORDER BY ip) FROM ml_app_server WHERE site='whatsapp.com' AND ip LIKE '203.0.113.%'")" "203.0.113.31,203.0.113.32"
t "  ... with the name that was asked" "$(db "SELECT host FROM ml_app_server WHERE site='whatsapp.com' AND ip='203.0.113.32'")" "mmg.whatsapp.net"

# the self-check
radius-admin policy build >/dev/null
radius-admin doctor --save >/dev/null 2>&1
J="python3 -c \"import json; d={c['id']: c for c in json.load(open('$HJ'))['checks']}"
t "health: saved for the dashboard and the alerts" "$([ -f "$HJ" ] && echo yes)" "yes"
t "health: router rules built after the last policy change" "$(eval "$J; print(d['rules']['status'])\"")" "ok"
t "health: router files import cleanly (lint)" "$(eval "$J; print(d['rsc']['status'])\"")" "ok"
t "health: policies self-test passes" "$(eval "$J; print(d['policies']['status'], 'rules tried' in d['policies']['detail'])\"")" "ok True"
sleep 1; printf '# health test: written by hand, rules not built\nblock-site example-direct.com\n' > "$PD/ah-direct.txt"
radius-admin doctor --save >/dev/null 2>&1
t "health: a policy changed after the build is seen" "$(eval "$J; print(d['rules']['status'], 'changed after' in d['rules']['detail'])\"")" "warn True"
t "health: a policy missing from the router rules fails the self-test" "$(eval "$J; print(d['policies']['status'], 'ah-direct' in d['policies']['detail'])\"")" "fail True"
radius-admin policy build >/dev/null; radius-admin doctor --save >/dev/null 2>&1
t "  ... fine after the build" "$(eval "$J; print(d['rules']['status'], d['policies']['status'])\"")" "ok ok"
rm -f "$PD/ah-direct.txt"; radius-admin policy build >/dev/null
# a router takes the rules: the server notes it
KEY=$(radius-admin policy sync 2>/dev/null | grep -o 'key=[A-Za-z0-9]*' | head -1 | cut -d= -f2)
curl -sk -o /dev/null "https://127.0.0.1:8443/api/public/router/version?key=$KEY"
curl -sk -o /dev/null "https://127.0.0.1:8443/api/public/router/sync.rsc?key=$KEY"
t "router fetch noted (version + sync)" "$(db "SELECT COUNT(*) FROM ml_router_fetch WHERE router_ip='127.0.0.1' AND at > NOW() - INTERVAL 1 MINUTE")" "2"
radius-admin doctor --save >/dev/null 2>&1
t "health: the router has the newest rules" "$(eval "$J; c=d.get('sync:127.0.0.1', {}); print(c.get('status'), 'newest rules' in c.get('detail', ''))\"")" "ok True"
db "UPDATE ml_router_fetch SET at = NOW() - INTERVAL 3 HOUR WHERE router_ip='127.0.0.1'"
radius-admin doctor --save >/dev/null 2>&1
t "health: a router that stopped asking fails, with what to do" "$(eval "$J; c=d['sync:127.0.0.1']; print(c['status'], 're-import' in c['fix'])\"")" "fail True"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ah.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ah.json')); print($1)"; }
    t "API apps: Android filter keeps the Android phone's apps" "$(api GET '/api/apps?days=1&os=android')$(js "sorted(r['app'] for r in d['rows'] if r['app'] in ('WhatsApp','TikTok','Instagram','YouTube'))")" "200['TikTok', 'WhatsApp']"
    t "API apps: devices of each kind per app" "$(api GET '/api/apps?days=1')$(js "[(r['android'], r['apple']) for r in d['rows'] if r['app']=='WhatsApp']")" "200[(1, 1)]"
    t "API app detail: servers, ports, devices with their kind" "$(api GET '/api/apps/detail?site=whatsapp.com&days=1')$(js "('203.0.113.32' in [s['ip'] for s in d['servers']], ('udp', 3478) in [(p['proto'], p['port']) for p in d['ports']], sorted(x['os'] or '' for x in d['devices'] if x['client_ip'].startswith('10.98.')), 'mmg.whatsapp.net' in [n['host'] for n in d['names']], len(d['known']) > 0)")" "200(True, True, ['android', 'apple'], True, True)"
    t "API app detail: unknown app 404" "$(api GET '/api/apps/detail?site=no-such-app.example')" "404"
    t "API app detail: bad name 400" "$(api GET '/api/apps/detail?site=a%3Bb')" "400"
    t "API apps: bad kind 400" "$(api GET '/api/apps?os=nokia')" "400"
    t "API health: the saved hourly check at once" "$(api GET '/api/health?saved=1')$(js "d['saved'], 'checks' in d")" "200True True"
    rm -f "$jar" /tmp/ah.json
fi
[ "$fails" = 0 ] && echo "all apps + health tests passed" || { echo "$fails FAILED"; exit 1; }
