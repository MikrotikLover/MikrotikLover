#!/usr/bin/env python3
"""MikrotikLover reports: visited sites, browsing history, blocked attempts, live log.

Reads the logs that rsyslog writes on the RADIUS server:
  /var/log/mikrotik/dns.log        DNS queries from the dnsmasq logger ("radius-admin dnslog on")
  /var/log/mikrotik/webfilter.log  router firewall blocks (webfilter-logging.rsc, prefix WF-...)
and maps client IP / MAC to the RADIUS username active at that moment (radacct).
Installed to /usr/local/lib/mikrotiklover/ and run by radius-admin (sites, history, blocked, live).
"""
import argparse, glob, gzip, json, os, re, subprocess, sys, time
from datetime import datetime, timedelta

LOGDIR = os.environ.get("MLREPORT_LOGDIR", "/var/log/mikrotik")
DNS_LOG = os.path.join(LOGDIR, "dns.log")
WF_LOG = os.path.join(LOGDIR, "webfilter.log")

# 2026-10-16T18:00:44.63+00:00 127.0.0.1 dnsmasq[123]: query[A] www.google.com from 192.168.88.23
DNS_RE = re.compile(r"^(\S+) \S+ .*?query\[(A|AAAA|HTTPS|CNAME)\] (\S+) from (\d+\.\d+\.\d+\.\d+)")
WF_RE = re.compile(r"^(\S+) (\S+) .*?WF-([a-z0-9-]+)\b.*?(?:src-mac ([0-9a-fA-F:]{17}).*?)?"
                   r"(\d+\.\d+\.\d+\.\d+)(?::\d+)?->(\d+\.\d+\.\d+\.\d+)(?::(\d+))?")

# second-level public suffixes common in our region; good enough for grouping, not a full PSL
SLD = {"co", "com", "net", "org", "edu", "gov", "gob", "ac", "or", "ne", "go", "web", "biz", "info", "nic"}
NOISE = re.compile(r"(\.arpa|\.local|\.lan|\.home|\.internal|^wpad|^localhost)$|^[^.]+$")


# CDN / API domains shown as the site people actually use
ALIAS = {
    "googlevideo.com": "youtube.com", "ytimg.com": "youtube.com", "youtube-nocookie.com": "youtube.com",
    "youtu.be": "youtube.com", "fbcdn.net": "facebook.com", "fbsbx.com": "facebook.com", "fb.com": "facebook.com",
    "messenger.com": "facebook.com", "cdninstagram.com": "instagram.com", "whatsapp.net": "whatsapp.com",
    "wa.me": "whatsapp.com", "tiktokcdn.com": "tiktok.com", "tiktokcdn-us.com": "tiktok.com",
    "tiktokv.com": "tiktok.com", "byteoversea.com": "tiktok.com", "ibytedtos.com": "tiktok.com",
    "nflxvideo.net": "netflix.com", "nflximg.net": "netflix.com", "nflxext.com": "netflix.com",
    "nflxso.net": "netflix.com", "twimg.com": "x.com", "twitter.com": "x.com", "t.co": "x.com",
    "sc-cdn.net": "snapchat.com", "snapkit.com": "snapchat.com", "licdn.com": "linkedin.com",
    "pinimg.com": "pinterest.com", "redd.it": "reddit.com", "redditmedia.com": "reddit.com",
    "redditstatic.com": "reddit.com", "telegram.org": "telegram.org", "t.me": "telegram.org",
    "cdn-telegram.org": "telegram.org", "discordapp.com": "discord.com", "discordapp.net": "discord.com",
    "discord.gg": "discord.com", "discord.media": "discord.com", "steamstatic.com": "steampowered.com",
    "steamcontent.com": "steampowered.com", "steamserver.net": "steampowered.com", "rbxcdn.com": "roblox.com",
    "ttvnw.net": "twitch.tv", "jtvnw.net": "twitch.tv", "vimeocdn.com": "vimeo.com", "dmcdn.net": "dailymotion.com",
    "aiv-cdn.net": "primevideo.com", "aiv-delivery.net": "primevideo.com",
}


try:                                    # CDN detective catalog (cdn-apps.json), same directory
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import cdnmap
except ImportError:                     # pragma: no cover - reports still work with the small alias list
    cdnmap = None


def base_domain(name):
    """Site name for reports: the app's main site for known CDN/API hosts, else the registrable domain."""
    if cdnmap:
        e = cdnmap.catalog().name(name)
        if e and not e["generic"]:
            return e["site"]
    parts = name.rstrip(".").lower().split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in SLD:
        d = ".".join(parts[-3:])
    else:
        d = ".".join(parts[-2:])
    return ALIAS.get(d, d)


def is_generic_cdn(name):
    if not cdnmap:
        return False
    e = cdnmap.catalog().name(name)
    return bool(e and e["generic"])


class Sessions:
    """RADIUS sessions (user, ip, mac, start, stop) from radacct, refreshed on demand."""

    def __init__(self, cnf, db, days):
        self.cnf, self.db, self.days, self.rows, self.loaded = cnf, db, days, [], 0

    def refresh(self, force=False):
        if not force and time.time() - self.loaded < 60:
            return
        q = ("SELECT username, IFNULL(framedipaddress,''), IFNULL(callingstationid,''), "
             "UNIX_TIMESTAMP(acctstarttime), UNIX_TIMESTAMP(IFNULL(acctstoptime, NOW() + INTERVAL 1 DAY)) "
             f"FROM radacct WHERE acctstarttime >= NOW() - INTERVAL {int(self.days) + 1} DAY "
             "ORDER BY acctstarttime DESC")
        try:
            out = subprocess.run(["mysql", f"--defaults-extra-file={self.cnf}", "-N", "-B", self.db, "-e", q],
                                 capture_output=True, text=True, timeout=30, check=True).stdout
        except (OSError, subprocess.SubprocessError) as e:
            print(f"warning: cannot read RADIUS sessions ({e}); usernames will be '-'", file=sys.stderr)
            out = ""
        rows = []
        for line in out.splitlines():
            f = line.split("\t")
            if len(f) == 5:
                rows.append((f[0], f[1], f[2].upper().replace(":", "-"), float(f[3] or 0), float(f[4] or 0)))
        self.rows, self.loaded = rows, time.time()

    def who(self, ip, ts, mac=""):
        mac = mac.upper().replace(":", "-")
        for user, sip, smac, start, stop in self.rows:
            if start <= ts <= stop and ((sip and sip == ip) or (mac and smac == mac)):
                return user
        return "-"


def ts_of(s):
    try:
        return datetime.fromisoformat(s).timestamp()
    except ValueError:
        return None


def log_files(path, since=0):
    """Current log plus rotated ones (oldest first). A rotated file last written before
    `since` holds only older lines, so it is skipped (a 1-day report does not read 30 days)."""
    def num(p):
        m = re.search(r"\.(\d+)(?:\.gz)?$", p)
        return int(m.group(1)) if m else 0
    rotated = sorted(glob.glob(path + ".*"), key=num, reverse=True)
    if since:
        rotated = [f for f in rotated if os.path.getmtime(f) >= since - 60]
    return rotated + ([path] if os.path.exists(path) else [])


def read_lines(path, since=0):
    for f in log_files(path, since):
        opener = gzip.open if f.endswith(".gz") else open
        try:
            with opener(f, "rt", encoding="utf-8", errors="replace") as fh:
                yield from fh
        except OSError:
            continue


def dns_events(lines, since):
    """Yield (ts, timestr, ip, domain); one 'visit' per ip+domain per minute (apps repeat queries)."""
    last = {}
    for line in lines:
        m = DNS_RE.search(line)
        if not m:
            continue
        t, qtype, name, ip = m.groups()
        name = name.rstrip(".").lower()
        ts = ts_of(t)
        if ts is None or ts < since or NOISE.search(name) or is_generic_cdn(name):
            continue
        key = (ip, name)
        if ts - last.get(key, 0) < 60:
            continue
        last[key] = ts
        yield ts, t[:19].replace("T", " "), ip, name


def table(rows, hdr):
    if not rows:
        print("Nothing found.")
        return
    w = [max(len(str(r[i])) for r in rows + [hdr]) for i in range(len(hdr))]
    print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
    for r in rows:
        print("  ".join(str(v).ljust(w[i]) for i, v in enumerate(r)))


def match(user, ip, a):
    return (not a.user or user == a.user) and (not a.ip or ip == a.ip)


def sites_rows(a, s):
    """[(site, visits, users, last_visit, who)] most visited first."""
    since = time.time() - a.days * 86400
    count, users, last, seen = {}, {}, {}, {}
    for ts, t, ip, name in dns_events(read_lines(DNS_LOG, since), since):
        user = s.who(ip, ts)
        if not match(user, ip, a):
            continue
        d = base_domain(name)
        if ts - seen.get((ip, d), 0) < 300:        # one visit = same device + site within 5 minutes
            continue
        seen[(ip, d)] = ts
        count[d] = count.get(d, 0) + 1
        users.setdefault(d, set()).add(user if user != "-" else ip)
        last[d] = t
    rows = sorted(count, key=lambda d: -count[d])[:a.top]
    return [(d, count[d], len(users[d]), last[d], ", ".join(sorted(users[d]))[:60]) for d in rows]


def cmd_sites(a, s):
    table(sites_rows(a, s), ("site", "visits", "users", "last visit", "who"))


def history_rows(a, s):
    """[(time, user, ip, site, hostname)] oldest first, last a.n."""
    since = time.time() - a.days * 86400
    rows, prev = [], {}
    for ts, t, ip, name in dns_events(read_lines(DNS_LOG, since), since):
        user = s.who(ip, ts)
        if not match(user, ip, a):
            continue
        d = base_domain(name)
        if prev.get(ip) == (d, int(ts // 300)):     # collapse a page's many hostnames (5 min)
            continue
        prev[ip] = (d, int(ts // 300))
        rows.append((t, user, ip, d, name))
    return rows[-a.n:]


def cmd_history(a, s):
    table(history_rows(a, s), ("time", "user", "ip", "site", "hostname"))


def wf_row(line, s):
    m = WF_RE.search(line)
    if not m:
        return None
    t, router, cat, mac, src, dst, port = m.groups()
    ts = ts_of(t)
    if ts is None:
        return None
    return ts, t[:19].replace("T", " "), s.who(src, ts, mac or ""), src, (mac or "-").upper().replace(":", "-"), \
        cat, f"{dst}:{port}" if port else dst, router


def blocked_rows(a, s):
    """[(time, user, ip, mac, category, destination, router)] oldest first, last a.n."""
    since = time.time() - a.days * 86400
    rows = []
    for line in read_lines(WF_LOG, since):
        r = wf_row(line, s)
        if r and r[0] >= since and match(r[2], r[3], a):
            rows.append(r[1:])
    return rows[-a.n:]


SECURITY_TAGS = {"threat", "scan", "brute", "synflood"}
POLICY_SQL = ("SELECT u.username, COALESCE((SELECT r.value FROM radreply r WHERE r.username=u.username AND r.attribute='Mikrotik-Address-List' LIMIT 1), "
              "(SELECT gr.value FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname AND gr.attribute='Mikrotik-Address-List' "
              "WHERE g.username=u.username ORDER BY g.priority LIMIT 1), '') AS list FROM (SELECT DISTINCT username FROM radcheck) u")


def block_reason(tag):
    """Log prefix WF-<tag> -> what blocked it, in words."""
    if tag.startswith("app-"):
        return f"app {tag[4:]}"
    return {"vpn": "VPN / proxy", "allowonly": "not allowed (allow-only)", "noinet": "no internet", "keywords": "adult word in the name",
            "threat": "threat list (security)", "scan": "port scan (security)", "brute": "password guessing (security)",
            "synflood": "SYN flood (security)", "vpn-proxy": "VPN / proxy website"}.get(tag, f"category {tag}")


def user_policies(cnf, db):
    """username -> policy name (own, else the group's)."""
    try:
        out = subprocess.run(["mysql", f"--defaults-extra-file={cnf}", "-N", "-B", db, "-e", POLICY_SQL],
                             capture_output=True, text=True, timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    return {f[0]: f[1] for f in (l.split("\t") for l in out.splitlines()) if len(f) == 2}


def dns_names(since):
    """(client, ip) -> the name that client looked up for that ip; and ip -> any name (for blocked HTTPS)."""
    import cdnlearn
    by_client, by_ip = {}, {}
    for r in cdnlearn.parse(l for l in read_lines(DNS_LOG, since - 3600) if (ts_of(l.split(" ", 1)[0]) or 0) >= since - 3600):
        for ip in r["ips"]:
            by_client[(r["client"], ip)] = r["qname"]
            by_ip[ip] = r["qname"]
    return by_client, by_ip


def blocked_detail(a, s, policies):
    """Blocked attempts with the POLICY that blocked them, why, and the site name. Newest last."""
    since = time.time() - a.days * 86400
    by_client, by_ip = dns_names(since)
    out = []
    for line in read_lines(WF_LOG, since):
        m = WF_RE.search(line)
        if not m:
            continue
        t, router, tag, mac, src, dst, port = m.groups()
        ts = ts_of(t)
        if ts is None or ts < since:
            continue
        user = s.who(src, ts, mac or "")
        if not match(user, src, a):
            continue
        lst = policies.get(user, "") if user != "-" else ""
        policy = "security.rsc (everyone)" if tag in SECURITY_TAGS else lst[7:] if lst.startswith("policy-") else lst or "router list"
        if getattr(a, "policy", "") and policy != a.policy:
            continue
        out.append({"time": t[:19].replace("T", " "), "user": user, "ip": src, "mac": (mac or "-").upper().replace(":", "-"),
                    "policy": policy, "rule": tag, "reason": block_reason(tag),
                    "site": by_client.get((src, dst)) or by_ip.get(dst) or "", "destination": f"{dst}:{port}" if port else dst,
                    "router": router})
    return out[-a.n:]


def blocked_summary(rows):
    """[(policy, user, reason, count)] most first."""
    c = {}
    for r in rows:
        k = (r["policy"], r["user"], r["reason"])
        c[k] = c.get(k, 0) + 1
    return sorted(((p, u, why, n) for (p, u, why), n in c.items()), key=lambda x: -x[3])


def cmd_blocked(a, s):
    rows = blocked_detail(a, s, user_policies(a.cnf, a.db))
    if getattr(a, "summary", False):
        table(blocked_summary(rows), ("policy", "user", "blocked", "times"))
        return
    table([(r["time"], r["user"], r["ip"], r["policy"], r["reason"], r["site"] or "-", r["destination"]) for r in rows],
          ("time", "user", "ip", "policy", "blocked by", "site", "destination"))


def live_events(path, lines, s, last):
    """Turn new log lines into live events (dicts); 'last' de-duplicates repeated site lookups."""
    out = []
    for line in lines:
        if path == WF_LOG:
            r = wf_row(line, s)
            if r:
                out.append({"time": r[1], "user": r[2], "ip": r[3], "type": "blocked", "site": r[5], "detail": r[6]})
            continue
        for ts, t, ip, name in dns_events([line], 0):
            d = base_domain(name)
            if ts - last.get((ip, d), 0) < 30:
                continue
            last[(ip, d)] = ts
            out.append({"time": t, "user": s.who(ip, ts), "ip": ip, "type": "visit", "site": d, "detail": name})
    return out


def follow(paths):
    """tail -F for several files; survives log rotation."""
    fhs = {}
    for p in paths:
        try:
            fh = open(p, encoding="utf-8", errors="replace")
            fh.seek(0, os.SEEK_END)
            fhs[p] = (fh, os.fstat(fh.fileno()).st_ino)
        except OSError:
            fhs[p] = (None, None)
    while True:
        got = False
        for p, (fh, ino) in list(fhs.items()):
            if fh is not None:
                line = fh.readline()
                if line:
                    got = True
                    yield p, line
                    continue
            try:
                st = os.stat(p)
                if fh is None or st.st_ino != ino:
                    fhs[p] = (open(p, encoding="utf-8", errors="replace"), st.st_ino)
            except OSError:
                pass
        if not got:
            time.sleep(0.5)


def cmd_live(a, s):
    color = sys.stdout.isatty()
    red, dim, off = ("\033[31m", "\033[2m", "\033[0m") if color else ("", "", "")
    print(f"{dim}Live log — Ctrl+C to stop{off}", flush=True)
    last = {}
    try:
        for path, line in follow([DNS_LOG, WF_LOG]):
            s.refresh()
            if path == WF_LOG:
                r = wf_row(line, s)
                if r and match(r[2], r[3], a):
                    print(f"{r[1]}  {r[2]:<14} {r[3]:<15} {red}BLOCKED {r[5]} → {r[6]}{off}", flush=True)
                continue
            for ts, t, ip, name in dns_events([line], 0):
                user = s.who(ip, ts)
                d = base_domain(name)
                if not match(user, ip, a) or ts - last.get((ip, d), 0) < 30:
                    continue
                last[(ip, d)] = ts
                print(f"{t}  {user:<14} {ip:<15} {d:<28} {dim}{name}{off}", flush=True)
    except KeyboardInterrupt:
        print()


def human(n):
    for unit, size in (("GB", 1 << 30), ("MB", 1 << 20), ("KB", 1 << 10)):
        if n >= size:
            return f"{n / size:.1f} {unit}"
    return f"{n} B"


NOW_FILE = "/run/mikrotiklover/traffic-now.json"


def cmd_now(a, s):
    try:
        snap = json.load(open(NOW_FILE))
    except (OSError, ValueError):
        print("No live data yet — is the traffic collector on? (radius-admin traffic collector status)")
        return
    secs = max(snap.get("interval", 60), 1)
    rows = [r for r in snap["rows"] if match(r["user"] or "-", r["ip"], a)]
    rows.sort(key=lambda r: -(r["down"] + r["up"]))
    age = int(time.time() - snap["time"])
    print(f"Last {secs:.0f} s (updated {age} s ago)")
    table([(r["ip"], r["user"] or "-", r["site"], human(r["down"]), human(r["up"]),
            f"{(r['down'] + r['up']) * 8 / secs / 1e6:.2f} Mbps") for r in rows[:a.top]],
          ("ip", "user", "site", "download", "upload", "speed"))


def main():
    p = argparse.ArgumentParser(prog="radius-admin report")
    p.add_argument("--cnf", default="/etc/mikrotiklover-radius/my.cnf")
    p.add_argument("--db", default="radius")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("sites", "history", "blocked", "live", "now"):
        sp = sub.add_parser(name)
        sp.add_argument("-u", "--user", default="")
        sp.add_argument("--ip", default="")
        sp.add_argument("--days", type=float, default=1 if name != "sites" else 7)
        sp.add_argument("--top", type=int, default=30)
        sp.add_argument("n", nargs="?", type=int, default=50)
        if name == "blocked":
            sp.add_argument("--policy", default="")
            sp.add_argument("--summary", action="store_true")
    a = p.parse_args()
    s = Sessions(a.cnf, a.db, max(a.days, 1))
    s.refresh(force=True)
    {"sites": cmd_sites, "history": cmd_history, "blocked": cmd_blocked, "live": cmd_live, "now": cmd_now}[a.cmd](a, s)


if __name__ == "__main__":
    main()
