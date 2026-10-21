#!/usr/bin/env bash
# MikrotikLover RADIUS server installer
# FreeRADIUS 3.2 + MariaDB for MikroTik wireless (WPA2/WPA3-Enterprise) and hotspot users.
#
# Tested on Ubuntu 24.04 / 22.04 and Debian 12. Safe to re-run (idempotent).
#
#   sudo RADIUS_DOMAIN=radius.example.com ./install.sh
#
# Optional environment variables:
#   RADIUS_DOMAIN   name in the server certificate (default: radius.local)
#   CERT_ORG        organisation in the certificates (default: MikrotikLover)
#   RENEW_CERT=1    issue a new server certificate (same CA, clients keep working)
#   RENEW_CA=1      new CA + server certificate (clients must re-trust the CA)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF_DIR=/etc/mikrotiklover-radius
CONF_FILE=$CONF_DIR/radius.conf
RADDB=/etc/freeradius/3.0
CERT_DIR=$RADDB/certs/mikrotiklover

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

svc() { # svc <action> <service>; works with and without systemd
    if [ -d /run/systemd/system ]; then systemctl "$1" "$2"; else service "$2" "$1"; fi
}

backup_once() { [ -e "$1" ] && [ ! -e "$1.mikrotiklover.orig" ] && cp -a "$1" "$1.mikrotiklover.orig" || true; }

[ "$(id -u)" -eq 0 ] || die "Run as root (sudo ./install.sh)"
command -v apt-get >/dev/null || die "Only Debian/Ubuntu are supported"

# ---------------------------------------------------------------- packages
log "Installing FreeRADIUS + MariaDB"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq freeradius freeradius-mysql freeradius-utils mariadb-server openssl rsyslog python3 python3-pymysql dnsmasq-base openssh-client iputils-ping >/dev/null
# eapol_test lets "radius-admin test --peap" simulate a real Wi-Fi client (optional package)
apt-get install -y -qq eapoltest >/dev/null 2>&1 || warn "eapoltest not available; PEAP self-test disabled"
[ -d "$RADDB" ] || die "$RADDB not found — unexpected FreeRADIUS layout"

# ---------------------------------------------------------------- settings
install -d -m 700 "$CONF_DIR"
# dashboard options given now win over the saved ones; otherwise the saved ones are kept on an update
ARG_WEB_PORT=${WEB_PORT:-} ARG_WEB_ALLOW=${WEB_ALLOW:-}
if [ -f "$CONF_FILE" ]; then
    # shellcheck source=/dev/null
    . "$CONF_FILE"
fi
DB_NAME=${DB_NAME:-radius}
DB_USER=${DB_USER:-radius}
DB_PASS=${DB_PASS:-$(openssl rand -hex 16)}
LOCAL_SECRET=${LOCAL_SECRET:-$(openssl rand -hex 16)}
RADIUS_DOMAIN=${RADIUS_DOMAIN:-radius.local}
CERT_ORG=${CERT_ORG:-MikrotikLover}
WEB_PORT=${ARG_WEB_PORT:-${WEB_PORT:-8443}}
WEB_ALLOW=${ARG_WEB_ALLOW:-${WEB_ALLOW:-"127.0.0.1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"}}

[[ $RADIUS_DOMAIN =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "Invalid RADIUS_DOMAIN"
[[ $CERT_ORG =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]] || die "CERT_ORG may only contain letters, digits, space . _ -"
[[ $WEB_PORT =~ ^[0-9]{2,5}$ ]] || die "Invalid WEB_PORT"
[[ $WEB_ALLOW =~ ^[0-9a-fA-F.:/\ ]+$ || $WEB_ALLOW == any ]] || die "WEB_ALLOW: IPs/networks separated by spaces, or 'any'"

umask 077
cat > "$CONF_FILE" <<EOF
# MikrotikLover RADIUS settings (written by install.sh — keep this file private)
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
LOCAL_SECRET=$LOCAL_SECRET
RADIUS_DOMAIN=$RADIUS_DOMAIN
CERT_ORG="$CERT_ORG"
WEB_PORT=$WEB_PORT
WEB_ALLOW="$WEB_ALLOW"
EOF
cat > "$CONF_DIR/my.cnf" <<EOF
[client]
user=$DB_USER
password=$DB_PASS
socket=/run/mysqld/mysqld.sock
default-character-set=utf8mb4
[mysql]
init-command="SET collation_connection=utf8mb4_unicode_ci"
EOF
umask 022

# ---------------------------------------------------------------- database
log "Configuring MariaDB database '$DB_NAME'"
svc enable mariadb >/dev/null 2>&1 || true
svc start mariadb
for _ in $(seq 1 30); do mysqladmin ping >/dev/null 2>&1 && break; sleep 1; done
mysqladmin ping >/dev/null 2>&1 || die "MariaDB did not start"

mysql <<EOF
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
EOF
# Official FreeRADIUS schema (CREATE TABLE IF NOT EXISTS → safe to re-run)
mysql "$DB_NAME" < "$RADDB/mods-config/sql/main/mysql/schema.sql"
mysql --default-character-set=utf8mb4 "$DB_NAME" < "$SCRIPT_DIR/templates/schema-extra.sql"
mysql --default-character-set=utf8mb4 "$DB_NAME" < "$SCRIPT_DIR/templates/functions.sql"
mysql -e "GRANT EXECUTE ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'"

# ---------------------------------------------------------------- certificates
make_ca() {
    log "Creating private CA"
    openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
        -keyout "$CERT_DIR/ca.key" -out "$CERT_DIR/ca.pem" \
        -subj "/O=$CERT_ORG/CN=$CERT_ORG RADIUS CA" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    openssl x509 -in "$CERT_DIR/ca.pem" -outform DER -out "$CERT_DIR/ca.der"
}

make_server_cert() {
    log "Issuing server certificate for $RADIUS_DOMAIN"
    local ext
    ext=$(mktemp)
    cat > "$ext" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:$RADIUS_DOMAIN
EOF
    openssl req -new -newkey rsa:2048 -sha256 -nodes \
        -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.csr" \
        -subj "/O=$CERT_ORG/CN=$RADIUS_DOMAIN" 2>/dev/null
    # 825 days: the maximum Apple devices accept for server certificates
    openssl x509 -req -sha256 -days 825 -in "$CERT_DIR/server.csr" \
        -CA "$CERT_DIR/ca.pem" -CAkey "$CERT_DIR/ca.key" -CAcreateserial \
        -extfile "$ext" -out "$CERT_DIR/server.pem" 2>/dev/null
    rm -f "$ext" "$CERT_DIR/server.csr"
}

install -d -m 750 -o root -g freerad "$CERT_DIR"
if [ ! -f "$CERT_DIR/ca.pem" ] || [ "${RENEW_CA:-0}" = 1 ]; then
    make_ca
    make_server_cert
elif [ ! -f "$CERT_DIR/server.pem" ] || [ "${RENEW_CERT:-0}" = 1 ]; then
    make_server_cert
fi
chown root:freerad "$CERT_DIR"/*
chmod 640 "$CERT_DIR"/*
chmod 600 "$CERT_DIR/ca.key"
chmod 644 "$CERT_DIR/ca.pem" "$CERT_DIR/ca.der"

# ---------------------------------------------------------------- FreeRADIUS config
log "Configuring FreeRADIUS"
backup_once "$RADDB/mods-available/sql"
backup_once "$RADDB/mods-available/eap"
backup_once "$RADDB/sites-available/default"
backup_once "$RADDB/sites-available/inner-tunnel"
backup_once "$RADDB/clients.conf"
backup_once "$RADDB/mods-config/sql/main/mysql/queries.conf"

sed -e "s|@DB_USER@|$DB_USER|" -e "s|@DB_PASS@|$DB_PASS|" -e "s|@DB_NAME@|$DB_NAME|" \
    "$SCRIPT_DIR/templates/sql" > "$RADDB/mods-available/sql"
install -m 640 -o freerad -g freerad "$SCRIPT_DIR/templates/eap" "$RADDB/mods-available/eap"
chown freerad:freerad "$RADDB/mods-available/sql"
chmod 640 "$RADDB/mods-available/sql"
ln -sfn ../mods-available/sql "$RADDB/mods-enabled/sql"
ln -sfn ../mods-available/eap "$RADDB/mods-enabled/eap"

# Always edit a fresh copy of the packaged site so re-runs stay idempotent.
cp -a "$RADDB/sites-available/default.mikrotiklover.orig" "$RADDB/sites-available/default"

# Simultaneous-Use (max sessions per user) needs SQL in the session section.
sed -i '/^session {/,/^}/ s/^#[[:space:]]*sql$/\tsql/' "$RADDB/sites-available/default"

# MAC authentication: normalise MAC user names before the SQL lookup and in accounting.
install -m 644 "$SCRIPT_DIR/templates/policy" "$RADDB/policy.d/mikrotiklover"
sed -i -e '/^authorize {/,/^}/ s/^\tpreprocess$/\tpreprocess\n\tmikrotiklover_mac_normalize/' \
       -e '/^authorize {/,/^}/ s/^\t-sql$/\t-sql\n\tmikrotiklover_limits/' \
       -e '/^post-auth {/,/^}/ s/^\t-sql$/\tmikrotiklover_activate\n\t-sql/' \
       -e '/^preacct {/,/^}/ s/^\tpreprocess$/\tpreprocess\n\tmikrotiklover_mac_normalize\n\tmikrotiklover_eap_account/' \
       "$RADDB/sites-available/default"

# WPA-Enterprise (PEAP/TTLS): the same plan limits inside the tunnel, where the real user logs in
cp -a "$RADDB/sites-available/inner-tunnel.mikrotiklover.orig" "$RADDB/sites-available/inner-tunnel"
sed -i -e '/^authorize {/,/^}/ s/^\t-sql$/\t-sql\n\tmikrotiklover_limits/' \
       -e '/^post-auth {/,/^}/ s/^\t-sql$/\tmikrotiklover_activate\n\tmikrotiklover_eap_identity\n\t-sql/' \
       "$RADDB/sites-available/inner-tunnel"

# Hosts/containers with IPv6 disabled cannot bind "::" — keep only the IPv4 listeners there.
if [ ! -e /proc/net/if_inet6 ]; then
    warn "IPv6 is disabled on this host — disabling the IPv6 RADIUS listeners"
    awk '/^listen \{/ {buf=$0 "\n"; inb=1; v6=0; next}
         inb { buf=buf $0 "\n"; if ($0 ~ /^[[:space:]]*ipv6addr/) v6=1
               if ($0 ~ /^\}/) { inb=0; if (v6) gsub(/(^|\n)/, "&#", buf); sub(/#$/, "", buf); printf "%s", buf }
               next }
         { print }' "$RADDB/sites-available/default" > "$RADDB/sites-available/default.tmp"
    cat "$RADDB/sites-available/default.tmp" > "$RADDB/sites-available/default"
    rm -f "$RADDB/sites-available/default.tmp"
fi

# Never store users' plaintext passwords in the radpostauth log table.
sed -i "s/'%{%{User-Password}:-%{Chap-Password}}'/''/" "$RADDB/mods-config/sql/main/mysql/queries.conf"

# Localhost client (used by "radius-admin test"): replace the well-known default secret.
sed -i -E "s/^([[:space:]]*secret[[:space:]]*=[[:space:]]*)testing123$/\1$LOCAL_SECRET/" "$RADDB/clients.conf"
grep -q "$LOCAL_SECRET" "$RADDB/clients.conf" || warn "Could not set the localhost secret in clients.conf"

# ---------------------------------------------------------------- admin tool
install -m 750 "$SCRIPT_DIR/radius-admin" /usr/local/sbin/radius-admin
# Enforcer: cut expired / slow FUP sessions (PPPoE has no Total-Limit) every 5 minutes
cat > /etc/cron.d/mikrotiklover <<'EOF'
# MikrotikLover RADIUS (install.sh)
*/5 * * * * root /usr/local/sbin/radius-admin enforce >/dev/null 2>&1
# hourly: learn app domains, app inventory + website names, VPN scan, security scan, router rules
7 * * * * root /usr/local/sbin/radius-admin hourly >/dev/null 2>&1
# weekly: app catalog, IP owners, new app names, threat lists, VPN lists, router rules
17 4 * * 2 root /usr/local/sbin/radius-admin update >/dev/null 2>&1
# alerts: Telegram / WhatsApp / email when something needs attention (+ daily summary); nothing is sent until set up
2-59/5 * * * * root /usr/local/sbin/radius-admin alerts check >/dev/null 2>&1
# nightly complete backup (newest 14 kept in /var/backups/mikrotiklover)
43 2 * * * root /usr/local/sbin/radius-admin backup --auto --quiet >/dev/null 2>&1
EOF
chmod 644 /etc/cron.d/mikrotiklover
command -v cron >/dev/null || apt-get install -y -qq cron >/dev/null 2>&1 || warn "cron missing: run 'radius-admin enforce' every 5 minutes yourself"
install -d -m 755 /usr/local/lib/mikrotiklover
install -m 644 "$SCRIPT_DIR/tools/mlreport.py" /usr/local/lib/mikrotiklover/mlreport.py
install -m 644 "$SCRIPT_DIR/tools/flowcollector.py" /usr/local/lib/mikrotiklover/flowcollector.py
install -m 644 "$SCRIPT_DIR/tools/cdnmap.py" "$SCRIPT_DIR/tools/cdnlearn.py" "$SCRIPT_DIR/tools/cdn-apps.json" "$SCRIPT_DIR/tools/ports.py" "$SCRIPT_DIR/tools/appinv.py" "$SCRIPT_DIR/tools/vpn.py" "$SCRIPT_DIR/tools/sentinel.py" "$SCRIPT_DIR/tools/alerts.py" "$SCRIPT_DIR/tools/health.py" "$SCRIPT_DIR/tools/insights.py" "$SCRIPT_DIR/tools/minipdf.py" "$SCRIPT_DIR/tools/secreport.py" "$SCRIPT_DIR/tools/routerstat.py" "$SCRIPT_DIR/tools/hotspotgen.py" "$SCRIPT_DIR/tools/routersetup.py" "$SCRIPT_DIR/tools/whyblocked.py" "$SCRIPT_DIR/tools/applearn.py" /usr/local/lib/mikrotiklover/
install -d -m 755 /usr/local/lib/mikrotiklover/hotspot-login
install -m 644 "$SCRIPT_DIR"/mikrotik/hotspot-login/*.html /usr/local/lib/mikrotiklover/hotspot-login/
install -d -m 755 /usr/local/lib/mikrotiklover/mikrotik      # router scripts for the Router setup page
install -m 644 "$SCRIPT_DIR"/mikrotik/*.rsc /usr/local/lib/mikrotiklover/mikrotik/
install -d -m 755 /var/lib/mikrotiklover
# Web-filter builder (router rules from policies, app lists and the VPN lists) — radius-admin policy build
install -d -m 755 /usr/local/lib/mikrotiklover/webfilter/categories /usr/local/lib/mikrotiklover/webfilter/allowonly
install -m 755 "$SCRIPT_DIR/webfilter/build.sh" /usr/local/lib/mikrotiklover/webfilter/build.sh
install -m 644 "$SCRIPT_DIR"/webfilter/*.in "$SCRIPT_DIR/webfilter/keywords.txt" /usr/local/lib/mikrotiklover/webfilter/
install -m 644 "$SCRIPT_DIR"/webfilter/categories/*.txt /usr/local/lib/mikrotiklover/webfilter/categories/
install -m 644 "$SCRIPT_DIR"/webfilter/allowonly/*.txt /usr/local/lib/mikrotiklover/webfilter/allowonly/
# Policies are edited on the server (dashboard → Blocking): each example is installed only once,
# so a policy the admin deleted does not come back with the next update.
install -d -m 755 /var/lib/mikrotiklover/policies /var/lib/mikrotiklover/router
touch /var/lib/mikrotiklover/policies/.installed
for f in "$SCRIPT_DIR"/webfilter/policies/*.txt; do
    b=$(basename "$f")
    [ "$b" = README.txt ] && continue
    grep -qxF "$b" /var/lib/mikrotiklover/policies/.installed && continue
    [ -e "/var/lib/mikrotiklover/policies/$b" ] || install -m 644 "$f" /var/lib/mikrotiklover/policies/
    echo "$b" >> /var/lib/mikrotiklover/policies/.installed
done
install -m 644 "$SCRIPT_DIR/webfilter/policies/README.txt" /var/lib/mikrotiklover/policies/README.txt
# allow-only app profiles (WhatsApp, Hik-Connect, …): editable copies, each shipped one installed once
install -d -m 755 /var/lib/mikrotiklover/allowonly
touch /var/lib/mikrotiklover/allowonly/.installed
for f in "$SCRIPT_DIR"/webfilter/allowonly/*.txt; do
    b=$(basename "$f")
    [ "$b" = meta-ipv4.txt ] && continue
    grep -qxF "$b" /var/lib/mikrotiklover/allowonly/.installed && continue
    [ -e "/var/lib/mikrotiklover/allowonly/$b" ] || install -m 644 "$f" /var/lib/mikrotiklover/allowonly/
    echo "$b" >> /var/lib/mikrotiklover/allowonly/.installed
done
[ -s /var/lib/mikrotiklover/asn.json ] || python3 -I /usr/local/lib/mikrotiklover/cdnmap.py update >/dev/null 2>&1 \
    || warn "Could not download the CDN detective IP lists (no internet?) — run later: radius-admin cdn update"
rm -f /usr/local/lib/mikrotiklover/wf-report.py

# ---------------------------------------------------------------- router logs (blocked-site report)
log "Configuring rsyslog for router web-filter logs (UDP 514)"
# Ubuntu's rsyslog drops privileges to user "syslog"; Debian's runs as root.
if id syslog >/dev/null 2>&1; then install -d -m 750 -o syslog -g adm /var/log/mikrotik
else install -d -m 750 -o root -g adm /var/log/mikrotik; fi
cat > /etc/logrotate.d/mikrotiklover-webfilter <<'EOF'
/var/log/mikrotik/webfilter.log /var/log/mikrotik/router.log {
    weekly
    rotate 8
    compress
    missingok
    notifempty
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate 2>/dev/null || true
    endscript
}
/var/log/mikrotik/dns.log {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate 2>/dev/null || true
    endscript
}
EOF
svc enable rsyslog >/dev/null 2>&1 || true
svc start rsyslog >/dev/null 2>&1 || true
/usr/local/sbin/radius-admin syslog-sync
# Re-apply optional services so upgrades take effect (DNS logger format, collector code)
if [ -f "$CONF_DIR/dnsmasq.conf" ]; then
    /usr/local/sbin/radius-admin dnslog on "$(sed -n 's/^server=//p' "$CONF_DIR/dnsmasq.conf" | head -1)" >/dev/null
fi
if pgrep -f '^(/usr/bin/)?python3 -I /usr/local/lib/mikrotiklover/flowcollector[.]py' >/dev/null; then
    /usr/local/sbin/radius-admin traffic collector on >/dev/null
fi

# ---------------------------------------------------------------- web dashboard
# WEB=0 skips it. WEB_PORT (default 8443). WEB_ALLOW: who may open it (default: private networks).
WEB=${WEB:-1}
WEB_URL=""
if [ "$WEB" = 1 ]; then
    WEB_PORT=${WEB_PORT:-8443}
    WEB_ALLOW=${WEB_ALLOW:-"127.0.0.1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10"}
    [[ $WEB_PORT =~ ^[0-9]{2,5}$ ]] || die "Invalid WEB_PORT"
    [[ $WEB_ALLOW =~ ^[0-9a-fA-F.:/\ ]+$ || $WEB_ALLOW == any ]] || die "WEB_ALLOW: IPs/networks separated by spaces, or 'any'"
    log "Installing the web dashboard (port $WEB_PORT)"
    apt-get install -y -qq python3-flask python3-waitress python3-werkzeug nginx sudo >/dev/null
    id mlweb >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin mlweb
    usermod -a -G adm mlweb                          # read /var/log/mikrotik (reports)
    chgrp adm /var/log/mikrotik/*.log 2>/dev/null || true

    WEB_DIR=/etc/mikrotiklover-radius-web
    install -d -m 750 -o root -g mlweb "$WEB_DIR"
    WEB_DB_PASS="" SECRET_KEY="" BLOCK_KEY=""
    if [ -f "$WEB_DIR/web.conf" ]; then
        WEB_DB_PASS=$(sed -n 's/^WEB_DB_PASS=//p' "$WEB_DIR/web.conf")
        SECRET_KEY=$(sed -n 's/^SECRET_KEY=//p' "$WEB_DIR/web.conf")
        BLOCK_KEY=$(sed -n 's/^BLOCK_KEY=//p' "$WEB_DIR/web.conf")
    fi
    WEB_DB_PASS=${WEB_DB_PASS:-$(openssl rand -hex 16)}
    SECRET_KEY=${SECRET_KEY:-$(openssl rand -hex 32)}
    BLOCK_KEY=${BLOCK_KEY:-$(openssl rand -hex 24)}     # nginx (block page proxy) -> app
    mysql <<EOF
CREATE USER IF NOT EXISTS 'radius_web'@'localhost' IDENTIFIED BY '$WEB_DB_PASS';
ALTER USER 'radius_web'@'localhost' IDENTIFIED BY '$WEB_DB_PASS';
GRANT SELECT ON \`$DB_NAME\`.* TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON \`$DB_NAME\`.web_admin TO 'radius_web'@'localhost';
GRANT INSERT ON \`$DB_NAME\`.web_audit TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON \`$DB_NAME\`.ml_setting TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON \`$DB_NAME\`.ml_router_status TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON \`$DB_NAME\`.ml_router_stat TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE, DELETE ON \`$DB_NAME\`.ml_router_setup TO 'radius_web'@'localhost';
GRANT INSERT, UPDATE ON \`$DB_NAME\`.ml_traffic TO 'radius_web'@'localhost';
GRANT INSERT, DELETE ON \`$DB_NAME\`.ml_block_event TO 'radius_web'@'localhost';
GRANT INSERT ON \`$DB_NAME\`.ml_unblock TO 'radius_web'@'localhost';
GRANT EXECUTE ON \`$DB_NAME\`.* TO 'radius_web'@'localhost';
FLUSH PRIVILEGES;
EOF
    mysql "$DB_NAME" -e "INSERT INTO ml_setting (k, v) VALUES ('radius_domain', '$RADIUS_DOMAIN') ON DUPLICATE KEY UPDATE v=VALUES(v)"
    umask 027
    cat > "$WEB_DIR/web.conf" <<EOF
# MikrotikLover web dashboard (written by install.sh)
DB_NAME=$DB_NAME
WEB_DB_USER=radius_web
WEB_DB_PASS=$WEB_DB_PASS
SECRET_KEY=$SECRET_KEY
BLOCK_KEY=$BLOCK_KEY
BIND=127.0.0.1:8099
EOF
    cat > "$WEB_DIR/my.cnf" <<EOF
[client]
user=radius_web
password=$WEB_DB_PASS
socket=/run/mysqld/mysqld.sock
EOF
    umask 022
    chgrp mlweb "$WEB_DIR/web.conf" "$WEB_DIR/my.cnf"

    # application + the policy list it offers
    install -d -m 755 /usr/local/lib/mikrotiklover/web/static
    install -m 644 "$SCRIPT_DIR/web/app.py" /usr/local/lib/mikrotiklover/web/app.py
    install -m 644 "$SCRIPT_DIR/mikrotik/autosync.rsc" /usr/local/lib/mikrotiklover/web/autosync.rsc   # router auto-sync template
    install -m 644 "$SCRIPT_DIR"/web/static/* /usr/local/lib/mikrotiklover/web/static/
    install -m 644 "$CERT_DIR/ca.der" /usr/local/lib/mikrotiklover/web/static/ca.der    # public CA for the connect guide
    install -m 644 "$CERT_DIR/ca.pem" /usr/local/lib/mikrotiklover/web/static/ca.pem

    # the dashboard may run radius-admin as root — and nothing else
    echo 'mlweb ALL=(root) NOPASSWD: /usr/local/sbin/radius-admin' > /etc/sudoers.d/.mikrotiklover-web.tmp
    visudo -cf /etc/sudoers.d/.mikrotiklover-web.tmp >/dev/null || die "sudoers check failed"
    install -m 440 /etc/sudoers.d/.mikrotiklover-web.tmp /etc/sudoers.d/mikrotiklover-web
    rm -f /etc/sudoers.d/.mikrotiklover-web.tmp

    # nginx: TLS with this server's certificate, only allowed networks, proxy to the app
    {
        echo "# Managed by MikrotikLover install.sh"
        echo "server {"
        echo "    listen $WEB_PORT ssl;"
        [ -e /proc/net/if_inet6 ] && echo "    listen [::]:$WEB_PORT ssl;"
        echo "    server_name _;"
        echo "    ssl_certificate $CERT_DIR/server.pem;"
        echo "    ssl_certificate_key $CERT_DIR/server.key;"
        echo "    ssl_protocols TLSv1.2 TLSv1.3;"
        echo "    server_tokens off;"
        echo "    client_max_body_size 64k;"
        echo '    add_header Strict-Transport-Security "max-age=31536000" always;'
        if [ "$WEB_ALLOW" != any ]; then
            for a in $WEB_ALLOW; do echo "    allow $a;"; done
            echo "    deny all;"
        fi
        echo "    # public: the users' connect guide (names, CA certificate) — no login, any network"
        echo "    location ~ ^/(connect|api/public/|static/) {"
        echo "        allow all;"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo '        proxy_set_header Host $host;'
        echo '        proxy_set_header X-Forwarded-For $remote_addr;'
        echo "        proxy_set_header X-Forwarded-Proto https;"
        echo '        proxy_set_header X-Forwarded-Port $server_port;'
        echo "    }"
        echo "    location / {"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo '        proxy_set_header Host $host;'
        echo '        proxy_set_header X-Forwarded-For $remote_addr;'
        echo "        proxy_set_header X-Forwarded-Proto https;"
        echo '        proxy_set_header X-Forwarded-Port $server_port;'
        echo "        proxy_read_timeout 900s;    # backups, Run all updates now and threat-list downloads can take minutes"
        echo "    }"
        echo "}"
        echo
        echo "# Quarantine warning page (plain HTTP, any network): the routers send every http:// request of an"
        echo "# infected device here (radius-admin security quarantine). Nothing else is served on this port."
        echo "server {"
        echo "    listen 8081;"
        [ -e /proc/net/if_inet6 ] && echo "    listen [::]:8081;"
        echo "    server_name _;"
        echo "    server_tokens off;"
        echo "    location ~ ^/static/(quarantine|social)\\.(css|js)\$ {"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo "    }"
        echo "    location /social/ {             # social WiFi portal (phone number + code, before login)"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo '        proxy_set_header Host $host;'
        echo '        proxy_set_header X-Forwarded-For $remote_addr;'
        echo "        client_max_body_size 16k;"
        echo "    }"
        echo "    location / {"
        echo "        rewrite ^ /quarantine break;"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo '        proxy_set_header Host $host;'
        echo '        proxy_set_header X-Forwarded-For $remote_addr;'
        echo "    }"
        echo "}"
        echo
        echo "# Block page (plain HTTP): the routers send the http:// requests of users with a web-filter policy here"
        echo "# (radius-admin blockpage on). The app says per request: blocked -> branded block page, else the request"
        echo "# goes on to the address the app checked (public addresses only, never this server or the LAN)."
        echo "server {"
        echo "    listen 8082;"
        echo "    server_name _;"
        echo "    server_tokens off;"
        echo "    allow 10.0.0.0/8; allow 172.16.0.0/12; allow 192.168.0.0/16; allow 100.64.0.0/10; allow 127.0.0.1;"
        echo "    deny all;"
        echo "    client_max_body_size 0;"
        echo "    location = /__mlcheck {"
        echo "        internal;"
        echo "        proxy_pass http://127.0.0.1:8099/internal/blockcheck;"
        echo "        proxy_pass_request_body off;"
        echo '        proxy_set_header Content-Length "";'
        echo "        proxy_set_header X-ML-Block $BLOCK_KEY;"
        echo '        proxy_set_header X-ML-Host $host;'
        echo '        proxy_set_header X-Real-IP $remote_addr;'
        echo "    }"
        echo "    location = /__mlrequest {     # the 'please open it' button of the block page"
        echo "        proxy_pass http://127.0.0.1:8099/internal/unblockrequest;"
        echo "        client_max_body_size 4k;"
        echo "        proxy_set_header X-ML-Block $BLOCK_KEY;"
        echo '        proxy_set_header X-ML-Host $host;'
        echo '        proxy_set_header X-Real-IP $remote_addr;'
        echo "    }"
        echo "    location @mlblocked {"
        echo "        rewrite ^ /internal/blockpage break;"
        echo "        proxy_pass http://127.0.0.1:8099;"
        echo '        proxy_method GET;'
        echo '        proxy_pass_request_body off;'
        echo '        proxy_set_header Content-Length "";'
        echo "        proxy_set_header X-ML-Block $BLOCK_KEY;"
        echo '        proxy_set_header X-ML-Host $host;'
        echo '        proxy_set_header X-ML-Uri $request_uri;'
        echo '        proxy_set_header X-Real-IP $remote_addr;'
        echo "    }"
        echo "    location / {"
        echo "        auth_request /__mlcheck;"
        echo '        auth_request_set $ml_up $upstream_http_x_ml_upstream;'
        echo "        error_page 403 = @mlblocked;"
        echo '        proxy_pass http://$ml_up$request_uri;'
        echo '        proxy_set_header Host $http_host;'
        echo "        proxy_http_version 1.1;"
        echo '        proxy_set_header Connection "";'
        echo "        proxy_buffering off;"
        echo "        proxy_request_buffering off;"
        echo "        proxy_read_timeout 300s;"
        echo "    }"
        echo "}"
    } > /etc/nginx/sites-available/mikrotiklover
    ln -sfn ../sites-available/mikrotiklover /etc/nginx/sites-enabled/mikrotiklover
    # IPv6 disabled on this host: nginx's stock default site would fail on "listen [::]:80"
    if [ ! -e /proc/net/if_inet6 ] && [ -f /etc/nginx/sites-available/default ]; then
        sed -i -E 's/^([[:space:]]*)listen \[::\]/\1# listen [::]/' /etc/nginx/sites-available/default
    fi
    nginx -t >/dev/null 2>&1 || { nginx -t; die "nginx configuration failed"; }

    if [ -d /run/systemd/system ]; then
        cat > /etc/systemd/system/mikrotiklover-web.service <<EOF
[Unit]
Description=MikrotikLover RADIUS web dashboard
After=network-online.target mariadb.service
Wants=network-online.target

[Service]
User=mlweb
Group=mlweb
SupplementaryGroups=adm
ExecStart=/usr/bin/python3 -I /usr/local/lib/mikrotiklover/web/app.py
Restart=always
RestartSec=3
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable mikrotiklover-web >/dev/null 2>&1
        systemctl restart mikrotiklover-web
        systemctl enable nginx >/dev/null 2>&1 || true
        systemctl reload nginx 2>/dev/null || systemctl restart nginx
    else
        pkill -u mlweb -f '^/usr/bin/python3 -I /usr/local/lib/mikrotiklover/web/app[.]py' 2>/dev/null || true
        runuser -u mlweb -- nohup /usr/bin/python3 -I /usr/local/lib/mikrotiklover/web/app.py >>/var/log/mikrotik/web.log 2>&1 &
        if pgrep -x nginx >/dev/null; then nginx -s reload; else nginx; fi
    fi

    # first dashboard account
    if [ "$(mysql -N "$DB_NAME" -e 'SELECT COUNT(*) FROM web_admin')" = 0 ]; then
        WEB_FIRST_PASS=$(openssl rand -base64 18 | tr -dc 'A-HJ-NP-Za-km-z2-9' | cut -c1-14)
        printf '%s\n' "$WEB_FIRST_PASS" | /usr/local/sbin/radius-admin web passwd admin -p - >/dev/null
    fi
    WEB_URL="https://$(hostname -I 2>/dev/null | awk '{print $1}'):$WEB_PORT"
fi

# threat lists for the security detective (first time; then weekly by "radius-admin update")
[ -s /var/lib/mikrotiklover/threat-domains.txt ] || python3 -I /usr/local/lib/mikrotiklover/sentinel.py update >/dev/null 2>&1 \
    || warn "Could not download the threat lists (no internet?) — run later: radius-admin security update"
install -d -m 750 /var/backups/mikrotiklover
chgrp mlweb /var/backups/mikrotiklover 2>/dev/null || true
# router rules from the policies (+ VPN list) for the routers' auto-sync (radius-admin policy sync)
/usr/local/sbin/radius-admin policy build >/dev/null || warn "Router rules not built — run: radius-admin policy build"

# ---------------------------------------------------------------- start
log "Checking configuration"
freeradius -C -lstdout >/dev/null 2>&1 || { freeradius -XC 2>&1 | tail -30; die "FreeRADIUS configuration check failed"; }
svc enable freeradius >/dev/null 2>&1 || true
svc restart freeradius

cat <<EOF

$(printf '\033[1;32m')RADIUS server is ready.$(printf '\033[0m')

  Ports            : 1812/udp (auth), 1813/udp (accounting), 514/udp (router logs) — open them
                     for your MikroTik IPs only (see README.md).
  Settings         : $CONF_FILE
  CA certificate   : $CERT_DIR/ca.pem  (ca.der for Windows/Android)
  Cert domain      : $RADIUS_DOMAIN   (enter this as "Domain" on Android)

$( [ -n "$WEB_URL" ] && printf 'Web dashboard    : %s\n' "$WEB_URL" )
$( [ -n "${WEB_FIRST_PASS:-}" ] && printf '  First login    : admin / %s   (change it under Settings)\n' "$WEB_FIRST_PASS" )

Next steps:
  radius-admin nas add <mikrotik-ip> [secret] [name]
  radius-admin group add staff --rate 10M/10M
  radius-admin user add ali --group staff
  radius-admin test ali --peap
EOF
