#!/usr/bin/env python3
"""Router setup page tests.
  python3 tests/test-routersetup.py                       script builder only (no server needed)
  URL=https://127.0.0.1:8443 USER=admin PASS=... python3 tests/test-routersetup.py   + the dashboard API
The made scripts are also checked with tests/lint-rsc.py.
"""
import http.cookiejar, json, os, re, ssl, subprocess, sys, tempfile, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import routersetup as rs  # noqa: E402

MK = os.path.join(HERE, "..", "mikrotik")
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


def err(o, auto=""):
    try:
        rs.build(o, MK, auto)
        return ""
    except ValueError as e:
        return str(e)


BASE = dict(server_ip="10.10.10.10", secret="Sekret123", router_ip="10.10.10.1", router_name="Office")
ALL = dict(BASE, hotspot=1, hotspot_create=1, lan_net="192.168.88.1/24", wpa_ros7=1, staff_ssid="Staff Net", pppoe=1, pppoe_if="ether3",
           macauth=1, devices_ssid="Dev", devices_key="abcdefgh12", logging=1, dnslog=1, traffic=1, security=1, languard=1,
           server_if="ether5", server_net="10.10.10.1/24", autosync=1)
s = rs.build(ALL, MK, '/system script\nadd name=ml-sync source={ :put "x" }')
t("everything: one RADIUS entry with all services", s.count("/radius add") == 1 and "service=hotspot,ppp,wireless " in s)
t("no placeholders left", not re.search(r"RADIUS_SERVER_IP|RADIUS_SECRET|Office-WiFi|Devices-WiFi|DevicesWiFiKey123", s))
t("server IP and secret filled in", 'address=10.10.10.10 secret="Sekret123"' in s and "remote=10.10.10.10" in s)
t("names filled in", 'ssid="Staff Net"' in s and 'ssid="Dev"' in s and 'passphrase="abcdefgh12"' in s and "interface=ether3" in s)
t("blocking base added before logging", s.index("webfilter-base.rsc") < s.index("webfilter-logging.rsc"))
t("server port: out of the bridge, own address", '/interface bridge port remove [find interface="ether5"]' in s and "address=10.10.10.1/24 interface=ether5" in s)
t("hotspot made only when none", ':if ([:len [/ip hotspot find interface="bridge"]] = 0)' in s and "ranges=192.168.88.10-192.168.88.254" in s)
t("auto-sync text included", "add name=ml-sync" in s)
ok, out = lint(s)
t("full script passes the RouterOS lint", ok, out)

s = rs.build(dict(BASE, hotspot=1, lan_if="vlan20", languard=1), MK)
t("hotspot only: service=hotspot", "service=hotspot " in s and "/ppp" not in s and "webfilter-base" not in s)
t("LAN guard uses the LAN interface", 'lanIf "vlan20"' in s and '"bridge"' not in s)
ok, out = lint(s)
t("small script passes the lint", ok, out)
s = rs.build(dict(BASE, hotspot=1, hotspot_mac=1), MK)
t("remember devices: the hotspot tries the MAC first (MAC as user name), login page for the rest",
  "login-by=mac,http-chap,cookie mac-auth-mode=mac-as-username" in s and s.count("login-by=") == 1)
ok, out = lint(s)
t("  ... passes the lint", ok, out)
t("without the option the hotspot keeps the login page only", "login-by=http-chap,cookie" in rs.build(dict(BASE, hotspot=1), MK))
s = rs.build(dict(BASE, logging=1, base_done=1), MK)
t("base already on the router: not added again", "webfilter-base" not in s and "/radius add" not in s)
s = rs.build(dict(BASE, wpa_legacy=1), MK)
t("old wireless: default SSID kept", 'ssid="Office-WiFi"' in s and "service=wireless " in s)

t("nothing chosen refused", "at least one" in err(dict(BASE)))
t("both Wi-Fi kinds refused", "not both" in err(dict(BASE, wpa_ros7=1, wpa_legacy=1)))
t("bad server IP refused", "server IP" in err(dict(BASE, server_ip="10.0.0.300", hotspot=1)))
t("missing secret refused", "secret" in err(dict(BASE, secret="", hotspot=1)))
t("secret with a quote refused (no script injection)", "secret" in err(dict(BASE, secret='abc"def;/system reset', hotspot=1)))
t("bad interface refused", "interface" in err(dict(BASE, lan_if="bridge; /system reset", hotspot=1)))
t("bad SSID refused", "Wi-Fi name" in err(dict(BASE, wpa_ros7=1, staff_ssid='x"; /system reset')))
t("short devices password refused", "8-63" in err(dict(BASE, macauth=1, devices_key="short")))
t("hotspot create needs a /24", "/24" in err(dict(BASE, hotspot=1, hotspot_create=1, lan_net="10.0.0.1/16")))
t("server port needs an address", "server port" in err(dict(BASE, hotspot=1, server_if="ether5", server_net="")))
t("auto-sync without rules refused", "Build" in err(dict(BASE, autosync=1, base_done=1)))

# ------------------------------------------------------------------ dashboard API (optional)
URL = os.environ.get("URL")
if URL:
    ctx = ssl._create_unverified_context()
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx), urllib.request.HTTPCookieProcessor(jar))
    csrf = ""

    def call(method, path, data=None, raw=False):
        req = urllib.request.Request(URL + path, method=method, data=json.dumps(data).encode() if data is not None else None,
                                     headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
        try:
            with op.open(req, timeout=30) as r:
                b = r.read().decode()
                return r.status, (b if raw else json.loads(b))
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    st, r = call("POST", "/api/login", {"username": os.environ["USER"], "password": os.environ["PASS"]})
    csrf = r.get("csrf", "") if isinstance(r, dict) else ""
    st, info = call("GET", "/api/router-setup")
    t("API: page data", st == 200 and len(info["modules"]) == len(rs.MODULES), info)
    routers = [x["nasname"] for x in info.get("routers", []) if "/" not in x["nasname"]]
    if not routers:
        print("skip API tests: no router on the Routers page")
    else:
        rip = routers[0]
        st, r = call("POST", "/api/router-setup", {"router": rip, "server_ip": "10.10.10.10", "hotspot": True, "logging": True,
                                                   "security": True, "autosync": True})
        t("API: script made", st == 200 and r.get("line", "").startswith("/tool fetch url=\"https://10.10.10.10:"), r)
        if st == 200:
            tok = r["token"]
            t("API: one-liner imports and removes the file", "/import file-name=ml-setup.rsc; /file remove ml-setup.rsc" in r["line"])
            t("API: router secret in the script, not in the line", "secret=" in r["script"] and "secret" not in r["line"])
            t("API: auto-sync key filled in", "PUT-THE-KEY-HERE" not in r["script"] and "api/public/router" in r["script"])
            ok, out = lint(r["script"])
            t("API: script passes the lint", ok, out)
            st, s0 = call("GET", f"/api/router-setup/{tok}")
            t("API: not fetched yet", st == 200 and s0["fetched"] == 0 and s0["seconds_left"] > 3500, s0)
            anon = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
            with anon.open(URL + f"/api/public/setup/{tok}.rsc", timeout=30) as resp:
                body = resp.read().decode()
            t("router download (no login) gives the same script", body == r["script"])
            st, s1 = call("GET", f"/api/router-setup/{tok}")
            t("API: shows it was fetched", s1.get("fetched") == 1, s1)
            for bad in ("0" * 32, "../../etc/passwd", "abc"):
                try:
                    anon.open(URL + f"/api/public/setup/{bad}.rsc", timeout=30)
                    code = 200
                except urllib.error.HTTPError as e:
                    code = e.code
                t(f"unknown token refused ({bad[:12]})", code == 404, code)
            subprocess.run(["mysql", "radius", "-e", f"UPDATE ml_router_setup SET expires=NOW() - INTERVAL 1 SECOND WHERE token='{tok}'"])
            try:
                anon.open(URL + f"/api/public/setup/{tok}.rsc", timeout=30)
                code = 200
            except urllib.error.HTTPError as e:
                code = e.code
            t("expired link refused", code == 404, code)
        st, r = call("POST", "/api/router-setup", {"router": "203.0.113.99", "server_ip": "10.10.10.10", "hotspot": True})
        t("API: unknown router refused", st == 400 and "Routers page" in str(r), r)
        st, r = call("POST", "/api/router-setup", {"router": rip, "server_ip": "10.10.10.10", "hotspot": True, "lan_if": "x;y"})
        t("API: bad input refused with a message", st == 400 and "interface" in str(r), r)
        jar.clear()
        st, r = call("POST", "/api/router-setup", {"router": rip, "server_ip": "10.10.10.10", "hotspot": True})
        t("API: needs login", st in (401, 403), st)

print("all router setup tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
