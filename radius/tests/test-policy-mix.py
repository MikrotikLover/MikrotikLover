#!/usr/bin/env python3
"""Several policies for one user (joined into one: mix-…).

  python3 tests/test-policy-mix.py          joining rules (no server needed)
  sudo python3 tests/test-policy-mix.py --live   + radius-admin user policy a,b / policy give a,b, the mix file,
                                                router rules, edits / off / delete of a policy, dashboard API
"""
import json, os, re, ssl, subprocess, sys, tempfile, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import policymix as pm  # noqa: E402

fails = 0


def t(name, cond, info=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f": {str(info)[:500]}"))
    fails += 0 if cond else 1


# ---------------------------------------------------------------- joining
t("members: commas, spaces, + ; no repeats; order kept", pm.members_of("students, no-video+students") == ["students", "no-video"])
for bad in ("Students", "a;b", "mix-x", "x" * 41):
    try:
        pm.members_of(bad); t(f"bad name refused: {bad}", False)
    except ValueError:
        t(f"bad name refused: {bad}", True)
t("same set, any order -> same mix name", pm.mix_name(["a", "b"]) == pm.mix_name(["b", "a"]) and re.match(r"^mix-[0-9a-f]{10}$", pm.mix_name(["a", "b"])))
t("other set -> other name", pm.mix_name(["a", "b"]) != pm.mix_name(["a", "c"]))
A = "# Students\nblock social\nblock gaming time=21h-7h,mon\nallow-site linkedin.com\ndns family\n"
B = "# No video\nblock social-video\nblock social\nallow-app WhatsApp\ndns cleanbrowsing-family\nstrict-ech\n"
C = "# Guests\nblock torrent-piracy   # comment\ndns router\nallow-only whatsapp\n"
m = pm.merge({"a": A, "b": B, "c": C}, ["a", "b", "c"])
lines = m.splitlines()
t("header: names + descriptions, members line", lines[0].startswith("# a + b + c (joined: Students; No video; Guests") and lines[1] == "# mix: a,b,c", m)
t("every block of each, with its time", all(x in lines for x in ("block social", "block gaming time=21h-7h,mon", "block social-video", "block torrent-piracy")), m)
t("a line twice only once", lines.count("block social") == 1, m)
t("exceptions of any policy", all(x in lines for x in ("allow-site linkedin.com", "allow-app WhatsApp", "allow-only whatsapp")), m)
t("dns: the strictest one, once", [x for x in lines if x.startswith("dns")] == ["dns cleanbrowsing-family"], m)
t("strict-ech when any has it", "strict-ech" in lines)
t("comments after a rule dropped", not any("comment" in x for x in lines[2:]), m)
t("no dns line when all use the router", "dns" not in pm.merge({"a": "# x\nblock social\n"}, ["a"]))
t("a missing / turned-off policy is left out", pm.merge({"a": A}, ["a", "gone"]).splitlines()[2:] == pm.merge({"a": A}, ["a"]).splitlines()[2:])

with tempfile.TemporaryDirectory() as d:
    open(os.path.join(d, "a.txt"), "w").write(A); open(os.path.join(d, "b.txt"), "w").write(B)
    n = pm.write(d, ["a", "b"])
    t("write: mix/<name>.txt", os.path.isfile(os.path.join(d, "mix", n + ".txt")))
    t("members read back", pm.members(d, n) == ["a", "b"])
    open(os.path.join(d, ".off"), "w").write("b\n")
    pm.regen(d, {n})
    t("regen: a turned-off policy leaves the mix", "block social-video" not in open(os.path.join(d, "mix", n + ".txt")).read())
    open(os.path.join(d, ".off"), "w").write("")
    open(os.path.join(d, "a.txt"), "w").write(A + "block-site example.com\n")
    pm.regen(d, {n})
    t("regen: an edit of a policy reaches the mix", "block-site example.com" in open(os.path.join(d, "mix", n + ".txt")).read())
    pm.regen(d, set())
    t("regen: an unused mix is removed", not os.path.exists(os.path.join(d, "mix", n + ".txt")))

# ---------------------------------------------------------------- build.sh: the mix gets router rules like any policy
WF = os.path.join(HERE, "..", "webfilter")
with tempfile.TemporaryDirectory() as d:
    pdir, out = os.path.join(d, "pol"), os.path.join(d, "out")
    os.makedirs(pdir); os.makedirs(out)
    for f in ("students", "no-video"):
        open(os.path.join(pdir, f + ".txt"), "w").write(open(os.path.join(WF, "policies", f + ".txt")).read())
    n = pm.write(pdir, ["students", "no-video"])
    p = subprocess.run(["bash", "./build.sh"], cwd=WF, capture_output=True, text=True,
                       env={**os.environ, "WF_OUT": out, "POLICY_DIR": pdir, "CDNMAP": os.path.join(HERE, "..", "tools", "cdnmap.py")})
    rsc = open(os.path.join(out, "webfilter-policies.rsc")).read() if p.returncode == 0 else p.stderr
    t("build: router rules for the joined policy's list", f"src-address-list=policy-{n}" in rsc, rsc[-400:])
    t("build: the parts keep their own rules too", "src-address-list=policy-students" in rsc and "src-address-list=policy-no-video" in rsc)

# ---------------------------------------------------------------- live server
if "--live" in sys.argv:
    def sh(*cmd, inp=None):
        p = subprocess.run(list(cmd), input=inp, capture_output=True, text=True)
        return p.returncode, re.sub(r"\x1b\[[0-9;]*m", "", p.stdout + p.stderr)

    def own(u):
        return sh("mysql", "radius", "-N", "-e", f"SELECT IFNULL((SELECT value FROM radreply WHERE username='{u}' AND attribute='Mikrotik-Address-List'),'-')")[1].strip()
    PD, RD = "/var/lib/mikrotiklover/policies", "/var/lib/mikrotiklover/router"
    for u in ("pmx1", "pmx2", "pmx3"):
        sh("radius-admin", "user", "del", u); sh("radius-admin", "user", "add", u, "-p", "Pm#Test-2026")
    rc, out = sh("radius-admin", "user", "policy", "pmx1", "students,no-video")
    v = own("pmx1")
    t("live: user policy a,b -> a joined policy", rc == 0 and v.startswith("policy-mix-") and "students + no-video" in out, out)
    t("live: its file exists", os.path.isfile(f"{PD}/mix/{v[7:]}.txt"))
    t("live: the routers' rules have it", f"src-address-list={v}" in open(f"{RD}/sync.rsc").read())
    rc, out = sh("radius-admin", "policy", "give", "no-video,students", "pmx2", "pmx3")
    t("live: policy give a,b (other order) -> the same joined policy", rc == 0 and own("pmx2") == v and own("pmx3") == v, out)
    rc, out = sh("radius-admin", "user", "policy", "pmx3", "students,nope-policy")
    t("live: an unknown policy in the list refused, nothing changed", rc != 0 and own("pmx3") == v, out)
    rc, out = sh("radius-admin", "user", "policy", "pmx3", "students")
    t("live: back to one policy", own("pmx3") == "policy-students", out)
    rc, out = sh("radius-admin", "policy", "mixes")
    t("live: policy mixes lists it with 2 users", re.search(rf"{v[7:]}\s+(students \+ no-video|no-video \+ students)\s+2 user", out) is not None, out)
    # the dashboard
    conf = dict(re.findall(r'^([A-Z_]+)="?([^"\n]*)"?$', open("/etc/mikrotiklover-radius/radius.conf").read(), re.M))
    t("live: why-blocked reads the joined policy", sh("python3", "-I", "/usr/local/lib/mikrotiklover/whyblocked.py", "youtube.com", "--policy", v[7:])[0] == 0)
    for u in ("pmx1", "pmx2", "pmx3"):
        sh("radius-admin", "user", "del", u)
    sh("radius-admin", "policy", "build")
    t("live: users gone -> the joined policy is removed at the next build", not os.path.exists(f"{PD}/mix/{v[7:]}.txt"))

print("all policy mix tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
