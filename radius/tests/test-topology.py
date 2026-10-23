#!/usr/bin/env python3
"""Offline tests for tools/topology.py (the whole-network tree) and the SNMP MAC table / LLDP reading."""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import snmp  # noqa: E402
import topology  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


M = lambda n: f"00-00-00-00-{n >> 8:02X}-{n & 255:02X}"  # noqa: E731
R = [{"ip": "10.0.0.1", "name": "hAP", "online": 5}]
D = [{"id": 1, "name": "core", "ip": "10.0.0.2", "kind": "switch", "status": "up", "macs": [M(0x101)], "ports": {"1": "Gi1", "2": "Gi2", "3": "Gi3", "5": "Gi5"}},
     {"id": 2, "name": "floor2", "ip": "10.0.0.3", "kind": "switch", "status": "up", "macs": [M(0x201)], "ports": {"1": "p1", "4": "p4"}},
     {"id": 3, "name": "AP-1", "ip": "10.0.0.4", "kind": "ap", "status": "up", "macs": [M(0x301)]},
     {"id": 4, "name": "printer", "ip": "10.0.0.9", "kind": "printer", "status": "up", "macs": [M(0x401)]}]
# core: Gi1 up to the router, Gi2 -> floor2 (+ its PCs), Gi3 -> AP-1 (+ Wi-Fi phone), Gi5 -> printer + an unknown box
F = [(1, 1, M(0xAA)), (1, 2, M(0x201)), (1, 2, M(0xB1)), (1, 2, M(0xB2)), (1, 3, M(0x301)), (1, 3, M(0xC1)), (1, 5, M(0x401)), (1, 5, M(0x99)),
     (2, 1, M(0x101)), (2, 1, M(0xAA)), (2, 1, M(0x301)), (2, 4, M(0xB1)), (2, 4, M(0xB2))]
P = [{"mac": M(0xB1), "name": "ali", "ip": "10.0.0.21", "kind": "user", "nas": "10.0.0.1"},
     {"mac": M(0xB2), "name": "sara", "ip": "10.0.0.22", "kind": "user", "nas": "10.0.0.1"},
     {"mac": M(0xC1), "name": "bilal", "ip": "10.0.0.23", "kind": "user", "nas": "10.0.0.1"},
     {"mac": M(0xDD), "name": "ghost", "ip": "10.0.0.24", "kind": "user", "nas": "10.0.0.1"},
     {"mac": M(0x401), "name": "AA-printer", "ip": "10.0.0.9", "kind": "mac", "nas": "10.0.0.1"}]
t = topology.build(R, D, F, [], P)
N = {n["id"]: n for n in t["nodes"]}
par = lambda i: (N[i]["parent"], N[i].get("port", ""))  # noqa: E731
check("router under the Internet, the core switch under the router (link guessed: the router is not an SNMP device)",
      par("r10.0.0.1") == ("internet", "") and N["d1"]["parent"] == "r10.0.0.1" and N["d1"].get("guess"), (par("r10.0.0.1"), N["d1"]))
check("second switch on the core's port Gi2 (the fewest MACs wins)", par("d2") == ("d1", "Gi2"), par("d2"))
check("AP and printer on their core ports", par("d3") == ("d1", "Gi3") and par("d4") == ("d1", "Gi5"), (par("d3"), par("d4")))
check("PCs on floor2's port p4 (nearest switch, not the core)", par(f"p{M(0xB1)}") == ("d2", "p4") and par(f"p{M(0xB2)}") == ("d2", "p4"))
check("Wi-Fi phone under the AP (seen on the AP's switch port)", par(f"p{M(0xC1)}") == ("d3", ""), par(f"p{M(0xC1)}"))
check("logged in but on no switch: under its router, counted", par(f"p{M(0xDD)}") == ("r10.0.0.1", "") and t["unplaced"] == 1)
check("a MAC device that is also an SNMP device: shown once (as the device)", f"p{M(0x401)}" not in N)
check("unknown MACs counted where they are: on the core (by the printer's port), not under the printer", N.get("u-d1", {}).get("count") == 2 and "u-d4" not in N,
      {k: v.get("count") for k, v in N.items() if k.startswith("u-")})

# the router is an SNMP device (MikroTik) and LLDP tells the links
D2 = D + [{"id": 9, "name": "hAP", "ip": "10.0.0.1", "kind": "mikrotik", "status": "up", "macs": [M(0xAA)], "ports": {"2": "ether2"}}]
L = [{"device_id": 9, "ifindex": 2, "name": "core", "ip": "10.0.0.2", "chassis": ""}, {"device_id": 1, "ifindex": 1, "name": "hAP", "ip": "", "chassis": M(0xAA)}]
t = topology.build(R, D2, F, L, P)
N = {n["id"]: n for n in t["nodes"]}
check("router = its SNMP device; core on the router's ether2 (LLDP), not guessed", "r10.0.0.1" not in N and N["d9"]["parent"] == "internet"
      and N["d1"]["parent"] == "d9" and N["d1"]["port"] == "ether2" and not N["d1"].get("guess"), (N.get("d9"), N.get("d1")))

# a loop in the cabling (two switches linked twice) does not hang or duplicate
F3 = F + [(2, 4, M(0x101)), (1, 3, M(0x201))]
t = topology.build(R, D, F3, [{"device_id": 1, "ifindex": 3, "name": "floor2", "ip": "10.0.0.3", "chassis": ""}], P)
ids = [n["id"] for n in t["nodes"]]
check("loop: every device once", len(ids) == len(set(ids)) and all(f"d{i}" in ids for i in (1, 2, 3, 4)))

# no switches at all (only logins): everybody under the router
t = topology.build(R, [], [], [], P[:3])
check("no SNMP switches: people under their router", all(n["parent"] == "r10.0.0.1" for n in t["nodes"] if n["type"] == "person") and t["unplaced"] == 3)
many = [{"mac": M(0x1000 + i), "name": f"u{i:03d}", "ip": "", "kind": "user", "nas": "10.0.0.1"} for i in range(80)]
t = topology.build(R, [], [], [], many, max_people=60)
check("80 people on one place: 60 shown + '20 more'", sum(1 for n in t["nodes"] if n["type"] == "person") == 60 and any(n["type"] == "more" and n["name"] == "20 more" for n in t["nodes"]))

# reading a switch's MAC table and LLDP over SNMP (fake switch)
check("MAC from bytes / text; broadcast, multicast and empty left out",
      [snmp.mac_of(b"\x00\x0c\x29\xab\xcd\xef"), snmp.mac_of("00:0c:29:ab:cd:ef"), snmp.mac_of(b"\xff" * 6), snmp.mac_of(b"\x01\x00\x5e\x00\x00\x01"), snmp.mac_of(b"\0" * 6)]
      == ["00-0C-29-AB-CD-EF", "00-0C-29-AB-CD-EF", "", "", ""])
d = tempfile.mkdtemp()
data = {"1.3.6.1.2.1.1.1.0": ["s", "JetStream"], "1.3.6.1.2.1.1.2.0": ["o", "1.3.6.1.4.1.11863.1"], "1.3.6.1.2.1.1.3.0": ["t", 1], "1.3.6.1.2.1.1.4.0": ["s", ""],
        "1.3.6.1.2.1.1.5.0": ["s", "sw"], "1.3.6.1.2.1.1.6.0": ["s", ""],
        "1.3.6.1.2.1.17.1.4.1.2.1": ["i", 49], "1.3.6.1.2.1.17.1.4.1.2.2": ["i", 50],                       # bridge port 1 -> ifIndex 49 ...
        "1.3.6.1.2.1.17.7.1.2.2.1.2.1.0.12.41.171.205.239": ["i", 1], "1.3.6.1.2.1.17.7.1.2.2.1.3.1.0.12.41.171.205.239": ["i", 3],
        "1.3.6.1.2.1.17.7.1.2.2.1.2.10.0.12.41.0.0.1": ["i", 2], "1.3.6.1.2.1.17.7.1.2.2.1.3.10.0.12.41.0.0.1": ["i", 3],
        "1.3.6.1.2.1.17.7.1.2.2.1.2.1.0.12.41.0.0.2": ["i", 2], "1.3.6.1.2.1.17.7.1.2.2.1.3.1.0.12.41.0.0.2": ["i", 4],   # own MAC (self)
        "1.0.8802.1.1.2.1.4.1.1.5.0.49.1": ["x", "0011223344aa"], "1.0.8802.1.1.2.1.4.1.1.7.0.49.1": ["s", "ether2"],
        "1.0.8802.1.1.2.1.4.1.1.9.0.49.1": ["s", "hAP-office"], "1.0.8802.1.1.2.1.4.2.1.3.0.49.1.1.4.192.168.88.1": ["i", 2],
        "1.3.6.1.2.1.2.2.1.6.49": ["x", "000c29000002"]}
json.dump(data, open(os.path.join(d, "sw.json"), "w"))
pr = subprocess.Popen([sys.executable, os.path.join(HERE, "fakesnmp.py"), os.path.join(d, "sw.json"), "--port", "11197"])
time.sleep(0.6)
try:
    b = snmp.bridge(snmp.Client("127.0.0.1", "public", "2c", 11197, timeout=1))
    check("MAC table (Q-BRIDGE): port -> ifIndex, VLAN kept, the switch's own MAC left out",
          sorted(b["fdb"]) == [("49", "00-0C-29-AB-CD-EF", 1), ("50", "00-0C-29-00-00-01", 10)], b["fdb"])
    check("LLDP: neighbour name, its port, chassis MAC, management IP, on our ifIndex 49",
          b["lldp"] == [{"ifindex": "49", "name": "hAP-office", "port": "ether2", "chassis": "00-11-22-33-44-AA", "ip": "192.168.88.1"}], b["lldp"])
    m = snmp.collect(snmp.Client("127.0.0.1", "public", "2c", 11197, timeout=1), "printer", topo=False)
    check("every device: its own MACs read (for the map)", m["macs"] == ["00-0C-29-00-00-02"] and "bridge" not in m, m.get("macs"))
finally:
    pr.kill()
print("all topology tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
