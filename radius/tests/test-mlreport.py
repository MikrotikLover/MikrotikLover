#!/usr/bin/env python3
"""Offline test for tools/mlreport.py using sample rsyslog lines (no database needed)."""
import os, subprocess, sys, tempfile, datetime

here = os.path.dirname(os.path.abspath(__file__))
tool = os.path.join(here, "..", "tools", "mlreport.py")
now = datetime.datetime.now(datetime.timezone.utc)
def t(sec): return (now - datetime.timedelta(seconds=sec)).isoformat()

dns = [
    f"{t(900)} 127.0.0.1 dnsmasq[1]: query[A] www.youtube.com from 192.168.88.23",
    f"{t(899)} 127.0.0.1 dnsmasq[1]: query[A] i.ytimg.com from 192.168.88.23",
    f"{t(898)} 127.0.0.1 dnsmasq[1]: query[AAAA] rr2---sn-x.googlevideo.com from 192.168.88.23",
    f"{t(600)} 127.0.0.1 dnsmasq[1]: query[A] www.daraz.pk from 192.168.88.23",
    f"{t(500)} 127.0.0.1 dnsmasq[1]: query[A] news.bbc.co.uk from 192.168.88.40",
    f"{t(400)} 127.0.0.1 dnsmasq[1]: query[A] wpad from 192.168.88.40",
    f"{t(300)} 127.0.0.1 dnsmasq[1]: query[PTR] 23.88.168.192.in-addr.arpa from 192.168.88.23",
    f"{t(100)} 127.0.0.1 dnsmasq[1]: query[A] www.youtube.com from 192.168.88.23",
    f"{t(90)} 127.0.0.1 dnsmasq[1]: forwarded www.youtube.com to 192.168.88.1",
]
wf = [f"{t(50)} 192.168.88.1 firewall,info: WF-social forward: in:bridge out:ether1, connection-state:established "
      f"src-mac aa:bb:cc:dd:ee:ff, proto TCP (ACK,PSH), 192.168.88.23:51234->157.240.1.35:443, len 571"]

with tempfile.TemporaryDirectory() as d:
    open(os.path.join(d, "dns.log"), "w").write("\n".join(dns) + "\n")
    open(os.path.join(d, "webfilter.log"), "w").write("\n".join(wf) + "\n")
    env = dict(os.environ, MLREPORT_LOGDIR=d)
    def run(*args):
        r = subprocess.run([sys.executable, tool, "--cnf", "/nonexistent", *args], env=env,
                           capture_output=True, text=True)
        return r.stdout
    fail = 0
    def check(desc, cond, out):
        global fail
        print(("ok   " if cond else "FAIL ") + desc)
        if not cond:
            print(out); fail += 1
    out = run("sites")
    lines = {l.split()[0]: l.split() for l in out.splitlines()[1:]}
    check("sites: youtube.com counted 2 visits (CDN hosts merged, 5-min dedupe)", lines.get("youtube.com", [0, 0])[1] == "2", out)
    check("sites: daraz.pk and bbc.co.uk present", "daraz.pk" in lines and "bbc.co.uk" in lines, out)
    check("sites: noise (wpad, arpa) ignored", "wpad" not in out and "arpa" not in out, out)
    out = run("history", "--ip", "192.168.88.23")
    check("history: only that IP, youtube collapsed", "bbc" not in out and sum(1 for l in out.splitlines() if " youtube.com " in l) == 2, out)
    out = run("blocked")
    check("blocked: social block parsed", "social" in out and "157.240.1.35:443" in out, out)
    sys.exit(1 if fail else 0)
