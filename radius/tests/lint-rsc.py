#!/usr/bin/env python3
"""Static sanity check for the RouterOS scripts in radius/mikrotik/.

RouterOS cannot run in CI, so this catches the mistakes that would abort an /import:
unbalanced quotes/braces, commands outside a menu, and property names that do not
exist in the menu they are used in (whitelist below, from the RouterOS 7 manual).
Usage: python3 tests/lint-rsc.py [files...]
"""
import re, sys, glob, os

FW = {"chain", "in-interface-list", "src-address-list", "dst-address-list", "src-address",
      "dst-address", "protocol", "dst-port", "action", "to-addresses", "to-ports",
      "reject-with", "comment", "tls-host", "place-before", "disabled"}
PROPS = {
    "/radius": {"address", "secret", "service", "timeout", "comment", "src-address"},
    "/radius incoming": {"accept"},
    "/ip dns": {"allow-remote-requests", "servers"},
    "/ip dns static": {"name", "regexp", "type", "match-subdomain", "comment", "cname",
                       "forward-to", "address", "disabled"},
    "/ip dns adlist": {"url", "ssl-verify", "comment", "file", "disabled"},
    "/ip firewall address-list": {"list", "address", "comment", "timeout"},
    "/ipv6 firewall address-list": {"list", "address", "comment", "timeout"},
    "/ip firewall nat": FW,
    "/ip firewall filter": FW,
    "/ipv6 firewall filter": FW,
    "/interface wifi security": {"name", "authentication-types", "eap-accounting", "passphrase"},
    "/interface wifi configuration": {"name", "ssid", "security", "country", "mode"},
    "/interface wifi access-list": {"action", "ssid-regexp", "comment", "mac-address"},
    "/interface wifi": {"configuration", "disabled", "master-interface", "name"},
    "/interface wireless security-profiles": {"name", "mode", "authentication-types", "eap-methods",
        "unicast-ciphers", "group-ciphers", "radius-eap-accounting", "wpa2-pre-shared-key",
        "radius-mac-authentication", "radius-mac-accounting", "radius-mac-mode", "radius-mac-format"},
    "/interface wireless": {"security-profile", "ssid", "mode", "disabled", "master-interface", "name", "vlan-mode"},
    "/ip hotspot profile": {"use-radius", "radius-accounting", "radius-interim-update", "login-by", "mac-auth-mode"},
}
VERBS = {"add", "set", "remove", "move", ":foreach", "}"}

def strip_quoted(s):
    return re.sub(r'"(?:\\.|[^"\\])*"', 'Q', s)

def lint(path):
    errs, menu, depth, cont = [], None, 0, ""
    for n, raw in enumerate(open(path, encoding="utf-8"), 1):
        line = raw.rstrip("\n")
        if line.rstrip().endswith("\\") and not line.lstrip().startswith("#"):
            cont += line.rstrip()[:-1] + " "
            continue
        line, cont = cont + line, ""
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if strip_quoted(s).count('"'):
            errs.append(f"{n}: unbalanced quote")
            continue
        bare = strip_quoted(s)
        depth += bare.count("{") - bare.count("}")
        if depth < 0:
            errs.append(f"{n}: unbalanced braces")
        if s.startswith("/"):
            menu = s.split(" add ")[0].split(" set ")[0].strip()
            if menu not in PROPS:
                errs.append(f"{n}: unknown menu {menu}")
            if " " not in s.strip() or menu == s:
                continue
            s = s[len(menu):].strip()
            bare = strip_quoted(s)
        verb = s.split()[0]
        if verb not in VERBS:
            errs.append(f"{n}: unexpected command '{verb}'")
            continue
        if menu is None:
            errs.append(f"{n}: command before any menu")
            continue
        if verb in ("add", "set"):
            for prop in re.findall(r'(?:^|\s)([a-z0-9-]+)=', re.sub(r"\[[^\]]*\]", "", bare)):
                if prop not in PROPS.get(menu, set()):
                    errs.append(f"{n}: property '{prop}' not valid in {menu}")
    if depth != 0:
        errs.append("end: unbalanced braces")
    return errs

files = sys.argv[1:] or sorted(glob.glob(os.path.join(os.path.dirname(__file__), "..", "mikrotik", "*.rsc")))
bad = 0
for f in files:
    e = lint(f)
    print(("FAIL " if e else "ok   ") + os.path.basename(f))
    for x in e:
        print("     " + x)
    bad += bool(e)
sys.exit(1 if bad else 0)
