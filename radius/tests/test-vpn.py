#!/usr/bin/env python3
"""Offline tests for VPN watch (tools/vpn.py): VPN names, server IPs, router blocks, flows."""
import json, os, sys, tempfile, time
state = tempfile.mkdtemp()
os.environ["MLCDN_STATE"] = state
# a shared-CDN owner network, to check that its IPs never become "VPN servers"
json.dump({"updated": "test", "owners": {"Cloudflare (shared CDN)": ["104.16.0.0/13"]}}, open(f"{state}/asn.json", "w"))
open(f"{state}/vpn-ignore.txt", "w").write("vpn.mycompany.com\n")
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import cdnmap, vpn  # noqa: E402
vpn.IGNORE_FILE = f"{state}/vpn-ignore.txt"

lines, serial = [], [100]
T0 = time.mktime((2026, 10, 16, 10, 0, 0, 0, 0, -1))
def iso(t): return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(t)) + "+00:00"
def look(t, client, qname, ips, chain=()):
    serial[0] += 1
    s = serial[0]
    lines.append(f"{iso(t)} 192.168.88.1 dnsmasq[1]: {s} {client}/5000 query[A] {qname} from {client}")
    for n in [qname] + list(chain):
        lines.append(f"{iso(t)} 192.168.88.1 dnsmasq[1]: {s} {client}/5000 reply {n} is <CNAME>")
    for ip in ips:
        lines.append(f"{iso(t)} 192.168.88.1 dnsmasq[1]: {s} {client}/5000 reply {(list(chain) or [qname])[-1]} is {ip}")

ali, sara, bilal = "10.0.0.11", "10.0.0.12", "10.0.0.13"
look(T0, ali, "api.nordvpn.com", ["198.51.100.10"])                       # catalog VPN app
look(T0 + 5, ali, "us1234.nordvpn.com", ["198.51.100.11"])
look(T0 + 10, sara, "api.superfast-vpn-free.xyz", ["203.0.113.70"])       # unknown: "vpn" in the name
look(T0 + 12, sara, "www.psiphon3.com", ["104.16.5.5"])                    # block list, but on Cloudflare
look(T0 + 20, bilal, "vpn.mycompany.com", ["192.0.2.50"])                  # ignored (office VPN)
look(T0 + 21, bilal, "www.google.com", ["142.250.1.1"])                    # normal
look(T0 + 22, bilal, "shared.example.net", ["198.51.100.10"])              # non-VPN name on a "VPN" IP? -> not a server
look(T0 + 30, ali, "cdn.vpnapp.io", ["151.101.1.1"], ["vpnapp.global.fastly.net"])   # VPN name via a shared CDN
look(T0 + 35, bilal, "www.freeproxy-unblock.site", ["203.0.113.90"])   # web proxy site
look(T0 + 36, bilal, "www.croxyproxy.com", ["203.0.113.91"])           # proxy site from the block list
wf = [f"{iso(T0 + 40)} 192.168.88.1 firewall,info: WF-vpn forward: in:bridge out:ether1, connection-state:new src-mac aa:bb:cc:00:00:12, proto UDP, {sara}:40000->203.0.113.70:51820, len 148",
      f"{iso(T0 + 41)} 192.168.88.1 firewall,info: WF-social forward: in:bridge out:ether1, src-mac aa:bb:cc:00:00:12, proto TCP (SYN), {sara}:40001->157.240.1.35:443, len 60"]

users = {ali: "ali", sara: "sara", bilal: "bilal"}
events, servers, domains = vpn.scan(lines, wf, vpn.Matcher(), lambda ip, t, mac="": users.get(ip, ""))
fail = 0
def check(desc, cond, got=""):
    global fail
    print(("ok   " if cond else "FAIL ") + desc + ("" if cond else f"\n     got: {got}"))
    fail += not cond

who = {(c, src): e for (b, c, src, w), e in events.items()}
check("ali looked up NordVPN -> attempt, kind NordVPN, user ali",
      any(k[1] == ali and k[2] == "dns" and e[0] == "NordVPN" and e[4] == "ali" for k, e in events.items()), events)
check("unknown name with 'vpn' -> attempt for sara", any(k[1] == sara and k[3] == "api.superfast-vpn-free.xyz" for k in events), events)
check("block-list app (psiphon) -> attempt", any(k[3] == "www.psiphon3.com" for k in events))
check("office VPN on the ignore list is not reported", not any(k[3] == "vpn.mycompany.com" for k in events))
check("google is not a VPN", not any(k[3] == "www.google.com" for k in events))
check("NordVPN IP 198.51.100.11 learned as a server", servers.get("198.51.100.11", [None])[0] == "NordVPN", servers)
check("unknown VPN IP learned", "203.0.113.70" in servers, servers)
check("IP also used by a normal site is NOT a server", "198.51.100.10" not in servers, servers)
check("Cloudflare IP of psiphon's website is NOT a server", "104.16.5.5" not in servers, servers)
check("VPN name behind a shared CDN: its IP is NOT a server", "151.101.1.1" not in servers, servers)
blk = [(k, e) for k, e in events.items() if k[2] == "blocked"]
check("router block WF-vpn -> 'blocked' attempt for sara (by MAC/IP)", len(blk) == 1 and blk[0][0][1] == sara and blk[0][1][4] == "sara", blk)
check("blocked attempt shows port/protocol + known server kind", blk and blk[0][0][3] == "203.0.113.70:51820/udp", blk)
check("WF-social line is not a VPN attempt", not any(k[3].startswith("157.240.1.35") for k in events))
check("VPN names list", {"api.nordvpn.com", "api.superfast-vpn-free.xyz", "www.psiphon3.com"} <= set(domains), domains)

check("web proxy site found by its name", any(k[3] == "www.freeproxy-unblock.site" and e[0].startswith("Web proxy") for k, e in events.items()), events)
check("proxy site from the block list found", any(k[3] == "www.croxyproxy.com" for k in events))
srv = {"203.0.113.70": "superfast-vpn-free.xyz"}
check("flow: proxy set on the phone (tcp/3128)", vpn.flow_kind(6, "out", 3128, "1.2.3.4", srv) == "HTTP proxy")
check("flow: SOCKS proxy (tcp/1080)", vpn.flow_kind(6, "out", 1080, "1.2.3.4", srv) == "SOCKS proxy")
check("flow: OpenVPN udp/1194 out", vpn.flow_kind(17, "out", 1194, "1.2.3.4", srv) == "OpenVPN")
check("flow: WireGuard", vpn.flow_kind(17, "out", 51820, "1.2.3.4", srv) == "WireGuard")
check("flow: GRE (PPTP)", vpn.flow_kind(47, "out", 0, "1.2.3.4", srv) == "PPTP VPN (GRE)")
check("flow: stealth VPN on 443 to a known server", vpn.flow_kind(6, "out", 443, "203.0.113.70", srv) == "superfast-vpn-free.xyz")
check("flow: HTTPS elsewhere is not VPN", vpn.flow_kind(6, "out", 443, "142.250.1.1", srv) is None)
check("flow: LAN server on 1194 (IN) is not a VPN attempt", vpn.flow_kind(17, "in", 1194, "1.2.3.4", srv) is None)

sql = vpn.sql(events, servers, domains, T0 - 3600)
check("SQL: re-run replaces dns/blocked rows only (flows are kept)", "DELETE FROM ml_vpn_event WHERE source IN ('dns','blocked')" in sql)
check("SQL: server first_seen never moves later", "first_seen=LEAST(first_seen" in sql)
sys.exit(1 if fail else 0)
