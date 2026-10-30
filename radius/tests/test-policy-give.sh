#!/usr/bin/env bash
# radius-admin policy give: one policy for many users at once (dashboard: Users list select / bulk bar, Blocking → Give a policy)
# Needs an installed server (sudo). Makes and removes its own users.
set -uo pipefail
fails=0
t() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails+1)); fi; }
pol() { mysql radius -N -e "SELECT IFNULL((SELECT value FROM radreply WHERE username='$1' AND attribute='Mikrotik-Address-List'),'-')"; }
P=$(ls /var/lib/mikrotiklover/policies/*.txt | grep -v README | head -1 | xargs basename | sed 's/\.txt$//')
for u in pgtest1 pgtest2 pgtest3; do radius-admin user del $u >/dev/null 2>&1; radius-admin user add $u -p 'Pg#Test-2026' >/dev/null; done
out=$(radius-admin policy give "$P" pgtest1 pgtest2 2>&1)
t "two users at once" '[ "$(pol pgtest1)" = "policy-$P" ] && [ "$(pol pgtest2)" = "policy-$P" ]'
out=$(printf 'pgtest3\n\n  \n' | radius-admin policy give "$P" - 2>&1)
t "names on stdin (blank lines skipped)" '[ "$(pol pgtest3)" = "policy-$P" ]'
out=$(radius-admin policy give - pgtest1 pgtest2 2>&1)
t "back to the group's policy" '[ "$(pol pgtest1)" = "-" ] && [ "$(pol pgtest2)" = "-" ] && [ "$(pol pgtest3)" = "policy-$P" ]'
out=$(radius-admin policy give "$P" pgtest1 no-such-user-pg 2>&1); rc=$?
t "an unknown user: warned, the others still done" '[ $rc = 0 ] && grep -q "no such user" <<<"$out" && [ "$(pol pgtest1)" = "policy-$P" ]'
out=$(radius-admin policy give "$P" no-such-user-pg 2>&1); rc=$?
t "only unknown users: error" '[ $rc != 0 ]'
out=$(radius-admin policy give no-such-policy pgtest1 2>&1); rc=$?
t "unknown policy refused, nothing changed" '[ $rc != 0 ] && [ "$(pol pgtest1)" = "policy-$P" ]'
out=$(radius-admin policy give "$P" "bad name" 2>&1); rc=$?
t "bad user name refused" '[ $rc != 0 ]'
out=$(radius-admin policy give "$P" 2>&1); rc=$?
t "no users: usage" '[ $rc != 0 ] && grep -q usage <<<"$out"'
for u in pgtest1 pgtest2 pgtest3; do radius-admin user del $u >/dev/null 2>&1; done
[ $fails = 0 ] && echo "all policy give tests passed" || echo "$fails FAILED"
exit $fails
