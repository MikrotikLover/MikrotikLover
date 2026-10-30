#!/usr/bin/env python3
"""Offline tests for tools/firewall.py: entries, router rules, countries, policy lookup, logs (no database)."""
import ipaddress, os, sys, tempfile
from datetime import datetime
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
os.environ["ML_GEO_DIR"] = tempfile.mkdtemp()
import firewall as fw  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


def bad(fn, *a):
    try:
        fn(*a)
        return False
    except fw.Bad:
        return True


# entries
check("address entries: network, single IP, range, website, country", [fw.addr_entry(x) for x in ("10.0.0.7/24", "10.0.0.5", "10.0.0.9-10.0.0.20", "Mail.Example.com", "geo:pk", "CN")]
      == [("net", "10.0.0.0/24"), ("net", "10.0.0.5/32"), ("range", "10.0.0.9-10.0.0.20"), ("fqdn", "mail.example.com"), ("geo", "PK"), ("geo", "CN")])
check("bad entries refused (999.x, reversed range, unknown country, junk)", all(bad(fw.addr_entry, x) for x in ("999.1.1.1", "10.0.0.9-10.0.0.1", "geo:XX", "a b;c")))
check("services: ports, ranges, icmp, any", [fw.service_entry(x) for x in ("tcp/80,443", "UDP 5000-5100", "icmp", "any")] == [("tcp", "80,443"), ("udp", "5000-5100"), ("icmp", ""), ("", "")])
check("bad services refused (port 0, 70000, icmp with port, 16 ports)", all(bad(fw.service_entry, x) for x in ("tcp/0", "udp/70000", "icmp/5", "tcp/" + ",".join(str(i) for i in range(1, 17)))))
check("schedule: office hours -> one RouterOS time", fw.sched_times(fw.DAYS[:6], "09:00", "17:00") == ["9h-17h,mon,tue,wed,thu,fri,sat"])
check("schedule over midnight -> two parts; 23:59 -> end of day", fw.sched_times(fw.DAYS, "22:30", "06:00") == ["22h30m-23h59m59s,mon,tue,wed,thu,fri,sat,sun", "0s-6h,mon,tue,wed,thu,fri,sat,sun"]
      and fw.sched_times(["sat"], "00:00", "23:59") == ["0s-23h59m59s,sat"])

# a firewall in memory
st = {"addrs": {"office": {"name": "office", "entries": ["192.168.88.0/24", "10.20.0.5-10.20.0.9", "vpn.example.com"]},
                "bad": {"name": "bad", "entries": ["geo:CN", "geo:RU"]}, "mix": {"name": "mix", "entries": ["1.2.3.4/32", "geo:PK"]}},
      "services": {"cam": {"name": "cam", "entries": ["tcp/37777", "udp/37778"], "comment": ""}},
      "schedules": {"lunch": {"name": "lunch", "days": "mon,tue", "start": "13:00", "end": "14:00", "comment": ""}}, "rules": [], "vips": []}
R = lambda **k: {"id": 9, "name": "t", "enabled": 1, "dir": "out", "src": ["all"], "dst": ["all"], "service": ["ALL"], "schedule": "always", "action": "deny", "log": 0, **k}  # noqa: E731
lines = fw.rule_lines(st, R(dir="in", service=["RDP", "SMB"], log=1))
check("Internet → LAN: one rule per protocol / port group, logged WF-fw-ID", len(lines) == 4 and all("in-interface-list=!LAN out-interface-list=LAN" in l and 'log-prefix="WF-fw-9"' in l and "action=drop" in l for l in lines), lines)
lines = fw.rule_lines(st, R(dir="wan", src=["bad"], action="reject", service=["WINBOX"]))
check("wan = forward + input, one per country, tcp reject = tcp-reset", len(lines) == 4 and sum("chain=mlfw-in" in l for l in lines) == 2
      and all("reject-with=tcp-reset" in l for l in lines) and {"src-address-list=mlgeo-CN", "src-address-list=mlgeo-RU"} <= set(" ".join(lines).split()), lines)
lines = fw.rule_lines(st, R(src=["mix"], action="allow", log=1))
check("object with IPs + a country -> its own list and the country list; allow = return, logged WF-fwa", len(lines) == 2 and "mlfw-mix" in lines[0]
      and "mlgeo-PK" in lines[1] and all("action=return" in l and "WF-fwa-9" in l for l in lines), lines)
lines = fw.rule_lines(st, R(service=["cam"], action="reject", schedule="lunch"))
check("own service + schedule; udp reject = icmp", lines == ['add chain=mlfw-fwd in-interface-list=LAN out-interface-list=!LAN protocol=tcp dst-port=37777 time=13h-14h,mon,tue action=reject reject-with=tcp-reset comment="mlfw:9 t"',
                                                              'add chain=mlfw-fwd in-interface-list=LAN out-interface-list=!LAN protocol=udp dst-port=37778 time=13h-14h,mon,tue action=reject reject-with=icmp-admin-prohibited comment="mlfw:9 t"'], lines)
check("ALL among services = no protocol condition", fw.rule_lines(st, R(service=["RDP", "ALL"])) == ['add chain=mlfw-fwd in-interface-list=LAN out-interface-list=!LAN action=drop comment="mlfw:9 t"'])
check("quotes in a name cannot break the rule", '"' not in fw.rule_lines(st, R(name='x" ; /system reset'))[0].split('comment="')[1][:-1])

st["rules"] = [R(id=1, name="countries", dir="wan", src=["bad"]), R(id=2, name="winbox office", dir="router", src=["office"], service=["WINBOX"], action="allow"),
               R(id=3, name="winbox others", dir="wan", service=["WINBOX"], action="reject"), R(id=4, name="off one", enabled=0, dir="out"),
               R(id=5, name="lunch no cam", dir="out", service=["cam"], schedule="lunch", action="reject")]
st["vips"] = [{"id": 1, "name": "DVR", "enabled": 1, "proto": "both", "port": "37777", "to_ip": "192.168.88.20", "to_port": "37777", "src": ["office", "geo:PK"], "wan": ""},
              {"id": 2, "name": "old", "enabled": 0, "proto": "tcp", "port": "80", "to_ip": "192.168.88.30", "to_port": "8080", "src": ["all"], "wan": "ether1"}]
text = fw.rsc(st, "https://r/api/public/router/geo.rsc?key=K", "abc123")
check("router file: address lists (no countries), jumps on new connections only, off policy left out",
      text.count("add list=mlfw-office") == 3 and "mlgeo" not in text.split("/ip firewall filter")[0] and text.count("connection-state=new action=jump") == 2
      and "mlfw:4" not in text, text)
check("router file: jumps moved to the top (safe when they are the only rules); old rules removed first",
      '/ip firewall filter move [/ip firewall filter find comment~"^mlfw: policies"] destination=[:pick $o 0]' in text
      and 'find where !(comment~"^mlfw: policies")' in text and "destination=0" not in text and text.index('remove [find comment~"^mlfw"]') < text.index("jump-target=mlfw-fwd"))
check("port forward: tcp + udp, one per allowed source; disabled one left out", text.count("chain=dstnat") == 4 and "192.168.88.30" not in text
      and "src-address-list=mlgeo-PK" in text and "to-addresses=192.168.88.20 to-ports=37777" in text, text)
check("country lists fetched only when the version changes", ':if ($mlGeoVer != "abc123")' in text and "geo.rsc?key=K" in text)
check("countries in use (enabled rules + port forwards)", fw.used_countries(st) == ["CN", "PK", "RU"], fw.used_countries(st))
st2 = dict(st, rules=[], vips=[])
check("nothing set: only the clean-up lines, no jumps", "jump" not in fw.rsc(st2) and 'remove [find comment~"^mlfw"]' in fw.rsc(st2))
check("used by: objects -> policies / port forwards", fw.used_by(st)["office"] == ["policy #2", "port forward DVR"] and "lunch" in fw.used_by(st))

# countries
data = fw.parse_delegated(["2|apnic|x", "apnic|CN|ipv4|1.0.1.0|256|2011|allocated", "apnic|CN|ipv4|1.0.2.0|512|2011|assigned",
                           "apnic|PK|ipv4|39.32.0.0|768|2008|allocated", "ripencc|RU|ipv6|2a00::|32|2010|allocated", "apnic|CN|ipv4|9.9.9.0|256|2011|reserved", "junk"])
check("RIR file: IPv4 allocated / assigned only, counts that are not a power of 2 split", sorted(data) == ["CN", "PK"] and [str(n) for n in data["PK"]] == ["39.32.0.0/23", "39.32.2.0/24"], data)
meta = fw.geo_write(data, "test")
check("lists written and merged (1.0.1.0/24 + 1.0.2.0/23 stay 2)", meta["counts"] == {"CN": 2, "PK": 2}, meta)
check("lookup: address -> country", (fw.lookup("39.32.2.9"), fw.lookup("1.0.2.200"), fw.lookup("8.8.8.8")) == ("PK", "CN", ""))
gtext, ver = fw.geo_rsc(["CN", "PK", "RU"])
check("router country file: only the countries used, a missing one is empty", gtext.count("list=mlgeo-CN") == 2 and "mlgeo-RU" not in gtext and len(ver) == 16)
check("  ... version changes with the lists", fw.geo_rsc(["CN"])[1] != ver and fw.geo_rsc([])[1] == "")

# policy lookup (first fit wins)
wed_noon, mon_lunch = datetime(2026, 10, 21, 12, 0), datetime(2026, 10, 19, 13, 30)
L = lambda *a, when=wed_noon: fw.lookup_policy(st, *a, when=when)  # noqa: E731
check("from China to the router: country policy first", L("router", "1.0.2.5", "203.0.113.1", "tcp", 8291)["rule"] == 1)
check("Winbox from the office range (a-b): allowed by #2", (lambda r: (r["verdict"], r["rule"]))(L("router-lan", "10.20.0.7", "192.168.88.1", "tcp", 8291)) == ("allow", 2))
check("Winbox from another internet address: rejected by #3", (lambda r: (r["verdict"], r["rule"]))(L("router", "8.8.4.4", "203.0.113.1", "tcp", 8291)) == ("reject", 3))
r = L("out", "192.168.88.9", "5.5.5.5", "tcp", 37777)
check("schedule: not at Wednesday noon -> no policy; the off policy skipped with why", r["verdict"] == "no-policy" and any(s["why"] == "policy is off" for s in r["steps"])
      and any("not now" in s["why"] for s in r["steps"]), r)
check("  ... Monday 13:30 -> rejected by #5", L("out", "192.168.88.9", "5.5.5.5", "tcp", 37777, when=mon_lunch)["rule"] == 5)
check("udp 37778 is in the cam service too, udp 37777 is not", L("out", "192.168.88.9", "5.5.5.5", "udp", 37778, when=mon_lunch)["rule"] == 5
      and L("out", "192.168.88.9", "5.5.5.5", "udp", 37777, when=mon_lunch)["rule"] == 0)
check("bad direction refused", bad(fw.lookup_policy, st, "sideways", "1.1.1.1", "2.2.2.2", "tcp", 1))

# logs
logs = fw.parse_logs(["2026-10-22T18:00:03+00:00 10.10.10.1 firewall,info: WF-fw-12 forward: in:ether1 out:bridge, connection-state:new proto TCP (SYN), 1.0.2.11:5111->192.168.88.21:3389, len 52",
                      "2026-10-22T18:00:04+00:00 10.10.10.1 firewall,info: WF-fwa-2 input: in:bridge out:(unknown 0), connection-state:new proto UDP, 192.168.88.5:4444->192.168.88.1:53, len 52",
                      "2026-10-22T18:00:05+00:00 10.10.10.1 firewall,info: WF-allowonly forward: x, proto TCP (SYN), 1.1.1.1:1->2.2.2.2:3, len 1"])
check("logs: firewall lines only, deny / allow, proto, ports", [(x["rule"], x["action"], x["proto"], x["src"], x["port"]) for x in logs]
      == [(12, "deny", "tcp", "1.0.2.11", 3389), (2, "allow", "udp", "192.168.88.5", 53)], logs)

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tools"))
import mlreport  # noqa: E402
check("blocking logs: a firewall deny says which policy", mlreport.block_reason("fw-12") == "firewall policy #12")
print("all firewall tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
