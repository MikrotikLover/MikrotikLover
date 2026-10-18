#!/usr/bin/env python3
"""Why blocked? finder tests.
  python3 tests/test-whyblocked.py                     matcher only (uses webfilter/ of this repository)
  URL=https://127.0.0.1:8443 USER=admin PASS=... python3 tests/test-whyblocked.py   + the dashboard API
"""
import http.cookiejar, json, os, ssl, subprocess, sys, urllib.error, urllib.parse, urllib.request
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import whyblocked as w  # noqa: E402

WF = os.path.join(HERE, "..", "webfilter")
fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {info}"))
    fails += 0 if cond else 1


class Cat:                       # tiny stand-in for the CDN catalog
    def name(self, host):
        for d, app, cat in (("tiktok.com", "TikTok", "video"), ("pubg.com", "PUBG Mobile", "games"), ("nordvpn.com", "NordVPN", "vpn")):
            if host == d or host.endswith("." + d):
                return {"app": app, "category": cat, "matched": d, "generic": False}
        return None


MON_10 = datetime(2026, 10, 19, 10, 0)     # a Monday
MON_23 = datetime(2026, 10, 19, 23, 30)
SAT_10 = datetime(2026, 10, 24, 10, 0)

t("URL cleaned to the host", w.clean_host("HTTPS://user@M.Facebook.com:443/page?x=1") == "m.facebook.com")
t("not a site refused", w.clean_host("hello") == "" and w.clean_host("a b.com") == "" and w.clean_host("*.x.com") == "")
t("subdomain of a listed domain", w.domain_hit("video.fbcdn.net", "fbcdn.net") and not w.domain_hit("notfbcdn.net", "fbcdn.net"))
t("* pattern like tls-host", w.domain_hit("abc.xyz-cdn.com", "*xyz-cdn.com") and not w.domain_hit("xyz.org", "*xyz-cdn.com"))
t("keyword anywhere", w.keyword_hit("freeporn.net", "porn"))
t("^keyword only at the start of a name part", w.keyword_hit("x.sexvideos.com", "^sex") and not w.keyword_hit("essex.ac.uk", "^sex"))
t("time: inside the window", w.time_active("9h-17h,mon,tue,wed,thu,fri", MON_10))
t("time: other day", not w.time_active("9h-17h,mon,tue,wed,thu,fri", SAT_10))
t("time: over midnight", w.time_active("22h-6h", MON_23) and not w.time_active("22h-6h", MON_10))
t("time: 0s-6h and HH:MM", w.time_active("0s-6h", datetime(2026, 1, 1, 3, 0)) and w.time_active("08:30-09:00", datetime(2026, 1, 1, 8, 45)))
t("time: empty = always", w.time_active("", MON_10))

lists = w.lists_for("m.facebook.com", WF, Cat())
t("facebook: category social", any(h["kind"] == "category" and h["name"] == "social" for h in lists), lists)
lists = w.lists_for("www.nordvpn.com", WF, Cat())
t("VPN site: vpn list + app", {"vpn", "app"} <= {h["kind"] for h in lists}, lists)
t("adult keyword", any(h["kind"] == "keywords" for h in w.lists_for("hot-xxx-site.net", WF, Cat())))
t("ordinary site on no list", w.lists_for("example.org", WF, Cat()) == [])

POL = "# test\nblock social time=9h-17h,mon,tue,wed,thu,fri\nblock-app TikTok\nblock-vpn\ndns family\n"
r = w.explain("facebook.com", "office", POL, MON_10, WF, Cat())
t("blocked now by the category rule", r["verdict"] == "blocked" and r["rules"][0]["router"] == "WF-social" and "block social" in r["summary"], r)
r = w.explain("facebook.com", "office", POL, SAT_10, WF, Cat())
t("same rule on Saturday: other times only", r["verdict"] == "blocked-other-times" and "9h-17h" in r["summary"], r)
r = w.explain("www.tiktok.com", "office", POL, SAT_10, WF, Cat())
t("app rule, router log name", r["verdict"] == "blocked" and any(x["router"] == "WF-app-tiktok" and x["active"] for x in r["rules"]), r)
r = w.explain("nordvpn.com", "office", POL, SAT_10, WF, Cat())
t("block-vpn", any(x["router"] == "WF-vpn" for x in r["rules"]), r)
r = w.explain("example.org", "office", POL, MON_10, WF, Cat())
t("not blocked by the policy (+ DNS note)", r["verdict"] == "allowed" and "family" in r["summary"], r)
r = w.explain("example.org", "kids", "block-all time=22h-6h\n", MON_23, WF, Cat())
t("block-all at night", r["verdict"] == "blocked" and r["rules"][0]["router"] == "WF-noinet", r)
r = w.explain("www.google.com", "wa", "allow-only whatsapp\n", MON_10, WF, Cat())
t("allow-only: other sites refused", r["verdict"] == "blocked" and r["rules"][0]["router"] == "WF-allowonly", r)
r = w.explain("web.whatsapp.com", "wa", "allow-only whatsapp\n", MON_10, WF, Cat())
t("allow-only: its own host allowed", r["verdict"] == "allowed", r)
r = w.explain("facebook.com", None, "", MON_10, WF, Cat())
t("no policy: lists named, router-wide hint", r["verdict"] == "no-policy" and "webfilter-*.rsc" in r["summary"], r)

URL = os.environ.get("URL")
if URL:
    ctx = ssl._create_unverified_context()
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(jar))

    def get(path):
        try:
            with op.open(URL + path, timeout=60) as resp:
                return resp.status, json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    req = urllib.request.Request(URL + "/api/login", data=json.dumps({"username": os.environ["USER"], "password": os.environ["PASS"]}).encode(),
                                 headers={"Content-Type": "application/json"})
    op.open(req, timeout=30).read()
    db = lambda sql: subprocess.run(["mysql", "radius", "-N", "-e", sql], capture_output=True, text=True).stdout.strip()  # noqa: E731
    db("DELETE FROM radreply WHERE username='wb-test'; DELETE FROM radcheck WHERE username='wb-test';"
       "INSERT INTO radcheck (username, attribute, op, value) VALUES ('wb-test','Cleartext-Password',':=','x12345');"
       "INSERT INTO radreply (username, attribute, op, value) VALUES ('wb-test','Mikrotik-Address-List',':=','policy-wb-test')")
    open("/var/lib/mikrotiklover/policies/wb-test.txt", "w").write("# test\nblock-app TikTok\nblock social time=0s-1s\n")
    try:
        st, d = get("/api/why?" + urllib.parse.urlencode({"site": "https://www.tiktok.com/@x", "user": "wb-test"}))
        t("API: blocked by the user's policy", st == 200 and d["verdict"] == "blocked" and d["policy"] == "wb-test" and d["list_from"] == "user", d)
        st, d = get("/api/why?" + urllib.parse.urlencode({"site": "facebook.com", "user": "wb-test"}))
        t("API: rule outside its time", st == 200 and d["verdict"] == "blocked-other-times", d)
        st, d = get("/api/why?" + urllib.parse.urlencode({"site": "facebook.com", "user": "wb-test", "at": "2026-10-19T00:00"}))
        t("API: at a given time", st == 200 and d["verdict"] == "blocked", d)
        db("INSERT INTO ml_quarantine (username, reason) VALUES ('wb-test', 'test virus')")
        st, d = get("/api/why?" + urllib.parse.urlencode({"site": "example.org", "user": "wb-test"}))
        t("API: quarantine shown first", st == 200 and d["verdict"] == "blocked" and d["notes"][0].startswith("QUARANTINE"), d)
        st, d = get("/api/why?site=hello&user=wb-test")
        t("API: not a site -> 400", st == 400)
        st, d = get("/api/why?site=facebook.com&user=nosuchuser9")
        t("API: unknown user -> 404", st == 404)
        st, d = get("/api/why?site=facebook.com&user=" + urllib.parse.quote("a'b"))
        t("API: bad user -> 400", st == 400)
        st, d = get("/api/why?site=facebook.com")
        t("API: without a user", st == 200 and d["verdict"] == "no-policy", d)
        cli = subprocess.run(["radius-admin", "why", "www.tiktok.com", "wb-test"], capture_output=True, text=True).stdout
        t("CLI: same answer", "policy-wb-test" in cli and "Blocked by policy 'wb-test'" in cli and "QUARANTINE" in cli, cli)
    finally:
        db("DELETE FROM radreply WHERE username='wb-test'; DELETE FROM radcheck WHERE username='wb-test'; DELETE FROM ml_quarantine WHERE username='wb-test'")
        os.unlink("/var/lib/mikrotiklover/policies/wb-test.txt")
    jar.clear()
    st, _ = get("/api/why?site=facebook.com")
    t("API: needs login", st in (401, 403), st)

print("all why-blocked tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
