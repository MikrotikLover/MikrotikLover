#!/usr/bin/env python3
"""Router setup: one RouterOS script made from the files in mikrotik/ with this server's IP, the router's
RADIUS secret, interface names and Wi-Fi names filled in, in the right order — the dashboard turns it into
one line to paste into the router's terminal.

build(opts, mikrotik_dir, autosync_text) -> script text; raises ValueError for bad input.
"""
import os, re

IFACE_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
IP_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
CIDR_RE = re.compile(r"^(\d{1,3}(?:\.\d{1,3}){3})/(\d{1,2})$")
SSID_RE = re.compile(r"^[A-Za-z0-9 ._@#+()-]{1,32}$")
KEY_RE = re.compile(r"^[A-Za-z0-9 ._@#+()!-]{8,63}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9._@#+-]{6,128}$")

# (key, file, what it is) in the order they are imported
MODULES = [
    ("hotspot", "hotspot.rsc", "Hotspot (vouchers, social WiFi)"),
    ("wpa_ros7", "wpa-enterprise-wifi-ros7.rsc", "Staff Wi-Fi WPA-Enterprise (RouterOS 7, wifi)"),
    ("wpa_legacy", "wpa-enterprise-wireless-legacy.rsc", "Staff Wi-Fi WPA-Enterprise (old wireless)"),
    ("pppoe", "pppoe-server.rsc", "PPPoE server"),
    ("macauth", "mac-auth.rsc", "Devices by MAC (printer, TV, CCTV)"),
    ("webfilter", "webfilter-base.rsc", "Blocking base (needed for policies)"),
    ("logging", "webfilter-logging.rsc", "Router logs to the server"),
    ("dnslog", "dns-logging.rsc", "DNS logger (sites, apps, VPN, virus)"),
    ("traffic", "traffic-flow.rsc", "Traffic flow (data usage, DDoS)"),
    ("autosync", None, "Auto-sync (policies, lists, health, hotspot pages)"),
    ("security", "security.rsc", "Security (scans, password guessing, SYN flood)"),
    ("languard", "lan-guard.rsc", "LAN guard (fake router, ARP spoofing)"),
]
SERVICES = {"hotspot": "hotspot", "wpa_ros7": "wireless", "wpa_legacy": "wireless", "pppoe": "ppp", "macauth": "wireless,hotspot"}
NEEDS_BASE = ("logging", "dnslog", "autosync")      # these build on webfilter-base


def _ip(v, what):
    m = IP_RE.match(v or "")
    if not m or any(int(x) > 255 for x in m.groups()):
        raise ValueError(f"{what}: an IPv4 address like 10.10.10.10")
    return v


def _iface(v, what):
    if not IFACE_RE.match(v or ""):
        raise ValueError(f"{what}: interface name like bridge, ether2, vlan20")
    return v


def _strip_radius(text):
    """Remove the per-script RADIUS client lines: the setup adds one entry with every service."""
    text = re.sub(r'(?m)^/radius\n(add address=RADIUS_SERVER_IP [^\n]*comment="MikrotikLover RADIUS"\n)?', "", text)
    text = re.sub(r"(?m)^/radius incoming\nset accept=yes\n", "", text)
    return text


def build(o, mikrotik_dir, autosync_text=""):
    sel = [k for k, _, _ in MODULES if o.get(k)]
    if not sel:
        raise ValueError("choose at least one part")
    if o.get("wpa_ros7") and o.get("wpa_legacy"):
        raise ValueError("staff Wi-Fi: RouterOS 7 (wifi) or old wireless, not both")
    if any(k in sel for k in NEEDS_BASE) and "webfilter" not in sel and not o.get("base_done"):
        sel.insert(0, "webfilter")
    server = _ip(o.get("server_ip"), "server IP")
    secret = o.get("secret") or ""
    if not SECRET_RE.match(secret):
        raise ValueError("this router has no usable RADIUS secret (Routers page)")
    lan = _iface(o.get("lan_if") or "bridge", "LAN interface")
    out = [f"# MikrotikLover router setup - made by the dashboard for {o.get('router_name') or o.get('router_ip')}",
           f"# server {server} | parts: {', '.join(sel)}", ""]
    # optional: the port the RADIUS server is plugged into (its own network)
    if o.get("server_if"):
        sif = _iface(o["server_if"], "server port")
        m = CIDR_RE.match(o.get("server_net") or "")
        if not m or not 8 <= int(m.group(2)) <= 30:
            raise ValueError("router address on the server port: like 10.10.10.1/24")
        _ip(m.group(1), "router address on the server port")
        out += ["# the server's own network on " + sif,
                f'/interface bridge port remove [find interface="{sif}"]',
                f'/ip address remove [find comment="ml-server-port"]',
                f'/ip address add address={o["server_net"]} interface={sif} comment="ml-server-port"',
                f':if ([:len [/interface list find name="LAN"]] = 0) do={{ /interface list add name=LAN }}',
                f':if ([:len [/interface list member find list=LAN interface="{sif}"]] = 0) do={{ /interface list member add list=LAN interface={sif} }}',
                ""]
    out += [f':if ([:len [/interface list find name="LAN"]] = 0) do={{ /interface list add name=LAN }}',
            f':if ([:len [/interface list member find list=LAN interface="{lan}"]] = 0) do={{ /interface list member add list=LAN interface={lan} }}', ""]
    svc = sorted({s for k in sel if k in SERVICES for s in SERVICES[k].split(",")})
    if svc:
        out += ["# RADIUS: one entry for every service",
                '/radius remove [find comment="MikrotikLover RADIUS"]',
                f'/radius add address={server} secret="{secret}" service={",".join(svc)} timeout=3s comment="MikrotikLover RADIUS"',
                "/radius incoming set accept=yes", ""]
    if "hotspot" in sel and o.get("hotspot_create"):
        m = CIDR_RE.match(o.get("lan_net") or "")
        if not m:
            raise ValueError("LAN address of the router: like 192.168.88.1/24")
        gw = _ip(m.group(1), "LAN address")
        a, b, c, _ = gw.split(".")
        if int(m.group(2)) != 24:
            raise ValueError("hotspot made here needs a /24 LAN (e.g. 192.168.88.1/24); else use /ip hotspot setup")
        dns = o.get("dns_name") or "login.wifi"
        if not re.match(r"^[a-z0-9.-]{3,64}$", dns):
            raise ValueError("hotspot DNS name like login.wifi")
        out += ["# hotspot on the LAN (only when there is none yet)",
                f':if ([:len [/ip hotspot find interface="{lan}"]] = 0) do={{',
                f'  /ip pool remove [find name="ml-hs-pool"]',
                f'  /ip pool add name=ml-hs-pool ranges={a}.{b}.{c}.10-{a}.{b}.{c}.254',
                f'  :if ([:len [/ip hotspot profile find name="hsprof1"]] = 0) do={{ /ip hotspot profile add name=hsprof1 }}',
                f'  /ip hotspot profile set [find name="hsprof1"] hotspot-address={gw} dns-name={dns} html-directory=hotspot',
                f'  /ip hotspot add name=ml-hotspot interface={lan} address-pool=ml-hs-pool profile=hsprof1 disabled=no',
                "}", ""]
    for key, fname, title in MODULES:
        if key not in sel:
            continue
        if key == "autosync":
            if not autosync_text:
                raise ValueError("auto-sync: build the router rules first (Blocking → Build)")
            out += [f"# ---------------- {title}", autosync_text.strip(), ""]
            continue
        text = open(os.path.join(mikrotik_dir, fname), encoding="utf-8").read()
        body = "\n".join(l for l in text.splitlines() if not l.startswith("#"))
        body = _strip_radius(body.strip() + "\n")
        body = body.replace("RADIUS_SERVER_IP", server).replace("RADIUS_SECRET", secret)
        if key in ("wpa_ros7", "wpa_legacy"):
            ssid = o.get("staff_ssid") or "Office-WiFi"
            if not SSID_RE.match(ssid):
                raise ValueError("staff Wi-Fi name: letters, digits, space . _ - (32 at most)")
            body = body.replace('ssid="Office-WiFi"', f'ssid="{ssid}"')
        if key == "macauth":
            ssid, pw = o.get("devices_ssid") or "Devices-WiFi", o.get("devices_key") or ""
            if not SSID_RE.match(ssid) or not KEY_RE.match(pw):
                raise ValueError("devices Wi-Fi: a name and a password of 8-63 characters")
            body = body.replace("Devices-WiFi", ssid).replace("DevicesWiFiKey123", pw)
        if key == "pppoe":
            body = body.replace("interface=ether2", f"interface={_iface(o.get('pppoe_if') or 'ether2', 'PPPoE interface')}")
        if key == "languard":
            body = body.replace('"bridge"', f'"{lan}"').replace("interface=bridge", f"interface={lan}")
        out += [f"# ---------------- {title} ({fname})", body.strip(), ""]
    out += [':log info "MikrotikLover setup finished"', ':put "MikrotikLover setup finished - check the dashboard (Routers, Health check)"']
    return "\n".join(out) + "\n"
