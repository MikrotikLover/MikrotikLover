#!/usr/bin/env python3
"""Security detective: infected devices (virus), hacker attacks, DDoS attacks and ransomware.

Three sources, four categories:
  virus   a LAN device looks up malware / phishing / crypto-mining names (threat lists), asks for
          many random names that do not exist (DGA malware), talks to a botnet server, sends spam
          to many mail servers, scans the internet or the local network, or floods someone (DDoS bot)
  attack  someone scans your ports, guesses passwords (SSH, RDP, Winbox, router login, Wi-Fi /
          hotspot users, the dashboard) or comes from a known attacker network
  ddos    floods towards your network, by type: SYN flood, UDP flood, ICMP flood, HTTP flood, and
          reflection/amplification by service (DNS, NTP, SSDP, memcached, CLDAP, SNMP ...)
  ransomware  what ransomware does on the network before and while it locks files: Tor and ransom-note
          (Tor gateway) sites, spreading inside the LAN over SMB / RDP, much more upload than the device's
          own usual (data stolen first), file-sharing upload sites / rclone, and a sudden mass of SMB data
          with a file server (files being encrypted). ransom_risk() turns a device's signals into 0-100.

FlowWatch is fed every flow by flowcollector.py (one-minute windows); the hourly scan reads the DNS
log, the router logs and the RADIUS / dashboard login failures.

  sentinel.py sql [--cnf FILE] [--db NAME]   SQL for the hourly log scan (since yesterday)
  sentinel.py risk [--cnf FILE] [--db NAME]   ransomware risk per device (last 24 h): ip, user, score, signals
  sentinel.py update                          download the threat lists (malware, phishing, mining,
                                              botnet and attacker IPs) into /var/lib/mikrotiklover
"""
import bisect, ipaddress, math, os, re, subprocess, sys, time, urllib.request
from collections import Counter, defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdnmap  # noqa: E402

STATE = cdnmap.STATE
LOGDIR = os.environ.get("MLREPORT_LOGDIR", "/var/log/mikrotik")
DOMAIN_FILE = os.path.join(STATE, "threat-domains.txt")    # name<TAB>list
IP_FILE = os.path.join(STATE, "threat-ips.txt")            # network<TAB>list
HOSTS_FILE = os.path.join(STATE, "threat-hosts")           # dnsmasq addn-hosts (server-side blocking)
KEEP_DAYS = int(os.environ.get("SECURITY_DAYS", "180"))

FEEDS_DOMAINS = [
    ("Malware (URLhaus)", "https://urlhaus.abuse.ch/downloads/hostfile/"),
    ("Malware (ThreatFox)", "https://threatfox.abuse.ch/downloads/hostfile/"),
    ("Malware (Blackbook)", "https://raw.githubusercontent.com/stamparm/blackbook/master/blackbook.txt"),
    ("Phishing (Phishing Army)", "https://phishing.army/download/phishing_army_blocklist.txt"),
    ("Crypto mining (NoCoin)", "https://raw.githubusercontent.com/hoshsadiq/adblock-nocoin-list/master/hosts.txt"),
]
FEEDS_IPS = [
    ("Botnet server (Feodo Tracker)", "https://feodotracker.abuse.ch/downloads/ipblocklist.txt"),
    ("Hijacked network (Spamhaus DROP)", "https://www.spamhaus.org/drop/drop.txt"),
    ("Attacker network (FireHOL level 1)", "https://raw.githubusercontent.com/firehol/blocklist-ipsets/master/firehol_level1.netset"),
]
MINING_RE = re.compile(r"(^|[.-])(xmr|monero|nicehash|minergate|nanopool|ethermine|f2pool|2miners|hashvault|supportxmr|"
                       r"moneroocean|unmineable|herominers|coinhive|cryptonight|miningpool|mining-pool|minexmr)")
DOMAIN_RE = re.compile(r"^[a-z0-9_]([a-z0-9_-]{0,62}\.)+[a-z0-9-]{2,63}$")

AUTH_PORTS = {22: "SSH", 23: "Telnet", 21: "FTP", 3389: "RDP (remote desktop)", 8291: "Winbox", 8728: "MikroTik API",
              8729: "MikroTik API", 5900: "VNC", 3306: "MySQL", 1433: "MS-SQL", 5060: "SIP (VoIP)", 445: "SMB (Windows)",
              110: "POP3", 143: "IMAP", 25: "SMTP"}
WORM_PORTS = {23: "Telnet (Mirai)", 2323: "Telnet (Mirai)", 22: "SSH", 445: "SMB (WannaCry)", 3389: "RDP", 5555: "Android ADB",
              7547: "TR-069 (router worm)", 8291: "Winbox", 80: "HTTP", 8080: "HTTP"}
AMP_PORTS = {53: "DNS", 123: "NTP", 1900: "SSDP", 11211: "memcached", 389: "CLDAP", 19: "Chargen", 161: "SNMP",
             3702: "WS-Discovery", 5353: "mDNS", 37810: "DVR (DHAP)", 10001: "Ubiquiti discovery", 3283: "Apple Remote Desktop",
             111: "Portmap", 1194: "OpenVPN", 3478: "STUN", 27015: "Steam / game server"}
MINING_PORTS = {3333, 4444, 7777, 14444, 14433, 45700}
# ransomware moves inside the LAN over these (WannaCry, Ryuk, LockBit …)
LATERAL_PORTS = {445: "SMB", 139: "NetBIOS", 3389: "RDP", 135: "RPC", 5985: "WinRM", 5986: "WinRM"}
TOR_PORTS = {9001, 9030, 9050, 9051, 9150}
# ransom notes send victims to a Tor site, often through a web gateway; a name ending in .onion asked
# from the normal DNS is a Tor client leaking
ONION_RE = re.compile(r"(\.onion(\.[a-z0-9-]+)*$)|((^|\.)(onion\.(ws|ly|pet|to|ink|re|cab|city|direct|sh|dog|moe|rip|top|si|nu|link|lu|cloud)"
                      r"|tor2web\.[a-z]+|torproxy\.[a-z]+|onion-router\.[a-z]+|darknet\.to)$)")
# anonymous upload sites (not the big cloud drives people use every day) and the data-copy tool rclone
EXFIL_SITES = ("mega.nz", "mega.co.nz", "mega.io", "transfer.sh", "anonfiles.com", "gofile.io", "file.io", "sendspace.com", "temp.sh",
               "catbox.moe", "pixeldrain.com", "oshi.at", "bashupload.com", "ufile.io", "filetransfer.io", "anonymfile.com", "bayfiles.com",
               "uploadfiles.io", "filebin.net", "tmpfiles.org", "0x0.st", "put.re", "files.catbox.moe", "litterbox.catbox.moe")
EXFIL_TOOLS = ("rclone.org", "downloads.rclone.org", "beta.rclone.org")

# per one-minute window; flowcollector scales them to its flush interval. Override in
# /etc/mikrotiklover-radius/radius.conf as SEC_<NAME>=value
THRESHOLDS = {
    "SCAN_PORTS": 25,        # one outside IP touches this many different ports
    "SWEEP_HOSTS": 40,       # ... or this many of your IPs on one port
    "BRUTE_FLOWS": 15,       # connections to one login port of one host
    "SPAM_HOSTS": 15,        # LAN device -> different mail servers (port 25)
    "WORM_HOSTS": 30,        # LAN device -> different internet hosts on a worm port
    "LAN_SCAN_HOSTS": 30,    # LAN device -> different LAN hosts
    "FLOOD_FLOWS": 3000,     # small connections towards one target
    "FLOOD_SOURCES": 50,     # ... from at least this many sources = DDoS (fewer = DoS)
    "AMP_BYTES": 20_000_000, # bytes from one amplification service port to one target
    "AMP_SOURCES": 10,
    "UDP_BYTES": 300_000_000,
    "ICMP_PKTS": 30000,
    "BOT_FLOWS": 2000,       # LAN device -> one target, small connections (part of a DDoS)
    "DGA_NAMES": 25,         # random-looking names that do not exist, per device and hour
    "ROUTER_LOGIN_FAILS": 5,
    "ARP_TAKEOVER": 3,          # one device takes over this many addresses in a day = ARP spoofing
    "RADIUS_REJECTS": 15,
    "DASHBOARD_LOGIN_FAILS": 8,
    "LATERAL_HOSTS": 8,             # LAN device -> this many LAN devices on SMB / RDP / RPC in a minute
    "SMB_BURST_MB": 1000,           # MB with one file server over SMB in a minute (mass encryption)
    "EXFIL_MB": 300,                # MB uploaded to one internet host in a minute
    "EXFIL_HOUR_MB": 1500,          # an hour's upload at least this big ...
    "EXFIL_FACTOR": 10,             # ... and this many times the device's own usual busy hour
}


def thresholds(conf=None):
    t = dict(THRESHOLDS)
    for k in t:
        v = (conf or {}).get("SEC_" + k)
        if v and v.isdigit():
            t[k] = int(v)
    return t


# ------------------------------------------------------------------ threat lists
class Threats:
    def __init__(self, domain_file=DOMAIN_FILE, ip_file=IP_FILE):
        self.domains = {}
        self.ranges, self.starts = [], []
        try:
            for line in open(domain_file, encoding="utf-8"):
                d, _, src = line.rstrip("\n").partition("\t")
                if d:
                    self.domains[d] = src
        except OSError:
            pass
        items = []
        try:
            for line in open(ip_file, encoding="utf-8"):
                n, _, src = line.rstrip("\n").partition("\t")
                try:
                    net = ipaddress.ip_network(n, strict=False)
                except ValueError:
                    continue
                items.append((int(net.network_address), int(net.broadcast_address), src))
        except OSError:
            pass
        items.sort()
        self.ranges = items
        self.starts = [a for a, _, _ in items]

    def domain(self, host):
        labels = host.split(".")
        for i in range(len(labels) - 1):
            src = self.domains.get(".".join(labels[i:]))
            if src:
                return src
        if MINING_RE.search(host):
            return "Crypto mining (pool name)"
        return None

    def ip(self, ip):
        try:
            x = int(ipaddress.ip_address(ip))
        except ValueError:
            return None
        i = bisect.bisect_right(self.starts, x) - 1
        for j in range(i, max(i - 30, -1), -1):
            a, b, src = self.ranges[j]
            if a <= x <= b:
                return src
        return None


def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "MikrotikLover-RADIUS"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", "replace")


def update(state=STATE):
    """Download every list; keeps the old file of a kind when all its downloads fail."""
    doms, nets, failed = {}, {}, []
    for name, url in FEEDS_DOMAINS:
        try:
            n = 0
            for line in _fetch(url).splitlines():
                line = line.split("#", 1)[0].strip().lower()
                if not line:
                    continue
                parts = line.split()
                d = parts[1] if len(parts) > 1 and re.match(r"^(0\.0\.0\.0|127\.0\.0\.1)$", parts[0]) else parts[0]
                if d in ("localhost", "0.0.0.0") or len(d) > 253 or not DOMAIN_RE.match(d):
                    continue
                doms.setdefault(d, name)
                n += 1
            print(f"{name}: {n} names")
        except OSError as e:
            failed.append(f"{name}: {e}")
    for name, url in FEEDS_IPS:
        try:
            n = 0
            for line in _fetch(url).splitlines():
                tok = line.split(";", 1)[0].split("#", 1)[0].strip().split()
                if not tok:
                    continue
                try:
                    net = ipaddress.ip_network(tok[0], strict=False)
                except ValueError:
                    continue
                if net.version != 4 or not net.is_global or net.prefixlen < 8:
                    continue
                nets.setdefault(str(net), name)
                n += 1
            print(f"{name}: {n} networks")
        except OSError as e:
            failed.append(f"{name}: {e}")
    for f in failed:
        print(f"warning: {f}", file=sys.stderr)
    os.makedirs(state, exist_ok=True)

    def write(path, lines):
        tmp = path + ".tmp"
        with open(tmp, "w") as fh:
            fh.write("\n".join(lines) + ("\n" if lines else ""))
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    if doms:
        write(os.path.join(state, "threat-domains.txt"), [f"{d}\t{s}" for d, s in sorted(doms.items())])
        write(os.path.join(state, "threat-hosts"), [f"0.0.0.0 {d}" for d in sorted(doms)])
    if nets:
        write(os.path.join(state, "threat-ips.txt"), [f"{n}\t{s}" for n, s in sorted(nets.items())])
    if not doms and not nets:
        raise SystemExit("no threat list could be downloaded; keeping the old ones")
    print(f"threat lists: {len(doms)} names, {len(nets)} networks")


# ------------------------------------------------------------------ events
def day_of(t):
    return time.strftime("%Y-%m-%d", time.localtime(t))


class Events:
    """(day, category, type, source, src, dst) -> {severity, detail, hits, first, last, user}"""
    SEV = {"low": 0, "medium": 1, "high": 2}

    def __init__(self):
        self.ev = {}

    def add(self, t, category, typ, source, src, dst="", detail="", severity="medium", hits=1, user="", last=None):
        k = (day_of(t), category, typ[:64], source, src, dst)
        e = self.ev.get(k)
        if not e:
            e = self.ev[k] = {"severity": severity, "detail": detail[:255], "hits": 0, "first": t, "last": t, "user": user}
        e["hits"] += hits
        e["first"], e["last"] = min(e["first"], t), max(e["last"], t, last or t)
        if self.SEV[severity] > self.SEV[e["severity"]]:
            e["severity"] = severity
        if detail:
            e["detail"] = detail[:255]
        e["user"] = user or e["user"]

    def rows(self):
        return [(k, v) for k, v in sorted(self.ev.items(), key=lambda kv: kv[1]["first"])]


def entropy(s):
    c = Counter(s)
    return -sum(n / len(s) * math.log2(n / len(s)) for n in c.values())


def looks_random(host):
    """DGA-like: a long first label that is mostly random letters/digits."""
    label = max(host.split(".")[:-1] or [""], key=len)
    if len(label) < 12 or "-" in label:
        return False
    vowels = sum(ch in "aeiou" for ch in label) / len(label)
    digits = sum(ch.isdigit() for ch in label) / len(label)
    return entropy(label) >= 3.4 and (vowels < 0.25 or digits > 0.25)


# ------------------------------------------------------------------ hourly log scan
LOGIN_FAIL_RE = re.compile(r"login failure for user (\S+) from (\d+\.\d+\.\d+\.\d+) via (\S+)")
# lan-guard.rsc: fake DHCP servers and ARP spoofing on the LAN
DHCP_ALERT_RE = re.compile(r"dhcp alert on (\S+): discovered unknown dhcp server, mac ([0-9A-Fa-f:]{17}), ip (\d+\.\d+\.\d+\.\d+)")
ARP_CHANGED_RE = re.compile(r"ML-ARP changed ip=(\d+\.\d+\.\d+\.\d+) old=([0-9A-Fa-f:]{17}) new=([0-9A-Fa-f:]{17})(?: if=(\S+))?")
ARP_MANY_RE = re.compile(r"ML-ARP many-ips mac=([0-9A-Fa-f:]{17}) ip=(\d+\.\d+\.\d+\.\d+) ips=(\d+)")
WF_SEC = {"scan": ("attack", "Port scan (router saw it)", "high"),
          "brute": ("attack", "Password guessing on the router (Winbox/SSH/API)", "high"),
          "synflood": ("ddos", "SYN flood (router limit hit)", "high"),
          "threat": (None, "", "high")}


def scan_logs(dns_lines, router_lines, wf_lines, threats, lan_nets, who=lambda ip, t: "", th=None):
    import cdnlearn, mlreport
    th = th or thresholds()
    ev = Events()
    in_lan = _lan_checker(lan_nets)
    # DNS: threat names (virus) and random names that do not exist (DGA)
    by_serial, nx = {}, defaultdict(set)
    for line in dns_lines:
        m = cdnmap.EXTRA_RE.search(line)
        if not m:
            continue
        t_, sid, client, action, name, answer = m.groups()
        name = name.rstrip(".").lower()
        if action.startswith("query"):
            t = cdnlearn.ts(t_)
            if t is None:
                continue
            by_serial[sid] = (t, client, name)
            if len(by_serial) > 200000:
                for k in list(by_serial)[:50000]:
                    del by_serial[k]
            if ONION_RE.search(name):
                ev.add(t, "ransomware", "Ransom note / Tor gateway site", "dns", client, "",
                       f"{name} — ransom notes send victims to Tor sites like this", "high", user=who(client, t))
            elif any(name == x or name.endswith("." + x) for x in EXFIL_TOOLS):
                ev.add(t, "ransomware", "Data-copy tool rclone downloaded", "dns", client, "",
                       f"{name} — rclone copies whole disks to the internet (often used to steal data)", "medium", user=who(client, t))
            elif any(name == x or name.endswith("." + x) for x in EXFIL_SITES):
                ev.add(t, "ransomware", "Anonymous file-upload site", "dns", client, "",
                       f"{name} — used to steal data before encrypting (also by normal people)", "low", user=who(client, t))
            src = threats.domain(name)
            if src:
                cat = "Crypto mining" if "mining" in src.lower() else "Phishing site" if "phishing" in src.lower() else "Malware site"
                ev.add(t, "virus", cat, "dns", client, "", f"{name} - {src}", "low" if cat == "Crypto mining" and "pool name" not in src else "high",
                       user=who(client, t))
        elif answer == "NXDOMAIN":
            q = by_serial.get(sid)
            if q and q[2] == name and looks_random(name):
                nx[(q[1], int(q[0] // 3600))].add(name)
    for (client, hour), names in nx.items():
        if len(names) >= th["DGA_NAMES"]:
            t = hour * 3600
            ev.add(t, "virus", "Random names that do not exist (DGA malware)", "dns", client, "",
                   f"{len(names)} names in one hour, e.g. {', '.join(sorted(names)[:3])}", "high", hits=len(names), user=who(client, t))
    # router: login failures (needs system logs sent to this server, see mikrotik/security.rsc)
    fails = defaultdict(list)
    for line in router_lines:
        m = LOGIN_FAIL_RE.search(line)
        t = cdnlearn.ts(line.split(" ", 1)[0])
        if m and t:
            fails[(m.group(2), day_of(t))].append((t, m.group(1), m.group(3)))
    for (src, _), items in fails.items():
        if len(items) >= th["ROUTER_LOGIN_FAILS"]:
            users = sorted({u for _, u, _ in items})
            via = sorted({v for _, _, v in items})
            for t, _, _ in items:
                ev.add(t, "attack", "Password guessing on the router", "log", src, "",
                       f"{len(items)} failed logins via {', '.join(via)} as {', '.join(users[:5])}", "high" if len(items) >= 4 * th["ROUTER_LOGIN_FAILS"] else "medium")
    # LAN guard (lan-guard.rsc): fake DHCP server, ARP spoofing
    changed = defaultdict(list)          # (new mac, day) -> [(t, ip, old mac)]
    for line in router_lines:
        t = cdnlearn.ts(line.split(" ", 1)[0])
        if not t:
            continue
        m = DHCP_ALERT_RE.search(line)
        if m:
            iface, mac, ip = m.groups()
            ev.add(t, "attack", "Fake DHCP server (rogue router on the LAN)", "log", ip, "",
                   f"device {mac.upper()} on {iface} gives out addresses — phones may get a wrong gateway", "high", user=who(ip, t))
            continue
        m = ARP_MANY_RE.search(line)
        if m:
            mac, ip, n = m.groups()
            ev.add(t, "attack", "ARP spoofing (one device answers for many addresses)", "log", ip, "",
                   f"device {mac.upper()} answers for {n} addresses — man in the middle", "high", user=who(ip, t))
            continue
        m = ARP_CHANGED_RE.search(line)
        if m:
            ip, old, new, _ = m.groups()
            changed[(new.upper(), day_of(t))].append((t, ip, old.upper()))
    for (mac, _), items in changed.items():
        ips = sorted({ip for _, ip, _ in items})
        if len(ips) >= th.get("ARP_TAKEOVER", 3):
            for t, ip, old in items:
                ev.add(t, "attack", "ARP spoofing (one device took over other addresses)", "log", ip, "",
                       f"device {mac} took over {len(ips)} addresses: {', '.join(ips[:5])}", "high", user=who(ip, t))
        else:
            for t, ip, old in items:
                ev.add(t, "attack", "Address moved to another device (ARP change)", "log", ip, "",
                       f"{ip}: {old} -> {mac} (normal when a phone reconnects; many of these = spoofing)", "low", user=who(ip, t))
    # router firewall: security rules (WF-scan, WF-brute, WF-synflood, WF-threat)
    for line in wf_lines:
        m = mlreport.WF_RE.search(line)
        if not m or m.group(3) not in WF_SEC:
            continue
        t_, _, tag, mac, src, dst, port = m.groups()
        t = cdnlearn.ts(t_)
        if t is None:
            continue
        cat, typ, sev = WF_SEC[tag]
        if tag == "threat":
            lan_src = in_lan(src)
            remote = dst if lan_src else src
            lst = threats.ip(remote) or "threat list"
            cat, typ = ("virus", "Talked to a botnet / malware server") if lan_src else ("attack", "Known attacker network")
            ev.add(t, cat, typ, "log", src, dst, f"{remote} is on {lst}", sev, user=who(src, t) if lan_src else "")
        else:
            ev.add(t, cat, typ, "log", src, dst, f"to {dst}:{port}" if port else f"to {dst}", sev)
    return ev


def db_checks(cnf, db, since, th=None):
    """RADIUS (Wi-Fi / hotspot / PPPoE) password guessing and dashboard login attacks."""
    th = th or thresholds()
    ev = Events()
    q1 = (f"SELECT username, DATE(authdate), COUNT(*), UNIX_TIMESTAMP(MIN(authdate)), UNIX_TIMESTAMP(MAX(authdate)) FROM radpostauth "
          f"WHERE reply='Access-Reject' AND authdate >= FROM_UNIXTIME({int(since)}) GROUP BY username, DATE(authdate) "
          f"HAVING COUNT(*) >= {int(th['RADIUS_REJECTS'])}")
    q2 = (f"SELECT ip, DATE(at), COUNT(*), UNIX_TIMESTAMP(MIN(at)), UNIX_TIMESTAMP(MAX(at)), GROUP_CONCAT(DISTINCT admin) FROM web_audit "
          f"WHERE action='login' AND result='failed' AND at >= FROM_UNIXTIME({int(since)}) GROUP BY ip, DATE(at) "
          f"HAVING COUNT(*) >= {int(th['DASHBOARD_LOGIN_FAILS'])}")
    for q, kind in ((q1, "radius"), (q2, "web")):
        try:
            out = subprocess.run(["mysql", f"--defaults-extra-file={cnf}", "-N", "-B", db, "-e", q],
                                 capture_output=True, text=True, timeout=60, check=True).stdout
        except (OSError, subprocess.SubprocessError) as e:
            print(f"warning: {kind} login check: {e}", file=sys.stderr)
            continue
        for line in out.splitlines():
            f = line.split("\t")
            if kind == "radius" and len(f) == 5:
                n = int(f[2])
                ev.add(float(f[3]), "attack", "Password guessing on a Wi-Fi / hotspot user", "log", "", f[0][:45],
                       f"{n} wrong passwords for user {f[0]}", "high" if n >= 4 * th["RADIUS_REJECTS"] else "medium", hits=n, user=f[0],
                       last=float(f[4]))
            elif kind == "web" and len(f) == 6:
                n = int(f[2])
                ev.add(float(f[3]), "attack", "Password guessing on the dashboard", "log", f[0], "",
                       f"{n} failed logins as {f[5][:80]}", "high", hits=n, last=float(f[4]))
    return ev


def unusual_uploads(rows, since, th=None):
    """rows: (client_ip, user, hour_start_epoch, bytes_up) for ~8 days. -> Events: hours since SINCE in which a
    device sent far more than its own usual busy hour (95th percentile of the 7 days before), and at least
    EXFIL_HOUR_MB — ransomware steals the data first."""
    th = th or thresholds()
    ev = Events()
    per = defaultdict(list)
    for ip, user, hour, b in rows:
        per[ip].append((float(hour), int(b), user))
    floor = th["EXFIL_HOUR_MB"] * 1e6
    for ip, hours in per.items():
        hours.sort()
        for i, (h, b, user) in enumerate(hours):
            if h < since or b < floor:
                continue
            past = sorted(x[1] for x in hours[:i] if h - 7 * 86400 <= x[0] < h and x[1] > 0)
            usual = past[int(len(past) * 0.95) - 1] if len(past) >= 24 else 0     # too little history: the floor only
            if usual and b < th["EXFIL_FACTOR"] * usual:
                continue
            night = time.localtime(h).tm_hour < 6
            ev.add(h, "ransomware", "Unusual upload (much more than this device's usual)", "log", ip, "",
                   f"{b / 1e9:.1f} GB sent in one hour" + (f", usual busy hour {usual / 1e6:.0f} MB" if usual else ", no usual yet")
                   + (" — at night" if night else ""), "high" if night or b >= 5 * floor else "medium", user=user if user != "NULL" else "")
    return ev


# what each signal says about ransomware (points), and its stage: in, contact, spread, steal, lock
RISK = [
    ("Ransom note / Tor gateway site", 45, "contact"), ("Mass file changes on a file server", 45, "lock"),
    ("Spreading inside the LAN", 40, "spread"), ("Scanning the local network", 25, "spread"),
    ("Unusual upload", 30, "steal"), ("Big upload to the internet", 25, "steal"), ("Data-copy tool rclone", 20, "steal"),
    ("Anonymous file-upload site", 10, "steal"), ("Tor network", 20, "contact"), ("Talked to a botnet", 25, "contact"),
    ("Random names that do not exist", 20, "contact"), ("Malware site", 15, "in"), ("Phishing site", 10, "in"),
]
STAGES = ["in", "contact", "spread", "steal", "lock"]


def ransom_risk(events):
    """events: [{src_ip, username, type, severity, last_seen}] of the last 24 h (ransomware + virus).
    -> [{ip, user, score 0-100, level, stages, signals}] worst first. Several stages together weigh more."""
    dev = {}
    for e in events:
        ip = e.get("src_ip") or ""
        if not ip:
            continue
        hit = next(((pts, st) for name, pts, st in RISK if e["type"].startswith(name)), None)
        if not hit:
            continue
        pts, st = hit
        if e.get("severity") == "high":
            pts = int(pts * 1.2)
        d = dev.setdefault(ip, {"ip": ip, "user": "", "points": {}, "stages": set(), "signals": [], "last": ""})
        d["user"] = d["user"] or (e.get("username") or "")
        key = next(name for name, _, _ in RISK if e["type"].startswith(name))
        d["points"][key] = max(d["points"].get(key, 0), pts)
        d["stages"].add(st)
        d["signals"].append(e["type"])
        d["last"] = max(d["last"], str(e.get("last_seen") or ""))
    out = []
    for d in dev.values():
        score = sum(d["points"].values()) + 10 * max(0, len(d["stages"]) - 1)      # a chain of stages is the real danger
        score = min(100, score)
        out.append({"ip": d["ip"], "user": d["user"], "score": score,
                    "level": "high" if score >= 70 else "medium" if score >= 40 else "low",
                    "stages": [s for s in STAGES if s in d["stages"]], "signals": sorted(set(d["signals"])), "last": d["last"]})
    return sorted(out, key=lambda x: (-x["score"], x["ip"]))


def _lan_checker(lan_nets):
    nets = []
    for n in lan_nets or []:
        try:
            nets.append(ipaddress.ip_network(n.strip(), strict=False))
        except ValueError:
            pass

    def in_lan(ip):
        try:
            a = ipaddress.ip_address(ip)
        except ValueError:
            return False
        return any(a in n for n in nets)
    return in_lan


# ------------------------------------------------------------------ live flow watch (in flowcollector)
IE_BYTES, IE_PKTS, IE_PROTO, IE_FLAGS = 1, 2, 4, 6
IE_SRC4, IE_DST4, IE_SPORT, IE_DPORT = 8, 12, 7, 11


class FlowWatch:
    def __init__(self, lan_nets, threats=None, conf=None):
        self.in_lan = _lan_checker(lan_nets)
        self.threats = threats or Threats()
        self.th = thresholds(conf)
        self.reset()

    def reset(self):
        self.to_dst = defaultdict(lambda: {"tcp_small": 0, "tcp_flows": 0, "udp_flows": 0, "udp_bytes": 0, "icmp_pkts": 0,
                                           "web_flows": 0, "srcs": set(), "amp": Counter(), "amp_srcs": defaultdict(set)})
        self.scan_ports = defaultdict(set)           # ext src -> {(dst, port)}
        self.sweep = defaultdict(set)                # (ext src, port) -> {dst}
        self.brute = Counter()                       # (ext src, dst, port) -> flows
        self.lan_out = defaultdict(lambda: {"smtp": set(), "worm": defaultdict(set), "lan": set(), "mining": set(),
                                            "lateral": defaultdict(set), "tor": set()})
        self.smb = Counter()                         # (client, file server) -> bytes over SMB
        self.upload = Counter()                      # (lan src, internet dst) -> bytes sent
        self.bot = Counter()                         # (lan src, dst) -> small flows
        self.c2 = {}                                 # (lan src, remote) -> list
        self.attackers = {}                          # ext src -> list

    def feed(self, rec):
        src, dst = rec.get(IE_SRC4), rec.get(IE_DST4)
        if not src or not dst:
            return
        proto = int(rec.get(IE_PROTO) or 0)
        sport, dport = int(rec.get(IE_SPORT) or 0), int(rec.get(IE_DPORT) or 0)
        nbytes, pkts = int(rec.get(IE_BYTES) or 0), int(rec.get(IE_PKTS) or 1)
        s_lan, d_lan = self.in_lan(src), self.in_lan(dst)
        if s_lan and not d_lan:                      # LAN device -> internet
            o = self.lan_out[src]
            if proto == 6 and dport == 25:
                o["smtp"].add(dst)
            if proto == 6 and dport in WORM_PORTS:
                o["worm"][dport].add(dst)
            if proto == 6 and dport in MINING_PORTS:
                o["mining"].add(f"{dst}:{dport}")
            if nbytes / max(pkts, 1) < 200 and (proto == 17 or (proto == 6 and pkts <= 3)):
                self.bot[(src, dst)] += 1
            lst = self.threats.ip(dst)
            if lst:
                self.c2[(src, dst)] = lst
            self.upload[(src, dst)] += nbytes
            if proto == 6 and dport in TOR_PORTS:
                o["tor"].add(dst)
        elif s_lan and d_lan:                        # inside the LAN
            if not (dst.endswith(".255") or dst.endswith(".1")):
                self.lan_out[src]["lan"].add(dst)
                if proto == 6 and dport in LATERAL_PORTS:
                    self.lan_out[src]["lateral"][dport].add(dst)
            if proto == 6 and 445 in (dport, sport):
                self.smb[(src, dst) if dport == 445 else (dst, src)] += nbytes
        elif not s_lan:                              # from the internet (to the router or a LAN host)
            d = self.to_dst[dst]
            if len(d["srcs"]) < 5000:
                d["srcs"].add(src)
            if proto == 6:
                d["tcp_flows"] += 1
                if nbytes / max(pkts, 1) < 120 and pkts <= 3:
                    d["tcp_small"] += 1
                if dport in (80, 443, 8080, 8443):
                    d["web_flows"] += 1
                if dport in AUTH_PORTS:
                    self.brute[(src, dst, dport)] += 1
            elif proto == 17:
                d["udp_flows"] += 1
                d["udp_bytes"] += nbytes
                if sport in AMP_PORTS:
                    d["amp"][sport] += nbytes
                    if len(d["amp_srcs"][sport]) < 1000:
                        d["amp_srcs"][sport].add(src)
            elif proto == 1:
                d["icmp_pkts"] += pkts
            if proto in (6, 17) and len(self.scan_ports[src]) < 2000:
                self.scan_ports[src].add((dst, dport))
                if len(self.sweep[(src, dport)]) < 2000:
                    self.sweep[(src, dport)].add(dst)
            lst = self.threats.ip(src)
            if lst:
                self.attackers[src] = (lst, dst)

    def evaluate(self, now, interval=60.0, users=None):
        """-> Events for the window that just ended (thresholds scaled to the window length)."""
        users = users or {}
        k = max(interval / 60.0, 0.2)
        th = {n: v * k for n, v in self.th.items()}
        ev = Events()
        t = now
        for dst, d in self.to_dst.items():
            nsrc = len(d["srcs"])
            many = nsrc >= self.th["FLOOD_SOURCES"]
            kind = "ddos" if many else "attack"
            tail = f"from {nsrc} sources" if many else f"from {nsrc} source(s) (DoS)"
            if d["tcp_small"] >= th["FLOOD_FLOWS"]:
                ev.add(t, kind, "SYN flood", "flow", "", dst, f"{d['tcp_small']} half-open TCP connections {tail}", "high", d["tcp_small"])
            elif d["web_flows"] >= th["FLOOD_FLOWS"]:
                ev.add(t, kind, "HTTP/HTTPS flood", "flow", "", dst, f"{d['web_flows']} web connections {tail}", "high", d["web_flows"])
            for port, b in d["amp"].items():
                ns = len(d["amp_srcs"][port])
                if b >= th["AMP_BYTES"] and ns >= self.th["AMP_SOURCES"]:
                    ev.add(t, "ddos", f"{AMP_PORTS[port]} amplification (reflection) flood", "flow", "", dst,
                           f"{b / 1e6:.0f} MB from {ns} {AMP_PORTS[port]} servers (udp/{port})", "high", ns)
            if d["udp_flows"] >= th["FLOOD_FLOWS"] or d["udp_bytes"] >= th["UDP_BYTES"]:
                if not any(b >= th["AMP_BYTES"] for b in d["amp"].values()):
                    ev.add(t, kind, "UDP flood", "flow", "", dst, f"{d['udp_flows']} UDP flows, {d['udp_bytes'] / 1e6:.0f} MB {tail}", "high", d["udp_flows"])
            if d["icmp_pkts"] >= th["ICMP_PKTS"]:
                ev.add(t, kind, "ICMP (ping) flood", "flow", "", dst, f"{d['icmp_pkts']} ping packets {tail}", "high", d["icmp_pkts"])
        for src, pairs in self.scan_ports.items():
            ports = {p for _, p in pairs}
            if len(ports) >= th["SCAN_PORTS"]:
                targets = {h for h, _ in pairs}
                ev.add(t, "attack", "Port scan", "flow", src, next(iter(targets)) if len(targets) == 1 else "",
                       f"{len(ports)} ports on {len(targets)} host(s)", "medium", len(ports))
        for (src, port), dsts in self.sweep.items():
            if len(dsts) >= th["SWEEP_HOSTS"]:
                ev.add(t, "attack", f"Network sweep on port {port}", "flow", src, "", f"{len(dsts)} of your addresses", "medium", len(dsts))
        for (src, dst, port), n in self.brute.items():
            if n >= th["BRUTE_FLOWS"]:
                ev.add(t, "attack", f"Password guessing on {AUTH_PORTS[port]}", "flow", src, dst, f"{n} logins tried on port {port}",
                       "high" if n >= 4 * th["BRUTE_FLOWS"] else "medium", n)
        if len(self.attackers) > 20:                 # e.g. part of a flood: one alert, not hundreds
            dst = Counter(d for _, d in self.attackers.values()).most_common(1)[0][0]
            ev.add(t, "attack", "Known attacker networks", "flow", "", dst,
                   f"{len(self.attackers)} addresses on threat lists, e.g. {', '.join(sorted(self.attackers)[:3])}", "medium", len(self.attackers))
        else:
            for src, (lst, dst) in self.attackers.items():
                ev.add(t, "attack", "Known attacker network", "flow", src, dst, f"{src} is on {lst}", "medium")
        for src, o in self.lan_out.items():
            u = users.get(src, "")
            if len(o["smtp"]) >= th["SPAM_HOSTS"]:
                ev.add(t, "virus", "Spam bot (mail to many servers)", "flow", src, "", f"{len(o['smtp'])} mail servers in {interval:.0f}s",
                       "high", len(o["smtp"]), user=u)
            for port, dsts in o["worm"].items():
                if len(dsts) >= th["WORM_HOSTS"]:
                    ev.add(t, "virus", f"Scanning the internet on port {port} ({WORM_PORTS[port]})", "flow", src, "",
                           f"{len(dsts)} hosts in {interval:.0f}s (worm / botnet)", "high", len(dsts), user=u)
            if len(o["lan"]) >= th["LAN_SCAN_HOSTS"]:
                ev.add(t, "virus", "Scanning the local network", "flow", src, "", f"{len(o['lan'])} LAN devices in {interval:.0f}s",
                       "medium", len(o["lan"]), user=u)
            if o["mining"]:
                ev.add(t, "virus", "Possible crypto mining (stratum port)", "flow", src, "", ", ".join(sorted(o["mining"])[:3]), "low",
                       len(o["mining"]), user=u)
        # ransomware: spreading inside the LAN, Tor, a big upload, mass file changes on a file server
        night = time.localtime(t).tm_hour < 6
        for src, o in self.lan_out.items():
            u = users.get(src, "")
            for port, dsts in o["lateral"].items():
                if len(dsts) >= th["LATERAL_HOSTS"]:
                    ev.add(t, "ransomware", f"Spreading inside the LAN ({LATERAL_PORTS[port]})", "flow", src, "",
                           f"{len(dsts)} LAN devices on port {port} in {interval:.0f}s — how ransomware reaches other PCs", "high", len(dsts), user=u)
            if o["tor"]:
                ev.add(t, "ransomware", "Tor network (hidden servers)", "flow", src, sorted(o["tor"])[0],
                       f"{len(o['tor'])} Tor relay(s) — ransomware talks to its owner over Tor", "medium", len(o["tor"]), user=u)
        for (src, dst), b in self.upload.items():
            if b >= th["EXFIL_MB"] * 1e6:
                ev.add(t, "ransomware", "Big upload to the internet", "flow", src, dst,
                       f"{b / 1e6:.0f} MB sent to {dst} in {interval:.0f}s" + (" at night" if night else "") + " — data is stolen before it is locked",
                       "high" if night else "medium", 1, user=users.get(src, ""))
        for (client, server), b in self.smb.items():
            if b >= th["SMB_BURST_MB"] * 1e6:
                ev.add(t, "ransomware", "Mass file changes on a file server (SMB)", "flow", client, server,
                       f"{b / 1e9:.1f} GB with {server} over SMB in {interval:.0f}s — files may be being encrypted", "high", 1,
                       user=users.get(client, ""))
        for (src, dst), n in self.bot.items():
            if n >= th["BOT_FLOWS"]:
                ev.add(t, "virus", "Device is flooding someone (DDoS bot)", "flow", src, dst, f"{n} small connections to {dst}",
                       "high", n, user=users.get(src, ""))
        for (src, dst), lst in self.c2.items():
            ev.add(t, "virus", "Talked to a botnet / malware server", "flow", src, dst, f"{dst} is on {lst}", "high", user=users.get(src, ""))
        self.reset()
        return ev


# ------------------------------------------------------------------ SQL
def esc(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dt(t):
    return esc(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)))


UPSERT = ("INSERT INTO ml_security_event (day, category, type, source, src_ip, dst_ip, username, severity, detail, hits, first_seen, last_seen) VALUES {} "
          "ON DUPLICATE KEY UPDATE hits=hits+VALUES(hits), last_seen=GREATEST(last_seen, VALUES(last_seen)), detail=VALUES(detail), "
          "username=IF(VALUES(username)='', username, VALUES(username)), "
          "severity=IF(FIELD(VALUES(severity),'low','medium','high') > FIELD(severity,'low','medium','high'), VALUES(severity), severity)")


def row_values(k, e):
    day, cat, typ, source, src, dst = k
    return (f"({esc(day)},{esc(cat)},{esc(typ)},{esc(source)},{esc(src)},{esc(dst)},{esc((e['user'] or '')[:64])},{esc(e['severity'])},"
            f"{esc(e['detail'])},{int(e['hits'])},{dt(e['first'])},{dt(e['last'])})")


def sql(events, since_day):
    out = ["START TRANSACTION;", f"DELETE FROM ml_security_event WHERE source IN ('dns','log') AND day >= {esc(since_day)};"]
    rows = [row_values(k, e) for k, e in events.rows()]
    for i in range(0, len(rows), 300):
        out.append(UPSERT.format(",".join(rows[i:i + 300])) + ";")
    out.append(f"DELETE FROM ml_security_event WHERE day < CURDATE() - INTERVAL {KEEP_DAYS} DAY;")
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def _rows(cnf, db, q):
    try:
        out = subprocess.run(["mysql", f"--defaults-extra-file={cnf}", "-N", "-B", db, "-e", q],
                             capture_output=True, text=True, timeout=120, check=True).stdout
    except (OSError, subprocess.SubprocessError) as e:
        print(f"warning: {e}", file=sys.stderr)
        return []
    return [l.split("\t") for l in out.splitlines()]


def upload_rows(cnf, db):
    """(client_ip, user, hour start, bytes up) per device and hour, 8 days (traffic collector)."""
    return [r for r in _rows(cnf, db, "SELECT client_ip, MAX(username), UNIX_TIMESTAMP(DATE_FORMAT(bucket, '%Y-%m-%d %H:00:00')), SUM(bytes_up) "
                                      "FROM traffic_site WHERE bucket >= NOW() - INTERVAL 8 DAY GROUP BY client_ip, 3") if len(r) == 4]


def main():
    args = sys.argv[1:]
    if args[:1] == ["update"]:
        return update()
    if args[:1] == ["risk"]:                              # ransomware risk per device, last 24 h
        opt = lambda k, d: args[args.index(k) + 1] if k in args else d  # noqa: E731
        rows = _rows(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"),
                     "SELECT src_ip, username, type, severity, last_seen FROM ml_security_event WHERE category IN ('ransomware','virus') "
                     "AND last_seen >= NOW() - INTERVAL 1 DAY AND src_ip <> ''")
        ev = [dict(zip(("src_ip", "username", "type", "severity", "last_seen"), r)) for r in rows if len(r) == 5]
        for d in ransom_risk(ev):
            print("\t".join([d["ip"], d["user"] or "-", str(d["score"]), d["level"], ",".join(d["stages"]), "; ".join(d["signals"])[:200]]))
        return
    if args[:1] != ["sql"]:
        print(__doc__)
        sys.exit(1)
    import cdnlearn, mlreport
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d  # noqa: E731
    lt = time.localtime()
    since = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - 1, 0, 0, 0, 0, 0, -1))
    keep = lambda l: (cdnlearn.ts(l.split(" ", 1)[0]) or 0) >= since  # noqa: E731
    dns = [l for l in cdnmap.recent_lines(os.path.join(LOGDIR, "dns.log"), since) if keep(l)]
    router = [l for l in cdnmap.recent_lines(os.path.join(LOGDIR, "router.log"), since, 100_000_000) if keep(l)]
    wf = [l for l in cdnmap.recent_lines(os.path.join(LOGDIR, "webfilter.log"), since, 100_000_000) if keep(l)]
    conf = {}
    try:
        for line in open("/etc/mikrotiklover-radius/radius.conf"):
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m:
                conf[m.group(1)] = m.group(2).strip('"')
    except OSError:
        pass
    lan = conf.get("LAN_NETS", "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10").split(",")
    th = thresholds(conf)
    who = lambda ip, t: ""  # noqa: E731
    cnf = opt("--cnf", "")
    if cnf:
        s = mlreport.Sessions(cnf, opt("--db", "radius"), 2)
        s.refresh(force=True)
        who = lambda ip, t: (lambda u: "" if u == "-" else u)(s.who(ip, t))  # noqa: E731
    ev = scan_logs(dns, router, wf, Threats(), lan, who, th)
    if cnf:
        ev.ev.update(db_checks(cnf, opt("--db", "radius"), since, th).ev)
        ev.ev.update(unusual_uploads(upload_rows(cnf, opt("--db", "radius")), since, th).ev)
    sys.stdout.write(sql(ev, day_of(since)))
    cats = Counter(k[1] for k in ev.ev)
    print(f"security: {len(ev.ev)} events — virus {cats['virus']}, attack {cats['attack']}, ddos {cats['ddos']}, "
          f"ransomware {cats['ransomware']}", file=sys.stderr)


if __name__ == "__main__":
    main()
