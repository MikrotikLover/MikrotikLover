#!/usr/bin/env python3
"""CDN detective: which app or website is behind a hostname or an IP address?

Four kinds of evidence, strongest first:
  1. the hostname itself (cdn-apps.json: googlevideo.com -> YouTube, fbcdn.net -> Facebook, ...)
  2. the DNS logger: the name a client actually asked for before the answer pointed at a CDN
     (www.daraz.pk -> CNAME ...edgekey.net -> 23.x.x.x means 23.x.x.x is Daraz *for that client*)
  3. who owns the IP (ASN lists of Meta, Google, ByteDance, Netflix, Akamai, ...)
  4. context: for a bare shared-CDN name, the site the same device opened just before it

Used by mlreport.py / flowcollector.py (site names in reports), the dashboard and
"radius-admin cdn HOST|IP".  CLI:
  cdnmap.py lookup NAME_OR_IP [--json]
  cdnmap.py update                       download the ASN lists (ipverse/asn-ip on GitHub)
"""
import bisect, ipaddress, json, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "cdn-apps.json")
STATE = os.environ.get("MLCDN_STATE", "/var/lib/mikrotiklover")
LOCAL = os.path.join(STATE, "cdn-apps.local.json")
REMOTE = os.path.join(STATE, "cdn-apps.update.json")      # newer catalog downloaded by "catalog-update"
CATALOG_URL = os.environ.get("CATALOG_URL", "https://raw.githubusercontent.com/mikrotiklover/mikrotiklover/main/radius/tools/cdn-apps.json")
LEARNED = os.path.join(STATE, "cdn-apps.learned.json")
ASN_DB = os.path.join(STATE, "asn.json")
DNS_LOG = os.environ.get("MLREPORT_LOGDIR", "/var/log/mikrotik") + "/dns.log"

SLD = {"co", "com", "net", "org", "edu", "gov", "gob", "ac", "or", "ne", "go", "web", "biz", "info", "nic"}
EXTRA_RE = re.compile(r"^(\S+) .*?\b(\d+) (\d+\.\d+\.\d+\.\d+)/\d+ (query\[\w+\]|reply|cached|config) (\S+)(?: is (\S+))?")
IPV4_RE = re.compile(r"^\d+\.\d+\.\d+\.\d+$")


def registrable(name):
    parts = name.rstrip(".").lower().split(".")
    if len(parts) >= 3 and len(parts[-1]) == 2 and parts[-2] in SLD:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


class Catalog:
    def __init__(self, with_learned=True):
        self.suffix = {}        # domain -> entry
        self.asn = {}
        self.asn_sites = {}
        self.sources = {}       # domain -> builtin | local | learned
        for path in (DATA, REMOTE, LOCAL):
            try:
                data = json.load(open(path, encoding="utf-8"))
            except (OSError, ValueError):
                continue
            local = path == LOCAL
            newer = path != DATA          # the downloaded update and your own file win over the built-in list
            for e in data.get("apps", []):
                entry = {"app": e["app"], "site": e.get("site") or e["domains"][0], "category": e.get("category", ""),
                         "note": e.get("note", ""), "generic": False}
                for d in e.get("domains", []):
                    if newer or d.lower() not in self.suffix:
                        self.suffix[d.lower()] = entry
                        self.sources[d.lower()] = "local" if local else "builtin"
            for owner, doms in data.get("generic_cdns", {}).items():
                if owner.startswith("_"):
                    continue
                entry = {"app": owner, "site": "", "category": "cdn", "note": "Shared CDN: serves many websites", "generic": True}
                for d in doms:
                    self.suffix.setdefault(d.lower(), entry)
            self.asn.update({k: v for k, v in data.get("asn", {}).items() if not k.startswith("_")})
            self.asn_sites.update({k: v for k, v in data.get("asn_sites", {}).items() if not k.startswith("_")})
        # domains the learner found by itself (cdnlearn.py) — lowest priority
        self.learned = {}
        self.discovered = {}
        if with_learned:
            try:
                learned = json.load(open(LEARNED, encoding="utf-8"))
            except (OSError, ValueError):
                learned = {}
            # whole new apps discovered automatically (name + category guessed, admin can rename)
            for aid, a in learned.get("apps", {}).items():
                entry = {"app": a["app"], "site": a.get("site") or aid, "category": a.get("category", "other"),
                         "note": "new app discovered automatically", "generic": False, "discovered": aid}
                self.discovered[aid] = a
                for d in a.get("domains", []):
                    if d not in self.suffix:
                        self.suffix[d] = entry
                        self.sources[d] = "discovered"
            by_site = {e["site"]: e for e in self.suffix.values() if not e["generic"]}
            for d, info in learned.get("domains", {}).items():
                base = by_site.get(info.get("site"))
                if d in self.suffix or not base:
                    continue
                self.suffix[d] = {**base, "note": f"learned automatically ({info.get('why', '')})", "learned": True}
                self.sources[d] = "learned"
                self.learned[d] = info
        self._ranges = None

    def name(self, host):
        """Longest matching domain suffix -> entry (copy) with 'matched', or None."""
        host = host.rstrip(".").lower()
        labels = host.split(".")
        for i in range(len(labels) - 1):
            cand = ".".join(labels[i:])
            e = self.suffix.get(cand)
            if e:
                return {**e, "matched": cand}
        return None

    def site(self, host):
        """Report name for a hostname: the app's main site, else the registrable domain."""
        e = self.name(host)
        if e and not e["generic"]:
            return e["site"]
        return registrable(host)

    def apps(self):
        """{app: {site, category, domains: [{domain, source, ...}]}} for every known app."""
        out = {}
        for d, e in self.suffix.items():
            if e["generic"]:
                continue
            a = out.setdefault(e["app"], {"app": e["app"], "site": e["site"], "category": e["category"], "domains": [],
                                          "discovered": e.get("discovered")})
            if e.get("discovered"):
                info = self.discovered.get(e["discovered"], {})
                a.update({k: info.get(k) for k in ("first_seen", "last_seen", "devices", "queries", "name_from", "renamed", "title")})
            row = {"domain": d, "source": self.sources.get(d, "builtin")}
            if d in self.learned:
                row.update({k: self.learned[d].get(k) for k in ("score", "devices", "why", "first_seen", "last_seen")})
            a["domains"].append(row)
        for a in out.values():
            a["domains"].sort(key=lambda r: (r["source"] != "learned", r["domain"]))
        return out

    def ip_site(self, ip):
        """Site for an IP whose owner serves only one app (TikTok, Netflix, Telegram ...), else None."""
        o = self.ip_owner(ip)
        return self.asn_sites.get(o["owner"]) if o else None

    # ---- IP owners
    def ranges(self):
        if self._ranges is None:
            starts, rows = [], []
            try:
                db = json.load(open(ASN_DB))
            except (OSError, ValueError):
                db = {}
            items = []
            for owner, nets in db.get("owners", {}).items():
                for n in nets:
                    try:
                        net = ipaddress.ip_network(n)
                    except ValueError:
                        continue
                    items.append((int(net.network_address), int(net.broadcast_address), owner, n))
            items.sort()
            for a, b, owner, n in items:
                starts.append(a)
                rows.append((a, b, owner, n))
            self._ranges = (starts, rows, db.get("updated"))
        return self._ranges

    def ip_owner(self, ip):
        starts, rows, _ = self.ranges()
        try:
            x = int(ipaddress.ip_address(ip))
        except ValueError:
            return None
        i = bisect.bisect_right(starts, x) - 1
        # ranges may nest (more specific inside larger): walk back a little
        for j in range(i, max(i - 50, -1), -1):
            a, b, owner, n = rows[j]
            if a <= x <= b:
                return {"owner": owner, "network": n}
        return None


_CATALOG, _STAMP = None, None


def _stamp():
    out = []
    for p in (DATA, REMOTE, LOCAL, LEARNED, ASN_DB):
        try:
            out.append(os.path.getmtime(p))
        except OSError:
            out.append(0)
    return tuple(out)


def catalog():
    """Shared catalog; rebuilt when cdn-apps / local / learned / ASN files change (long-running services)."""
    global _CATALOG, _STAMP
    st = _stamp()
    if _CATALOG is None or st != _STAMP:
        _CATALOG, _STAMP = Catalog(), st
    return _CATALOG


def site_of(host):
    return catalog().site(host)


# ---------------------------------------------------------------- DNS evidence
def tail_lines(path, max_bytes=40_000_000):
    try:
        with open(path, "rb") as fh:
            size = os.path.getsize(path)
            fh.seek(max(0, size - max_bytes))
            if size > max_bytes:
                fh.readline()
            for raw in fh:
                yield raw.decode("utf-8", "replace")
    except OSError:
        return


def dns_evidence(target, lines=None):
    """What the DNS logger knows about a hostname or an IP: original names, answers, clients, context."""
    is_ip = bool(IPV4_RE.match(target))
    target = target.lower().rstrip(".")
    serial = {}                     # serial -> {client, qname, time, chain:[names], ips:[...]}
    recent_by_client = {}           # client -> [(time, qname)] last few, for context
    origins, answers, clients, context = {}, {}, {}, {}
    cat = catalog()
    for line in (lines if lines is not None else tail_lines(DNS_LOG)):
        m = EXTRA_RE.search(line)
        if not m:
            continue
        t, sid, client, action, name, answer = m.groups()
        name = name.rstrip(".").lower()
        if action.startswith("query"):
            serial[sid] = {"client": client, "qname": name, "time": t[:19].replace("T", " ")}
            hist = recent_by_client.setdefault(client, [])
            if not is_ip and name == target:
                # context: the last non-CDN site this device asked for in the 15 s before
                for ht, hq in reversed(hist[-20:]):
                    e = cat.name(hq)
                    if (e and e["generic"]) or hq == target:
                        continue
                    if _secs(ht, t) <= 15:
                        s = cat.site(hq)
                        context[s] = context.get(s, 0) + 1
                    break
            hist.append((t, name))
            if len(hist) > 40:
                del hist[:20]
            if len(serial) > 200000:
                for k in list(serial)[:50000]:
                    del serial[k]
            continue
        q = serial.get(sid)
        if not q:
            continue
        hit = (answer == target) if is_ip else (name == target and q["qname"] != target)
        if is_ip and not hit:
            continue
        if not is_ip and name == target and answer and IPV4_RE.match(answer):
            answers[answer] = answers.get(answer, 0) + 1
        if hit:
            o = origins.setdefault(q["qname"], {"count": 0, "last": q["time"], "clients": set()})
            o["count"] += 1
            o["last"] = q["time"]
            o["clients"].add(q["client"])
            clients[q["client"]] = clients.get(q["client"], 0) + 1
    return {
        "origins": sorted(({"name": k, "site": cat.site(k), "count": v["count"], "last": v["last"],
                            "clients": sorted(v["clients"])[:10]} for k, v in origins.items()),
                          key=lambda x: -x["count"])[:30],
        "answers": sorted(answers, key=lambda k: -answers[k])[:20],
        "clients": sorted(clients, key=lambda k: -clients[k])[:20],
        "context": sorted(({"site": k, "count": v} for k, v in context.items()), key=lambda x: -x["count"])[:10],
    }


def _secs(a, b):
    try:
        from datetime import datetime
        return abs((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds())
    except ValueError:
        return 999


def lookup(target, lines=None):
    """Full detective answer for a hostname or IPv4 address."""
    target = target.strip().lower().rstrip(".")
    is_ip = bool(IPV4_RE.match(target))
    if not is_ip and not re.match(r"^[a-z0-9_.-]{1,253}$", target):
        raise ValueError("Enter a hostname (e.g. scontent.xx.fbcdn.net) or an IPv4 address")
    cat = catalog()
    res = {"query": target, "type": "ip" if is_ip else "hostname", "name_match": None, "ip_owner": None}
    ev = dns_evidence(target, lines)
    res["evidence"] = ev
    if is_ip:
        res["ip_owner"] = cat.ip_owner(target)
    else:
        res["name_match"] = cat.name(target)
        owners = {}
        for ip in ev["answers"][:5]:
            o = cat.ip_owner(ip)
            if o:
                owners[o["owner"]] = owners.get(o["owner"], 0) + 1
        if owners:
            res["ip_owner"] = {"owner": max(owners, key=owners.get), "network": "(from the IPs it resolved to)"}

    # verdict
    nm = res["name_match"]
    origin_sites = {}
    for o in ev["origins"]:
        origin_sites[o["site"]] = origin_sites.get(o["site"], 0) + o["count"]
    v = None
    if nm and not nm["generic"]:
        v = {"app": nm["app"], "site": nm["site"], "category": nm["category"], "confidence": "high",
             "reason": f"Hostname matches {nm['matched']}" + (f" — {nm['note']}" if nm["note"] else "")}
    elif origin_sites:
        best = max(origin_sites, key=origin_sites.get)
        e = cat.name(best)
        share = origin_sites[best] / max(sum(origin_sites.values()), 1)
        v = {"app": e["app"] if e and not e["generic"] else best, "site": best, "category": (e or {}).get("category", ""),
             "confidence": "high" if share > .8 else "medium",
             "reason": f"Devices asked the DNS for {best} and got this {'IP' if is_ip else 'CDN name'}"
                       + (f" ({round(share * 100)}% of lookups; also: {', '.join(k for k in origin_sites if k != best)[:120]})" if share < 1 else "")}
    elif ev["context"]:
        best = ev["context"][0]["site"]
        e = cat.name(best)
        v = {"app": e["app"] if e and not e["generic"] else best, "site": best, "category": (e or {}).get("category", ""),
             "confidence": "low", "reason": f"Shared CDN name; the device opened {best} just before asking for it"}
    elif res["ip_owner"]:
        owner = res["ip_owner"]["owner"]
        shared = "shared" in owner.lower()
        v = {"app": owner, "site": "", "category": "cdn" if shared else "",
             "confidence": "low" if shared else "medium",
             "reason": f"IP belongs to {owner} ({res['ip_owner']['network']})" + (" — a shared CDN, the app is unknown" if shared else "")}
    elif nm:
        v = {"app": nm["app"], "site": "", "category": "cdn", "confidence": "low",
             "reason": f"{nm['matched']} is a shared CDN ({nm['app']}); no DNS evidence yet — check again after users browse"}
    else:
        v = {"app": registrable(target) if not is_ip else "unknown", "site": "" if is_ip else registrable(target),
             "category": "", "confidence": "none", "reason": "Not in the catalog and no DNS evidence"}
    res["verdict"] = v
    return res


def rsc_for(app):
    """RouterOS script that blocks every known domain of an app (built-in + local + learned)."""
    cat = catalog()
    info = cat.apps().get(app)
    if not info:
        raise ValueError(f"unknown app {app!r}")
    slug = re.sub(r"[^a-z0-9]+", "-", app.lower()).strip("-")
    lines = [f"# Block {app} — {len(info['domains'])} domains (MikrotikLover CDN detective, {time.strftime('%Y-%m-%d')})",
             f"# Undo: /ip dns static remove [find comment=\"webfilter:app-{slug}\"]",
             "/ip dns static", f"remove [find comment=\"webfilter:app-{slug}\"]"]
    for r in info["domains"]:
        d = r["domain"]
        if re.match(r"^[a-z0-9.-]+$", d):
            lines.append(f"add name={d} type=NXDOMAIN match-subdomain=yes comment=\"webfilter:app-{slug}\"")
    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------- ASN lists
def catalog_update(url=CATALOG_URL, out=REMOTE):
    """Download a newer app catalog (same format as cdn-apps.json); kept only if it is valid."""
    if not url:
        print("no CATALOG_URL set")
        return
    req = urllib.request.Request(url, headers={"User-Agent": "MikrotikLover-RADIUS"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read(5_000_000).decode("utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit(f"catalog update failed: {e}")
    apps = data.get("apps") if isinstance(data, dict) else None
    dom_re = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")
    if not isinstance(apps, list) or len(apps) < 10 or not all(
            isinstance(a, dict) and isinstance(a.get("app"), str) and isinstance(a.get("domains"), list)
            and all(isinstance(d, str) and dom_re.match(d.lower()) for d in a["domains"]) for a in apps):
        raise SystemExit("catalog update: the downloaded file is not a valid app catalog; keeping the current one")
    builtin = json.load(open(DATA, encoding="utf-8"))
    if data == builtin:
        print(f"app catalog: up to date ({len(apps)} entries)")
        return
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    json.dump(data, open(tmp, "w"), indent=1)
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)
    print(f"app catalog updated: {len(apps)} entries ({len({a['app'] for a in apps})} apps)")


def update(out=ASN_DB):
    cat = Catalog()
    owners, failed = {}, []
    for owner, asns in cat.asn.items():
        nets = []
        for a in asns:
            url = f"https://raw.githubusercontent.com/ipverse/asn-ip/master/as/{int(a)}/ipv4-aggregated.txt"
            try:
                with urllib.request.urlopen(url, timeout=30) as r:
                    for line in r.read().decode().splitlines():
                        line = line.strip()
                        if re.match(r"^\d+\.\d+\.\d+\.\d+/\d+$", line):
                            nets.append(line)
            except OSError as e:
                failed.append(f"AS{a}: {e}")
        if nets:
            owners[owner] = nets
    if not owners:
        raise SystemExit("No ASN list could be downloaded: " + "; ".join(failed))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = out + ".tmp"
    json.dump({"updated": time.strftime("%Y-%m-%d %H:%M"), "owners": owners}, open(tmp, "w"))
    os.chmod(tmp, 0o644)
    os.replace(tmp, out)
    print(f"ASN lists: {sum(len(v) for v in owners.values())} networks for {len(owners)} owners -> {out}")
    for f in failed:
        print(f"  warning: {f}", file=sys.stderr)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "update":
        return update()
    if len(sys.argv) >= 2 and sys.argv[1] == "catalog-update":
        return catalog_update(sys.argv[2] if len(sys.argv) > 2 else CATALOG_URL)
    if len(sys.argv) == 3 and sys.argv[1] == "domains" or len(sys.argv) == 4 and sys.argv[1:3] == ["domains", "--category"]:
        # domains APP | domains --category CAT  -> every known domain, one per line (for webfilter/build.sh)
        want = sys.argv[-1].lower()
        apps = catalog().apps()
        out = set()
        for a in apps.values():
            if (a["category"].lower() == want) if len(sys.argv) == 4 else (want in (a["app"].lower(), a["site"].lower())):
                out.update(r["domain"] for r in a["domains"] if re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", r["domain"]))
        if not out and len(sys.argv) == 3:
            raise SystemExit(f"unknown app {sys.argv[2]!r}")
        print("\n".join(sorted(out)))
        return
    if len(sys.argv) >= 3 and sys.argv[1] == "lookup":
        try:
            r = lookup(sys.argv[2])
        except ValueError as e:
            raise SystemExit(str(e))
        if "--json" in sys.argv:
            print(json.dumps(r, indent=2, default=list))
            return
        v = r["verdict"]
        print(f"{r['query']}  →  {v['app']}" + (f"  ({v['site']})" if v["site"] and v["site"] != v["app"] else "")
              + f"   [confidence: {v['confidence']}]")
        print(f"  why: {v['reason']}")
        if r["name_match"]:
            print(f"  name: {r['name_match']['matched']} = {r['name_match']['app']}")
        if r["ip_owner"]:
            print(f"  IP owner: {r['ip_owner']['owner']} {r['ip_owner']['network']}")
        ev = r["evidence"]
        if ev["origins"]:
            print("  DNS: devices asked for")
            for o in ev["origins"][:8]:
                print(f"    {o['name']:<40} {o['count']:>5}x  last {o['last']}  e.g. {', '.join(o['clients'][:3])}")
        if ev["answers"]:
            print(f"  resolved to: {', '.join(ev['answers'][:8])}")
        if ev["context"]:
            print("  opened just before: " + ", ".join(f"{c['site']} ({c['count']}x)" for c in ev["context"][:5]))
        return
    print(__doc__)
    sys.exit(1)


if __name__ == "__main__":
    main()
