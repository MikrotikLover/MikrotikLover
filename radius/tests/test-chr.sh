#!/usr/bin/env bash
# CHR test: every router script imported on a real RouterOS — MikroTik's Cloud Hosted Router (CHR) in QEMU.
#
#   tests/test-chr.sh [--ros 7|6] [--version 7.25] [--cache DIR] [--sync FILE] [--keep]
#
#   --ros 7       RouterOS 7 (default: newest stable)      --ros 6   RouterOS 6 (newest long-term), v6 copies
#   --version V   a fixed RouterOS version instead of the newest
#   --cache DIR   where the CHR image is kept (default ~/.cache/mikrotiklover-chr)
#   --sync FILE   also import this sync.rsc (the server's router rules: /var/lib/mikrotiklover/router/sync.rsc)
#   --keep        leave the CHR running at the end (ssh -p 2222 admin@127.0.0.1, empty password)
#
# What it does: downloads the CHR image (+ the 'wireless' package, so the old-wireless scripts are tested
# too) from download.mikrotik.com, boots a fresh copy (KVM when there is /dev/kvm, else slow emulation),
# sets it up like a home router (bridge, LAN/WAN lists, DHCP), then imports in order:
#   - every mikrotik/*.rsc, placeholders filled (RouterOS 6: the v6 copy the server makes);
#   - what the dashboard's Router setup makes for several sets of parts (imported twice: must update cleanly);
#   - Passpoint (Hotspot 2.0) with real settings — and checks what the router then holds.
# A line RouterOS cannot run stops the import with an error: that is a FAIL here.
# CHR has no Wi-Fi radio: the Wi-Fi menus are set up, the per-radio lines run on no radio.
# Needs: qemu-system-x86, sshpass, unzip, curl.     Exit 0 = all passed.
# Without those tools or without download.mikrotik.com it says "skipped" and exits 0 (the full suite runs it too);
# CHR_REQUIRED=1 makes that an error (exit 2).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROS=7 VER="" CACHE=${HOME:-/root}/.cache/mikrotiklover-chr SYNC="" KEEP=0 PORT=${CHR_SSH_PORT:-2222}
while [ $# -gt 0 ]; do
    case $1 in
    --ros) ROS=${2:-}; shift ;; --version) VER=${2:-}; shift ;; --cache) CACHE=${2:-}; shift ;;
    --sync) SYNC=${2:-}; shift ;; --keep) KEEP=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
    esac; shift
done
[[ $ROS =~ ^[67]$ ]] || { echo "--ros 6 or 7" >&2; exit 2; }
skip() { # nothing to test with here: a skip, or an error with CHR_REQUIRED=1
    echo "$1" >&2
    [ "${CHR_REQUIRED:-0}" = 1 ] && exit 2
    echo "skip: CHR test not run ($1)"; echo "all CHR tests passed (skipped)"; exit 0
}
for t in qemu-system-x86_64 sshpass unzip curl python3; do
    command -v $t >/dev/null || skip "missing $t (apt install qemu-system-x86 sshpass unzip curl)"
done

PASS=0 FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
note() { printf '  ---- %s\n' "$*"; }

# ---------------------------------------------------------------- image
DL=https://download.mikrotik.com/routeros
if [ -z "$VER" ]; then
    VER=$(curl -fsS -m 30 "$DL/$([ "$ROS" = 7 ] && echo NEWESTa7.stable || echo NEWEST6.long-term)" | awk '{print $1}')
    [[ $VER =~ ^[67]\.[0-9.]+$ ]] || skip "could not find the newest RouterOS $ROS version (download.mikrotik.com reachable?)"
fi
[ "${VER%%.*}" = "$ROS" ] || { echo "--version $VER is not RouterOS $ROS" >&2; exit 2; }
mkdir -p "$CACHE"
IMG=$CACHE/chr-$VER.img PKGZIP=$CACHE/all_packages-x86-$VER.zip
if [ ! -s "$IMG" ]; then
    echo "Downloading CHR $VER ..."
    curl -fsS -m 600 -o "$IMG.zip" "$DL/$VER/chr-$VER.img.zip" && unzip -o -q "$IMG.zip" -d "$CACHE" && rm -f "$IMG.zip" \
        || { rm -f "$IMG.zip"; skip "CHR image download failed (download.mikrotik.com reachable?)"; }
fi
[ -s "$PKGZIP" ] || curl -fsS -m 300 -o "$PKGZIP" "$DL/$VER/all_packages-x86-$VER.zip" || rm -f "$PKGZIP"

WORK=$(mktemp -d /tmp/mlchr.XXXXXX)
QPID=""
cleanup() {
    if [ "$KEEP" = 1 ] && [ -n "$QPID" ]; then echo "CHR left running (pid $QPID): ssh -p $PORT admin@127.0.0.1"; return; fi
    [ -n "$QPID" ] && kill "$QPID" 2>/dev/null; rm -rf "$WORK"
}
trap cleanup EXIT
cp "$IMG" "$WORK/chr.img"
# one SSH connection for every command: security.rsc (imported here too) bans an address that opens
# 4 new SSH connections a minute from the WAN side — it would ban this test
SSHO=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=30 -o ServerAliveInterval=15
      -o ControlMaster=auto -o "ControlPath=$WORK/ssh-%r@%h:%p" -o ControlPersist=900)
ros() { # -n: never eat the caller's stdin; a busy (emulated) CHR may not answer SSH at once: try again
    local out i
    for i in 1 2 3 4; do
        out=$(sshpass -p '' ssh -n "${SSHO[@]}" -p "$PORT" admin@127.0.0.1 "$@" 2>&1 | tr -d '\r')
        grep -qE '^(Connection timed out|ssh: connect to host|Connection (reset|closed) by|kex_exchange_identification)' <<<"$out" || break
        sleep 15
    done
    printf '%s\n' "$out"
}
put()  { sshpass -p '' scp -O -q "${SSHO[@]}" -P "$PORT" "$@" admin@127.0.0.1:/ ; }
wait_up() {
    local i; for i in $(seq 1 90); do ros ':put ok' 2>/dev/null | grep -q '^ok' && return 0; sleep 5; done; return 1
}
boot() {
    local accel=tcg; [ -w /dev/kvm ] && accel=kvm
    # ether1 = WAN (QEMU NAT, SSH forwarded); ether2, ether3 = spare ports (PPPoE, server port) without a network
    qemu-system-x86_64 -m 1024 -smp 2 -accel $accel -drive "file=$WORK/chr.img,format=raw,if=virtio" \
        -nic "user,model=virtio,hostfwd=tcp:127.0.0.1:$PORT-:22" -nic user,model=virtio,restrict=on -nic user,model=virtio,restrict=on \
        -display none -daemonize -pidfile "$WORK/qemu.pid" \
        || { echo "QEMU did not start (port $PORT busy? CHR_SSH_PORT=...)" >&2; exit 2; }
    QPID=$(cat "$WORK/qemu.pid")
    wait_up || { echo "CHR did not come up" >&2; exit 2; }
}

echo "== CHR test: RouterOS $VER ($([ -w /dev/kvm ] && echo KVM || echo 'no KVM: slow emulation'))"
boot
note "booted: $(ros ':put [/system resource get version]')"

# the 'wireless' package: old-wireless scripts (and on RouterOS 6, every Wi-Fi script) need its menus
if [ -s "$PKGZIP" ] && unzip -o -q "$PKGZIP" "wireless*.npk" -d "$WORK" 2>/dev/null; then
    put "$WORK"/wireless*.npk && ros ':execute "/system reboot"' >/dev/null; sleep 20; wait_up || { echo "CHR did not come back after the package" >&2; exit 2; }
fi
ros '/system package print' | grep -q wireless && note "wireless package installed" || note "no wireless package: old-wireless scripts will fail"

# like a home router: LAN bridge, interface lists, DHCP server; ether1 = WAN (QEMU NAT)
SETUP=$(cat <<'RSC'
/interface bridge add name=bridge
/interface list add name=LAN
/interface list add name=WAN
/interface list member add list=LAN interface=bridge
/interface list member add list=WAN interface=ether1
/ip address add address=192.168.88.1/24 interface=bridge
/ip pool add name=dhcp ranges=192.168.88.10-192.168.88.254
/ip dhcp-server add name=defconf interface=bridge address-pool=dhcp disabled=no
/ip dhcp-server network add address=192.168.88.0/24 gateway=192.168.88.1 dns-server=192.168.88.1
:if ([:len [/ip dhcp-client find interface=ether1]] = 0) do={ /ip dhcp-client add interface=ether1 disabled=no }
RSC
)
printf '%s\n' "$SETUP" > "$WORK/00-base.rsc"; put "$WORK/00-base.rsc"

# ---------------------------------------------------------------- the scripts
GEN=$WORK/gen
python3 -I "$HERE/chr-scripts.py" "$GEN" --ros "$ROS" ${SYNC:+--sync "$SYNC"} || { bad "making the scripts"; exit 1; }
put "$GEN"/*.rsc
logerr() { ros ':put [:len [/log find where topics~"error" and topics~"script"]]' | tail -1; }
import_one() { # FILE -> 0 when RouterOS ran it to the end
    # RouterOS 7 says "executed successfully"; RouterOS 6 says nothing over SSH and puts the error in the log
    local out before after; before=$(logerr)
    out=$(ros "/import file-name=$1 verbose=no")
    if grep -q 'executed successfully' <<<"$out"; then return 0; fi
    after=$(logerr)
    if [ "$ROS" = 6 ] && [ -z "$(grep -v '^\s*$' <<<"$out")" ] && [ "$after" = "$before" ]; then return 0; fi
    printf '%s\n' "$out" | grep -v '^\s*$' | tail -3 | sed 's/^/         /'
    [ "$after" = "$before" ] || ros '/log print where topics~"error" and topics~"script"' | tail -$(( after - before > 3 ? 3 : after - before )) | sed 's/^/         /'
    return 1
}
import_one 00-base.rsc && ok "home-router base set up" || bad "home-router base"
while read -r f strict; do
    if import_one "$f"; then
        ok "$f"
        if [ "$strict" = 1 ]; then import_one "$f" && ok "$f (imported again: updates, no duplicates error)" || bad "$f imported again"; fi
    else
        bad "$f"
    fi
done < "$GEN/list.txt"

# ---------------------------------------------------------------- Passpoint: what the router holds now
pp_check() { # MENU -> the ml-passpoint profile as one line
    ros ":put [$1 get [find name=\"ml-passpoint\"]]"
}
if [ "$ROS" = 7 ]; then
    p=$(pp_check "/interface wifi interworking")
    for want in "domain-names=wifi.chrtest.example" "hotspot20=true" "realms=wifi.chrtest.example:not-specified" \
                "roaming-ois=5a03ba0000" "venue=industrial-factory" "operator-names=CHR Test Ltd:eng" "network-type=private"; do
        tr ';' '\n' <<<"$p" | grep -qxF "$want" && ok "wifi interworking: $want" || bad "wifi interworking: $want (got: ${p:0:300})"
    done
    c=$(ros ':put [/interface wifi configuration get [find name="cfg-passpoint"] interworking]')
    [ "$c" = ml-passpoint ] && ok "wifi configuration cfg-passpoint uses the Passpoint profile" || bad "cfg-passpoint interworking=$c"
    s=$(ros ':put [/interface wifi security get [find name="sec-passpoint"] authentication-types]')
    [ "$s" = wpa2-eap ] && ok "Passpoint security is WPA2-Enterprise" || bad "sec-passpoint authentication-types=$s"
    n=$(ros ':put [:len [/interface wifi interworking find name="ml-passpoint"]]')
    [ "$n" = 1 ] && ok "one Passpoint profile after several imports" || bad "$n Passpoint profiles (expected 1)"
fi
if ros '/system package print' | grep -q wireless; then
    p=$(pp_check "/interface wireless interworking-profiles")
    for want in "domain-names=wifi.chrtest.example" "hotspot20=true" "venue=industrial-factory"; do
        tr ';' '\n' <<<"$p" | grep -qxF "$want" && ok "wireless interworking-profile: $want" || bad "wireless interworking-profile: $want (got: ${p:0:300})"
    done
fi
r=$(ros ':put [:len [/radius find where comment="MikrotikLover RADIUS" and address=10.0.2.2]]')
[ "${r:-0}" -ge 1 ] && ok "RADIUS client entry present ($r)" || bad "no RADIUS entry"
e=$(ros '/log print where topics~"error"' | grep -vi 'dhcp\|ntp\|fetch\|login failure' | tail -5)
[ -z "$e" ] && ok "no script errors in the router log" || { note "router log errors:"; printf '%s\n' "$e" | sed 's/^/         /'; }

echo
echo "CHR $VER: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
