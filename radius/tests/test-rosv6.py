#!/usr/bin/env python3
"""RouterOS 6 copies of the router files (tools/rosv6.py).
  python3 tests/test-rosv6.py            converter + every file in mikrotik/ (+ the server's sync6.rsc when there)
Every v6 copy must have no RouterOS-7-only line left and pass tests/lint-rsc.py.
"""
import glob, os, re, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import rosv6  # noqa: E402

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


# --- DNS names
t("regexp for a name and its sub-names, written for a RouterOS string", rosv6.dns_re("www.youtube.com") == r"(^|\\.)www\\.youtube\\.com\$")
t("  ... the RouterOS string gives the real regexp", rosv6.dns_re("a-b.com").replace("\\\\", "\\").replace("\\$", "$") == r"(^|\.)a-b\.com$")
t("  ... and it matches the name and sub-names only",
  all(bool(re.search(r"(^|\.)youtube\.com$", h)) == want for h, want in
      (("youtube.com", True), ("m.youtube.com", True), ("notyoutube.com", False), ("youtube.com.evil.net", False))))
try:
    rosv6.dns_re('x"; /system reset')
    t("a name with a quote refused (no script injection)", False)
except ValueError:
    t("a name with a quote refused (no script injection)", True)

v7 = """/ip dns static
remove [find comment="wf"]
add name=youtube.com type=NXDOMAIN match-subdomain=yes comment="wf"
add name=googlevideo.com match-subdomain=yes type=FWD forward-to=1.1.1.1 comment="wf"
:do { add name=whatsapp.net match-subdomain=yes type=FWD forward-to=$up address-list=mlname-wa address-list-timeout=1d comment="wfpolicy:dns whatsapp.net" } on-error={}
add name=router.lan address=10.0.0.1
"""
ips = {"whatsapp.net": ["157.240.1.53", "157.240.1.60", "10.0.0.9", "2a03:2880::1", "bad"]}
v6 = rosv6.convert(v7, lambda n: ips.get(n, []))
t("blocked name -> regexp + NXDOMAIN (RouterOS 6.49 refuses address=0.0.0.0)", 'add type=NXDOMAIN regexp="(^|\\\\.)youtube\\\\.com\\$" comment="wf"' in v6 and "0.0.0.0" not in v6, v6)
t("forwarded name -> regexp, forward kept", 'add regexp="(^|\\\\.)googlevideo\\\\.com\\$" type=FWD forward-to=1.1.1.1 comment="wf"' in v6, v6)
t("name -> address list: the server puts in the public IPv4 addresses it saw",
  v6.count("address-list add list=mlname-wa address=157.240.1.") == 2 and "10.0.0.9" not in v6 and "2a03" not in v6, v6)
t("  ... the old ones taken out first, own comment", 'remove [find list="mlname-wa" comment="wfpolicy:dns whatsapp.net (v6)"]' in v6)
t("plain lines untouched", "add name=router.lan address=10.0.0.1" in v6 and 'remove [find comment="wf"]' in v6)
t("nothing RouterOS-7-only left", not rosv6.check(v6), rosv6.check(v6))

v7 = """/ip dns adlist
add url=https://example.com/hosts ssl-verify=no comment="ad"
/interface wifi security
add name=s passphrase="x"
/ipv6 firewall filter
remove [find comment~"^wf"]
add chain=forward protocol=udp dst-port=53 action=drop comment="wf: v6 \\"dns\\""
:foreach a in={"2606:4700::1"} do={ add list=doh address=$a }

/ip firewall filter
add chain=forward action=accept
:if ([:len [/certificate find where name~"ca"]] = 0) do={ /certificate import file-name=ca.pem passphrase="" name=ca }
"""
v6 = rosv6.convert(v7)
t("adlist and RouterOS 7 Wi-Fi left out", "add url=" not in v6 and 'passphrase="x"' not in v6 and "RouterOS 7 only" in v6, v6)
t("IPv6 part runs only with the ipv6 package (else the menu does not exist)",
  ':if ([:len [/system package find where name="ipv6" disabled=no]] > 0) do={' in v6 and "\n/ipv6" not in v6, v6)
t("  ... its text kept whole: quotes and $ escaped", '\\$a' in v6 and 'v6 \\\\\\"dns\\\\\\"' in v6, v6)
t("after the IPv6 part the IPv4 rules are normal again", "/ip firewall filter\nadd chain=forward action=accept" in v6)
t("certificate import without name=", 'passphrase="" }' in v6 and " name=ca" not in v6)
t("nothing RouterOS-7-only left", not rosv6.check(v6), rosv6.check(v6))
t("check finds the RouterOS 7 lines in the original", {w for _, w in rosv6.check(v7)} >= {
    "/ip dns adlist (RouterOS 7.15+)", "/interface wifi (RouterOS 7 Wi-Fi)", "certificate import name= (RouterOS 7)"})
t("check: file-name= is not name=", not rosv6.check('/certificate import file-name=a.pem passphrase=""'))
t("check: slash paths and RouterOS 7 commands", len(rosv6.check(":put [/ip/address/print]\n:onerror e in={ :put 1 } do={}")) == 2)

# --- every router file the server hands out
for f in sorted(glob.glob(os.path.join(MK, "*.rsc"))):
    c6 = rosv6.convert(open(f, encoding="utf-8").read())
    bad = rosv6.check(c6)
    ok, out = lint(c6)
    t(f"v6 copy of {os.path.basename(f)}: nothing RouterOS-7-only, lint ok", not bad and ok, (bad[:3], out[-300:]))

S6 = "/var/lib/mikrotiklover/router/sync6.rsc"
if os.path.exists(S6) and os.access(S6, os.R_OK):
    text = open(S6, encoding="utf-8").read()
    ok, out = lint(text)
    t("server's sync6.rsc: nothing RouterOS-7-only, lint ok", not rosv6.check(text) and ok, (rosv6.check(text)[:3], out[-300:]))
    v = open("/var/lib/mikrotiklover/router/version6", encoding="utf-8").read().strip()
    t("  ... with its own version", len(v) == 16 and v != open("/var/lib/mikrotiklover/router/version", encoding="utf-8").read().strip())
else:
    print("skip: no sync6.rsc on this machine (radius-admin policy build)")

print("all RouterOS 6 tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
