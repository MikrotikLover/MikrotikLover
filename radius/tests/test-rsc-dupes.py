#!/usr/bin/env python3
"""Hand-imported router files side by side: an entry two files both add (same DNS name, same address-list entry) must
be wrapped in ':do { … } on-error={}' in both, or RouterOS stops the second /import at "already have such entry".
Also: a DNS name added by two files must fill the same address list (RouterOS keeps only one entry per name).
   python3 tests/test-rsc-dupes.py"""
import glob
import itertools
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MK = os.path.join(HERE, "..", "mikrotik")
fails = 0


def t(name, got, want):
    global fails
    if got == want:
        print(f"ok   {name}")
    else:
        print(f"FAIL {name}: got {got!r} expected {want!r}")
        fails += 1


def entries(path):
    """-> {key: (guarded, address list, line)} for every DNS static / address-list add the file makes; an entry whose
    comment the same file removed just before counts as guarded too (re-adding its own copy, never a second one)"""
    out, menu, removed = {}, "", set()
    for raw in open(path, encoding="utf-8"):
        line = raw.strip()
        rm = re.match(r'remove \[find comment="([^"]+)"\]$', line)
        if rm:
            removed.add(rm.group(1))
        if line.startswith("/") and " add " not in line:
            menu = line
        cm = re.search(r'comment="([^"]+)"', line)
        guarded = (line.startswith(":do {") and "on-error=" in line) or bool(cm and cm.group(1) in removed)
        m = re.search(r"(/ip dns static |/ip firewall address-list )?add (.*?)(?: \} on-error=.*)?$", line)
        if not m or not (line.startswith("add ") or "add " in line and guarded):
            continue
        where = (m.group(1) or menu).strip()
        args = m.group(2)
        if where.startswith("/ip dns static"):
            k = re.search(r'\b(name|regexp)=("[^"]*"|\S+)', args)
            if k:
                al = re.search(r"\baddress-list=(\S+)", args)
                out[("dns", k.group(2))] = (guarded, al.group(1) if al else "", line)
        elif where.startswith("/ip firewall address-list"):
            lst, adr = re.search(r"\blist=(\S+)", args), re.search(r"\baddress=(\S+)", args)
            if lst and adr:
                out[("list", lst.group(1) + " " + adr.group(1))] = (guarded, "", line)
    return out


files = sorted(glob.glob(os.path.join(MK, "webfilter-*.rsc")) + glob.glob(os.path.join(MK, "allow-only-*.rsc")))
data = {os.path.basename(f): entries(f) for f in files}
t("router files read (web filter categories, policies, allow-only)", len(data) >= 10 and sum(len(v) for v in data.values()) > 300, True)

shared, unguarded, lists = 0, [], []
for a, b in itertools.combinations(sorted(data), 2):
    for k in set(data[a]) & set(data[b]):
        shared += 1
        same_comment = re.search(r'comment="[^"]+"', data[a][k][2]) and \
            re.search(r'comment="[^"]+"', data[a][k][2]).group(0) == (re.search(r'comment="[^"]+"', data[b][k][2]) or [None])[0]
        for f in (a, b):
            if not data[f][k][0] or (not same_comment and not data[f][k][2].startswith(":do {")):
                unguarded.append(f"{f}: {k[1]}")
        if k[0] == "dns" and data[a][k][1] != data[b][k][1]:
            lists.append(f"{k[1]}: {a} -> {data[a][k][1]}, {b} -> {data[b][k][1]}")
t("entries two files both add were found (social / social-video, policies / allow-only …)", shared > 5, True)
t("every one of them is skipped when already there (:do … on-error), so no /import stops", unguarded[:5], [])
t("a DNS name two files add fills the same address list in both", lists[:5], [])

# the known pairs, by name
t("  ... tiktok.com is in social and social-video, both guarded", all(data[f][("dns", "tiktok.com")][0] for f in ("webfilter-social.rsc", "webfilter-social-video.rsc")), True)
t("  ... googlevideo.com is in social-video and video-streaming, both guarded", all(data[f][("dns", "googlevideo.com")][0] for f in ("webfilter-social-video.rsc", "webfilter-video-streaming.rsc")), True)
hk = [k for k in data["allow-only-hikconnect.rsc"] if k[0] == "dns"]
t("  ... allow-only Hik-Connect names fill mlname-NAME like the policies file", sorted(data["allow-only-hikconnect.rsc"][k][1] for k in hk), sorted("mlname-" + k[1] for k in hk))
rules = open(os.path.join(MK, "allow-only-hikconnect.rsc")).read()
t("  ... and its rules accept those lists", all(f"dst-address-list=mlname-{k[1]} action=accept" in rules for k in hk), True)

# the RouterOS 6 copies keep the guard (the converter rewrites inside the line)
sys.path.insert(0, os.path.join(HERE, "..", "tools"))
import rosv6  # noqa: E402
v6 = rosv6.convert(open(os.path.join(MK, "webfilter-social.rsc")).read())
t("RouterOS 6 copy: still one guarded line per name, as a regexp", ':do { /ip dns static add type=NXDOMAIN comment="webfilter:social" regexp="(^|\\\\.)facebook\\\\.com\\$" } on-error={}' in v6 or
  re.search(r':do \{ /ip dns static add .*regexp="\(\^\|\\\\\.\)facebook\\\\\.com\\\$".* \} on-error=\{\}', v6) is not None, True)
t("  ... and nothing RouterOS-7-only left", rosv6.check(v6), [])

# the generator itself makes these files (an edit to build.sh cannot quietly undo it)
src = open(os.path.join(HERE, "..", "webfilter", "build.sh")).read()
t("build.sh writes the guarded lines", src.count("} on-error={}") >= 3, True)
r = subprocess.run([sys.executable, os.path.join(HERE, "lint-rsc.py")] + files, capture_output=True, text=True)
t("RouterOS lint passes on every file", r.returncode, 0)
print("all duplicate-entry tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
