#!/usr/bin/env python3
"""Offline tests for the CDN detective (tools/cdnmap.py): names, DNS CNAME evidence, context, IP owners."""
import json, os, sys, tempfile
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
json.dump({"updated": "test", "owners": {"Meta (Facebook / Instagram / WhatsApp)": ["157.240.0.0/17"],
                                         "Akamai (shared CDN)": ["23.32.0.0/11"]}}, open(f"{state}/asn.json", "w"))
json.dump({"apps": [{"app": "My Bank", "site": "mybank.pk", "category": "finance", "domains": ["mybank-cdn.net"]}]},
          open(f"{state}/cdn-apps.local.json", "w"))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import cdnmap  # noqa: E402

L = lambda t, rest: f"2026-10-16T10:00:{t:02d}+00:00 127.0.0.1 dnsmasq[1]: {rest}"
lines = [
    L(1, "10 192.168.88.23/5000 query[A] www.daraz.pk from 192.168.88.23"),
    L(1, "10 192.168.88.23/5000 reply www.daraz.pk is <CNAME>"),
    L(1, "10 192.168.88.23/5000 reply www.daraz.pk.edgekey.net is <CNAME>"),
    L(1, "10 192.168.88.23/5000 reply e9876.a.akamaiedge.net is 23.40.1.2"),
    L(5, "11 192.168.88.40/5001 query[A] www.daraz.pk from 192.168.88.40"),
    L(5, "11 192.168.88.40/5001 cached e9876.a.akamaiedge.net is 23.40.1.2"),
    L(20, "12 192.168.88.50/5002 query[A] www.olx.com.pk from 192.168.88.50"),
    L(20, "12 192.168.88.50/5002 reply www.olx.com.pk is 99.84.10.10"),
    L(24, "13 192.168.88.50/5003 query[A] d1abcd.cloudfront.net from 192.168.88.50"),
    L(24, "13 192.168.88.50/5003 reply d1abcd.cloudfront.net is 99.84.20.20"),
]
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond

c = cdnmap.catalog()
for host, app in [("rr5---sn-hju7en7k.googlevideo.com", "YouTube"), ("scontent.fkhi22-1.fna.fbcdn.net", "Facebook"),
                  ("scontent-ams2-1.cdninstagram.com", "Instagram"), ("mmg.whatsapp.net", "WhatsApp"),
                  ("v16-webapp.tiktokcdn.com", "TikTok"), ("ipv4-c012-khi001-ix.1.oca.nflxvideo.net", "Netflix"),
                  ("audio-ak-spotify-com.akamaized.net", "Spotify"), ("edge-chat.facebook.com", "Messenger"),
                  ("img.mybank-cdn.net", "My Bank")]:
    e = c.name(host)
    check(f"name: {host} -> {app}", e and e["app"] == app and not e["generic"], e)
check("generic: d1abcd.cloudfront.net is a shared CDN", c.name("d1abcd.cloudfront.net")["generic"])
check("report site name: googlevideo -> youtube.com", c.site("r1---sn-x.googlevideo.com") == "youtube.com")

r = cdnmap.lookup("e9876.a.akamaiedge.net", lines)
check("CNAME evidence: akamaiedge name -> Daraz (both devices)", r["verdict"]["site"] == "daraz.pk" and r["verdict"]["confidence"] == "high"
      and len(r["evidence"]["origins"][0]["clients"]) == 2, r["verdict"])
r = cdnmap.lookup("23.40.1.2", lines)
check("IP evidence beats the Akamai owner: 23.40.1.2 -> Daraz", r["verdict"]["app"] == "Daraz" and r["ip_owner"]["owner"].startswith("Akamai"), r)
r = cdnmap.lookup("d1abcd.cloudfront.net", lines)
check("context: bare CloudFront name opened right after olx -> olx.com.pk (low)", r["verdict"]["site"] == "olx.com.pk" and r["verdict"]["confidence"] == "low", r["verdict"])
r = cdnmap.lookup("157.240.3.3", [])
check("IP owner only: 157.240.3.3 -> Meta", r["verdict"]["app"].startswith("Meta") and r["verdict"]["confidence"] == "medium", r["verdict"])
try:
    cdnmap.lookup("x;rm -rf /", [])
    check("invalid input rejected", False)
except ValueError:
    check("invalid input rejected", True)
sys.exit(1 if fail else 0)
