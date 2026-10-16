#!/usr/bin/env python3
"""Simulate mikrotik/webfilter-policies.rsc (jump/return chains, time=, SNI) on sample traffic."""
import re, sys, fnmatch, os

RSC = os.path.join(os.path.dirname(__file__), "..", "mikrotik", "webfilter-policies.rsc")
chains, nat, menu = {}, [], None
for line in open(RSC):
    s = line.strip()
    if s.startswith("/"): menu = s
    if not s.startswith("add "): continue
    r = {k: v.strip('"') for k, v in re.findall(r'([a-z-]+)=("[^"]*"|\S+)', s)}
    (nat.append(r) if menu == "/ip firewall nat" else chains.setdefault(r["chain"], []).append(r))

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
        if "dst-port" in r and int(r["dst-port"]) != f["port"]: continue
        if "time" in r and not time_ok(r["time"], f["hour"], f["day"]): continue
        if "tls-host" in r and not (f.get("sni") and fnmatch.fnmatch(f["sni"], r["tls-host"])): continue
        if "connection-state" in r: continue          # log-only rules
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

def F(lst, sni=None, proto="tcp", port=443, hour=11, day="tue"):
    return dict(list=lst, sni=sni, proto=proto, port=port, hour=hour, day=day)

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
