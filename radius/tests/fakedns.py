#!/usr/bin/env python3
"""A tiny DNS server for tests: answers A / MX / TXT / PTR from a JSON file, 'no such name' otherwise.
  fakedns.py PORT RECORDS.json      records: {"name TYPE": [answers]}  (MX answers: [pref, "host"])"""
import json, socket, struct, sys

TYPES = {1: "A", 15: "MX", 16: "TXT", 12: "PTR"}


def enc(name):
    return b"".join(bytes([len(p)]) + p.encode() for p in name.rstrip(".").split(".") if p) + b"\0"


def answer(msg, rec):
    qid, _, qd = struct.unpack("!HHH", msg[:6])
    i, labels = 12, []
    while msg[i]:
        labels.append(msg[i + 1:i + 1 + msg[i]].decode())
        i += 1 + msg[i]
    qtype = struct.unpack("!H", msg[i + 1:i + 3])[0]
    question = msg[12:i + 5]
    name = ".".join(labels).lower()
    ans = rec.get(f"{name} {TYPES.get(qtype, '?')}")
    known = any(k.split()[0] == name for k in rec)
    body = b""
    for a in ans or []:
        if qtype == 1:
            rd = socket.inet_aton(a)
        elif qtype == 15:
            rd = struct.pack("!H", a[0]) + enc(a[1])
        elif qtype == 16:
            rd = b"".join(bytes([len(c)]) + c.encode() for c in [a[i:i + 255] for i in range(0, len(a), 255)])
        else:
            rd = enc(a)
        body += b"\xc0\x0c" + struct.pack("!HHIH", qtype, 1, 300, len(rd)) + rd
    rcode = 0 if (ans or known) else 3
    return struct.pack("!HHHHHH", qid, 0x8180 | rcode, 1, len(ans or []), 0, 0) + question + body


if __name__ == "__main__":
    port, rec = int(sys.argv[1]), {k.split()[0].lower() + " " + k.split()[1].upper(): v for k, v in json.load(open(sys.argv[2])).items()}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind(("127.0.0.1", port))
    while True:
        m, addr = s.recvfrom(4096)
        try:
            s.sendto(answer(m, rec), addr)
        except Exception:  # noqa: BLE001
            pass
