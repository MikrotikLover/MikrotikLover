#!/usr/bin/env python3
"""VPN watch: who tries to use a VPN, and an automatic, growing list of VPN servers and VPN domains.

Evidence, from three places:
  DNS log        a VPN website / app name was looked up (catalog apps of category "vpn", the vpn-proxy
                 block list, or simply "vpn" in the name) -> the IPs it resolved to are VPN servers
  router log     the router blocked a VPN connection (log prefix WF-vpn...)
  traffic flows  a VPN protocol (OpenVPN, WireGuard, IPsec, L2TP, PPTP, Tor ...) or a known VPN server
                 (flowcollector.py calls flow_kind() for every connection)

Tables: ml_vpn_event (who / when / what), ml_vpn_server (IP list), ml_vpn_domain (name list).
radius-admin policy build turns the lists into the router's "vpn-servers" address list and the
wf-vpn firewall chain, so a policy with "block-vpn" keeps up with new VPN servers by itself.

  vpn.py sql [--cnf FILE] [--db NAME]   SQL for the hourly run (DNS + router log since yesterday)
  vpn.py public FILE                     download public VPN / Tor server lists into FILE
"""
import ipaddress, os, re, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdnmap, cdnlearn  # noqa: E402

STATE = cdnmap.STATE
IGNORE_FILE = os.path.join(STATE, "vpn-ignore.txt")
LOGDIR = os.environ.get("MLREPORT_LOGDIR", "/var/log/mikrotik")
WF_DIR = os.environ.get("MLWF_DIR", "")
KEEP_DAYS = int(os.environ.get("VPN_DAYS", "180"))

# (proto, service port) -> protocol name. Only when the LAN device is the client (direction "out").
PORTS = {
    (17, 1194): "OpenVPN", (6, 1194): "OpenVPN", (17, 1197): "OpenVPN", (17, 1198): "OpenVPN",
    (6, 1197): "OpenVPN", (6, 1198): "OpenVPN", (17, 51820): "WireGuard", (17, 51821): "WireGuard",
    (17, 2408): "Cloudflare WARP", (17, 500): "IPsec VPN", (17, 4500): "IPsec VPN", (17, 1701): "L2TP VPN",
    (6, 1723): "PPTP VPN", (6, 5555): "SoftEther VPN", (17, 5555): "SoftEther VPN",
    (6, 9001): "Tor", (6, 9030): "Tor", (6, 9050): "Tor", (6, 9150): "Tor",
}
PROTOS = {47: "PPTP VPN (GRE)", 50: "IPsec VPN (ESP)", 51: "IPsec VPN (AH)"}
KEYWORD = re.compile(r"vpn")
PUBLIC_LISTS = [
    ("VPN provider (public list)", "https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output/vpn/ipv4.txt"),
    ("Tor exit (public list)", "https://check.torproject.org/torbulkexitlist"),
]


def _wf_dir():
    for d in (WF_DIR, "/usr/local/lib/mikrotiklover/webfilter",
              os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "webfilter")):
        if d and os.path.isdir(os.path.join(d, "categories")):
            return d
    return ""


def read_list(path):
    out = []
    try:
        for line in open(path, encoding="utf-8"):
            line = line.split("#", 1)[0].strip().lower()
            if line:
                out.append(line)
    except OSError:
        pass
    return out


class Matcher:
    def __init__(self, cat=None, block_list=None, ignore=None):
        self.cat = cat or cdnmap.catalog()
        d = _wf_dir()
        self.block = set(block_list if block_list is not None else
                         read_list(os.path.join(d, "categories", "vpn-proxy.txt")) if d else [])
        self.ignore = set(ignore if ignore is not None else read_list(IGNORE_FILE))

    @staticmethod
    def _suffixes(host):
        labels = host.split(".")
        return [".".join(labels[i:]) for i in range(len(labels) - 1)]

    def domain(self, host):
        """hostname -> (vpn name, why) or None."""
        host = host.rstrip(".").lower()
        sfx = self._suffixes(host)
        if any(s in self.ignore for s in sfx):
            return None
        e = self.cat.name(host)
        if e and e.get("generic"):
            return None
        if e and e.get("category") == "vpn":
            return e["app"], "app"
        hit = next((s for s in sfx if s in self.block), None)
        if hit:
            return (e["app"] if e else hit), "block list"
        if KEYWORD.search(host) and not e:
            return cdnmap.registrable(host), "name has 'vpn'"
        return None

    def ip_shared(self, ip):
        """IP of a big shared network (CDN / cloud of a big company): never put it on the server list."""
        o = self.cat.ip_owner(ip)
        return bool(o)


def flow_kind(proto, direction, port, remote, servers):
    """A connection -> VPN kind, or None. servers: {ip: kind} of known VPN servers."""
    proto = int(proto or 0)
    if proto in PROTOS:
        return PROTOS[proto]
    if direction == "out" and (proto, int(port or 0)) in PORTS:
        return PORTS[(proto, int(port))]
    if remote in servers:
        return servers[remote]
    return None


def bucket(t):
    return time.strftime("%Y-%m-%d %H:00:00", time.localtime(t))


def scan(dns_lines, wf_lines, m, who=lambda ip, t, mac="": "", servers=None):
    """-> events {(bucket, client, source, what): [kind, hits, first, last, user]},
          servers {ip: [kind, why, first, last]}, domains {domain: [kind, why, first, last]}"""
    servers = dict(servers or {})
    events, new_servers, domains = {}, {}, {}
    ip_names = {}
    recs = cdnlearn.parse(dns_lines)
    for r in recs:
        for ip in r["ips"]:
            ip_names.setdefault(ip, set()).add(r["qname"])

    def ev(t, client, source, what, kind, mac=""):
        k = (bucket(t), client, source, what)
        e = events.get(k)
        if not e:
            e = events[k] = [kind, 0, t, t, ""]
        e[1] += 1
        e[2], e[3] = min(e[2], t), max(e[3], t)
        e[4] = who(client, t, mac) or e[4]

    vpn_names = set()
    for r in recs:
        hit = None
        for n in [r["qname"]] + r["chain"]:
            hit = m.domain(n)
            if hit:
                break
        if not hit:
            continue
        kind, why = hit
        vpn_names.add(r["qname"])
        dom = r["qname"]
        d = domains.setdefault(dom, [kind, why, r["t"], r["t"]])
        d[2], d[3] = min(d[2], r["t"]), max(d[3], r["t"])
        ev(r["t"], r["client"], "dns", dom, kind)
        if any(cdnmap.catalog().name(c) and cdnmap.catalog().name(c).get("generic") for c in r["chain"]):
            continue                                       # served by a shared CDN: its IPs are not VPN servers
        for ip in r["ips"]:
            s = new_servers.setdefault(ip, [kind, f"DNS {dom}", r["t"], r["t"]])
            s[2], s[3] = min(s[2], r["t"]), max(s[3], r["t"])
    # an IP that also serves non-VPN names, or belongs to a big shared network, is not a VPN server
    for ip in list(new_servers):
        if ip_names.get(ip, set()) - vpn_names or m.ip_shared(ip):
            del new_servers[ip]
    known = {**{ip: v[0] for ip, v in new_servers.items()}, **servers}

    import mlreport
    for line in wf_lines:
        mm = mlreport.WF_RE.search(line)
        if not mm or not mm.group(3).startswith("vpn"):
            continue
        t_, _, cat_, mac, src, dst, port = mm.groups()
        t = cdnlearn.ts(t_)
        if t is None:
            continue
        pr = re.search(r"proto (\w+)", line)
        what = f"{dst}:{port}/{pr.group(1).lower()}" if port and pr else dst
        ev(t, src, "blocked", what, known.get(dst) or ("VPN website" if port == "443" else "VPN connection"), mac or "")
    return events, new_servers, domains


def esc(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dt(t):
    return esc(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)))


def sql(events, servers, domains, since):
    out = ["START TRANSACTION;",
           f"DELETE FROM ml_vpn_event WHERE source IN ('dns','blocked') AND bucket >= {dt(since)};"]
    rows = [f"({esc(b)},{esc(c)},{esc((u or '')[:64])},{esc(src)},{esc(what[:253])},{esc(kind[:64])},{n},{dt(f)},{dt(l)},0)"
            for (b, c, src, what), (kind, n, f, l, u) in sorted(events.items())]
    for i in range(0, len(rows), 500):
        out.append("INSERT INTO ml_vpn_event (bucket, client_ip, username, source, what, kind, hits, first_seen, last_seen, bytes) VALUES "
                   + ",".join(rows[i:i + 500]) + " ON DUPLICATE KEY UPDATE hits=VALUES(hits), kind=VALUES(kind), "
                   "username=VALUES(username), first_seen=VALUES(first_seen), last_seen=VALUES(last_seen);")
    for ip, (kind, why, f, l) in servers.items():
        out.append("INSERT INTO ml_vpn_server (ip, kind, why, first_seen, last_seen) VALUES "
                   f"({esc(ip)},{esc(kind[:64])},{esc(why[:128])},{dt(f)},{dt(l)}) ON DUPLICATE KEY UPDATE "
                   "first_seen=LEAST(first_seen, VALUES(first_seen)), last_seen=GREATEST(last_seen, VALUES(last_seen));")
    for d, (kind, why, f, l) in domains.items():
        out.append("INSERT INTO ml_vpn_domain (domain, kind, why, first_seen, last_seen) VALUES "
                   f"({esc(d[:253])},{esc(kind[:64])},{esc(why[:64])},{dt(f)},{dt(l)}) ON DUPLICATE KEY UPDATE kind=VALUES(kind), "
                   "why=VALUES(why), first_seen=LEAST(first_seen, VALUES(first_seen)), last_seen=GREATEST(last_seen, VALUES(last_seen));")
    out.append(f"DELETE FROM ml_vpn_event WHERE bucket < NOW() - INTERVAL {KEEP_DAYS} DAY;")
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def public(path):
    """Download the public VPN / Tor lists -> FILE with 'network<TAB>kind' lines (keeps the old file on failure)."""
    rows, failed = [], []
    for kind, url in PUBLIC_LISTS:
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                n = 0
                for line in r.read().decode("utf-8", "replace").splitlines():
                    line = line.strip()
                    try:
                        net = ipaddress.ip_network(line, strict=False)
                    except ValueError:
                        continue
                    if net.version == 4 and net.prefixlen >= 8 and net.is_global:
                        rows.append(f"{net}\t{kind}")
                        n += 1
                print(f"{kind}: {n} networks")
        except OSError as e:
            failed.append(f"{kind}: {e}")
    for f in failed:
        print(f"warning: {f}", file=sys.stderr)
    if not rows:
        raise SystemExit("no public list could be downloaded; keeping the old one")
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        fh.write("\n".join(rows) + "\n")
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)
    print(f"{len(rows)} networks -> {path}")


def main():
    args = sys.argv[1:]
    if args[:1] == ["public"] and len(args) == 2:
        return public(args[1])
    if args[:1] != ["sql"]:
        print(__doc__)
        sys.exit(1)
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d  # noqa: E731
    lt = time.localtime()
    since = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - 1, 0, 0, 0, 0, 0, -1))
    keep = lambda l: (cdnlearn.ts(l.split(" ", 1)[0]) or 0) >= since  # noqa: E731
    dns = [l for l in cdnmap.tail_lines(os.path.join(LOGDIR, "dns.log"), 400_000_000) if keep(l)]
    wf = [l for l in cdnmap.tail_lines(os.path.join(LOGDIR, "webfilter.log"), 100_000_000) if keep(l)]
    who = lambda ip, t, mac="": ""  # noqa: E731
    if opt("--cnf", ""):
        import mlreport
        s = mlreport.Sessions(opt("--cnf", ""), opt("--db", "radius"), 2)
        s.refresh(force=True)
        memo = {}

        def who(ip, t, mac=""):
            k = (ip, mac, int(t // 300))
            if k not in memo:
                u = s.who(ip, t, mac)
                memo[k] = "" if u == "-" else u
            return memo[k]
    events, servers, domains = scan(dns, wf, Matcher(), who)
    sys.stdout.write(sql(events, servers, domains, since))
    users = {e[4] or c for (b, c, s_, w), e in events.items()}
    print(f"vpn: {len(events)} attempt rows from {len(users)} users/devices, {len(servers)} server IPs, {len(domains)} VPN names",
          file=sys.stderr)


if __name__ == "__main__":
    main()
