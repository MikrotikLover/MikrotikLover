#!/usr/bin/env python3
"""Simulate the generated allow-only-whatsapp.rsc firewall rules on sample traffic.
Evaluates the rules top-down like RouterOS (first matching accept/drop/reject wins)."""
import ipaddress, re, sys, fnmatch, os

RSC = os.path.join(os.path.dirname(__file__), "..", "mikrotik", "allow-only-whatsapp.rsc")
lists, rules, menu = {}, [], None
for line in open(RSC):
    s = line.strip()
    if s.startswith("/"): menu = s
    if not s.startswith("add "): continue
    props = dict(re.findall(r'([a-z-]+)=("[^"]*"|\S+)', s))
    props = {k: v.strip('"') for k, v in props.items()}
    if menu == "/ip firewall address-list":
        lists.setdefault(props["list"], []).append(props["address"])
    elif menu == "/ip firewall filter":
        rules.append(props)

# hostnames in address lists are resolved by the router; pretend-resolve the ones we use
FAKE_DNS = {"connectivitycheck.gstatic.com": "142.250.181.3", "mtalk.google.com": "142.250.102.188",
            "g.whatsapp.net": "57.144.110.32"}
def in_list(ip, name):
    for a in lists.get(name, []):
        a = FAKE_DNS.get(a, a)
        if re.match(r"^[\d./]+$", a) and ipaddress.ip_address(ip) in ipaddress.ip_network(a):
            return True
    return False

def ports(spec, p):
    for part in spec.split(","):
        lo, _, hi = part.partition("-")
        if int(lo) <= p <= int(hi or lo): return True
    return False

def verdict(src_listed, proto, dst, dport, sni=None):
    for r in rules:
        if r.get("src-address-list") == "allow-only-whatsapp" and not src_listed: continue
        if "protocol" in r and r["protocol"] != proto: continue
        if "dst-port" in r and not ports(r["dst-port"], dport): continue
        if "dst-address-list" in r and not in_list(dst, r["dst-address-list"]): continue
        if "dst-address" in r and ipaddress.ip_address(dst) not in ipaddress.ip_network(r["dst-address"]): continue
        if "tls-host" in r and not (sni and fnmatch.fnmatch(sni, r["tls-host"])): continue
        return r["action"]
    return "(other rules)"

CASES = [  # (description, proto, dst, port, sni, expected)
    ("WhatsApp chat (Noise, no SNI)",      "tcp", "57.144.110.32",  443,  None,                         "accept"),
    ("WhatsApp chat port 5222",            "tcp", "157.240.1.53",   5222, None,                         "accept"),
    ("WhatsApp media download",            "tcp", "157.240.1.60",   443,  "mmg.whatsapp.net",           "accept"),
    ("WhatsApp Web",                       "tcp", "157.240.1.60",   443,  "web.whatsapp.com",           "accept"),
    ("WhatsApp voice/video call (STUN)",   "udp", "157.240.9.1",    3478, None,                         "accept"),
    ("Facebook on the same Meta network",  "tcp", "157.240.1.35",   443,  "www.facebook.com",           "reject"),
    ("Instagram images",                   "tcp", "31.13.70.1",     443,  "scontent.cdninstagram.com",  "reject"),
    ("Facebook video CDN",                 "tcp", "31.13.70.2",     443,  "video.xx.fbcdn.net",         "reject"),
    ("Messenger",                          "tcp", "157.240.1.36",   443,  "edge-chat.messenger.com",    "reject"),
    ("Facebook app over QUIC",             "udp", "157.240.1.35",   443,  None,                         "drop"),
    ("YouTube",                            "tcp", "142.250.181.14", 443,  "www.youtube.com",            "reject"),
    ("TikTok",                             "tcp", "23.45.67.89",    443,  "www.tiktok.com",             "reject"),
    ("Any website over QUIC",              "udp", "142.250.181.14", 443,  None,                         "reject"),
    ("Google over the check IP, HTTPS",    "tcp", "142.250.181.3",  443,  "www.google.com",             "reject"),
    ("Android 'internet OK' check (HTTP)", "tcp", "142.250.181.3",  80,   None,                         "accept"),
    ("Android push notification",          "tcp", "142.250.102.188",5228, None,                         "accept"),
    ("iPhone push notification",           "tcp", "17.57.144.10",   5223, None,                         "accept"),
    ("iCloud / App Store",                 "tcp", "17.253.1.1",     443,  "apps.apple.com",             "reject"),
]
fail = 0
for desc, proto, dst, port, sni, exp in CASES:
    got = verdict(True, proto, dst, port, sni)
    ok = got == exp
    fail += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {desc:38} {proto}/{port:<5} -> {got}")
other = verdict(False, "tcp", "142.250.181.14", 443, "www.youtube.com")
print(f"{'ok  ' if other == '(other rules)' else 'FAIL'} {'normal user is not affected':38} -> {other}")
fail += other != "(other rules)"
sys.exit(1 if fail else 0)
