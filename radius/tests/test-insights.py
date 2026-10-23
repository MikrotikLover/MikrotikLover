#!/usr/bin/env python3
"""Offline tests for "reports aur samajh" (tools/insights.py): week vs week, words, top lists, unusual use."""
import os, sys
from datetime import date, timedelta
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import insights  # noqa: E402

fails = 0


def check(name, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))
    fails += 0 if cond else 1


TODAY = date(2026, 10, 19)
GB = 2**30


def fake(traffic, acct=(), sales=()):
    """traffic: [(day offset, hour, user, site, bytes)]"""
    def rows(q):
        if "FROM traffic_site" in q and "DATE(bucket)" in q:
            agg = {}
            for off, _, u, _, b in traffic:
                k = ((TODAY - timedelta(days=off)).isoformat(), u)
                agg[k] = agg.get(k, 0) + b
            return [(d, u, str(b)) for (d, u), b in agg.items()]
        if "FROM traffic_site" in q and "HOUR(bucket)" in q:
            agg = {}
            for off, h, _, _, b in traffic:
                if off <= 6:
                    agg[h] = agg.get(h, 0) + b
            return [(str(h), str(b)) for h, b in agg.items()]
        if "FROM traffic_site" in q:
            agg = {}
            for off, _, _, s, b in traffic:
                if off <= 13:
                    k = (s, "now" if off <= 6 else "before")
                    agg[k] = agg.get(k, 0) + b
            return [(s, w, str(b)) for (s, w), b in agg.items()]
        if "FROM radacct" in q:
            return [((TODAY - timedelta(days=off)).isoformat(), u, str(b)) for off, u, b in acct]
        if "FROM ml_sale" in q:
            return list(sales)
        return []
    return rows


t = []
for off in range(14):
    w = 2 if off <= 6 else 1                                   # this week twice last week
    t.append((off, 20, "ali", "youtube.com", 1 * GB * w))
    t.append((off, 9, "sara", "facebook.com", GB // 4))
    t.append((off, 21, "sara", "tiktok.com", (GB // 2) * (4 if off <= 6 else 1)))   # tiktok 4x
t.append((0, 22, "bilal", "netflix.com", 9 * GB))             # bilal: today 9 GB ...
for off in range(1, 12):
    t.append((off, 22, "bilal", "netflix.com", 300 * 2**20))  # ... normal day 300 MB
acct = [(1, "pppoe-only", 5 * GB), (0, "ali", 50 * GB)]      # ali has traffic data: accounting not added twice
r = insights.report(fake(t, acct, [("now", "12", "6000"), ("before", "10", "5000")]), TODAY)
check("week total and change", r["change"] is not None and r["total_now"] > r["total_before"], (r["total_now"], r["total_before"]))
check("users: traffic users + accounting-only user", r["users_now"] == 4 and any(u["user"] == "pppoe-only" for u in r["top_users"]), r["top_users"])
check("ali not counted twice (traffic wins over accounting)", next(u for u in r["top_users"] if u["user"] == "ali")["now"] == 14 * GB, r["top_users"])
top = r["top_sites"][0]
check("top site this week: youtube, +100%", top["site"] == "youtube.com" and top["change"] == 100, top)
check("words: plain sentences", r["words"][0].startswith("Is hafte") and "zyada" in r["words"][0], r["words"])
check("words: fastest grower (netflix, bilal 9 GB)", any("tezi se barha: netflix.com" in w for w in r["words"]), r["words"])
check("words: busiest hour 20:00", any("masroof waqt 20:00–21:00" in w for w in r["words"]), r["words"])
check("words: sales this vs last week", any("12 sales" in w and "pichle hafte 10" in w for w in r["words"]), r["words"])
an = r["anomalies"]
check("unusual use: bilal today 9 GB = 30x a 300 MB day", len(an) == 1 and an[0]["user"] == "bilal" and an[0]["times"] == 30, an)
check("unusual use is in the words", any(w.startswith("⚠ bilal") for w in r["words"]), r["words"])
check("30 days of daily totals, today last", len(r["daily"]) == 30 and r["daily"][-1]["day"] == TODAY.isoformat())
check("24 hours", len(r["hours"]) == 24 and r["hours"][22] > 0)
# anomaly rules
du = {((TODAY - timedelta(days=i)).isoformat(), "x"): 100 * 2**20 for i in range(1, 10)}
du[(TODAY.isoformat(), "x")] = 400 * 2**20                            # 4x but under 500 MB
check("small jump (under 500 MB) is not unusual", insights.find_anomalies(du, TODAY) == [])
du[(TODAY.isoformat(), "x")] = 900 * 2**20                            # 9x
check("9x is not unusual (10x needed)", insights.find_anomalies(du, TODAY) == [])
du[(TODAY.isoformat(), "x")] = 1200 * 2**20
check("12x and over 500 MB is unusual", len(insights.find_anomalies(du, TODAY)) == 1)
du2 = {((TODAY - timedelta(days=i)).isoformat(), "new"): 100 * 2**20 for i in range(1, 4)}
du2[(TODAY.isoformat(), "new")] = 5 * GB
check("new user (3 days history) is not judged", insights.find_anomalies(du2, TODAY) == [])
du3 = {((TODAY - timedelta(days=i)).isoformat(), "y"): 100 * 2**20 for i in range(2, 10)}
du3[((TODAY - timedelta(days=1)).isoformat(), "y")] = 3 * GB
check("yesterday counts too", [a["day"] for a in insights.find_anomalies(du3, TODAY)] == [(TODAY - timedelta(days=1)).isoformat()])
check("gb()", insights.gb(1.5 * GB) == "1.5 GB" and insights.gb(300 * 2**20) == "300 MB" and insights.gb(3 * 2**40) == "3.0 TB")
e = insights.report(fake([]), TODAY)
check("no data: says so, no crash", e["total_now"] == 0 and "traffic collector" in e["words"][0] and e["top_users"] == [])
txt = insights.text_report(r)
check("text report (weekly message): words + top lists", txt.startswith("📈") and "Top users:" in txt and "1. " in txt and "(+" in txt)
print("all insights tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
