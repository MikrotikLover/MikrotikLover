#!/usr/bin/env bash
# Allowed websites / apps, automatically: allow-web (server reads the site, learns from the DNS log) and allow-app.
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-webscan.sh
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
WS=/var/lib/mikrotiklover/webscan S=/var/lib/mikrotiklover/router/webfilter-policies.rsc DNSLOG=/var/log/mikrotik/dns.log DEV=10.99.0.55
SITE=example-test.com WWW=/tmp/ml-webscan-site PORT=18081
cleanup() {
    radius-admin user del ws-user >/dev/null 2>&1
    rm -f /var/lib/mikrotiklover/policies/ws-test.txt /var/lib/mikrotiklover/policies/ws-app.txt "$WS/$SITE".* "$WS/new-site-test.com".* "$WS/shop.example-test.com".*
    sed -i "/ from $DEV\$/d" "$DNSLOG" 2>/dev/null; sed -i '/shop.example-test.com/d' /etc/hosts
    db "DELETE FROM radacct WHERE acctuniqueid='wst-1'"
    [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
    rm -rf "$WWW"; radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
mkdir -p "$WWW/products"
cat > "$WWW/index.html" <<'H'
<html><head><link rel="stylesheet" href="/s.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=A">
<script src="https://www.googletagmanager.com/gtag/js"></script><script src="https://cdn.jsdelivr.net/npm/x.js"></script></head>
<body><img src="https://scontent-sin6-1.cdninstagram.com/a.jpg"><iframe src="https://www.youtube.com/embed/x"></iframe>
<a href="/products/">p</a><a href="https://www.instagram.com/shop">ig</a></body></html>
H
echo 'body{src:url(https://fonts.gstatic.com/a.woff2)}' > "$WWW/s.css"
echo '<img src="https://images.unsplash.com/1.jpg">' > "$WWW/products/index.html"
echo "127.0.0.1 shop.example-test.com" >> /etc/hosts
python3 -m http.server $PORT --bind 127.0.0.1 --directory "$WWW" >/dev/null 2>&1 & SRV=$!
sleep 1
# 1. reading the site (a LAN test site: --allow-private; radius-admin refuses non-public addresses)
python3 -I /usr/local/lib/mikrotiklover/webscan.py scan $SITE --url http://shop.example-test.com:$PORT/ --allow-private --dir $WS >/dev/null
TXT=$(tr '\n' ' ' < $WS/$SITE.txt)
t "scan: fonts, CSS font files, JS library, image CDN, other pages' images" "$TXT" "cdn.jsdelivr.net cdninstagram.com fonts.googleapis.com fonts.gstatic.com unsplash.com "
t "scan: trackers left out" "$(python3 -c "import json; d=json.load(open('$WS/$SITE.json')); print(list(d['skipped']))")" "['googletagmanager.com']"
t "scan: embedded video only asked" "$(python3 -c "import json; d=json.load(open('$WS/$SITE.json')); print(list(d['suggest']))")" "['youtube.com']"
t "scan: links to other sites are not opened" "$(grep -cx 'instagram.com' $WS/$SITE.txt)" "0"
t "radius-admin refuses a site on a LAN address" "$(radius-admin webscan scan shop.example-test.com 2>&1 | grep -c 'not a public address')" "1"
# 2. policy: only the site, the rest blocked
radius-admin user add ws-user -p Pass1234 >/dev/null
printf '# test\nblock-all\nallow-web www.%s\n' $SITE | radius-admin policy set ws-test >/dev/null
radius-admin user policy ws-user ws-test >/dev/null
for n in $SITE fonts.gstatic.com cdninstagram.com unsplash.com; do
    t "router: $n opened (name + DNS list)" "$(grep -c "chain=wfp-ws-test protocol=tcp tls-host=\"$n\" action=return" $S)$(grep -c "chain=wfp-ws-test dst-address-list=mlname-$n action=return" $S)" "11"
done
t "router: tracker not opened" "$(grep -c 'wfp-ws-test.*googletagmanager' $S)" "0"
t "sync.rsc passes the RouterOS lint" "$(python3 "$HERE/lint-rsc.py" /var/lib/mikrotiklover/router/sync.rsc | head -1)" "ok   sync.rsc"
t "a new site is read when the policy is saved" "$(printf 'block-all\nallow-web new-site-test.com\n' | radius-admin policy set ws-test 2>&1 >/dev/null | grep -c 'Reading new-site-test.com'; ls $WS/new-site-test.com.txt | wc -l)" "1
1"
printf '# test\nblock-all\nallow-web www.%s\n' $SITE | radius-admin policy set ws-test >/dev/null
# 3. learning while it is used
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctupdatetime) VALUES ('w1','wst-1','ws-user','127.0.0.1','$DEV',NOW(),NOW())"
ts() { date -u -d "$1" +%Y-%m-%dT%H:%M:%S.00+00:00; }
{ echo "$(ts '-30 sec') 127.0.0.1 dnsmasq[1]: query[A] www.$SITE from $DEV"
  echo "$(ts '-28 sec') 127.0.0.1 dnsmasq[1]: query[A] fonts.bunny.net from $DEV"
  echo "$(ts '-27 sec') 127.0.0.1 dnsmasq[1]: query[A] api.reviews-widget.io from $DEV"
  echo "$(ts '-26 sec') 127.0.0.1 dnsmasq[1]: query[A] www.google-analytics.com from $DEV"
  echo "$(ts '-1 sec') 127.0.0.1 dnsmasq[1]: query[A] www.netflix.com from $DEV"; } >> "$DNSLOG"
out=$(radius-admin webscan auto)
J="python3 -c \"import json,sys; d=json.load(open('$WS/$SITE.json'))"
t "learning: a well-known helper is opened by itself" "$(eval "$J; print(d['allowed'].get('fonts.bunny.net', {}).get('from'))\"")" "learned"
t "learning: an unknown name is asked" "$(eval "$J; print(d['suggest'].get('reviews-widget.io', {}).get('count'))\"")" "1"
t "learning: trackers and later names ignored" "$(eval "$J; print('google-analytics.com' in d['suggest'], 'netflix.com' in d['suggest'])\"")" "False False"
t "  ... and the router gets the learned helper" "$(grep -c 'chain=wfp-ws-test protocol=tcp tls-host="fonts.bunny.net" action=return' $S)" "1"
radius-admin webscan allow $SITE reviews-widget.io >/dev/null
t "admin allows a suggestion" "$(grep -c 'tls-host="reviews-widget.io" action=return' $S)$(eval "$J; print(d['allowed']['reviews-widget.io']['from'])\"")" "1admin"
radius-admin webscan ignore $SITE unsplash.com >/dev/null
t "admin removes one: not opened, not found again by the next read" "$(grep -c 'tls-host="unsplash.com"' $S)$(python3 -I /usr/local/lib/mikrotiklover/webscan.py scan $SITE --url http://shop.example-test.com:$PORT/ --allow-private --dir $WS >/dev/null; grep -c unsplash $WS/$SITE.txt)" "00"
# 4. apps by name
printf '# test\nblock-all\nallow-app Instagram\n' | radius-admin policy set ws-app >/dev/null
t "allow-app: the app's domains from the catalog" "$(grep -c 'chain=wfp-ws-app protocol=tcp tls-host="cdninstagram.com" action=return' $S)$(grep -c 'chain=wfp-ws-app protocol=tcp tls-host="instagram.com" action=return' $S)" "11"
t "allow-app: unknown app refused" "$(printf 'block-all\nallow-app NoSuchApp9\n' | radius-admin policy set ws-app 2>&1 | grep -c 'unknown app')" "1"
if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ws.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ws.json')); print($1)"; }
    t "API: sites with what they need" "$(api GET /api/webscan)$(js "[(x['site'], x['policies'], 'fonts.gstatic.com' in x['allowed']) for x in d['sites'] if x['site']=='$SITE']")" "200[('$SITE', ['ws-test'], True)]"
    t "API: answer a suggestion" "$(api POST /api/webscan/$SITE/answer '{"name":"youtube.com","allow":false}')$(eval "$J; print('youtube.com' in d['ignored'])\"")" "200True"
    t "API: bad name 400" "$(api POST /api/webscan/$SITE/answer '{"name":"x;y","allow":true}')" "400"
    t "API finder: what the site needs is open" "$(api GET "/api/why?site=fonts.gstatic.com&user=ws-user")$(js "d['verdict'], 'needs fonts.gstatic.com' in d['summary']")" "200allowed True"
    t "API finder: the rest blocked" "$(api GET "/api/why?site=www.netflix.com&user=ws-user")$(js "d['verdict']")" "200blocked"
    rm -f "$jar" /tmp/ws.json
fi
[ "$fails" = 0 ] && echo "all allowed-website tests passed" || { echo "$fails FAILED"; exit 1; }
