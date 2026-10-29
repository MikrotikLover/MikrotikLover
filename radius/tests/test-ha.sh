#!/usr/bin/env bash
# Second RADIUS server (backup) in a lab on one machine: this server is the first one (its MariaDB restarts with the pair
# settings), a second MariaDB (port 3307) + a second FreeRADIUS (ports 1912/1913) stand in for the backup server.
# The real join file is opened and loaded like 'ha join' does; then: copying both ways (TLS, own GTID domain, own id
# slots), a login and accounting on the backup server, the routers' backup RADIUS entry, health check, ha stop.
#   sudo bash tests/test-ha.sh        (restarts MariaDB twice)
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
# shellcheck disable=SC1091
. /etc/mikrotiklover-radius/radius.conf
W=$(mktemp -d /var/tmp/mlha.XXXX); chmod 755 "$W"
B="mysql -S $W/run/b.sock -uroot -N -B"
was_sip=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")
cleanup() {
    [ -n "${FRB:-}" ] && kill "$FRB" 2>/dev/null
    [ -f "$W/run/b.pid" ] && kill "$(cat "$W/run/b.pid")" 2>/dev/null; sleep 2
    radius-admin ha stop >/dev/null 2>&1
    radius-admin user del ha-user >/dev/null 2>&1
    mysql -e "DROP USER IF EXISTS 'ml_repl'@'127.0.0.1'; DROP USER IF EXISTS 'ml_repl'@'127.0.0.2'" 2>/dev/null
    db "DELETE FROM radacct WHERE acctsessionid LIKE 'ha-%'; REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '${was_sip:-}')"
    rm -f /var/backups/mikrotiklover/ha-join-*.enc; rm -rf "$W"
    radius-admin policy build >/dev/null 2>&1
}
trap cleanup EXIT
db "REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '127.0.0.1')"

# ---- the first server: pair settings, join file
out=$(radius-admin ha start 127.0.0.2 2>&1)
FILE=$(grep -o '/var/backups/mikrotiklover/ha-join-[0-9-]*\.enc' <<<"$out" | head -1); PW=$(grep -o "echo '[A-Za-z0-9]*' | sudo radius-admin ha join" <<<"$out" | cut -d"'" -f2)
t "ha start: join file + password, steps" "$([ -s "$FILE" ] && echo file) $([ ${#PW} -ge 20 ] && echo pw) $(stat -c %a "$FILE")" "file pw 600"
t "  ... MariaDB: server 1, own GTID domain, odd ids, binary log, TLS" "$(mysql -N -e "SELECT @@server_id, @@gtid_domain_id, @@auto_increment_increment, @@auto_increment_offset, @@log_bin, @@have_ssl" | tr '\t' ' ')" "1 1 2 1 1 YES"
mkdir -p "$W/j"; t "join file: wrong password refused" "$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:wrong -in "$FILE" 2>/dev/null | tar -tzf - >/dev/null 2>&1 && echo opened || echo refused)" "refused"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "pass:$PW" -in "$FILE" | tar -C "$W/j" -xzf -
t "  ... holds the database, certificates (same for phones), RADIUS + router secrets" \
  "$(ls "$W/j/dump.sql" "$W/j/certs/server.pem" "$W/j/certs/ca.key" "$W/j/conf/secret" "$W/j/conf/key" 2>/dev/null | wc -l) $(grep -c '^-- ML-GTID-POS: ' "$W/j/dump.sql")" "5 1"
RP=$(python3 -c "import json; print(json.load(open('$W/j/info.json'))['repl_pass'])"); POS=$(python3 -c "import json; print(json.load(open('$W/j/info.json'))['pos'])")
t "  ... replication login only for the backup's address, TLS required" "$(mysql -N -e "SELECT CONCAT(host, ' ', ssl_type) FROM mysql.user WHERE user='ml_repl'")" "127.0.0.2 ANY"
# in this lab the backup's packets come from 127.0.0.1: the same login for that address
mysql -e "CREATE USER 'ml_repl'@'127.0.0.1' IDENTIFIED BY '$RP' REQUIRE SSL; GRANT REPLICATION SLAVE ON *.* TO 'ml_repl'@'127.0.0.1'"

# ---- the backup server: second MariaDB with the pair settings for server 2, the join's steps
mkdir -p "$W/ssl" "$W/data" "$W/run"; cp /etc/mysql/ml-ssl/* "$W/ssl/"; chown -R mysql:mysql "$W/ssl" "$W/data" "$W/run"
mariadb-install-db --user=mysql --datadir="$W/data" --auth-root-authentication-method=socket >/dev/null 2>&1
{ python3 -I /usr/local/lib/mikrotiklover/ha.py mycnf 2 "$W/ssl"; printf 'port = 3307\nsocket = %s/run/b.sock\ndatadir = %s/data\npid_file = %s/run/b.pid\nlog_bin = %s/data/mariadb-bin\nuser = mysql\n' "$W" "$W" "$W" "$W"; } > "$W/b.cnf"
mariadbd --defaults-file="$W/b.cnf" >"$W/b.log" 2>&1 &
for i in $(seq 1 30); do $B -e "SELECT 1" >/dev/null 2>&1 && break; sleep 1; done
# (what install.sh made on the backup before the pair: not in its binary log)
$B -e "SET SESSION sql_log_bin = 0; CREATE DATABASE radius CHARACTER SET utf8mb4; CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS'; CREATE USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
       GRANT ALL ON radius.* TO '$DB_USER'@'localhost'; GRANT ALL ON radius.* TO '$DB_USER'@'127.0.0.1'"
$B radius < "$W/j/dump.sql"
t "backup: database loaded (users, routers, settings)" "$($B radius -e "SELECT COUNT(*) > 0 FROM radcheck") $($B radius -e "SELECT COUNT(*) FROM nas")" "1 $(db "SELECT COUNT(*) FROM nas")"
t "  ... the load was not written to its binary log (not copied back)" "$($B -e "SELECT @@gtid_binlog_pos")" ""
printf '%s\n' "$RP" | python3 -I /usr/local/lib/mikrotiklover/ha.py link 127.0.0.1 3306 "$W/ssl/ca.pem" "$POS" --socket $W/run/b.sock
st() { python3 -I /usr/local/lib/mikrotiklover/ha.py status --json --socket $W/run/b.sock; }
for i in $(seq 1 20); do [ "$(st | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("io"), d.get("sql"))' 2>/dev/null)" = "Yes Yes" ] && break; sleep 1; done
t "backup copies from the first server over TLS" "$(st | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["peer"], d["io"], d["sql"])')" "127.0.0.1 Yes Yes"
RP2=$(openssl rand -hex 16)
$B -e "SET SESSION sql_log_bin = 0; CREATE USER 'ml_repl'@'127.0.0.1' IDENTIFIED BY '$RP2' REQUIRE SSL; GRANT REPLICATION SLAVE ON *.* TO 'ml_repl'@'127.0.0.1'"
BPOS=$($B -e "SELECT @@gtid_binlog_pos")
t "first server copies back (ha link)" "$(printf '%s\n' "$RP2" | HA_PORT=3307 radius-admin ha link 127.0.0.2 "$BPOS" 2>&1 | grep -c 'both servers copy each other')" "1"
sleep 3
t "  ... running" "$(python3 -I /usr/local/lib/mikrotiklover/ha.py status --json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["io"], d["sql"])')" "Yes Yes"

# ---- both ways
radius-admin user add ha-user -p 'Ha-Pass-123' >/dev/null
sleep 2
t "a user made on the first server is on the backup" "$($B radius -e "SELECT COUNT(*) FROM radcheck WHERE username='ha-user'")" "1"
$B radius -e "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime) VALUES ('ha-b1', 'ha-b1', 'ha-user', '127.0.0.1', NOW())"
db "INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, acctstarttime) VALUES ('ha-a1', 'ha-a1', 'ha-user', '127.0.0.1', NOW())"
sleep 3
t "accounting written on the backup reaches the first server, and back" "$(db "SELECT COUNT(*) FROM radacct WHERE acctsessionid IN ('ha-a1','ha-b1')") $($B radius -e "SELECT COUNT(*) FROM radacct WHERE acctsessionid IN ('ha-a1','ha-b1')")" "2 2"
t "  ... no id clash: odd ids on the first server, even on the backup" "$(db "SELECT radacctid % 2 FROM radacct WHERE acctsessionid='ha-a1'") $(db "SELECT radacctid % 2 FROM radacct WHERE acctsessionid='ha-b1'")" "1 0"

# ---- a second FreeRADIUS on the backup database: logins work there
cp -a /etc/freeradius/3.0 "$W/fr"; mkdir -p "$W/fr-run" "$W/fr-log"; chown -R freerad:freerad "$W/fr-run" "$W/fr-log"
sed -i "s|^\(\s*\)server = .*|\1server = \"127.0.0.1\"|; s|^\(\s*\)port = 3306|\1port = 3307|" "$W/fr/mods-available/sql"
awk 'BEGIN{n=0} /^\s*port = 0/ {n++; sub(/port = 0/, n==1 ? "port = 1912" : "port = 1913")} {print}' "$W/fr/sites-available/default" > "$W/x" && cat "$W/x" > "$W/fr/sites-available/default"
sed -i "s|port = 18120|port = 18121|" "$W/fr/sites-available/inner-tunnel"
sed -i "s|^run_dir = .*|run_dir = $W/fr-run|; s|^logdir = .*|logdir = $W/fr-log|" "$W/fr/radiusd.conf"
freeradius -d "$W/fr" -f >"$W/fr.log" 2>&1 & FRB=$!
sleep 4
login() { printf 'User-Name = "%s"\nUser-Password = "%s"\nNAS-IP-Address = 127.0.0.1\n' "$1" "$2" | radclient -x -r 1 -t 3 127.0.0.1:$3 auth "$LOCAL_SECRET" 2>&1 | grep -c '^Received Access-Accept'; }
t "the backup server logs the user in (data copied from the first)" "$(login ha-user 'Ha-Pass-123' 1912)" "1"
t "  ... a wrong password still refused" "$(login ha-user 'wrong' 1912)" "0"
printf 'Acct-Status-Type = Start\nAcct-Session-Id = "ha-b2"\nUser-Name = "ha-user"\nNAS-IP-Address = 127.0.0.1\nFramed-IP-Address = 10.77.0.9\n' | radclient -r 1 -t 3 127.0.0.1:1913 acct "$LOCAL_SECRET" >/dev/null 2>&1
sleep 3
t "accounting sent to the backup server shows on the first (quota, online list)" "$(db "SELECT COUNT(*) FROM radacct WHERE acctsessionid='ha-b2' AND framedipaddress='10.77.0.9'")" "1"

# ---- routers: the backup RADIUS entry with each router's own secret
db "REPLACE INTO ml_setting (k, v) VALUES ('ha_servers', '127.0.0.1,127.0.0.2')"; radius-admin policy build >/dev/null
K=$(cat /var/lib/mikrotiklover/router/key); SEC=$(db "SELECT secret FROM nas WHERE nasname='127.0.0.1'")
sync=$(curl -sk "https://127.0.0.1:${WEB_PORT:-8443}/api/public/router/sync.rsc?key=$K")
t "router: backup RADIUS entry with its own secret, the same services, old ones cleaned" \
  "$(grep -c "add address=\$a secret=\"$SEC\" service=\$svc timeout=3s comment=\"MikrotikLover RADIUS backup\"" <<<"$sync") $(grep -c ':local keep {"127.0.0.1";"127.0.0.2"}' <<<"$sync")" "1 1"
echo "$sync" > "$W/sync.rsc"
t "  ... RouterOS lint ok, RouterOS 6 too" "$(python3 "$HERE/lint-rsc.py" "$W/sync.rsc" | grep -c '^ok') $(curl -sk "https://127.0.0.1:${WEB_PORT:-8443}/api/public/router/sync.rsc?key=$K&v=6" > "$W/s6.rsc"; python3 /usr/local/lib/mikrotiklover/rosv6.py check "$W/s6.rsc" | grep -c '^ok')" "1 1"
t "  ... the version changes when the pair changes (routers fetch again)" "$(grep -c '# RADIUS servers in the pair (radius-admin ha): 127.0.0.1,127.0.0.2' /var/lib/mikrotiklover/router/sync.rsc)" "1"
t "health check: copy from the backup is up to date" "$(radius-admin doctor 2>&1 | grep -c 'Copy from 127.0.0.2: up to date')" "1"
t "status" "$(radius-admin ha status | grep -c 'receiving Yes, applying Yes')" "1"

# ---- end the pair
radius-admin ha stop >/dev/null 2>&1
t "ha stop: no copying, normal MariaDB settings, routers take the backup entry away" \
  "$(python3 -I /usr/local/lib/mikrotiklover/ha.py status) $(mysql -N -e 'SELECT @@server_id') $(grep -c 'remove \[find comment="MikrotikLover RADIUS backup"\]' /var/lib/mikrotiklover/router/sync.rsc)" "not copying from a peer 1 1"
[ "$fails" = 0 ] && echo "all backup server tests passed" || { echo "$fails FAILED"; exit 1; }
