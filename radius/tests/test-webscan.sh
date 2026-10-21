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
DEEP=deepshop-test.com DWWW=/tmp/ml-webscan-deep DPORT=18083 DEV2=10.99.0.56 DEV3=10.99.0.57
cleanup() {
    pkill -f "webscan[.]py scan ($DEEP|new-site-test.com)" 2>/dev/null; sleep 0.3
    for u in ws-user ws-user2 ws-user3; do radius-admin user del $u >/dev/null 2>&1; done
    rm -f /var/lib/mikrotiklover/policies/ws-test.txt /var/lib/mikrotiklover/policies/ws-app.txt /var/lib/mikrotiklover/policies/ws-ao.txt /var/lib/mikrotiklover/policies/ws-deep.txt \
        "$WS/$SITE".* "$WS/new-site-test.com".* "$WS/shop.example-test.com".* "$WS/$DEEP".* "$WS/app-instagram".* "$WS/ao-whatsapp".* "$WS/ao-hikconnect".*
    for d in $DEV $DEV2 $DEV3; do sed -i "/ from $d\$/d" "$DNSLOG" 2>/dev/null; done; sed -i '/shop.example-test.com\|www.deepshop-test.com/d' /etc/hosts
    db "DELETE FROM radacct WHERE acctuniqueid IN ('wst-1','wst-2','wst-3')"
    [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; [ -n "${SRV2:-}" ] && kill "$SRV2" 2>/dev/null
    rm -rf "$WWW" "$DWWW"; radius-admin policy build >/dev/null 2>&1
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
# 5. deep reading: sitemap (index -> 40 pages), JS files, in the background; the routers get it after
mkdir -p "$DWWW/p" "$DWWW/js"
printf 'User-agent: *\nSitemap: http://www.%s:%s/sm-index.xml\n' $DEEP $DPORT > "$DWWW/robots.txt"
echo "<sitemapindex><sitemap><loc>http://www.$DEEP:$DPORT/sm1.xml</loc></sitemap></sitemapindex>" > "$DWWW/sm-index.xml"
{ echo '<urlset>'; for i in $(seq 1 40); do echo "<url><loc>http://www.$DEEP:$DPORT/p/$i.html</loc></url>"; done; echo '</urlset>'; } > "$DWWW/sm1.xml"
echo '<html><head><script src="/js/app.js"></script></head><body>home</body></html>' > "$DWWW/index.html"
for i in $(seq 1 40); do echo "<html><body><p>page $i</p></body></html>" > "$DWWW/p/$i.html"; done
echo '<html><body><img src="https://img.deep-cdn-test.net/x.jpg"></body></html>' > "$DWWW/p/37.html"
echo 'var a="https://static.shopfiles-test.com/v1/";var b="https://api.reviews-thing.io/x";var c="https://www.w3.org/2000/svg";var t="https://www.google-analytics.com/a.js";' > "$DWWW/js/app.js"
echo "127.0.0.1 www.$DEEP" >> /etc/hosts
python3 -m http.server $DPORT --bind 127.0.0.1 --directory "$DWWW" >/dev/null 2>&1 & SRV2=$!
sleep 1
python3 -I /usr/local/lib/mikrotiklover/webscan.py scan $DEEP --url http://www.$DEEP:$DPORT/ --allow-private --dir $WS >/dev/null
t "quick read: only the home page (no links)" "$(python3 -c "import json; d=json.load(open('$WS/$DEEP.json')); print(d['pages_read'], d['deep'], list(d['allowed']))")" "1 False []"
printf 'block-all\nallow-web %s\n' $DEEP | radius-admin policy set ws-deep >/dev/null
out=$(python3 -I /usr/local/lib/mikrotiklover/webscan.py scan $DEEP --url http://www.$DEEP:$DPORT/ --allow-private --deep --background --rebuild --dir $WS)
t "whole site: started in the background" "$(grep -c 'in the background' <<<"$out")" "1"
t "  ... a second start is refused while it reads" "$(python3 -I /usr/local/lib/mikrotiklover/webscan.py scan $DEEP --deep --background --dir $WS | grep -c 'already being read')" "1"
for i in $(seq 1 60); do python3 -c "import json,sys; sys.exit(0 if json.load(open('$WS/$DEEP.json')).get('scanning') else 1)" || break; sleep 1; done
DJ="python3 -c \"import json,sys; d=json.load(open('$WS/$DEEP.json'))"
t "whole site: sitemap index followed, every page read" "$(eval "$DJ; print(d['pages_read'], d['deep'], 'scanning' in d)\"")" "41 True False"
t "  ... an image on page 37 found" "$(eval "$DJ; print(d['allowed'].get('deep-cdn-test.net', {}).get('why'))\"")" "image"
t "  ... a file host named only in the JS opened" "$(eval "$DJ; print(d['allowed'].get('shopfiles-test.com', {}).get('why'))\"")" "in JS: file host"
t "  ... an API named in the JS only asked; trackers / w3.org left out" "$(eval "$DJ; print(list(d['suggest']), 'w3.org' in d['allowed'], 'google-analytics.com' in d['allowed'])\"")" "['reviews-thing.io'] False False"
for i in $(seq 1 20); do grep -q 'tls-host="deep-cdn-test.net"' $S && break; sleep 1; done
t "  ... the routers got it by themselves (policy rebuilt after the read)" "$(grep -c 'chain=wfp-ws-deep protocol=tcp tls-host="shopfiles-test.com" action=return' $S)" "1"
t "list shows pages read" "$(radius-admin webscan list | grep $DEEP | grep -c '41 pages (whole site)')" "1"
# 6. apps learn while used: helpers by themselves, other names asked
radius-admin user add ws-user2 -p Pass1234 >/dev/null; radius-admin user policy ws-user2 ws-app >/dev/null
printf '# test\nallow-only whatsapp\nallow-only hikconnect\n' | radius-admin policy set ws-ao >/dev/null
radius-admin user add ws-user3 -p Pass1234 >/dev/null; radius-admin user policy ws-user3 ws-ao >/dev/null
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, acctstarttime, acctupdatetime) VALUES
    ('w2','wst-2','ws-user2','127.0.0.1','$DEV2',NOW(),NOW()), ('w3','wst-3','ws-user3','127.0.0.1','$DEV3',NOW(),NOW())"
{ echo "$(ts '-40 sec') 127.0.0.1 dnsmasq[1]: query[A] www.instagram.com from $DEV2"
  echo "$(ts '-39 sec') 127.0.0.1 dnsmasq[1]: query[A] cdnjs.cloudflare.com from $DEV2"
  echo "$(ts '-38 sec') 127.0.0.1 dnsmasq[1]: query[A] edge-chat.facebook.com from $DEV2"
  echo "$(ts '-40 sec') 127.0.0.1 dnsmasq[1]: query[A] g.whatsapp.net from $DEV3"
  echo "$(ts '-39 sec') 127.0.0.1 dnsmasq[1]: query[A] e7.whatsapp.net from $DEV3"
  echo "$(ts '-38 sec') 127.0.0.1 dnsmasq[1]: query[A] www.facebook.com from $DEV3"
  echo "$(ts '-30 sec') 127.0.0.1 dnsmasq[1]: query[A] i-api.hik-connect.com from $DEV3"
  echo "$(ts '-29 sec') 127.0.0.1 dnsmasq[1]: query[A] devlogs.ezvizlife.com from $DEV3"; } >> "$DNSLOG"
radius-admin webscan auto >/dev/null
AJ="python3 -c \"import json,sys; a=json.load(open('$WS/app-instagram.json')); w=json.load(open('$WS/ao-whatsapp.json')); k=json.load(open('$WS/ao-hikconnect.json'))"
t "app: a helper asked right after it is opened" "$(eval "$AJ; print(a['allowed'].get('cdnjs.cloudflare.com', {}).get('from'))\"")" "learned"
t "app: a Facebook name only asked (that exact name), never opened by itself" "$(eval "$AJ; print([n for n in a['allowed'] if 'facebook' in n], a['suggest'].get('edge-chat.facebook.com', {}).get('count'))\"")" "[] 1"
t "profile: another *.whatsapp.net opened by itself (same company)" "$(eval "$AJ; print(w['allowed'].get('whatsapp.net', {}).get('from'))\"")" "learned"
t "profile: denied names (deny-sni facebook) not opened" "$(eval "$AJ; print('facebook.com' in w['allowed'])\"")" "False"
t "profile: an unknown name after Hik-Connect asked" "$(eval "$AJ; print(k['suggest'].get('ezvizlife.com', {}).get('count'))\"")" "1"
t "  ... learned app name reaches the router" "$(grep -c 'chain=wfp-ws-app protocol=tcp tls-host="cdnjs.cloudflare.com" action=return' $S)" "1"
t "  ... learned profile name reaches the router (DNS list)" "$(grep -c 'name=whatsapp.net match-subdomain=yes type=FWD.*address-list=mlname-whatsapp.net' $S)$(grep -c 'chain=ao-whatsapp dst-address-list=mlname-whatsapp.net action=accept' $S)" "11"
radius-admin webscan allow ao-hikconnect ezvizlife.com >/dev/null
t "admin allows a profile suggestion" "$(grep -c 'chain=ao-hikconnect dst-address-list=mlname-ezvizlife.com action=accept' $S)" "1"
t "bad key refused" "$(radius-admin webscan allow 'ao-x;y' a.com 2>&1 | grep -c usage)" "1"
if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/ws.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/ws.json')); print($1)"; }
    t "API: sites with what they need" "$(api GET /api/webscan)$(js "[(x['site'], x['policies'], 'fonts.gstatic.com' in x['allowed']) for x in d['sites'] if x['site']=='$SITE']")" "200[('$SITE', ['ws-test'], True)]"
    t "API: answer a suggestion" "$(api POST /api/webscan/$SITE/answer '{"name":"youtube.com","allow":false}')$(eval "$J; print('youtube.com' in d['ignored'])\"")" "200True"
    t "API: bad name 400" "$(api POST /api/webscan/$SITE/answer '{"name":"x;y","allow":true}')" "400"
    t "API: apps and profiles listed with their kind" "$(api GET /api/webscan)$(js "sorted((x['site'], x['kind']) for x in d['sites'] if x['site'] in ('app-instagram','ao-whatsapp','$DEEP'))")" "200[('ao-whatsapp', 'ao'), ('app-instagram', 'app'), ('$DEEP', 'site')]"
    t "API: answer for an app" "$(api POST /api/webscan/app-instagram/answer '{"name":"edge-chat.facebook.com","allow":false}')$(eval "$AJ; print('edge-chat.facebook.com' in a['ignored'])\"")" "200True"
    t "API: bad key 400" "$(api POST '/api/webscan/app-x%3By/answer' '{"name":"a.com","allow":true}')" "400"
    t "API: whole-site read starts in the background" "$(api POST /api/webscan/$DEEP/scan '{"deep":true}')$(js "d.get('message','')" | grep -c 'background')" "2001"
    t "API finder: learned app name is open" "$(api GET "/api/why?site=cdnjs.cloudflare.com&user=ws-user2")$(js "d['verdict']")" "200allowed"
    t "API finder: learned profile name is open" "$(api GET "/api/why?site=e9.whatsapp.net&user=ws-user3")$(js "d['verdict']")" "200allowed"
    t "API finder: what the site needs is open" "$(api GET "/api/why?site=fonts.gstatic.com&user=ws-user")$(js "d['verdict'], 'needs fonts.gstatic.com' in d['summary']")" "200allowed True"
    t "API finder: the rest blocked" "$(api GET "/api/why?site=www.netflix.com&user=ws-user")$(js "d['verdict']")" "200blocked"
    rm -f "$jar" /tmp/ws.json
fi
[ "$fails" = 0 ] && echo "all allowed-website tests passed" || { echo "$fails FAILED"; exit 1; }
