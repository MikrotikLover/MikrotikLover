#!/usr/bin/env python3
"""Static sanity check for the RouterOS scripts in radius/mikrotik/.

RouterOS cannot run in CI, so this catches the mistakes that would abort an /import:
unbalanced quotes/braces, commands outside a menu, and property names that do not
exist in the menu they are used in (whitelist below, from the RouterOS 7 manual).
Usage: python3 tests/lint-rsc.py [files...]
"""
import re, sys, glob, os

FW = {"chain", "in-interface-list", "out-interface-list", "sniff-target", "sniff-target-port", "connection-bytes", "dst-limit", "in-interface", "out-interface", "src-address-list", "dst-address-list", "src-address",
      "dst-address", "protocol", "dst-port", "action", "to-addresses", "to-ports",
      "reject-with", "comment", "tls-host", "place-before", "disabled", "jump-target", "time",
      "log", "log-prefix", "connection-state", "limit", "tcp-flags", "psd", "connection-limit",
      "address-list", "address-list-timeout", "new-packet-mark", "passthrough"}
PROPS = {
    "/radius": {"address", "secret", "service", "timeout", "comment", "src-address"},
    "/radius incoming": {"accept"},
    "/ip dns": {"allow-remote-requests", "servers"},
    "/ip dns static": {"name", "regexp", "type", "match-subdomain", "comment", "cname",
                       "forward-to", "address", "disabled", "address-list", "address-list-timeout"},
    "/ip dns adlist": {"url", "ssl-verify", "comment", "file", "disabled"},
    "/ip firewall address-list": {"list", "address", "comment", "timeout"},
    "/ipv6 firewall address-list": {"list", "address", "comment", "timeout"},
    "/ip firewall nat": FW,
    "/ip firewall filter": FW,
    "/ip firewall raw": FW,
    "/ip firewall mangle": FW,
    "/ipv6 firewall filter": FW,
    "/interface wifi security": {"name", "authentication-types", "eap-accounting", "passphrase"},
    "/interface wifi configuration": {"name", "ssid", "security", "country", "mode"},
    "/interface wifi access-list": {"action", "ssid-regexp", "comment", "mac-address"},
    "/interface wifi": {"configuration", "disabled", "master-interface", "name"},
    "/interface wireless security-profiles": {"name", "mode", "authentication-types", "eap-methods",
        "unicast-ciphers", "group-ciphers", "radius-eap-accounting", "wpa2-pre-shared-key",
        "radius-mac-authentication", "radius-mac-accounting", "radius-mac-mode", "radius-mac-format"},
    "/interface wireless": {"security-profile", "ssid", "mode", "disabled", "master-interface", "name", "vlan-mode"},
    "/ip traffic-flow": {"enabled", "interfaces", "active-flow-timeout", "inactive-flow-timeout", "cache-entries"},
    "/ip traffic-flow target": {"dst-address", "port", "version", "src-address"},
    "/ip pool": {"name", "ranges", "comment"},
    "/ppp profile": {"name", "local-address", "remote-address", "dns-server", "use-encryption", "only-one", "change-tcp-mss", "comment", "rate-limit"},
    "/interface pppoe-server server": {"service-name", "interface", "default-profile", "authentication", "one-session-per-host", "max-mtu", "max-mru", "disabled"},
    "/ppp aaa": {"use-radius", "accounting", "interim-update"},
    "/interface list": {"include", "name"},
    "/tool netwatch": {"host", "interval", "timeout", "comment", "up-script", "down-script", "type"},
    "/system logging action": {"name", "target", "remote", "remote-port"},
    "/system logging": {"topics", "action", "prefix"},
    "/ip hotspot profile": {"use-radius", "radius-accounting", "radius-interim-update", "login-by", "mac-auth-mode",
                            "name", "hotspot-address", "dns-name", "html-directory"},
    "/ip hotspot": {"name", "interface", "address-pool", "profile", "disabled"},
    "/ip hotspot walled-garden ip": {"action", "dst-address", "protocol", "dst-port", "comment", "dst-host"},
    "/queue tree": {"name", "parent", "packet-mark", "max-limit", "limit-at", "queue", "priority", "comment"},
    "/queue type": {"name", "kind", "pcq-classifier", "pcq-rate", "pcq-limit", "pcq-total-limit"},
    "/ip dhcp-server lease": {"mac-address", "address", "comment", "server", "disabled"},
    "/ip address": {"address", "interface", "comment", "disabled"},
    "/interface bridge port": {"bridge", "interface", "comment"},
    "/interface list member": {"list", "interface", "comment"},
    "/ip dhcp-server alert": {"interface", "valid-server", "alert-timeout", "comment", "on-alert", "disabled"},
    "/system script": {"name", "policy", "source", "comment", "dont-require-permissions"},
    "/system scheduler": {"name", "interval", "start-time", "on-event", "policy", "comment"},
}
# one-shot commands (not a menu + add/set): their arguments are not checked
COMMANDS = ("/tool fetch", "/certificate import", "/import", "/system script run")
VERBS = {"add", "set", "remove", "move", "disable", "enable", ":foreach", ":if", "}"}

def strip_quoted(s):
    return re.sub(r'"(?:\\.|[^"\\])*"', 'Q', s)

def lint(path):
    errs, menu, depth, cont, script_depth = [], None, 0, "", 0
    for n, raw in enumerate(open(path, encoding="utf-8"), 1):
        line = raw.rstrip("\n")
        if line.rstrip().endswith("\\") and not line.lstrip().startswith("#"):
            cont += line.rstrip()[:-1] + " "
            continue
        line, cont = cont + line, ""
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        if script_depth:                      # inside source={ ... }: RouterOS script, not menu commands
            bare = strip_quoted(s)
            script_depth += bare.count("{") - bare.count("}")
            depth += bare.count("{") - bare.count("}")
            continue
        if s.startswith(COMMANDS) or s.startswith((":delay", ":if", ":do", ":log", ":local", ":global", ":put", ":set", ":foreach")):
            bare = strip_quoted(s)
            depth += bare.count("{") - bare.count("}")
            continue
        if strip_quoted(s).count('"'):
            errs.append(f"{n}: unbalanced quote")
            continue
        bare = strip_quoted(s)
        depth += bare.count("{") - bare.count("}")
        if depth < 0:
            errs.append(f"{n}: unbalanced braces")
        if s.startswith("/"):
            words = s.split()
            cut = next((i for i, w in enumerate(words) if w in ("add", "set", "remove", "move")), len(words))
            menu = " ".join(words[:cut])
            if menu not in PROPS:
                errs.append(f"{n}: unknown menu {menu}")
            if " " not in s.strip() or menu == s:
                continue
            s = s[len(menu):].strip()
            bare = strip_quoted(s)
        verb = s.split()[0]
        if verb == "}":                       # end of a block
            continue
        if verb not in VERBS:
            errs.append(f"{n}: unexpected command '{verb}'")
            continue
        if menu is None:
            errs.append(f"{n}: command before any menu")
            continue
        if verb in ("add", "set") and "source={" in s:
            script_depth = bare.count("{") - bare.count("}")
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
