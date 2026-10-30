#!/usr/bin/env python3
"""Offline tests for the domain auto-learner (tools/cdnlearn.py)."""
import json, os, sys, tempfile
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
json.dump({"updated": "test", "owners": {"ByteDance (TikTok)": ["71.18.0.0/16"]}}, open(f"{state}/asn.json", "w"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import cdnmap, cdnlearn  # noqa: E402

lines, serial = [], [100]
def look(sec, client, qname, chain=(), ips=()):
    serial[0] += 1
    s, t = serial[0], f"2026-10-16T10:{sec // 60:02d}:{sec % 60:02d}+00:00"
    lines.append(f"{t} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 query[A] {qname} from {client}")
    names = [qname] + list(chain)
    for i, n in enumerate(names):
        last = i == len(names) - 1
        for ip in (ips if last else ["<CNAME>"]):
            lines.append(f"{t} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 reply {n} is {ip}")

# 1) CNAME app -> new domain, two devices
look(1, "10.0.0.1", "www.tiktok.com", ["v19.tiktok.newtiktokcdn.com"], ["1.2.3.4"])
look(9, "10.0.0.2", "www.tiktok.com", ["v19.tiktok.newtiktokcdn.com"], ["1.2.3.4"])
# 2) unknown name CNAMEs into Facebook
look(20, "10.0.0.3", "img.fbnew.net", ["scontent.xx.fbcdn.net"], ["157.240.1.1"])
look(25, "10.0.0.4", "img.fbnew.net", ["scontent.xx.fbcdn.net"], ["157.240.1.1"])
# 3) unknown domain resolving only into ByteDance IPs, three devices
for i, c in enumerate(["10.0.0.5", "10.0.0.6", "10.0.0.7"]):
    look(40 + i, c, "api.bytenew.com", [], ["71.18.5.5"])
# 4) co-occurrence: tkstatic.net right after tiktok.com, 4 devices, 6 times
t = 100
for c in ["10.0.1.1", "10.0.1.2", "10.0.1.3", "10.0.1.4", "10.0.1.1", "10.0.1.2"]:
    look(t, c, "m.tiktok.com", [], ["9.9.9.9"]); look(t + 2, c, "cdn.tkstatic.net", [], ["8.8.4.4"]); t += 20
# 5) shared SDK after many different apps -> must NOT be learned
t = 300
for app in ["www.youtube.com", "www.tiktok.com", "www.facebook.com", "www.netflix.com", "web.whatsapp.com", "www.youtube.com", "www.facebook.com", "x.com", "www.tiktok.com"]:
    for c in ["10.0.2.1", "10.0.2.2"]:
        look(t, c, app, [], ["9.9.9.9"]); look(t + 1, c, "app-measurement.com", [], ["8.8.4.4"])
    t += 10
# 6) co-occurrence with only 2 devices -> not enough
for c in ["10.0.3.1", "10.0.3.2", "10.0.3.1", "10.0.3.2", "10.0.3.1", "10.0.3.2"]:
    look(t, c, "www.snapchat.com", [], ["9.9.9.9"]); look(t + 1, c, "rare-snaptool.io", [], ["8.8.4.4"]); t += 20

data, added = cdnlearn.learn(lines, {"domains": {}, "rejected": []})
d = data["domains"]
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond

check("cname app->new: newtiktokcdn.com -> TikTok", d.get("newtiktokcdn.com", {}).get("app") == "TikTok", d.get("newtiktokcdn.com"))
check("cname new->app: fbnew.net -> Facebook", d.get("fbnew.net", {}).get("app") == "Facebook", d.get("fbnew.net"))
check("ip owner: bytenew.com -> TikTok", d.get("bytenew.com", {}).get("app") == "TikTok", d.get("bytenew.com"))
check("co-occurrence: tkstatic.net -> TikTok", d.get("tkstatic.net", {}).get("app") == "TikTok", d.get("tkstatic.net"))
check("shared SDK app-measurement.com NOT learned", "app-measurement.com" not in d, d.get("app-measurement.com"))
check("co-occurrence with 2 devices NOT learned", "rare-snaptool.io" not in d, d.get("rare-snaptool.io"))

cdnlearn.save(data)
cdnmap._CATALOG = None
cat = cdnmap.catalog()
e = cat.name("v1.newtiktokcdn.com")
check("catalog uses learned domains", e and e["app"] == "TikTok" and e.get("learned"), e)
check("apps() lists learned with source", any(r["domain"] == "tkstatic.net" and r["source"] == "learned" for r in cat.apps()["TikTok"]["domains"]))
check("RouterOS export includes learned", "name=tkstatic.net" in cdnmap.rsc_for("TikTok"))

# reject: removed and never learned again
data["domains"].pop("tkstatic.net"); data["rejected"] = ["tkstatic.net"]
data2, added2 = cdnlearn.learn(lines, data)
check("rejected domain is not learned again", "tkstatic.net" not in data2["domains"], data2["domains"].get("tkstatic.net"))
check("second run adds nothing new", added2 == [], added2)
sys.exit(1 if fail else 0)
