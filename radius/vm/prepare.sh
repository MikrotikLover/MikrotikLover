#!/usr/bin/env bash
# Runs INSIDE the VM while the image is built (build-image.sh starts it by cloud-init): every package, the code, the
# first-boot service, the console user; then the machine is wiped of anything that must be unique per VM and powered off.
set -euo pipefail
exec > >(tee -a /dev/ttyS0 /var/log/mikrotiklover-build.log) 2>&1
echo "ML-BUILD: start $(date -Is)"
trap 'echo "ML-BUILD-FAILED at line $LINENO"' ERR
export DEBIAN_FRONTEND=noninteractive
echo 'DPkg::Lock::Timeout "900";' > /etc/apt/apt.conf.d/90-ml-lock-wait     # the image's own apt timers may hold the lock
systemctl stop apt-daily.timer apt-daily-upgrade.timer unattended-upgrades 2>/dev/null || true
install -d -m 755 /opt/mikrotiklover
tar -xf /dev/vdb -C /opt/mikrotiklover                 # the code (second disk: a plain tar)
cd /opt/mikrotiklover/radius

# kernel drivers for VMware / VirtualBox / Hyper-V disks and network cards (the cloud kernel has only some of them)
apt-get update -qq
apt-get -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade >/dev/null   # this month's Ubuntu fixes inside
for m in e1000 e1000e vmxnet3 vmw_pvscsi ahci mptspi hv_netvsc hv_storvsc; do
    modinfo -n $m >/dev/null 2>&1 || { echo "ML-BUILD: $m missing in this kernel: adding linux-image-generic"
        apt-get install -y -qq linux-image-generic >/dev/null || echo "ML-BUILD: linux-image-generic not installed"; break; }
done
ML_PREPARE_ONLY=1 ./install.sh
for p in qemu-guest-agent open-vm-tools; do      # Proxmox / VMware see the VM's address and can shut it down
    apt-get install -y -qq $p >/dev/null 2>&1 || echo "ML-BUILD: guest tools $p not installed"
done

install -m 755 vm/firstboot.sh /usr/local/sbin/mikrotiklover-firstboot
install -m 644 vm/mikrotiklover-firstboot.service vm/mikrotiklover-firstkeys.service /etc/systemd/system/
systemctl enable mikrotiklover-firstboot.service mikrotiklover-firstkeys.service

# console / SSH user: the password must be changed at the first login
id mladmin >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo,adm mladmin
echo 'mladmin:mikrotiklover' | chpasswd
chage -d 0 mladmin
rm -f /etc/ssh/sshd_config.d/60-cloudimg-settings.conf
printf 'PasswordAuthentication yes\nKbdInteractiveAuthentication yes\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/60-mikrotiklover.conf

# network: DHCP on the first wired card, whatever its name (radius-admin netip static … for a fixed address)
rm -f /etc/netplan/50-cloud-init.yaml
cat > /etc/netplan/50-mikrotiklover.yaml <<'NP'
# Managed by radius-admin netip (DHCP until 'radius-admin netip static' is run)
network:
  version: 2
  ethernets:
    wired:
      match:
        name: "e*"
      dhcp4: true
      optional: true
NP
chmod 600 /etc/netplan/50-mikrotiklover.yaml
touch /etc/cloud/cloud-init.disabled                    # no cloud: the VM sets itself up (mikrotiklover-firstboot)
hostnamectl set-hostname mikrotiklover 2>/dev/null || echo mikrotiklover > /etc/hostname
sed -i 's/^127.0.1.1.*/127.0.1.1 mikrotiklover/' /etc/hosts; grep -q '^127.0.1.1' /etc/hosts || echo '127.0.1.1 mikrotiklover' >> /etc/hosts
printf '\n  MikrotikLover RADIUS: first boot setup will start in a moment...\n\n' > /etc/issue.d/mikrotiklover.issue 2>/dev/null \
    || { install -d /etc/issue.d; printf '\n  MikrotikLover RADIUS: first boot setup will start in a moment...\n\n' > /etc/issue.d/mikrotiklover.issue; }
# the GRUB menu and the kernel also on the serial console (Proxmox / headless)
sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0,115200"/' /etc/default/grub 2>/dev/null || true
[ -f /etc/default/grub.d/50-cloudimg-settings.cfg ] && sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0,115200"/' /etc/default/grub.d/50-cloudimg-settings.cfg
update-grub >/dev/null 2>&1 || true

echo "ML-BUILD: drivers: $(for m in virtio_net virtio_blk e1000 e1000e vmxnet3 vmw_pvscsi ahci mptspi hv_netvsc hv_storvsc; do modinfo -n $m >/dev/null 2>&1 && printf '%s ' $m || printf '%s(missing) ' $m; done)"
echo "ML-BUILD: packages: $(dpkg -l freeradius mariadb-server nginx python3-flask 2>/dev/null | awk '/^ii/{printf "%s ", $2}') venv: $(/opt/mikrotiklover/venv/bin/python -c 'import anthropic, google.genai; print("ok")' 2>&1 | tail -1)"

# nothing that must differ per VM: machine id, SSH keys, logs, the build's proxy
rm -f /etc/apt/apt.conf.d/90-ml-build-proxy /usr/local/share/ca-certificates/ml-build-ca.crt /etc/pip.conf
update-ca-certificates >/dev/null 2>&1 || true
apt-get clean
rm -f /etc/ssh/ssh_host_*
truncate -s 0 /etc/machine-id; rm -f /var/lib/dbus/machine-id
cloud-init clean --logs >/dev/null 2>&1 || true
rm -rf /var/log/journal/* /root/.bash_history /home/*/.bash_history /tmp/* /var/tmp/*
find /var/log -type f -name '*.log' ! -name 'mikrotiklover-build.log' -exec truncate -s 0 {} +
fstrim -av >/dev/null 2>&1 || true
echo "ML-BUILD-OK $(date -Is)"
sync
systemctl poweroff
