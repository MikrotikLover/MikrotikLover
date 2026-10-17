#!/usr/bin/env python3
"""Reports aur samajh: this week vs last week in plain words, daily / hourly charts, top users and
apps with their change, and users whose data suddenly jumps (10x a normal day).

  insights.py report [--json] [--cnf FILE] [--db NAME]     this week (text, or JSON for the dashboard)
  insights.py anomalies [--json] [--cnf FILE] [--db NAME]  users far above their normal day

Data: traffic_site (traffic collector: per hour, user, site); users without traffic data fall back to
RADIUS accounting (radacct). The functions take a rows(sql) callable so the dashboard can use its own
database connection.
"""
import json, subprocess, sys
from datetime import date, timedelta
from statistics import median

ANOMALY_FACTOR = 10            # x a normal day
ANOMALY_MIN = 500 * 2**20      # and at least this much (small numbers jump easily)
ANOMALY_HISTORY_DAYS = 5       # days with data needed before a user can be "unusual"


def gb(n):
    n = float(n or 0)
    if n >= 2**40:
        return f"{n / 2**40:.1f} TB"
    if n >= 2**30:
        return f"{n / 2**30:.1f} GB"
    return f"{n / 2**20:.0f} MB"


def pct(now, before):
    if not before:
        return None
    return round((now - before) * 100.0 / before)


def change_words(p):
    if p is None:
        return "naya"
    if p == 0:
        return "utna hi"
    return f"{abs(p)}% {'zyada' if p > 0 else 'kam'}"


def mysql_rows(cnf, db):
    def rows(q):
        p = subprocess.run(["mysql", f"--defaults-extra-file={cnf}", "-N", "-B", db, "-e", q], capture_output=True, text=True, timeout=120)
        if p.returncode:
            raise RuntimeError(p.stderr.strip()[:200])
        return [tuple(l.split("\t")) for l in p.stdout.splitlines()]
    return rows


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


# ------------------------------------------------------------------ data
def daily_user(rows, days, today=None):
    """{(day 'YYYY-MM-DD', user): bytes} for the last `days` days (traffic data, else accounting)."""
    today = today or date.today()
    since = (today - timedelta(days=days - 1)).isoformat()
    out = {}
    for d, u, b in rows(f"SELECT DATE(bucket), IF(username='', client_ip, username), SUM(bytes_down + bytes_up) FROM traffic_site "
                        f"WHERE bucket >= '{since}' GROUP BY 1, 2"):
        out[(str(d), u)] = _num(b)
    have = {u for (_, u) in out}
    for d, u, b in rows(f"SELECT DATE(acctstarttime), username, SUM(acctinputoctets + acctoutputoctets) FROM radacct "
                        f"WHERE acctstarttime >= '{since}' AND username <> '' GROUP BY 1, 2"):
        if u not in have:
            out[(str(d), u)] = out.get((str(d), u), 0) + _num(b)
    return out


def report(rows, today=None):
    today = today or date.today()
    t0 = today - timedelta(days=6)            # this week: the last 7 days, today included
    p0 = today - timedelta(days=13)           # last week: the 7 days before
    du = daily_user(rows, 30, today)
    days = [(today - timedelta(days=i)).isoformat() for i in range(29, -1, -1)]
    per_day = {d: 0.0 for d in days}
    for (d, _), b in du.items():
        if d in per_day:
            per_day[d] += b
    this_u, last_u = {}, {}
    for (d, u), b in du.items():
        if d >= t0.isoformat():
            this_u[u] = this_u.get(u, 0) + b
        elif d >= p0.isoformat():
            last_u[u] = last_u.get(u, 0) + b
    tot_now, tot_before = sum(this_u.values()), sum(last_u.values())
    # sites (apps) from the traffic data
    this_s, last_s = {}, {}
    for s, w, b in rows(f"SELECT site, IF(bucket >= '{t0.isoformat()}', 'now', 'before'), SUM(bytes_down + bytes_up) FROM traffic_site "
                        f"WHERE bucket >= '{p0.isoformat()}' GROUP BY 1, 2"):
        (this_s if w == "now" else last_s)[s] = _num(b)
    # busiest hours (this week, average per day)
    hours = [0.0] * 24
    for h, b in rows(f"SELECT HOUR(bucket), SUM(bytes_down + bytes_up) FROM traffic_site WHERE bucket >= '{t0.isoformat()}' GROUP BY 1"):
        hours[int(h)] = _num(b) / 7
    # sales this week vs last week
    sales = {w: (int(_num(n)), _num(a)) for w, n, a in rows(
        f"SELECT IF(at >= '{t0.isoformat()}', 'now', 'before'), COUNT(*), IFNULL(SUM(amount),0) FROM ml_sale WHERE at >= '{p0.isoformat()}' GROUP BY 1")}
    top_users = [{"user": u, "now": b, "before": last_u.get(u, 0), "change": pct(b, last_u.get(u, 0))}
                 for u, b in sorted(this_u.items(), key=lambda x: -x[1])[:15]]
    top_sites = [{"site": s, "now": b, "before": last_s.get(s, 0), "change": pct(b, last_s.get(s, 0))}
                 for s, b in sorted(this_s.items(), key=lambda x: -x[1])[:15]]
    anomalies = find_anomalies(du, today)
    words = []
    if tot_now:
        words.append(f"Is hafte {gb(tot_now)} data istemal hua" + (f" — pichle hafte se {change_words(pct(tot_now, tot_before))}." if tot_before else "."))
        words.append(f"{len(this_u)} users / devices ne internet chalaya" + (f" (pichle hafte {len(last_u)})." if last_u else "."))
    else:
        words.append("Is hafte abhi koi data record nahi hua (traffic collector aur router ka traffic-flow check karein).")
    if top_sites:
        s = top_sites[0]
        words.append(f"Sab se zyada data {s['site']} par gaya: {gb(s['now'])} ({round(s['now'] * 100 / max(tot_now, 1))}%)"
                     + (f", pichle hafte se {change_words(s['change'])}." if s["before"] else "."))
        growers = [x for x in top_sites[:10] if x["before"] >= 2**30 / 10 and x["change"] is not None and x["change"] >= 50]
        if growers:
            g = max(growers, key=lambda x: x["change"])
            words.append(f"Sab se tezi se barha: {g['site']} ({change_words(g['change'])}).")
    if top_users:
        u = top_users[0]
        words.append(f"Sab se zyada data {u['user']} ne istemal kiya: {gb(u['now'])}.")
    if any(hours):
        h = max(range(24), key=lambda i: hours[i])
        q = min(range(6, 24), key=lambda i: hours[i])
        words.append(f"Sab se masroof waqt {h:02d}:00–{(h + 1) % 24:02d}:00; sab se khali (din mein) {q:02d}:00.")
    if sales.get("now"):
        n, a = sales["now"]
        bn, ba = sales.get("before", (0, 0))
        words.append(f"Is hafte {n} sales ({a:,.0f})" + (f" — pichle hafte {bn} ({ba:,.0f})." if bn else "."))
    for a in anomalies[:3]:
        words.append(f"⚠ {a['user']} ne {a['day']} ko {gb(a['bytes'])} istemal kiya — aam din ({gb(a['normal'])}) se {a['times']} guna.")
    return {"today": today.isoformat(), "week_start": t0.isoformat(), "total_now": tot_now, "total_before": tot_before,
            "change": pct(tot_now, tot_before), "users_now": len(this_u), "users_before": len(last_u),
            "daily": [{"day": d, "bytes": per_day[d]} for d in days], "hours": hours,
            "top_users": top_users, "top_sites": top_sites, "anomalies": anomalies, "words": words,
            "sales": {k: {"count": v[0], "amount": v[1]} for k, v in sales.items()}}


def find_anomalies(du, today=None, factor=ANOMALY_FACTOR, minimum=ANOMALY_MIN):
    """Users whose today / yesterday is `factor` x their normal (median) day of the 2 weeks before."""
    today = today or date.today()
    by_user = {}
    for (d, u), b in du.items():
        by_user.setdefault(u, {})[d] = b
    out = []
    for u, days in by_user.items():
        for dd in (today, today - timedelta(days=1)):
            d = dd.isoformat()
            b = days.get(d, 0)
            if b < minimum:
                continue
            hist = [v for k, v in days.items() if (dd - timedelta(days=15)).isoformat() <= k < d and v > 0]
            if len(hist) < ANOMALY_HISTORY_DAYS:
                continue
            normal = median(hist)
            if normal > 0 and b >= factor * normal:
                out.append({"user": u, "day": d, "bytes": b, "normal": normal, "times": int(b // normal)})
                break
    return sorted(out, key=lambda a: -a["times"])


def text_report(r, title=True):
    lines = (["📈 Is hafte ki report"] if title else []) + [f"• {w}" for w in r["words"]]
    if r["top_users"]:
        lines += ["", "Top users:"] + [f"{i}. {u['user']} — {gb(u['now'])}" + (f" ({'+' if u['change'] > 0 else ''}{u['change']}%)" if u["change"] is not None else " (naya)")
                                       for i, u in enumerate(r["top_users"][:10], 1)]
    if r["top_sites"]:
        lines += ["", "Top apps / sites:"] + [f"{i}. {s['site']} — {gb(s['now'])}" + (f" ({'+' if s['change'] > 0 else ''}{s['change']}%)" if s["change"] is not None else " (naya)")
                                              for i, s in enumerate(r["top_sites"][:10], 1)]
    return "\n".join(lines)


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    rows = mysql_rows(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"))
    cmd = a[0] if a and not a[0].startswith("--") else "report"
    if cmd == "report":
        r = report(rows)
        print(json.dumps(r) if "--json" in a else text_report(r))
    elif cmd == "anomalies":
        an = find_anomalies(daily_user(rows, 20))
        if "--json" in a:
            print(json.dumps(an))
        else:
            for x in an:
                print(f"{x['user']}\t{x['day']}\t{gb(x['bytes'])}\t{x['times']}x normal ({gb(x['normal'])})")
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
