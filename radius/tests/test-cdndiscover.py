#!/usr/bin/env python3
"""Offline tests for new-app discovery (tools/cdnlearn.py discover)."""
import json, os, sys, tempfile, subprocess
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
json.dump({"updated": "test", "owners": {}}, open(f"{state}/asn.json", "w"))
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import cdnmap, cdnlearn  # noqa: E402

lines, serial = [], [100]
def look(sec, client, qname, chain=(), ips=("203.0.113.9",)):
    serial[0] += 1
    s, t = serial[0], f"2026-10-16T11:{sec // 60:02d}:{sec % 60:02d}+00:00"
    lines.append(f"{t} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 query[A] {qname} from {client}")
    names = [qname] + list(chain)
    for i, n in enumerate(names):
        for ip in (ips if i == len(names) - 1 else ["<CNAME>"]):
            lines.append(f"{t} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 reply {n} is {ip}")

t = 0
for rnd in range(2):
    for c in ["10.1.0.1", "10.1.0.2", "10.1.0.3"]:
        look(t, c, "api.zingclips.in", ["edge.zc-feed.net"], ["198.51.100.7"]); t += 1     # CNAME into zc-feed.net
        look(t, c, "img.zingclips-cdn.com", [], ["198.51.100.8"]); t += 1                  # same brand
        look(t, c, "log.zcstat.io", [], ["198.51.100.9"]); t += 30                          # asked together
for c in ["10.2.0.1", "10.2.0.2", "10.2.0.3", "10.2.0.4"]:
    look(t, c, "inapp.appsflyersdk.com"); t += 5                                            # shared SDK
look(t, "10.3.0.1", "lonely-blog.example.org"); t += 5                                       # one device only
for i in range(25):
    look(t, "10.4.0.%d" % (1 + i % 2), "ludo-kingdom.net", [], ["198.51.100.50"]); t += 40  # 2 devices, many queries
for c in ["10.5.0.1", "10.5.0.2", "10.5.0.3"]:
    look(t, c, "www.tiktok.com"); t += 50                                                    # known app: not "new"

titles = {"zingclips.in": "Zing Clips - Short Videos & Funny Clips"}
data, found = cdnlearn.discover(lines, {"domains": {}, "rejected": []}, titles=lambda d: titles.get(d, ""))
apps = {a["site"]: a for a in found}
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond

sv = apps.get("zingclips.in")
check("new app found and grouped (CNAME + brand + asked-together)",
      sv and set(sv["domains"]) == {"zingclips.in", "zc-feed.net", "zingclips-cdn.com", "zcstat.io"}, sv)
check("name from the website title: 'Zing Clips'", sv and sv["app"] == "Zing Clips" and sv["name_from"] == "website", sv and sv["app"])
check("category guessed: video", sv and sv["category"] == "video", sv and sv["category"])
check("shared SDK (appsflyer) is not an app", not any("appsflyersdk.com" in a["domains"] for a in found), found)
check("single-device domain not an app", "example.org" not in apps)
lk = apps.get("ludo-kingdom.net")
check("2 devices but many queries -> app, name from domain 'Ludo Kingdom'... category gaming",
      lk and lk["name_from"] == "domain" and lk["category"] == "gaming", lk)
check("known app (tiktok) not rediscovered", "tiktok.com" not in apps)

cdnlearn.save(data)
cdnmap._CATALOG = None
e = cdnmap.catalog().name("x.zc-feed.net")
check("catalog: discovered app used everywhere (reports/detective)", e and e["app"] == "Zing Clips" and e["site"] == "zingclips.in", e)
check("report site name for its CDN = zingclips.in", cdnmap.catalog().site("img.zingclips-cdn.com") == "zingclips.in")
check("RouterOS export for a discovered app", "name=zcstat.io" in cdnmap.rsc_for("Zing Clips"))

# next run: no duplicate; a new CNAME target joins the discovered app via the learner
for c in ["10.1.0.1", "10.1.0.2"]:
    look(t, c, "api.zingclips.in", ["v.zingimg-new.net"], ["198.51.100.70"]); t += 10
data2, added = cdnlearn.learn(lines, data)
data2, found2 = cdnlearn.discover(lines, data2, titles=lambda d: "")
check("second run: Zing Clips not discovered twice", not any(a["site"] == "zingclips.in" for a in found2), [a["site"] for a in found2])
check("new CDN of a discovered app is learned into it", data2["domains"].get("zingimg-new.net", {}).get("app") == "Zing Clips",
      data2["domains"].get("zingimg-new.net"))

# admin actions through the CLI
cdnlearn.save(data2)
run = lambda *a: subprocess.run([sys.executable, os.path.join(here, "..", "tools", "cdnlearn.py"), *a], capture_output=True, text=True, env=os.environ)
r = run("rename", "ludo-kingdom.net", "Ludo Kingdom Pro", "gaming")
check("rename", "renamed" in r.stdout and cdnlearn.load()["apps"]["ludo-kingdom.net"]["app"] == "Ludo Kingdom Pro", r.stdout + r.stderr)
r = run("merge", "zingclips.in", "Kwai / Snack Video")
d = cdnlearn.load()
check("merge into a known app", "zingclips.in" not in d["apps"] and d["domains"]["zcstat.io"]["app"] == "Kwai / Snack Video", r.stdout + r.stderr)
r = run("drop", "ludo-kingdom.net")
d = cdnlearn.load()
data3, found3 = cdnlearn.discover(lines, d, titles=lambda x: "")
check("drop: never discovered again", not any(a["site"] == "ludo-kingdom.net" for a in found3), [a["site"] for a in found3])
r = run("rename", "no-such", "X")
check("rename unknown id fails", r.returncode != 0)
sys.exit(1 if fail else 0)
