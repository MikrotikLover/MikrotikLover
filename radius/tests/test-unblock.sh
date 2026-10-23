#!/usr/bin/env bash
# Site exceptions and unblock requests on an installed server (root, database, nginx).
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-unblock.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
DEV=10.99.0.17
ip addr add $DEV/32 dev lo 2>/dev/null
was=$(db "SELECT v FROM ml_setting WHERE k='blockpage_on'")
cleanup() {
    radius-admin user del ub-user >/dev/null 2>&1
    db "DELETE FROM radacct WHERE acctuniqueid LIKE 'ubt-%'; DELETE FROM ml_block_event WHERE ip='$DEV'; DELETE FROM ml_unblock WHERE ip='$DEV' OR username='ub-user';
        REPLACE INTO ml_setting (k, v) VALUES ('blockpage_on', '${was:-0}')"
    rm -f /var/lib/mikrotiklover/policies/ub-test.txt
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
KEY=$(cat /var/lib/mikrotiklover/router/key)
radius-admin user add ub-user -p Pass1234 >/dev/null
db "INSERT INTO radreply (username, attribute, op, value) VALUES ('ub-user','Mikrotik-Address-List',':=','policy-ub-test')"
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctupdatetime) VALUES ('u1','ubt-1','ub-user','127.0.0.1','$DEV',NOW(),NOW())"

# ---- block-site / allow-site in a policy
printf '# test\nblock social\nblock-site example-bet.com\nallow-site linkedin.com\n' | radius-admin policy set ub-test >/dev/null
S=/var/lib/mikrotiklover/router/sync.rsc
t "policy runs in its own chain" "$(grep -c 'src-address-list=policy-ub-test action=jump jump-target=wfp-ub-test' $S)" "1"
t "allow-site first: return before the blocks" "$(grep -n 'chain=wfp-ub-test' $S | head -1 | grep -c 'tls-host=\"linkedin.com\" action=return')" "1"
t "block-site: the site and its subdomains, logged WF-site" "$(grep -c 'chain=wfp-ub-test protocol=tcp tls-host="\*\.example-bet.com" action=reject.*log-prefix="WF-site"' $S)" "1"
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" $S | head -1)" "ok   sync.rsc"
t "bad site refused" "$(printf 'block-site bad_site\n' | radius-admin policy set ub-test 2>&1 | grep -c 'bad site')" "1"
t "finder: allow-site beats the category" "$(radius-admin why www.linkedin.com ub-user | grep -c 'allows it: allow-site linkedin.com')" "1"
t "finder: block-site" "$(radius-admin why m.example-bet.com ub-user | grep -c 'Blocked by policy .ub-test.: block-site example-bet.com')" "1"

# ---- request from the block page -> alert -> approve -> router -> open
radius-admin blockpage on >/dev/null
req() { curl -s --interface $DEV -m 15 -H "Host: $1" -H 'Accept: text/html' -o /tmp/ub.out -w '%{http_code}' "http://127.0.0.1:8082${2:-/}" "${@:3}"; }
t "blocked site: block page with the request button" "$(req www.facebook.com /)$(grep -c 'action="/__mlrequest"' /tmp/ub.out)" "4031"
code=$(grep -o 'name="code" value="[A-Z0-9]*' /tmp/ub.out | cut -d'"' -f4)
t "request with a wrong code refused" "$(req www.facebook.com /__mlrequest -d code=ZZZZZZ -d note=x)" "400"
t "request sent" "$(req www.facebook.com /__mlrequest -d "code=$code" --data-urlencode 'note=School project <b>')$(grep -c 'admin ko bhej di' /tmp/ub.out)" "2001"
t "  ... saved with user, policy and a cleaned note" "$(db "SELECT CONCAT(username,'|',host,'|',policy,'|',status,'|',note) FROM ml_unblock WHERE ip='$DEV'")" "ub-user|www.facebook.com|ub-test|pending|School project  b"
t "same request twice: not stored again" "$(req www.facebook.com /__mlrequest -d "code=$code" >/dev/null; db "SELECT COUNT(*) FROM ml_unblock WHERE ip='$DEV'")" "1"
rid=$(db "SELECT id FROM ml_unblock WHERE ip='$DEV'")
alert=$(python3 - "$rid" <<'PY'
import sys; sys.path.insert(0, "/usr/local/lib/mikrotiklover")
import alerts
class DB:
    def rows(self, q):
        import subprocess
        return [tuple(l.split("\t")) for l in subprocess.run(["mysql", "radius", "-N", "-B", "-e", q], capture_output=True, text=True).stdout.splitlines()]
st = {"unblock_id": int(sys.argv[1]) - 1}
f = alerts.check({"EVENTS": "requests"}, DB(), st, ping_fn=lambda a: True, running_fn=lambda p: True)
print("\n".join(l for k, l in f if k == "requests"))
PY
)
t "admin alert names the user, site and the approve command" "$(grep -c "Request #$rid: ub-user wants www.facebook.com (policy ub-test) — \"School project  b\"\. .*unblock approve $rid 1h" <<<"$alert")" "1"
L=$(curl -sk "https://127.0.0.1:8443/api/public/router/live.rsc?key=$KEY")
t "router: nothing open before the answer" "$(grep -c 'mltemp:' <<<"$L")" "2"
radius-admin unblock approve "$rid" 1h --by tester >/dev/null
t "approved for 1 hour, by whom" "$(db "SELECT CONCAT(status,'|',decided_by,'|',TIMESTAMPDIFF(MINUTE, NOW(), until) BETWEEN 58 AND 60) FROM ml_unblock WHERE id=$rid")" "allowed|tester|1"
L=$(curl -sk "https://127.0.0.1:8443/api/public/router/live.rsc?key=$KEY")
t "router: return rules on top of the user's policy chain (name + address)" "$(grep -c "add chain=wfp-ub-test src-address=$DEV protocol=tcp tls-host=\"www.facebook.com\" action=return comment=\"mltemp:$rid\" place-before" <<<"$L")$(grep -c "src-address=$DEV dst-address-list=mltemp-$rid action=return" <<<"$L")" "11"
printf '%s\n' "$L" > /tmp/ub-live.rsc
t "router script passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" /tmp/ub-live.rsc | head -1)" "ok   ub-live.rsc"
t "router script only re-applies when something changed (signature)" "$(grep -c ':if (\$mlTempSig != "' <<<"$L")" "1"
t "block page now lets it through" "$(req www.facebook.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/ub.out)" "0"
t "other blocked sites stay blocked" "$(req www.instagram.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/ub.out)" "1"
radius-admin unblock end "$rid" >/dev/null
t "ended: router rules gone, site blocked again" "$(curl -sk "https://127.0.0.1:8443/api/public/router/live.rsc?key=$KEY" | grep -c "mltemp-$rid")$(req www.facebook.com / >/dev/null; grep -c 'Yeh website band hai' /tmp/ub.out)" "01"
db "UPDATE ml_unblock SET status='allowed', until=NOW() - INTERVAL 1 MINUTE WHERE id=$rid"
t "expired exception closes by itself" "$(curl -sk "https://127.0.0.1:8443/api/public/router/live.rsc?key=$KEY" | grep -c "mltemp-$rid")" "0"
radius-admin unblock approve "$rid" always >/dev/null
t "always: allow-site added to the user's policy" "$(grep -cx 'allow-site facebook.com' /var/lib/mikrotiklover/policies/ub-test.txt)$(db "SELECT status FROM ml_unblock WHERE id=$rid")" "1always"
t "  ... and the router rules have it" "$(grep -c 'chain=wfp-ub-test protocol=tcp tls-host="facebook.com" action=return' $S)" "1"
t "manual opening without a request" "$(radius-admin unblock allow ub-user https://www.pubg.com/x today | grep -c 'may open www.pubg.com')" "1"
t "bad duration refused" "$(radius-admin unblock allow ub-user pubg.com 99h 2>&1 | grep -c '1h .. 24h')" "1"
t "deny" "$(radius-admin unblock deny "$rid" | grep -c refused)$(db "SELECT status FROM ml_unblock WHERE id=$rid")" "1denied"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ub.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    db "INSERT INTO ml_unblock (ip, username, host, policy) VALUES ('$DEV','ub-user','www.snapchat.com','ub-test')"
    r2=$(db "SELECT id FROM ml_unblock WHERE host='www.snapchat.com' AND ip='$DEV'")
    t "API: list" "$(api GET /api/unblock)$(python3 -c "import json; d=json.load(open('/tmp/ub.json')); print(any(r['id']==$r2 for r in d['pending']), len(d['open'])>=1)")" "200True True"
    t "API: today" "$(api POST /api/unblock/$r2 '{"how":"today"}')$(db "SELECT CONCAT(status,'|',decided_by,'|',DATE(until)=CURDATE()) FROM ml_unblock WHERE id=$r2")" "200allowed|$USER|1"
    t "API: bad answer 400" "$(api POST /api/unblock/$r2 '{"how":"forever"}')" "400"
    t "API: end" "$(api POST /api/unblock/$r2 '{"how":"end"}')$(db "SELECT status FROM ml_unblock WHERE id=$r2")" "200ended"
    t "API: open for a user" "$(api POST /api/unblock/allow '{"user":"ub-user","site":"khanacademy.org","how":"2h"}')" "200"
    t "API: finder shows the open exception" "$(api GET '/api/why?site=www.khanacademy.org&user=ub-user')$(python3 -c "import json; d=json.load(open('/tmp/ub.json')); print(d['verdict'], d['notes'][0][:16])")" "200allowed Temporarily OPEN"
    t "API: bad site 400" "$(api POST /api/unblock/allow '{"user":"ub-user","site":"not a site","how":"2h"}')" "400"
    rm -f "$jar"
fi
rm -f /tmp/ub.out /tmp/ub.json /tmp/ub-live.rsc
[ "$fails" = 0 ] && echo "all exception + request tests passed" || { echo "$fails FAILED"; exit 1; }
