#!/usr/bin/env bash
# Policies on / off, and one word blocks every site with it in its name (block-word).
#   sudo bash tests/test-policy-onoff.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-policy-onoff.sh    (+ dashboard API)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
S=/var/lib/mikrotiklover/router/webfilter-policies.rsc OFF=/var/lib/mikrotiklover/policies/.off
cleanup() {
    radius-admin user del po-user >/dev/null 2>&1
    radius-admin policy del po-words >/dev/null 2>&1
    rm -f /var/lib/mikrotiklover/policies/po-bad.txt
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
rules() { grep -c "chain=wfp-po-words " "$S"; }

# 1. block-word
printf '# test: words\nblock-word casino\nblock-word ^bet time=20h-23h,fri,sat\n' | radius-admin policy set po-words >/dev/null
t "word anywhere: one name rule" "$(grep -c 'chain=wfp-po-words protocol=tcp tls-host="\*casino\*" action=reject .*log-prefix="WF-word"' $S)" "1"
t "^word: start of the name, of a part after . and after -" "$(grep -c 'chain=wfp-po-words protocol=tcp tls-host="\(bet\*\|\*\.bet\*\|\*-bet\*\)" .*time=20h-23h,fri,sat' $S)" "3"
t "too short word refused" "$(printf 'block-word ab\n' | radius-admin policy set po-bad 2>&1 | grep -c "bad word 'ab'")" "1"
t "  ... ^ + 2 letters is fine" "$(printf 'block-word ^ab\n' | radius-admin policy set po-bad 2>&1 | grep -c saved)" "1"
radius-admin policy del po-bad >/dev/null
t "other characters refused" "$(printf 'block-word ca*sino\n' | radius-admin policy set po-bad 2>&1 | grep -c 'bad word')" "1"
t "policies file passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   webfilter-policies.rsc"

# 2. on / off
radius-admin user add po-user -p Pass1234 >/dev/null; radius-admin user policy po-user po-words >/dev/null
before=$(rules)
t "on: rules there" "$([ "$before" -gt 0 ] && echo yes)" "yes"
out=$(radius-admin policy off po-words)
t "off: told how many users keep it" "$(grep -c '1 user(s)/group(s) are not limited' <<<"$out")" "1"
t "off: no rules for the routers" "$(rules)" "0"
t "off: the user keeps the policy" "$(radius-admin user show po-user 2>/dev/null | grep -c 'policy-po-words')" "1"
t "off: shown in the list" "$(radius-admin policy list | grep -c '^po-words *\[OFF\]')" "1"
radius-admin policy off po-words >/dev/null
t "off twice: listed once" "$(grep -cx po-words $OFF)" "1"
printf '# test: words\nblock-word casino\nblock-word poker\n' | radius-admin policy set po-words >/dev/null
t "changing a policy that is off keeps it off" "$(rules)$(grep -cx po-words $OFF)" "01"
radius-admin policy on po-words >/dev/null
t "on again: rules back (with the change)" "$(grep -c 'chain=wfp-po-words .*tls-host="\*poker\*"' $S)$(grep -cx po-words $OFF)" "10"
t "unknown policy refused" "$(radius-admin policy off no-such-policy 2>&1 | grep -c "No policy")" "1"
radius-admin policy off po-words >/dev/null
radius-admin user del po-user >/dev/null; radius-admin policy del po-words >/dev/null
t "deleted policy leaves the off list" "$(grep -cx po-words $OFF 2>/dev/null)" "0"
printf '# test: words\nblock-word casino\nblock-word ^bet time=20h-23h,fri,sat\n' | radius-admin policy set po-words >/dev/null
radius-admin user add po-user -p Pass1234 >/dev/null; radius-admin user policy po-user po-words >/dev/null

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/po.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/po.json')); print($1)"; }
    t "API finder: casino in the name blocked" "$(api GET "/api/why?site=www.bestcasino.net&user=po-user")$(js "d['verdict'], 'casino' in d['summary']")" "200blocked True"
    t "API finder: alphabet.com not hit by ^bet" "$(api GET "/api/why?site=abc.alphabet.com&user=po-user")$(js "d['verdict']")" "200allowed"
    t "API: turn off" "$(api POST /api/policies/po-words/off '{}')$(rules)" "2000"
    t "API: list says off" "$(api GET /api/blocking)$(js "[p['enabled'] for p in d['policies'] if p['name']=='po-words']")" "200[False]"
    t "API finder: policy off -> nothing blocked" "$(api GET "/api/why?site=www.bestcasino.net&user=po-user")$(js "d['verdict'], 'OFF' in d['summary']")" "200allowed True"
    t "API summary: one off" "$(api GET /api/blocking/summary)$(js "d['off'] >= 1")" "200True"
    t "API: turn on" "$(api POST /api/policies/po-words/on '{}')$([ "$(rules)" -gt 0 ] && echo yes)" "200yes"
    t "API: bad action 404" "$(api POST /api/policies/po-words/maybe '{}')" "404"
    t "API: bad name 404" "$(api POST '/api/policies/x%3By/off' '{}')" "404"
    rm -f "$jar" /tmp/po.json
fi
[ "$fails" = 0 ] && echo "all policy on/off + word tests passed" || { echo "$fails FAILED"; exit 1; }
