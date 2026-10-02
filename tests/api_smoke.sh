#!/usr/bin/env bash
# API smoke test for Batch 1 (auth, setup, users, roles, audit, CSRF, lockout).
# Requires: a FRESH database (schema.sql + seed.sql, no users), curl, php.
# Usage: BASE=http://127.0.0.1:8080 SETUP_KEY=... tests/api_smoke.sh
set -u
BASE="${BASE:-http://127.0.0.1:8080}"
API="$BASE/api/index.php?r="
SETUP_KEY="${SETUP_KEY:-}"
JAR=$(mktemp); JAR2=$(mktemp)
PASS=0; FAIL=0

json() { php -r '$d=json_decode(stream_get_contents(STDIN),true); $v=$d; foreach(explode(".",$argv[1]) as $k){ $v=is_array($v)&&array_key_exists($k,$v)?$v[$k]:null; } echo is_bool($v)?($v?"true":"false"):(is_array($v)?json_encode($v):(string)$v);' "$1"; }
req() { # method route body jar csrf -> prints "status|body"
  local out; out=$(curl -s -o - -w '\n%{http_code}' -X "$1" -b "$4" -c "$4" -H 'Content-Type: application/json' -H "X-CSRF-Token: ${5:-}" ${3:+--data "$3"} "$API$2")
  echo "$(tail -n1 <<<"$out")|$(sed '$d' <<<"$out")"
}
check() { # name expected actual
  if [[ "$2" == "$3" ]]; then PASS=$((PASS+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1 (expected '$2', got '$3')"; fi
}

echo "== bootstrap"
R=$(req GET auth/bootstrap "" "$JAR"); B=${R#*|}
check "bootstrap 200" 200 "${R%%|*}"
check "needs setup" true "$(json data.needs_setup <<<"$B")"
CSRF=$(json data.csrf <<<"$B")
R=$(curl -s -D - -o /dev/null "${API}auth/bootstrap")
check "no-cache header" 1 "$(grep -ci '^cache-control: no-store' <<<"$R")"
check "litespeed no-cache header" 1 "$(grep -ci '^x-litespeed-cache-control: no-cache' <<<"$R")"

echo "== csrf"
R=$(req POST auth/login '{"username":"x","password":"y"}' "$JAR" "bad-token")
check "login without valid csrf -> 419" 419 "${R%%|*}"

echo "== setup"
if [[ -n "$SETUP_KEY" ]]; then
  R=$(req POST setup/admin '{"setup_key":"wrong","full_name":"Admin","username":"admin","password":"Admin12345","confirm_password":"Admin12345"}' "$JAR" "$CSRF")
  check "wrong setup key -> 422" 422 "${R%%|*}"
fi
R=$(req POST setup/admin "{\"setup_key\":\"$SETUP_KEY\",\"full_name\":\"Admin\",\"username\":\"admin\",\"password\":\"short\",\"confirm_password\":\"short\"}" "$JAR" "$CSRF")
check "weak password -> 422" 422 "${R%%|*}"
check "error beside password field" 1 "$(json data <<<"${R#*|}" >/dev/null; [[ -n "$(json errors.password <<<"${R#*|}")" ]] && echo 1 || echo 0)"
R=$(req POST setup/admin "{\"setup_key\":\"$SETUP_KEY\",\"full_name\":\"Site Admin\",\"username\":\"admin\",\"password\":\"Admin12345\",\"confirm_password\":\"Admin12345\"}" "$JAR" "$CSRF")
check "create admin 200" 200 "${R%%|*}"
CSRF=$(json data.csrf <<<"${R#*|}")
check "logged in as admin" admin "$(json data.user.role_code <<<"${R#*|}")"
R=$(req POST setup/admin "{\"setup_key\":\"$SETUP_KEY\",\"full_name\":\"X\",\"username\":\"admin2\",\"password\":\"Admin12345\",\"confirm_password\":\"Admin12345\"}" "$JAR" "$CSRF")
check "second setup refused 409" 409 "${R%%|*}"

echo "== users"
R=$(req GET roles "" "$JAR"); ROLE_GATE=$(php -r '$d=json_decode($argv[1],true); foreach($d["data"] as $r) if($r["code"]==="gate") echo $r["id"];' "${R#*|}")
check "roles listed" 200 "${R%%|*}"
R=$(req POST users "{\"username\":\"gate1\",\"full_name\":\"Gate Man\",\"role_id\":$ROLE_GATE,\"lang\":\"ur\",\"is_active\":true,\"password\":\"Gate12345\",\"must_change_password\":true}" "$JAR" "$CSRF")
check "create user 201" 201 "${R%%|*}"
GATE_ID=$(json data.id <<<"${R#*|}")
R=$(req POST users "{\"username\":\"gate1\",\"full_name\":\"Dup\",\"role_id\":$ROLE_GATE,\"lang\":\"en\",\"password\":\"Gate12345\"}" "$JAR" "$CSRF")
check "duplicate username 422" 422 "${R%%|*}"
check "duplicate error on username" 1 "$([[ -n "$(json errors.username <<<"${R#*|}")" ]] && echo 1 || echo 0)"
R=$(req PUT "users/$GATE_ID" "{\"username\":\"gate1\",\"full_name\":\"Gate Keeper\",\"role_id\":$ROLE_GATE,\"lang\":\"ur\",\"is_active\":true,\"phone\":\"0300-1234567\"}" "$JAR" "$CSRF")
check "update user 200" 200 "${R%%|*}"
R=$(req DELETE "users/1" "" "$JAR" "$CSRF")
check "cannot delete self 422" 422 "${R%%|*}"
R=$(req GET "users&q=gate" "" "$JAR")
check "search users" 1 "$(json data.total <<<"${R#*|}")"

echo "== gate user: forced password change + permissions"
R=$(req GET auth/bootstrap "" "$JAR2"); C2=$(json data.csrf <<<"${R#*|}")
R=$(req POST auth/login '{"username":"gate1","password":"Gate12345"}' "$JAR2" "$C2"); C2=$(json data.csrf <<<"${R#*|}")
check "gate login 200" 200 "${R%%|*}"
check "must change password flag" 1 "$(json data.user.must_change_password <<<"${R#*|}")"
R=$(req GET users "" "$JAR2")
check "blocked until password change 403" password_change_required "$(json code <<<"${R#*|}")"
R=$(req POST auth/password '{"current_password":"Gate12345","new_password":"NewGate123","confirm_password":"NewGate123"}' "$JAR2" "$C2"); C2=$(json data.csrf <<<"${R#*|}")
check "password changed 200" 200 "${R%%|*}"
R=$(req GET users "" "$JAR2")
check "gate cannot list users 403" 403 "${R%%|*}"
R=$(req GET auth/me "" "$JAR2")
check "gate has igp.create" 1 "$(php -r 'echo (int)in_array("igp.create", json_decode($argv[1],true)["data"]["permissions"]);' "${R#*|}")"

echo "== admin reset invalidates gate session"
R=$(req POST "users/$GATE_ID/password" '{"new_password":"Reset12345"}' "$JAR" "$CSRF")
check "reset password 200" 200 "${R%%|*}"
R=$(req GET auth/me "" "$JAR2")
check "old session rejected 401" 401 "${R%%|*}"

echo "== roles matrix"
R=$(req PUT "roles/$ROLE_GATE/permissions" '{"codes":["dashboard.view","igp.view"]}' "$JAR" "$CSRF")
check "update permissions 200" 200 "${R%%|*}"
R=$(req PUT "roles/1/permissions" '{"codes":[]}' "$JAR" "$CSRF")
check "admin role locked 422" 422 "${R%%|*}"

echo "== lockout"
R=$(req GET auth/bootstrap "" "$JAR2"); C2=$(json data.csrf <<<"${R#*|}")
for i in 1 2 3 4 5; do R=$(req POST auth/login '{"username":"gate1","password":"wrong-pass1"}' "$JAR2" "$C2"); done
check "5th failure 401" 401 "${R%%|*}"
R=$(req POST auth/login '{"username":"gate1","password":"Reset12345"}' "$JAR2" "$C2")
check "locked even with right password 429" 429 "${R%%|*}"

echo "== urdu messages"
R=$(curl -s -X POST -b "$JAR" -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -H 'X-Lang: ur' --data '{"username":"","full_name":""}' "${API}users")
check "urdu validation message" "یہ خانہ ضروری ہے۔" "$(json errors.username <<<"$R")"

echo "== audit"
R=$(req GET "audit&entity=users" "" "$JAR")
check "audit entries recorded" 1 "$([[ $(json data.total <<<"${R#*|}") -ge 6 ]] && echo 1 || echo 0)"

echo "== logout"
R=$(req POST auth/logout "" "$JAR" "$CSRF")
check "logout 200" 200 "${R%%|*}"
R=$(req GET auth/me "" "$JAR")
check "me after logout 401" 401 "${R%%|*}"

rm -f "$JAR" "$JAR2"
echo; echo "passed: $PASS  failed: $FAIL"
[[ $FAIL -eq 0 ]]
