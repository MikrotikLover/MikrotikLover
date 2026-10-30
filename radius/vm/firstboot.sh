#!/usr/bin/env bash
# First boot of the MikrotikLover VM image: the installer runs here (not when the image was built), so every VM gets
# its own database passwords, certificates (CA + server), RADIUS secrets and dashboard login. Then the console shows
# the dashboard address and the first login.
set -uo pipefail
LOG=/var/log/mikrotiklover-firstboot.log
ISSUE=/etc/issue.d/mikrotiklover.issue
PASSF=/root/mikrotiklover-first-login.txt
exec >>"$LOG" 2>&1
echo "== first boot $(date -Is)"
say() { local t; for t in /dev/tty1 /dev/ttyS0; do [ -w "$t" ] && printf '%s\n' "$@" > "$t" 2>/dev/null; done; printf '%s\n' "$@"; }

install -d -m 755 /etc/issue.d
printf '\n  MikrotikLover RADIUS: setting up this server for the first time (a few minutes)...\n  Log: %s\n\n' "$LOG" > "$ISSUE"
agetty --reload 2>/dev/null || true           # the login prompts show the new banner
say "MikrotikLover: first boot setup started (own passwords and certificates for this VM)"

[ -s /etc/machine-id ] || systemd-machine-id-setup
command -v make-ssl-cert >/dev/null && make-ssl-cert generate-default-snakeoil --force-overwrite || true

# wait a little for an address (DHCP), the installer prints the dashboard address with it
for _ in $(seq 1 30); do hostname -I 2>/dev/null | grep -q '[0-9]' && break; sleep 2; done

if (cd /opt/mikrotiklover/radius && ML_FIRST_PASS_FILE=$PASSF ./install.sh); then
    install -d -m 755 /var/lib/mikrotiklover && date -Is > /var/lib/mikrotiklover/firstboot.done
    cat > "$ISSUE" <<'ISS'

  MikrotikLover RADIUS server  (\n)
  -----------------------------------------------------------------------
  Dashboard   : https://\4:8443/
  First login : sudo cat /root/mikrotiklover-first-login.txt
  Console     : user mladmin, password mikrotiklover (a new one is asked at once)
  Fixed IP    : sudo radius-admin netip static 192.168.88.10/24 192.168.88.1
  Routers     : RADIUS address = this server's IP; secret: sudo radius-admin nas add ROUTER-IP

ISS
    agetty --reload 2>/dev/null || true
    sleep 1
    say "" "MikrotikLover is ready: https://$(hostname -I | awk '{print $1}'):8443/" "$(cat "$PASSF" 2>/dev/null)" ""
    echo "== done"
else
    printf '\n  MikrotikLover first boot setup FAILED — see %s, then: sudo systemctl restart mikrotiklover-firstboot\n\n' "$LOG" > "$ISSUE"
    agetty --reload 2>/dev/null || true
    say "MikrotikLover first boot setup FAILED — see $LOG"
    exit 1
fi
