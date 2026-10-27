#!/usr/bin/env python3
"""tools/macpolicy.py: MAC format, router report, the RouterOS part (lint, RouterOS 6, nothing from a user name can
break out of the script).   python3 tests/test-macpolicy.py"""
import os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import macpolicy as mp  # noqa: E402
import rosv6  # noqa: E402

fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {info}"))
    fails += 0 if cond else 1


def lint(text):
    with tempfile.NamedTemporaryFile("w", suffix=".rsc", delete=False) as f:
        f.write(text)
    p = subprocess.run([sys.executable, os.path.join(HERE, "lint-rsc.py"), f.name], capture_output=True, text=True)
    os.unlink(f.name)
    return p.returncode == 0, p.stdout


t("MAC: dashes / lower case -> the router's AA:BB:..", mp.mac("aa-bb-cc-dd-ee-0f") == "AA:BB:CC:DD:EE:0F" and mp.mac("AA:BB:CC:DD:EE:0F") == "AA:BB:CC:DD:EE:0F")
t("MAC: not a MAC -> None", all(mp.mac(x) is None for x in ("", "ali", "AA:BB:CC:DD:EE", 'AA:BB:CC:DD:EE:0F"; /system reset')))
t("report: good lines kept, bad left out", mp.parse_report("aa-bb-cc-dd-ee-01|192.168.1.5\njunk\nAA:BB:CC:DD:EE:02|x\nAA:BB:CC:DD:EE:03|fe80::1\n")
  == {"AA:BB:CC:DD:EE:01": "192.168.1.5", "AA:BB:CC:DD:EE:03": "fe80::1"})


def fake(rows):
    return lambda sql, args=None: rows


R = [{"mac": "aa-bb-cc-dd-ee-01", "username": "ali", "seen": 3, "list": "policy-staff", "quarantined": 0, "ip": "", "router": "", "ip_at": None},
     {"mac": "AA:BB:CC:DD:EE:01", "username": "old-user", "seen": 1, "list": "policy-kids", "quarantined": 0, "ip": "", "router": "", "ip_at": None},
     {"mac": "AA:BB:CC:DD:EE:02", "username": 'evil"; /system reset; "', "seen": 2, "list": "policy-kids", "quarantined": 1, "ip": "10.0.0.2", "router": "10.0.0.1", "ip_at": None},
     {"mac": "AA:BB:CC:DD:EE:03", "username": "nopol", "seen": 2, "list": "", "quarantined": 0, "ip": "", "router": "", "ip_at": None},
     {"mac": "AA:BB:CC:DD:EE:04", "username": "bad", "seen": 2, "list": 'x"; /system reset', "quarantined": 0, "ip": "", "router": "", "ip_at": None},
     {"mac": "not-a-mac", "username": "x", "seen": 2, "list": "policy-kids", "quarantined": 0, "ip": "", "router": "", "ip_at": None}]
rows = mp.rows(fake(R))
by = {r["mac"]: r for r in rows}
t("one entry per MAC, the newest login wins", by["AA:BB:CC:DD:EE:01"]["user"] == "ali" and by["AA:BB:CC:DD:EE:01"]["lists"] == ["policy-staff"])
t("quarantine added on top", by["AA:BB:CC:DD:EE:02"]["lists"] == ["policy-kids", "ml-quarantine"])
t("no policy / a bad list name / not a MAC: left out", set(by) == {"AA:BB:CC:DD:EE:01", "AA:BB:CC:DD:EE:02"}, sorted(by))
s = mp.script(rows, "https://radius.lan:8443/api/public/router", "KEY123")
t("script: the lists and users", '"AA:BB:CC:DD:EE:01"="policy-staff"' in s and '"AA:BB:CC:DD:EE:02"="policy-kids,ml-quarantine"' in s and '"AA:BB:CC:DD:EE:01"="ali"' in s)
t("script: a user name cannot break out (quotes, ; and / taken out)", '"AA:BB:CC:DD:EE:02"="evilsystemreset"' in s and "/system reset" not in s, [l for l in s.splitlines() if "evil" in l])
t("script: DHCP first, else ARP; takes out what is not right; reports only on change",
  all(x in s for x in ('lease find where mac-address=$m and status="bound"', "/ip arp find where mac-address=$m",
                       "/ip firewall address-list remove $e", ":if ($rep != $mlMacRep) do={", "/macip?key=KEY123")))
ok, out = lint(s)
t("script: RouterOS lint ok", ok, out)
t("script: nothing RouterOS-7-only", not rosv6.check(s), rosv6.check(s))
e = mp.script([], "u", "k")
t("nobody: empty lists (old entries taken out by the same loop)", ':local mm [:toarray ""]' in e and lint(e)[0])
o = mp.script(rows, "u", "k", on=False)
t("off: every mlmac entry taken out, no MAC sent", 'remove [find where comment~"^mlmac"]' in o and "AA:BB" not in o and lint(o)[0])
print("all macpolicy tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
