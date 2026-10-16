#!/usr/bin/env python3
"""App inventory: every app used on the network, built automatically from the DNS log.

Each DNS lookup is matched to an app (built-in catalog + learned domains + automatically discovered
new apps, see cdnmap.py / cdnlearn.py). The result is written to two tables:
  ml_app      one row per app ever seen: name, category, first seen, last seen   (kept for good)
  ml_app_day  per day, app and device: lookups and user                          (kept KEEP_DAYS)

  appinv.py sql [--hours H] [--cnf FILE] [--db NAME]   print the SQL for the last H hours (default:
                                                        since the start of yesterday) — radius-admin
                                                        pipes it into MariaDB every hour
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cdnmap, cdnlearn  # noqa: E402

KEEP_DAYS = int(os.environ.get("APP_DAYS", "180"))


def resolve(cat, rec):
    """DNS lookup -> catalog entry of its app, or None (unknown / shared CDN)."""
    for n in [rec["qname"]] + rec["chain"]:
        e = cat.name(n)
        if e and not e["generic"]:
            return e
    return None


def source_of(cat, e):
    if e.get("discovered"):
        return "discovered"
    return "local" if cat.sources.get(e["matched"]) == "local" else "builtin"


def inventory(recs, cat, who=lambda ip, t: ""):
    """-> (apps {site: {...}}, days {(day, site, client): [queries, user]}, unknown lookups)."""
    apps, days, unknown = {}, {}, 0
    for r in recs:
        e = resolve(cat, r)
        if not e:
            unknown += 1
            continue
        site, t = e["site"], r["t"]
        a = apps.get(site)
        if not a:
            a = apps[site] = {"site": site, "app": e["app"], "category": e.get("category") or "other",
                              "source": source_of(cat, e), "first": t, "last": t}
        a["first"], a["last"] = min(a["first"], t), max(a["last"], t)
        k = (time.strftime("%Y-%m-%d", time.localtime(t)), site, r["client"])
        v = days.setdefault(k, [0, ""])
        v[0] += 1
        v[1] = who(r["client"], t) or v[1]
    return apps, days, unknown


def esc(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def dt(t):
    return esc(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t)))


def sql(apps, days, since_day):
    out = ["START TRANSACTION;"]
    for a in apps.values():
        out.append("INSERT INTO ml_app (site, app, category, source, first_seen, last_seen) VALUES "
                   f"({esc(a['site'])},{esc(a['app'][:64])},{esc(a['category'][:32])},{esc(a['source'])},{dt(a['first'])},{dt(a['last'])}) "
                   "ON DUPLICATE KEY UPDATE app=VALUES(app), category=VALUES(category), source=VALUES(source), "
                   "first_seen=LEAST(first_seen, VALUES(first_seen)), last_seen=GREATEST(last_seen, VALUES(last_seen));")
    # the days read here are rebuilt completely, so running every hour never counts twice
    out.append(f"DELETE FROM ml_app_day WHERE day >= {esc(since_day)};")
    rows = [f"({esc(d)},{esc(s)},{esc(c)},{esc((u or '')[:64])},{q})" for (d, s, c), (q, u) in sorted(days.items())]
    for i in range(0, len(rows), 500):
        out.append("INSERT INTO ml_app_day (day, site, client_ip, username, queries) VALUES " + ",".join(rows[i:i + 500]) + ";")
    out.append(f"DELETE FROM ml_app_day WHERE day < CURDATE() - INTERVAL {KEEP_DAYS} DAY;")
    out.append("COMMIT;")
    return "\n".join(out) + "\n"


def main():
    args = sys.argv[1:]
    if not args or args[0] != "sql":
        print(__doc__)
        sys.exit(1)
    opt = lambda k, d: args[args.index(k) + 1] if k in args else d  # noqa: E731
    lt = time.localtime()
    since = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday - 1, 0, 0, 0, 0, 0, -1))   # start of yesterday
    if "--hours" in args:
        since = time.time() - float(opt("--hours", 48)) * 3600
        lt = time.localtime(since)
        since = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday, 0, 0, 0, 0, 0, -1))      # whole days only
    lines = [l for l in cdnmap.tail_lines(cdnmap.DNS_LOG, 400_000_000) if (cdnlearn.ts(l.split(" ", 1)[0]) or 0) >= since]
    recs = cdnlearn.parse(lines)
    who = lambda ip, t: ""  # noqa: E731
    cnf = opt("--cnf", "")
    if cnf:
        import mlreport
        s = mlreport.Sessions(cnf, opt("--db", "radius"), max(1, (time.time() - since) / 86400))
        s.refresh(force=True)
        memo = {}

        def who(ip, t):
            k = (ip, int(t // 300))
            if k not in memo:
                u = s.who(ip, t)
                memo[k] = "" if u == "-" else u
            return memo[k]
    apps, days, unknown = inventory(recs, cdnmap.catalog(), who)
    sys.stdout.write(sql(apps, days, time.strftime("%Y-%m-%d", time.localtime(since))))
    print(f"appinv: {len(recs)} lookups, {len(apps)} apps, {unknown} not matched to an app", file=sys.stderr)


if __name__ == "__main__":
    main()
