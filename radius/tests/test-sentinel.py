#!/usr/bin/env python3
"""Offline tests for the security detective (tools/sentinel.py): virus, hacker attack, DDoS."""
import json, os, sys, tempfile, time
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
json.dump({"updated": "test", "owners": {}}, open(f"{state}/asn.json", "w"))
open(f"{state}/threat-domains.txt", "w").write("evil-loader.top\tMalware (URLhaus)\nfree-prize-login.com\tPhishing (Phishing Army)\ncoinhive-x.net\tCrypto mining (NoCoin)\n")
open(f"{state}/threat-ips.txt", "w").write("198.51.100.66/32\tBotnet server (Feodo Tracker)\n203.0.113.0/24\tAttacker network (FireHOL level 1)\n")
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import sentinel  # noqa: E402

LAN = ["192.168.88.0/24"]
th = sentinel.thresholds()
threats = sentinel.Threats(f"{state}/threat-domains.txt", f"{state}/threat-ips.txt")
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond
def flow(src, dst, sport, dport, proto=6, nbytes=60, pkts=1):
    return {8: src, 12: dst, 7: sport, 11: dport, 4: proto, 1: nbytes, 2: pkts}
def types(ev):
    return {(k[1], k[2]) for k in ev.ev}
def find(ev, typ):
    return [(k, e) for k, e in ev.ev.items() if k[2].startswith(typ)]

# ---- DDoS on the WAN address 100.70.1.2 (not LAN)
w = sentinel.FlowWatch(LAN, threats)
for i in range(4000):
    w.feed(flow(f"10.{i % 250}.{i // 250}.9", "100.70.1.2", 40000 + i, 443))            # SYN flood from 4000 sources
for i in range(40):
    w.feed(flow(f"77.1.{i}.1", "100.70.1.3", 123, 51000, 17, 1_000_000, 2000))          # NTP amplification: 40 MB from 40 servers
for i in range(3500):
    w.feed(flow("45.9.9.9", "100.70.1.4", 50000 + i % 1000, 53 + i, 17, 80, 1))         # UDP flood from one source = DoS
w.feed(flow("45.9.9.10", "100.70.1.5", 0, 0, 1, 64 * 40000, 40000))                       # ping flood
ev = w.evaluate(time.time(), 60)
syn = find(ev, "SYN flood")
check("SYN flood from many sources -> ddos", syn and syn[0][0][1] == "ddos" and syn[0][0][5] == "100.70.1.2", types(ev))
amp = find(ev, "NTP amplification")
check("NTP amplification (reflection) by service", amp and amp[0][0][1] == "ddos" and "40 MB" in amp[0][1]["detail"], types(ev))
check("amplification is not also called a plain UDP flood", not any(k[2] == "UDP flood" and k[5] == "100.70.1.3" for k in ev.ev))
udp = find(ev, "UDP flood")
check("UDP flood from one source -> DoS (attack)", udp and udp[0][0][1] == "attack" and "DoS" in udp[0][1]["detail"], types(ev))
check("ICMP flood", find(ev, "ICMP (ping) flood"), types(ev))

# ---- hacker attacks
w = sentinel.FlowWatch(LAN, threats)
for p in range(1, 60):
    w.feed(flow("91.1.1.1", "100.70.1.2", 4444, p))                                       # port scan
for h in range(60):
    w.feed(flow("91.1.1.2", f"192.168.88.{h + 2}", 4444, 3389))                           # sweep on 3389
for i in range(80):
    w.feed(flow("91.1.1.3", "100.70.1.2", 30000 + i, 8291, 6, 400, 6))                   # winbox guessing
w.feed(flow("203.0.113.7", "100.70.1.2", 5555, 443, 6, 400, 6))                           # known attacker network
w.feed(flow("8.8.8.8", "100.70.1.2", 53, 40000, 17, 120, 1))                              # normal DNS answer
ev = w.evaluate(time.time(), 60)
check("port scan", find(ev, "Port scan") and find(ev, "Port scan")[0][0][4] == "91.1.1.1", types(ev))
check("network sweep on port 3389", find(ev, "Network sweep on port 3389"), types(ev))
bf = find(ev, "Password guessing on Winbox")
check("password guessing on Winbox, high (80 tries)", bf and bf[0][1]["severity"] == "high", types(ev))
check("known attacker network (threat list)", find(ev, "Known attacker network"), types(ev))
check("normal traffic -> nothing else", len(ev.ev) == 4, sorted(types(ev)))

# ---- infected LAN devices (virus)
w = sentinel.FlowWatch(LAN, threats)
for h in range(20):
    w.feed(flow("192.168.88.20", f"74.1.1.{h}", 40000 + h, 25))                          # spam bot
for h in range(40):
    w.feed(flow("192.168.88.21", f"88.1.{h}.1", 40000 + h, 23))                          # Mirai-style telnet scan
for h in range(40):
    w.feed(flow("192.168.88.22", f"192.168.88.{100 + h}", 40000 + h, 445))              # scanning the LAN
for i in range(2500):
    w.feed(flow("192.168.88.23", "151.101.9.9", 30000 + i % 30000, 80, 6, 60, 1))       # DDoS bot
w.feed(flow("192.168.88.24", "198.51.100.66", 50000, 443, 6, 900, 8))                    # botnet server
w.feed(flow("192.168.88.25", "5.5.5.5", 50001, 3333, 6, 900, 8))                         # stratum port
for i in range(200):
    w.feed(flow("192.168.88.26", f"142.250.1.{i % 50}", 40000 + i, 443, 6, 50000, 60))   # normal browsing
ev = w.evaluate(time.time(), 60, users={"192.168.88.20": "ali"})
sp = find(ev, "Spam bot")
check("spam bot, with the user name", sp and sp[0][1]["user"] == "ali" and sp[0][0][1] == "virus", types(ev))
check("internet scan on telnet (Mirai)", find(ev, "Scanning the internet on port 23"), types(ev))
check("scanning the local network", find(ev, "Scanning the local network"), types(ev))
check("device flooding someone (DDoS bot)", find(ev, "Device is flooding someone"), types(ev))
check("talked to a botnet server", find(ev, "Talked to a botnet"), types(ev))
check("crypto mining port (low)", find(ev, "Possible crypto mining") and find(ev, "Possible crypto mining")[0][1]["severity"] == "low")
check("normal browsing device not reported", not any(k[4] == "192.168.88.26" for k in ev.ev))

# ---- thresholds scale with the window
w = sentinel.FlowWatch(LAN, threats)
for h in range(20):
    w.feed(flow("192.168.88.20", f"74.1.1.{h}", 40000 + h, 25))
check("20 mail servers in 5 minutes is not spam (scaled threshold)", not w.evaluate(time.time(), 300).ev)

# ---- logs: DNS (threat names, DGA), router login failures, router security rules
T0 = time.mktime((2026, 10, 16, 10, 0, 0, 0, 0, -1))
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t)) + "+00:00"
dns, serial = [], [100]
def look(t, client, name, answer="203.0.113.9"):
    serial[0] += 1
    dns.append(f"{iso(t)} 192.168.88.1 dnsmasq[1]: {serial[0]} {client}/5000 query[A] {name} from {client}")
    dns.append(f"{iso(t)} 192.168.88.1 dnsmasq[1]: {serial[0]} {client}/5000 reply {name} is {answer}")
look(T0, "192.168.88.30", "cdn.evil-loader.top")
look(T0 + 1, "192.168.88.31", "free-prize-login.com")
look(T0 + 2, "192.168.88.32", "pool.supportxmr.com")
import random
random.seed(7)
for i in range(40):
    name = "".join(random.choice("bcdfghjklmnpqrstvwxz0123456789") for _ in range(16)) + ".com"
    look(T0 + 10 + i, "192.168.88.33", name, "NXDOMAIN")
for i in range(40):
    look(T0 + 100 + i, "192.168.88.34", f"typo-shop-{i}.com", "NXDOMAIN")                   # human typos: not random
router = [f"{iso(T0 + i)} 192.168.88.1 system,error,critical login failure for user admin from 45.1.1.1 via winbox" for i in range(12)]
wf = [f"{iso(T0)} 192.168.88.1 firewall,info: WF-scan input: in:ether1 out:(unknown 0), proto TCP (SYN), 46.2.2.2:5000->100.70.1.2:22, len 60",
      f"{iso(T0)} 192.168.88.1 firewall,info: WF-threat forward: in:bridge out:ether1, src-mac aa:bb:cc:00:00:35, proto TCP (SYN), 192.168.88.35:5000->198.51.100.66:443, len 60",
      f"{iso(T0)} 192.168.88.1 firewall,info: WF-social forward: in:bridge out:ether1, proto TCP (SYN), 192.168.88.36:5000->157.240.1.35:443, len 60"]
ev = sentinel.scan_logs(dns, router, wf, threats, LAN, lambda ip, t: {"192.168.88.30": "sara"}.get(ip, ""))
mw = find(ev, "Malware site")
check("malware site lookup -> virus, high, user", mw and mw[0][1]["user"] == "sara" and "URLhaus" in mw[0][1]["detail"], types(ev))
check("phishing site", find(ev, "Phishing site"), types(ev))
check("mining pool by name", find(ev, "Crypto mining") and any("supportxmr" in e["detail"] for _, e in find(ev, "Crypto mining")))
dga = find(ev, "Random names")
check("DGA: random names that do not exist (most of the 40)", dga and dga[0][0][4] == "192.168.88.33" and dga[0][1]["hits"] >= 30, dga)
check("typos are not DGA", not any(k[4] == "192.168.88.34" for k in ev.ev))
rl = find(ev, "Password guessing on the router")
check("router login failures (12 from one IP)", rl and rl[0][0][4] == "45.1.1.1" and "winbox" in rl[0][1]["detail"], types(ev))
check("router port-scan rule (WF-scan)", find(ev, "Port scan (router saw it)"))
check("router threat rule from a LAN device -> virus", any(k[1] == "virus" and k[4] == "192.168.88.35" for k in ev.ev))
check("blocked website (WF-social) is not a security event", not any(k[4] == "192.168.88.36" for k in ev.ev))
# LAN guard (lan-guard.rsc): fake DHCP server, ARP spoofing
lg = [f"{iso(T0)} 192.168.88.1 dhcp,critical,error dhcp alert on bridge: discovered unknown dhcp server, mac 00:0C:29:AA:BB:CC, ip 192.168.88.250",
      f"{iso(T0 + 5)} 192.168.88.1 script,warning ML-ARP many-ips mac=00:0C:29:DE:AD:01 ip=192.168.88.66 ips=24 if=bridge"]
lg += [f"{iso(T0 + 10 + i)} 192.168.88.1 script,warning ML-ARP changed ip=192.168.88.{40 + i} old=AA:AA:AA:00:00:{40 + i} new=00:0c:29:de:ad:02 if=bridge" for i in range(4)]
lg += [f"{iso(T0 + 20)} 192.168.88.1 script,warning ML-ARP changed ip=192.168.88.90 old=AA:AA:AA:00:00:90 new=BB:BB:BB:00:00:90 if=bridge"]
ev2 = sentinel.scan_logs([], lg, [], threats, LAN, lambda ip, t: {"192.168.88.66": "hacker1"}.get(ip, ""))
fd = find(ev2, "Fake DHCP server")
check("rogue DHCP server: attack, high, its IP and MAC", fd and fd[0][0][4] == "192.168.88.250" and fd[0][1]["severity"] == "high" and "00:0C:29:AA:BB:CC" in fd[0][1]["detail"], types(ev2))
mi = find(ev2, "ARP spoofing (one device answers")
check("one MAC for 24 addresses: ARP spoofing, high, user", mi and mi[0][1]["user"] == "hacker1" and "24 addresses" in mi[0][1]["detail"], types(ev2))
to = find(ev2, "ARP spoofing (one device took")
check("one MAC took over 4 addresses: ARP spoofing, high", len(to) == 4 and all(e["severity"] == "high" for _, e in to) and "00:0C:29:DE:AD:02" in to[0][1]["detail"], types(ev2))
mv = find(ev2, "Address moved to another device")
check("a single address change (phone reconnect): low only", len(mv) == 1 and mv[0][1]["severity"] == "low" and mv[0][0][4] == "192.168.88.90", types(ev2))
q = sentinel.sql(ev, "2026-10-15")
check("SQL: log/dns events re-built, flows kept", "DELETE FROM ml_security_event WHERE source IN ('dns','log')" in q)
check("SQL: severity only goes up", "FIELD(VALUES(severity)" in q)
sys.exit(1 if fail else 0)
