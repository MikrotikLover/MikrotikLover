#!/usr/bin/env bash
# The ready VM image (vm/build-image.sh), booted like a customer would: first boot sets the VM up by itself; the console
# shows the dashboard address and the first login; the dashboard login works; SSH has its own host keys and asks for a
# new password; a router (NAS) added on the dashboard gets a RADIUS answer from the VM; netip and the health check run.
#   bash tests/test-vm-image.sh vm-image/mikrotiklover-radius-….qcow2 [--ova FILE] [--vhdx FILE]
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=${1:-${ML_VM_IMAGE:-}}
if [ -z "$IMG" ]; then echo "skip: no image given (vm/build-image.sh makes one; test-vm-image.sh IMAGE.qcow2)"; echo "all VM image tests passed (skipped)"; exit 0; fi
shift || true
OVA="" VHDX=""
while [ $# -gt 0 ]; do case $1 in --ova) OVA=$2; shift 2 ;; --vhdx) VHDX=$2; shift 2 ;; *) shift ;; esac; done
fails=0
t() { if [[ $2 == "$3" ]]; then echo "ok   $1"; else echo "FAIL $1: got '$2' expected '$3'"; fails=$((fails+1)); fi; }
W=$(mktemp -d) QP=""
cleanup() { [ -n "$QP" ] && kill "$QP" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
P_WEB=18443 P_SSH=12222 P_RAD=11812

# the images in the other formats are the same disk
if [ -n "$OVA" ]; then
    tar -tf "$OVA" > "$W/ova.list"
    t "OVA: the description first, then the checksum list and the disk" "$(sed -E 's/^.*(\.ovf|\.mf|-disk1\.vmdk)$/\1/' "$W/ova.list" | paste -sd' ')" ".ovf .mf -disk1.vmdk"
    tar -xf "$OVA" -C "$W" --wildcards '*.ovf' '*.mf'
    t "  ... the OVF is valid XML with 2 CPUs, 4 GB, SCSI disk, E1000 on a bridged network" "$(python3 -c "
import sys, xml.etree.ElementTree as E; r=E.parse(sys.argv[1]).getroot(); x=E.tostring(r).decode()
print(all(s in x for s in ('>2</', '>4096</', '>lsilogic<', '>E1000<', 'bridged', 'streamOptimized')))" "$W"/*.ovf)" "True"
    (cd "$W" && tar -xf "$OVA" --wildcards '*.vmdk' && sed -E 's/^SHA256\((.*)\)= (.*)$/\2  \1/' *.mf | sha256sum -c --quiet && echo good) > "$W/mf.out" 2>&1
    t "  ... the checksums in the .mf match" "$(cat "$W/mf.out")" "good"
    t "  ... the disk is a streamOptimized VMDK of the same size" "$(qemu-img info --output=json "$W"/*.vmdk | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["format"], d["virtual-size"])')" "vmdk $(qemu-img info --output=json "$IMG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["virtual-size"])')"
    rm -f "$W"/*.vmdk
fi
if [ -n "$VHDX" ]; then
    t "VHDX (Hyper-V): readable, same size" "$(qemu-img info --output=json "$VHDX" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["format"], d["virtual-size"])')" "vhdx $(qemu-img info --output=json "$IMG" | python3 -c 'import json,sys; print(json.load(sys.stdin)["virtual-size"])')"
fi

# boot a throw-away copy (the image itself stays unused). Boot 1 is cut off from the internet (restrict=on): the first
# boot must set everything up offline. Boot 2 (normal network, also UDP back to the host) checks a restart and the rest.
qemu-img create -q -f qcow2 -F qcow2 -b "$(realpath "$IMG")" "$W/vm.qcow2"
ACCEL=tcg,thread=multi; [ -w /dev/kvm ] && ACCEL=kvm
boot() { # boot LOGFILE NETOPTS
    qemu-system-x86_64 -machine q35 -accel $ACCEL -cpu max -smp "$(nproc)" -m 4096 -nographic \
        -drive file="$W/vm.qcow2",if=virtio -netdev user,id=n0$2,hostfwd=tcp:127.0.0.1:$P_WEB-:8443,hostfwd=tcp:127.0.0.1:$P_SSH-:22,hostfwd=udp:127.0.0.1:$P_RAD-:1812 \
        -device e1000,netdev=n0 -serial file:"$1" -monitor unix:"$W/mon.sock",server=on,wait=off -display none </dev/null & QP=$!
}
boot "$W/serial.log" ",restrict=on"
echo "     boot 1 ($ACCEL, no internet) — first boot runs the installer inside the VM"
for _ in $(seq 1 540); do grep -aq "MikrotikLover is ready\|setup FAILED" "$W/serial.log" 2>/dev/null && break; sleep 10; done
t "first boot: the console says ready (E1000 card, DHCP, no internet)" "$(grep -ac 'MikrotikLover is ready' "$W/serial.log")" "1"
pass=$(grep -ao 'Dashboard first login: admin / [A-Za-z0-9]*' "$W/serial.log" | head -1 | awk '{print $NF}')
t "  ... and shows the first dashboard login" "$([ ${#pass} -ge 12 ] && echo yes)" "yes"
[ -n "$pass" ] || { tail -60 "$W/serial.log"; echo "$fails+ FAILED (VM did not get ready)"; exit 1; }

jar="$W/jar"
csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$pass\"}" "https://127.0.0.1:$P_WEB/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("csrf",""))' 2>/dev/null)
t "dashboard: login with the console's password" "$([ -n "$csrf" ] && echo yes)" "yes"
api() { curl -sk -b "$jar" -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" -X "$1" "https://127.0.0.1:$P_WEB$2" ${3:+-d "$3"}; }
t "  ... a wrong password is refused" "$(curl -sk -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"username":"admin","password":"mikrotiklover"}' "https://127.0.0.1:$P_WEB/api/login")" "401"
t "  ... the certificate is this VM's own CA (made at first boot)" "$(echo | openssl s_client -connect 127.0.0.1:$P_WEB 2>/dev/null | openssl x509 -noout -issuer 2>/dev/null | grep -c 'MikrotikLover')" "1"

# boot 2: a normal restart — the power button (ACPI), the VM shuts itself down
python3 -c 'import socket,sys,time; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); time.sleep(1); s.sendall(b"system_powerdown\n"); time.sleep(1)' "$W/mon.sock"
for _ in $(seq 1 60); do kill -0 "$QP" 2>/dev/null || break; sleep 5; done
t "power button: the VM shuts down cleanly" "$(kill -0 "$QP" 2>/dev/null && echo still-running || echo off)" "off"
kill "$QP" 2>/dev/null; wait "$QP" 2>/dev/null; QP=""; rm -f "$W/mon.sock"
boot "$W/serial2.log" ""
for _ in $(seq 1 120); do [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:$P_WEB/")" = 200 ] && break; sleep 10; done
t "boot 2: back up, first boot setup not run again" "$(grep -ac 'first boot setup started' "$W/serial2.log") $(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$P_WEB/")" "0 200"
csrf=$(curl -sk -c "$jar" -H 'Content-Type: application/json' -d "{\"username\":\"admin\",\"password\":\"$pass\"}" "https://127.0.0.1:$P_WEB/api/login" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("csrf",""))' 2>/dev/null)
t "  ... the same dashboard login still works" "$([ -n "$csrf" ] && echo yes)" "yes"

# a router: added on the dashboard (from the host, seen as 10.0.2.2 inside), then a RADIUS login from it
api POST /api/nas '{"ip":"10.0.2.2","secret":"VmTestSecret2026","name":"vmtest"}' > "$W/nas.json"
api POST /api/users '{"name":"vmuser","password":"VmUser-Pass-1"}' > "$W/user.json"
sleep 8
t "RADIUS: router added on the dashboard, user logs in (Access-Accept)" "$(echo 'User-Name=vmuser,User-Password=VmUser-Pass-1' | radclient -t 5 -r 3 127.0.0.1:$P_RAD auth VmTestSecret2026 2>&1 | grep -m1 -c 'Access-Accept')" "1"
t "  ... a wrong password: Access-Reject" "$(echo 'User-Name=vmuser,User-Password=wrong' | radclient -t 5 -r 3 127.0.0.1:$P_RAD auth VmTestSecret2026 2>&1 | grep -m1 -c 'Access-Reject')" "1"

# SSH: own host keys, the console user must change the default password, then root work through sudo
t "SSH: host keys made at first boot (ed25519)" "$(ssh-keyscan -p $P_SSH -t ed25519 127.0.0.1 2>/dev/null | grep -c ssh-ed25519)" "1"
python3 "$HERE/vmssh.py" $P_SSH mladmin mikrotiklover 'Vm-New-Pass-2026x' "radius-admin netip show" "radius-admin doctor" "cat /var/lib/mikrotiklover/firstboot.done" "systemctl is-enabled mikrotiklover-firstboot" "ls /etc/cloud/cloud-init.disabled" "/opt/mikrotiklover/venv/bin/python -c 'import anthropic, google.genai; print(\"sdk ok\")'" > "$W/ssh.out" 2>&1
sed 's/^/     | /' "$W/ssh.out" | head -80
t "  ... the default password must be changed at the first login" "$(grep -c '^CHANGED' "$W/ssh.out")" "1"
t "  ... netip shows the card and its DHCP address" "$(grep -c 'Set by   : DHCP' "$W/ssh.out") $(grep -cE 'Address  : 10\.0\.2\.' "$W/ssh.out")" "1 1"
t "  ... health check: FreeRADIUS, database, dashboard all green" "$(grep -A40 '^--- 1' "$W/ssh.out" | grep -E '✔.*(FreeRADIUS \(logins\): running|Database \(MariaDB\): answering|Dashboard \(web \+ nginx\): running)' | wc -l)" "3"
t "  ... first boot marked done, cloud-init off, AI SDKs there" "$(grep -A1 '^--- 2' "$W/ssh.out" | grep -c '^20') $(grep -c '/etc/cloud/cloud-init.disabled' "$W/ssh.out") $(grep -c '^sdk ok' "$W/ssh.out")" "1 1 1"
t "no build proxy left in the image" "$(grep -ac 'ml-build-proxy\|10.0.2.2:42089' "$W/serial.log" "$W/serial2.log" | awk -F: '{s+=$2} END {print s}')" "0"
[ "$fails" = 0 ] && echo "all VM image tests passed" || { echo "$fails FAILED"; exit 1; }
