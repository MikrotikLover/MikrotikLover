#!/usr/bin/env bash
# "Network se poochho" (AI assistant) on an installed server, against a fake Claude Messages API: the request (model,
# refusal fallback, effort, Roman Urdu system prompt with cache, 9 read-only tools), the tool loop with real server data,
# bad tool input, API errors, key handling, the dashboard API.
#   AI_VENV_PY=/opt/mikrotiklover/venv/bin/python URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-ai.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
[ -x /opt/mikrotiklover/venv/bin/python ] || { echo "skip: no Claude SDK venv (install.sh)"; echo "all AI assistant tests passed (skipped)"; exit 0; }
W=$(mktemp -d) PORT=9931 KEYF=/etc/mikrotiklover-radius/anthropic.key
had_key=0; [ -f $KEYF ] && { had_key=1; cp -p $KEYF "$W/key.bak"; }
was_on=$(db "SELECT v FROM ml_setting WHERE k='ai_on'")
cleanup() {
    [ -n "${FP:-}" ] && kill "$FP" 2>/dev/null
    radius-admin user del ai-exp >/dev/null 2>&1
    db "DELETE FROM traffic_site WHERE username='ai-top'; REPLACE INTO ml_setting (k, v) VALUES ('ai_on', '${was_on:-}')"
    if [ $had_key = 1 ]; then cp -p "$W/key.bak" $KEYF; else rm -f $KEYF; fi
    rm -rf "$W"
}
trap cleanup EXIT
rm -f $KEYF
script() { echo "$1" > "$W/s.json"; }
ask() { printf '%s' "{\"question\": \"$1\"}" | ANTHROPIC_BASE_URL=http://127.0.0.1:$PORT radius-admin ai ask; }
ans() { python3 -c 'import json,sys; d=json.loads(sys.stdin.read().splitlines()[-1]); print(d.get("answer") or d.get("error"))'; }

t "no key: a clear message, no call" "$(ask 'aaj kaun online hai' | ans | grep -c 'no API key')" "1"
t "bad key refused" "$(echo 'not-a-key' | radius-admin ai key 2>&1 | grep -c 'sk-ant')" "1"
echo 'sk-ant-api03-TestKeyOnlyForTheFakeServer000' | radius-admin ai key >/dev/null
t "key saved for root only" "$(stat -c %a $KEYF)" "600"
script '{"tool": "top_users_for", "input": {"app_or_site": "YouTube", "day": "yesterday"}}'
python3 "$HERE/fakeclaude.py" $PORT "$W/log" "$W/s.json" & FP=$!
sleep 1
Y=$(date -d yesterday +%F)
db "INSERT INTO traffic_site (bucket, client_ip, username, site, bytes_down, bytes_up, flows) VALUES ('$Y 10:00:00', '10.9.9.9', 'ai-top', 'youtube.com', 9000000000, 100000000, 5)"
out=$(ask 'kal sab se zyada YouTube kis ne chalaya?')
t "loop: Claude asks a tool, the server answers from its data, Claude answers" "$(echo "$out" | ans | grep -c '1\. ai-top: 9.10 GB')" "1"
t "  ... the dashboard is told which lookups were made" "$(echo "$out" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read().splitlines()[-1]); print([x["tool"] for x in d["tools"]], d["tools"][0]["input"]["day"])')" "['top_users_for'] yesterday"
req() { python3 -c "import json; L=[json.loads(l) for l in open('$W/log')]; r=L[0]; print($1)"; }
t "request: model claude-opus-5-5, effort medium, refusal fallback on" "$(req "r['req']['model'], r['req']['output_config']['effort'], r['req'].get('fallbacks'), 'server-side-fallback-2026-07-01' in r['beta']")" "claude-opus-5-5 medium default True"
t "  ... Roman Urdu system prompt, cached; the key in the header" "$(req "'Roman Urdu' in r['req']['system'][0]['text'], r['req']['system'][0].get('cache_control') == {'type': 'ephemeral'}, r['key']")" "True True sk-ant"
t "  ... only the 9 read-only tools" "$(req "sorted(t['name'] for t in r['req']['tools'])")" "['blocked_attempts', 'find_user', 'health_check', 'online_now', 'security_events', 'top_sites', 'top_users_for', 'user_report', 'why_blocked']"
radius-admin user add ai-exp -p 'Ai-Pass-123' >/dev/null; radius-admin user expiry ai-exp '2020-01-01 00:00' >/dev/null
script '{"tool": "user_report", "input": {"username": "ai-exp"}}'
t "\"X ka internet kyun band hai\": the user report shows the RADIUS refusal" "$(ask 'ai-exp ka internet kyun band hai?' | ans | grep -c 'REFUSED — Your package has expired')" "1"
script '{"tool": "user_report", "input": {"username": "x; rm -rf /"}}'
t "bad tool input: refused with the reason, nothing run" "$(ask 'test' | ans | grep -c 'Error: username: letters')" "1"
script '{"tool": "why_blocked", "input": {"site": "../../etc/passwd"}}'
t "  ... site names checked too" "$(ask 'test' | ans | grep -c 'Error: site')" "1"
python3 - <<'PY' > "$W/ro"
import sys; sys.path.insert(0, "/usr/local/lib/mikrotiklover")
import assistant
q = assistant._db()
try:
    q("INSERT INTO ml_setting (k, v) VALUES ('ai_ro_test', '1')"); print("written")
except Exception as e:
    print("refused" if "READ ONLY" in str(e).upper() or "read-only" in str(e).lower() or "1792" in str(e) else str(e)[:80])
PY
t "the tools' database session is read-only (a write is refused)" "$(cat "$W/ro")" "refused"
script '{"status": 401}'
t "API key refused by Claude: said in plain words" "$(ask 'test' | ans | grep -c 'API key was refused')" "1"
radius-admin ai off >/dev/null
t "off: no call" "$(ask 'test' | ans | grep -c 'is off')" "1"
radius-admin ai on >/dev/null

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: status (on, key, SDK, model)" "$(api GET /api/ai)$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['on'], d['has_key'], d['sdk'], d['model'])")" "200True True True claude-opus-5-5"
    t "API: question checked (empty / too long refused)" "$(api POST /api/ai/ask '{"question":""}')$(api POST /api/ai/ask "{\"question\":\"$(head -c 2100 /dev/zero | tr '\0' a)\"}")" "400400"
    # through the dashboard the real Claude API is asked with the fake key: a plain error comes back, not a crash
    t "API: a failed question comes back as a message" "$(api POST /api/ai/ask '{"question":"aaj kaun online hai?"}')$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['ok'], bool(d['error']))")" "200False True"
    t "API: bad key refused" "$(api POST /api/ai/key '{"key":"abc"}')" "400"
    rm -f "$jar"
fi
[ "$fails" = 0 ] && echo "all AI assistant tests passed" || { echo "$fails FAILED"; exit 1; }
