#!/usr/bin/env python3
"""Offline tests for tools/mailsec.py: the DNS client, DNS record / blacklist checks, certificates, doors, volume, logs.
Starts a small DNS server and a TLS server on 127.0.0.1 (needs the openssl command)."""
import json, os, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import mailsec  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


d = tempfile.mkdtemp()
GOOD = {"good.test MX": [[10, "mail.good.test"], [20, "backup.good.test"]], "mail.good.test A": ["198.51.100.25"],
        "good.test TXT": ["v=spf1 mx ip4:198.51.100.25 -all", "google-site-verification=x"], "_dmarc.good.test TXT": ["v=DMARC1; p=quarantine; rua=mailto:a@good.test"],
        "mdaemon._domainkey.good.test TXT": ["v=DKIM1; k=rsa; p=MIIBIjANBgkqh" + "A" * 300], "25.100.51.198.in-addr.arpa PTR": ["mail.good.test"],
        "bad.test MX": [[10, "other.host.test"]], "mail.bad.test A": ["198.51.100.26"], "bad.test TXT": ["v=spf1 include:a.test", "v=spf1 -all"],
        "_dmarc.bad.test TXT": ["v=DMARC1; p=none"], "26.100.51.198.zen.spamhaus.org A": ["127.0.0.2"], "26.100.51.198.bl.spamcop.net A": ["127.0.0.2"],
        "25.100.51.198.b.barracudacentral.org A": ["127.255.255.254"]}
json.dump(GOOD, open(os.path.join(d, "rec.json"), "w"))
dns = subprocess.Popen([sys.executable, os.path.join(HERE, "fakedns.py"), "5398", os.path.join(d, "rec.json")])
time.sleep(0.8)
q = lambda n, t, timeout=3.0: mailsec.query(n, t, server="127.0.0.1", port=5398, timeout=timeout)  # noqa: E731
try:
    check("DNS client: MX with name compression, sorted by preference", sorted(q("good.test", "MX")[1]) == [(10, "mail.good.test"), (20, "backup.good.test")])
    check("DNS client: long TXT (several strings) joined", q("mdaemon._domainkey.good.test", "TXT")[1][0].endswith("A" * 300))
    check("DNS client: no such name = rcode 3", q("nothing.good.test", "A") == (3, []))
    c, pub = mailsec.check_dns("good.test", "mail.good.test", "", "MDaemon", q)
    st = {x["id"]: x["status"] for x in c}
    check("good domain: MX, A, SPF, DMARC quarantine, DKIM, PTR all fine; public IP found from DNS",
          st == {"mx": "ok", "a": "ok", "spf": "ok", "dmarc": "ok", "dkim": "ok", "ptr": "ok"} and pub == "198.51.100.25", (st, pub))
    c, pub = mailsec.check_dns("bad.test", "mail.bad.test", "198.51.100.26", "MDaemon", q)
    st = {x["id"]: x for x in c}
    check("bad domain: MX elsewhere (warn), two SPF records (fail), DMARC none (warn), no DKIM, no PTR (fail)",
          [st[k]["status"] for k in ("mx", "spf", "dmarc", "dkim", "ptr")] == ["warn", "fail", "warn", "warn", "fail"], {k: v["status"] for k, v in st.items()})
    check("  ... each with what to do (the ISP for reverse DNS)", "ISP" in st["ptr"]["fix"] and "198.51.100.26" in st["ptr"]["fix"])
    bl = {b["list"]: b["status"] for b in mailsec.check_blacklists("198.51.100.26", q)}
    check("blacklists: listed on Spamhaus + SpamCop, others not", bl["Spamhaus ZEN"] == "listed" and bl["SpamCop"] == "listed" and bl["SORBS"] == "ok", bl)
    bl = {b["list"]: b["status"] for b in mailsec.check_blacklists("198.51.100.25", q)}
    check("blacklists: 127.255.255.x = refused query (unknown), not 'listed'", bl["Barracuda"] == "unknown" and "listed" not in bl.values(), bl)
finally:
    dns.kill()

# certificates: a TLS server with a 10-day self-signed certificate for mail.good.test
key, crt = os.path.join(d, "k.pem"), os.path.join(d, "c.pem")
subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "10", "-subj", "/CN=mail.good.test",
                "-addext", "subjectAltName=DNS:mail.good.test"], capture_output=True, check=True)
srv = subprocess.Popen(["openssl", "s_server", "-accept", "9465", "-cert", crt, "-key", key, "-quiet"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    c = mailsec.tls_cert("127.0.0.1", 9465, "tls", "mail.good.test")
    check("certificate read: days left, names, self-signed", c.get("days") in (9, 10) and c.get("names") == ["mail.good.test"] and c.get("self_signed"), c)
    r = mailsec.check_tls("127.0.0.1", "mail.good.test", {465: 9465})
    check("TLS check: < 21 days + self-signed -> warn, asked on the inside port", len(r) == 1 and r[0]["status"] == "warn" and "self-signed" in r[0]["detail"], r)
    r = mailsec.check_tls("127.0.0.1", "other.good.test", {465: 9465})
    check("TLS check: certificate for another name said", "not for other.good.test" in r[0]["detail"], r)
    r = mailsec.check_tls("127.0.0.1", "mail.good.test", {993: 9993, 995: 9995})
    check("nothing answers on any port: one 'reachable' check, not one per port", len(r) == 1 and r[0]["id"] == "tls", r)
finally:
    srv.kill()

# doors
vips = [{"name": "mail-smtp", "enabled": 1, "port": "25", "to_ip": "192.168.88.30", "to_port": "25", "src": ["all"]},
        {"name": "mail-web", "enabled": 1, "port": "443", "to_ip": "192.168.88.30", "to_port": "3000", "src": ["office"]},
        {"name": "other", "enabled": 1, "port": "993", "to_ip": "192.168.88.40", "to_port": "993", "src": ["all"]}]
nat = [{"to": "192.168.88.30", "port": "1000", "to_port": "1000", "src": "", "disabled": False}]
c, fwd = mailsec.check_ports(vips, nat, "192.168.88.30")
st = {x["id"]: x for x in c}
check("doors: firewall + router port forwards, outside -> inside port", fwd == {25: 25, 443: 3000, 1000: 1000}, fwd)
check("  ... admin port 1000 open = fail with the reason; limited webmail said", st["port1000"]["status"] == "fail" and "NEVER" in st["port1000"]["fix"]
      and "only some addresses" in st["port443"]["detail"] and "inside port 3000" in st["port443"]["detail"])
c, _ = mailsec.check_ports([], [], "192.168.88.30")
check("no port 25 forward: mail cannot arrive (warn)", c[0]["id"] == "port25" and c[0]["status"] == "warn")

check("outgoing mail: 5x the usual hour (at least 200) is a spike", mailsec.volume([("h1", 40), ("h2", 50), ("h3", 60), ("now", 400)], "now") == (400, 50, True)
      and mailsec.volume([("h1", 40), ("now", 150)], "now")[2] is False)
logs = mailsec.parse_logs(["2026-10-22T19:07:09+00:00 10.10.10.1 firewall,info: WF-mailbrute forward: in:ether1 out:bridge, connection-state:new proto TCP (SYN), 92.63.197.15:5111->192.168.88.30:993, len 52",
                           "2026-10-22T19:07:10+00:00 10.10.10.1 firewall,info: WF-spambot forward: in:bridge out:ether1, connection-state:new proto TCP (SYN), 192.168.88.57:51000->91.215.85.20:25, len 52",
                           "2026-10-22T19:07:11+00:00 10.10.10.1 firewall,info: WF-site forward: x, proto TCP (SYN), 1.1.1.1:1->2.2.2.2:3, len 1"])
check("logs: password guessers and spam bots only", [(x["kind"], x["src"], x["port"]) for x in logs] == [("mailbrute", "92.63.197.15", 993), ("spambot", "192.168.88.57", 25)], logs)
c = mailsec.conf_of({"mail_ip": "192.168.88.30", "mail_domain": "Good.Test"})
check("settings: host defaults to mail.DOMAIN, DKIM MDaemon, webmail 3000, protection on", (c["host"], c["dkim"], c["webmail"], c["guard"], c["smtp_out"]) == ("mail.good.test", "MDaemon", 3000, True, True))
print("all mail server tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
