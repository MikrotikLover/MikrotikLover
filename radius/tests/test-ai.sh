#!/usr/bin/env bash
# "Network se poochho" (AI assistant) on an installed server, against a fake Claude Messages API: the request (model,
# refusal fallback, effort, Roman Urdu system prompt with cache, 9 read-only tools), the tool loop with real server data,
# bad tool input, API errors, key handling, the dashboard API; then the other providers against fakes: Gemini
# (generateContent, function calling) and a local model (Ollama /api/chat, tools), switching provider and model.
#   AI_VENV_PY=/opt/mikrotiklover/venv/bin/python URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-ai.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
[ -x /opt/mikrotiklover/venv/bin/python ] || { echo "skip: no Claude SDK venv (install.sh)"; echo "all AI assistant tests passed (skipped)"; exit 0; }
AI=${AI_VENV_PY:-/opt/mikrotiklover/venv/bin/python}
W=$(mktemp -d) PORT=9931 KEYF=/etc/mikrotiklover-radius/anthropic.key
GKEYF=/etc/mikrotiklover-radius/gemini.key
had_key=0; [ -f $KEYF ] && { had_key=1; cp -p $KEYF "$W/key.bak"; }
had_gkey=0; [ -f $GKEYF ] && { had_gkey=1; cp -p $GKEYF "$W/gkey.bak"; }
db "SELECT k, v FROM ml_setting WHERE k IN ('ai_on','ai_provider','ai_ollama_url','ai_model_claude','ai_model_gemini','ai_model_ollama')" > "$W/settings.bak"
cleanup() {
    [ -n "${FP:-}" ] && kill "$FP" 2>/dev/null
    radius-admin user del ai-exp >/dev/null 2>&1
    [ -n "${FL:-}" ] && kill "$FL" 2>/dev/null
    db "DELETE FROM traffic_site WHERE username='ai-top'; DELETE FROM ml_setting WHERE k IN ('ai_on','ai_provider','ai_ollama_url','ai_model_claude','ai_model_gemini','ai_model_ollama')"
    while IFS=$'\t' read -r k v; do [ -n "$k" ] && db "REPLACE INTO ml_setting (k, v) VALUES ('$k', '$v')"; done < "$W/settings.bak"
    if [ $had_key = 1 ]; then cp -p "$W/key.bak" $KEYF; else rm -f $KEYF; fi
    if [ $had_gkey = 1 ]; then cp -p "$W/gkey.bak" $GKEYF; else rm -f $GKEYF; fi
    rm -rf "$W"
}
trap cleanup EXIT
rm -f $KEYF $GKEYF
db "DELETE FROM ml_setting WHERE k IN ('ai_provider','ai_ollama_url','ai_model_claude','ai_model_gemini','ai_model_ollama')"
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

# ---- the other providers (fake Gemini + fake Ollama on one port)
LP=9941
python3 "$HERE/fakellm.py" $LP "$W/llog" "$W/s.json" & FL=$!
sleep 1
gask() { printf '%s' "{\"question\": \"$1\"}" | ML_GEMINI_BASE_URL=http://127.0.0.1:$LP radius-admin ai ask; }
lreq() { python3 -c "import json; L=[json.loads(l) for l in open('$W/llog')]; r=L[$1]; print($2)"; }
if "$AI" -c 'import google.genai' 2>/dev/null; then
    t "Gemini: bad key refused" "$(echo 'short' | radius-admin ai gemini-key 2>&1 | grep -c 'Gemini API key')" "1"
    echo 'AIzaTestKeyOnlyForTheFakeServer0000000' | radius-admin ai gemini-key >/dev/null
    t "Gemini: key saved for root only, provider switched" "$(stat -c %a $GKEYF) $(radius-admin ai status | grep -c 'Provider     : gemini')" "600 1"
    script '{"tool": "top_users_for", "input": {"app_or_site": "YouTube", "day": "yesterday"}}'
    : > "$W/llog"
    out=$(gask 'kal sab se zyada YouTube kis ne chalaya?')
    t "Gemini loop: function call -> server data -> answer" "$(echo "$out" | ans | grep -c 'ai-top')" "1"
    t "  ... model gemini-2.5-flash, the key in its header, tools listed" "$(lreq 0 "'gemini-2.5-flash:generateContent' in r['path'], r['key'], len(r['req']['tools'][0]['functionDeclarations'])")" "True AIzaTe 9"
    t "  ... Roman Urdu system prompt; the dashboard sees the lookup" "$(lreq 0 "'Roman Urdu' in r['req']['systemInstruction']['parts'][0]['text']") $(echo "$out" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read().splitlines()[-1])["tools"][0]["tool"])')" "True top_users_for"
    radius-admin ai model gemini-2.5-pro >/dev/null; : > "$W/llog"; gask 'test' >/dev/null
    t "Gemini: model changed for Gemini only" "$(lreq 0 "'gemini-2.5-pro:' in r['path']") $(db "SELECT v FROM ml_setting WHERE k='ai_model_claude'" | grep -c .)" "True 0"
    script '{"status": 400}'
    t "Gemini: key refused by Google: said in plain words" "$(gask 'test' | ans | grep -c 'API key was refused')" "1"
else
    echo "skip Gemini: google-genai not in the venv"
fi
t "Ollama: bad address refused" "$(radius-admin ai ollama 'file:///etc' 2>&1 | grep -c 'usage')" "1"
radius-admin ai ollama http://127.0.0.1:$LP qwen2.5:7b >/dev/null
t "Ollama: provider, address and model saved" "$(radius-admin ai status | grep -c 'Provider     : ollama') $(db "SELECT v FROM ml_setting WHERE k='ai_model_ollama'")" "1 qwen2.5:7b"
script '{"tool": "user_report", "input": {"username": "ai-exp"}}'
: > "$W/llog"
t "Ollama loop: tool call -> server data -> answer (no key, nothing leaves the network)" "$(ask 'ai-exp ka internet kyun band hai?' | ans | grep -c 'REFUSED')" "1"
t "  ... model qwen2.5:7b, 9 tools with typed parameters, then the tool result sent back" "$(lreq 0 "r['req']['model'], len(r['req']['tools']), r['req']['tools'][0]['function']['parameters']['type']") $(lreq 1 "r['req']['messages'][-1]['role'], r['req']['messages'][-1]['tool_name']")" "qwen2.5:7b 9 object tool user_report"
script '{"tool": "find_user", "input": {"text": "; drop table"}}'
t "Ollama: bad tool input refused the same way" "$(ask 'test' | ans | grep -c 'Error')" "1"
radius-admin ai ollama http://127.0.0.1:9 >/dev/null
t "Ollama not running: said in plain words" "$(ask 'test' | ans | grep -c 'not answering')" "1"
radius-admin ai ollama http://127.0.0.1:$LP >/dev/null
t "provider: unknown refused; back to Claude keeps its key" "$(radius-admin ai provider openai 2>&1 | grep -c usage) $(radius-admin ai provider claude >/dev/null; radius-admin ai status | grep -c 'API key      : set')" "1 1"
radius-admin ai provider ollama >/dev/null

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    t "API: status (on, provider, ready, model, Ollama address)" "$(api GET /api/ai)$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['on'], d['provider'], d['ready']['claude'], d['ready']['ollama'], d['sdk'], d['model'], d['ollama_url'].endswith(':$LP'))")" "200True ollama True True True qwen2.5:7b True"
    t "API: switch provider / model; bad values refused" "$(api POST /api/ai/provider '{"provider":"claude"}')$(api POST /api/ai/provider '{"provider":"x"}')$(api POST /api/ai/model '{"model":"a b"}')$(api POST /api/ai/ollama '{"url":"ftp://x"}')$(api GET /api/ai)$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['provider'], d['model'])")" "200400400400200claude claude-opus-5-5"
    t "API: Gemini key format checked" "$(api POST /api/ai/gemini-key '{"key":"bad key!"}')" "400"
    t "API: question checked (empty / too long refused)" "$(api POST /api/ai/ask '{"question":""}')$(api POST /api/ai/ask "{\"question\":\"$(head -c 2100 /dev/zero | tr '\0' a)\"}")" "400400"
    # through the dashboard the real Claude API is asked with the fake key: a plain error comes back, not a crash
    t "API: a failed question comes back as a message" "$(api POST /api/ai/ask '{"question":"aaj kaun online hai?"}')$(python3 -c "import json; d=json.load(open('$W/a.json')); print(d['ok'], bool(d['error']))")" "200False True"
    t "API: bad key refused" "$(api POST /api/ai/key '{"key":"abc"}')" "400"
    rm -f "$jar"
fi
[ "$fails" = 0 ] && echo "all AI assistant tests passed" || { echo "$fails FAILED"; exit 1; }
