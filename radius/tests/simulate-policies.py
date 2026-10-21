#!/usr/bin/env python3
"""Simulate mikrotik/webfilter-policies.rsc (jump/return chains, time=, SNI, address lists) on sample traffic."""
import ipaddress, re, sys, fnmatch, os

RSC = os.path.join(os.path.dirname(__file__), "..", "mikrotik", "webfilter-policies.rsc")
chains, nat, lists, menu = {}, [], {}, None
for line in open(RSC):
    s = line.strip()
    if s.startswith("/"): menu = s
    if not s.startswith("add "): continue
    r = {k: v.strip('"') for k, v in re.findall(r'([a-z-]+)=("[^"]*"|\S+)', s)}
    if menu == "/ip firewall nat": nat.append(r)
    elif menu == "/ip firewall address-list": lists.setdefault(r["list"], []).append(r["address"])
    elif menu == "/ip firewall filter": chains.setdefault(r["chain"], []).append(r)

# filled by the server's router sync on a real router; a sample entry here
lists.setdefault("vpn-servers", []).append("203.0.113.50")
# the router's DNS adds what it answers for "domain hik-connect.com" (a sample cloud server here)
lists.setdefault("mlname-hik-connect.com", []).append("203.0.113.90")
# "allow-site moe.gov.pk" in a no-internet policy: a CDN subdomain the router's DNS answered
lists.setdefault("mlname-moe.gov.pk", []).append("198.51.100.120")
FAKE_DNS = {"moe.gov.pk": "203.0.113.77", "www.moe.gov.pk": "198.51.100.88", "g.whatsapp.net": "57.144.110.32", "connectivitycheck.gstatic.com": "142.250.181.3"}

def in_list(ip, name):
    for a in lists.get(name, []):
        a = FAKE_DNS.get(a, a)
        if ip and re.match(r"^[\d./]+$", a) and ipaddress.ip_address(ip) in ipaddress.ip_network(a, strict=False):
            return True
    return False

def port_ok(spec, p):
    return any(int(a) <= p <= int(b or a) for a, _, b in (x.partition("-") for x in spec.split(",")))

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
def secs(t):
    return sum(int(n) * {"h": 3600, "m": 60, "s": 1}[u] for n, u in re.findall(r"(\d+)([hms])", t))
def time_ok(spec, hour, day):
    rng, *days = spec.split(",")
    a, b = rng.split("-")
    return secs(a) <= hour * 3600 < secs(b) and day in days

def run(chain, f):
    for r in chains.get(chain, []):
        if "src-address-list" in r and r["src-address-list"] != f["list"]: continue
        if "protocol" in r and r["protocol"] != f["proto"]: continue
        if "dst-port" in r and not (f["port"] and port_ok(r["dst-port"], f["port"])): continue
        if "dst-address-list" in r and not in_list(f.get("dst"), r["dst-address-list"]): continue
        if "dst-address" in r and not (f.get("dst") and ipaddress.ip_address(f["dst"]) in ipaddress.ip_network(r["dst-address"])): continue
        if "time" in r and not time_ok(r["time"], f["hour"], f["day"]): continue
        if "tls-host" in r and not (f.get("sni") and fnmatch.fnmatch(f["sni"], r["tls-host"])): continue
        a = r["action"]
        if a == "jump":
            v = run(r["jump-target"], f)
            if v != "return": return v
            continue
        if a in ("log", "passthrough"): continue
        return a
    return "return" if chain != "forward" else "allow"

def dns(lst):
    for r in nat:
        if r["src-address-list"] == lst: return r["to-addresses"]
    return "router"

def F(lst, sni=None, proto="tcp", port=443, hour=11, day="tue", dst="198.51.100.1"):
    return dict(list=lst, sni=sni, proto=proto, port=port, hour=hour, day=day, dst=dst)

CASES = [
    ("students: facebook",                 F("policy-students", "www.facebook.com"),        "reject"),
    ("students: m.youtube.com",            F("policy-students", "m.youtube.com"),           "reject"),
    ("students: PUBG",                     F("policy-students", "api.pubgmobile.com"),      "reject"),
    ("students: xvideos (keyword)",        F("policy-students", "www.xvideos.com"),         "reject"),
    ("students: free-sex.org (^sex)",      F("policy-students", "free-sex.org"),            "reject"),
    ("students: wikipedia",                F("policy-students", "en.wikipedia.org"),        "allow"),
    ("students: essex.ac.uk",              F("policy-students", "www.essex.ac.uk"),         "allow"),
    ("students: ECH hidden site",          F("policy-students", "cloudflare-ech.com"),      "reject"),
    ("students: QUIC",                     F("policy-students", None, "udp"),               "drop"),
    ("staff: facebook at 11:00 Tuesday",   F("policy-staff", "www.facebook.com"),           "reject"),
    ("staff: facebook at 18:00 Tuesday",   F("policy-staff", "www.facebook.com", hour=18),  "allow"),
    ("staff: facebook Sunday",             F("policy-staff", "www.facebook.com", day="sun"),"allow"),
    ("staff: steam any time",              F("policy-staff", "store.steampowered.com", hour=20), "reject"),
    ("staff: linkedin at 11:00 (allow-site beats social)", F("policy-staff", "www.linkedin.com"), "allow"),
    ("staff: example-bet.com (block-site)", F("policy-staff", "www.example-bet.com", hour=20), "reject"),
    ("guests: example-bet.com (other policy)", F("policy-guests", "example-bet.com"), "allow"),
    ("no-internet: moe.gov.pk by name (allow-site)", F("policy-no-internet", "www.moe.gov.pk"), "allow"),
    ("no-internet: first packet to moe.gov.pk (address)", F("policy-no-internet", None, "tcp", 443, dst="203.0.113.77"), "allow"),
    ("no-internet: first packet to www.moe.gov.pk (other address)", F("policy-no-internet", None, "tcp", 443, dst="198.51.100.88"), "allow"),
    ("no-internet: first packet to a subdomain (DNS list)", F("policy-no-internet", None, "tcp", 443, dst="198.51.100.120"), "allow"),
    ("no-internet: first packet elsewhere", F("policy-no-internet", None, "tcp", 443, dst="198.51.100.9"), "reject"),
    ("whatsapp+hik: whatsapp chat", F("policy-whatsapp-hikconnect", None, "tcp", 5222, dst="157.240.1.53"), "accept"),
    ("whatsapp+hik: Hik-Connect cloud", F("policy-whatsapp-hikconnect", "api.hik-connect.com", "tcp", 443, dst="203.0.113.90"), "accept"),
    ("whatsapp+hik: NVR in this office", F("policy-whatsapp-hikconnect", None, "tcp", 8000, dst="192.168.1.64"), "accept"),
    ("whatsapp+hik: NVR video (UDP) in this office", F("policy-whatsapp-hikconnect", None, "udp", 554, dst="192.168.1.64"), "accept"),
    ("whatsapp+hik: google", F("policy-whatsapp-hikconnect", "www.google.com", "tcp", 443, dst="142.250.181.4"), "reject"),
    ("whatsapp+hik: facebook on Meta servers", F("policy-whatsapp-hikconnect", "www.facebook.com", "tcp", 443, dst="157.240.1.35"), "reject"),
    ("whatsapp+hik: youtube over QUIC", F("policy-whatsapp-hikconnect", None, "udp", 443, dst="142.250.181.4"), "reject"),
    ("whatsapp-only: still refuses Hik-Connect", F("policy-whatsapp-only", "api.hik-connect.com", "tcp", 443, dst="203.0.113.90"), "reject"),
    ("guests: facebook",                   F("policy-guests", "www.facebook.com"),          "allow"),
    ("guests: thepiratebay",               F("policy-guests", "thepiratebay.org"),          "reject"),
    ("no-internet: google",                F("policy-no-internet", "www.google.com"),       "reject"),
    ("no-internet: DNS-less UDP",          F("policy-no-internet", None, "udp", 3478),      "reject"),
    ("night-off: 02:00",                   F("policy-night-off", "www.google.com", hour=2), "reject"),
    ("night-off: 10:00 google",            F("policy-night-off", "www.google.com", hour=10),"allow"),
    ("normal user: facebook",              F("lan", "www.facebook.com"),                    "allow"),
    # no-video: Facebook/YouTube/TikTok videos blocked, the rest of the apps work
    ("no-video: facebook video",           F("policy-no-video", "video.fkhi4-1.fna.fbcdn.net"), "reject"),
    ("no-video: facebook reel (video-)",   F("policy-no-video", "video-sin6-2.xx.fbcdn.net"), "reject"),
    ("no-video: youtube stream",           F("policy-no-video", "rr3---sn-4g5edn6r.googlevideo.com"), "reject"),
    ("no-video: tiktok app",               F("policy-no-video", "api16-normal-c-alisg.tiktokv.com"), "reject"),
    ("no-video: tiktok video cdn",         F("policy-no-video", "v16-webapp-prime.tiktok.com"), "reject"),
    ("no-video: tiktok web",               F("policy-no-video", "www.tiktok.com"),           "reject"),
    ("no-video: facebook feed",            F("policy-no-video", "www.facebook.com"),         "allow"),
    ("no-video: facebook photo",           F("policy-no-video", "scontent.fkhi4-1.fna.fbcdn.net"), "allow"),
    ("no-video: messenger chat",           F("policy-no-video", "edge-chat.facebook.com"),   "allow"),
    ("no-video: whatsapp",                 F("policy-no-video", "g.whatsapp.net"),           "allow"),
    ("no-video: youtube.com page",         F("policy-no-video", "www.youtube.com"),          "allow"),
    ("no-video: google search",            F("policy-no-video", "www.google.com"),           "allow"),
    ("no-video: QUIC (video over UDP)",    F("policy-no-video", None, "udp"),                "drop"),
    ("no-video-day: youtube at 11:00",     F("policy-no-video-day", "rr1---sn-x.googlevideo.com"), "reject"),
    ("no-video-day: youtube at 22:00",     F("policy-no-video-day", "rr1---sn-x.googlevideo.com", hour=22), "allow"),
    ("no-video-day: QUIC at 22:00",        F("policy-no-video-day", None, "udp", hour=22),   "allow"),
    # no-vpn: names, keyword, servers list, protocols; normal traffic untouched
    ("no-vpn: nordvpn.com website",        F("policy-no-vpn", "nordvpn.com"),                "reject"),
    ("no-vpn: psiphon app (block list)",   F("policy-no-vpn", "www.psiphon3.com"),           "reject"),
    ("no-vpn: unknown 'turbovpn' name",    F("policy-no-vpn", "api.turbovpn-app.net"),       "reject"),
    ("no-vpn: Cloudflare WARP app",        F("policy-no-vpn", "engage.cloudflareclient.com"),"reject"),
    ("no-vpn: OpenVPN udp/1194",           F("policy-no-vpn", None, "udp", 1194),            "drop"),
    ("no-vpn: WireGuard udp/51820",        F("policy-no-vpn", None, "udp", 51820),           "drop"),
    ("no-vpn: WARP udp/2408",              F("policy-no-vpn", None, "udp", 2408),            "drop"),
    ("no-vpn: PPTP tcp/1723",              F("policy-no-vpn", None, "tcp", 1723),            "reject"),
    ("no-vpn: PPTP GRE",                   F("policy-no-vpn", None, "gre", 0),               "drop"),
    ("no-vpn: IPsec ESP",                  F("policy-no-vpn", None, "ipsec-esp", 0),         "drop"),
    ("no-vpn: known VPN server, tcp/443",  F("policy-no-vpn", None, "tcp", 443, dst="203.0.113.50"), "reject"),
    ("no-vpn: known VPN server, udp/8443", F("policy-no-vpn", None, "udp", 8443, dst="203.0.113.50"), "drop"),
    ("no-vpn: google",                     F("policy-no-vpn", "www.google.com"),             "allow"),
    ("no-vpn: whatsapp call udp/3478",     F("policy-no-vpn", None, "udp", 3478),            "allow"),
    ("normal user: OpenVPN",               F("lan", None, "udp", 1194),                      "allow"),
    ("students: VPN website",              F("policy-students", "www.expressvpn.com"),       "reject"),
    # whatsapp-only (allow-only profile inside a policy)
    ("whatsapp-only: chat to Meta",        F("policy-whatsapp-only", None, "tcp", 5222, dst="157.240.1.53"), "accept"),
    ("whatsapp-only: call STUN to Meta",   F("policy-whatsapp-only", None, "udp", 3478, dst="157.240.9.1"),  "accept"),
    ("whatsapp-only: facebook on Meta",    F("policy-whatsapp-only", "www.facebook.com", dst="157.240.1.35"), "reject"),
    ("whatsapp-only: youtube",             F("policy-whatsapp-only", "www.youtube.com", dst="142.250.181.14"), "reject"),
    ("whatsapp-only: any UDP elsewhere",   F("policy-whatsapp-only", None, "udp", 3478, dst="8.8.8.8"), "reject"),
    # single apps
    ("no-tiktok-pubg: tiktok",             F("policy-no-tiktok-pubg", "v16.tiktokcdn.com"),  "reject"),
    ("no-tiktok-pubg: pubg",               F("policy-no-tiktok-pubg", "api.pubgmobile.com"), "reject"),
    ("no-tiktok-pubg: youtube",            F("policy-no-tiktok-pubg", "www.youtube.com"),    "allow"),
    # time ranges over midnight are split in two (RouterOS ranges cannot cross 00:00)
    ("kids-night: Tue 23:00 no internet",  F("policy-kids-night", "www.google.com", hour=23, day="tue"), "reject"),
    ("kids-night: Wed 03:00 no internet",  F("policy-kids-night", "www.google.com", hour=3, day="wed"),  "reject"),
    ("kids-night: Tue 12:00 internet ok",  F("policy-kids-night", "www.google.com", hour=12, day="tue"), "allow"),
    ("kids-night: Fri 23:00 (weekend) ok", F("policy-kids-night", "www.google.com", hour=23, day="fri"), "allow"),
    ("kids-night: Sat 03:00 (weekend) ok", F("policy-kids-night", "www.google.com", hour=3, day="sat"),  "allow"),
    ("kids-night: games Sat 05:00 blocked",F("policy-kids-night", "api.pubgmobile.com", hour=5, day="sat"), "reject"),
    ("kids-night: games Sat 15:00 ok",     F("policy-kids-night", "api.pubgmobile.com", hour=15, day="sat"), "allow"),
    # quarantine (infected device): only DNS (+ the server's warning page), everything else refused
    ("quarantine: https google",           F("ml-quarantine", "www.google.com"),             "reject"),
    ("quarantine: whatsapp call",          F("ml-quarantine", None, "udp", 3478),            "reject"),
    ("quarantine: DNS still works",        F("ml-quarantine", None, "udp", 53),              "accept"),
]
fail = 0
for desc, f, exp in CASES:
    got = run("forward", f)
    fail += got != exp
    print(f"{'ok  ' if got == exp else 'FAIL'} {desc:36} -> {got}")
for lst, exp in [("policy-students", "185.228.168.168"), ("policy-guests", "1.1.1.3"), ("policy-staff", "router")]:
    got = dns(lst); fail += got != exp
    print(f"{'ok  ' if got == exp else 'FAIL'} {lst + ' DNS':36} -> {got}")
sys.exit(1 if fail else 0)
