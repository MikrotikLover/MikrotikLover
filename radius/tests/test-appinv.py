#!/usr/bin/env python3
"""Offline tests for the automatic app inventory (tools/appinv.py)."""
import json, os, sys, tempfile, time
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
json.dump({"updated": "test", "owners": {}}, open(f"{state}/asn.json", "w"))
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import cdnmap, cdnlearn, appinv  # noqa: E402

# a discovered app (as cdnlearn.py would have saved it)
json.dump({"domains": {}, "rejected": [], "apps": {"zingclips.in": {
    "app": "Zing Clips", "site": "zingclips.in", "category": "video", "domains": ["zingclips.in", "zc-feed.net"],
    "devices": 3, "queries": 9, "name_from": "website", "first_seen": "2026-10-16 10:00", "last_seen": "2026-10-16 10:00"}}},
    open(f"{state}/cdn-apps.learned.json", "w"))

lines, serial = [], [100]
T0 = time.mktime((2026, 10, 15, 9, 0, 0, 0, 0, -1))
def look(t, client, qname, chain=()):
    serial[0] += 1
    s = serial[0]
    ts = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t)) + "+00:00"
    lines.append(f"{ts} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 query[A] {qname} from {client}")
    for n in [qname] + list(chain):
        lines.append(f"{ts} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 reply {n} is <CNAME>")
    lines.append(f"{ts} 127.0.0.1 dnsmasq[1]: {s} {client}/5000 reply {(list(chain) or [qname])[-1]} is 203.0.113.9")

ali, sara, bilal = "10.0.0.11", "10.0.0.12", "10.0.0.13"
look(T0, ali, "www.facebook.com"); look(T0 + 5, ali, "video.xx.fbcdn.net"); look(T0 + 9, ali, "g.whatsapp.net")
look(T0 + 86400, ali, "rr3---sn-x.googlevideo.com")                                   # next day
look(T0 + 20, sara, "v16.tiktokcdn.com"); look(T0 + 21, sara, "api.pubgmobile.com")
look(T0 + 30, sara, "trk.example-redirect.net", ["edge.instagram.com"])              # CNAME into Instagram
look(T0 + 40, bilal, "g.whatsapp.net"); look(T0 + 41, bilal, "api.zingclips.in")      # discovered app
look(T0 + 42, bilal, "x.zc-feed.net")
look(T0 + 50, bilal, "d1234.cloudfront.net")                                          # shared CDN: no app
look(T0 + 51, bilal, "some-unknown-blog.org")                                          # unknown

cdnmap._CATALOG = None
recs = cdnlearn.parse(lines)
users = {ali: "ali", sara: "sara", bilal: "bilal"}
apps, days, unknown = appinv.inventory(recs, cdnmap.catalog(), lambda ip, t: users.get(ip, ""))
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond

names = {a["app"] for a in apps.values()}
check("apps found: Facebook WhatsApp YouTube TikTok PUBG Instagram Zing Clips",
      names == {"Facebook", "WhatsApp", "YouTube", "TikTok", "PUBG Mobile", "Instagram", "Zing Clips"}, names)
check("discovered app has source 'discovered' and its category", apps["zingclips.in"]["source"] == "discovered"
      and apps["zingclips.in"]["category"] == "video", apps.get("zingclips.in"))
check("built-in app source 'builtin'", apps["facebook.com"]["source"] == "builtin")
check("CNAME into Instagram counts as Instagram", "instagram.com" in apps)
check("shared CDN + unknown site are not apps (2 unmatched)", unknown == 2, unknown)
d1, d2 = time.strftime("%Y-%m-%d", time.localtime(T0)), time.strftime("%Y-%m-%d", time.localtime(T0 + 86400))
check("facebook: 2 lookups by ali on day 1 (page + video)", days.get((d1, "facebook.com", ali)) == [2, "ali"], days.get((d1, "facebook.com", ali)))
check("whatsapp used by 2 devices", sum(1 for (d, s, c) in days if s == "whatsapp.com") == 2)
check("youtube counted on day 2", (d2, "youtube.com", ali) in days)
check("zing clips: both domains -> 2 lookups", days.get((d1, "zingclips.in", bilal)) == [2, "bilal"], days.get((d1, "zingclips.in", bilal)))
check("first/last seen span both days", apps["youtube.com"]["first"] == apps["youtube.com"]["last"] == T0 + 86400
      and apps["facebook.com"]["first"] == T0)
sql = appinv.sql(apps, days, d1)
check("SQL: re-runs replace the days read (no double count)", f"DELETE FROM ml_app_day WHERE day >= '{d1}';" in sql)
check("SQL: first_seen never moves later", "first_seen=LEAST(first_seen" in sql)
check("SQL escaping", appinv.esc("it's\\x") == "'it\\'s\\\\x'")
hosts, per_day = appinv.domains(recs, cdnmap.catalog())
check("every website name saved, subdomains too", {"www.facebook.com", "video.xx.fbcdn.net", "rr3---sn-x.googlevideo.com",
      "some-unknown-blog.org", "d1234.cloudfront.net"} <= set(hosts), sorted(hosts))
check("subdomain keeps its domain + app", hosts["video.xx.fbcdn.net"]["base"] == "fbcdn.net" and hosts["video.xx.fbcdn.net"]["app"] == "Facebook",
      hosts.get("video.xx.fbcdn.net"))
check("unknown site saved without app", hosts["some-unknown-blog.org"]["app"] == "")
check("IPs of the answer saved", hosts["www.facebook.com"]["ips"] == ["203.0.113.9"], hosts["www.facebook.com"])
check("CNAME target saved with the asked name (instagram via redirect)", hosts["trk.example-redirect.net"]["app"] == "Instagram")
check("per day: lookups + devices", per_day[(d1, "g.whatsapp.net")] == [2, {ali, bilal}], per_day.get((d1, "g.whatsapp.net")))
dsql = appinv.domain_sql(hosts, per_day, d1)
check("domain SQL: days re-read are replaced, first_seen never later",
      f"DELETE FROM ml_domain_day WHERE day >= '{d1}';" in dsql and "first_seen=LEAST(first_seen" in dsql)
# app servers + what kind of device each one is
srv = appinv.servers(recs, cdnmap.catalog())
check("servers: app + address from the DNS answer", ("facebook.com", "203.0.113.9") in srv and srv[("whatsapp.com", "203.0.113.9")]["n"] == 2, sorted(srv))
check("servers: shared CDN / unknown names give no app server", not any(k[0] in ("cloudfront.net", "some-unknown-blog.org") for k in srv))
andro, iph, win, weak = "10.0.0.21", "10.0.0.22", "10.0.0.23", "10.0.0.24"
look(T0 + 100, andro, "connectivitycheck.gstatic.com"); look(T0 + 101, andro, "play.googleapis.com")
look(T0 + 102, iph, "captive.apple.com"); look(T0 + 103, win, "www.msftconnecttest.com"); look(T0 + 104, win, "settings-win.data.microsoft.com")
look(T0 + 105, weak, "play.googleapis.com")                       # one weak hint only
devs = appinv.devices(cdnlearn.parse(lines), lambda ip, t: users.get(ip, ""))
check("device kind: Android, Apple, Windows from their system names", (devs[andro]["os"], devs[iph]["os"], devs[win]["os"]) == ("android", "apple", "windows"),
      {k: v["os"] for k, v in devs.items()})
check("  ... evidence kept", "connectivitycheck.gstatic.com" in devs[andro]["evidence"], devs[andro])
check("  ... one weak hint is not enough", weak not in devs)
check("  ... devices without system names are not guessed", ali not in devs)
xs = appinv.extra_sql(srv, devs)
check("SQL: servers + devices, first_seen never later", "INSERT INTO ml_app_server" in xs and "INSERT INTO ml_device" in xs and "first_seen=LEAST(first_seen" in xs)

# hourly rebuild reads the rotated log too: after the nightly rotation yesterday's lines are in dns.log.1
import gzip
d = tempfile.mkdtemp()
open(f"{d}/dns.log", "w").write("today-1\ntoday-2\n")
open(f"{d}/dns.log.1", "w").write("yesterday-1\n")
with gzip.open(f"{d}/dns.log.2.gz", "wt") as fh:
    fh.write("old-1\n")
os.utime(f"{d}/dns.log.1", (time.time() - 7200, time.time() - 7200))
os.utime(f"{d}/dns.log.2.gz", (time.time() - 3 * 86400, time.time() - 3 * 86400))
got = [l.strip() for l in cdnmap.recent_lines(f"{d}/dns.log", time.time() - 2 * 86400)]
check("recent_lines: rotated file of yesterday + today, old ones skipped, oldest first", got == ["yesterday-1", "today-1", "today-2"], got)
got = [l.strip() for l in cdnmap.recent_lines(f"{d}/dns.log", time.time() - 5 * 86400)]
check("recent_lines: older window also reads the .gz file", got == ["old-1", "yesterday-1", "today-1", "today-2"], got)
sys.exit(1 if fail else 0)
