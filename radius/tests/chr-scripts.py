#!/usr/bin/env python3
"""Makes the scripts tests/test-chr.sh imports on a CHR (MikroTik Cloud Hosted Router), in import order.

  chr-scripts.py OUT-DIR --ros 7|6 [--sync FILE]

Writes NN-name.rsc files (and list.txt: file, strict 0/1) into OUT-DIR:
  - every mikrotik/*.rsc with its placeholders filled (RouterOS 6: the v6 copy, as the server makes it);
  - what the dashboard's Router setup makes (routersetup.build) for several sets of parts;
  - Passpoint with real settings (passpoint.router), RouterOS 7 'wifi' and old 'wireless';
  - the server's sync.rsc when one is given.
strict=1: must also import a second time (scripts made to be imported again: Router setup, Passpoint).
"""
import argparse, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import newdev, passpoint, routersetup, rosv6  # noqa: E402

SERVER, SECRET, COMMUNITY = "10.0.2.2", "ChrTest#Secret1", "chrtestcommunity42"
# by-hand files: import order (a base before what builds on it); not listed = after these, by name
ORDER = ["webfilter-base.rsc", "hotspot.rsc", "wpa-enterprise-wifi-ros7.rsc", "wpa-enterprise-wireless-legacy.rsc",
         "passpoint-wifi-ros7.rsc", "passpoint-wireless-legacy.rsc", "mac-auth.rsc", "mac-auth-wireless-legacy.rsc",
         "pppoe-server.rsc"]
# Files that add the same entries (social / social-video / video-streaming; webfilter-policies.rsc and allow-only-*.rsc)
# are imported one after the other with nothing removed in between: a second copy must be skipped, not stop the import.
SKIP = {"autosync.rsc": "template of the dashboard's auto-sync (tested in the Router setup sets)"}
V7_ONLY = {"wpa-enterprise-wifi-ros7.rsc", "mac-auth.rsc", "passpoint-wifi-ros7.rsc"}   # v6 routers get the legacy file
PP = {"domain": "wifi.chrtest.example", "name": "CHR Test Ltd", "ssid": "CHR-Passpoint", "venue": "industrial-factory",
      "venue_name": "Plant 2", "network": "private", "roaming_oi": "5a03ba0000"}
SETUPS = {   # name: parts (+ options) — like the dashboard's presets
    "setup-wifi": {"wpa_ros7": True, "passpoint": True, "macauth": True, "staff_ssid": "Staff-WiFi",
                   "devices_ssid": "Devices-WiFi", "devices_key": "DevKey12345"},
    "setup-legacy": {"wpa_legacy": True, "passpoint": True, "passpoint_legacy": True, "staff_ssid": "Staff-WiFi"},
    "setup-hotspot": {"hotspot": True, "hotspot_create": True, "hotspot_mac": True, "lan_net": "192.168.88.1/24", "dns_name": "login.wifi"},
    "setup-isp": {"pppoe": True, "pppoe_if": "ether2", "traffic": True, "security": True, "languard": True,
                  "snmp": True, "snmp_community": COMMUNITY},
    "setup-blocking": {"webfilter": True, "logging": True, "dnslog": True},
}


def fill(text):
    # adlists: the syntax is what is tested; real lists (100k+ names) keep an emulated CHR busy for minutes
    text = re.sub(r'url="https?://[^"]+"(?= ssl-verify=)', 'url="https://127.0.0.1/chr-test-adlist"', text)
    return (text.replace("RADIUS_SERVER_IP", SERVER).replace("RADIUS_SECRET", SECRET)
            .replace("SNMP_COMMUNITY", COMMUNITY).replace("ROUTER_IP", "192.168.88.1"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out"); ap.add_argument("--ros", default="7", choices=("6", "7")); ap.add_argument("--sync")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    mk = os.path.join(ROOT, "mikrotik")
    files = sorted(f for f in os.listdir(mk) if f.endswith(".rsc"))
    files = [f for f in ORDER if f in files] + [f for f in files if f not in ORDER]
    jobs = []                                  # (name, text, strict, note)
    for f in files:
        if f in SKIP:
            print(f"skip {f}: {SKIP[f]}", file=sys.stderr)
            continue
        if a.ros == "6" and f in V7_ONLY:
            continue
        text = fill(open(os.path.join(mk, f), encoding="utf-8").read())
        if f.startswith("passpoint-"):
            text = passpoint.router(passpoint.settings(PP), text)
        if a.ros == "6":
            text = rosv6.convert(text)
        jobs.append((f[:-4], text, f.startswith("passpoint-"), ""))
    st = passpoint.settings(PP)
    for name, parts in SETUPS.items():
        o = {"server_ip": SERVER, "secret": SECRET, "router_name": "chr", "lan_if": "bridge", "passpoint_settings": st, **parts}
        if a.ros == "6" and name == "setup-legacy":
            continue                           # RouterOS 6: setup-wifi already becomes the legacy version
        text = routersetup.build(o, mk, "", ros=a.ros)
        jobs.append((name, text, True, ""))
    # new device approval (sync.rsc part): on (twice: an update), strict, then off — the server is not reachable
    # from here, so the router's first check fails and is logged (strict: nothing is waiting yet either)
    nd_base = "https://radius.chrtest.example:8443/api/public/router"
    for name, text in (("newdev-on", newdev.router_part(True, nd_base, "K" * 32, SERVER)),
                       ("newdev-strict", newdev.router_part(True, nd_base, "K" * 32, SERVER, strict=True)),
                       ("newdev-answer", newdev.reconcile(["192.168.88.50", "192.168.88.51"])),
                       ("newdev-answer-empty", newdev.reconcile(["192.168.88.51"])),
                       ("newdev-off", newdev.router_part(False))):
        jobs.append((name, rosv6.convert(text) if a.ros == "6" else text, name != "newdev-answer", ""))
    if a.sync:
        jobs.append(("server-sync", open(a.sync, encoding="utf-8").read(), False, "sync.rsc from the server"))
    with open(os.path.join(a.out, "list.txt"), "w") as lst:
        for i, (name, text, strict, _) in enumerate(jobs, 1):
            fn = f"{i:02d}-{re.sub(r'[^a-z0-9-]', '-', name.lower())}.rsc"
            with open(os.path.join(a.out, fn), "w", encoding="utf-8") as fh:
                fh.write(text)
            lst.write(f"{fn} {int(strict)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
