#!/usr/bin/env python3
"""Make TZSP packets like a MikroTik router (mangle sniff-tzsp) for the IPS tests."""
import socket, struct, sys


def csum(b):
    if len(b) % 2:
        b += b"\0"
    s = sum(struct.unpack(f"!{len(b) // 2}H", b))
    s = (s >> 16) + (s & 0xFFFF)
    return ~(s + (s >> 16)) & 0xFFFF


def tcp_frame(src, dst, sport, dport, flags=0x02, payload=b"", seq=1000):
    tcp = struct.pack("!HHIIBBHHH", sport, dport, seq, 0, 5 << 4, flags, 64240, 0, 0) + payload
    ph = socket.inet_aton(src) + socket.inet_aton(dst) + struct.pack("!BBH", 0, 6, len(tcp))
    tcp = tcp[:16] + struct.pack("!H", csum(ph + tcp)) + tcp[18:]
    ip = struct.pack("!BBHHHBBH4s4s", 0x45, 0, 20 + len(tcp), 1, 0, 64, 6, 0, socket.inet_aton(src), socket.inet_aton(dst))
    ip = ip[:10] + struct.pack("!H", csum(ip)) + ip[12:]
    return b"\x00\x11\x22\x33\x44\x55" + b"\x66\x77\x88\x99\xaa\xbb" + b"\x08\x00" + ip + tcp


def tzsp(frame, tags=b"\x01"):
    return struct.pack("!BBH", 1, 0, 1) + tags + frame


def send(frames, host="127.0.0.1", port=37008):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    for f in frames:
        s.sendto(tzsp(f), (host, port))


if __name__ == "__main__":   # tzspgen.py SRC DST DPORT COUNT
    src, dst, dport, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
    send([tcp_frame(src, dst, 40000 + i, dport, seq=1000 + i) for i in range(n)])
