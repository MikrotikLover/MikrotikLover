#!/usr/bin/env bash
# Ready VM image of MikrotikLover RADIUS: Ubuntu 24.04 LTS + every package + this code + first-boot setup.
# Import it in Proxmox / KVM (qcow2), VMware or VirtualBox (ova), Hyper-V (vhdx) and start it: the first boot makes
# this VM's own passwords and certificates, the console shows the dashboard address and the first login.
#
#   sudo radius/vm/build-image.sh [--out DIR] [--formats qcow2,ova,vhdx] [--size 20G] [--proxy http://HOST:PORT] [--ca FILE]
#   (--proxy: a company web proxy for the build; --ca: its certificate, when it looks inside HTTPS)
#
# Needs (Ubuntu / Debian): apt install qemu-utils qemu-system-x86 cloud-image-utils
# With KVM (/dev/kvm) the build takes ~10 minutes; without it (nested, CI) about an hour. Internet is needed for the
# build only (Ubuntu image + packages); the finished VM installs itself without internet.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
OUT=$PWD/vm-image FORMATS=qcow2,ova,vhdx SIZE=20G PROXY="" CA="" MEM=4096 CPUS=$(nproc 2>/dev/null || echo 2) TIMEOUT=${TIMEOUT:-7200}
UBU=https://cloud-images.ubuntu.com/noble/current IMG=noble-server-cloudimg-amd64.img

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
while [ $# -gt 0 ]; do
    case $1 in
        --out) OUT=$2; shift 2 ;;
        --formats) FORMATS=$2; shift 2 ;;
        --size) SIZE=$2; shift 2 ;;
        --proxy) PROXY=$2; shift 2 ;;
        --ca) CA=$2; shift 2 ;;
        --mem) MEM=$2; shift 2 ;;
        *) sed -n '2,12p' "$0"; exit 1 ;;
    esac
done
[[ $FORMATS =~ ^(qcow2|ova|vhdx)(,(qcow2|ova|vhdx))*$ ]] || die "--formats: qcow2,ova,vhdx"
[[ $SIZE =~ ^[0-9]+G$ ]] && [ "${SIZE%G}" -ge 10 ] || die "--size: 10G or more"
[ -z "$PROXY" ] || [[ $PROXY =~ ^https?://[A-Za-z0-9.-]+:[0-9]+/?$ ]] || die "--proxy: http://HOST:PORT"
[ -z "$CA" ] || [ -f "$CA" ] || die "--ca: file not found"
for c in qemu-img qemu-system-x86_64 cloud-localds curl sha256sum; do command -v $c >/dev/null || die "$c missing: apt install qemu-utils qemu-system-x86 cloud-image-utils curl"; done
VER=$(git -C "$ROOT" describe --always --dirty 2>/dev/null || date +%Y%m%d)
NAME=mikrotiklover-radius-$(date +%Y%m%d)-$VER
mkdir -p "$OUT/cache"; W=$(mktemp -d "$OUT/build.XXXX"); trap 'rm -rf "$W"' EXIT

# 1. Ubuntu's cloud image, checked against Ubuntu's checksum list
say "Ubuntu 24.04 cloud image"
curl -fsSL "$UBU/SHA256SUMS" -o "$W/SHA256SUMS"
want=$(awk -v f="*$IMG" '$2==f || $2==substr(f,2){print $1}' "$W/SHA256SUMS")
[ -n "$want" ] || die "no checksum for $IMG"
if [ ! -f "$OUT/cache/$IMG" ] || [ "$(sha256sum "$OUT/cache/$IMG" | cut -d' ' -f1)" != "$want" ]; then
    curl -fL --progress-bar "$UBU/$IMG" -o "$OUT/cache/$IMG.part" && mv "$OUT/cache/$IMG.part" "$OUT/cache/$IMG"
fi
[ "$(sha256sum "$OUT/cache/$IMG" | cut -d' ' -f1)" = "$want" ] || die "checksum mismatch for $IMG"
qemu-img convert -O qcow2 "$OUT/cache/$IMG" "$W/disk.qcow2"
qemu-img resize -q "$W/disk.qcow2" "$SIZE"

# 2. the code as a plain tar on a second disk (no network share needed), the build steps by cloud-init
tar -C "$ROOT" --exclude=.git --exclude='radius/vm-image' -cf "$W/code.tar" radius
truncate -s %1M "$W/code.tar"
{
    echo "#cloud-config"
    echo "hostname: mikrotiklover"
    [ -z "$PROXY$CA" ] || echo "write_files:"
    if [ -n "$PROXY" ]; then
        echo "  - path: /etc/apt/apt.conf.d/90-ml-build-proxy"
        printf '    content: |\n      Acquire::http::Proxy "%s";\n      Acquire::https::Proxy "%s";\n' "$PROXY" "$PROXY"
        echo "  - path: /etc/pip.conf"
        printf '    content: |\n      [global]\n      proxy = %s\n' "$PROXY"
    fi
    if [ -n "$CA" ]; then
        echo "  - path: /usr/local/share/ca-certificates/ml-build-ca.crt"
        echo "    encoding: b64"
        echo "    content: $(base64 -w0 "$CA")"
    fi
    echo "runcmd:"
    [ -z "$CA" ] || echo "  - [update-ca-certificates]"
    echo "  - [bash, -c, 'mkdir -p /tmp/ml && tar -xf /dev/vdb -C /tmp/ml radius/vm/prepare.sh && ${PROXY:+https_proxy=$PROXY http_proxy=$PROXY }PIP_CERT=/etc/ssl/certs/ca-certificates.crt bash /tmp/ml/radius/vm/prepare.sh || { echo ML-BUILD-FAILED > /dev/ttyS0; systemctl poweroff; }']"
} > "$W/user-data"
printf 'instance-id: ml-build\nlocal-hostname: mikrotiklover\n' > "$W/meta-data"
cloud-localds "$W/seed.img" "$W/user-data" "$W/meta-data"

# 3. boot it; prepare.sh installs everything and powers the VM off
ACCEL=tcg,thread=multi; [ -w /dev/kvm ] && ACCEL=kvm
say "Building inside the VM ($ACCEL, log: $W/serial.log) — $([ "$ACCEL" = kvm ] && echo '~10 minutes' || echo 'no KVM: about an hour')"
qemu-system-x86_64 -machine q35 -accel $ACCEL -cpu max -smp "$CPUS" -m "$MEM" -nographic -no-reboot \
    -drive file="$W/disk.qcow2",if=virtio,discard=unmap,detect-zeroes=unmap \
    -drive file="$W/code.tar",if=virtio,format=raw,readonly=on \
    -drive file="$W/seed.img",if=virtio,format=raw \
    -netdev user,id=n0 -device virtio-net-pci,netdev=n0 \
    -serial file:"$W/serial.log" -monitor none -display none </dev/null & QP=$!
trap 'kill $QP 2>/dev/null || true; rm -rf "$W"' EXIT
start=$(date +%s)
while kill -0 $QP 2>/dev/null; do              # the VM powers itself off; a failed step says so on the serial line
    grep -aq "ML-BUILD-FAILED" "$W/serial.log" 2>/dev/null && { sleep 20; kill $QP 2>/dev/null; break; }
    [ $(( $(date +%s) - start )) -lt "$TIMEOUT" ] || { kill $QP; echo "timed out after $TIMEOUT s"; break; }
    sleep 10
done
wait $QP 2>/dev/null || true
grep -a "ML-BUILD:" "$W/serial.log" | sed 's/^/   /' || true
grep -aq "ML-BUILD-OK" "$W/serial.log" || { tail -40 "$W/serial.log"; die "the build inside the VM did not finish (serial log above)"; }
cp "$W/serial.log" "$OUT/$NAME.build.log"

# 4. the formats
say "Writing the images to $OUT"
for f in ${FORMATS//,/ }; do
    case $f in
    qcow2) qemu-img convert -c -O qcow2 "$W/disk.qcow2" "$OUT/$NAME.qcow2" ;;
    vhdx)  qemu-img convert -O vhdx -o subformat=dynamic "$W/disk.qcow2" "$OUT/$NAME.vhdx" ;;
    ova)
        qemu-img convert -O vmdk -o subformat=streamOptimized "$W/disk.qcow2" "$W/$NAME-disk1.vmdk"
        python3 "$HERE/ovf.py" "$NAME" "$W/$NAME-disk1.vmdk" "$(qemu-img info --output=json "$W/disk.qcow2" | python3 -c 'import json,sys; print(json.load(sys.stdin)["virtual-size"])')" > "$W/$NAME.ovf"
        (cd "$W" && sha256sum "$NAME.ovf" "$NAME-disk1.vmdk" | sed -E 's/^([0-9a-f]+)  (.*)$/SHA256(\2)= \1/' > "$NAME.mf")
        tar -C "$W" --format=ustar -cf "$OUT/$NAME.ova" "$NAME.ovf" "$NAME.mf" "$NAME-disk1.vmdk"
        rm -f "$W/$NAME-disk1.vmdk" ;;
    esac
done
(cd "$OUT" && sha256sum $(ls $NAME.qcow2 $NAME.ova $NAME.vhdx 2>/dev/null) > "$NAME.sha256.tmp" && mv "$NAME.sha256.tmp" "$NAME.sha256")
ls -lh "$OUT"/$NAME.* | awk '{print "   " $5 "  " $9}'
say "Done. Start the VM (2 CPUs, 2-4 GB RAM, bridged network); the console shows the dashboard address and the first login."
