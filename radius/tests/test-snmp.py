#!/usr/bin/env python3
"""Offline tests for tools/snmp.py: the wire format, a fake device (get / walk / v1 / bulk), traps in plain words,
events (UPS on battery, printer, CPU, ports, restart), counters, device kinds, v3 output parsing, finding devices."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import snmp  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


# ---- wire format
for o in ("1.3.6.1.2.1.1.1.0", "1.3.6.1.4.1.14988.1.1.3.100.1.3.7101", "2.999.3", "1.3.6.1.4.1.318.0.5", "1.3.6.1.2.1.31.1.1.1.6.4294967295"):
    check(f"OID round trip {o}", snmp.dec_oid(snmp.enc_oid(o)[2:]) == o, snmp.dec_oid(snmp.enc_oid(o)[2:]))
msg = snmp.build(1, "pub", snmp.GET, 1234, [("1.3.6.1.2.1.1.5.0", snmp.OCTETS, b"name"), ("1.3.6.1.2.1.1.3.0", snmp.TIMETICKS, 2**32 - 1),
                                            ("1.3.6.1.2.1.31.1.1.1.6.1", snmp.COUNTER64, 2**64 - 1), ("1.3.6.1.2.1.2.2.1.1.1", snmp.INT, -5),
                                            ("1.3.6.1.2.1.4.20.1.1.10", snmp.IPADDR, "10.1.2.3"), ("1.3.6.1.2.1.1.2.0", snmp.OID, "1.3.6.1.4.1.14988.1")])
m = snmp.parse(msg)
check("message round trip: version, community, request id, every value type (64-bit counter, negative, IP, OID)",
      (m["version"], m["community"], m["reqid"]) == (1, b"pub", 1234) and [v for _, _, v in m["varbinds"]] ==
      [b"name", 2**32 - 1, 2**64 - 1, -5, "10.1.2.3", "1.3.6.1.4.1.14988.1"], m)
check("matches net-snmp's bytes for a simple GET (same encoding as the reference)",
      snmp.build(1, "public", snmp.GET, 1, [("1.3.6.1.2.1.1.5.0", snmp.NULL, None)]).hex() ==
      "302602010104067075626c6963a019020101020100020100300e300c06082b060102010105000500")
bad = [b"", b"\x30\x05\x02\x01", b"\x30\x84\xff\xff\xff\xff", b"\x30\x03\x02\x01\x03", msg[:-3], b"\x04\x02ab", os.urandom(200)]
res = []
for b in bad:
    try:
        snmp.parse(b)
        res.append("parsed")
    except ValueError:
        res.append("refused")
check("broken / short / v3 / random packets are refused (no crash)", res == ["refused"] * len(bad), res)
t1 = snmp.build_trap1("public", "1.3.6.1.4.1.318", "192.168.88.5", 6, 5, 12345, [("1.3.6.1.4.1.318.2.3.3.0", snmp.OCTETS, b"UPS: On battery power")])
m1 = snmp.parse(t1)
check("v1 trap read: enterprise, agent address, generic / specific", (m1["enterprise"], m1["agent"], m1["generic"], m1["specific"], m1["ticks"]) ==
      ("1.3.6.1.4.1.318", "192.168.88.5", 6, 5, 12345), m1)

# ---- traps in plain words
w = snmp.trap_words(m1)
check("APC v1 trap 5 -> 'UPS ON BATTERY', high", (w["severity"], w["words"].startswith("UPS ON BATTERY")) == ("high", True), w)
v2 = lambda oid, *vb: {"pdu": snmp.TRAP2, "varbinds": [("1.3.6.1.2.1.1.3.0", snmp.TIMETICKS, 5), (snmp.TRAP_OID, snmp.OID, oid), *vb]}  # noqa: E731
w = snmp.trap_words(v2("1.3.6.1.6.3.1.1.5.3", ("1.3.6.1.2.1.2.2.1.1.7", snmp.INT, 7), ("1.3.6.1.2.1.2.2.1.8.7", snmp.INT, 2)), {"7": "ether7"})
check("linkDown with ifIndex -> 'Port down ether7' (name from the device's port list)", (w["words"], w["ifindex"], w["severity"]) == ("Port down ether7", "7", "medium"), w)
w = snmp.trap_words(v2("1.3.6.1.2.1.33.2.3", ("1.3.6.1.2.1.33.1.6.2.1.2.1", snmp.OID, "1.3.6.1.2.1.33.1.6.3.3")))
check("UPS-MIB alarm 'battery low' -> high", (w["words"], w["severity"]) == ("UPS alarm: battery low", "high"), w)
w = snmp.trap_words(v2("1.3.6.1.2.1.33.1.6.3.24.99", ("1.3.6.1.4.1.9.9.1", snmp.OCTETS, b"something odd")))
check("unknown trap: its number + the text it carries, info", (w["severity"], w["words"]) == ("info", "Trap 1.3.6.1.2.1.33.1.6.3.24.99: something odd"), w)
w = snmp.trap_words({"pdu": snmp.TRAP1, "enterprise": "1.3.6.1.4.1.14988", "agent": "1.1.1.1", "generic": 0, "specific": 0, "ticks": 1, "varbinds": []})
check("v1 generic coldStart -> 'Device started'", w["oid"] == "1.3.6.1.6.3.1.1.5.1" and w["words"].startswith("Device started"), w)
w = snmp.trap_words(v2("1.3.6.1.2.1.43.18.2.0.1", ("1.3.6.1.2.1.43.18.1.1.8.1.5", snmp.OCTETS, b"Paper jam in tray 2")))
check("printer alert carries its text", w["words"] == "Printer alert: Paper jam in tray 2", w)

# ---- events
dev = {"id": 1, "name": "UPS-1", "ip": "192.168.88.5", "watch": {"3"}}
conf = {"toner_pct": 10, "cpu_pct": 90, "disk_pct": 90, "temp_c": 70, "ups_load": 90}
st = {}
ups = lambda src, bat="normal", ch=100, rt=40, load=30: {"source": src, "battery": bat, "charge": ch, "runtime": rt, "load": load, "replace": False}  # noqa: E731
e = snmp.events(dev, {"ups": ups("mains")}, {"ups": ups("battery", ch=88, rt=23)}, st, conf)
check("UPS on battery -> high alert with charge and minutes", e == [("high", "🔋 UPS ON BATTERY: UPS-1 (192.168.88.5) — mains power is gone: 88% charged, about 23 min left")], e)
check("  ... said once (same state next minute: nothing)", snmp.events(dev, {"ups": ups("battery")}, {"ups": ups("battery")}, st, conf) == [])
e = snmp.events(dev, {"ups": ups("battery")}, {"ups": ups("battery", "low", 12, 4)}, st, conf)
check("battery low while on battery -> high", e and e[0][0] == "high" and "battery LOW" in e[0][1], e)
e = snmp.events(dev, {"ups": ups("battery", "low")}, {"ups": ups("mains", "low", 15)}, st, conf)
check("power back -> medium 'on mains again'", e == [("medium", "🔌 Power back: UPS-1 (192.168.88.5) is on mains again (15% charged)")], e)
e = snmp.events(dev, {"ups": ups("mains")}, {"ups": ups("mains", load=95)}, st, conf)
check("UPS overloaded (95%) -> once a day", len(e) == 1 and "load 95%" in e[0][1] and snmp.events(dev, {"ups": ups("mains")}, {"ups": ups("mains", load=95)}, st, conf) == [], e)
pr = {"printer": {"status": "idle", "errors": ["paper jam", "toner low"]}, "supplies": [{"name": "Black", "pct": 6}, {"name": "Cyan", "pct": 50}]}
e = snmp.events(dev, {"printer": {"errors": ["toner low"]}}, pr, st, conf)
check("printer: new jam + Black at 6% (not 'toner low' itself, not Cyan 50%)", [x[1].split(": ", 1)[1] for x in e] == ["paper jam", "Black at 6% — order a new one"], e)
check("  ... toner said once in 3 days, a jam that stays is not repeated", snmp.events(dev, pr, pr, st, conf) == [])
s2 = {}
for i in range(5):
    e = snmp.events(dev, {}, {"cpu": 97}, s2, conf)
check("CPU 97% five minutes in a row -> one alert (not before)", len(e) == 1 and "CPU 97%" in e[0][1] and s2["cpu_hi"] == 5, e)
check("  ... CPU back to normal resets the count", snmp.events(dev, {}, {"cpu": 20}, s2, conf) == [] and s2["cpu_hi"] == 0)
ifs = lambda o3, o4: {"3": {"name": "ether3", "alias": "uplink", "oper": o3}, "4": {"name": "ether4", "alias": "", "oper": o4}}  # noqa: E731
e = snmp.events(dev, {"ifs": ifs("up", "up")}, {"ifs": ifs("down", "down")}, {}, conf)
check("watched port down -> high; an unwatched port going down says nothing", e == [("high", "🔌 Port DOWN: UPS-1 (192.168.88.5) ether3 (uplink)")], e)
e = snmp.events(dev, {"ifs": ifs("down", "up")}, {"ifs": ifs("up", "up")}, {}, conf)
check("  ... and up again", e == [("medium", "✅ Port up again: UPS-1 (192.168.88.5) ether3 (uplink)")], e)
e = snmp.events(dev, {"uptime": 864000}, {"uptime": 60}, {}, conf)
check("uptime went back -> 'restarted (power cut or crash?)'", len(e) == 1 and "restarted" in e[0][1], e)
e = snmp.events(dev, {}, {"disks": [{"name": "C:\\", "pct": 95.2}], "sensors": [{"name": "cpu-temperature", "value": 78, "unit": "°C"}]}, {}, conf)
check("disk 95% full and 78°C -> two alerts", len(e) == 2 and "disk C:\\ 95% full" in e[0][1] and "78°C" in e[1][1], e)

# ---- counters
r = snmp.rates({"1": {"in": 1000, "out": 2**32 - 1000}}, {"1": {"in": 61000, "out": 4000, "wrap": 2**32}}, 60)
check("bit/s from counters; a 32-bit counter going round is counted right", r == {"1": [8000, 666]}, r)
r = snmp.rates({"1": {"in": 10**9, "out": 10**9}}, {"1": {"in": 500, "out": 700, "wrap": 2**64}}, 60)
check("device restarted (counter back near 0): 0, not a huge number", r == {"1": [0, 0]}, r)

# ---- device kinds and the one-line summary
k = lambda d, oid="1.3.6.1.4.1.8072.3.2.10", **x: snmp.guess_kind({"sys": {"descr": d, "objectid": oid}, **x})  # noqa: E731
eth = {str(i): {"type": 6, "oper": "up" if i < 10 else "down"} for i in range(1, 25)}
check("kinds: UPS, printer, MikroTik, camera, Windows server, 24-port switch, unknown",
      [k("x", ups={"source": "mains"}), k("HP LaserJet", supplies=[{}]), k("RouterOS RB4011", "1.3.6.1.4.1.14988.1"), k("Hikvision DS-7608NI NVR"),
       k("Hardware: Intel64 - Software: Windows Version 6.3", disks=[{}]), k("JetStream 24-Port Gigabit", ifs=eth), k("something")] ==
      ["ups", "printer", "mikrotik", "camera", "server", "switch", "other"])
check("summary: switch ports up, CPU, temperature", snmp.summary("switch", {"sys": {"descr": ""}, "ifs": eth, "cpu": 12.4, "sensors": [{"value": 41, "unit": "°C"}]}) ==
      "9/24 ports up · CPU 12% · 41°C")
check("summary: UPS on battery", snmp.summary("ups", {"ups": {"source": "battery", "charge": 80, "runtime": 20, "load": 35}}) == "ON BATTERY · 80% · 20 min left · load 35%")

# ---- v3 output (net-snmp) parsing
out = """.1.3.6.1.2.1.1.1.0 = STRING: "Linux box 6.1
second line"
.1.3.6.1.2.1.1.3.0 = Timeticks: 12345
.1.3.6.1.2.1.2.2.1.6.2 = Hex-STRING: 00 0C 29 AB CD EF
.1.3.6.1.2.1.1.2.0 = OID: .1.3.6.1.4.1.8072.3.2.10
.1.3.6.1.2.1.31.1.1.1.6.2 = Counter64: 18446744073709551615
.1.3.6.1.2.1.33.1.2.4.0 = No Such Object available on this agent at this OID
.1.3.6.1.2.1.2.2.1.8.2 = INTEGER: 1"""
p = snmp.V3Client._lines(out)
check("v3 output read: text over two lines, timeticks, MAC bytes, OID, 64-bit counter; 'No Such Object' left out",
      [v for _, _, v in p] == [b"Linux box 6.1\nsecond line", 12345, bytes.fromhex("000c29abcdef"), "1.3.6.1.4.1.8072.3.2.10", 2**64 - 1, 1], p)

# ---- against the fake device: get, walk (bulk + v1), missing names, finding devices
d = tempfile.mkdtemp()
data = {"1.3.6.1.2.1.1.1.0": ["s", "JetStream 8-Port"], "1.3.6.1.2.1.1.2.0": ["o", "1.3.6.1.4.1.11863.1"], "1.3.6.1.2.1.1.3.0": ["t", 100000],
        "1.3.6.1.2.1.1.4.0": ["s", ""], "1.3.6.1.2.1.1.5.0": ["s", "sw-core"], "1.3.6.1.2.1.1.6.0": ["s", "rack"]}
for i in range(1, 61):
    data[f"1.3.6.1.2.1.2.2.1.2.{i}"] = ["s", f"port {i}"]
    data[f"1.3.6.1.2.1.2.2.1.3.{i}"] = ["i", 6]
    data[f"1.3.6.1.2.1.2.2.1.8.{i}"] = ["i", 1 if i % 2 else 2]
    data[f"1.3.6.1.2.1.31.1.1.1.6.{i}"] = ["c64", i * 10**12]
    data[f"1.3.6.1.2.1.31.1.1.1.10.{i}"] = ["c64", i]
json.dump(data, open(os.path.join(d, "dev.json"), "w"))
procs = [subprocess.Popen([sys.executable, os.path.join(HERE, "fakesnmp.py"), os.path.join(d, "dev.json"), "--bind", ip, "--port", "11199", "--community", "c0mm"])
         for ip in ("127.0.0.2", "127.0.0.3")]
time.sleep(0.6)
try:
    cl = snmp.Client("127.0.0.2", "c0mm", "2c", 11199, timeout=1)
    g = cl.get(["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.99.9.0", "1.3.6.1.2.1.1.3.0"])
    check("get: values back, a missing name just left out", g == {"1.3.6.1.2.1.1.5.0": b"sw-core", "1.3.6.1.2.1.1.3.0": 100000}, g)
    w2 = cl.walk("1.3.6.1.2.1.2.2.1.2")
    c1 = snmp.Client("127.0.0.2", "c0mm", "1", 11199, timeout=1)
    w1 = c1.walk("1.3.6.1.2.1.2.2.1.2")
    check("walk: 60 rows with GETBULK (v2c) and the same with GETNEXT (v1), stops at the table's end",
          len(w2) == 60 and w1 == w2 and w2[-1] == ("1.3.6.1.2.1.2.2.1.2.60", b"port 60"), (len(w2), len(w1)))
    g1 = c1.get(["1.3.6.1.2.1.99.9.0", "1.3.6.1.2.1.1.5.0"])
    check("v1: one missing name does not lose the others", g1 == {"1.3.6.1.2.1.1.5.0": b"sw-core"}, g1)
    m = snmp.collect(cl)
    check("collect: switch with 60 ports, 30 up, 64-bit counters", snmp.guess_kind(m) == "switch" and len(m["ifs"]) == 60 and
          sum(1 for i in m["ifs"].values() if i["oper"] == "up") == 30 and m["ifs"]["60"]["in"] == 60 * 10**12, (snmp.guess_kind(m), len(m.get("ifs", {}))))
    t0 = time.time()
    try:
        snmp.Client("127.0.0.2", "wrong", "2c", 11199, timeout=0.5, retries=1).get(["1.3.6.1.2.1.1.5.0"])
        check("wrong community -> no answer", False)
    except snmp.Timeout:
        check("wrong community -> 'does not answer' after the time limit (with one retry)", 0.9 < time.time() - t0 < 2.5, time.time() - t0)
    f = snmp.discover("127.0.0.0/29", "c0mm", port=11199, timeout=1)
    check("find devices: the two that answer in 127.0.0.0/29, with name and kind", [(x["ip"], x["name"]) for x in f] == [("127.0.0.2", "sw-core"), ("127.0.0.3", "sw-core")], f)
    try:
        snmp.discover("10.0.0.0/16")
        check("network too big refused", False)
    except ValueError:
        check("a network bigger than 1024 addresses is refused", True)
    # trap receiver logic (no database: known devices given by hand)
    class FakeDB:
        def q(self, *a):
            return []
    td = snmp.TrapD(FakeDB())
    td.known, td.comms, td.ifn, td.known_t = {"127.0.0.9": {"id": 4, "name": "sw-core", "alerts": 1}}, {b"public"}, {4: {"3": ("ether3", 1), "5": ("ether5", 0)}}, time.time() + 999
    srv = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    srv.bind(("127.0.0.1", 0))
    tr = lambda oid, *vb, comm="public", pdu=snmp.TRAP2: snmp.build(1, comm, pdu, 77, [("1.3.6.1.2.1.1.3.0", snmp.TIMETICKS, 5), (snmp.TRAP_OID, snmp.OID, oid), *vb])  # noqa: E731
    td.handle(tr("1.3.6.1.6.3.1.1.5.3", ("1.3.6.1.2.1.2.2.1.1.3", snmp.INT, 3)), ("127.0.0.9", 162))
    td.handle(tr("1.3.6.1.6.3.1.1.5.3", ("1.3.6.1.2.1.2.2.1.1.5", snmp.INT, 5)), ("127.0.0.9", 162))
    td.handle(tr("1.3.6.1.6.3.1.1.5.3", ("1.3.6.1.2.1.2.2.1.1.3", snmp.INT, 3)), ("127.0.0.9", 162))
    td.handle(tr("1.3.6.1.2.1.33.2.1", comm="nope"), ("127.0.0.9", 162))
    td.handle(tr("1.3.6.1.2.1.33.2.1"), ("10.9.9.9", 162))
    a = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    a.bind(("127.0.0.1", 0))
    td.handle(tr("1.3.6.1.6.3.1.1.5.1", pdu=snmp.INFORM), a.getsockname(), srv)
    a.settimeout(1)
    resp = snmp.parse(a.recv(65535))
    recs = [(r[1], r[6], r[8], al) for r, al in td.buf]
    check("traps: watched port down alerts, unwatched only kept, the same again within 10 min not repeated; wrong community dropped; "
          "unknown sender kept without alert", [(x[1], x[2]) for x in recs[:4]] == [("Port down ether3", 1), ("Port down ether5", 0), ("Port down ether3", 0),
                                                                                  ("UPS ON BATTERY — mains power is gone", 0)]
          and td.stats["bad_community"] == 1 and recs[3][0] == "10.9.9.9", recs)
    check("inform answered (same request id), stored", resp["pdu"] == snmp.RESPONSE and resp["reqid"] == 77 and recs[4][1].startswith("Device started"), resp)
    for _ in range(70):
        td.handle(tr("1.3.6.1.6.3.1.1.5.4"), ("127.0.0.9", 162))
    check("a device sending a flood: at most 60 a minute kept", td.stats["limited"] >= 13 and len(td.buf) <= 61, (td.stats, len(td.buf)))
finally:
    for p in procs:
        p.kill()
print("all SNMP tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
