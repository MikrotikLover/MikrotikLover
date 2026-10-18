#!/usr/bin/env bash
# MikrotikLover RADIUS — one-command install / update
#
#   curl -fsSL https://raw.githubusercontent.com/MikrotikLover/MikrotikLover/main/radius/get.sh | sudo bash
#
# With answers (no questions asked):
#   curl -fsSL .../get.sh | sudo bash -s -- --domain radius.mycompany.lan --yes
#
# Options:
#   --domain NAME       certificate / server name (Wi-Fi clients see it)       default: radius.local
#   --org NAME          company name in the certificates                       default: MikrotikLover
#   --web-allow LIST    who may open the dashboard ("any" or networks)         default: private networks
#   --web-port N        dashboard port                                         default: 8443
#   --firewall          open the needed ports in ufw (if ufw is on)
#   --yes               no questions (use the defaults / options above)
#   --branch NAME       git branch                                             default: main
#   --repo URL          git repository                                         default: GitHub
#   --dir DIR           where the code is kept                                 default: /opt/mikrotiklover
#   --force             install on an untested OS too
# Running it again updates the code and re-runs the installer (users and settings are kept).
set -euo pipefail

REPO=${REPO:-https://github.com/MikrotikLover/MikrotikLover.git}
BRANCH=${BRANCH:-main}
DIR=${DIR:-/opt/mikrotiklover}
DOMAIN=${RADIUS_DOMAIN:-} ORG=${CERT_ORG:-} ALLOW=${WEB_ALLOW:-} PORT=${WEB_PORT:-}
YES=0 FORCE=0 FIREWALL=0

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case $1 in
        --domain) DOMAIN=${2:-}; shift 2 ;;
        --org) ORG=${2:-}; shift 2 ;;
        --web-allow) ALLOW=${2:-}; shift 2 ;;
        --web-port) PORT=${2:-}; shift 2 ;;
        --branch) BRANCH=${2:-}; shift 2 ;;
        --repo) REPO=${2:-}; shift 2 ;;
        --dir) DIR=${2:-}; shift 2 ;;
        --firewall) FIREWALL=1; shift ;;
        --yes|-y) YES=1; shift ;;
        --force) FORCE=1; shift ;;
        -h|--help) sed -n '2,23p' "$0" 2>/dev/null || true; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

# questions come from the keyboard even when the script itself arrives through a pipe (curl | bash)
TTY=""
if [ "$YES" = 0 ] && { exec 3</dev/tty; } 2>/dev/null; then TTY=1; fi
ask() { # ask VAR "question" default
    local v=""
    if [ -n "$TTY" ]; then read -r -u 3 -p "$2 [$3]: " v || true; fi
    printf -v "$1" '%s' "${v:-$3}"
}

# ---------------------------------------------------------------- checks before anything is changed
[ "$(id -u)" -eq 0 ] || die "run as root:  curl -fsSL .../get.sh | sudo bash"
command -v apt-get >/dev/null || die "only Debian / Ubuntu are supported"
. /etc/os-release 2>/dev/null || true
case "${ID:-}:${VERSION_ID:-}" in
    debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) say "System: ${PRETTY_NAME:-$ID $VERSION_ID}" ;;
    *) [ "$FORCE" = 1 ] || die "untested system '${PRETTY_NAME:-unknown}' (tested: Debian 12/13, Ubuntu 22.04/24.04). Add --force to try anyway"
       warn "untested system '${PRETTY_NAME:-unknown}' — continuing (--force)" ;;
esac
case $(uname -m) in x86_64|aarch64|arm64) ;; *) warn "processor $(uname -m) is not tested" ;; esac
mem=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
[ "$mem" -ge 900 ] || die "too little memory: ${mem} MB (1 GB or more needed)"
disk=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$disk" -ge 3000 ] || die "too little free disk: ${disk} MB (3 GB or more needed; logs and backups grow)"
if command -v ss >/dev/null; then
    other=$(ss -H -lunp 2>/dev/null | awk '$4 ~ /:(1812|1813)$/' | grep -v freeradius || true)
    [ -z "$other" ] || die "another program already uses the RADIUS ports 1812/1813: $other"
fi
case $REPO in
    http*://*) curl -fsS -m 20 -o /dev/null "${REPO%.git}" 2>/dev/null || curl -fsS -m 20 -o /dev/null https://deb.debian.org 2>/dev/null \
                   || die "no internet (needed for packages and the code). Check DNS / gateway / proxy" ;;
esac
UPDATE=0
[ -f /etc/mikrotiklover-radius/radius.conf ] && UPDATE=1

# ---------------------------------------------------------------- questions (only on a first install)
if [ "$UPDATE" = 1 ]; then
    say "MikrotikLover is already installed here — updating (users, settings and data are kept)"
else
    echo
    echo "  MikrotikLover RADIUS — install"
    echo "  Press Enter to take the value in [brackets]."
    echo
    [ -n "$DOMAIN" ] || ask DOMAIN "Server name for the Wi-Fi certificate (e.g. radius.mycompany.lan)" "radius.local"
    [ -n "$ORG" ] || ask ORG "Company name (in the certificates)" "MikrotikLover"
    [ -n "$ALLOW" ] || ask ALLOW "Who may open the dashboard: 'lan' (private networks) or 'any'" "lan"
    [ "$ALLOW" != lan ] || ALLOW=""
fi
[ -z "$DOMAIN" ] || [[ $DOMAIN =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "invalid server name: $DOMAIN"
[ -z "$ORG" ] || [[ $ORG =~ ^[A-Za-z0-9\ ._-]{1,64}$ ]] || die "company name: letters, digits, space . _ - only"
[ -z "$PORT" ] || [[ $PORT =~ ^[0-9]{2,5}$ ]] || die "invalid --web-port"
[[ $BRANCH =~ ^[A-Za-z0-9._/-]+$ ]] || die "invalid --branch"

# ---------------------------------------------------------------- code
say "Getting the code ($BRANCH)"
export DEBIAN_FRONTEND=noninteractive
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git ca-certificates curl >/dev/null; }
if [ -d "$DIR/.git" ]; then
    git -C "$DIR" remote set-url origin "$REPO"
    git -C "$DIR" fetch -q --depth 1 origin "$BRANCH" || die "could not download the code from $REPO"
    git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
else
    [ ! -e "$DIR" ] || [ -z "$(ls -A "$DIR" 2>/dev/null)" ] || die "$DIR exists and is not a MikrotikLover copy — use --dir"
    git clone -q --depth 1 -b "$BRANCH" "$REPO" "$DIR" || die "could not download the code from $REPO"
fi
[ -x "$DIR/radius/install.sh" ] || chmod +x "$DIR/radius/install.sh" 2>/dev/null || die "$DIR/radius/install.sh missing"
say "Code: $(git -C "$DIR" log -1 --format='%h %cd' --date=short)"

# ---------------------------------------------------------------- install
say "Installing (takes 2–5 minutes) — full log: /var/log/mikrotiklover-install.log"
env ${DOMAIN:+RADIUS_DOMAIN="$DOMAIN"} ${ORG:+CERT_ORG="$ORG"} ${ALLOW:+WEB_ALLOW="$ALLOW"} ${PORT:+WEB_PORT="$PORT"} \
    bash "$DIR/radius/install.sh" > >(tee /var/log/mikrotiklover-install.log) 2>&1 \
    || die "installer failed — last lines above; full log: /var/log/mikrotiklover-install.log"

# ---------------------------------------------------------------- firewall
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if [ "$FIREWALL" = 1 ]; then
        for p in 1812/udp 1813/udp 514/udp 2055/udp 53/udp 53/tcp "${PORT:-8443}/tcp" 8081/tcp 8082/tcp; do ufw allow "$p" >/dev/null; done
        say "Firewall (ufw): RADIUS, router logs, traffic, DNS, dashboard and quarantine page opened"
    else
        warn "ufw is on: open the ports (docs/INSTALL.md 'Server firewall'), or run again with --firewall"
    fi
fi

# ---------------------------------------------------------------- result
echo
say "Health check"
/usr/local/sbin/radius-admin doctor 2>/dev/null | sed -n '/^Services/,/^Jobs/p' | grep -v '^Jobs' || true
echo
say "Done. Next:"
echo "  1. Open the dashboard (address + first password are printed above, under the installer summary)"
echo "  2. Add your router:   sudo radius-admin nas add ROUTER_IP NAME"
echo "  3. Router setup:      $DIR/radius/docs/INSTALL.md  (sections 4–5)"
echo "  4. Anything red later: sudo radius-admin doctor"
echo "  Update later: run the same command again."
