#!/usr/bin/env python3
"""A fake SNMP v1/v2c device for the tests: answers GET / GETNEXT / GETBULK from a JSON file that is read again
on every request, so a test can change the device (UPS on battery, toner low, port down) while it runs.

  fakesnmp.py FILE.json [--bind 127.0.0.1] [--port 11171] [--community public]
  FILE.json: {"1.3.6.1.2.1.1.5.0": ["s", "name"], "...": ["i", 3], ["c64", n], ["c32", n], ["g", n], ["t", ticks], ["o", "1.3.6..."], ["x", "hex"]}
"""
import json
import os
import socket
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import snmp  # noqa: E402

T = {"s": snmp.OCTETS, "x": snmp.OCTETS, "i": snmp.INT, "c32": snmp.COUNTER32, "c64": snmp.COUNTER64, "g": snmp.GAUGE32,
     "t": snmp.TIMETICKS, "o": snmp.OID, "ip": snmp.IPADDR}


def load(path):
    d = json.load(open(path))
    out = {}
    for o, (t, v) in d.items():
        out[o] = (T[t], bytes.fromhex(v) if t == "x" else v.encode() if t == "s" else v)
    return out


def answer(m, data):
    keys = sorted(data, key=snmp.oid_key)
    vb, err, eidx = [], 0, 0

    def nxt(o):
        k = snmp.oid_key(o)
        for x in keys:
            if snmp.oid_key(x) > k:
                return x
        return None
    if m["pdu"] == snmp.GET:
        for i, (o, _, _) in enumerate(m["varbinds"], 1):
            if o in data:
                vb.append((o, *data[o]))
            elif m["version"] == 0:
                return [(o, snmp.NULL, None) for o, _, _ in m["varbinds"]], 2, i
            else:
                vb.append((o, snmp.NOSUCHOBJECT, None))
    elif m["pdu"] == snmp.GETNEXT:
        for i, (o, _, _) in enumerate(m["varbinds"], 1):
            n = nxt(o)
            if n is None:
                if m["version"] == 0:
                    return [(o, snmp.NULL, None) for o, _, _ in m["varbinds"]], 2, i
                vb.append((o, snmp.ENDOFMIB, None))
            else:
                vb.append((n, *data[n]))
    elif m["pdu"] == snmp.GETBULK:
        cur = [o for o, _, _ in m["varbinds"]]
        for _ in range(max(1, m["eidx"])):
            for j, o in enumerate(cur):
                n = nxt(o)
                if n is None:
                    vb.append((o, snmp.ENDOFMIB, None))
                else:
                    vb.append((n, *data[n]))
                    cur[j] = n
            if all(nxt(o) is None for o in cur):
                break
    return vb, err, eidx


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d  # noqa: E731
    path, comm = a[0], opt("--community", "public").encode()
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.bind((opt("--bind", "127.0.0.1"), int(opt("--port", "11171"))))
    while True:
        data, addr = s.recvfrom(65535)
        try:
            m = snmp.parse(data)
        except ValueError:
            continue
        if m["community"] != comm or m["pdu"] not in (snmp.GET, snmp.GETNEXT, snmp.GETBULK):
            continue
        if os.path.exists(path + ".silent"):          # the test pulls the plug
            continue
        try:
            vb, err, eidx = answer(m, load(path))
        except (OSError, ValueError):
            continue
        s.sendto(snmp.build(m["version"], m["community"], snmp.RESPONSE, m["reqid"], vb, err, eidx), addr)


if __name__ == "__main__":
    main()
