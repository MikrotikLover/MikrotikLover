#!/usr/bin/env python3
"""Unit tests for tools/flowcollector.py with synthetic IPFIX and NetFlow v9 packets."""
import os, socket, struct, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flowcollector as fc  # noqa: E402

from flowgen import rec, ipfix, v9  # noqa: E402

CLIENT, PUB, YT = "192.168.88.23", "203.0.113.5", "142.250.181.14"
dec, cls, dd, names = fc.Decoder(), fc.Classifier(["192.168.0.0/16", "10.0.0.0/8"]), fc.Dedupe(), fc.DnsNames()
for line in [
    "x dnsmasq[1]: 7 192.168.88.23/5000 query[A] www.youtube.com from 192.168.88.23",
    "x dnsmasq[1]: 7 192.168.88.23/5000 reply www.youtube.com is <CNAME>",
    "x dnsmasq[1]: 7 192.168.88.23/5000 reply youtube-ui.l.google.com is 142.250.181.14",
    "x dnsmasq[1]: 9 192.168.88.40/5001 query[A] www.daraz.pk from 192.168.88.40",
    "x dnsmasq[1]: 9 192.168.88.40/5001 cached www.daraz.pk is 47.246.1.1",
]:
    names.feed(line, 100)

def run(pkt):
    out = {}
    for r in dec.decode(pkt, "192.168.88.1"):
        c = cls.classify(r)
        if c and dd.first(c[4], 100):
            k = (c[0], names.site(c[0], c[1]), c[2])
            out[k] = out.get(k, 0) + c[3]
    return out

fail = 0
def check(desc, cond, got):
    global fail
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got); fail += 1

# 1) download as RouterOS reports it after NAT: src=YouTube, dst=public IP, post-NAT dst=client
got = run(ipfix([rec(YT, PUB, 443, 40000, 5_000_000, ndst=CLIENT)]))
check("IPFIX download via post-NAT field -> client, youtube.com", got == {(CLIENT, "youtube.com", "down"): 5_000_000}, got)
# 2) upload seen on LAN side (private src), template already known (no template in packet)
got = run(ipfix([rec(CLIENT, YT, 40000, 443, 300_000, nsrc=PUB)], with_template=False))
check("IPFIX upload, cached template", got == {(CLIENT, "youtube.com", "up"): 300_000}, got)
# 3) same packets reported on LAN and WAN interface -> counted once
dup = rec(YT, CLIENT, 443, 40001, 1_000_000, start=5000, end=6000)
dup2 = rec(YT, PUB, 443, 40001, 1_000_000, ndst=CLIENT, start=5000, end=6000)
got = run(ipfix([dup, dup2]))
check("duplicate (LAN + WAN record of same flow) counted once", got == {(CLIENT, "youtube.com", "down"): 1_000_000}, got)
# 4) next delta of the same long flow (different times) is counted
got = run(ipfix([rec(YT, CLIENT, 443, 40001, 2_000_000, start=5000, end=7000)], with_template=False))
check("next delta of a long download is added", got == {(CLIENT, "youtube.com", "down"): 2_000_000}, got)
# 5) cached DNS answer, other client; NetFlow v9
got = run(v9([rec("47.246.1.1", "192.168.88.40", 443, 41000, 750_000)]))
check("NetFlow v9 + cached DNS answer -> daraz.pk", got == {("192.168.88.40", "daraz.pk", "down"): 750_000}, got)
# 6) unknown remote without DNS -> shown as IP; LAN<->LAN and router-only ignored
got = run(ipfix([rec("8.8.4.4", CLIENT, 53, 5353, 4000), rec(CLIENT, "192.168.88.50", 1, 2, 9999),
                 rec(PUB, "1.1.1.1", 1, 2, 9999)], with_template=False))
check("no DNS name -> IP; LAN-LAN and router traffic ignored", got == {(CLIENT, "8.8.4.4", "down"): 4000}, got)
# 7) bare shared-CDN name right after a site (CDN detective context) -> counted for that site
for line in ["x dnsmasq[1]: 20 192.168.88.50/6000 query[A] www.olx.com.pk from 192.168.88.50",
             "x dnsmasq[1]: 20 192.168.88.50/6000 reply www.olx.com.pk is 99.84.10.10",
             "x dnsmasq[1]: 21 192.168.88.50/6001 query[A] d1abcd.cloudfront.net from 192.168.88.50",
             "x dnsmasq[1]: 21 192.168.88.50/6001 reply d1abcd.cloudfront.net is 99.84.20.20"]:
    names.feed(line, 105)
got = run(ipfix([rec("99.84.20.20", "192.168.88.50", 443, 42000, 3_000_000)], with_template=False))
check("CloudFront data after olx -> olx.com.pk", got == {("192.168.88.50", "olx.com.pk", "down"): 3_000_000}, got)
# 7) garbage does not crash
check("garbage packet ignored", dec.decode(b"\x00\x0a\xff\xff" + b"\x00" * 30, "x") == [], "")
sys.exit(1 if fail else 0)
