#!/usr/bin/env python3
"""Auto-learn which app a domain belongs to, from the DNS logger (runs hourly from cron).

Every app (Facebook, YouTube, TikTok, ...) starts with the built-in domain list in cdn-apps.json.
The learner grows these lists by itself from what devices actually do:

  cname  a known app name points (CNAME) to an unknown domain:   www.tiktok.com -> x.tiktokcdn-eu.com
         or an unknown name points into a known app:             foo.example.com -> star.c10r.facebook.com
  ip     an unknown domain resolves only into an IP owner that serves one app (ByteDance -> TikTok)
  cooc   devices ask for the unknown domain within 5 s after the app (needs several devices and
         a clear majority, so shared things like analytics SDKs are not learned)

Each piece of evidence adds to a score per (domain, app); a domain is learned when the score is
high enough, enough devices showed it and one app clearly wins. Learned domains are stored in
/var/lib/mikrotiklover/cdn-apps.learned.json and are used by every report, the dashboard and the
RouterOS block export. Wrong ones can be rejected (never learned again).

New apps: unknown domains that many devices use are grouped into apps (CNAME links, asked
together, same brand name, same IPs) and each group gets a name automatically — the website's
own title when the server can fetch it (public IPs only), else the brand part of the domain —
plus a category guess. The admin can rename, merge into a known app or reject.

  cdnlearn.py run [--hours 48]       learn + discover from the recent DNS log
  cdnlearn.py list [APP]             learned domains
  cdnlearn.py apps                   discovered apps
  cdnlearn.py reject DOMAIN          remove + never learn again      (unreject DOMAIN to undo)
  cdnlearn.py rename ID NAME [CATEGORY] | merge ID 'KNOWN APP' | drop ID
"""
import html, ipaddress, json, os, re, socket, ssl, sys, time
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdnmap  # noqa: E402

MIN_SCORE = 6          # e.g. two CNAME sightings, or CNAME + IP, or 6 co-occurrences
MIN_SHARE = 0.75       # winning app's share of all votes for the domain
COOC_WINDOW = 5        # seconds
COOC_MIN_DEVICES = 3
NEVER = {"localhost", "local", "lan", "arpa", "home", "internal"}


def ts(t):
    try:
        return datetime.fromisoformat(t).timestamp()
    except ValueError:
        return None


def parse(lines):
    """-> list of lookups {t, client, qname, chain:[names], ips:[...]} in time order."""
    recs, by_serial = [], {}
    for line in lines:
        m = cdnmap.EXTRA_RE.search(line)
        if not m:
            continue
        t, sid, client, action, name, answer = m.groups()
        name = name.rstrip(".").lower()
        if action.startswith("query"):
            if not action.startswith("query[A") and not action.startswith("query[HTTPS"):
                continue
            r = {"t": ts(t), "client": client, "qname": name, "chain": [], "ips": []}
            if r["t"] is None:
                continue
            by_serial[sid] = r
            recs.append(r)
            if len(by_serial) > 300000:
                for k in list(by_serial)[:100000]:
                    del by_serial[k]
            continue
        r = by_serial.get(sid)
        if not r:
            continue
        if name != r["qname"] and name not in r["chain"]:
            r["chain"].append(name)
        if answer and cdnmap.IPV4_RE.match(answer):
            r["ips"].append(answer)
    return recs


def learnable(dom, cat):
    if not dom or "." not in dom or dom.split(".")[-1] in NEVER:
        return False
    if re.match(r"^[0-9.]+$", dom) or dom.endswith(".in-addr.arpa"):
        return False
    return cat.name(dom) is None          # not built-in, not local, not a shared CDN


def learn(lines, previous=None, now=None):
    now = now or time.time()
    cat = cdnmap.Catalog(with_learned=False)
    disc = cdnmap.Catalog(with_learned=True)      # discovered apps count as known apps here
    for d, e in disc.suffix.items():
        if e.get("discovered") and d not in cat.suffix:
            cat.suffix[d] = e
    site_app = {e["site"]: e for e in cat.suffix.values() if not e["generic"]}
    votes = {}                            # domain -> app -> {score, devices:set, ev:{}}
    seen_devices = {}                     # domain -> devices that asked for it at all

    def vote(dom, entry, kind, client, w):
        v = votes.setdefault(dom, {}).setdefault(entry["app"], {"score": 0, "devices": set(), "ev": {}, "site": entry["site"]})
        v["score"] += w
        v["devices"].add(client)
        v["ev"][kind] = v["ev"].get(kind, 0) + 1

    recs = parse(lines)
    last_app = {}                         # client -> (t, entry) of the last known-app lookup
    for r in recs:
        q = r["qname"]
        e = cat.name(q)
        known = e if e and not e["generic"] else None
        reg = cdnmap.registrable(q)
        if not known and learnable(reg, cat):
            seen_devices.setdefault(reg, set()).add(r["client"])
        if known:
            last_app[r["client"]] = (r["t"], known)
            for c in r["chain"]:                      # cname: app -> unknown
                creg = cdnmap.registrable(c)
                if learnable(creg, cat) and learnable(c, cat):
                    vote(creg, known, "cname", r["client"], 3)
            continue
        if not learnable(reg, cat):
            continue
        for c in r["chain"]:                          # cname: unknown -> app
            ce = cat.name(c)
            if ce and not ce["generic"]:
                vote(reg, ce, "cname", r["client"], 3)
                break
        sites = {cat.ip_site(ip) for ip in r["ips"]}  # ip: single-app owner
        if r["ips"] and len(sites) == 1:
            s = sites.pop()
            if s in site_app:
                vote(reg, site_app[s], "ip", r["client"], 2)
        prev = last_app.get(r["client"])              # cooc: right after an app
        if prev and 0 <= r["t"] - prev[0] <= COOC_WINDOW:
            vote(reg, prev[1], "cooc", r["client"], 1)

    learned = dict((previous or {}).get("domains", {}))
    rejected = set((previous or {}).get("rejected", []))
    added = []
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    for dom, apps in votes.items():
        if dom in rejected:
            continue
        total = sum(v["score"] for v in apps.values())
        app, best = max(apps.items(), key=lambda kv: kv[1]["score"])
        share = best["score"] / total if total else 0
        devices = len(best["devices"])
        strong = best["ev"].get("cname", 0) + best["ev"].get("ip", 0)
        if best["score"] < MIN_SCORE or share < MIN_SHARE:
            continue
        if not strong:                    # co-occurrence only: stricter
            asked = len(seen_devices.get(dom, ()))
            if devices < COOC_MIN_DEVICES or (asked and devices / asked < 0.6):
                continue
        why = ", ".join(f"{k} x{v}" for k, v in sorted(best["ev"].items()))
        old = learned.get(dom)
        learned[dom] = {"app": app, "site": best["site"], "score": best["score"] + (old or {}).get("score", 0) // 2,
                        "devices": max(devices, (old or {}).get("devices", 0)), "share": round(share, 2), "why": why,
                        "first_seen": (old or {}).get("first_seen", stamp), "last_seen": stamp}
        if not old:
            added.append((dom, app, why))
    out = dict(previous or {})
    out.update({"updated": stamp, "domains": learned, "rejected": sorted(rejected)})
    return out, added


def load():
    try:
        return json.load(open(cdnmap.LEARNED, encoding="utf-8"))
    except (OSError, ValueError):
        return {"domains": {}, "rejected": []}


def save(data):
    os.makedirs(os.path.dirname(cdnmap.LEARNED), exist_ok=True)
    tmp = cdnmap.LEARNED + ".tmp"
    json.dump(data, open(tmp, "w", encoding="utf-8"), indent=1, sort_keys=True)
    os.chmod(tmp, 0o644)
    os.replace(tmp, cdnmap.LEARNED)


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else ""
    if cmd == "run":
        hours = float(args[args.index("--hours") + 1]) if "--hours" in args else 48
        since = time.time() - hours * 3600
        lines = (l for l in cdnmap.recent_lines(cdnmap.DNS_LOG, since, 200_000_000) if (ts(l.split(" ", 1)[0]) or 0) >= since)
        lines = list(lines)
        data, added = learn(lines, load())
        print(f"learned domains: {len(data['domains'])} total, {len(added)} new")
        for d, app, why in added:
            print(f"  + {d:<32} -> {app}   ({why})")
        known_ids = set(data.get("apps", {}))
        data, found = discover(lines, data, titles=None if "--no-titles" in args else fetch_title)
        save(data)
        fresh = [a for a in found if a["site"] not in known_ids]
        print(f"discovered apps: {len(data.get('apps', {}))} total, {len(fresh)} new")
        for a in fresh:
            print(f"  * {a['app']:<24} [{a['category']}] {', '.join(a['domains'])}  ({a['devices']} devices, name from {a['name_from']})")
    elif cmd == "list":
        data = load()
        app = args[1].lower() if len(args) > 1 else ""
        rows = sorted((v["app"], d, v) for d, v in data.get("domains", {}).items() if not app or v["app"].lower() == app)
        for a, d, v in rows:
            print(f"{a:<22} {d:<34} score {v['score']:<4} devices {v['devices']:<3} {v['why']}  (first {v['first_seen']})")
        print(f"{len(rows)} learned domain(s); rejected: {', '.join(data.get('rejected', [])) or '-'}")
    elif cmd == "titles":
        # weekly: discovered apps still named after their domain get their website's name (and category)
        data = load()
        n = 0
        for aid, a in data.get("apps", {}).items():
            if a.get("renamed") or a.get("name_from") == "website":
                continue
            title = fetch_title(a.get("site") or aid)
            if title:
                a.update(app=title, name_from="website", title=title,
                         category=guess_category(f"{title} {' '.join(a.get('domains', []))}"))
                n += 1
                print(f"  {aid}: {title} [{a['category']}]")
        save(data)
        print(f"{n} app name(s) updated from their websites")
    elif cmd in ("apps", "rename", "merge", "drop"):
        _discovery_cli(cmd, args[1:])
    elif cmd in ("reject", "unreject") and len(args) == 2:
        dom = args[1].lower().rstrip(".")
        if not re.match(r"^[a-z0-9.-]{1,253}$", dom):
            raise SystemExit("invalid domain")
        data = load()
        rej = set(data.get("rejected", []))
        if cmd == "reject":
            data.get("domains", {}).pop(dom, None)
            rej.add(dom)
        else:
            rej.discard(dom)
        data["rejected"] = sorted(rej)
        save(data)
        print(f"{dom}: {cmd}ed")
    else:
        print(__doc__)
        sys.exit(1)



# ---------------------------------------------------------------- discovering new apps
BRAND_STRIP = re.compile(r"^(www|m|api|apis|cdn|cdns|static|img|imgs|image|images|media|v\d*|s\d*|"
                         r"app|apps|assets|edge|content|dl|download|upload|gateway|gw|log|logs|stat|stats)-|"
                         r"-(cdn|static|api|img|media|assets|edge|app|apps|global|online|prod)$")
CATEGORY_WORDS = [
    ("adult", r"porn|xxx|sex|nude|adult|hentai|escort"),
    ("video", r"video|tv|stream|movie|film|drama|anime|clip|tube|live|reel|short"),
    ("gaming", r"game|gaming|play|pubg|clash|arena|esport|casino|slot|ludo|bet"),
    ("messaging", r"chat|messag|call|talk|voip|meet"),
    ("shopping", r"shop|store|mart|buy|deal|bazar|bazaar|sale|cart|order"),
    ("finance", r"bank|pay|wallet|cash|loan|finance|money|crypto|exchange|trade|paisa"),
    ("music", r"music|song|radio|audio|podcast|sound"),
    ("vpn", r"vpn|proxy|tunnel|unblock"),
    ("news", r"news|times|daily|tribune|dawn|geo|ary|express"),
    ("education", r"learn|edu|school|course|study|academy|quiz|university"),
    ("social", r"social|friend|dating|match|community|forum|share"),
]


def brand(dom):
    """'snackvideo-cdn.com' -> 'snackvideo'; the label users would recognise."""
    label = dom.split(".")[0]
    prev = None
    while prev != label:
        prev, label = label, BRAND_STRIP.sub("", label)
    return label or dom.split(".")[0]


def guess_category(text):
    t = text.lower()
    for cat, rx in CATEGORY_WORDS:
        if re.search(rx, t):
            return cat
    return "other"


def _public(host):
    """All addresses of host are public (no LAN / localhost / CGNAT): no SSRF into the network."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


def fetch_title(dom, timeout=5):
    """Website name from <title> / og:site_name of https://www.DOM or https://DOM; '' if not possible."""
    import http.client
    for host in (f"www.{dom}", dom):
        if not _public(host):
            continue
        try:
            conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=ssl.create_default_context())
            conn.request("GET", "/", headers={"User-Agent": "Mozilla/5.0 (MikrotikLover app discovery)", "Accept": "text/html"})
            resp = conn.getresponse()
            if resp.status != 200 or "html" not in resp.getheader("Content-Type", ""):
                conn.close()
                continue
            page = resp.read(200_000).decode("utf-8", "replace")
            conn.close()
        except (OSError, http.client.HTTPException, ssl.SSLError):
            continue
        for rx in (r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\']([^"\']{2,80})',
                   r'<meta[^>]+name=["\']application-name["\'][^>]+content=["\']([^"\']{2,80})',
                   r"<title[^>]*>([^<]{2,200})</title>"):
            m = re.search(rx, page, re.I)
            if m:
                name = clean_title(m.group(1))
                if name:
                    return name
    return ""


def clean_title(raw):
    """'Zing Clips - Short Videos &amp; more' -> 'Zing Clips'; '' for useless titles."""
    name = html.unescape(raw or "").strip()
    name = re.split(r"\s+[-|–—:·•]\s+", name)[0].strip()
    if 2 <= len(name) <= 40 and not re.search(r"(?i)^(home|index|welcome|404|403|error|just a moment|attention|access denied)", name):
        return name
    return ""


class _UF:
    def __init__(self):
        self.p = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def discover(lines, previous=None, now=None, titles=fetch_title, min_devices=3):
    """Group unknown, widely used domains into new apps and name them. Returns (data, new_apps)."""
    now = now or time.time()
    data = dict(previous or {"domains": {}, "rejected": []})
    apps = dict(data.get("apps", {}))
    ignored = set(data.get("ignored", []))
    cat = cdnmap.Catalog(with_learned=True)
    recs = parse(lines)

    devices, queries, ips_of = {}, {}, {}
    uf, pair = _UF(), {}
    last = {}                                   # client -> (t, reg) of the previous unknown lookup
    for r in recs:
        reg = cdnmap.registrable(r["qname"])
        if not learnable(reg, cat) or not learnable(r["qname"], cat) or reg in ignored:
            last.pop(r["client"], None) if cat.name(r["qname"]) else None
            continue
        devices.setdefault(reg, set()).add(r["client"])
        queries[reg] = queries.get(reg, 0) + 1
        uf.find(reg)
        for ip in r["ips"]:
            ips_of.setdefault(ip, set()).add(reg)
        for c in r["chain"]:                     # CNAME between two unknown domains = same app
            creg = cdnmap.registrable(c)
            if creg != reg and learnable(creg, cat) and learnable(c, cat) and creg not in ignored:
                uf.union(reg, creg)
                devices.setdefault(creg, set()).add(r["client"])   # a CNAME target is part of the app too
                queries[creg] = queries.get(creg, 0) + 1
        prev = last.get(r["client"])
        if prev and prev[1] != reg and 0 <= r["t"] - prev[0] <= 3:
            key = tuple(sorted((prev[1], reg)))
            p = pair.setdefault(key, {"n": 0, "dev": set()})
            p["n"] += 1
            p["dev"].add(r["client"])
        last[r["client"]] = (r["t"], reg)

    for (a, b), p in pair.items():               # asked together, repeatedly, by several devices
        if p["n"] >= 3 and len(p["dev"]) >= 2 and p["n"] >= 0.5 * min(queries.get(a, 1), queries.get(b, 1)):
            uf.union(a, b)
    by_brand = {}
    for reg in queries:                          # same brand label: snackvideo.in / snackvideo-cdn.com
        b = brand(reg)
        if len(b) >= 5:
            by_brand.setdefault(b, []).append(reg)
    for regs in by_brand.values():
        for x in regs[1:]:
            uf.union(regs[0], x)
    for ip, regs in ips_of.items():              # same (non shared-CDN) IP
        regs = sorted(regs)
        if len(regs) > 1 and not (cat.ip_owner(ip) or {}).get("owner", "").lower().count("shared") \
                and len(regs) <= 5:
            for x in regs[1:]:
                uf.union(regs[0], x)

    clusters = {}
    for reg in queries:
        clusters.setdefault(uf.find(reg), []).append(reg)
    stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(now))
    new_apps = []
    for regs in clusters.values():
        devs = set().union(*(devices[r] for r in regs))
        nq = sum(queries[r] for r in regs)
        if len(devs) < min_devices and not (len(devs) >= 2 and nq >= 20):
            continue
        # main domain: its brand recurs in the group (zingclips.in, zingclips-cdn.com), then most devices
        brand_count = {}
        for r in regs:
            brand_count[brand(r)] = brand_count.get(brand(r), 0) + 1
        leader = sorted(regs, key=lambda r: (-brand_count[brand(r)], -len(devices[r]), -queries[r], len(r)))[0]
        title = clean_title(titles(leader)) if titles else ""
        name = title or brand(leader).replace("-", " ").title()
        if any(a["app"].lower() == name.lower() for a in cat.apps().values() if not a.get("discovered")):
            name = f"{name} ({leader})"           # never shadow a known app's name
        app_id = leader
        apps[app_id] = {"app": name, "site": leader, "category": guess_category(f"{title} {' '.join(regs)}"),
                        "domains": sorted(regs), "devices": len(devs), "queries": nq, "name_from": "website" if title else "domain",
                        "first_seen": stamp, "last_seen": stamp, "renamed": False, "title": title}
        new_apps.append(apps[app_id])
    data["apps"] = apps
    return data, new_apps


def _discovery_cli(cmd, args):
    data = load()
    apps = data.setdefault("apps", {})
    if cmd == "apps":
        for aid, a in sorted(apps.items(), key=lambda kv: kv[1]["app"].lower()):
            print(f"{a['app']:<26} [{a.get('category', '')}] {', '.join(a['domains'])}   "
                  f"devices {a.get('devices')}  name from {a.get('name_from')}  (id {aid})")
        print(f"{len(apps)} discovered app(s)")
        return
    aid = args[0] if args else ""
    if aid not in apps:
        raise SystemExit(f"no discovered app with id {aid!r} (see: cdnlearn.py apps)")
    if cmd == "rename":
        name = args[1] if len(args) > 1 else ""
        if not re.match(r"^[\w .&+()'/-]{2,40}$", name):
            raise SystemExit("name: 2-40 letters, digits, space . & + ( ) ' / -")
        apps[aid]["app"], apps[aid]["renamed"] = name, True
        if len(args) > 2:
            if not re.match(r"^[a-z]{2,20}$", args[2]):
                raise SystemExit("category: lowercase word")
            apps[aid]["category"] = args[2]
        print(f"{aid}: renamed to {name}")
    elif cmd == "merge":
        target = args[1] if len(args) > 1 else ""
        known = cdnmap.Catalog(with_learned=False).apps()
        if target not in known:
            raise SystemExit(f"unknown app {target!r} (see: radius-admin cdn apps)")
        stamp = time.strftime("%Y-%m-%d %H:%M")
        for d in apps[aid]["domains"]:
            data.setdefault("domains", {})[d] = {"app": target, "site": known[target]["site"], "score": 99, "devices": apps[aid].get("devices", 0),
                                                 "share": 1, "why": "merged by admin", "first_seen": stamp, "last_seen": stamp}
        del apps[aid]
        print(f"{aid}: merged into {target}")
    elif cmd == "drop":
        data.setdefault("ignored", [])
        data["ignored"] = sorted(set(data["ignored"]) | set(apps[aid]["domains"]))
        del apps[aid]
        print(f"{aid}: dropped (its domains will not be discovered again)")
    save(data)


if __name__ == "__main__":
    main()
