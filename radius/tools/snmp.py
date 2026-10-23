#!/usr/bin/env python3
"""SNMP: watch the devices on the LAN (switches, UPS, printers, MikroTik, servers, cameras) and receive their traps.

  snmp.py poll                              every minute (cron): who answers, readings, events, alerts
  snmp.py probe IP [--version 2c] [--json]  what is this device (secrets on stdin as JSON, or --community)
  snmp.py discover NET [--json]             which addresses in a network answer SNMP (community from stdin / --community)
  snmp.py add|set|del|list|show ...         devices (radius-admin snmp ...)
  snmp.py trapd [--port 162]                trap receiver (service)
  snmp.py get|walk IP OID                   for testing

SNMP v1 / v2c are spoken here (own code, no library). v3 (user + passwords, encrypted) goes through net-snmp's
snmpget / snmpbulkwalk; the passwords are handed over in a private config file, never on the command line.
Secrets (communities, v3 passwords) are kept in a root-only file, not in the database.
"""
import concurrent.futures as cf
import fcntl
import ipaddress
import json
import os
import random
import re
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # alerts.py (python3 -I leaves it out)

CNF = "/etc/mikrotiklover-radius/my.cnf"
DBNAME = "radius"
SECRETS = "/etc/mikrotiklover-radius/snmp-secrets.json"
STATE = "/var/lib/mikrotiklover/snmp-state.json"
LOCK = "/run/mikrotiklover-snmp.lock"
KINDS = ("switch", "ups", "printer", "mikrotik", "server", "camera", "other")

# ------------------------------------------------------------------ BER (the SNMP wire format)
INT, OCTETS, NULL, OID, SEQ = 0x02, 0x04, 0x05, 0x06, 0x30
IPADDR, COUNTER32, GAUGE32, TIMETICKS, OPAQUE, COUNTER64 = 0x40, 0x41, 0x42, 0x43, 0x44, 0x46
NOSUCHOBJECT, NOSUCHINSTANCE, ENDOFMIB = 0x80, 0x81, 0x82
GET, GETNEXT, RESPONSE, SET, TRAP1, GETBULK, INFORM, TRAP2, REPORT = 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8
UNSIGNED = (COUNTER32, GAUGE32, TIMETICKS, COUNTER64)
MISSING = (NOSUCHOBJECT, NOSUCHINSTANCE, ENDOFMIB)


def _len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def tlv(tag, val):
    return bytes([tag]) + _len(len(val)) + val


def enc_int(v, tag=INT):
    return tlv(tag, int(v).to_bytes(max(1, (int(v).bit_length() + 8) // 8), "big", signed=True))


def enc_oid(oid):
    p = [int(x) for x in oid.strip(".").split(".")]
    if len(p) < 2 or p[0] > 2 or (p[0] < 2 and p[1] > 39):
        raise ValueError(f"bad OID {oid}")
    out = bytearray()
    for i, n in enumerate([p[0] * 40 + p[1]] + p[2:]):
        if n < 0:
            raise ValueError(f"bad OID {oid}")
        chunk = [n & 0x7F]
        n >>= 7
        while n:
            chunk.append(0x80 | (n & 0x7F))
            n >>= 7
        out += bytes(reversed(chunk))
    return tlv(OID, bytes(out))


def enc_value(tag, v):
    if tag == NULL or tag in MISSING:
        return bytes([tag, 0])
    if tag == INT or tag in UNSIGNED:
        return enc_int(v, tag)
    if tag == OID:
        return enc_oid(v)
    if tag == IPADDR:
        return tlv(IPADDR, socket.inet_aton(v))
    return tlv(tag, v if isinstance(v, bytes) else str(v).encode())


def dec(data, pos, end=None):
    """-> (tag, value bytes, next position); ValueError on anything broken."""
    end = len(data) if end is None else end
    if pos + 2 > end:
        raise ValueError("short")
    tag, n = data[pos], data[pos + 1]
    pos += 2
    if n & 0x80:
        k = n & 0x7F
        if k == 0 or k > 4 or pos + k > end:
            raise ValueError("bad length")
        n = int.from_bytes(data[pos:pos + k], "big")
        pos += k
    if pos + n > end:
        raise ValueError("truncated")
    return tag, data[pos:pos + n], pos + n


def dec_oid(b):
    if not b:
        raise ValueError("empty OID")
    out, n = [], 0
    for i, x in enumerate(b):
        n = (n << 7) | (x & 0x7F)
        if not x & 0x80:
            if not out:
                out += [min(n // 40, 2), n - 40 * min(n // 40, 2)]
            else:
                out.append(n)
            n = 0
        elif i == len(b) - 1:
            raise ValueError("bad OID")
    return ".".join(map(str, out))


def dec_value(tag, b):
    if tag == INT:
        return int.from_bytes(b, "big", signed=True) if b else 0
    if tag in UNSIGNED:
        return int.from_bytes(b, "big") if b else 0
    if tag == OID:
        return dec_oid(b)
    if tag == IPADDR:
        return socket.inet_ntoa(b) if len(b) == 4 else ""
    if tag == NULL or tag in MISSING:
        return None
    return bytes(b)


def build(version, community, pdu, reqid, varbinds, a=0, b=0):
    """version 0 = v1, 1 = v2c. varbinds: [(oid, tag, value)]. GETBULK: a = non-repeaters, b = max-repetitions."""
    vbs = b"".join(tlv(SEQ, enc_oid(o) + enc_value(t, v)) for o, t, v in varbinds)
    body = enc_int(reqid) + enc_int(a) + enc_int(b) + tlv(SEQ, vbs)
    return tlv(SEQ, enc_int(version) + tlv(OCTETS, community.encode() if isinstance(community, str) else community) + tlv(pdu, body))


def build_trap1(community, enterprise, agent, generic, specific, ticks, varbinds):
    vbs = b"".join(tlv(SEQ, enc_oid(o) + enc_value(t, v)) for o, t, v in varbinds)
    body = enc_oid(enterprise) + enc_value(IPADDR, agent) + enc_int(generic) + enc_int(specific) + enc_int(ticks, TIMETICKS) + tlv(SEQ, vbs)
    return tlv(SEQ, enc_int(0) + tlv(OCTETS, community.encode()) + tlv(TRAP1, body))


def parse(data):
    """A whole SNMP v1 / v2c message -> dict. ValueError when it is not one (v3 too)."""
    tag, msg, _ = dec(data, 0)
    if tag != SEQ:
        raise ValueError("not SNMP")
    t, v, p = dec(msg, 0)
    if t != INT:
        raise ValueError("not SNMP")
    version = dec_value(INT, v)
    if version not in (0, 1):
        raise ValueError(f"SNMP version {version + 1 if version < 3 else 3} not handled here")
    t, comm, p = dec(msg, p)
    if t != OCTETS:
        raise ValueError("no community")
    pdu, body, _ = dec(msg, p)
    out = {"version": version, "community": bytes(comm), "pdu": pdu}
    q = 0
    if pdu == TRAP1:
        t, v, q = dec(body, q)
        out["enterprise"] = dec_oid(v)
        t, v, q = dec(body, q)
        out["agent"] = dec_value(IPADDR, v)
        for k in ("generic", "specific", "ticks"):
            t, v, q = dec(body, q)
            out[k] = dec_value(t if t in UNSIGNED else INT, v)
    else:
        for k in ("reqid", "err", "eidx"):
            t, v, q = dec(body, q)
            if t != INT:
                raise ValueError("bad PDU")
            out[k] = dec_value(INT, v)
    t, vbl, _ = dec(body, q)
    if t != SEQ:
        raise ValueError("no varbinds")
    vbs, q = [], 0
    while q < len(vbl):
        t, vb, q = dec(vbl, q)
        if t != SEQ:
            raise ValueError("bad varbind")
        t1, o, r = dec(vb, 0)
        t2, val, _ = dec(vb, r)
        if t1 != OID:
            raise ValueError("bad varbind name")
        vbs.append((dec_oid(o), t2, dec_value(t2, val)))
        if len(vbs) > 500:
            raise ValueError("too many varbinds")
    out["varbinds"] = vbs
    return out


def oid_key(o):
    return tuple(int(x) for x in o.strip(".").split("."))


def under(o, root):
    return o == root or o.startswith(root + ".")


# ------------------------------------------------------------------ clients
class Timeout(Exception):
    pass


class Client:
    """SNMP v1 / v2c."""

    def __init__(self, ip, community="public", version="2c", port=161, timeout=1.5, retries=1):
        self.ip, self.port, self.timeout, self.retries = ip, int(port), timeout, retries
        self.community = community or "public"
        self.v = 0 if str(version) == "1" else 1
        self.rtt = None

    def _req(self, pdu, varbinds, a=0, b=0):
        fam = socket.AF_INET6 if ":" in self.ip else socket.AF_INET
        reqid = random.randint(1, 2**31 - 1)
        msg = build(self.v, self.community, pdu, reqid, varbinds, a, b)
        with socket.socket(fam, socket.SOCK_DGRAM) as s:
            s.connect((self.ip, self.port))
            for _ in range(self.retries + 1):
                t0 = time.monotonic()
                try:
                    s.send(msg)
                except OSError as e:
                    raise Timeout(str(e)) from None
                deadline = t0 + self.timeout
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        break
                    r, _, _ = select.select([s], [], [], left)
                    if not r:
                        break
                    try:
                        data = s.recv(65535)
                        m = parse(data)
                    except (OSError, ValueError):
                        continue        # ICMP refused, garbage: keep waiting until the time is up
                    if m.get("pdu") == RESPONSE and m.get("reqid") == reqid:
                        self.rtt = (time.monotonic() - t0) * 1000
                        return m
        raise Timeout(f"{self.ip} does not answer SNMP (community / version / firewall?)")

    def get(self, oids):
        """-> {oid: value} for the OIDs the device has (missing ones left out)."""
        oids, out = list(oids), {}
        while oids:
            m = self._req(GET, [(o, NULL, None) for o in oids])
            if m["err"] == 2 and self.v == 0 and 0 < m["eidx"] <= len(oids):   # v1: one missing name fails all
                oids.pop(m["eidx"] - 1)
                continue
            if m["err"] == 1 and len(oids) > 1:                                  # tooBig: in halves
                h = len(oids) // 2
                out.update(self.get(oids[:h]))
                oids = oids[h:]
                continue
            if m["err"]:
                return out
            for o, t, v in m["varbinds"]:
                if t not in MISSING:
                    out[o] = v
            break
        return out

    def walk(self, root, limit=3000):
        """-> [(oid, value)] under root."""
        out, cur, maxrep = [], root, 25
        while len(out) < limit:
            if self.v:
                m = self._req(GETBULK, [(cur, NULL, None)], 0, maxrep)
                if m["err"] == 1 and maxrep > 1:
                    maxrep = max(1, maxrep // 3)
                    continue
            else:
                m = self._req(GETNEXT, [(cur, NULL, None)])
            if m["err"] or not m["varbinds"]:
                break
            done = False
            for o, t, v in m["varbinds"]:
                if t in MISSING or not under(o, root) or oid_key(o) <= oid_key(cur):
                    done = True
                    break
                out.append((o, v))
                cur = o
            if done:
                break
        return out


V3_TYPES = {"INTEGER": INT, "STRING": OCTETS, "Hex-STRING": OCTETS, "OID": OID, "IpAddress": IPADDR, "Counter32": COUNTER32,
            "Gauge32": GAUGE32, "Timeticks": TIMETICKS, "Counter64": COUNTER64, "Opaque": OPAQUE, "BITS": OCTETS, "Network Address": IPADDR}


class V3Client:
    """SNMP v3 through net-snmp (encryption needs AES, which Python has not built in)."""

    def __init__(self, ip, user, auth="SHA", authpass="", priv="AES", privpass="", port=161, timeout=2, retries=1):
        if not user:
            raise ValueError("v3 needs a user name")
        self.ip, self.port, self.timeout, self.retries = ip, int(port), timeout, retries
        self.conf = ["defVersion 3", f"defSecurityName {user}"]
        level = "noAuthNoPriv"
        if authpass:
            level = "authNoPriv"
            self.conf += [f"defAuthType {auth or 'SHA'}", f"defAuthPassphrase {authpass}"]
            if privpass:
                level = "authPriv"
                self.conf += [f"defPrivType {priv or 'AES'}", f"defPrivPassphrase {privpass}"]
        self.conf.append(f"defSecurityLevel {level}")
        self.rtt = None

    def _run(self, tool, args):
        with tempfile.TemporaryDirectory(prefix="mlsnmp") as d:
            os.chmod(d, 0o700)
            with open(os.path.join(d, "snmp.conf"), "w") as f:
                os.fchmod(f.fileno(), 0o600)
                f.write("\n".join(self.conf) + "\n")
            env = {"PATH": "/usr/bin:/bin", "SNMPCONFPATH": d, "MIBS": "", "MIBDIRS": "/nonexistent", "HOME": d}
            t0 = time.monotonic()
            try:
                p = subprocess.run([tool, "-On", "-Oe", "-Ot", "-t", str(self.timeout), "-r", str(self.retries),
                                    f"{'udp6:[' + self.ip + ']' if ':' in self.ip else self.ip}:{self.port}"] + args,
                                   capture_output=True, text=True, env=env, timeout=120)
            except FileNotFoundError:
                raise Timeout("SNMP v3 needs the net-snmp tools: apt install snmp") from None
            except subprocess.TimeoutExpired:
                raise Timeout(f"{self.ip} SNMP v3 took too long") from None
        if p.returncode and not p.stdout:
            err = (p.stderr.strip().splitlines() or ["no answer"])[-1]
            raise Timeout(f"{self.ip}: {err[:150]}")
        self.rtt = (time.monotonic() - t0) * 1000
        return self._lines(p.stdout)

    @staticmethod
    def _lines(text):
        out, cur = [], None
        for line in text.splitlines():
            m = re.match(r"^(\.[\d.]+) = (.*)$", line)
            if m:
                cur = [m.group(1).lstrip("."), m.group(2)]
                out.append(cur)
            elif cur is not None:
                cur[1] += "\n" + line            # a text value over several lines
        res = []
        for o, rest in out:
            if rest.startswith(("No Such", "No more variables")):
                continue
            m = re.match(r"^([A-Za-z0-9 -]+): ?(.*)$", rest, re.S)
            if not m:
                v, t = rest.strip('"').encode(), OCTETS
            else:
                t = V3_TYPES.get(m.group(1), OCTETS)
                v = m.group(2)
                if t == OCTETS:
                    if m.group(1) == "Hex-STRING":
                        v = bytes.fromhex(v.replace(" ", "").replace("\n", ""))
                    else:
                        v = (v[1:-1] if len(v) >= 2 and v[0] == v[-1] == '"' else v).replace('\\"', '"').encode()
                elif t in (INT, *UNSIGNED):
                    n = re.search(r"-?\d+", v)
                    v = int(n.group()) if n else 0
                elif t == OID:
                    v = v.lstrip(".")
            res.append((o, t, v))
        return res

    def get(self, oids):
        return {o: v for o, t, v in self._run("snmpget", list(oids))}

    def walk(self, root, limit=3000):
        return [(o, v) for o, t, v in self._run("snmpbulkwalk", ["-Cr25", root])][:limit]


def client(dev, secret, timeout=1.5):
    if str(dev.get("version")) == "3":
        return V3Client(dev["ip"], secret.get("user", ""), secret.get("auth", "SHA"), secret.get("authpass", ""),
                        secret.get("priv", "AES"), secret.get("privpass", ""), dev.get("port") or 161, timeout=max(2, int(timeout)))
    return Client(dev["ip"], secret.get("community") or "public", dev.get("version") or "2c", dev.get("port") or 161, timeout)


# ------------------------------------------------------------------ what to read
SYS = {"descr": "1.3.6.1.2.1.1.1.0", "objectid": "1.3.6.1.2.1.1.2.0", "uptime": "1.3.6.1.2.1.1.3.0", "contact": "1.3.6.1.2.1.1.4.0",
       "name": "1.3.6.1.2.1.1.5.0", "location": "1.3.6.1.2.1.1.6.0"}
IF_COLS = {"descr": "1.3.6.1.2.1.2.2.1.2", "type": "1.3.6.1.2.1.2.2.1.3", "speed32": "1.3.6.1.2.1.2.2.1.5", "admin": "1.3.6.1.2.1.2.2.1.7",
           "oper": "1.3.6.1.2.1.2.2.1.8", "in32": "1.3.6.1.2.1.2.2.1.10", "inerr": "1.3.6.1.2.1.2.2.1.14", "out32": "1.3.6.1.2.1.2.2.1.16",
           "outerr": "1.3.6.1.2.1.2.2.1.20"}
IFX_COLS = {"name": "1.3.6.1.2.1.31.1.1.1.1", "in": "1.3.6.1.2.1.31.1.1.1.6", "out": "1.3.6.1.2.1.31.1.1.1.10",
            "speed": "1.3.6.1.2.1.31.1.1.1.15", "alias": "1.3.6.1.2.1.31.1.1.1.18"}
HR_CPU = "1.3.6.1.2.1.25.3.3.1.2"
HR_STORE = {"type": "1.3.6.1.2.1.25.2.3.1.2", "descr": "1.3.6.1.2.1.25.2.3.1.3", "units": "1.3.6.1.2.1.25.2.3.1.4",
            "size": "1.3.6.1.2.1.25.2.3.1.5", "used": "1.3.6.1.2.1.25.2.3.1.6"}
HR_RAM, HR_DISK = "1.3.6.1.2.1.25.2.1.2", "1.3.6.1.2.1.25.2.1.4"
UPS = {"battery": "1.3.6.1.2.1.33.1.2.1.0", "on_battery_s": "1.3.6.1.2.1.33.1.2.2.0", "runtime": "1.3.6.1.2.1.33.1.2.3.0",
       "charge": "1.3.6.1.2.1.33.1.2.4.0", "temp": "1.3.6.1.2.1.33.1.2.7.0", "in_volt": "1.3.6.1.2.1.33.1.3.3.1.3.1",
       "source": "1.3.6.1.2.1.33.1.4.1.0", "load": "1.3.6.1.2.1.33.1.4.4.1.5.1", "model": "1.3.6.1.2.1.33.1.1.2.0"}
APC = {"status": "1.3.6.1.4.1.318.1.1.1.4.1.1.0", "battery": "1.3.6.1.4.1.318.1.1.1.2.1.1.0", "charge": "1.3.6.1.4.1.318.1.1.1.2.2.1.0",
       "runtime": "1.3.6.1.4.1.318.1.1.1.2.2.3.0", "temp": "1.3.6.1.4.1.318.1.1.1.2.2.2.0", "replace": "1.3.6.1.4.1.318.1.1.1.2.2.4.0",
       "in_volt": "1.3.6.1.4.1.318.1.1.1.3.2.1.0", "load": "1.3.6.1.4.1.318.1.1.1.4.2.3.0", "model": "1.3.6.1.4.1.318.1.1.1.1.1.1.0"}
PRT = {"descr": "1.3.6.1.2.1.43.11.1.1.6", "max": "1.3.6.1.2.1.43.11.1.1.8", "level": "1.3.6.1.2.1.43.11.1.1.9"}
PRT_PAGES = "1.3.6.1.2.1.43.10.2.1.4"
HR_PRINTER = {"status": "1.3.6.1.2.1.25.3.5.1.1", "errors": "1.3.6.1.2.1.25.3.5.1.2"}
PRINTER_ERRORS = ["paper low", "no paper", "toner low", "no toner", "door open", "paper jam", "offline", "service needed",
                  "input tray missing", "output tray missing", "supply missing", "output nearly full", "output full", "input tray empty",
                  "maintenance overdue"]
PRINTER_BAD = {"no paper", "no toner", "door open", "paper jam", "offline", "service needed", "supply missing", "output full"}
MTXR_GAUGE = {"name": "1.3.6.1.4.1.14988.1.1.3.100.1.2", "value": "1.3.6.1.4.1.14988.1.1.3.100.1.3", "unit": "1.3.6.1.4.1.14988.1.1.3.100.1.4"}
MTXR_OLD = {"temperature": "1.3.6.1.4.1.14988.1.1.3.10.0", "voltage": "1.3.6.1.4.1.14988.1.1.3.8.0", "cpu-temperature": "1.3.6.1.4.1.14988.1.1.3.11.0"}
ENT_SENSOR = {"type": "1.3.6.1.2.1.99.1.1.1.1", "scale": "1.3.6.1.2.1.99.1.1.1.2", "precision": "1.3.6.1.2.1.99.1.1.1.3", "value": "1.3.6.1.2.1.99.1.1.1.4"}
ENT_NAME = "1.3.6.1.2.1.47.1.1.1.1.7"
MIKROTIK = "1.3.6.1.4.1.14988"


def text(v):
    if isinstance(v, bytes):
        s = v.decode("utf-8", "replace") if not any(b < 9 for b in v.rstrip(b"\0")) else v.hex(":")
        return s.replace("\0", "").strip()
    return "" if v is None else str(v)


def table(cl, cols, limit=3000):
    """Several columns of one table -> {index: {col: value}}."""
    rows = {}
    for k, base in cols.items():
        for o, v in cl.walk(base, limit):
            rows.setdefault(o[len(base) + 1:], {})[k] = v
    return rows


def collect(cl, kind=None):
    """Read one device -> readings. kind None = first look (read everything to find out what it is)."""
    s = cl.get(SYS.values())
    if not s:
        raise Timeout(f"{getattr(cl, 'ip', '?')} answered, but without the basic system values")
    m = {"sys": {k: (text(s.get(o)) if k not in ("uptime",) else int(s.get(o) or 0)) for k, o in SYS.items()}}
    m["uptime"] = m["sys"].pop("uptime") // 100
    is_mt = m["sys"]["objectid"].startswith(MIKROTIK)
    want = lambda *ks: kind is None or kind in ks  # noqa: E731
    if want("switch", "mikrotik", "server", "camera", "other"):
        ifs = table(cl, IF_COLS, 4000)
        if len(ifs) <= 600:
            ifx = table(cl, IFX_COLS, 4000)
        else:
            ifx = {}
        m["ifs"] = {}
        for idx, r in list(ifs.items())[:600]:
            x = ifx.get(idx, {})
            hc = "in" in x and "out" in x
            m["ifs"][idx] = {"name": text(x.get("name")) or text(r.get("descr")) or f"if{idx}", "descr": text(r.get("descr")),
                             "alias": text(x.get("alias")), "type": int(r.get("type") or 0),
                             "speed": int(x.get("speed") or 0) or int(r.get("speed32") or 0) // 1000000,
                             "admin": {1: "up", 2: "down", 3: "testing"}.get(r.get("admin"), "?"),
                             "oper": {1: "up", 2: "down", 3: "testing", 5: "dormant", 6: "absent", 7: "down"}.get(r.get("oper"), "?"),
                             "in": int(x["in"] if hc else r.get("in32") or 0), "out": int(x["out"] if hc else r.get("out32") or 0),
                             "wrap": 2**64 if hc else 2**32, "inerr": int(r.get("inerr") or 0), "outerr": int(r.get("outerr") or 0)}
    if want("mikrotik", "server", "switch", "camera", "other"):
        loads = [v for o, v in cl.walk(HR_CPU, 256) if isinstance(v, int)]
        m["cpu"] = round(sum(loads) / len(loads), 1) if loads else None
        disks, mem = [], None
        for idx, r in table(cl, HR_STORE, 1000).items():
            try:
                units, size, used = int(r.get("units") or 0), int(r.get("size") or 0), int(r.get("used") or 0)
            except (TypeError, ValueError):
                continue
            if not size or not units:
                continue
            pct = round(used / size * 100, 1)
            if r.get("type") == HR_RAM:
                mem = pct
            elif r.get("type") == HR_DISK and size * units >= 2**29 and not re.match(r"^/(sys|dev|run|proc|snap|boot/efi)(/|$)", text(r.get("descr"))):
                disks.append({"name": text(r.get("descr"))[:60], "pct": pct, "size_gb": round(size * units / 2**30, 1)})
        m["mem"], m["disks"] = mem, disks[:20]
    if want("ups", "other"):
        u = cl.get(UPS.values())
        a = cl.get(APC.values()) if not u else {}
        if u:
            g = lambda k: u.get(UPS[k])  # noqa: E731
            m["ups"] = {"source": {3: "mains", 4: "bypass", 5: "battery", 6: "mains", 7: "mains", 2: "off"}.get(g("source"), "other"),
                        "battery": {2: "normal", 3: "low", 4: "depleted"}.get(g("battery"), "unknown"), "charge": g("charge"),
                        "runtime": g("runtime"), "load": g("load"), "in_volt": g("in_volt"), "temp": g("temp"),
                        "on_battery_s": g("on_battery_s") or 0, "replace": False, "model": text(g("model"))}
        elif a:
            g = lambda k: a.get(APC[k])  # noqa: E731
            m["ups"] = {"source": {2: "mains", 3: "battery", 4: "mains", 5: "off", 6: "bypass", 7: "off", 8: "off", 9: "bypass", 12: "mains"}.get(g("status"), "other"),
                        "battery": {2: "normal", 3: "low"}.get(g("battery"), "unknown"), "charge": g("charge"),
                        "runtime": (g("runtime") // 6000) if g("runtime") is not None else None, "load": g("load"),
                        "in_volt": g("in_volt"), "temp": g("temp"), "replace": g("replace") == 2, "model": text(g("model"))}
    if want("printer", "other"):
        sup = []
        for idx, r in sorted(table(cl, PRT, 200).items()):
            mx, lv = r.get("max"), r.get("level")
            if not isinstance(lv, int):
                continue
            pct = round(lv / mx * 100) if isinstance(mx, int) and mx > 0 and lv >= 0 else None
            sup.append({"name": text(r.get("descr"))[:60] or f"supply {idx}", "pct": pct, "level": lv, "max": mx})
        st = table(cl, HR_PRINTER, 20)
        if sup or st:
            errs = []
            for r in st.values():
                b = r.get("errors") or b""
                if isinstance(b, bytes):
                    errs += [PRINTER_ERRORS[i] for i in range(min(len(b) * 8, len(PRINTER_ERRORS))) if b[i // 8] & (0x80 >> (i % 8))]
            stat = next((r.get("status") for r in st.values() if r.get("status")), None)
            pages = [v for o, v in cl.walk(PRT_PAGES, 10) if isinstance(v, int)]
            m["printer"] = {"status": {3: "idle", 4: "printing", 5: "warming up", 1: "other"}.get(stat, "unknown"),
                            "errors": sorted(set(errs), key=PRINTER_ERRORS.index), "pages": pages[0] if pages else None}
            m["supplies"] = sup[:16]
    sensors = []
    if is_mt and want("mikrotik", "other"):
        for idx, r in sorted(table(cl, MTXR_GAUGE, 100).items(), key=lambda x: x[0]):
            unit = {1: "°C", 2: "rpm", 3: "V", 4: "A", 5: "W", 6: ""}.get(r.get("unit"), "")
            v = r.get("value")
            if not isinstance(v, int):
                continue
            sensors.append({"name": text(r.get("name")) or f"gauge {idx}", "value": v / 10 if unit in ("V", "A", "W") else v, "unit": unit})
        if not sensors:
            old = cl.get(MTXR_OLD.values())
            for k, o in MTXR_OLD.items():
                if isinstance(old.get(o), int):
                    sensors.append({"name": k, "value": old[o] / 10, "unit": "V" if k == "voltage" else "°C"})
    elif want("switch", "server", "other"):
        es = table(cl, ENT_SENSOR, 200)
        if es:
            names = {o[len(ENT_NAME) + 1:]: text(v) for o, v in cl.walk(ENT_NAME, 400)}
            for idx, r in es.items():
                if r.get("type") == 8 and isinstance(r.get("value"), int):       # celsius
                    sc = {8: 0, 9: 0}.get(r.get("scale"), 0)
                    sensors.append({"name": names.get(idx, f"sensor {idx}")[:40], "value": r["value"] / (10 ** int(r.get("precision") or 0)) * 10 ** sc, "unit": "°C"})
    if sensors:
        m["sensors"] = sensors[:30]
    m["rtt"] = round(cl.rtt, 1) if cl.rtt is not None else None
    return m


def guess_kind(m):
    d, oid = m["sys"]["descr"].lower(), m["sys"]["objectid"]
    if m.get("ups"):
        return "ups"
    if m.get("supplies") or (m.get("printer") and "printer" in d):
        return "printer"
    if oid.startswith(MIKROTIK) or "routeros" in d:
        return "mikrotik"
    if re.search(r"hikvision|dahua|\bnvr\b|\bdvr\b|ip ?camera|\bipc\b|uniview|axis", d):
        return "camera"
    if re.search(r"windows|linux|freebsd|vmware|esxi|synology|qnap|truenas|ubuntu|debian", d) and m.get("disks"):
        return "server"
    ether = [i for i in (m.get("ifs") or {}).values() if i["type"] in (6, 117)]
    if len(ether) >= 8 or re.search(r"switch|procurve|catalyst|aruba|jetstream|smart managed|d-link des|netgear gs|cisco ios|huawei.*s\d{4}", d):
        return "switch"
    if re.search(r"windows|linux", d):
        return "server"
    return "other"


def summary(kind, m):
    """One line the dashboard shows next to the device."""
    if kind == "ups" and m.get("ups"):
        u = m["ups"]
        parts = ["ON BATTERY" if u["source"] == "battery" else {"mains": "on mains", "bypass": "on bypass", "off": "output off"}.get(u["source"], u["source"])]
        if u.get("charge") is not None:
            parts.append(f"{u['charge']}%")
        if u.get("runtime") is not None:
            parts.append(f"{u['runtime']} min left")
        if u.get("load") is not None:
            parts.append(f"load {u['load']}%")
        return " · ".join(parts)
    if kind == "printer" and m.get("printer"):
        sup = [s for s in m.get("supplies", []) if s["pct"] is not None]
        low = sorted(sup, key=lambda s: s["pct"])[:2]
        p = m["printer"]
        return " · ".join([", ".join(p["errors"]) or p["status"]] + [f"{s['name'][:18]} {s['pct']}%" for s in low])
    parts = []
    ifs = m.get("ifs") or {}
    ether = [i for i in ifs.values() if i["type"] in (6, 117)]
    if kind == "switch" and ether:
        parts.append(f"{sum(1 for i in ether if i['oper'] == 'up')}/{len(ether)} ports up")
    if m.get("cpu") is not None:
        parts.append(f"CPU {m['cpu']:.0f}%")
    if m.get("mem") is not None:
        parts.append(f"memory {m['mem']:.0f}%")
    t = [s["value"] for s in m.get("sensors", []) if s["unit"] == "°C"]
    if t:
        parts.append(f"{max(t):.0f}°C")
    if m.get("disks"):
        d = max(m["disks"], key=lambda x: x["pct"])
        parts.append(f"disk {d['pct']:.0f}%")
    return " · ".join(parts) or m["sys"]["descr"][:60]


# ------------------------------------------------------------------ events from two readings
def events(dev, prev, m, st, conf, now=None):
    """dev: device row, prev: last readings (or {}), m: new readings, st: this device's state (changed in place).
    -> [(severity, text)]"""
    now = now or time.time()
    out, name = [], f"{dev['name']} ({dev['ip']})"
    flags = st.setdefault("flags", {})

    def once(key, ttl):
        if now - flags.get(key, 0) < ttl:
            return False
        flags[key] = now
        return True

    if prev.get("uptime") is not None and m.get("uptime") is not None and m["uptime"] + 120 < prev["uptime"] and prev["uptime"] < 4.2e7:
        out.append(("medium", f"🔄 {name} restarted (power cut or crash?) — up for {m['uptime'] // 60} min"))
    u, pu = m.get("ups"), prev.get("ups") or {}
    if u:
        if u["source"] == "battery" and pu.get("source") != "battery":
            more = ", ".join(x for x in (f"{u['charge']}% charged" if u.get("charge") is not None else "",
                                         f"about {u['runtime']} min left" if u.get("runtime") is not None else "") if x)
            out.append(("high", f"🔋 UPS ON BATTERY: {name} — mains power is gone{': ' + more if more else ''}"))
        elif pu.get("source") == "battery" and u["source"] in ("mains", "bypass"):
            out.append(("medium", f"🔌 Power back: {name} is on mains again ({u.get('charge', '?')}% charged)"))
        if u["battery"] in ("low", "depleted") and pu.get("battery") not in ("low", "depleted"):
            out.append(("high", f"🪫 UPS battery {u['battery'].upper()}: {name} — {u.get('runtime', '?')} min left. Save work, shut down servers"))
        if u.get("replace") and once("replace", 7 * 86400):
            out.append(("medium", f"🔧 {name}: the UPS says its battery needs replacing"))
        if isinstance(u.get("load"), int) and u["load"] >= conf.get("ups_load", 90) and once("load", 86400):
            out.append(("medium", f"⚡ {name}: UPS load {u['load']}% — too many devices on it"))
    p, pp = m.get("printer"), prev.get("printer") or {}
    if p:
        new = [e for e in p["errors"] if e in PRINTER_BAD and e not in pp.get("errors", [])]
        if new:
            out.append(("medium", f"🖨️ Printer {name}: {', '.join(new)}"))
        for s in m.get("supplies", []):
            if s["pct"] is not None and s["pct"] <= conf.get("toner_pct", 10) and once(f"sup:{s['name']}", 3 * 86400):
                out.append(("medium", f"🖨️ {name}: {s['name']} at {s['pct']}% — order a new one"))
    if m.get("cpu") is not None:
        st["cpu_hi"] = st.get("cpu_hi", 0) + 1 if m["cpu"] >= conf.get("cpu_pct", 90) else 0
        if st["cpu_hi"] >= 5 and once("cpu", 6 * 3600):
            out.append(("medium", f"🔥 {name}: CPU {m['cpu']:.0f}% for 5 minutes"))
    for d in m.get("disks", []):
        if d["pct"] >= conf.get("disk_pct", 90) and once(f"disk:{d['name']}", 86400):
            out.append(("medium", f"💾 {name}: disk {d['name']} {d['pct']:.0f}% full"))
    hot = [s for s in m.get("sensors", []) if s["unit"] == "°C" and s["value"] >= conf.get("temp_c", 70)]
    if hot and once("temp", 6 * 3600):
        out.append(("medium", f"🌡️ {name}: {hot[0]['name']} {hot[0]['value']:.0f}°C — too hot (fan, dust, room?)"))
    for idx, i in (m.get("ifs") or {}).items():
        if idx not in dev.get("watch", ()):
            continue
        was = ((prev.get("ifs") or {}).get(idx) or {}).get("oper")
        label = i["name"] + (f" ({i['alias']})" if i["alias"] else "")
        if i["oper"] != "up" and was == "up":
            out.append(("high", f"🔌 Port DOWN: {name} {label}"))
        elif i["oper"] == "up" and was and was != "up":
            out.append(("medium", f"✅ Port up again: {name} {label}"))
    return out


def rates(prev_ifs, ifs, dt):
    """bit/s per interface from two counter readings (counter wrap and reset handled)."""
    out = {}
    if not dt or dt <= 0:
        return out
    for idx, i in ifs.items():
        p = prev_ifs.get(idx)
        if not p:
            continue
        r = []
        for k in ("in", "out"):
            d, wrap = i[k] - p[k], i.get("wrap", 2**64)
            if d < 0:                                   # the counter went round (it was near the top), else the device restarted
                d = d + wrap if p[k] > wrap // 2 and d + wrap < wrap // 2 else 0
            r.append(int(d * 8 / dt))
        out[idx] = r
    return out


# ------------------------------------------------------------------ secrets, database, state
def load_secrets(path=SECRETS):
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_secrets(s, path=SECRETS):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(path + ".tmp", path)


class DB:
    def __init__(self, cnf=CNF, name=DBNAME):
        import pymysql
        import pymysql.cursors
        self.c = pymysql.connect(read_default_file=cnf, database=name, autocommit=True, charset="utf8mb4",
                                 cursorclass=pymysql.cursors.DictCursor)

    def q(self, sql, args=()):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def many(self, sql, rows):
        if rows:
            with self.c.cursor() as cur:
                cur.executemany(sql, rows)

    def setting(self, k, default=""):
        r = self.q("SELECT v FROM ml_setting WHERE k=%s", (k,))
        return r[0]["v"] if r and r[0]["v"] not in (None, "") else default


def conf_from(db):
    c = {}
    for k, d in (("toner_pct", 10), ("cpu_pct", 90), ("disk_pct", 90), ("temp_c", 70), ("ups_load", 90)):
        try:
            c[k] = int(db.setting(f"snmp_{k}", d))
        except ValueError:
            c[k] = d
    return c


def devices(db, only=None):
    rows = db.q("SELECT * FROM ml_snmp_device WHERE enabled=1" + (" AND id=%s" if only else "") + " ORDER BY id", (only,) if only else ())
    w = {}
    for r in db.q("SELECT device_id, ifindex FROM ml_snmp_if WHERE watch=1"):
        w.setdefault(r["device_id"], set()).add(str(r["ifindex"]))
    for r in rows:
        r["watch"] = w.get(r["id"], set())
    return rows


def send_alerts(db, lines, kind="devices"):
    """Device problems go out at once (a UPS on battery cannot wait for the 5-minute alert check)."""
    if not lines:
        return {}
    try:
        import alerts
        c = alerts.load_conf()
        if "devices" not in alerts.events(c) or not alerts.channels(c):
            return {}
        k, title, text_ = alerts.compose([(kind, l) for l in lines])
        res = alerts.deliver(c, title, text_)
        db.q("INSERT INTO ml_alert (kind, title, text, result) VALUES (%s,%s,%s,%s)",
             (kind, title[:255], text_[:4000], (", ".join(f"{a}: {b}" for a, b in res.items()) or "no channel")[:255]))
        return res
    except Exception as e:  # noqa: BLE001 — polling must go on even if a channel is broken
        print(f"snmp: alert not sent: {e}", file=sys.stderr)
        return {}


# ------------------------------------------------------------------ the minute job
def poll(db, only=None, state_path=STATE, now=None, workers=16):
    now = now or time.time()
    secrets = load_secrets().get("devices", {})
    state = load_json(state_path)
    conf = conf_from(db)
    devs = devices(db, only)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now))
    sample = int(now // 60) % 5 == 0 or only

    def one(d):
        try:
            cl = client(d, secrets.get(str(d["id"]), {}))
            return d, collect(cl, d["kind"] if d["kind_auto"] == 0 or d["status"] != "new" else None), None
        except Timeout as e:
            return d, None, str(e)
        except Exception as e:  # noqa: BLE001 — one odd device must not stop the others
            return d, None, f"{e.__class__.__name__}: {e}"[:200]

    with cf.ThreadPoolExecutor(max_workers=max(1, min(workers, len(devs) or 1))) as ex:
        results = list(ex.map(one, devs))
    alerts_out, report = [], []
    for d, m, err in results:
        did = str(d["id"])
        st = state.setdefault(did, {})
        prev = st.get("last") or {}
        evs = []
        if m is None:
            st["fail"] = st.get("fail", 0) + 1
            if st["fail"] >= 2 and d["status"] != "down":
                db.q("UPDATE ml_snmp_device SET status='down', last_error=%s, last_poll=%s WHERE id=%s", (err[:255], stamp, d["id"]))
                if d["status"] == "up":
                    evs.append(("high", f"📟 {d['name']} ({d['ip']}) does NOT answer — power, cable or network?"))
            else:
                db.q("UPDATE ml_snmp_device SET last_error=%s, last_poll=%s WHERE id=%s", (err[:255], stamp, d["id"]))
            report.append(f"{d['name']:20} {d['ip']:15} no answer ({st['fail']}x): {err}")
        else:
            if d["status"] == "down":
                evs.append(("medium", f"✅ {d['name']} ({d['ip']}) answers again"))
            kind = d["kind"]
            if d["kind_auto"] and d["status"] == "new":
                kind = guess_kind(m)
            evs += events(d, prev, m, st, conf, now)
            dt = now - st.get("t", 0) if st.get("t") else 0
            rt = rates(prev.get("ifs") or {}, m.get("ifs") or {}, dt) if prev else {}
            line = summary(kind, m)
            info = {k: m.get(k) for k in ("cpu", "mem", "disks", "ups", "supplies", "printer", "sensors", "rtt")}
            db.q("UPDATE ml_snmp_device SET status='up', kind=%s, last_ok=%s, last_poll=%s, last_error='', sysname=%s, sysdescr=%s, "
                 "sysobjectid=%s, location=%s, uptime=%s, line=%s, info=%s WHERE id=%s",
                 (kind, stamp, stamp, m["sys"]["name"][:128], m["sys"]["descr"][:500], m["sys"]["objectid"][:128], m["sys"]["location"][:128],
                  m["uptime"], line[:255], json.dumps(info)[:60000], d["id"]))
            if m.get("ifs") is not None:
                db.many("INSERT INTO ml_snmp_if (device_id, ifindex, name, alias, type, speed, admin, oper, in_bps, out_bps, in_err, out_err, changed) "
                        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE name=VALUES(name), alias=VALUES(alias), type=VALUES(type), "
                        "speed=VALUES(speed), admin=VALUES(admin), changed=IF(oper<>VALUES(oper), VALUES(changed), changed), oper=VALUES(oper), "
                        "in_bps=VALUES(in_bps), out_bps=VALUES(out_bps), in_err=VALUES(in_err), out_err=VALUES(out_err)",
                        [(d["id"], int(idx), i["name"][:64], i["alias"][:128], i["type"], i["speed"], i["admin"], i["oper"],
                          rt.get(idx, [0, 0])[0], rt.get(idx, [0, 0])[1], i["inerr"], i["outerr"], stamp) for idx, i in m["ifs"].items() if idx.isdigit()])
                gone = [int(x) for x in (prev.get("ifs") or {}) if x not in m["ifs"] and x.isdigit()]
                if gone:
                    db.q("DELETE FROM ml_snmp_if WHERE device_id=%s AND ifindex IN (" + ",".join(["%s"] * len(gone)) + ")", (d["id"], *gone))
            if sample:
                rows = [(k, v) for k, v in (("cpu", m.get("cpu")), ("mem", m.get("mem")), ("rtt", m.get("rtt")),
                                            ("charge", (m.get("ups") or {}).get("charge")), ("runtime", (m.get("ups") or {}).get("runtime")),
                                            ("load", (m.get("ups") or {}).get("load")), ("in_volt", (m.get("ups") or {}).get("in_volt"))) if v is not None]
                t = [s["value"] for s in m.get("sensors", []) if s["unit"] == "°C"]
                if t:
                    rows.append(("temp", max(t)))
                for idx, (a, b) in rt.items():
                    if m["ifs"][idx]["oper"] == "up":
                        rows += [(f"if:{idx}:in", a), (f"if:{idx}:out", b)]
                db.many("INSERT INTO ml_snmp_sample (device_id, ts, k, v) VALUES (%s,%s,%s,%s)", [(d["id"], stamp, k, float(v)) for k, v in rows])
            st.update({"fail": 0, "t": now, "last": {"uptime": m["uptime"], "ups": m.get("ups"), "printer": m.get("printer"),
                                                    "ifs": {k: {x: i[x] for x in ("in", "out", "oper")} for k, i in (m.get("ifs") or {}).items()}}})
            report.append(f"{d['name']:20} {d['ip']:15} {kind:8} {line}")
        for sev, t in evs:
            db.q("INSERT INTO ml_snmp_event (ts, device_id, ip, severity, text) VALUES (%s,%s,%s,%s,%s)", (stamp, d["id"], d["ip"], sev, t[:500]))
            if d["alerts"] and sev in ("high", "medium"):
                alerts_out.append(t)
    if not only:
        ids = {str(r["id"]) for r in db.q("SELECT id FROM ml_snmp_device")}
        for k in [k for k in state if k not in ids]:
            del state[k]
    save_json(state_path, state)
    if not only and int(now // 60) % 60 == 7:                 # once an hour: old numbers out
        db.q("DELETE FROM ml_snmp_sample WHERE ts < NOW() - INTERVAL 30 DAY OR (k LIKE 'if:%%' AND ts < NOW() - INTERVAL 7 DAY)")
        db.q("DELETE FROM ml_snmp_event WHERE ts < NOW() - INTERVAL 90 DAY")
        db.q("DELETE FROM ml_snmp_trap WHERE ts < NOW() - INTERVAL 90 DAY")
    send_alerts(db, alerts_out)
    try:
        with open(os.path.join(os.path.dirname(state_path), "snmp-poll.stamp"), "w") as f:
            f.write(stamp)
    except OSError:
        pass
    return report


# ------------------------------------------------------------------ looking for devices
def discover(net, community="public", version="2c", timeout=2.5, port=161, limit=1024):
    """Ask every address of a network at once (one socket) -> [{ip, name, descr, objectid, kind}]."""
    n = ipaddress.ip_network(net, strict=False)
    if n.version != 4 or n.num_addresses > limit:
        raise ValueError(f"give an IPv4 network of at most {limit} addresses (like 192.168.88.0/24)")
    hosts = [str(h) for h in (n.hosts() if n.num_addresses > 2 else n)]
    v = 0 if str(version) == "1" else 1
    oids = [SYS["descr"], SYS["objectid"], SYS["name"]]
    ids = {}
    found = {}
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.setblocking(False)
        for rnd in range(2):
            for h in hosts:
                if h in found:
                    continue
                rid = random.randint(1, 2**31 - 1)
                ids[rid] = h
                try:
                    s.sendto(build(v, community, GET, rid, [(o, NULL, None) for o in oids]), (h, port))
                except OSError:
                    pass
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                r, _, _ = select.select([s], [], [], max(0.0, end - time.monotonic()))
                if not r:
                    break
                try:
                    data, addr = s.recvfrom(65535)
                    m = parse(data)
                except (OSError, ValueError):
                    continue
                if m.get("pdu") != RESPONSE or ids.get(m.get("reqid")) != addr[0] or m.get("err"):
                    continue
                vals = {o: val for o, t, val in m["varbinds"] if t not in MISSING}
                descr, oid = text(vals.get(oids[0])), text(vals.get(oids[1]))
                k = guess_kind({"sys": {"descr": descr, "objectid": oid}})
                found[addr[0]] = {"ip": addr[0], "name": text(vals.get(oids[2])), "descr": descr[:200], "objectid": oid, "kind": k}
    return sorted(found.values(), key=lambda x: ipaddress.ip_address(x["ip"]))


# ------------------------------------------------------------------ traps
TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0"
GENERIC = {0: ("1.3.6.1.6.3.1.1.5.1", "coldStart"), 1: ("1.3.6.1.6.3.1.1.5.2", "warmStart"), 2: ("1.3.6.1.6.3.1.1.5.3", "linkDown"),
           3: ("1.3.6.1.6.3.1.1.5.4", "linkUp"), 4: ("1.3.6.1.6.3.1.1.5.5", "authenticationFailure"), 5: ("1.3.6.1.6.3.1.1.5.6", "egpNeighborLoss")}
UPS_ALARMS = {1: "battery bad", 2: "on battery", 3: "battery low", 4: "battery depleted", 5: "temperature bad", 6: "input power bad",
              7: "output bad", 8: "output overload", 9: "on bypass", 10: "bypass bad", 11: "output off (asked)", 12: "UPS off (asked)",
              13: "charger failed", 14: "output off", 15: "UPS system off", 16: "fan failure", 17: "fuse failure", 18: "general fault",
              19: "self-test failed", 20: "communication lost", 21: "waiting for power", 22: "shutdown pending", 23: "shutdown imminent",
              24: "self-test running"}
APC_TRAPS = {1: ("high", "UPS lost communication"), 2: ("high", "UPS overload"), 3: ("medium", "UPS self-test failed"),
             4: ("high", "UPS battery discharged"), 5: ("high", "UPS ON BATTERY — mains power is gone"), 6: ("info", "UPS boosting low mains voltage"),
             7: ("high", "UPS battery LOW — shut down soon"), 8: ("info", "UPS communication back"), 9: ("medium", "Power back — UPS on mains"),
             10: ("info", "UPS self-test passed"), 11: ("medium", "UPS battery no longer low"), 12: ("high", "UPS turned off"),
             13: ("medium", "UPS going to sleep"), 14: ("info", "UPS woke up"), 15: ("medium", "UPS restarting"),
             17: ("medium", "UPS battery needs replacing")}
STD_TRAPS = {"1.3.6.1.6.3.1.1.5.1": ("medium", "Device started (power on / restart)"), "1.3.6.1.6.3.1.1.5.2": ("medium", "Device restarted"),
             "1.3.6.1.6.3.1.1.5.3": ("medium", "Port down"), "1.3.6.1.6.3.1.1.5.4": ("info", "Port up"),
             "1.3.6.1.6.3.1.1.5.5": ("medium", "Wrong SNMP community — someone tried to read this device"),
             "1.3.6.1.2.1.33.2.1": ("high", "UPS ON BATTERY — mains power is gone"), "1.3.6.1.2.1.33.2.2": ("info", "UPS self-test finished"),
             "1.3.6.1.2.1.33.2.3": ("medium", "UPS alarm"), "1.3.6.1.2.1.33.2.4": ("info", "UPS alarm cleared"),
             "1.3.6.1.2.1.43.18.2.0.1": ("medium", "Printer alert")}
IF_INDEX, IF_DESCR, IF_NAME = "1.3.6.1.2.1.2.2.1.1.", "1.3.6.1.2.1.2.2.1.2.", "1.3.6.1.2.1.31.1.1.1.1."
UPS_ALARM_DESCR = "1.3.6.1.2.1.33.1.6.2.1.2."
PRT_ALERT_DESCR = "1.3.6.1.2.1.43.18.1.1.8."


def trap_words(m, ifnames=None):
    """A parsed trap -> {oid, severity, words, ifindex, vars}. ifnames: {ifindex: name} of the sender."""
    vbs = m["varbinds"]
    if m["pdu"] == TRAP1:
        if m["generic"] == 6:
            ent = m["enterprise"]
            oid = f"{ent}.0.{m['specific']}"
        else:
            oid = GENERIC.get(m["generic"], (f"generic.{m['generic']}", ""))[0]
    else:
        oid = next((text(v) if isinstance(v, bytes) else v for o, t, v in vbs if o == TRAP_OID), "")
    sev, words = STD_TRAPS.get(oid, ("info", ""))
    ifindex = None
    if oid.startswith("1.3.6.1.4.1.318.") and oid.rsplit(".", 1)[-1].isdigit():
        sev, words = APC_TRAPS.get(int(oid.rsplit(".", 1)[-1]), ("info", "APC UPS event"))
    for o, t, v in vbs:
        if o.startswith(IF_INDEX):
            ifindex = str(v)
        elif o.startswith(UPS_ALARM_DESCR) and isinstance(v, str):
            n = v.rsplit(".", 1)[-1]
            if v.startswith("1.3.6.1.2.1.33.1.6.3.") and n.isdigit():
                words += f": {UPS_ALARMS.get(int(n), 'alarm ' + n)}"
                if int(n) in (2, 3, 4, 5, 8, 13, 16, 17, 18, 22, 23) and oid.endswith("33.2.3"):
                    sev = "high"
        elif o.startswith(PRT_ALERT_DESCR):
            words += f": {text(v)[:100]}"
    if ifindex is None and oid in ("1.3.6.1.6.3.1.1.5.3", "1.3.6.1.6.3.1.1.5.4"):
        ifindex = next((o.rsplit(".", 1)[-1] for o, t, v in vbs if o.startswith(("1.3.6.1.2.1.2.2.1.7.", "1.3.6.1.2.1.2.2.1.8."))), None)
    if ifindex is not None:
        nm = (ifnames or {}).get(ifindex) or next((text(v) for o, t, v in vbs if o.startswith((IF_NAME, IF_DESCR))), "") or f"if{ifindex}"
        words += f" {nm}"
    if not words:
        extra = [text(v)[:60] for o, t, v in vbs if isinstance(v, bytes) and text(v)][:2]
        words = f"Trap {oid}" + (f": {'; '.join(extra)}" if extra else "")
    rest = [{"oid": o, "value": (text(v) if isinstance(v, bytes) else v)} for o, t, v in vbs if o not in ("1.3.6.1.2.1.1.3.0", TRAP_OID)][:30]
    return {"oid": oid, "severity": sev, "words": words.strip(), "ifindex": ifindex, "vars": rest}


class TrapD:
    """UDP 162 -> ml_snmp_trap (+ alert for the ones that matter). One thread receives, the main loop writes once a second."""

    def __init__(self, db, port=162, bind="0.0.0.0"):
        self.db, self.port, self.bind = db, port, bind
        self.buf, self.lock = [], threading.Lock()
        self.rate, self.dedupe = {}, {}
        self.known, self.known_t = {}, 0
        self.stats = {"received": 0, "stored": 0, "bad_community": 0, "not_snmp": 0, "limited": 0}

    def refresh(self):
        if time.time() - self.known_t < 60:
            return
        sec = load_secrets()
        comms = {sec.get("trap_community") or "public"} | {v.get("community") for v in sec.get("devices", {}).values() if v.get("community")}
        devs = {r["ip"]: r for r in self.db.q("SELECT id, name, ip, alerts FROM ml_snmp_device")}
        ifn = {}
        for r in self.db.q("SELECT device_id, ifindex, name, watch FROM ml_snmp_if"):
            ifn.setdefault(r["device_id"], {})[str(r["ifindex"])] = (r["name"], r["watch"])
        self.known, self.comms, self.ifn, self.known_t = devs, {c.encode() for c in comms}, ifn, time.time()

    def handle(self, data, addr, sock=None):
        self.stats["received"] += 1
        src = addr[0]
        now = time.time()
        b = self.rate.setdefault(src, [now, 0])
        if now - b[0] > 60:
            b[:] = [now, 0]
        b[1] += 1
        if b[1] > 60:
            self.stats["limited"] += 1
            return None
        try:
            m = parse(data)
        except ValueError:
            self.stats["not_snmp"] += 1
            return None
        if m["pdu"] not in (TRAP1, TRAP2, INFORM):
            return None
        if m["community"] not in self.comms:
            self.stats["bad_community"] += 1
            return None
        if m["pdu"] == INFORM and sock is not None:           # an inform wants an answer
            try:
                sock.sendto(build(m["version"], m["community"], RESPONSE, m["reqid"], m["varbinds"]), addr)
            except OSError:
                pass
        dev = self.known.get(src) or (self.known.get(m.get("agent")) if m["pdu"] == TRAP1 else None)
        ifn = {k: v[0] for k, v in self.ifn.get(dev["id"], {}).items()} if dev else {}
        w = trap_words(m, ifn)
        alert = False
        if dev and dev["alerts"]:
            if w["oid"] in ("1.3.6.1.6.3.1.1.5.3", "1.3.6.1.6.3.1.1.5.4"):
                alert = bool(self.ifn.get(dev["id"], {}).get(w["ifindex"], ("", 0))[1]) and w["oid"].endswith(".3")   # only watched ports
            else:
                alert = w["severity"] in ("high", "medium") and w["oid"] != "1.3.6.1.6.3.1.1.5.4"
        if alert:
            key = (src, w["oid"], w["words"])
            alert = now - self.dedupe.get(key, 0) > 600
            if alert:
                self.dedupe[key] = now
        rec = (time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(now)), src, dev["id"] if dev else None, "1" if m["version"] == 0 else "2c",
               w["oid"][:128], w["severity"], w["words"][:255], json.dumps(w["vars"])[:8000], 1 if alert else 0)
        with self.lock:
            self.buf.append((rec, (f"{'🔴' if w['severity'] == 'high' else '🟠'} {dev['name']} ({src}): {w['words']}" if alert else None)))
        return w

    def flush(self):
        with self.lock:
            buf, self.buf = self.buf, []
        if not buf:
            return
        self.db.many("INSERT INTO ml_snmp_trap (ts, src_ip, device_id, version, trap_oid, severity, words, vars, alerted) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                     [r for r, _ in buf])
        self.stats["stored"] += len(buf)
        lines = [a for _, a in buf if a]
        if lines:
            threading.Thread(target=send_alerts, args=(DBFactory(), lines, "devices"), daemon=True).start()

    def serve(self, stop=None):
        fam = socket.AF_INET6 if ":" in self.bind else socket.AF_INET
        sock = socket.socket(fam, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((self.bind, self.port))
        sock.settimeout(1.0)
        print(f"snmp trapd: listening on UDP {self.port}", flush=True)
        last = 0
        while not (stop and stop.is_set()):
            try:
                self.refresh()
            except Exception as e:  # noqa: BLE001 — database restarting: keep receiving
                print(f"snmp trapd: {e}", file=sys.stderr, flush=True)
            try:
                data, addr = sock.recvfrom(65535)
                self.handle(data, addr, sock)
            except socket.timeout:
                pass
            except OSError as e:
                print(f"snmp trapd: {e}", file=sys.stderr, flush=True)
            if time.time() - last >= 1:
                try:
                    self.flush()
                except Exception as e:  # noqa: BLE001
                    print(f"snmp trapd: could not save: {e}", file=sys.stderr, flush=True)
                last = time.time()
        sock.close()


_DBARGS = {"cnf": CNF, "name": DBNAME}


def DBFactory():
    return DB(_DBARGS["cnf"], _DBARGS["name"])


# ------------------------------------------------------------------ command line
def opt(a, k, d=None):
    return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d


def secret_from(a):
    """Secrets come on stdin as JSON (from the dashboard / radius-admin), or --community for a quick test."""
    s = {}
    if "--stdin" in a:
        try:
            s = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            sys.exit("ERROR: secrets on stdin must be JSON")
    if opt(a, "--community"):
        s["community"] = opt(a, "--community")
    for k, rx in (("community", r"^[\x21-\x7e]{1,64}$"), ("user", r"^[\w.@-]{1,32}$"), ("auth", r"^(MD5|SHA|SHA-224|SHA-256|SHA-384|SHA-512)$"),
                  ("authpass", r"^[\x21-\x7e]{8,64}$"), ("priv", r"^(DES|AES|AES-192|AES-256)$"), ("privpass", r"^[\x21-\x7e]{8,64}$")):
        if s.get(k) and not re.match(rx, str(s[k])):
            sys.exit(f"ERROR: bad {k}" + (" (8-64 characters)" if k.endswith("pass") else ""))
    return {k: str(v) for k, v in s.items() if k in ("community", "user", "auth", "authpass", "priv", "privpass") and v}


def valid_ip(ip):
    try:
        return str(ipaddress.ip_address(ip))
    except ValueError:
        sys.exit(f"ERROR: '{ip}' is not an IP address")


def main():
    a = sys.argv[1:]
    _DBARGS.update(cnf=opt(a, "--cnf", CNF), name=opt(a, "--db", DBNAME))
    skip = {"--cnf", "--db", "--version", "--community", "--port", "--name", "--kind", "--state", "--limit", "--hours", "--days", "--bind"}
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] not in skip)]
    cmd = pos[0] if pos else "list"
    ver = opt(a, "--version", "2c")
    if ver not in ("1", "2c", "3"):
        sys.exit("ERROR: --version 1, 2c or 3")
    port = int(opt(a, "--port", "161")) if (opt(a, "--port", "161") or "").isdigit() else sys.exit("ERROR: bad port")
    if cmd in ("get", "walk"):
        if len(pos) < 3:
            sys.exit(f"usage: snmp.py {cmd} IP OID [--community C] [--version 2c]")
        sec = secret_from(a)
        cl = client({"ip": valid_ip(pos[1]), "version": ver, "port": port}, sec)
        try:
            res = cl.get(pos[2:]).items() if cmd == "get" else cl.walk(pos[2])
        except Timeout as e:
            sys.exit(f"ERROR: {e}")
        for o, v in res:
            print(f"{o} = {text(v) if isinstance(v, bytes) else v}")
        return
    if cmd == "probe":
        if len(pos) < 2:
            sys.exit("usage: snmp.py probe IP [--version 2c] [--community C | --stdin]")
        sec = secret_from(a)
        try:
            cl = client({"ip": valid_ip(pos[1]), "version": ver, "port": port}, sec, timeout=2)
            m = collect(cl)
        except (Timeout, ValueError) as e:
            sys.exit(f"ERROR: {e}")
        k = guess_kind(m)
        out = {"ip": pos[1], "kind": k, "line": summary(k, m), "sys": m["sys"], "uptime": m["uptime"], "rtt": m.get("rtt"),
               "ifs": len(m.get("ifs") or {}), "readings": {x: m.get(x) for x in ("cpu", "mem", "ups", "supplies", "printer", "sensors", "disks") if m.get(x)}}
        if "--json" in a:
            print(json.dumps(out))
        else:
            print(f"{out['sys']['name'] or out['ip']}: {k} — {out['line']}\n  {out['sys']['descr'][:150]}\n  up {out['uptime'] // 86400} days, "
                  f"{out['ifs']} interfaces, answer in {out['rtt']} ms")
        return
    if cmd == "discover":
        if len(pos) < 2:
            sys.exit("usage: snmp.py discover 192.168.88.0/24 [--community C | --stdin] [--version 1|2c]")
        if ver == "3":
            sys.exit("ERROR: finding devices works with v1 / v2c (a community); add v3 devices one by one")
        sec = secret_from(a)
        try:
            found = discover(pos[1], sec.get("community") or "public", ver, port=port)
        except ValueError as e:
            sys.exit(f"ERROR: {e}")
        try:
            have = {r["ip"] for r in DBFactory().q("SELECT ip FROM ml_snmp_device")}
        except Exception:  # noqa: BLE001 — works without the database too
            have = set()
        for f in found:
            f["added"] = f["ip"] in have
        if "--json" in a:
            print(json.dumps(found))
        else:
            for f in found:
                print(f"{f['ip']:15} {f['kind']:8} {f['name'][:24]:24} {f['descr'][:60]}{'  (added)' if f['added'] else ''}")
            print(f"{len(found)} device(s) answered")
        return
    if cmd == "send-trap":            # for tests: snmp.py send-trap HOST:PORT OID [community] [v1]
        host, _, p = pos[1].partition(":")
        comm = pos[3] if len(pos) > 3 else "public"
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.sendto(build(1, comm, TRAP2, random.randint(1, 2**31 - 1), [("1.3.6.1.2.1.1.3.0", TIMETICKS, 100), (TRAP_OID, OID, pos[2])]),
                     (host, int(p or 162)))
        return
    if cmd == "router-community":     # one read-only community for all MikroTik routers (made once, kept secret)
        s = load_secrets()
        if not s.get("router_community"):
            import secrets as rnd
            s["router_community"] = "ml" + "".join(rnd.choice("abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(22))
            save_secrets(s)
        print(s["router_community"])
        return
    if cmd == "trap-community":       # traps are accepted with this community or any device's own one
        s = load_secrets()
        if "--stdin" in a:
            c = secret_from(a).get("community")
            if not c:
                sys.exit("ERROR: give a community (1-64 characters, no spaces)")
            s["trap_community"] = c
            save_secrets(s)
            print("trap community saved (the trap receiver takes it within a minute)")
        else:
            c = s.get("trap_community") or "public"
            print(c[:2] + "•" * max(0, len(c) - 2) if c != "public" else "public")
        return
    db = DBFactory()
    if cmd == "poll":
        only = int(pos[1]) if len(pos) > 1 and pos[1].isdigit() else None
        os.makedirs(os.path.dirname(LOCK), exist_ok=True)
        with open(LOCK, "w") as lk:
            try:
                fcntl.flock(lk, fcntl.LOCK_EX | (0 if only else fcntl.LOCK_NB))
            except OSError:
                print("snmp: the last poll is still running")
                return
            rep = poll(db, only, state_path=opt(a, "--state", STATE))
        if "--quiet" not in a:
            print("\n".join(rep) or "No devices yet: radius-admin snmp add IP")
    elif cmd == "add":
        if len(pos) < 2:
            sys.exit("usage: snmp.py add IP [--name N] [--kind K] [--version 2c] [--community C | --stdin]")
        ip = valid_ip(pos[1])
        name = opt(a, "--name", "") or ""
        if name and not re.match(r"^[\w .()@#&+,/-]{1,64}$", name):
            sys.exit("ERROR: name: letters, numbers, space . - _ ( ) / up to 64")
        kind = opt(a, "--kind", "")
        if kind and kind not in KINDS:
            sys.exit(f"ERROR: kind is one of {', '.join(KINDS)}")
        sec = secret_from(a)
        if ver == "3" and not sec.get("user"):
            sys.exit("ERROR: v3 needs a user (and passwords) on stdin")
        if db.q("SELECT id FROM ml_snmp_device WHERE ip=%s AND port=%s", (ip, port)):
            sys.exit(f"ERROR: {ip} is already in the list")
        probe = None
        if "--no-check" not in a:
            try:
                probe = collect(client({"ip": ip, "version": ver, "port": port}, sec, timeout=2))
            except (Timeout, ValueError) as e:
                sys.exit(f"ERROR: {e}. Check: SNMP on in the device, the community / user, and that this server's IP is allowed. "
                         "Add it anyway with --no-check")
        k = kind or (guess_kind(probe) if probe else "other")
        name = name or (probe["sys"]["name"][:64] if probe and probe["sys"]["name"] else ip)
        db.q("INSERT INTO ml_snmp_device (name, ip, port, version, kind, kind_auto, status, created) VALUES (%s,%s,%s,%s,%s,%s,'new',NOW())",
             (name, ip, port, ver, k, 0 if kind else 1))
        did = db.q("SELECT id FROM ml_snmp_device WHERE ip=%s AND port=%s", (ip, port))[0]["id"]
        s = load_secrets()
        s.setdefault("devices", {})[str(did)] = sec
        save_secrets(s)
        if probe:
            poll(db, did)
        print(json.dumps({"id": did, "name": name, "kind": k, "line": summary(k, probe) if probe else ""}) if "--json" in a
              else f"Device #{did} added: {name} ({ip}) — {k}" + (f": {summary(k, probe)}" if probe else " (not checked)"))
    elif cmd == "set":
        if len(pos) < 4 or not pos[1].isdigit():
            sys.exit("usage: snmp.py set ID name|kind|alerts|enabled|watch|secret VALUE [IFINDEX]")
        did, key, val = int(pos[1]), pos[2], pos[3]
        if not db.q("SELECT id FROM ml_snmp_device WHERE id=%s", (did,)):
            sys.exit(f"ERROR: no device #{did}")
        if key == "name":
            if not re.match(r"^[\w .()@#&+,/-]{1,64}$", val):
                sys.exit("ERROR: name: letters, numbers, space . - _ ( ) / up to 64")
            db.q("UPDATE ml_snmp_device SET name=%s WHERE id=%s", (val, did))
        elif key == "kind":
            if val not in KINDS + ("auto",):
                sys.exit(f"ERROR: kind is one of {', '.join(KINDS)} or auto")
            db.q("UPDATE ml_snmp_device SET kind=IF(%s='auto', kind, %s), kind_auto=%s, status=IF(%s='auto','new',status) WHERE id=%s",
                 (val, val, 1 if val == "auto" else 0, val, did))
        elif key in ("alerts", "enabled"):
            if val not in ("on", "off"):
                sys.exit("ERROR: on or off")
            db.q(f"UPDATE ml_snmp_device SET {key}=%s WHERE id=%s", (1 if val == "on" else 0, did))
        elif key == "watch":
            if val not in ("on", "off") or len(pos) < 5 or not pos[4].isdigit():
                sys.exit("usage: snmp.py set ID watch on|off IFINDEX")
            if not db.q("SELECT 1 FROM ml_snmp_if WHERE device_id=%s AND ifindex=%s", (did, int(pos[4]))):
                sys.exit(f"ERROR: device #{did} has no interface {pos[4]}")
            db.q("UPDATE ml_snmp_if SET watch=%s WHERE device_id=%s AND ifindex=%s", (1 if val == "on" else 0, did, int(pos[4])))
        elif key == "secret":
            sec = secret_from(a)
            s = load_secrets()
            s.setdefault("devices", {})[str(did)] = sec
            save_secrets(s)
            if val in ("1", "2c", "3"):
                db.q("UPDATE ml_snmp_device SET version=%s WHERE id=%s", (val, did))
        else:
            sys.exit("ERROR: name, kind, alerts, enabled, watch or secret")
        print(f"device #{did}: {key} {val}" + (f" ({pos[4]})" if key == "watch" else ""))
    elif cmd == "del":
        if len(pos) < 2 or not pos[1].isdigit():
            sys.exit("usage: snmp.py del ID")
        did = int(pos[1])
        r = db.q("SELECT name, ip FROM ml_snmp_device WHERE id=%s", (did,))
        if not r:
            sys.exit(f"ERROR: no device #{did}")
        for t in ("ml_snmp_if", "ml_snmp_sample"):
            db.q(f"DELETE FROM {t} WHERE device_id=%s", (did,))
        db.q("DELETE FROM ml_snmp_device WHERE id=%s", (did,))
        s = load_secrets()
        s.get("devices", {}).pop(str(did), None)
        save_secrets(s)
        print(f"Device #{did} removed: {r[0]['name']} ({r[0]['ip']})")
    elif cmd == "list":
        rows = db.q("SELECT id, name, ip, version, kind, status, line, enabled, alerts, last_ok FROM ml_snmp_device ORDER BY name")
        if "--json" in a:
            print(json.dumps(rows, default=str))
            return
        if not rows:
            print("No devices yet. Add one: radius-admin snmp add 192.168.88.5 [community public]  ·  find them: radius-admin snmp discover 192.168.88.0/24")
        for r in rows:
            st = "OFF" if not r["enabled"] else r["status"].upper()
            print(f"#{r['id']:<3} {r['name'][:22]:22} {r['ip']:15} v{r['version']:3} {r['kind']:8} {st:5} {r['line'] or ''}")
    elif cmd == "show":
        if len(pos) < 2 or not pos[1].isdigit():
            sys.exit("usage: snmp.py show ID")
        r = db.q("SELECT * FROM ml_snmp_device WHERE id=%s", (int(pos[1]),))
        if not r:
            sys.exit(f"ERROR: no device #{pos[1]}")
        d = r[0]
        print(f"#{d['id']} {d['name']} ({d['ip']}:{d['port']}, v{d['version']}) — {d['kind']}, {d['status']}, alerts {'on' if d['alerts'] else 'off'}")
        print(f"  {d['sysdescr'][:200]}")
        print(f"  {d['line']}  ·  up {int(d['uptime'] or 0) // 86400} days  ·  last answer {d['last_ok'] or 'never'}" + (f"  ·  {d['last_error']}" if d["last_error"] else ""))
        for i in db.q("SELECT * FROM ml_snmp_if WHERE device_id=%s ORDER BY ifindex", (d["id"],)):
            print(f"  {i['ifindex']:>5} {i['name'][:20]:20} {i['oper']:5} {i['speed'] or '':>6} in {i['in_bps']:>12} out {i['out_bps']:>12}"
                  f"{'  WATCHED' if i['watch'] else ''}  {i['alias'][:30]}")
    elif cmd == "traps":
        n = int(opt(a, "--limit", "50") or 50)
        rows = db.q("SELECT t.ts, t.src_ip, d.name, t.severity, t.words FROM ml_snmp_trap t LEFT JOIN ml_snmp_device d ON d.id=t.device_id "
                    "ORDER BY t.id DESC LIMIT %s", (min(n, 1000),))
        for r in rows:
            print(f"{r['ts']}  {r['src_ip']:15} {(r['name'] or 'unknown')[:18]:18} {r['severity']:6} {r['words']}")
        if not rows:
            print("No traps yet.")
    elif cmd == "events":
        for r in db.q("SELECT ts, severity, text FROM ml_snmp_event ORDER BY id DESC LIMIT %s", (min(int(opt(a, "--limit", "50") or 50), 1000),)):
            print(f"{r['ts']}  {r['severity']:6} {r['text']}")
    elif cmd == "trapd":
        TrapD(db, int(opt(a, "--port", "162")), opt(a, "--bind", "0.0.0.0")).serve()
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
