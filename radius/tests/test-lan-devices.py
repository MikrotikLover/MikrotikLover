#!/usr/bin/env python3
"""Devices page: every LAN device and its own policy by MAC (tools/landev.py).

  python3 tests/test-lan-devices.py               report parsing, MAC formats, random MAC, order, router scripts
  sudo python3 tests/test-lan-devices.py --live   + the router endpoint, default policy, IP change, radius-admin devices,
                                                  the order on a real server (quarantine > login > device > network),
                                                  live.rsc / sync.rsc, the dashboard API (URL USER PASS for the API part)
The router itself (real DHCP lease -> server -> policy list, IP change) is tested by tests/test-chr.sh.
"""
import http.cookiejar, json, os, re, ssl, subprocess, sys, tempfile, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import landev as ld  # noqa: E402
import macpolicy  # noqa: E402
import rosv6  # noqa: E402

fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {str(info)[:500]}"))
    fails += 0 if cond else 1


def lint(text):
    with tempfile.NamedTemporaryFile("w", suffix=".rsc", delete=False) as f:
        f.write(text)
    p = subprocess.run([sys.executable, os.path.join(HERE, "lint-rsc.py"), f.name], capture_output=True, text=True)
    os.unlink(f.name)
    return p.returncode == 0, p.stdout


def v6ok(text):
    return subprocess.run([sys.executable, os.path.join(HERE, "..", "tools", "rosv6.py"), "check", "/dev/stdin"],
                          input=rosv6.convert(text), capture_output=True, text=True).returncode == 0


# ---------------------------------------------------------------- MACs
t("MAC formats -> AA:BB:..", {ld.norm_mac(m) for m in ("aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "aabbccddeeff")} == {"AA:BB:CC:DD:EE:FF"})
t("not a MAC", all(ld.norm_mac(m) is None for m in ("", "aa:bb:cc", "zz:bb:cc:dd:ee:ff", "aa:bb:cc:dd:ee:ff:00")))
t("random MAC: locally administered bit", ld.random_mac("DA:A1:19:00:00:01") and ld.random_mac("02:00:00:00:00:01") and ld.random_mac("6e:00:00:00:00:01"))
t("not random: a maker's MAC", not ld.random_mac("3C:22:FB:11:22:33") and not ld.random_mac("00:11:32:AA:BB:CC") and not ld.random_mac("bad"))

# ---------------------------------------------------------------- the router's report
rep = ld.parse_report("aa:bb:cc:00:00:01|192.168.88.50|Ali's <Phone>|bridge|dhcp\n"
                      "AA-BB-CC-00-00-01|192.168.88.99||bridge|arp\n"         # same MAC by ARP: the lease wins
                      "aa:bb:cc:00:00:02|192.168.88.5||ether2;x|arp\n"
                      "aa:bb:cc:00:00:03|fe80::1|v6|bridge|dhcp\n"             # IPv6: left out
                      "aa:bb:cc:00:00:04|0.0.0.0|x|bridge|dhcp\n"
                      "nonsense|192.168.88.7\n\n-\n"
                      "aa:bb:cc:00:00:05|192.168.88.8|x|bridge|weird")
macs = [r["mac"] for r in rep]
t("report: good lines, one per MAC, bad ones left out", macs == ["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02", "AA:BB:CC:00:00:05"], rep)
t("report: a lease beats ARP for the same MAC", rep[0]["ip"] == "192.168.88.50" and rep[0]["src"] == "dhcp")
t("report: host name cleaned (no < > quotes)", rep[0]["host"] == "Ali's Phone", rep[0])
t("report: interface cleaned", rep[1]["iface"] == "ether2x" and rep[1]["src"] == "arp", rep[1])
t("report: unknown source -> dhcp", rep[2]["src"] == "dhcp")
t("report: at most 8000 lines", len(ld.parse_report("\n".join(f"02:00:00:00:{i // 256:02x}:{i % 256:02x}|10.1.{i // 250}.{i % 250 + 1}" for i in range(9000)))) == 8000)

# ---------------------------------------------------------------- order: quarantine > login > device
devs = [{"mac": "aa:bb:cc:00:00:01", "name": "Ali laptop", "host": "", "policy": "whatsapp-only", "last_ip": "192.168.88.50", "login_policy": 0, "quarantined": 0},
        {"mac": "aa:bb:cc:00:00:02", "name": "", "host": "tv", "policy": "no-video", "last_ip": "", "login_policy": 1, "quarantined": 0},
        {"mac": "aa:bb:cc:00:00:03", "name": "", "host": "", "policy": "guests", "last_ip": "", "login_policy": 0, "quarantined": 1},
        {"mac": "aa:bb:cc:00:00:04", "name": "", "host": "", "policy": "guests", "last_ip": "", "login_policy": 0, "quarantined": 0},
        {"mac": "aa:bb:cc:00:00:05", "name": "", "host": "", "policy": "Bad;Policy", "last_ip": "", "login_policy": 0, "quarantined": 0}]
rows = ld.device_rows(devs, login_macs=["AA-BB-CC-00-00-04"])
t("order: only the device with nothing above it gets its policy", [r["mac"] for r in rows] == ["AA:BB:CC:00:00:01"], rows)
t("order: device -> its policy list, named in the comment", rows[0]["lists"] == ["policy-whatsapp-only"] and rows[0]["user"] == "dev-Ali-laptop", rows)
t("order: a login's policy (open session) beats the device's", all(r["mac"] != "AA:BB:CC:00:00:02" for r in rows))
t("order: quarantine beats the device's", all(r["mac"] != "AA:BB:CC:00:00:03" for r in rows))
t("order: a Wi-Fi user's list on that MAC beats the device's", all(r["mac"] != "AA:BB:CC:00:00:04" for r in rows))

# ---------------------------------------------------------------- the router scripts
BASE, KEY = "https://radius.example.lan:8443/api/public/router", "K" * 32
live = macpolicy.script(rows, BASE, KEY, True) + ld.report_script(BASE, KEY) + ld.own_script()
ok, out = lint(live)
t("ml-live part: lint ok", ok, out)
t("ml-live part: RouterOS 6 copy has nothing 7-only", v6ok(live))
t("ml-live: the device's MAC -> its list (DHCP lease, else ARP)", '"AA:BB:CC:00:00:01"="policy-whatsapp-only"' in live and "/ip arp find where mac-address=$m" in live)
rs = ld.report_script(BASE, KEY)
t("report: bound leases + ARP of LAN interfaces without a lease", 'lease find where status="bound"' in rs and 'list="LAN"' in rs and '[:typeof ($seen->$m)] = "nothing"' in rs)
t("report: sent in parts (a big list is not one string)", f"[:len $cur] > {ld.PART}" in rs and ":foreach p in=$parts" in rs and f"{BASE}/devices?key={KEY}" in rs)
own = ld.own_script()
t("ml-own: every single IP of a policy-* list or quarantine; old ones removed", 'list~"^policy-"' in own and 'list="ml-quarantine"' in own
  and "address-list remove $e" in own and "list=ml-own" in own)
t("ml-own: ranges (a network policy) are not 'own'", '[:find $a "/"]' in own and '[:find $a "-"]' in own)

# ---------------------------------------------------------------- live server
if "--live" in sys.argv:
    def sh(*cmd, inp=None):
        p = subprocess.run(list(cmd), input=inp, capture_output=True, text=True)
        return p.returncode, re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)

    def db(sql):
        return sh("mysql", "radius", "-N", "-e", sql)[1].strip()
    conf = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', open("/etc/mikrotiklover-radius/radius.conf").read(), re.M))
    port = conf.get("WEB_PORT", "8443")
    key = open("/var/lib/mikrotiklover/router/key").read().strip()
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

    def post(text, k=key):
        req = urllib.request.Request(f"https://127.0.0.1:{port}/api/public/router/devices?key={k}", data=text.encode(),
                                     headers={"Content-Type": "text/plain"}, method="POST")
        try:
            r = urllib.request.urlopen(req, context=ctx, timeout=30)
            return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, ""

    def live_rsc():
        return urllib.request.urlopen(f"https://127.0.0.1:{port}/api/public/router/live.rsc?key={key}", context=ctx, timeout=60).read().decode()
    M = [f"02:1D:EE:00:00:{i:02X}" for i in range(1, 7)]       # this test's devices
    POL = "whatsapp-only" if os.path.isfile("/var/lib/mikrotiklover/policies/whatsapp-only.txt") else \
        sorted(f[:-4] for f in os.listdir("/var/lib/mikrotiklover/policies") if f.endswith(".txt") and f != "README.txt")[0]

    def clean():
        db("DELETE FROM ml_lan_device WHERE mac LIKE '02:1D:EE:%'; DELETE FROM radacct WHERE acctsessionid LIKE 'ldt-%';"
           " DELETE FROM ml_quarantine WHERE reason='ldt test'")
        sh("radius-admin", "user", "del", "ldt-user")
    old_default = db("SELECT v FROM ml_setting WHERE k='lan_default_policy'")
    clean()
    sh("radius-admin", "devices", "default", "-")
    t("live: wrong key 403", post("x", "nope")[0] == 403)
    code, out = post(f"{M[0]}|10.66.0.1|ali-laptop|bridge|dhcp\n{M[1]}|10.66.0.2||ether3|arp\nbad|line\n")
    t("live: report -> 2 seen, 2 new", code == 200 and out.split() == ["2", "2"], out)
    t("live: stored with IP, router, interface, source, random flag",
      db(f"SELECT CONCAT(last_ip,'|',router,'|',iface,'|',src,'|',random_mac,'|',host) FROM ml_lan_device WHERE mac='{M[0]}'") == "10.66.0.1|127.0.0.1|bridge|dhcp|1|ali-laptop")
    rc, out = sh("radius-admin", "devices", "default", POL)
    post(f"{M[2]}|10.66.0.3|new-phone|bridge|dhcp\n{M[0]}|10.66.0.9||bridge|dhcp\n")
    t("live: default policy -> a NEW device gets it", db(f"SELECT CONCAT(policy,'/',policy_how) FROM ml_lan_device WHERE mac='{M[2]}'") == f"{POL}/default")
    t("live: ... a device seen before keeps none", db(f"SELECT policy FROM ml_lan_device WHERE mac='{M[0]}'") == "")
    t("live: IP changed -> last IP updated, host kept", db(f"SELECT CONCAT(last_ip,'|',host) FROM ml_lan_device WHERE mac='{M[0]}'") == "10.66.0.9|ali-laptop")
    sh("radius-admin", "devices", "default", "-")
    rc, out = sh("radius-admin", "devices", "name", M[0].lower().replace(":", "-"), "Ali laptop")
    t("live: name (any MAC format)", rc == 0 and db(f"SELECT name FROM ml_lan_device WHERE mac='{M[0]}'") == "Ali laptop", out)
    rc, out = sh("radius-admin", "devices", "name", M[0], 'bad"name')
    t("live: bad name refused", rc != 0, out)
    rc, out = sh("radius-admin", "devices", "policy", M[0], "no-such-policy")
    t("live: unknown policy refused", rc != 0 and "No policy" in out, out)
    rc, out = sh("radius-admin", "devices", "policy", "02:1d:ee:99:99:99", POL)
    t("live: unknown device refused", rc != 0 and "No device" in out, out)
    rc, out = sh("radius-admin", "devices", "policy", "not-a-mac", POL)
    t("live: bad MAC refused", rc != 0 and "Invalid MAC" in out, out)
    rc, out = sh("radius-admin", "devices", "policy", M[0], POL)
    t("live: policy for the device", rc == 0 and db(f"SELECT CONCAT(policy,'/',policy_how) FROM ml_lan_device WHERE mac='{M[0]}'") == f"{POL}/admin", out)
    lr = live_rsc()
    t("live: live.rsc carries the device MAC -> its list", f'"{M[0]}"="policy-{POL}"' in lr, lr[:300])
    t("live: live.rsc carries the report and ml-own parts", "/devices?key=" in lr and "list=ml-own" in lr)
    ok_, out = lint(lr)
    t("live: live.rsc lint ok, RouterOS 6 too", ok_ and v6ok(lr), out)
    # order on the server: a login with a policy on that MAC, then quarantine
    sh("radius-admin", "user", "add", "ldt-user", "-p", "Ldt#Pass-2026")
    sh("radius-admin", "user", "policy", "ldt-user", "guests")
    db(f"INSERT INTO radacct (acctsessionid, acctuniqueid, username, nasipaddress, framedipaddress, callingstationid, acctstarttime, acctupdatetime)"
       f" VALUES ('ldt-1','ldt-1','ldt-user','127.0.0.1','10.66.0.9','{M[0].replace(':', '-')}',NOW(),NOW())")
    t("live: order — a logged-in user's policy beats the device's", f'"{M[0]}"="policy-{POL}"' not in live_rsc())
    db("DELETE FROM radacct WHERE acctsessionid='ldt-1'")
    t("live: ... session gone -> the device's policy again", f'"{M[0]}"="policy-{POL}"' in live_rsc())
    db("INSERT INTO ml_quarantine (ip, username, reason, since, auto) VALUES ('10.66.0.9', '', 'ldt test', NOW(), '0')")
    t("live: order — quarantine beats the device's", f'"{M[0]}"="policy-{POL}"' not in live_rsc())
    db("DELETE FROM ml_quarantine WHERE reason='ldt test'")
    # network policy: polnet list + ml-own first
    rc, _ = sh("radius-admin", "policy", "net", "add", POL, "10.66.0.0/24", "ldt net")
    sync = open("/var/lib/mikrotiklover/router/sync.rsc").read()
    t("live: network policy -> polnet list, chain that lets ml-own go first",
      f"add list=polnet-{POL} address=10.66.0.0/24" in sync and f"chain=mlnet-{POL} src-address-list=ml-own action=return" in sync
      and f"chain=mlnet-{POL} action=jump jump-target=wfp-{POL}" in sync and f"list=policy-{POL} address=10.66.0.0/24" not in sync)
    ok_, out = lint(sync)
    t("live: sync.rsc lint ok", ok_, out)
    for nid in db(f"SELECT id FROM ml_policy_net WHERE comment='ldt net'").split():
        sh("radius-admin", "policy", "net", "del", nid)
    rc, out = sh("radius-admin", "devices", "list", "--json")
    t("live: devices list --json", rc == 0 and any(d["mac"] == M[0] for d in json.loads(out)), out[:200])
    # dashboard API (needs URL USER PASS)
    if os.environ.get("PASS"):
        url = os.environ.get("URL", f"https://127.0.0.1:{port}")
        jar = http.cookiejar.CookieJar()
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), urllib.request.HTTPSHandler(context=ctx))

        def call(method, path, data=None, csrf=""):
            req = urllib.request.Request(url + path, data=json.dumps(data).encode() if data is not None else None, method=method,
                                         headers={"Content-Type": "application/json", "X-CSRF-Token": csrf})
            try:
                r = op.open(req, timeout=60)
                return r.status, json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read() or b"{}")
        st, _ = call("GET", "/api/lan")
        t("api: needs login", st in (401, 403), st)
        st, me = call("POST", "/api/login", {"username": os.environ.get("USER", "admin"), "password": os.environ["PASS"]})
        csrf = me.get("csrf", "")
        st, d = call("GET", "/api/lan")
        row = next((x for x in d.get("devices", []) if x["mac"] == M[0]), {})
        t("api: list with name, policy, random MAC", st == 200 and row.get("name") == "Ali laptop" and row.get("policy") == POL and row.get("random_mac") is True, row)
        st, r = call("POST", "/api/lan/policy", {"mac": M[1], "policy": POL}, csrf)
        t("api: policy", st == 200 and db(f"SELECT policy FROM ml_lan_device WHERE mac='{M[1]}'") == POL, r)
        st, r = call("POST", "/api/lan/name", {"mac": M[1], "name": "NAS"}, csrf)
        t("api: name", st == 200 and db(f"SELECT name FROM ml_lan_device WHERE mac='{M[1]}'") == "NAS", r)
        st, r = call("POST", "/api/lan/name", {"mac": M[1], "name": "a<b"}, csrf)
        t("api: bad name 400", st == 400, r)
        st, r = call("POST", "/api/lan/policy", {"mac": "x;y", "policy": POL}, csrf)
        t("api: bad MAC 400", st == 400, r)
        st, r = call("POST", "/api/lan/default", {"policy": POL}, csrf)
        t("api: default policy", st == 200 and db("SELECT v FROM ml_setting WHERE k='lan_default_policy'") == POL, r)
        st, r = call("POST", "/api/lan/forget", {"mac": M[1]}, csrf)
        t("api: forget", st == 200 and db(f"SELECT COUNT(*) FROM ml_lan_device WHERE mac='{M[1]}'") == "0", r)
        st, r = call("POST", "/api/lan/policy", {"mac": M[0], "policy": POL})
        t("api: no CSRF -> refused", st in (403, 419), st)
    else:
        print("skip dashboard API part (set URL, USER, PASS)")
    rc, out = sh("radius-admin", "devices", "forget", M[0])
    t("live: forget", rc == 0 and db(f"SELECT COUNT(*) FROM ml_lan_device WHERE mac='{M[0]}'") == "0", out)
    clean()
    sh("radius-admin", "devices", "default", old_default or "-")
    sh("radius-admin", "policy", "build")

print("all devices tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
