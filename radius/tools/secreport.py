#!/usr/bin/env python3
"""Monthly security report as a PDF (and a short text for WhatsApp / Telegram).

  secreport.py make [--month YYYY-MM] [--out DIR] [--cnf FILE] [--db NAME]   -> prints the PDF path
  secreport.py text [--month YYYY-MM] ...                                     -> the short summary

Default month: the last full month. Reports are kept in /var/lib/mikrotiklover/reports/.
"""
import os, sys
from datetime import date, timedelta
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import minipdf, insights  # noqa: E402

OUT = "/var/lib/mikrotiklover/reports"
CAT_COLORS = {"virus": (0.86, 0.15, 0.15), "attack": (0.92, 0.55, 0.05), "ddos": (0.45, 0.25, 0.75), "ransomware": (0.55, 0.05, 0.10)}
MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def month_range(m=None, today=None):
    today = today or date.today()
    if m:
        y, mo = (int(x) for x in m.split("-"))
    else:
        first = today.replace(day=1) - timedelta(days=1)
        y, mo = first.year, first.month
    start = date(y, mo, 1)
    end = date(y + (mo == 12), mo % 12 + 1, 1)
    pstart = date(y - (mo == 1), (mo - 2) % 12 + 1, 1)
    return start, end, pstart


def n(x):
    try:
        return int(float(x))
    except (TypeError, ValueError):
        return 0


def gather(rows, month=None, today=None):
    start, end, pstart = month_range(month, today)
    s, e, ps = start.isoformat(), end.isoformat(), pstart.isoformat()
    d = {"month": start.strftime("%Y-%m"), "title": f"{MONTHS[start.month]} {start.year}", "start": s, "end": e}
    cats = {c: {"now": 0, "high": 0, "before": 0} for c in CAT_COLORS}
    for c, w, cnt, hi in rows("SELECT category, IF(day >= '%s','now','before'), COUNT(*), SUM(severity='high') FROM ml_security_event "
                              "WHERE day >= '%s' AND day < '%s' GROUP BY 1, 2" % (s, ps, e)):
        if c in cats:
            cats[c][w] = n(cnt)
            if w == "now":
                cats[c]["high"] = n(hi)
    d["cats"] = cats
    per_day = {}
    for day, c, cnt in rows("SELECT day, category, COUNT(*) FROM ml_security_event WHERE day >= '%s' AND day < '%s' GROUP BY 1, 2" % (s, e)):
        per_day.setdefault(str(day), {})[c] = n(cnt)
    days, x = [], start
    while x < end:
        days.append((x.strftime("%d"), per_day.get(x.isoformat(), {})))
        x += timedelta(days=1)
    d["per_day"] = days
    d["types"] = [(t, c, n(cnt), n(hi), n(hits)) for t, c, cnt, hi, hits in rows(
        "SELECT type, category, COUNT(*), SUM(severity='high'), SUM(hits) FROM ml_security_event WHERE day >= '%s' AND day < '%s' "
        "GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 15" % (s, e))]
    d["infected"] = [(ip, u if u not in ("", "NULL") else "", t, n(hits), str(last)[:16]) for ip, u, t, hits, last in rows(
        "SELECT src_ip, MAX(username), GROUP_CONCAT(DISTINCT type ORDER BY type SEPARATOR ', '), SUM(hits), MAX(last_seen) "
        "FROM ml_security_event WHERE category='virus' AND src_ip <> '' AND day >= '%s' AND day < '%s' GROUP BY src_ip ORDER BY 4 DESC LIMIT 15" % (s, e))]
    d["attackers"] = [(ip, t, n(hits), str(last)[:16]) for ip, t, hits, last in rows(
        "SELECT src_ip, GROUP_CONCAT(DISTINCT type ORDER BY type SEPARATOR ', '), SUM(hits), MAX(last_seen) "
        "FROM ml_security_event WHERE category IN ('attack','ddos') AND src_ip <> '' AND day >= '%s' AND day < '%s' GROUP BY src_ip ORDER BY 3 DESC LIMIT 15" % (s, e))]
    d["lan"] = [(ip, t, det) for ip, t, det in rows(
        "SELECT src_ip, type, MAX(detail) FROM ml_security_event WHERE (type LIKE 'Fake DHCP%%' OR type LIKE 'ARP spoofing%%') "
        "AND day >= '%s' AND day < '%s' GROUP BY 1, 2 LIMIT 15" % (s, e))]
    d["quarantine"] = [(who, r, str(since)[:16], str(rel)[:16] if rel not in ("", "NULL", None) else "still") for who, r, since, rel in rows(
        "SELECT IF(username<>'', username, ip), reason, since, released_at FROM ml_quarantine WHERE since >= '%s' AND since < '%s' ORDER BY since LIMIT 30" % (s, e))]
    d["vpn"] = [(u, n(h), k) for u, h, k in rows(
        "SELECT IF(username<>'', username, client_ip), SUM(hits), GROUP_CONCAT(DISTINCT kind SEPARATOR ', ') FROM ml_vpn_event "
        "WHERE bucket >= '%s' AND bucket < '%s' GROUP BY 1 ORDER BY 2 DESC LIMIT 10" % (s, e))]
    brand = rows("SELECT v FROM ml_setting WHERE k='brand'")
    d["brand"] = brand[0][0] if brand else "MikrotikLover"
    d["words"] = words(d)
    d["advice"] = advice(d)
    return d


def words(d):
    c, out = d["cats"], []
    tot = sum(x["now"] for x in c.values())
    before = sum(x["before"] for x in c.values())
    if not tot:
        return ["Is mahine koi security alert nahi aaya. Network saaf raha."]
    out.append(f"Is mahine {tot} security alerts aaye" + (f" — pichle mahine {before} ({insights.change_words(insights.pct(tot, before))})." if before else "."))
    if d["infected"]:
        out.append(f"{len(d['infected'])} devices mein virus ki nishaniyan mili; sab se zyada: {d['infected'][0][0]}"
                   + (f" ({d['infected'][0][1]})" if d["infected"][0][1] else "") + f" — {d['infected'][0][2]}.")
    if d["attackers"]:
        out.append(f"{len(d['attackers'])} addresses ne hamla kiya; sab se zyada {d['attackers'][0][0]} ({d['attackers'][0][1]}, {d['attackers'][0][2]} baar).")
    if d["types"]:
        t = d["types"][0]
        out.append(f"Sab se aam masla: {t[0]} ({t[2]} alerts).")
    if d["lan"]:
        out.append(f"LAN ke andar khatra: {len(d['lan'])} nakli router / ARP spoofing ki koshish.")
    r = d["cats"].get("ransomware", {})
    if r.get("now"):
        out.append(f"Ransomware ki {r['now']} nishaniyan ({r.get('high', 0)} high): Tor / ransom-note sites, LAN mein phailna, "
                   "aam se zyada upload ya file server par achanak bahut data — Security → Ransomware.")
    if d["quarantine"]:
        out.append(f"{len(d['quarantine'])} devices quarantine kiye gaye.")
    if d["vpn"]:
        out.append(f"{len(d['vpn'])} users ne VPN / proxy chalane ki koshish ki (sab se zyada: {d['vpn'][0][0]}).")
    return out


def advice(d):
    a, types = [], " ".join(t[0] for t in d["types"]).lower()
    if d["infected"]:
        a.append("Infected devices ko antivirus se scan karein ya factory reset karein; zarurat ho to quarantine on rakhein (Security → Protection).")
    if "password guessing on the router" in types:
        a.append("Router ka Winbox / SSH internet se band karein (mikrotik/security.rsc) aur admin password lamba rakhein.")
    if "password guessing on a wi-fi" in types:
        a.append("Jin users ke password par guessing hui unke password badlein.")
    if d["lan"]:
        a.append("Nakli router / ARP spoofing: report mein diye MAC wala device dhoond kar network se hatayein; lan-guard.rsc ki 'hard protection' par ghaur karein.")
    if d["cats"].get("ransomware", {}).get("now"):
        a.append("Ransomware: jis PC par nishaniyan hain usay network se alag karein (Security → Ransomware → Cut off), file server / NAS check karein, "
                 "aur off-site backup chalta rakhein; 'Cut off a device by itself at risk 70+' on karne par ghaur karein.")
    if d["cats"]["ddos"]["now"]:
        a.append("DDoS: ISP se baat karein agar internet band hota raha; security.rsc ke SYN-flood rules lage hon.")
    if not a:
        a.append("Koi khaas qadam zaroori nahi. Backups aur updates chalte rahein (Health check).")
    return a


def make_pdf(d):
    doc = minipdf.PDF(title=f"Security report {d['title']}", footer=f"{d['brand']} — security report {d['title']}")
    doc.h1(f"Security report — {d['title']}", f"{d['brand']}   ·   {d['start']} to {d['end']} (excl.)   ·   made {date.today().isoformat()}")
    c = d["cats"]
    ch = lambda k: insights.change_words(insights.pct(c[k]["now"], c[k]["before"])) if c[k]["before"] else ("" if not c[k]["now"] else "new")  # noqa: E731
    doc.tiles([("Virus alerts", str(c["virus"]["now"]), f"{c['virus']['high']} high · {ch('virus')}", CAT_COLORS["virus"]),
               ("Hacker attacks", str(c["attack"]["now"]), f"{c['attack']['high']} high · {ch('attack')}", CAT_COLORS["attack"]),
               ("DDoS", str(c["ddos"]["now"]), f"{c['ddos']['high']} high · {ch('ddos')}", CAT_COLORS["ddos"]),
               ("Ransomware", str(c["ransomware"]["now"]), f"{c['ransomware']['high']} high · {ch('ransomware')}", CAT_COLORS["ransomware"]),
               ("Quarantined", str(len(d["quarantine"])), "devices cut off", (0.15, 0.39, 0.92))])
    doc.h2("In short")
    for w in d["words"]:
        doc.p(w, bullet=True)
    doc.h2("Alerts per day")
    doc.bars(d["per_day"], CAT_COLORS)
    doc.h2("What happened")
    doc.table(["Type", "Kind", "Alerts", "High", "Hits"], [(t, cat, cnt, hi, hits) for t, cat, cnt, hi, hits in d["types"]], [5, 1.2, 1, 1, 1])
    doc.h2("Infected devices (virus signs)")
    doc.table(["Device", "User", "What", "Hits", "Last"], d["infected"], [1.6, 1.3, 4, 0.8, 1.6], empty="None — no device showed virus signs.")
    doc.h2("Attackers")
    doc.table(["Address", "What", "Hits", "Last"], d["attackers"], [1.6, 4.5, 0.8, 1.6], empty="None.")
    if d["lan"]:
        doc.h2("Inside the LAN: fake router / ARP spoofing")
        doc.table(["Address", "What", "Details"], d["lan"], [1.4, 3, 4])
    doc.h2("Quarantine")
    doc.table(["Device / user", "Why", "Since", "Released"], d["quarantine"], [1.6, 4, 1.6, 1.6], empty="No device was quarantined.")
    if d["vpn"]:
        doc.h2("VPN / proxy attempts")
        doc.table(["User / device", "Attempts", "Kind"], d["vpn"], [2, 1, 5])
    doc.h2("What to do")
    for a in d["advice"]:
        doc.p(a, bullet=True)
    return doc.output()


def text(d):
    c = d["cats"]
    lines = [f"Security report {d['title']}: virus {c['virus']['now']}, attacks {c['attack']['now']}, DDoS {c['ddos']['now']}, "
             f"ransomware {c.get('ransomware', {}).get('now', 0)}, "
             f"quarantined {len(d['quarantine'])}."] + [f"• {w}" for w in d["words"]] + ["", "What to do:"] + [f"• {a}" for a in d["advice"]]
    return "\n".join(lines)


def main():
    a = sys.argv[1:]
    opt = lambda k, dflt: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else dflt  # noqa: E731
    cmd = a[0] if a and not a[0].startswith("--") else "make"
    month = opt("--month", None)
    if month and not (len(month) == 7 and month[4] == "-" and month[:4].isdigit() and month[5:].isdigit() and 1 <= int(month[5:]) <= 12):
        sys.exit("ERROR: --month like 2026-10")
    rows = insights.mysql_rows(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius"))
    d = gather(rows, month)
    if cmd == "text":
        print(text(d))
        return
    if cmd != "make":
        print(__doc__)
        sys.exit(1)
    out = opt("--out", OUT)
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f"security-{d['month']}.pdf")
    with open(path + ".tmp", "wb") as f:
        f.write(make_pdf(d))
    os.replace(path + ".tmp", path)
    print(path)


if __name__ == "__main__":
    main()
