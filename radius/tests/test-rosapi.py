#!/usr/bin/env python3
"""RouterOS API client (tools/rosapi.py) against a small fake RouterOS API server (tests/fakeros.py)."""
import json, os, subprocess, sys, tempfile, time
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
d = tempfile.mkdtemp()
os.environ["ML_ROUTER_API"] = os.path.join(d, "routers.json")
import rosapi  # noqa: E402

fails = 0


def check(desc, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + desc)
    if not cond:
        print("     got:", got)
        fails += 1


def lens(n):
    b = rosapi.enc_len(n)
    it = iter([b[i:i + 1] for i in range(len(b))])
    return rosapi.dec_len(lambda k: b"".join(next(it) for _ in range(k)))


check("word lengths: every size class round trips", all(lens(n) == n for n in (0, 1, 0x7F, 0x80, 0x3FFF, 0x4000, 0x1FFFFF, 0x200000, 0xFFFFFFF, 0x10000000)))
check("sentence ends with an empty word", rosapi.sentence(["/login", "=name=x"]) == b"\x06/login\x07=name=x\x00")


def fake(port, pw, plain=False):
    p = subprocess.Popen([sys.executable, os.path.join(HERE, "fakeros.py"), str(port), "mlapi", pw, os.path.join(d, f"s{port}.json")] + (["--plain"] if plain else []),
                         stdout=subprocess.PIPE, text=True)
    p.stdout.readline()
    return p


state = lambda port: json.load(open(os.path.join(d, f"s{port}.json")))  # noqa: E731
r1 = fake(28729, "pw-one")
try:
    rosapi.save({"127.0.0.1": {"port": 28729, "user": "mlapi", "password": "pw-one", "plain": False, "fingerprint": ""}})
    t0 = time.time()
    res = rosapi.push_block("45.155.205.233", 86400, 'RDP "guessing" ; /system reset')
    took = time.time() - t0
    check("block: in the router's ml-ips list with time limit, in well under a second", res == {"127.0.0.1": "ok"} and took < 1.0
          and [(i["list"], i["address"], i["timeout"]) for i in state(28729)] == [("ml-ips", "45.155.205.233", "86400s")], (res, took))
    check("  ... unsafe characters taken out of the comment", state(28729)[0]["comment"] == "mlips: RDP guessing  /system reset")
    check("certificate remembered on the first connection; status ok", len(rosapi.load()["127.0.0.1"]["fingerprint"]) == 64 and rosapi.load()["127.0.0.1"]["status"] == "ok")
    check("blocking again: 'already have such entry' is fine", rosapi.push_block("45.155.205.233", 60, "x") == {"127.0.0.1": "ok"} and len(state(28729)) == 1)
    check("unblock removes it", rosapi.push_unblock("45.155.205.233") == {"127.0.0.1": "ok (1 removed)"} and state(28729) == [])
    r = dict(rosapi.load()["127.0.0.1"], password="wrong")
    res = rosapi.push_block("1.2.3.4", 60, "x", {"127.0.0.1": r})
    check("wrong password: refused, said why", "login refused" in res["127.0.0.1"], res)
finally:
    r1.kill()
r2 = fake(28729, "pw-one")                      # same router address, a new certificate (someone in the middle?)
try:
    res = rosapi.push_block("1.2.3.4", 60, "x")
    check("changed certificate: refused, status failed", "certificate changed" in res["127.0.0.1"] and rosapi.load()["127.0.0.1"]["status"].startswith("failed"), res)
    rosapi.main(["forget-cert", "127.0.0.1"])
    check("  ... after forget-cert it works again", rosapi.push_block("1.2.3.4", 60, "x") == {"127.0.0.1": "ok"})
finally:
    r2.kill()
r3 = fake(28728, "pw-two", plain=True)
try:
    res = rosapi.push_block("5.6.7.8", 60, "x", {"127.0.0.1": {"port": 28728, "user": "mlapi", "password": "pw-two", "plain": True}})
    check("plain API (8728) works too", res == {"127.0.0.1": "ok"} and state(28728)[0]["address"] == "5.6.7.8", res)
finally:
    r3.kill()
t0 = time.time()
res = rosapi.push_block("9.9.9.9", 60, "x", {"127.0.0.1": {"port": 28799, "user": "mlapi", "password": "x"}})
check("router not answering: error at once (no hang)", "refused" in res["127.0.0.1"].lower() and time.time() - t0 < 6, res)

script = rosapi.router_script("192.168.88.10", "mlapi", "Abc123", 8729)
check("router script: API-only user from the server only, api-ssl with a certificate only for the server",
      "policy=api,read,write" in script and "address=192.168.88.10/32 password=\"Abc123\"" in script
      and "/ip service set api-ssl certificate=ml-api port=8729 address=192.168.88.10/32 disabled=no" in script)
f = os.path.join(d, "api.rsc")
open(f, "w").write(script)
lint = subprocess.run([sys.executable, os.path.join(HERE, "lint-rsc.py"), f], capture_output=True, text=True).stdout
check("router script passes the RouterOS lint", lint.startswith("ok"), lint)
check("password file is root-only (0600)", oct(os.stat(os.environ["ML_ROUTER_API"]).st_mode & 0o777) == "0o600")
print("all router API tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
