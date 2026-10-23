#!/usr/bin/env python3
"""Router traffic copy -> a network card Suricata can read.

MikroTik routers send a copy of packets as TZSP (mangle action=sniff-tzsp, UDP 37008). This takes the
Ethernet frame out of each TZSP packet and writes it to a TAP interface (mltap0); Suricata listens there.
Only routers on private networks / the NAS list may send. Every 10 s a small status file is written for
the dashboard (/run/mikrotiklover/tzsp.json).

  tzsp2tap.py [--port 37008] [--tap mltap0]
"""
import argparse, fcntl, ipaddress, json, os, socket, struct, subprocess, sys, time

TUNSETIFF, IFF_TAP, IFF_NO_PI = 0x400454CA, 0x0002, 0x1000
STATUS = "/run/mikrotiklover/tzsp.json"
ALLOWED = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]


def frame(data):
    """TZSP packet -> Ethernet frame, or None (other version / encapsulation, broken tags)."""
    if len(data) < 5 or data[0] != 1 or struct.unpack("!H", data[2:4])[0] != 1:   # version 1, Ethernet
        return None
    if data[1] not in (0, 1):                     # received / transmitted tag list (not keepalive / config)
        return None
    i = 4
    while i < len(data):
        tag = data[i]
        if tag == 1:                              # end of the tags
            return data[i + 1:] or None
        if tag == 0:                              # padding
            i += 1
            continue
        if i + 1 >= len(data):
            return None
        i += 2 + data[i + 1]
    return None


def open_tap(name):
    fd = os.open("/dev/net/tun", os.O_RDWR)
    fcntl.ioctl(fd, TUNSETIFF, struct.pack("16sH", name.encode(), IFF_TAP | IFF_NO_PI))
    subprocess.run(["ip", "link", "set", name, "up", "promisc", "on", "mtu", "9000"], check=False)
    return fd


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=37008)
    ap.add_argument("--tap", default="mltap0")
    ap.add_argument("--allow", default=",".join(ALLOWED), help="networks that may send (comma separated)")
    a = ap.parse_args(argv)
    nets = [ipaddress.ip_network(n.strip(), strict=False) for n in a.allow.split(",") if n.strip()]
    fd = open_tap(a.tap)
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 8 << 20)
    sock.bind(("0.0.0.0", a.port))
    sock.settimeout(1.0)
    os.makedirs(os.path.dirname(STATUS), exist_ok=True)
    stats = {"packets": 0, "bytes": 0, "dropped": 0, "refused": 0, "routers": {}, "started": time.time(), "tap": a.tap, "port": a.port}
    last = 0.0
    while True:
        try:
            data, (src, _) = sock.recvfrom(65535)
            if not any(ipaddress.ip_address(src) in n for n in nets):
                stats["refused"] += 1
            else:
                f = frame(data)
                if f is None:
                    stats["dropped"] += 1
                else:
                    try:
                        os.write(fd, f)
                        stats["packets"] += 1
                        stats["bytes"] += len(f)
                        stats["routers"][src] = time.time()
                    except OSError:
                        stats["dropped"] += 1
        except socket.timeout:
            pass
        now = time.time()
        if now - last >= 10:
            last = now
            stats["at"] = now
            try:
                with open(STATUS + ".tmp", "w") as fh:
                    json.dump(stats, fh)
                os.replace(STATUS + ".tmp", STATUS)
            except OSError as e:
                print(f"status: {e}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
