#!/usr/bin/env python3
"""Passpoint (Hotspot 2.0) tests.

  python3 tests/test-passpoint.py            settings, router scripts, phone profiles (no server needed)
  sudo python3 tests/test-passpoint.py --live   + on an installed server: radius-admin passpoint, real
                                                EAP-TTLS logins (eapol_test) with what each profile carries,
                                                the download page, accounting under the real name

The live part logs in exactly as a phone with the profile would: the name, password, realm, CA and
server name are read back OUT of the made profile (Android PPS-MO in the x-wifi-config MIME, Apple plist).
"""
import base64, email, json, os, plistlib, re, ssl, subprocess, sys, tempfile, urllib.request
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import passpoint as pp  # noqa: E402
import routersetup as rs  # noqa: E402

MK = os.path.join(HERE, "..", "mikrotik")
fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {str(info)[:400]}"))
    fails += 0 if cond else 1


def err(fn, *a):
    try:
        fn(*a)
        return ""
    except ValueError as e:
        return str(e)


def lint(text):
    with tempfile.NamedTemporaryFile("w", suffix=".rsc", delete=False) as f:
        f.write(text)
    p = subprocess.run([sys.executable, os.path.join(HERE, "lint-rsc.py"), f.name], capture_output=True, text=True)
    os.unlink(f.name)
    return p.returncode == 0, p.stdout


def read_android(text):
    """x-wifi-config file -> what Android takes from it"""
    msg = email.message_from_bytes(base64.b64decode(text))
    parts = {p.get_content_type(): p.get_payload(decode=True) for p in msg.walk() if not p.is_multipart()}
    root = ET.fromstring(parts["application/x-passpoint-profile"])
    ns = {"d": "syncml:dmddf1.2"}

    def val(path):
        node = root
        for name in path.split("/"):
            node = next((n for n in node.findall("d:Node", ns) if n.find("d:NodeName", ns).text == name), None)
            if node is None:
                return None
        v = node.find("d:Value", ns)
        return v.text if v is not None else ""
    pre = "PerProviderSubscription/i001/"
    return {"ddf": root.find("d:Node/d:RTProperties/d:Type/d:DDFName", ns).text,
            "fqdn": val(pre + "HomeSP/FQDN"), "friendly": val(pre + "HomeSP/FriendlyName"),
            "oi": val(pre + "HomeSP/RoamingConsortiumOI"), "realm": val(pre + "Credential/Realm"),
            "user": val(pre + "Credential/UsernamePassword/Username"),
            "pw": base64.b64decode(val(pre + "Credential/UsernamePassword/Password") or "").decode(),
            "eap": val(pre + "Credential/UsernamePassword/EAPMethod/EAPType"),
            "inner": val(pre + "Credential/UsernamePassword/EAPMethod/InnerMethod"),
            "trusted": val(pre + "Extension/Android/AAAServerTrustedNames/FQDN"),
            "ca": parts.get("application/x-x509-ca-cert")}


def read_ios(data):
    p = plistlib.loads(data)
    ca = next((c["PayloadContent"] for c in p["PayloadContent"] if c["PayloadType"] == "com.apple.security.root"), None)
    w = next(c for c in p["PayloadContent"] if c["PayloadType"] == "com.apple.wifi.managed")
    e = w["EAPClientConfiguration"]
    return {"profile": p, "wifi": w, "eap": e, "ca": ca, "user": e["UserName"], "pw": e["UserPassword"],
            "realm": e["OuterIdentity"].split("@", 1)[1], "fqdn": e["TLSTrustedServerNames"][0]}


# ---------------------------------------------------------------- settings
ST = pp.settings({"domain": "Wifi.Acme.Example.", "name": "Acme Ltd", "ssid": "Acme-WiFi", "roaming_oi": "5A-03-BA-00-00"})
t("settings: domain lower-cased, trailing dot gone", ST["domain"] == "wifi.acme.example", ST)
t("settings: defaults filled", ST["venue"] == "business-professional-office" and ST["network"] == "private" and ST["venue_name"] == "Office", ST)
t("settings: roaming OI normalised", ST["roaming_oi"] == "5a03ba0000", ST)
for bad, word in [({"domain": "nodot"}, "domain"), ({"domain": "a b.com"}, "domain"), ({"domain": "x.com", "ssid": 'a"b'}, "Wi-Fi name"),
                  ({"domain": "x.com", "name": "a:b"}, "name"), ({"domain": "x.com", "venue": "moon"}, "venue"),
                  ({"domain": "x.com", "network": "open"}, "network"), ({"domain": "x.com", "roaming_oi": "12345"}, "roaming"),
                  ({"domain": "x.com", "venue_name": "x;y"}, "venue name"), ({"domain": "x.com", "ssid": "a" * 33}, "Wi-Fi name")]:
    e = err(pp.settings, bad)
    t(f"settings refused: {bad}", word in e, e)

# ---------------------------------------------------------------- router scripts
for fname, menu in (("passpoint-wifi-ros7.rsc", "/interface wifi interworking"), ("passpoint-wireless-legacy.rsc", "/interface wireless interworking-profiles")):
    raw = open(os.path.join(MK, fname), encoding="utf-8").read()
    ok, out = lint(raw)
    t(f"{fname}: lint ok as shipped", ok, out)
    text = pp.router(ST, raw, "10.10.10.10", "Sekret123")
    ok, out = lint(text)
    t(f"{fname}: filled script lint ok", ok, out)
    t(f"{fname}: domain, realm, OI in the profile", "domain-names=wifi.acme.example realms=wifi.acme.example:not-specified roaming-ois=5a03ba0000" in text, text)
    t(f"{fname}: names and SSID", 'operator-names="Acme Ltd:eng"' in text and 'ssid="Acme-WiFi"' in text and 'venue-names="Office:eng"' in text, text)
    t(f"{fname}: server and secret", 'add address=10.10.10.10 secret="Sekret123" service=wireless' in text, text)
    body = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
    t(f"{fname}: nothing of the example left", not re.search(r"wifi\.example\.com|Office-Passpoint|Your Company|RADIUS_", body), body)
    t(f"{fname}: old copy removed first (import again = update)", body.index(f"{menu}\nremove") < body.index(f"{menu}\nadd"), body)
    t(f"{fname}: one virtual AP per radio, none on a router without radios", ":foreach r in=[" in body and "master-interface=$r" in body, body)
    t(f"{fname}: WPA2-Enterprise", "wpa2-eap" in body, body)
no_oi = pp.router(pp.settings({"domain": "x.example"}), open(os.path.join(MK, "passpoint-wifi-ros7.rsc"), encoding="utf-8").read())
t("router: no roaming OI -> no roaming-ois=", "roaming-ois" not in no_oi.split("# Import", 1)[1])
t("router: default settings fill in too", 'ssid="Office-Passpoint"' in no_oi and "domain-names=x.example " in no_oi, no_oi)
t("router: changed template refused", "not found" in err(pp.router, ST, "# Import\n/interface wifi interworking\nadd domain-names=wifi.example.com\n"))

# ---------------------------------------------------------------- dashboard Router setup
BASE = dict(server_ip="10.10.10.10", secret="Sekret123", router_ip="10.10.10.1", router_name="Office", passpoint_settings=ST)
s7 = rs.build({**BASE, "passpoint": True}, MK)
t("setup: Passpoint part (RouterOS 7 wifi)", "/interface wifi interworking" in s7 and "domain-names=wifi.acme.example" in s7, s7)
t("setup: one RADIUS entry, service wireless", s7.count("/radius add ") == 1 and "service=wireless " in s7, s7)
t("setup: lint ok", lint(s7)[0], lint(s7)[1])
sl = rs.build({**BASE, "passpoint": True, "passpoint_legacy": True}, MK)
t("setup: old wireless menu when ticked", "/interface wireless interworking-profiles" in sl and "/interface wifi " not in sl, sl)
s6 = rs.build({**BASE, "passpoint": True}, MK, ros="6")
t("setup: RouterOS 6 gets the old wireless version", "/interface wireless interworking-profiles" in s6 and "/interface wifi" not in s6, s6)
t("setup: with staff Wi-Fi + MAC devices", "cfg-passpoint" in rs.build({**BASE, "passpoint": True, "wpa_ros7": True, "macauth": True,
                                                                         "devices_key": "Devices123"}, MK))
e = err(rs.build, {**BASE, "passpoint": True, "passpoint_settings": {}}, MK)
t("setup: Passpoint without settings refused with a hint", "Passpoint" in e and "domain" in e, e)

# ---------------------------------------------------------------- phone profiles
CA = b"0\x82\x01\x0afake-der-ca"
a = read_android(pp.android(ST, "ali", "P@ss w0rd:é", CA, "radius.acme.example"))
t("android: PPS MO type", a["ddf"] == pp.PPS_DDF, a)
t("android: home provider = domain, friendly name", a["fqdn"] == "wifi.acme.example" and a["friendly"] == "Acme Ltd", a)
t("android: realm, user, password (base64 inside, any characters)", a["realm"] == "wifi.acme.example" and a["user"] == "ali" and a["pw"] == "P@ss w0rd:é", a)
t("android: EAP-TTLS (21) with MS-CHAP-V2", a["eap"] == "21" and a["inner"] == "MS-CHAP-V2", a)
t("android: roaming OI", a["oi"] == "5a03ba0000", a)
t("android: CA travels with the profile", a["ca"] == CA, a["ca"])
t("android: server name (Android 12+) when not the domain", a["trusted"] == "radius.acme.example", a)
a2 = read_android(pp.android(ST, "ali", "x1234", None, "wifi.acme.example"))
t("android: no CA part for a public certificate; no extra server name when = domain", a2["ca"] is None and a2["trusted"] is None, a2)
t("android: XML-special characters escaped", read_android(pp.android(ST, "a.b+c", "<x>&'\"", None))["pw"] == "<x>&'\"")
i = read_ios(pp.ios(ST, "ali", "P@ss w0rd:é", CA, "radius.acme.example"))
t("ios: Passpoint payload (IsHotspot, domain, realm)", i["wifi"]["IsHotspot"] is True and i["wifi"]["DomainName"] == "wifi.acme.example"
  and i["wifi"]["NAIRealmNames"] == ["wifi.acme.example"], i["wifi"])
t("ios: EAP-TTLS / MSCHAPv2, anonymous outer name", i["eap"]["AcceptEAPTypes"] == [21] and i["eap"]["TTLSInnerAuthentication"] == "MSCHAPv2"
  and i["eap"]["OuterIdentity"] == "anonymous@wifi.acme.example", i["eap"])
t("ios: user, password, server name", i["user"] == "ali" and i["pw"] == "P@ss w0rd:é" and i["fqdn"] == "radius.acme.example", i["eap"])
t("ios: CA payload and the Wi-Fi trusts it", i["ca"] == CA and i["eap"]["PayloadCertificateAnchorUUID"] == [
    next(c["PayloadUUID"] for c in i["profile"]["PayloadContent"] if c["PayloadType"] == "com.apple.security.root")], i["eap"])
t("ios: roaming OI upper-case hex", i["wifi"]["RoamingConsortiumOIs"] == ["5A03BA0000"], i["wifi"])
i2 = read_ios(pp.ios(ST, "ali", "other", None))
t("ios: same user -> same profile id (installing again replaces it)", i2["profile"]["PayloadUUID"] == i["profile"]["PayloadUUID"]
  and i2["profile"]["PayloadIdentifier"] == i["profile"]["PayloadIdentifier"])
t("ios: other user -> other profile id", read_ios(pp.ios(ST, "sara", "x1234"))["profile"]["PayloadUUID"] != i["profile"]["PayloadUUID"])
t("ios: no CA payload for a public certificate", i2["ca"] is None and "PayloadCertificateAnchorUUID" not in i2["eap"])
for fn in (pp.ios, pp.android):
    t(f"{fn.__name__}: bad user / no password refused", err(fn, ST, "a b", "x") and err(fn, ST, "ali", ""))

# ---------------------------------------------------------------- live server
if "--live" in sys.argv:
    def sh(*cmd, inp=None):
        p = subprocess.run(list(cmd), input=inp, capture_output=True, text=True)
        return p.returncode, re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)
    conf = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', open("/etc/mikrotiklover-radius/radius.conf").read(), re.M))
    secret, port = conf["LOCAL_SECRET"], conf.get("WEB_PORT", "8443")
    sh("radius-admin", "user", "del", "pptest1"); sh("radius-admin", "user", "del", "pptest2")
    sh("radius-admin", "user", "add", "pptest1", "-p", "Pp#Test-2026")
    sh("radius-admin", "user", "add", "pptest2", "-p", "Pp#Nt-2026", "--nt-hash")
    rc, old = sh("radius-admin", "passpoint", "json")
    rc, out = sh("radius-admin", "passpoint", "set", "--domain", "bad domain")
    t("live: bad domain refused", rc != 0 and "domain" in out, out)
    rc, out = sh("radius-admin", "passpoint", "set", "--name", "Live Test", "--ssid", "Live-PP", "--roaming-oi", "-")
    t("live: settings saved", rc == 0, out)
    rc, st = sh("radius-admin", "passpoint", "json")
    st = json.loads(st)
    t("live: settings read back", st["name"] == "Live Test" and st["ssid"] == "Live-PP", st)
    rc, out = sh("radius-admin", "passpoint", "status")
    t("live: status", rc == 0 and "Live-PP" in out, out)
    rc, out = sh("radius-admin", "passpoint", "profile", "pptest2", "--android")
    t("live: NT-hash user needs the password given", rc != 0 and "-p" in out, out)

    def login(prof, mac="02:aa:bb:cc:dd:01", pw=None):
        d = tempfile.mkdtemp()
        ca = os.path.join(d, "ca.pem")
        if prof["ca"]:
            subprocess.run(["openssl", "x509", "-inform", "der", "-out", ca], input=prof["ca"], check=True, capture_output=True)
        else:
            ca = "/etc/ssl/certs/ca-certificates.crt"
        cfg = os.path.join(d, "c.conf")
        with open(cfg, "w") as f:
            f.write(f'network={{\n key_mgmt=WPA-EAP\n eap=TTLS\n identity="{prof["user"]}"\n anonymous_identity="anonymous@{prof["realm"]}"\n'
                    f' password="{pw or prof["pw"]}"\n phase2="auth=MSCHAPV2"\n ca_cert="{ca}"\n domain_suffix_match="{prof["fqdn"]}"\n}}\n')
        p = subprocess.run(["eapol_test", "-c", cfg, "-a", "127.0.0.1", "-s", secret, "-t", "10", "-M", mac], capture_output=True, text=True)
        return p.returncode == 0 and "SUCCESS" in p.stdout
    rc, out = sh("radius-admin", "passpoint", "profile", "pptest1", "--android")
    a = read_android(out)
    t("live: Android profile: domain is the server's name", a["fqdn"] == st["domain"], a)
    t("live: Android profile logs in (TTLS, anonymous@domain, CA + name checked)", login(a), a)
    t("live: wrong password refused", not login(a, pw="Wrong-pass1"))
    rc, out = sh("bash", "-c", "radius-admin passpoint profile pptest1 --ios")
    with tempfile.NamedTemporaryFile(suffix=".mobileconfig", delete=False) as f:
        pass
    sh("radius-admin", "passpoint", "profile", "pptest1", "--ios", "-o", f.name)
    t("live: profile file only for root", oct(os.stat(f.name).st_mode & 0o777) == "0o600", oct(os.stat(f.name).st_mode))
    i = read_ios(open(f.name, "rb").read())
    os.unlink(f.name)
    t("live: iPhone profile logs in", login(i, mac="02:aa:bb:cc:dd:02"), i["eap"])
    rc, out = sh("radius-admin", "passpoint", "profile", "pptest2", "--android", "-p", "Pp#Nt-2026")
    t("live: NT-hash user logs in with the given password", login(read_android(out), mac="02:aa:bb:cc:dd:03"))
    rc, out = sh("mysql", "radius", "-N", "-e", "SELECT username FROM ml_eap_identity WHERE mac='02-AA-BB-CC-DD-03'")
    t("live: real name noted for the phone's MAC", out.strip() == "pptest2", out)
    acct = (f'User-Name = "anonymous@{st["domain"]}"\nAcct-Status-Type = Start\nAcct-Session-Id = "pptest-acct"\n'
            'Calling-Station-Id = "02-AA-BB-CC-DD-03"\nNAS-IP-Address = 127.0.0.1\n')
    sh("radclient", "127.0.0.1:1813", "acct", secret, inp=acct)
    rc, out = sh("mysql", "radius", "-N", "-e", "SELECT username FROM radacct WHERE acctsessionid='pptest-acct'")
    t("live: accounting (anonymous@domain) booked under the real user", out.strip() == "pptest2", out)
    sh("mysql", "radius", "-e", "DELETE FROM radacct WHERE acctsessionid='pptest-acct'")

    rc, out = sh("radius-admin", "passpoint", "link", "pptest1", "--hours", "1")
    m = re.search(r"/api/public/passpoint/([0-9a-f]{32})", out)
    t("live: link made", rc == 0 and m, out)
    if m:
        ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
        base = f"https://127.0.0.1:{port}/api/public/passpoint/{m.group(1)}"

        def get(url, ua="Mozilla/5.0 (Linux; Android 14)"):
            try:
                r = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), context=ctx, timeout=30)
                return r.status, r.headers, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.headers, b""
        code, h, body = get(base)
        t("live: page opens, Android button first on Android", code == 200 and body.decode().index("/android") < body.decode().index("/ios"), body[:300])
        t("live: page has a strict CSP", "default-src 'none'" in h.get("Content-Security-Policy", ""), dict(h))
        code, h, body = get(base, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")
        t("live: iPhone button first on iPhone", body.decode().index("/ios") < body.decode().index("/android"))
        code, h, body = get(base + "/android")
        t("live: Android download is application/x-wifi-config", code == 200 and h.get_content_type() == "application/x-wifi-config", dict(h))
        t("live: downloaded Android profile logs in", login(read_android(body.decode()), mac="02:aa:bb:cc:dd:04"))
        code, h, body = get(base + "/ios")
        t("live: iPhone download is a configuration profile", code == 200 and h.get_content_type() == "application/x-apple-aspen-config", dict(h))
        t("live: downloaded iPhone profile logs in", login(read_ios(body), mac="02:aa:bb:cc:dd:05"))
        rc, out = sh("radius-admin", "passpoint", "links")
        t("live: links list counts the downloads", re.search(r"pptest1\s*\|\s*\S+\s*\|\s*2\s*\|", out), out)
        t("live: unknown token 404", get(base[:-32] + "0" * 32)[0] == 404)
        t("live: unknown kind 404", get(base + "/windows")[0] == 404)
        sh("radius-admin", "passpoint", "unlink", "pptest1")
        t("live: removed link 404", get(base + "/ios")[0] == 404)
    sh("radius-admin", "user", "del", "pptest1"); sh("radius-admin", "user", "del", "pptest2")
    try:     # settings back as they were
        o = json.loads(old)
        sh("radius-admin", "passpoint", "set", "--name", o["name"], "--ssid", o["ssid"], "--roaming-oi", o["roaming_oi"] or "-")
    except (ValueError, KeyError):
        pass

print("all Passpoint tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
