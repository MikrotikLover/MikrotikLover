#!/usr/bin/env bash
# Step by step: a policy for a network / IP range (no login), pause all blocking, the setup steps and their checks,
# a router script with only one step's part.
#   sudo bash tests/test-golive.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-golive.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
S=/var/lib/mikrotiklover/router/sync.rsc P=/var/lib/mikrotiklover/router/webfilter-policies.rsc
was_golive=$(db "SELECT v FROM ml_setting WHERE k='golive'") was_pause=$(db "SELECT v FROM ml_setting WHERE k='blocking_pause'")
cleanup() {
    db "DELETE FROM ml_policy_net WHERE comment LIKE 'gl-%' OR target LIKE '10.123.%'"
    db "REPLACE INTO ml_setting (k, v) VALUES ('golive', '${was_golive:-{\}}'), ('blocking_pause', '${was_pause:-0}')"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
db "DELETE FROM ml_policy_net WHERE comment LIKE 'gl-%' OR target LIKE '10.123.%'"; radius-admin policy resume >/dev/null

# ---- a policy for a network, a range, one IP
t "network: whole LAN" "$(radius-admin policy net add staff 10.123.0.0/16 gl-office | grep -c 'no login needed')" "1"
radius-admin policy net add guests 10.123.5.10-10.123.5.50 gl-guests >/dev/null
radius-admin policy net add no-internet 10.123.9.7 gl-pc >/dev/null
t "  ... in the router file (address list policy-NAME)" "$(grep -c 'add list=policy-staff address=10.123.0.0/16 comment="mlnet: gl-office"' $S) $(grep -c 'add list=policy-guests address=10.123.5.10-10.123.5.50' $S) $(grep -c 'add list=policy-no-internet address=10.123.9.7 ' $S)" "1 1 1"
t "  ... the old entries are removed first" "$(grep -c 'remove \[find comment~"^mlnet:"\]' $S)" "1"
t "  ... router file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
t "network written in short form (10.123.7.9/24 -> 10.123.7.0/24)" "$(radius-admin policy net add staff 10.123.7.9/24 gl-x >/dev/null; db "SELECT target FROM ml_policy_net WHERE comment='gl-x'")" "10.123.7.0/24"
t "bad address / reversed range / unknown policy refused" "$(radius-admin policy net add staff 10.123.300.1 2>&1 | grep -c 'is not an IP')$(radius-admin policy net add staff 10.123.0.9-10.123.0.1 2>&1 | grep -c 'is not an IP')$(radius-admin policy net add nosuch 10.123.0.1 2>&1 | grep -c 'No policy')" "111"
t "same policy + network twice: one entry" "$(radius-admin policy net add staff 10.123.0.0/16 gl-office >/dev/null; db "SELECT COUNT(*) FROM ml_policy_net WHERE target='10.123.0.0/16'")" "1"
ID=$(db "SELECT id FROM ml_policy_net WHERE comment='gl-x'")
t "remove one" "$(radius-admin policy net del "$ID" | grep -c removed) $(grep -c '10.123.7.0/24' $S)" "1 0"

# ---- pause everything
before=$(grep -c 'chain=wfp-' $P)
radius-admin winupdate off >/dev/null
radius-admin policy pause >/dev/null
t "pause: no policy rule, no Windows Update rule, old ones removed on the router" "$(grep -c 'chain=wfp-' $P) $(grep -c 'wfpolicy:global windows-update' $P) $(grep -c 'remove \[find comment~"^wfpolicy:"\]' $P | awk '{print ($1 > 0)}')" "0 0 1"
t "  ... networks keep their policy (back at once on resume)" "$(grep -c 'mlnet: gl-office' $S)" "1"
radius-admin policy resume >/dev/null; radius-admin winupdate on >/dev/null
t "resume: the rules are back" "$(grep -c 'chain=wfp-' $P)" "$before"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/gl.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/gl.json')); print($1)"; }
    t "API: networks per policy, overlap shown (guests range inside the staff LAN)" "$(api GET /api/blocking)$(js "[(n['target'], n['overlaps']) for p in d['policies'] for n in p['nets'] if n['comment']=='gl-guests']")" "200[('10.123.5.10-10.123.5.50', ['10.123.0.0/16 (staff)'])]"
    t "API: give a network" "$(api POST /api/policies/net '{"policy":"guests","target":"10.123.8.0/24","comment":"gl-api"}')$(grep -c 'address=10.123.8.0/24 comment="mlnet: gl-api"' $S)" "2001"
    NID=$(db "SELECT id FROM ml_policy_net WHERE comment='gl-api'")
    t "API: remove it" "$(api POST /api/policies/net/$NID/del)$(grep -c 'gl-api' $S)" "2000"
    t "API: bad network 400, bad policy name 400" "$(api POST /api/policies/net '{"policy":"guests","target":"x;y"}')$(api POST /api/policies/net '{"policy":"a b","target":"10.123.1.1"}')" "400400"
    t "API: pause / resume" "$(api POST /api/blocking/pause '{"on":true}')$(api GET /api/blocking/summary)$(js "d['paused']")$(api POST /api/blocking/pause '{"on":false}')$(grep -c 'chain=wfp-' $P | awk '{print ($1 > 0)}')" "200200True2001"

    # ---- setup steps
    db "REPLACE INTO ml_setting (k, v) VALUES ('golive', '{}')"
    db "DELETE FROM ml_router_fetch WHERE router_ip='127.0.0.1'"
    t "steps: five, step 1 now" "$(api GET /api/golive)$(js "[s['key'] for s in d['steps']], d['current']")" "200['blocking', 'hotspot', 'usage', 'security', 'advanced'] 1"
    KEY=$(cat /var/lib/mikrotiklover/router/key)
    curl -sk -o /dev/null "https://127.0.0.1:8443/api/public/router/version?key=$KEY"
    touch /var/log/mikrotik/dns.log
    t "step 1 checks: router took the rules, site names arrive, a network has a policy" "$(api GET /api/golive)$(js "[c['ok'] for c in d['steps'][0]['check']][:3]")" "200[True, True, True]"
    radius-admin policy pause >/dev/null
    t "step 1 check: paused blocking is shown" "$(api GET /api/golive)$(js "d['paused'], d['steps'][0]['check'][-1]['ok']")" "200True False"
    radius-admin policy resume >/dev/null
    t "mark step 1 done: step 2 is now" "$(api POST /api/golive/done '{"step":"blocking","done":true}')$(api GET /api/golive)$(js "bool(d['steps'][0]['done']), d['current']")" "200200True 2"
    t "open it again" "$(api POST /api/golive/done '{"step":"blocking","done":false}')$(api GET /api/golive)$(js "d['current']")" "2002001"
    t "unknown step 400" "$(api POST /api/golive/done '{"step":"x","done":true}')" "400"
    # router script with only one step's part
    RT=$(db "SELECT nasname FROM nas ORDER BY nasname LIMIT 1")
    t "router script, step 2: only the hotspot (no blocking base again, no security)" \
      "$(api POST /api/router-setup "{\"router\":\"$RT\",\"server_ip\":\"192.168.88.10\",\"lan_if\":\"bridge\",\"hotspot\":true,\"base_done\":true}")$(js "('hotspot' in d['script'].split('parts:')[1].split(chr(10))[0], 'webfilter-base' in d['script'], 'mlsec' in d['script'])")" "200(True, False, False)"
    t "router script, step 1: blocking base, logs, DNS logger, auto-sync — no hotspot" \
      "$(api POST /api/router-setup "{\"router\":\"$RT\",\"server_ip\":\"192.168.88.10\",\"lan_if\":\"bridge\",\"webfilter\":true,\"logging\":true,\"dnslog\":true,\"autosync\":true}")$(js "d['script'].split('parts: ')[1].split(chr(10))[0]")" "200webfilter, logging, dnslog, autosync"
    rm -f "$jar" /tmp/gl.json
fi
[ "$fails" = 0 ] && echo "all step-by-step tests passed" || { echo "$fails FAILED"; exit 1; }
