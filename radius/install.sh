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
apt-get install -y -qq freeradius freeradius-mysql freeradius-utils mariadb-server openssl rsyslog python3 >/dev/null
# eapol_test lets "radius-admin test --peap" simulate a real Wi-Fi client (optional package)
apt-get install -y -qq eapoltest >/dev/null 2>&1 || warn "eapoltest not available; PEAP self-test disabled"
[ -d "$RADDB" ] || die "$RADDB not found — unexpected FreeRADIUS layout"

# ---------------------------------------------------------------- settings
install -d -m 700 "$CONF_DIR"
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

[[ $RADIUS_DOMAIN =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "Invalid RADIUS_DOMAIN"
[[ $CERT_ORG =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]] || die "CERT_ORG may only contain letters, digits, space . _ -"

umask 077
cat > "$CONF_FILE" <<EOF
# MikrotikLover RADIUS settings (written by install.sh — keep this file private)
DB_NAME=$DB_NAME
DB_USER=$DB_USER
DB_PASS=$DB_PASS
LOCAL_SECRET=$LOCAL_SECRET
RADIUS_DOMAIN=$RADIUS_DOMAIN
CERT_ORG="$CERT_ORG"
EOF
cat > "$CONF_DIR/my.cnf" <<EOF
[client]
user=$DB_USER
password=$DB_PASS
socket=/run/mysqld/mysqld.sock
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
mysql "$DB_NAME" < "$SCRIPT_DIR/templates/schema-extra.sql"

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
       -e '/^preacct {/,/^}/ s/^\tpreprocess$/\tpreprocess\n\tmikrotiklover_mac_normalize/' \
       "$RADDB/sites-available/default"

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
install -d -m 755 /usr/local/lib/mikrotiklover
install -m 644 "$SCRIPT_DIR/tools/wf-report.py" /usr/local/lib/mikrotiklover/wf-report.py

# ---------------------------------------------------------------- router logs (blocked-site report)
log "Configuring rsyslog for router web-filter logs (UDP 514)"
# Ubuntu's rsyslog drops privileges to user "syslog"; Debian's runs as root.
if id syslog >/dev/null 2>&1; then install -d -m 750 -o syslog -g adm /var/log/mikrotik
else install -d -m 750 -o root -g adm /var/log/mikrotik; fi
cat > /etc/logrotate.d/mikrotiklover-webfilter <<'EOF'
/var/log/mikrotik/webfilter.log {
    weekly
    rotate 8
    compress
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

Next steps:
  radius-admin nas add <mikrotik-ip> [secret] [name]
  radius-admin group add staff --rate 10M/10M
  radius-admin user add ali --group staff
  radius-admin test ali --peap
EOF
