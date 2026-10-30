#!/usr/bin/env python3
"""New device approval tests.

  python3 tests/test-newdev.py           router part + reports + answer script (no server needed)
  sudo python3 tests/test-newdev.py --live   + on an installed server: radius-admin newdev, the router endpoint
                                           (pending / learning / approve / deny / per router / IP moved), the waiting page

The router itself (DHCP lease-script, minute check, firewall) is tested on RouterOS by tests/test-chr.sh.
"""
import json, os, re, ssl, subprocess, sys, tempfile, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import newdev as nd  # noqa: E402
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


def err(fn, *a, **k):
    try:
        fn(*a, **k)
        return ""
    except ValueError as e:
        return str(e)


# ---------------------------------------------------------------- MACs and reports
t("MAC formats -> AA-BB-...", [nd.norm_mac(m) for m in ("aa:bb:cc:dd:ee:ff", "AABB.CCDD.EEFF", "aabbccddeeff", "AA-BB-CC-DD-EE-FF")]
  == ["AA-BB-CC-DD-EE-FF"] * 4)
t("not a MAC", nd.norm_mac("aa:bb:cc:dd:ee") is None and nd.norm_mac("x") is None and nd.norm_mac("") is None)
rep = nd.parse_report("AA:BB:CC:00:00:01|192.168.88.50|Ali's Phone<script>\n"
                      "aa:bb:cc:00:00:01|192.168.88.99|again\n"         # same MAC twice: first wins
                      "02:11:22:33:44:55|192.168.88.51|\n"
                      "bad|192.168.88.1|x\n02:11:22:33:44:56|300.1.1.1|x\n-\n\n02:11:22:33:44:57|10.0.0.9")
t("report: good lines, one per MAC, bad ones skipped",
  rep == [("AA-BB-CC-00-00-01", "192.168.88.50", "Alis Phonescript"), ("02-11-22-33-44-55", "192.168.88.51", ""),
          ("02-11-22-33-44-57", "10.0.0.9", "")], rep)
t("report: at most 4000 lines read", len(nd.parse_report("\n".join(f"02:00:00:00:{i // 256:02x}:{i % 256:02x}|10.0.{i // 250}.{i % 250 + 1}|"
                                                              for i in range(5000)))) == 4000)
t("host name: no quotes or $ (shown on the dashboard)", nd.clean_host('a"b$c\\d') == "abcd")

# ---------------------------------------------------------------- the answer: address list = exactly these IPs
r = nd.reconcile(["192.168.88.51", "192.168.88.50", "192.168.88.50", "bad", "1.2.3.400"])
t("answer: keep list, sorted, no duplicates / bad IPs", ':local keep {"192.168.88.50";"192.168.88.51"}' in r, r)
t("answer: removes what is not waiting, adds what is", "remove $i" in r and "add list=ml-newdev address=$a" in r, r)
t("answer: nothing waiting -> empty list (all removed)", ':local keep [:toarray ""]' in nd.reconcile([]))
t("answer: count for the router", ":global mlNdCount 2" in r)

# ---------------------------------------------------------------- the router part (sync.rsc)
BASE, KEY = "https://radius.example.lan:8443/api/public/router", "A" * 32
on = nd.router_part(True, BASE, KEY, "10.10.10.10")
t("router part: lint ok", lint(on)[0], lint(on)[1])
t("router part: script, scheduler every minute, lease-script", '/system script add name=ml-newdev' in on
  and "add name=ml-newdev interval=1m" in on and "lease-script=$ls" in on, on)
t("router part: asks the server over https with its certificate", f'"$base/newdev?key=$key"' in on and f':local base "{BASE}"' in on
  and "check-certificate=yes-without-crl" in on)
t("router part: hotspot DHCP servers left out", "/ip hotspot find where interface=" in on and ":if ($hs = 0)" in on)
t("router part: an admin's own lease-script is kept (warning)", "has its own lease-script" in on and '[:len $cur] = 0' in on)
t("router part: waiting devices: DNS + the server, the rest rejected", 'dst-address=10.10.10.10 action=accept comment="mlnewdev: server' in on
  and "dst-port=53 action=accept" in on and 'action=reject reject-with=tcp-reset comment="mlnewdev: block"' in on)
t("router part: http:// -> the waiting page on the server", "to-addresses=10.10.10.10 to-ports=8081" in on)
t("router part: rules above every other rule, safely", 'find where !(comment~"^mlnewdev")' in on and "destination=0" not in on)
t("router part: old rules removed first (import again = update)", on.index('remove [find comment~"^mlnewdev"]') < on.index("mlnewdev: dns"))
t("router part: not strict by default", ":local strict no" in on)
t("router part: strict", ":local strict yes" in nd.router_part(True, BASE, KEY, "10.10.10.10", strict=True))
no_srv = nd.router_part(True, BASE, KEY, "")
t("router part: no server IP -> no waiting page, still blocked", "to-ports=8081" not in no_srv and "mlnewdev: block" in no_srv)
t("router part: needs auto-sync address + key", "auto-sync" in err(nd.router_part, True, "http://x", KEY) and err(nd.router_part, True, BASE, "short"))
t("router part: bad server IP refused", err(nd.router_part, True, BASE, KEY, "10.1"))
off = nd.router_part(False)
t("router part off: everything out, own lease-script back to empty only when ours", lint(off)[0]
  and 'lease-script~"mlNdOne"' in off and 'remove [find comment~"^mlnewdev"]' in off and "remove [find list=ml-newdev]" in off, off)
v6 = rosv6.convert(on)
t("router part: RouterOS 6 copy has nothing 7-only", subprocess.run([sys.executable, os.path.join(HERE, "..", "tools", "rosv6.py"), "check", "/dev/stdin"],
                                                                      input=v6, capture_output=True, text=True).returncode == 0)

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
        req = urllib.request.Request(f"https://127.0.0.1:{port}/api/public/router/newdev?key={k}", data=text.encode(),
                                     headers={"Content-Type": "text/plain"}, method="POST")
        try:
            r = urllib.request.urlopen(req, context=ctx, timeout=30)
            return r.status, r.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, ""

    def keep(answer):
        m = re.search(r":local keep \{([^}]*)\}", answer)
        return sorted(ip for ip in re.findall(r'"([^"]+)"', m.group(1)) if ip.startswith("10.77.")) if m else []   # this test's devices only
    T = ["02:7E:57:00:00:0%d" % i for i in range(1, 6)]
    TM = [nd.norm_mac(m) for m in T]
    old = json.loads(sh("radius-admin", "newdev", "json")[1] or "{}")
    db("DELETE FROM ml_newdev WHERE mac LIKE '02-7E-57-%'")
    sh("radius-admin", "newdev", "off")
    code, ans = post(f"{T[0]}|10.77.0.1|x\n")
    t("live: off -> answer empties the list, nothing recorded", code == 200 and keep(ans) == [] and db(f"SELECT COUNT(*) FROM ml_newdev WHERE mac='{TM[0]}'") == "0", ans)
    t("live: wrong key 403", post("x", "wrong-key")[0] == 403)
    rc, out = sh("radius-admin", "newdev", "on", "--learn", "0")
    t("live: on", rc == 0 and "approval" in out, out)
    code, ans = post(f"{T[0]}|10.77.0.1|ali-phone\n{T[1]}|10.77.0.2|laptop\nbad line\n")
    t("live: new devices wait (answer lists their IPs)", keep(ans) == ["10.77.0.1", "10.77.0.2"], ans)
    t("live: recorded as pending with host and router", db(f"SELECT CONCAT(status,'/',host,'/',router) FROM ml_newdev WHERE mac='{TM[0]}'") == "pending/ali-phone/127.0.0.1")
    rc, out = sh("radius-admin", "newdev", "approve", T[0].lower(), "-n", "Ali's phone")
    t("live: approve (any MAC format) with a name", rc == 0 and db(f"SELECT CONCAT(status,'/',name) FROM ml_newdev WHERE mac='{TM[0]}'") == "approved/Ali's phone", out)
    code, ans = post("-\n")
    t("live: minute check without leases still answers the router's list", keep(ans) == ["10.77.0.2"], ans)
    sh("radius-admin", "newdev", "deny", T[1])
    t("live: denied stays in the list", keep(post("-\n")[1]) == ["10.77.0.2"])
    code, ans = post(f"{T[2]}|10.77.0.2|took-the-ip\n")
    t("live: IP given to another device -> old holder's IP cleared, new one waits", keep(ans) == ["10.77.0.2"]
      and db(f"SELECT ip FROM ml_newdev WHERE mac='{TM[1]}'") == "", ans)
    sh("radius-admin", "newdev", "approve", T[2])
    t("live: list empty once approved", keep(post("-\n")[1]) == [])
    db(f"UPDATE ml_newdev SET router='10.99.99.99' WHERE mac='{TM[1]}'")
    db(f"UPDATE ml_newdev SET ip='10.77.0.5' WHERE mac='{TM[1]}'")
    t("live: another router's waiting devices are not in this router's list", keep(post("-\n")[1]) == [])
    rc, out = sh("radius-admin", "newdev", "add", T[3], "-n", "New printer")
    code, ans = post(f"{T[3]}|10.77.0.4|printer\n")
    t("live: allowed before it came -> no wait", keep(ans) == [] and db(f"SELECT CONCAT(status,'/',how,'/',name) FROM ml_newdev WHERE mac='{TM[3]}'") == "approved/added/New printer", ans)
    sh("radius-admin", "newdev", "learn", "1")
    code, ans = post(f"{T[4]}|10.77.0.6|while-learning\n")
    t("live: while learning a new device is approved by itself", keep(ans) == []
      and db(f"SELECT CONCAT(status,'/',how) FROM ml_newdev WHERE mac='{TM[4]}'") == "approved/learned", ans)
    sh("radius-admin", "newdev", "learn", "0")
    rc, out = sh("radius-admin", "newdev", "approve", "02:7e:57:99:99:99")
    t("live: approve an unknown MAC refused with a hint", rc != 0 and "newdev add" in out, out)
    rc, out = sh("radius-admin", "newdev", "approve", "nonsense")
    t("live: bad MAC refused", rc != 0 and "Invalid MAC" in out, out)
    rc, out = sh("radius-admin", "newdev", "approve", T[0], "-u", "no-such-user-x")
    t("live: approve for an unknown user refused", rc != 0 and "No such user" in out, out)
    rc, out = sh("radius-admin", "newdev", "list", "pending", "--json")
    t("live: list --json", rc == 0 and isinstance(json.loads(out), list), out)
    rc, out = sh("radius-admin", "newdev", "status")
    t("live: status", rc == 0 and "on" in out.splitlines()[0], out)
    # waiting page: this machine's own IP as a waiting device
    db(f"UPDATE ml_newdev SET status='pending', ip='127.0.0.1', router='x', last_seen=NOW() WHERE mac='{TM[0]}'")
    page = urllib.request.urlopen("http://127.0.0.1:8081/any/site", timeout=20).read().decode()
    t("live: http:// of a waiting device -> the waiting page", "manzoori" in page and TM[0] in page, page[:300])
    db(f"UPDATE ml_newdev SET status='denied' WHERE mac='{TM[0]}'")
    page = urllib.request.urlopen("http://127.0.0.1:8081/", timeout=20).read().decode()
    t("live: denied device -> 'not allowed' page", "ijazat nahi" in page, page[:300])
    sh("radius-admin", "newdev", "forget", T[0])
    t("live: forget", db(f"SELECT COUNT(*) FROM ml_newdev WHERE mac='{TM[0]}'") == "0")
    rc, out = sh("radius-admin", "policy", "build")
    sync = open("/var/lib/mikrotiklover/router/sync.rsc").read()
    t("live: sync.rsc carries the router part (on)", rc == 0 and "/system script add name=ml-newdev" in sync, out)
    sh("radius-admin", "newdev", "off")
    sync = open("/var/lib/mikrotiklover/router/sync.rsc").read()
    t("live: off -> sync.rsc takes it out", "approval: off" in sync and "/system script add name=ml-newdev" not in sync)
    db("DELETE FROM ml_newdev WHERE mac LIKE '02-7E-57-%'")
    if old.get("on"):                      # back as it was
        sh("radius-admin", "newdev", "on", "--learn", "0")
        sh("radius-admin", "newdev", "strict", "on" if old.get("strict") else "off")

print("all new device tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
