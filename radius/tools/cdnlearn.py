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

  cdnlearn.py run [--hours 48]       learn from the recent DNS log
  cdnlearn.py list [APP]             learned domains
  cdnlearn.py reject DOMAIN          remove + never learn again      (unreject DOMAIN to undo)
"""
import json, os, re, sys, time
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
    return {"updated": stamp, "domains": learned, "rejected": sorted(rejected)}, added


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
        lines = (l for l in cdnmap.tail_lines(cdnmap.DNS_LOG, 200_000_000) if (ts(l.split(" ", 1)[0]) or 0) >= since)
        data, added = learn(lines, load())
        save(data)
        print(f"learned domains: {len(data['domains'])} total, {len(added)} new")
        for d, app, why in added:
            print(f"  + {d:<32} -> {app}   ({why})")
    elif cmd == "list":
        data = load()
        app = args[1].lower() if len(args) > 1 else ""
        rows = sorted((v["app"], d, v) for d, v in data.get("domains", {}).items() if not app or v["app"].lower() == app)
        for a, d, v in rows:
            print(f"{a:<22} {d:<34} score {v['score']:<4} devices {v['devices']:<3} {v['why']}  (first {v['first_seen']})")
        print(f"{len(rows)} learned domain(s); rejected: {', '.join(data.get('rejected', [])) or '-'}")
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


if __name__ == "__main__":
    main()
