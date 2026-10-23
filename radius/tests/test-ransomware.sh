#!/usr/bin/env bash
# Ransomware detective on an installed server: DNS signs through the hourly scan into the database,
# risk per device, automatic cut-off at risk 70+ (when on), dashboard API.
#   sudo bash tests/test-ransomware.sh
#   URL=https://127.0.0.1:8443 USER=admin PASS=... sudo -E bash tests/test-ransomware.sh    (+ dashboard API)
#   KEEP=1 ...   leave the sample data (for screenshots)
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
DNSLOG=/var/log/mikrotik/dns.log PC=10.97.0.21 PC2=10.97.0.22 PC3=10.97.0.23
was_auto=$(db "SELECT v FROM ml_setting WHERE k='ransomware_quarantine_auto'")
cleanup() {
    [ -n "${KEEP:-}" ] && return
    for d in $PC $PC2 $PC3; do sed -i "/ $d\/5000 /d" "$DNSLOG"; done
    db "DELETE FROM ml_security_event WHERE src_ip IN ('$PC','$PC2','$PC3'); DELETE FROM ml_quarantine WHERE ip IN ('$PC','$PC2','$PC3');
        REPLACE INTO ml_setting (k, v) VALUES ('ransomware_quarantine_auto', '${was_auto:-0}')"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
cleanup
n=700
look() { n=$((n+1)); local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%S+00:00)
    printf '%s 127.0.0.1 dnsmasq[1]: %s %s/5000 query[A] %s from %s\n%s 127.0.0.1 dnsmasq[1]: %s %s/5000 reply %s is 203.0.113.250\n' \
        "$ts" "$n" "$1" "$2" "$1" "$ts" "$n" "$1" "$2" >> "$DNSLOG"; }
# PC: ransom-note gateway + rclone; PC2: only an upload site; PC3: nothing ransomware-like
look $PC lockbitsupp3xyz.onion.ly; look $PC downloads.rclone.org; look $PC2 gofile.io; look $PC3 www.wikipedia.org
radius-admin security scan >/dev/null 2>&1
t "scan: ransom-note site saved as category ransomware, high" "$(db "SELECT CONCAT(category,'/',severity) FROM ml_security_event WHERE src_ip='$PC' AND type LIKE 'Ransom note%'")" "ransomware/high"
t "scan: rclone (medium) and upload site (low) saved" "$(db "SELECT GROUP_CONCAT(severity ORDER BY severity) FROM ml_security_event WHERE src_ip IN ('$PC','$PC2') AND category='ransomware' AND type NOT LIKE 'Ransom note%'")" "low,medium"
t "scan: nothing for a normal site" "$(db "SELECT COUNT(*) FROM ml_security_event WHERE src_ip='$PC3'")" "0"
# the flow signs (written by the traffic collector every minute) for the same PC: it spreads on SMB
db "INSERT INTO ml_security_event (day, category, type, severity, source, src_ip, detail, hits, first_seen, last_seen)
    VALUES (CURDATE(), 'ransomware', 'Spreading inside the LAN (SMB)', 'high', 'flow', '$PC', '12 LAN devices on port 445 in 60s', 12, NOW(), NOW())"
out=$(radius-admin security ransomware)
t "risk list: the PC first, 70+, ACT NOW level high, its stages" "$(awk -v ip=$PC '$1==ip {print $3>=70, $4, $5}' <<<"$out")" "1 high contact,spread,steal"
t "  ... the upload-site device low" "$(awk -v ip=$PC2 '$1==ip {print $4}' <<<"$out")" "low"
radius-admin security ransomware-auto off >/dev/null; radius-admin enforce >/dev/null 2>&1
t "auto cut-off off: nobody quarantined" "$(db "SELECT COUNT(*) FROM ml_quarantine WHERE ip='$PC' AND released_at IS NULL")" "0"
radius-admin security ransomware-auto on >/dev/null; radius-admin enforce >/dev/null 2>&1
t "auto cut-off on: the 70+ PC quarantined with the reason" "$(db "SELECT CONCAT(auto, ' ', reason LIKE 'auto: ransomware risk%') FROM ml_quarantine WHERE ip='$PC' AND released_at IS NULL")" "1 1"
t "  ... the low device is not" "$(db "SELECT COUNT(*) FROM ml_quarantine WHERE ip='$PC2'")" "0"
t "  ... and the routers get it (ml-quarantine list in sync.rsc)" "$(grep -c "list=ml-quarantine address=$PC comment=\"mlsync: quarantine" /var/lib/mikrotiklover/router/sync.rsc)" "1"
radius-admin security release $PC >/dev/null; radius-admin enforce >/dev/null 2>&1
t "released by the admin: not cut off again the same day" "$(db "SELECT COUNT(*) FROM ml_quarantine WHERE ip='$PC' AND released_at IS NULL")" "0"

if [ -n "${URL:-}" ]; then
    jar=$(mktemp)
    csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" "$URL/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin)["csrf"])')
    api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -o /tmp/rw.json -w '%{http_code}' -X "$1" "$URL$2" ${3:+-d "$3"}; }
    js() { python3 -c "import json; d=json.load(open('/tmp/rw.json')); print($1)"; }
    t "API: ransomware tab with risk per device" "$(api GET '/api/security?days=1&category=ransomware')$(js "[(r['level'], r['stages']) for r in d['risk'] if r['ip']=='$PC']")" "200[('high', ['contact', 'spread', 'steal'])]"
    t "API: only ransomware events in the tab" "$(js "sorted({e['category'] for e in d['events']})")" "['ransomware']"
    t "API: auto cut-off switch" "$(api POST /api/security/ransomware-auto '{"on":false}')$(db "SELECT v FROM ml_setting WHERE k='ransomware_quarantine_auto'")" "2000"
    t "API: cut off from the tab (quarantine)" "$(api POST /api/security/quarantine "{\"target\":\"$PC\",\"reason\":\"ransomware risk 99\"}")$(db "SELECT COUNT(*) FROM ml_quarantine WHERE ip='$PC' AND released_at IS NULL")" "2001"
    t "API: the device shows as cut off" "$(api GET '/api/security?days=1&category=ransomware')$(js "[r['quarantined'] for r in d['risk'] if r['ip']=='$PC']")" "200[True]"
    t "API: bad category 400" "$(api GET '/api/security?category=ransom')" "400"
    rm -f "$jar" /tmp/rw.json
fi
[ "$fails" = 0 ] && echo "all ransomware tests passed" || { echo "$fails FAILED"; exit 1; }
