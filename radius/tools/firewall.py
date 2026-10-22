#!/usr/bin/env python3
"""Firewall (FortiGate / Untangle style) for the MikroTik routers: objects, policies, port forwards, countries.

  Addresses   named groups of IPs, networks, ranges, website names and countries
  Services    protocol + ports (built-in: HTTP, HTTPS, DNS, RDP, SMB, WINBOX ... + your own)
  Schedules   days + time (built-in: always, office-hours, after-hours, weekend ...)
  Policies    ordered, first match wins: direction, source, destination, service, schedule -> allow / deny / reject, log
  Port forwards (virtual IPs)  outside port -> inside device, open to everyone or only some addresses / countries
  Countries   Geo-IP lists from the five regional internet registries (RIR delegated files), refreshed weekly

The database holds everything (ml_fw_*); `rsc` writes the router part of sync.rsc and `geo-rsc` the country
lists (fetched by the routers only when they change). Run by radius-admin as root:
  firewall.py list|rule|addr|service|schedule|vip|geo|logs|rsc|geo-rsc ...   (see --help)
"""
import argparse, hashlib, ipaddress, json, os, re, sys, time, urllib.request

CNF, DBNAME = "/etc/mikrotiklover-radius/my.cnf", "radius"
GEO_DIR = os.environ.get("ML_GEO_DIR", "/var/lib/mikrotiklover/geo")
GEO_URLS = ["https://ftp.arin.net/pub/stats/arin/delegated-arin-extended-latest",
            "https://ftp.ripe.net/pub/stats/ripencc/delegated-ripencc-latest",
            "https://ftp.apnic.net/stats/apnic/delegated-apnic-latest",
            "https://ftp.lacnic.net/pub/stats/lacnic/delegated-lacnic-latest",
            "https://ftp.afrinic.net/pub/stats/afrinic/delegated-afrinic-latest"]
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
FQDN_RE = re.compile(r"^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
IFACE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$")
DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
MAX_RULES_PER_POLICY = 200

COUNTRIES = dict(x.split(":", 1) for x in (
    "AD:Andorra|AE:United Arab Emirates|AF:Afghanistan|AG:Antigua and Barbuda|AI:Anguilla|AL:Albania|AM:Armenia|AO:Angola|AQ:Antarctica|"
    "AR:Argentina|AS:American Samoa|AT:Austria|AU:Australia|AW:Aruba|AX:Aland Islands|AZ:Azerbaijan|BA:Bosnia and Herzegovina|BB:Barbados|"
    "BD:Bangladesh|BE:Belgium|BF:Burkina Faso|BG:Bulgaria|BH:Bahrain|BI:Burundi|BJ:Benin|BL:Saint Barthelemy|BM:Bermuda|BN:Brunei|BO:Bolivia|"
    "BQ:Caribbean Netherlands|BR:Brazil|BS:Bahamas|BT:Bhutan|BW:Botswana|BY:Belarus|BZ:Belize|CA:Canada|CD:Congo (DRC)|CF:Central African Republic|"
    "CG:Congo|CH:Switzerland|CI:Cote d'Ivoire|CK:Cook Islands|CL:Chile|CM:Cameroon|CN:China|CO:Colombia|CR:Costa Rica|CU:Cuba|CV:Cape Verde|"
    "CW:Curacao|CY:Cyprus|CZ:Czechia|DE:Germany|DJ:Djibouti|DK:Denmark|DM:Dominica|DO:Dominican Republic|DZ:Algeria|EC:Ecuador|EE:Estonia|"
    "EG:Egypt|ER:Eritrea|ES:Spain|ET:Ethiopia|FI:Finland|FJ:Fiji|FK:Falkland Islands|FM:Micronesia|FO:Faroe Islands|FR:France|GA:Gabon|"
    "GB:United Kingdom|GD:Grenada|GE:Georgia|GF:French Guiana|GG:Guernsey|GH:Ghana|GI:Gibraltar|GL:Greenland|GM:Gambia|GN:Guinea|GP:Guadeloupe|"
    "GQ:Equatorial Guinea|GR:Greece|GT:Guatemala|GU:Guam|GW:Guinea-Bissau|GY:Guyana|HK:Hong Kong|HN:Honduras|HR:Croatia|HT:Haiti|HU:Hungary|"
    "ID:Indonesia|IE:Ireland|IL:Israel|IM:Isle of Man|IN:India|IO:British Indian Ocean Territory|IQ:Iraq|IR:Iran|IS:Iceland|IT:Italy|JE:Jersey|"
    "JM:Jamaica|JO:Jordan|JP:Japan|KE:Kenya|KG:Kyrgyzstan|KH:Cambodia|KI:Kiribati|KM:Comoros|KN:Saint Kitts and Nevis|KP:North Korea|"
    "KR:South Korea|KW:Kuwait|KY:Cayman Islands|KZ:Kazakhstan|LA:Laos|LB:Lebanon|LC:Saint Lucia|LI:Liechtenstein|LK:Sri Lanka|LR:Liberia|"
    "LS:Lesotho|LT:Lithuania|LU:Luxembourg|LV:Latvia|LY:Libya|MA:Morocco|MC:Monaco|MD:Moldova|ME:Montenegro|MF:Saint Martin|MG:Madagascar|"
    "MH:Marshall Islands|MK:North Macedonia|ML:Mali|MM:Myanmar|MN:Mongolia|MO:Macao|MP:Northern Mariana Islands|MQ:Martinique|MR:Mauritania|"
    "MS:Montserrat|MT:Malta|MU:Mauritius|MV:Maldives|MW:Malawi|MX:Mexico|MY:Malaysia|MZ:Mozambique|NA:Namibia|NC:New Caledonia|NE:Niger|"
    "NF:Norfolk Island|NG:Nigeria|NI:Nicaragua|NL:Netherlands|NO:Norway|NP:Nepal|NR:Nauru|NU:Niue|NZ:New Zealand|OM:Oman|PA:Panama|PE:Peru|"
    "PF:French Polynesia|PG:Papua New Guinea|PH:Philippines|PK:Pakistan|PL:Poland|PM:Saint Pierre and Miquelon|PR:Puerto Rico|PS:Palestine|"
    "PT:Portugal|PW:Palau|PY:Paraguay|QA:Qatar|RE:Reunion|RO:Romania|RS:Serbia|RU:Russia|RW:Rwanda|SA:Saudi Arabia|SB:Solomon Islands|"
    "SC:Seychelles|SD:Sudan|SE:Sweden|SG:Singapore|SH:Saint Helena|SI:Slovenia|SK:Slovakia|SL:Sierra Leone|SM:San Marino|SN:Senegal|SO:Somalia|"
    "SR:Suriname|SS:South Sudan|ST:Sao Tome and Principe|SV:El Salvador|SX:Sint Maarten|SY:Syria|SZ:Eswatini|TC:Turks and Caicos Islands|TD:Chad|"
    "TG:Togo|TH:Thailand|TJ:Tajikistan|TK:Tokelau|TL:Timor-Leste|TM:Turkmenistan|TN:Tunisia|TO:Tonga|TR:Turkey|TT:Trinidad and Tobago|TV:Tuvalu|"
    "TW:Taiwan|TZ:Tanzania|UA:Ukraine|UG:Uganda|US:United States|UY:Uruguay|UZ:Uzbekistan|VA:Vatican City|VC:Saint Vincent and the Grenadines|"
    "VE:Venezuela|VG:British Virgin Islands|VI:U.S. Virgin Islands|VN:Vietnam|VU:Vanuatu|WF:Wallis and Futuna|WS:Samoa|YE:Yemen|YT:Mayotte|"
    "ZA:South Africa|ZM:Zambia|ZW:Zimbabwe|XK:Kosovo").split("|"))

# name -> (entries, what it is). Entry: "tcp/80,443" "udp/53" "icmp" "gre" "esp" "any"
SERVICES = {
    "ALL": (["any"], "every protocol and port"), "HTTP": (["tcp/80"], "web (plain)"), "HTTPS": (["tcp/443", "udp/443"], "web (secure, incl. QUIC)"),
    "WEB": (["tcp/80,443", "udp/443"], "web: HTTP + HTTPS"), "DNS": (["udp/53", "tcp/53"], "name lookups"), "DOT": (["tcp/853"], "DNS over TLS"),
    "PING": (["icmp"], "ping / ICMP"), "SSH": (["tcp/22"], "SSH"), "TELNET": (["tcp/23"], "Telnet"), "FTP": (["tcp/20-21"], "FTP"),
    "RDP": (["tcp/3389", "udp/3389"], "Windows remote desktop"), "SMB": (["tcp/139,445", "udp/137-138"], "Windows file sharing"),
    "VNC": (["tcp/5900-5901"], "VNC remote screen"), "MYSQL": (["tcp/3306"], "MySQL"), "MSSQL": (["tcp/1433"], "MS-SQL"),
    "SMTP": (["tcp/25,465,587"], "sending mail"), "MAIL": (["tcp/110,143,993,995"], "POP3 / IMAP"), "NTP": (["udp/123"], "time"),
    "WINBOX": (["tcp/8291"], "MikroTik Winbox"), "MIKROTIK-API": (["tcp/8728-8729"], "MikroTik API"), "SNMP": (["udp/161-162"], "SNMP"),
    "SIP": (["udp/5060-5061", "tcp/5060-5061"], "VoIP SIP"), "RTSP": (["tcp/554"], "camera video"), "DVR": (["tcp/37777,8000,554"], "DVR / NVR (Dahua, Hikvision)"),
    "TORRENT": (["tcp/6881-6889", "udp/6881-6889"], "BitTorrent (default ports)"), "OPENVPN": (["udp/1194", "tcp/1194"], "OpenVPN"),
    "WIREGUARD": (["udp/51820"], "WireGuard"), "IPSEC": (["udp/500,4500", "esp"], "IPsec VPN"), "PPTP": (["tcp/1723", "gre"], "PPTP VPN"),
    "L2TP": (["udp/1701"], "L2TP"),
}
# name -> (days, start, end, what it is)
SCHEDULES = {
    "always": ([], "", "", "all the time"), "office-hours": (DAYS[:6], "09:00", "17:00", "Mon-Sat 9:00-17:00"),
    "after-hours": (DAYS, "17:00", "09:00", "every day 17:00-9:00"), "weekdays": (DAYS[:5], "00:00", "23:59", "Mon-Fri all day"),
    "weekend": (DAYS[5:], "00:00", "23:59", "Sat + Sun all day"), "night": (DAYS, "22:00", "06:00", "every day 22:00-6:00"),
}
DIRS = {"out": "LAN → Internet", "in": "Internet → LAN (port forwards)", "wan": "Internet → LAN + router",
        "router": "→ the router itself", "lan": "LAN ↔ LAN"}
ACTIONS = {"allow": "Allow", "deny": "Deny (drop)", "reject": "Reject (tell the app)"}
VIP_RISK = {3389: "RDP", 445: "SMB", 139: "NetBIOS", 23: "Telnet", 21: "FTP", 5900: "VNC", 3306: "MySQL", 1433: "MS-SQL",
            8291: "Winbox", 8728: "MikroTik API", 22: "SSH", 37777: "Dahua DVR", 8000: "Hikvision DVR", 554: "RTSP"}


class Bad(ValueError):
    pass


# ------------------------------------------------------------------ checks
def check_name(n, what="name"):
    if not isinstance(n, str) or not NAME_RE.match(n):
        raise Bad(f"bad {what} '{n}': letters, digits, . _ - (max 32)")
    return n


def addr_entry(e):
    """One address-object entry -> ('net', '1.2.3.0/24') | ('range', 'a-b') | ('fqdn', 'x.com') | ('geo', 'PK')."""
    e = str(e).strip()
    if re.match(r"^(geo:|country:)?[A-Za-z]{2}$", e) and (e.lower().startswith(("geo:", "country:")) or e.isupper()):
        cc = e.split(":")[-1].upper()
        if cc not in COUNTRIES:
            raise Bad(f"unknown country code '{cc}'")
        return "geo", cc
    if "-" in e and re.match(r"^[\d.]+-[\d.]+$", e):
        a, b = (ipaddress.IPv4Address(x) for x in e.split("-"))
        if a > b:
            raise Bad(f"range '{e}': first address is bigger")
        return "range", f"{a}-{b}"
    try:
        return "net", str(ipaddress.IPv4Network(e, strict=False))
    except ValueError:
        pass
    if FQDN_RE.match(e.lower()):
        return "fqdn", e.lower()
    raise Bad(f"'{e}' is not an IP, network, range (a-b), website name or country (geo:PK)")


def service_entry(e):
    """'tcp/80,443' -> ('tcp', '80,443'); 'icmp' -> ('icmp', ''); 'any' -> ('', '')."""
    e = str(e).strip().lower().replace(" ", "/", 1).replace(" ", "")
    if e in ("any", "all"):
        return "", ""
    m = re.match(r"^(tcp|udp|icmp|gre|esp|ah|ospf|sctp|\d{1,3})(?:/([\d,-]+))?$", e)
    if not m:
        raise Bad(f"bad service entry '{e}' (examples: tcp/80,443  udp/5000-5100  icmp  gre)")
    proto, ports = m.group(1), m.group(2) or ""
    if ports and proto not in ("tcp", "udp", "sctp"):
        raise Bad(f"'{e}': only tcp / udp have ports")
    parts = [p for p in ports.split(",") if p]
    if len(parts) > 15:
        raise Bad(f"'{e}': at most 15 ports / ranges in one entry")
    for p in parts:
        lo, _, hi = p.partition("-")
        if not lo.isdigit() or not 1 <= int(lo) <= 65535 or (hi and (not hi.isdigit() or not int(lo) <= int(hi) <= 65535)):
            raise Bad(f"bad port '{p}'")
    return proto, ",".join(parts)


def hhmm(t):
    m = re.match(r"^([01]?\d|2[0-3]):([0-5]\d)$", str(t))
    if not m:
        raise Bad(f"bad time '{t}' (HH:MM)")
    return int(m.group(1)), int(m.group(2))


def ros_time(t, end=False):
    h, m = hhmm(t)
    if end and (h, m) == (23, 59):
        return "23h59m59s"
    return f"{h}h{m}m" if m else (f"{h}h" if h else "0s")


def sched_times(days, start, end):
    """-> list of RouterOS time= values (one, or two when it runs over midnight)."""
    if not start:
        return [None]
    d = ",".join(x for x in DAYS if x in days) or ",".join(DAYS)
    if hhmm(start) < hhmm(end):
        return [f"{ros_time(start)}-{ros_time(end, True)},{d}"]
    return [f"{ros_time(start)}-23h59m59s,{d}", f"0s-{ros_time(end, True)},{d}"]


# ------------------------------------------------------------------ database
class DB:
    def __init__(self, cnf=CNF, name=DBNAME):
        import pymysql, pymysql.cursors
        self.c = pymysql.connect(read_default_file=cnf, database=name, autocommit=True, charset="utf8mb4",
                                 cursorclass=pymysql.cursors.DictCursor)

    def q(self, sql, args=()):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()


def load(db):
    st = {"rules": db.q("SELECT * FROM ml_fw_rule ORDER BY pos, id"),
          "addrs": {r["name"]: r for r in db.q("SELECT * FROM ml_fw_addr ORDER BY name")},
          "services": {r["name"]: r for r in db.q("SELECT * FROM ml_fw_service ORDER BY name")},
          "schedules": {r["name"]: r for r in db.q("SELECT * FROM ml_fw_schedule ORDER BY name")},
          "vips": db.q("SELECT * FROM ml_fw_vip ORDER BY id")}
    for r in st["rules"]:
        for k in ("src", "dst", "service"):
            r[k] = [x for x in (r[k] or "").split(",") if x]
    for r in st["vips"]:
        r["src"] = [x for x in (r["src"] or "").split(",") if x]
    for a in st["addrs"].values():
        a["entries"] = [x for x in (a["entries"] or "").split("\n") if x]
    for s in st["services"].values():
        s["entries"] = [x for x in (s["entries"] or "").split("\n") if x]
    return st


def all_services(st):
    out = {n: {"name": n, "entries": e, "comment": c, "builtin": True} for n, (e, c) in SERVICES.items()}
    for n, s in st["services"].items():
        out[n] = {"name": n, "entries": s["entries"], "comment": s["comment"] or "", "builtin": False}
    return out


def all_schedules(st):
    out = {n: {"name": n, "days": d, "start": a, "end": b, "comment": c, "builtin": True} for n, (d, a, b, c) in SCHEDULES.items()}
    for n, s in st["schedules"].items():
        out[n] = {"name": n, "days": [x for x in (s["days"] or "").split(",") if x], "start": s["start"], "end": s["end"],
                  "comment": s["comment"] or "", "builtin": False}
    return out


def check_addr_ref(st, x):
    """Policy / port-forward source or destination: 'all', an address object, or a country 'geo:PK'."""
    if x == "all":
        return x
    if x.lower().startswith(("geo:", "country:")):
        return "geo:" + addr_entry(x)[1]
    if x not in st["addrs"]:
        raise Bad(f"no address object '{x}' (Firewall → Addresses)")
    return x


def save_rule(db, st, r):
    name = str(r.get("name", "")).strip()
    if not re.match(r"^[\w .,()&+/-]{1,48}$", name):
        raise Bad("policy name: 1-48 letters, digits, spaces")
    if r.get("dir") not in DIRS:
        raise Bad(f"direction: {' | '.join(DIRS)}")
    if r.get("action") not in ACTIONS:
        raise Bad("action: allow | deny | reject")
    src = [check_addr_ref(st, x) for x in (r.get("src") or ["all"])]
    dst = [check_addr_ref(st, x) for x in (r.get("dst") or ["all"])]
    svcs = all_services(st)
    service = list(r.get("service") or ["ALL"])
    for s in service:
        if s not in svcs:
            raise Bad(f"no service '{s}' (Firewall → Services)")
    sched = r.get("schedule") or "always"
    if sched not in all_schedules(st):
        raise Bad(f"no schedule '{sched}'")
    if "all" in src and len(src) > 1 or "all" in dst and len(dst) > 1:
        raise Bad("'all' cannot be mixed with other addresses")
    comment = str(r.get("comment") or "")[:200]
    vals = (name, 1 if r.get("enabled", True) else 0, r["dir"], ",".join(src), ",".join(dst), ",".join(service), sched,
            r["action"], 1 if r.get("log") else 0, comment)
    probe = dict(zip(("name", "enabled", "dir", "src", "dst", "service", "schedule", "action", "log", "comment"), vals))
    probe.update(id=int(r.get("id") or 0), src=src, dst=dst, service=service)
    n = len(rule_lines(st, probe))
    if n > MAX_RULES_PER_POLICY:
        raise Bad(f"this policy would need {n} router rules (max {MAX_RULES_PER_POLICY}): use fewer addresses / services, or one address object")
    if r.get("id"):
        rid = int(r["id"])
        if not db.q("SELECT id FROM ml_fw_rule WHERE id=%s", (rid,)):
            raise Bad(f"no policy #{rid}")
        db.q("UPDATE ml_fw_rule SET name=%s, enabled=%s, dir=%s, src=%s, dst=%s, service=%s, schedule=%s, action=%s, log=%s, comment=%s, "
             "updated=NOW() WHERE id=%s", vals + (rid,))
        return rid, f"policy #{rid} '{name}' saved"
    pos = (db.q("SELECT COALESCE(MAX(pos),0)+10 AS p FROM ml_fw_rule")[0]["p"]) if r.get("where") != "top" else \
        (db.q("SELECT COALESCE(MIN(pos),10)-10 AS p FROM ml_fw_rule")[0]["p"])
    db.q("INSERT INTO ml_fw_rule (pos, name, enabled, dir, src, dst, service, schedule, action, log, comment, created, updated) "
         "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())", (pos,) + vals)
    rid = db.q("SELECT LAST_INSERT_ID() AS id")[0]["id"]
    return rid, f"policy #{rid} '{name}' added"


def rule_action(db, rid, what):
    rows = db.q("SELECT id, pos, name FROM ml_fw_rule ORDER BY pos, id")
    ids = [r["id"] for r in rows]
    if rid not in ids:
        raise Bad(f"no policy #{rid}")
    name = rows[ids.index(rid)]["name"]
    if what == "del":
        db.q("DELETE FROM ml_fw_rule WHERE id=%s", (rid,))
        return f"policy #{rid} '{name}' deleted"
    if what in ("on", "off"):
        db.q("UPDATE ml_fw_rule SET enabled=%s, updated=NOW() WHERE id=%s", (1 if what == "on" else 0, rid))
        return f"policy #{rid} '{name}' {'on' if what == 'on' else 'off'}"
    i = ids.index(rid)
    ids.pop(i)
    j = {"up": max(i - 1, 0), "down": min(i + 1, len(ids)), "top": 0, "bottom": len(ids)}.get(what)
    if j is None:
        if not str(what).isdigit():
            raise Bad("move: up | down | top | bottom | POSITION")
        j = min(max(int(what) - 1, 0), len(ids))
    ids.insert(j, rid)
    for k, x in enumerate(ids):
        db.q("UPDATE ml_fw_rule SET pos=%s WHERE id=%s", ((k + 1) * 10, x))
    return f"policy #{rid} '{name}' is now number {j + 1}"


def used_by(st):
    """object name -> ['policy #3', 'port forward DVR'] (addresses, services, schedules)."""
    out = {}
    for r in st["rules"]:
        for x in r["src"] + r["dst"] + r["service"] + [r["schedule"]]:
            out.setdefault(x, []).append(f"policy #{r['id']}")
    for v in st["vips"]:
        for x in v["src"]:
            out.setdefault(x, []).append(f"port forward {v['name']}")
    return out


def save_addr(db, st, a):
    name = check_name(a.get("name"), "address name")
    if name.lower() == "all" or name.lower().startswith(("geo", "country")):
        raise Bad("this name is reserved")
    entries = [x.strip() for x in (a.get("entries") or []) if str(x).strip()]
    if not entries or len(entries) > 2000:
        raise Bad("1-2000 entries (IP, network, range a-b, website name, or geo:PK)")
    norm = []
    for e in entries:
        k, v = addr_entry(e)
        norm.append(f"geo:{v}" if k == "geo" else v)
    db.q("REPLACE INTO ml_fw_addr (name, entries, comment, updated) VALUES (%s,%s,%s,NOW())",
         (name, "\n".join(dict.fromkeys(norm)), str(a.get("comment") or "")[:200]))
    return f"address '{name}' saved ({len(norm)} entries)"


def save_service(db, st, s):
    name = check_name(s.get("name"), "service name")
    if name in SERVICES:
        raise Bad(f"'{name}' is built in — pick another name")
    entries = [x for x in (s.get("entries") or []) if str(x).strip()]
    if not entries or len(entries) > 20:
        raise Bad("1-20 entries (tcp/80,443  udp/5000-5100  icmp)")
    norm = []
    for e in entries:
        p, ports = service_entry(e)
        norm.append("any" if not p else f"{p}/{ports}" if ports else p)
    db.q("REPLACE INTO ml_fw_service (name, entries, comment, updated) VALUES (%s,%s,%s,NOW())",
         (name, "\n".join(norm), str(s.get("comment") or "")[:200]))
    return f"service '{name}' saved"


def save_schedule(db, st, s):
    name = check_name(s.get("name"), "schedule name")
    if name in SCHEDULES:
        raise Bad(f"'{name}' is built in — pick another name")
    days = [d for d in DAYS if d in (s.get("days") or [])]
    if not days:
        raise Bad("pick at least one day")
    hhmm(s.get("start")), hhmm(s.get("end"))
    if s.get("start") == s.get("end"):
        raise Bad("start and end are the same")
    db.q("REPLACE INTO ml_fw_schedule (name, days, start, end, comment, updated) VALUES (%s,%s,%s,%s,%s,NOW())",
         (name, ",".join(days), s["start"], s["end"], str(s.get("comment") or "")[:200]))
    return f"schedule '{name}' saved"


def del_object(db, st, kind, name):
    table = {"addr": "ml_fw_addr", "service": "ml_fw_service", "schedule": "ml_fw_schedule"}[kind]
    if not db.q(f"SELECT name FROM {table} WHERE name=%s", (name,)):
        raise Bad(f"no {kind} '{name}'" + (" (built-in ones cannot be deleted)" if name in SERVICES or name in SCHEDULES else ""))
    users = used_by(st).get(name)
    if users:
        raise Bad(f"'{name}' is used by {', '.join(users[:5])} — change those first")
    db.q(f"DELETE FROM {table} WHERE name=%s", (name,))
    return f"{kind} '{name}' deleted"


def save_vip(db, st, v):
    name = check_name(v.get("name"), "port forward name")
    proto = v.get("proto", "tcp")
    if proto not in ("tcp", "udp", "both"):
        raise Bad("protocol: tcp | udp | both")
    port, to_port = str(v.get("port", "")), str(v.get("to_port") or v.get("port", ""))
    for p in (port, to_port):
        lo, _, hi = p.partition("-")
        if not lo.isdigit() or not 1 <= int(lo) <= 65535 or (hi and (not hi.isdigit() or int(hi) < int(lo) or int(hi) > 65535)):
            raise Bad(f"bad port '{p}' (one port or a range 5000-5100)")
    if "-" in to_port and to_port != port:
        raise Bad("a port range goes to the same ports inside")
    try:
        ip = ipaddress.IPv4Address(str(v.get("to", "")))
    except ValueError:
        raise Bad("inside address: an IPv4 address")
    if not ip.is_private:
        raise Bad("inside address must be a LAN (private) address")
    src = [check_addr_ref(st, x) for x in (v.get("src") or ["all"])]
    if "all" in src and len(src) > 1:
        raise Bad("'all' cannot be mixed with other addresses")
    wan = str(v.get("wan") or "")
    if wan and not IFACE_RE.match(wan):
        raise Bad("outside interface: an interface name (empty = every internet side)")
    vals = (name, 1 if v.get("enabled", True) else 0, proto, port, str(ip), to_port, ",".join(src), wan, str(v.get("comment") or "")[:200])
    if v.get("id"):
        vid = int(v["id"])
        if not db.q("SELECT id FROM ml_fw_vip WHERE id=%s", (vid,)):
            raise Bad(f"no port forward #{vid}")
        db.q("UPDATE ml_fw_vip SET name=%s, enabled=%s, proto=%s, port=%s, to_ip=%s, to_port=%s, src=%s, wan=%s, comment=%s, updated=NOW() "
             "WHERE id=%s", vals + (vid,))
        msg = f"port forward '{name}' saved"
    else:
        if db.q("SELECT id FROM ml_fw_vip WHERE name=%s", (name,)):
            raise Bad(f"a port forward '{name}' exists")
        db.q("INSERT INTO ml_fw_vip (name, enabled, proto, port, to_ip, to_port, src, wan, comment, created, updated) "
             "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())", vals)
        msg = f"port forward '{name}' added"
    risky = [VIP_RISK[p] for p in range(int(port.split("-")[0]), int(port.split("-")[-1]) + 1) if p in VIP_RISK][:3]
    if risky and src == ["all"]:
        msg += f" — WARNING: {', '.join(risky)} open to the whole internet; limit 'Allowed from' or use a VPN"
    return msg


def vip_action(db, vid, what):
    r = db.q("SELECT name FROM ml_fw_vip WHERE id=%s", (vid,))
    if not r:
        raise Bad(f"no port forward #{vid}")
    if what == "del":
        db.q("DELETE FROM ml_fw_vip WHERE id=%s", (vid,))
        return f"port forward '{r[0]['name']}' deleted"
    db.q("UPDATE ml_fw_vip SET enabled=%s, updated=NOW() WHERE id=%s", (1 if what == "on" else 0, vid))
    return f"port forward '{r[0]['name']}' {what}"


# ------------------------------------------------------------------ router rules
def lists_of(st, ref):
    """Address reference -> router address-list names to match ([None] = any address)."""
    if ref == "all":
        return [None]
    if ref.startswith("geo:"):
        return [f"mlgeo-{ref[4:]}"]
    a = st["addrs"][ref]
    out = [f"mlgeo-{e[4:]}" for e in a["entries"] if e.startswith("geo:")]
    if any(not e.startswith("geo:") for e in a["entries"]):
        out.insert(0, f"mlfw-{ref}")
    return out


def dir_specs(d):
    return {"out": [("mlfw-fwd", "in-interface-list=LAN out-interface-list=!LAN")],
            "in": [("mlfw-fwd", "in-interface-list=!LAN out-interface-list=LAN")],
            "lan": [("mlfw-fwd", "in-interface-list=LAN out-interface-list=LAN")],
            "router": [("mlfw-in", "")],
            "wan": [("mlfw-fwd", "in-interface-list=!LAN"), ("mlfw-in", "in-interface-list=!LAN")]}[d]


def clean(s):
    return re.sub(r'[^\w .,:()&+/-]', "", str(s))[:60]


def rule_lines(st, r):
    svcs, scheds = all_services(st), all_schedules(st)
    sv = []
    for name in r["service"]:
        for e in svcs[name]["entries"]:
            sv.append(service_entry(e))
    if ("", "") in sv:
        sv = [("", "")]
    sc = scheds[r["schedule"]]
    times = sched_times(sc["days"], sc["start"], sc["end"])
    tag = ("WF-fwa-" if r["action"] == "allow" else "WF-fw-") + str(r["id"])
    out = []
    for chain, iface in dir_specs(r["dir"]):
        for s in [l for x in r["src"] for l in lists_of(st, x)]:
            for d in [l for x in r["dst"] for l in lists_of(st, x)]:
                for proto, ports in sv:
                    for t in times:
                        p = [f"chain={chain}"] + ([iface] if iface else [])
                        p += [f"src-address-list={s}"] if s else []
                        p += [f"dst-address-list={d}"] if d else []
                        p += [f"protocol={proto}"] if proto else []
                        p += [f"dst-port={ports}"] if ports else []
                        p += [f"time={t}"] if t else []
                        if r["action"] == "allow":
                            p.append("action=return")
                        elif r["action"] == "deny":
                            p.append("action=drop")
                        else:
                            p.append("action=reject reject-with=" + ("tcp-reset" if proto == "tcp" else "icmp-admin-prohibited"))
                        if r["log"]:
                            p.append(f'log=yes log-prefix="{tag}"')
                        p.append(f'comment="mlfw:{r["id"]} {clean(r["name"])}"')
                        out.append("add " + " ".join(p))
    return out


def vip_lines(st, v):
    out = []
    protos = ["tcp", "udp"] if v["proto"] == "both" else [v["proto"]]
    iface = f"in-interface={v['wan']}" if v["wan"] else "in-interface-list=!LAN"
    for s in [l for x in v["src"] for l in lists_of(st, x)]:
        for p in protos:
            out.append(f"add chain=dstnat {iface} protocol={p} dst-port={v['port']}" + (f" src-address-list={s}" if s else "")
                       + f" action=dst-nat to-addresses={v['to_ip']} to-ports={v['to_port']} comment=\"mlfw-vip:{v['id']} {clean(v['name'])}\"")
    return out


def used_countries(st):
    out = set()
    for r in [r for r in st["rules"] if r["enabled"]] + [v for v in st["vips"] if v["enabled"]]:
        for x in r["src"] + r.get("dst", []):
            for l in lists_of(st, x):
                if l and l.startswith("mlgeo-"):
                    out.add(l[6:])
    return sorted(out)


def rsc(st, geo_url=None, geo_ver=""):
    """Router part of sync.rsc."""
    L = ["# Firewall (dashboard → Firewall, radius-admin firewall): policies, address objects, port forwards",
         "/ip firewall address-list", 'remove [find comment="mlfw"]']
    for name, a in st["addrs"].items():
        for e in a["entries"]:
            if not e.startswith("geo:"):
                L.append(f'add list=mlfw-{name} address={e} comment="mlfw"')
    rules = [r for r in st["rules"] if r["enabled"]]
    L += ["/ip firewall filter", 'remove [find comment~"^mlfw"]']
    if rules:
        L.append('add chain=forward connection-state=new action=jump jump-target=mlfw-fwd comment="mlfw: policies (through the router)"')
        L.append('add chain=input connection-state=new action=jump jump-target=mlfw-in comment="mlfw: policies (to the router)"')
        for r in rules:
            L += rule_lines(st, r)
        L.append('move [find comment~"^mlfw: policies"] destination=0')
    L += ["/ip firewall nat", 'remove [find comment~"^mlfw-vip:"]']
    for v in st["vips"]:
        if v["enabled"]:
            L += vip_lines(st, v)
    if geo_url and geo_ver:
        L += ["# country lists (Firewall → Countries): downloaded only when they change",
              ":global mlGeoVer", f':if ($mlGeoVer != "{geo_ver}") do={{', "  :do {",
              f'    /tool fetch url="{geo_url}" check-certificate=yes-without-crl dst-path=ml-geo.rsc', "    :delay 2s",
              "    /import file-name=ml-geo.rsc", f'    :set mlGeoVer "{geo_ver}"', f'    :log info "ml-sync: country lists updated ({geo_ver})"',
              '  } on-error={ :log warning "ml-sync: country lists not downloaded" }', "}"]
    return "\n".join(L) + "\n"


# ------------------------------------------------------------------ countries (Geo-IP)
def parse_delegated(lines):
    """RIR delegated stats -> {CC: [IPv4Network]} (allocated / assigned IPv4 only)."""
    out = {}
    for line in lines:
        f = line.strip().split("|")
        if len(f) < 7 or f[2] != "ipv4" or f[6] not in ("allocated", "assigned") or len(f[1]) != 2:
            continue
        try:
            start, n = ipaddress.IPv4Address(f[3]), int(f[4])
            nets = ipaddress.summarize_address_range(start, start + n - 1)
        except (ValueError, ipaddress.AddressValueError):
            continue
        out.setdefault(f[1].upper(), []).extend(nets)
    return out


def geo_write(data, source):
    os.makedirs(GEO_DIR, exist_ok=True)
    counts = {}
    for cc, nets in data.items():
        if cc not in COUNTRIES:
            continue
        nets = list(ipaddress.collapse_addresses(nets))
        counts[cc] = len(nets)
        tmp = os.path.join(GEO_DIR, f".{cc}.tmp")
        with open(tmp, "w") as f:
            f.write("\n".join(map(str, nets)) + "\n")
        os.replace(tmp, os.path.join(GEO_DIR, f"{cc}.txt"))
    meta = {"updated": time.strftime("%Y-%m-%d %H:%M"), "source": source, "counts": counts}
    with open(os.path.join(GEO_DIR, "meta.json"), "w") as f:
        json.dump(meta, f)
    return meta


def geo_meta():
    try:
        with open(os.path.join(GEO_DIR, "meta.json")) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"updated": "", "source": "", "counts": {}}


def geo_update(urls):
    data, got, errs = {}, [], []
    for u in urls:
        try:
            with urllib.request.urlopen(u, timeout=120) as r:
                part = parse_delegated(r.read().decode("ascii", "replace").splitlines())
            for cc, nets in part.items():
                data.setdefault(cc, []).extend(nets)
            got.append(u.split("/")[2])
        except Exception as e:  # noqa: BLE001 - one registry down must not stop the others
            errs.append(f"{u.split('/')[2]}: {e}")
    if not data:
        raise Bad("no country data downloaded: " + "; ".join(errs))
    meta = geo_write(data, ", ".join(got))
    return meta, errs


def geo_rsc(countries):
    L = ["# MikrotikLover country lists (Firewall → Countries)", "/ip firewall address-list", 'remove [find comment="mlgeo"]']
    for cc in countries:
        try:
            with open(os.path.join(GEO_DIR, f"{cc}.txt")) as f:
                nets = [l.strip() for l in f if l.strip()]
        except OSError:
            nets = []
        L += [f'add list=mlgeo-{cc} address={n} comment="mlgeo"' for n in nets]
    text = "\n".join(L) + "\n"
    return text, (hashlib.sha256(text.encode()).hexdigest()[:16] if countries else "")


def lookup(ip):
    """Which country an IPv4 address belongs to (from the downloaded lists)."""
    a = ipaddress.IPv4Address(ip)
    for f in sorted(os.listdir(GEO_DIR)) if os.path.isdir(GEO_DIR) else []:
        if re.match(r"^[A-Z]{2}\.txt$", f):
            with open(os.path.join(GEO_DIR, f)) as fh:
                for l in fh:
                    if a in ipaddress.IPv4Network(l.strip()):
                        return f[:2]
    return ""


# ------------------------------------------------------------------ logs
FW_LOG_RE = re.compile(r"^(\S+) (\S+) .*?WF-fw(a?)-(\d+)\b.*?(?:proto (\w+)[^,]*, )?(\d+\.\d+\.\d+\.\d+)(?::(\d+))?->(\d+\.\d+\.\d+\.\d+)(?::(\d+))?")


def parse_logs(lines, since=0):
    out = []
    for line in lines:
        m = FW_LOG_RE.search(line)
        if not m:
            continue
        t, router, allowed, rid, proto, src, sport, dst, dport = m.groups()
        try:
            from datetime import datetime
            ts = datetime.fromisoformat(t).timestamp()
        except ValueError:
            continue
        if ts < since:
            continue
        out.append({"time": t[:19].replace("T", " "), "router": router, "rule": int(rid), "action": "allow" if allowed else "deny",
                    "proto": (proto or "").lower(), "src": src, "dst": dst, "port": int(dport) if dport else 0})
    return out


# ------------------------------------------------------------------ CLI
def show(st):
    svcs, scheds = all_services(st), all_schedules(st)
    print(f"{'#':>3} {'ID':>4}  {'ON':3} {'NAME':24} {'DIRECTION':30} {'SOURCE':18} {'DESTINATION':18} {'SERVICE':14} {'SCHEDULE':13} ACTION")
    for i, r in enumerate(st["rules"], 1):
        print(f"{i:>3} {r['id']:>4}  {'on' if r['enabled'] else 'off':3} {r['name'][:24]:24} {DIRS[r['dir']]:30} {','.join(r['src'])[:18]:18} "
              f"{','.join(r['dst'])[:18]:18} {','.join(r['service'])[:14]:14} {r['schedule'][:13]:13} {r['action']}{' +log' if r['log'] else ''}")
    if not st["rules"]:
        print("  (no policies — everything passes to the router's own rules)")
    print(f"\nport forwards: {len(st['vips'])}   addresses: {len(st['addrs'])}   services: {len(svcs)}   schedules: {len(scheds)}   "
          f"countries used: {', '.join(used_countries(st)) or '-'}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cnf", default=CNF)
    ap.add_argument("--db", default=DBNAME)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("json")
    p = sub.add_parser("rule")
    p.add_argument("what", choices=["save", "add", "del", "on", "off", "move"])
    p.add_argument("args", nargs="*")
    p.add_argument("--dir", default="out")
    p.add_argument("--src", default="all")
    p.add_argument("--dst", default="all")
    p.add_argument("--service", default="ALL")
    p.add_argument("--schedule", default="always")
    p.add_argument("--action", default="deny")
    p.add_argument("--log", action="store_true")
    p.add_argument("--top", action="store_true")
    for k in ("addr", "service", "schedule"):
        p = sub.add_parser(k)
        p.add_argument("what", choices=["save", "set", "del", "list"])
        p.add_argument("args", nargs="*")
    p = sub.add_parser("vip")
    p.add_argument("what", choices=["save", "add", "del", "on", "off", "list"])
    p.add_argument("args", nargs="*")
    p.add_argument("--proto", default="tcp")
    p.add_argument("--src", default="all")
    p = sub.add_parser("geo")
    p.add_argument("what", choices=["update", "import", "status", "lookup", "list"])
    p.add_argument("args", nargs="*")
    p = sub.add_parser("rsc")
    p.add_argument("--geo-url", default="")
    p = sub.add_parser("geo-rsc")
    p.add_argument("--out", required=True)
    p = sub.add_parser("logs")
    p.add_argument("--file", default="/var/log/mikrotik/webfilter.log")
    p.add_argument("--n", type=int, default=50)
    a = ap.parse_args(argv)

    if a.cmd == "geo" and a.what in ("import", "status", "lookup", "list"):
        if a.what == "import":
            if not a.args:
                raise Bad("usage: geo import FILE...  (RIR delegated stats files)")
            data = {}
            for fn in a.args:
                with open(fn, encoding="ascii", errors="replace") as f:
                    for cc, nets in parse_delegated(f).items():
                        data.setdefault(cc, []).extend(nets)
            if not data:
                raise Bad("no IPv4 country lines found (expected RIR delegated stats: registry|CC|ipv4|start|count|date|status)")
            m = geo_write(data, "file " + ", ".join(os.path.basename(x) for x in a.args))
            print(f"country lists: {len(m['counts'])} countries, {sum(m['counts'].values())} networks")
        elif a.what == "lookup":
            for ip in a.args:
                cc = lookup(ip)
                print(f"{ip}  {cc or '?'}  {COUNTRIES.get(cc, 'not in the country lists')}")
        elif a.what == "list":
            m = geo_meta()
            for cc, name in sorted(COUNTRIES.items(), key=lambda x: x[1]):
                print(f"{cc}  {name:34} {m['counts'].get(cc, 0):>6} networks")
        else:
            m = geo_meta()
            print(f"country lists: {len(m['counts'])} countries, {sum(m['counts'].values())} networks, updated {m['updated'] or 'never'}"
                  f" ({m['source'] or '-'})")
        return 0
    if a.cmd == "logs":
        from collections import deque
        try:
            with open(a.file, errors="replace") as f:
                rows = parse_logs(deque(f, 20000))
        except OSError:
            rows = []
        for r in rows[-a.n:]:
            print(f"{r['time']}  #{r['rule']:<4} {r['action']:6} {r['proto']:4} {r['src']} -> {r['dst']}:{r['port']}  ({r['router']})")
        return 0

    db = DB(a.cnf, a.db)
    st = load(db)
    if a.cmd == "list":
        show(st)
    elif a.cmd == "json":
        json.dump({"rules": st["rules"], "addrs": list(st["addrs"].values()), "services": list(all_services(st).values()),
                   "schedules": list(all_schedules(st).values()), "vips": st["vips"]}, sys.stdout, default=str)
    elif a.cmd == "rsc":
        meta_ver = ""
        cs = used_countries(st)
        if cs:
            _, meta_ver = geo_rsc(cs)
        sys.stdout.write(rsc(st, a.geo_url, meta_ver))
    elif a.cmd == "geo-rsc":
        text, ver = geo_rsc(used_countries(st))
        with open(a.out, "w") as f:
            f.write(text)
        missing = [c for c in used_countries(st) if not geo_meta()["counts"].get(c)]
        print(f"{ver or 'none'}" + (f" missing:{','.join(missing)}" if missing else ""))
    elif a.cmd == "geo":
        urls = a.args or [u.strip() for u in os.environ.get("GEO_URLS", "").split() if u.strip()] or GEO_URLS
        meta, errs = geo_update(urls)
        print(f"country lists: {len(meta['counts'])} countries, {sum(meta['counts'].values())} networks from {meta['source']}"
              + (f" (not reached: {'; '.join(errs)})" if errs else ""))
    elif a.cmd == "rule":
        if a.what == "save":
            print(save_rule(db, st, json.load(sys.stdin))[1])
        elif a.what == "add":
            if not a.args:
                raise Bad("usage: rule add NAME --dir out|in|wan|router|lan --src A,B --dst A --service RDP,SMB --action deny|reject|allow")
            print(save_rule(db, st, {"name": " ".join(a.args), "dir": a.dir, "src": a.src.split(","), "dst": a.dst.split(","),
                                     "service": a.service.split(","), "schedule": a.schedule, "action": a.action, "log": a.log,
                                     "where": "top" if a.top else ""})[1])
        else:
            if not a.args or not a.args[0].isdigit():
                raise Bad(f"usage: rule {a.what} ID" + (" up|down|top|bottom|POSITION" if a.what == "move" else ""))
            print(rule_action(db, int(a.args[0]), a.args[1] if a.what == "move" and len(a.args) > 1 else a.what))
    elif a.cmd in ("addr", "service", "schedule"):
        if a.what == "list":
            objs = list(st["addrs"].values()) if a.cmd == "addr" else list((all_services if a.cmd == "service" else all_schedules)(st).values())
            u = used_by(st)
            for o in objs:
                desc = " ".join(o["entries"]) if "entries" in o else (f"{','.join(o['days'])} {o['start']}-{o['end']}" if o["start"] else "always")
                print(f"{o['name']:20} {desc[:60]:60} {('used: ' + ', '.join(u.get(o['name'], [])))[:40]}")
        elif a.what == "del":
            if not a.args:
                raise Bad(f"usage: {a.cmd} del NAME")
            print(del_object(db, st, a.cmd, a.args[0]))
        else:
            if a.what == "save":
                obj = json.load(sys.stdin)
            elif a.cmd == "schedule":
                if len(a.args) < 3 or "-" not in a.args[2]:
                    raise Bad("usage: schedule set NAME mon,tue,... HH:MM-HH:MM")
                obj = {"name": a.args[0], "days": a.args[1].split(","), "start": a.args[2].split("-")[0], "end": a.args[2].split("-")[1]}
            else:
                if len(a.args) < 2:
                    raise Bad(f"usage: {a.cmd} set NAME ENTRY [ENTRY...]")
                obj = {"name": a.args[0], "entries": a.args[1:]}
            print({"addr": save_addr, "service": save_service, "schedule": save_schedule}[a.cmd](db, st, obj))
    elif a.cmd == "vip":
        if a.what == "list":
            for v in st["vips"]:
                print(f"{v['id']:>3} {'on' if v['enabled'] else 'off':3} {v['name']:20} {v['proto']}/{v['port']} -> {v['to_ip']}:{v['to_port']}"
                      f"  from {','.join(v['src'])}")
        elif a.what == "save":
            print(save_vip(db, st, json.load(sys.stdin)))
        elif a.what == "add":
            if len(a.args) < 3:
                raise Bad("usage: vip add NAME OUTSIDE-PORT INSIDE-IP[:PORT] [--proto tcp|udp|both] [--src office,geo:PK]")
            ip, _, tp = a.args[2].partition(":")
            print(save_vip(db, st, {"name": a.args[0], "port": a.args[1], "to": ip, "to_port": tp or a.args[1], "proto": a.proto,
                                    "src": a.src.split(",")}))
        else:
            if not a.args or not a.args[0].isdigit():
                raise Bad(f"usage: vip {a.what} ID")
            print(vip_action(db, int(a.args[0]), a.what))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Bad as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        print(f"ERROR: bad input: {e}", file=sys.stderr)
        sys.exit(2)
