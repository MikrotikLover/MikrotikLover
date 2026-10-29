#!/usr/bin/env bash
# Dashboard app (PWA) + notifications on an installed server: manifest / service worker / icons, a device turns
# notifications on (dashboard API), test message and alerts reach it encrypted and signed (a fake push service checks
# both like FCM / Mozilla / Apple), unsubscribed devices are removed, other addresses are refused.
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-push.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
: "${URL:?URL, USER, PASS of a dashboard admin}"
W=$(mktemp -d) PORT=9917
was_push=$(grep -s '^PUSH=' /etc/mikrotiklover-radius/alerts.conf | cut -d= -f2)
cleanup() {
    [ -n "${FP:-}" ] && kill "$FP" 2>/dev/null
    db "DELETE FROM ml_push_sub WHERE endpoint LIKE 'http://127.0.0.1:$PORT/%'; DELETE FROM ml_setting WHERE k='push_allow_hosts'"
    printf 'PUSH=%s\n' "${was_push:-}" | python3 -I /usr/local/lib/mikrotiklover/alerts.py set >/dev/null 2>&1
    rm -rf "$W"
}
trap cleanup EXIT
# a phone: its own key pair and auth secret, like the browser makes them
python3 - "$W" <<'PY'
import os, sys, json, base64
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
d = sys.argv[1]; k = ec.generate_private_key(ec.SECP256R1())
open(f"{d}/dev.pem", "wb").write(k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=").decode()
pub = k.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
auth = b(os.urandom(16)); open(f"{d}/auth", "w").write(auth)
for name in ("sub1", "gone/sub2"):
    json.dump({"subscription": {"endpoint": f"http://127.0.0.1:9917/{name}", "keys": {"p256dh": b(pub), "auth": auth}}}, open(f"{d}/{name.replace('/', '-')}.json", "w"))
PY
python3 "$HERE/fakepush.py" $PORT "$W/dev.pem" "$(cat "$W/auth")" "$W/got" & FP=$!
sleep 1
db "REPLACE INTO ml_setting (k, v) VALUES ('push_allow_hosts', '127.0.0.1:$PORT')"

t "manifest: app name, standalone, icons" "$(curl -sk "$URL/manifest.webmanifest" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["display"], len(d["icons"]))')" "standalone 3"
t "  ... served as application/manifest+json" "$(curl -sk -o /dev/null -w '%{content_type}' "$URL/manifest.webmanifest")" "application/manifest+json"
t "service worker at the root (whole dashboard), not cached" "$(curl -sk -D - -o /dev/null "$URL/sw.js" | grep -ci '^service-worker-allowed: /\|^cache-control: no-cache')" "2"
t "icons there" "$(for i in icon-192 icon-512 maskable-512 apple-touch-icon badge-96; do curl -sk -o /dev/null -w '%{http_code}' "$URL/static/icons/$i.png"; done)" "200200200200200"
t "dashboard page links the app manifest" "$(curl -sk "$URL/" | grep -c 'rel="manifest"')" "1"

jar=$(mktemp)
csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o "$W/a.json" -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
t "server key for the browsers (VAPID, P-256)" "$(api GET /api/push)$(python3 -c "import json,base64; k=json.load(open('$W/a.json'))['key']; print(len(base64.urlsafe_b64decode(k+'==')))")" "20065"
t "private key only for root" "$(stat -c %a /etc/mikrotiklover-radius/vapid.pem)" "600"
t "a device turns notifications on" "$(api POST /api/push/subscribe "$(cat "$W/sub1.json")")$(api GET /api/push)$(python3 -c "import json; d=json.load(open('$W/a.json')); print(len(d['devices']), d['devices'][0]['admin'])")" "2002001 $USER"
t "  ... the alerts get a 'push' channel" "$(grep -c '^PUSH=1' /etc/mikrotiklover-radius/alerts.conf)" "1"
t "test message: reached the device" "$(api POST /api/push/test '{}')" "200"
sleep 0.5
t "  ... signed (VAPID checked like FCM / Apple), encrypted for the device, title + where to open" \
  "$(tail -1 "$W/got" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["vapid"], d["msg"]["title"], d["msg"]["url"], d["ttl"])')" "True ✅ Test /#/settings 86400"
radius-admin alerts test push >/dev/null 2>&1
t "an alert through the alerts system reaches it too" "$(tail -1 "$W/got" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print(d["vapid"], d["msg"]["title"], d["msg"]["url"])')" "True ✅ Test alert /#/health"
t "an address that is no browser push service: refused" "$(api POST /api/push/subscribe '{"subscription":{"endpoint":"https://evil.example/x","keys":{"p256dh":"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4","auth":"BTBZMqHH6r4Tts7J_aSIgg"}}}')$(api POST /api/push/subscribe '{"subscription":"x"}')" "400400"
api POST /api/push/subscribe "$(cat "$W/gone-sub2.json")" >/dev/null
radius-admin push test >/dev/null 2>&1
t "a device that turned notifications off (410): removed by itself" "$(db "SELECT COUNT(*) FROM ml_push_sub WHERE endpoint LIKE '%/gone/%'") $(db "SELECT COUNT(*) FROM ml_push_sub WHERE endpoint LIKE 'http://127.0.0.1:$PORT/sub1'")" "0 1"
id=$(db "SELECT id FROM ml_push_sub WHERE endpoint LIKE 'http://127.0.0.1:$PORT/sub1'")
t "remove a device: the 'push' channel goes off with the last one" "$(api POST /api/push/del "{\"id\":$id}")$(db "SELECT COUNT(*) FROM ml_push_sub") $(grep -c '^PUSH=0' /etc/mikrotiklover-radius/alerts.conf)" "2000 1"
rm -f "$jar"
[ "$fails" = 0 ] && echo "all push notification tests passed" || { echo "$fails FAILED"; exit 1; }
