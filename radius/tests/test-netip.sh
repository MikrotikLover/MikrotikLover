#!/usr/bin/env bash
# radius-admin netip: this server's own address by netplan (VM image console). Written to a test folder, not applied.
#   sudo bash tests/test-netip.sh
set -uo pipefail
db() { mysql --defaults-extra-file=/etc/mikrotiklover-radius/my.cnf -N -B radius -e "$1"; }
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
T=$(mktemp -d); export NETPLAN_DIR=$T NETPLAN_APPLY=0
sip=$(db "SELECT v FROM ml_setting WHERE k='server_ip'")
trap 'db "REPLACE INTO ml_setting (k, v) VALUES (\"server_ip\", \"$sip\")"; rm -rf "$T"' EXIT
printf 'network:\n  version: 2\n  ethernets:\n    wired:\n      match:\n        name: "e*"\n      dhcp4: true\n' > "$T/40-image.yaml"
printf 'network:\n  version: 2\n  wifis: {}\n' > "$T/90-other.yaml"

db "DELETE FROM ml_setting WHERE k='server_ip'"
radius-admin netip static 192.168.88.10/24 192.168.88.1 8.8.8.8,1.1.1.1 --if ens18 > /dev/null 2>&1
t "static: written for the card, gateway as default route, DNS list" "$(python3 -c "
import yaml,sys; d=yaml.safe_load(open('$T/50-mikrotiklover.yaml'))['network']['ethernets']['ens18']
print(d['dhcp4'], d['addresses'], d['routes'][0]['via'], d['nameservers']['addresses'])" 2>/dev/null || grep -c 'via: 192.168.88.1' "$T/50-mikrotiklover.yaml")" "False ['192.168.88.10/24'] 192.168.88.1 ['8.8.8.8', '1.1.1.1']"
t "  ... root-only file (netplan wants 600)" "$(stat -c %a "$T/50-mikrotiklover.yaml")" "600"
t "  ... the image's DHCP file for all cards set aside, others kept" "$(ls "$T" | paste -sd' ')" "40-image.yaml.ml-off 50-mikrotiklover.yaml 90-other.yaml"
t "  ... the server's IP setting follows (it was empty)" "$(db "SELECT v FROM ml_setting WHERE k='server_ip'")" "192.168.88.10"
db "REPLACE INTO ml_setting (k, v) VALUES ('server_ip', '10.9.9.9')"
radius-admin netip static 192.168.88.11/24 192.168.88.1 --if ens18 >/dev/null 2>&1
t "  ... but not when it was set to another address by hand" "$(db "SELECT v FROM ml_setting WHERE k='server_ip'")" "10.9.9.9"
t "  ... DNS defaults to the gateway" "$(grep -A1 nameservers "$T/50-mikrotiklover.yaml" | grep -c '\[192.168.88.1\]')" "1"
t "refused: gateway outside the network" "$(radius-admin netip static 192.168.88.10/24 10.0.0.1 --if ens18 2>&1 | grep -c 'not in 192.168.88.0/24')" "1"
t "refused: no network size / network address / broadcast" "$(radius-admin netip static 192.168.88.10 192.168.88.1 --if ens18 2>&1 | grep -c 'network size')$(radius-admin netip static 192.168.88.0/24 192.168.88.1 --if ens18 2>&1 | grep -c 'network size')$(radius-admin netip static 192.168.88.255/24 192.168.88.1 --if ens18 2>&1 | grep -c 'network size')" "111"
t "refused: bad DNS, bad card name, nothing written" "$(radius-admin netip static 192.168.88.10/24 192.168.88.1 'x;y' --if ens18 2>&1 | grep -c usage)$(radius-admin netip static 1 2 --if 'e;rm' 2>&1 | grep -c 'no network card')$(grep -c '192.168.88.11/24' "$T/50-mikrotiklover.yaml")" "111"
radius-admin netip dhcp --if ens18 >/dev/null
t "dhcp: back to DHCP on the card" "$(grep -c 'dhcp4: true' "$T/50-mikrotiklover.yaml") $(grep -c addresses "$T/50-mikrotiklover.yaml")" "1 0"
t "show: card, address, how it is set" "$(radius-admin netip show --if ens18 | grep -c 'Card     : ens18\|Set by   : DHCP')" "2"
t "unknown sub-command: usage" "$(radius-admin netip foo 2>&1 | grep -c usage)" "1"
[ "$fails" = 0 ] && echo "all netip tests passed" || { echo "$fails FAILED"; exit 1; }
