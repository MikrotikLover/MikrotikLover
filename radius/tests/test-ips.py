#!/usr/bin/env python3
"""Offline tests for the IPS parts: TZSP decoding, alert reading, plain words, who gets blocked, Suricata config."""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ips, tzsp2tap  # noqa: E402
from tzspgen import tcp_frame, tzsp  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


f = tcp_frame("45.155.205.233", "192.168.88.21", 40000, 3389)
check("TZSP: the Ethernet frame comes out unchanged", tzsp2tap.frame(tzsp(f)) == f)
check("TZSP: tags (padding, a 4-byte tag) skipped", tzsp2tap.frame(tzsp(f, tags=b"\x00\x0a\x04abcd\x01")) == f)
check("TZSP: other version / keepalive / not Ethernet / no end tag -> nothing",
      [tzsp2tap.frame(x) for x in (b"\x02\x00\x00\x01\x01" + f, b"\x01\x04\x00\x01\x01" + f, b"\x01\x00\x00\x12\x01" + f, b"\x01\x00\x00\x01\x0a\x09abc")] == [None] * 4)

ev = lambda **k: json.dumps({"timestamp": "2026-10-22T18:50:35.600330+0000", "event_type": "alert", "proto": "TCP", "src_port": 40000,  # noqa: E731
                             "dest_port": k.pop("dport", 3389), "src_ip": k.pop("src", "45.155.205.233"), "dest_ip": k.pop("dst", "192.168.88.21"),
                             "alert": {"signature_id": k.pop("sid", 9100001), "signature": k.pop("sig", "ML RDP password guessing from the internet"),
                                       "category": k.pop("cat", "Attempted Administrator Privilege Gain"), "severity": k.pop("sev", 1)}})
LAN = ["192.168.0.0/16", "10.0.0.0/8"]
lines = [ev(), ev(src="192.168.88.57", dst="91.215.85.20", dport=443, sid=2027000, sig="ET MALWARE Win32/Emotet CnC Checkin", cat="A Network Trojan was detected"),
         ev(src="192.168.88.57", dst="91.215.85.21", dport=25, sid=9100006, sig="ML Device sending mail directly (spam bot?)", cat="A Network Trojan was detected"),
         ev(src="66.240.205.34", sid=2010937, sig="ET SCAN Suspicious inbound to mySQL port 3306", cat="Potentially Bad Traffic", sev=2, dport=3306),
         ev(src="8.8.8.8", sid=2210000, sig="SURICATA STREAM 3way handshake wrong seq", cat="Generic Protocol Command Decode", sev=3),
         ev(src="10.1.1.5", dst="192.168.88.9", sid=2001569, sig="ET SCAN Behavioral Unusual Port 445 traffic", cat="Misc activity", sev=3),
         ev(sid=9100002), '{"event_type":"flow"}', "not json", ev(src="999.1.1.1")]
al = ips.parse(lines, LAN, disabled={9100002})
check("alerts read: other events, broken lines, bad addresses and switched-off signatures left out", [a["sid"] for a in al] == [9100001, 2027000, 9100006, 2010937, 2210000, 2001569], [a["sid"] for a in al])
check("direction: in / out / lan", [a["direction"] for a in al] == ["in", "out", "out", "in", "in", "lan"])
check("plain words + level", [(a["words"], a["severity"]) for a in al[:4]] == [("Password guessing", "high"), ("Infected device (malware / botnet)", "high"),
                                                                                ("Infected device (malware / botnet)", "high"), ("Scanning / looking for weak spots", "medium")], [(a["words"], a["severity"]) for a in al])
check("stream / decoder noise is 'harmless' (info); a low scan stays low", al[4]["kind"] == "info" and (al[5]["kind"], al[5]["severity"]) == ("scan", "low"))

b = ips.decide(al, True, "high", never={"45.155.205.1"}, lan=LAN)
check("blocked: the outside attacker and the malware server; not the mail servers a spam bot writes to, not LAN", sorted(b) == ["45.155.205.233", "91.215.85.20"], sorted(b))
check("level medium adds the scanner", "66.240.205.34" in ips.decide(al, True, "medium", set(), LAN))
check("auto-block off -> nothing", ips.decide(al, False, "medium", set(), LAN) == {})
check("never-block list respected", "45.155.205.233" not in ips.decide(al, True, "high", {"45.155.205.233"}, LAN))
check("an attacker inside the LAN networks is never blocked by address", not ips.blockable("10.1.1.5", LAN) and ips.blockable("45.155.205.233", LAN)
      and not ips.blockable("127.0.0.1", LAN))

# reading eve.json a bit at a time: rotation, truncation, half-written line
d = tempfile.mkdtemp()
eve, state = os.path.join(d, "eve.json"), os.path.join(d, "state")
open(eve, "w").write(lines[0] + "\n")
check("first run starts at the end (old alerts not imported)", ips.read_new(eve, state) == [])
open(eve, "a").write(lines[1] + "\n" + lines[3][:20])
check("new line read, a half-written one waits", ips.read_new(eve, state) == [lines[1]])
open(eve, "a").write(lines[3][20:] + "\n")
check("  ... and is read when complete", ips.read_new(eve, state) == [lines[3]])
os.rename(eve, eve + ".1")
open(eve, "w").write(lines[0] + "\n")
check("rotated file read from the start", ips.read_new(eve, state) == [lines[0]])
open(eve, "w").write("")
open(eve, "a").write(lines[1] + "\n")
check("truncated file read from the start", ips.read_new(eve, state) == [lines[1]])

y = ips.suricata_yaml(["192.168.0.0/16", "10.0.0.0/8"], "mltap0", rule_dir=d, log_dir=d)
check("Suricata config: home networks, tap, alerts only, partial copy settings", 'HOME_NET: "[192.168.0.0/16,10.0.0.0/8]"' in y and "- interface: mltap0" in y
      and "- alert:" in y and "midstream: true" in y and "checksum-validation: no" in y and "http:\n" in y)
check("own rules: 8 signatures, numbers 9100001-9100008", [int(x.split("sid:")[1].split(";")[0]) for x in ips.LOCAL.splitlines() if "sid:" in x] == list(range(9100001, 9100009)))
os.environ.pop("X", None)
ips.DISABLE = os.path.join(d, "disable.conf")
ips.RULE_DIR = d
open(os.path.join(d, "suricata.rules"), "w").write(ips.LOCAL)
ips.set_rule(9100004, False)
check("switch a signature off: listed, commented out in the rule file, defaults kept", 9100004 in ips.disabled_sids()
      and "group:stream-events.rules" in open(ips.DISABLE).read() and "# alert" in [l[:7] for l in open(os.path.join(d, "suricata.rules")) if "9100004" in l][0])
ips.set_rule(9100004, True)
check("  ... and on again", 9100004 not in ips.disabled_sids() and ips.rule_count(os.path.join(d, "suricata.rules")) == 8)
# inline mode: config and rules that stop traffic
m = {"mode": "inline", "wan": "eth1", "lan": "eth2", "drop": True}
y = ips.suricata_yaml(["192.168.0.0/16"], m=m, rule_dir=d, log_dir=d)
check("inline config: both cards copy to each other (ips), no tap, one flow per connection across cards",
      "- interface: eth1\n    copy-mode: ips\n    copy-iface: eth2" in y and "- interface: eth2\n    copy-mode: ips\n    copy-iface: eth1" in y
      and "mltap0" not in y and "use-for-tracking: false" in y and "- drop:" in y)
check("inline: Suricata started on every configured card", ips.suricata_args(m)[-1] == "--af-packet" and ips.suricata_args({"mode": "copy"})[-1] == "--af-packet=mltap0")
rf = os.path.join(d, "r.rules")
open(rf, "w").write("alert tcp any any -> any 1 (msg:\"x\"; classtype:trojan-activity; sid:1;)\n"
                    "alert tcp any any -> any 2 (msg:\"y\"; classtype:misc-activity; sid:2;)\n"
                    "# alert tcp any any -> any 3 (msg:\"z\"; classtype:trojan-activity; sid:3;)\n" + ips.LOCAL)
n = ips.apply_drop(m, rf)
lines = open(rf).read().splitlines()
check("inline + stop: high-level classes and our own rules drop, others alert, switched-off stay off",
      lines[0].startswith("drop ") and lines[1].startswith("alert ") and lines[2].startswith("# alert") and n == 1 + 8, (n, lines[:3]))
check("alert only (test) / copy mode: nothing drops", ips.apply_drop({**m, "drop": False}, rf) == 0 and ips.apply_drop({"mode": "copy"}, rf) == 0
      and not any(l.startswith("drop ") for l in open(rf)))
print("all IPS tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
