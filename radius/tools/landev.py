#!/usr/bin/env python3
"""Devices: every device on the LAN (DHCP lease, or ARP for an IP set by hand) and its own policy — by MAC,
no fixed IP needed.

  - Router (ml-live, every minute): the bound DHCP leases (MAC, IP, host name, interface) and the ARP entries of
    LAN interfaces whose MAC has no lease (a device with an IP set by hand) go to the server
    (POST /api/public/router/devices; in parts of ~3 KB, RouterOS 6 takes no more in one string comfortably).
  - Server: ml_lan_device keeps each MAC (name, policy, first / last seen, last IP, router, interface, random MAC).
    A new device gets the default policy ("new devices get": none or one policy).
  - Policy: the device's MAC -> its list goes out with the Wi-Fi users' MAC list (tools/macpolicy.py): the router
    finds the IP (DHCP lease, else ARP) and puts it in policy-NAME; an old IP is taken out by itself.
  - Order (one list for a device): quarantine > the policy of a user who logs in on it (hotspot, WPA-Enterprise,
    PPPoE) > the device's own policy > a network / IP range policy. The router keeps list ml-own (every IP that has
    a policy of its own or is quarantined); a network's range is in polnet-NAME and only reaches the policy when the
    IP is not in ml-own (radius-admin policy_net_rsc).

  landev.py list [--cnf F --db D] [--json]
"""
import ipaddress
import json
import re
import sys

MAC_RE = re.compile(r"^([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?"
                    r"([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})$")
POLICY_RE = re.compile(r"^[a-z0-9-]{1,40}$")
NAME_RE = re.compile(r"^[A-Za-z0-9 ._()+'&-]{1,64}$")
IFACE_RE = re.compile(r"[^A-Za-z0-9._<>/-]")
PART = 3000                       # bytes per report part (RouterOS 6 handles strings up to ~4 KB comfortably)


def norm_mac(v):
    """any MAC format -> AA:BB:CC:DD:EE:FF (the router's way, like macpolicy); None when not a MAC"""
    m = MAC_RE.match((v or "").strip())
    return ":".join(g.upper() for g in m.groups()) if m else None


def random_mac(mac):
    """'locally administered' bit of the first byte: phones' private / random addresses"""
    m = norm_mac(mac)
    return bool(m) and bool(int(m[:2], 16) & 0x02)


def clean_name(h):
    return re.sub(r"[^A-Za-z0-9 ._()+'&-]", "", h or "")[:64].strip()


def parse_report(text, limit=8000):
    """'MAC|IP|HOST|INTERFACE|dhcp|arp' lines -> [dict]; bad lines left out, one per MAC (a lease beats ARP)"""
    out = {}
    for line in (text or "").splitlines()[:limit]:
        p = line.strip().split("|")
        if len(p) < 2:
            continue
        mac = norm_mac(p[0])
        try:
            ip = ipaddress.ip_address(p[1].strip())
        except ValueError:
            continue
        if not mac or ip.version != 4 or ip.is_unspecified or ip.is_multicast:
            continue
        src = (p[4].strip() if len(p) > 4 else "dhcp")
        src = src if src in ("dhcp", "arp") else "dhcp"
        if mac in out and out[mac]["src"] == "dhcp" and src == "arp":
            continue
        out[mac] = {"mac": mac, "ip": str(ip), "host": clean_name(p[2] if len(p) > 2 else ""),
                    "iface": IFACE_RE.sub("", p[3] if len(p) > 3 else "")[:32], "src": src}
    return list(out.values())


def store(execute, router, found, default_policy=""):
    """upsert what a router reported; a new MAC gets the default policy. -> (seen, new)"""
    new = 0
    for d in found:
        r = execute("SELECT mac FROM ml_lan_device WHERE mac=%s", (d["mac"],))
        if r:
            execute("""UPDATE ml_lan_device SET last_ip=%s, router=%s, iface=%s, src=%s, last_seen=NOW(),
                       host=IF(%s<>'', %s, host) WHERE mac=%s""",
                    (d["ip"], router, d["iface"], d["src"], d["host"], d["host"], d["mac"]))
        else:
            execute("""INSERT INTO ml_lan_device (mac, host, policy, policy_how, last_ip, router, iface, src, random_mac,
                       first_seen, last_seen) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW(),NOW())""",
                    (d["mac"], d["host"], default_policy, "default" if default_policy else "", d["ip"], router, d["iface"],
                     d["src"], int(random_mac(d["mac"]))))
            new += 1
    return len(found), new


# who has a policy of their own on this MAC already: a login (open session) of a user with a policy, or quarantine
DEV_SQL = """
SELECT d.mac, d.name, d.host, d.policy, d.last_ip,
  EXISTS (SELECT 1 FROM radacct r
           WHERE r.acctstoptime IS NULL AND UPPER(REPLACE(r.callingstationid, '-', ':')) = d.mac
             AND (EXISTS (SELECT 1 FROM radreply x WHERE x.username=r.username AND x.attribute='Mikrotik-Address-List')
               OR EXISTS (SELECT 1 FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname
                           AND gr.attribute='Mikrotik-Address-List' WHERE g.username=r.username))) AS login_policy,
  (EXISTS (SELECT 1 FROM ml_quarantine q WHERE q.released_at IS NULL AND d.last_ip <> '' AND q.ip = d.last_ip)
   OR EXISTS (SELECT 1 FROM ml_quarantine q JOIN radacct r ON r.username=q.username
               WHERE q.released_at IS NULL AND r.acctstoptime IS NULL AND UPPER(REPLACE(r.callingstationid, '-', ':')) = d.mac)) AS quarantined
FROM ml_lan_device d WHERE d.policy <> ''
"""


def device_rows(devs, login_macs=()):
    """order: quarantine > a login's policy > the device's own. devs: DEV_SQL rows; login_macs: MACs that already
    have a list from macpolicy (Wi-Fi users). -> rows for macpolicy.script (one list per MAC)"""
    out, skip = [], {norm_mac(m) for m in login_macs}
    for d in devs:
        mac = norm_mac(d["mac"])
        if not mac or mac in skip or not POLICY_RE.match(d["policy"] or ""):
            continue
        if int(d.get("quarantined") or 0) or int(d.get("login_policy") or 0):
            continue
        who = re.sub(r"[^\w.@+-]", "", (d.get("name") or d.get("host") or "device").replace(" ", "-"))[:30] or "device"
        out.append({"mac": mac, "user": f"dev-{who}", "lists": [f"policy-{d['policy']}"], "ip": d.get("last_ip") or "", "router": ""})
    return out


def report_script(base, key):
    """ml-live part: send the router's devices (leases + ARP of LAN interfaces), in parts; RouterOS 6 and 7"""
    return "\n".join([
        "",
        "# devices for the server (Devices page): bound DHCP leases + ARP of LAN interfaces without a lease (IP set by hand)",
        ':local lan [:toarray ""]',
        ':do { :foreach m in=[/interface list member find where list="LAN"] do={ :set lan ($lan, [/interface list member get $m interface]) } } on-error={}',
        ':local seen [:toarray ""]',
        ':local parts [:toarray ""]',
        ':local cur ""',
        ':foreach l in=[/ip dhcp-server lease find where status="bound"] do={',
        '  :local x [/ip dhcp-server lease get $l]',
        '  :local ifc ""',
        '  :do { :set ifc [/ip dhcp-server get [find where name=($x->"server")] interface] } on-error={}',
        '  :set ($seen->($x->"mac-address")) 1',
        '  :set cur ($cur . ($x->"mac-address") . "|" . ($x->"address") . "|" . ($x->"host-name") . "|" . $ifc . "|dhcp\\n")',
        f'  :if ([:len $cur] > {PART}) do={{ :set parts ($parts, $cur); :set cur "" }}',
        '}',
        ':foreach a in=[/ip arp find] do={',
        '  :local x [/ip arp get $a]',
        '  :local m ($x->"mac-address")',
        '  :if ([:len $m] > 0 && [:typeof ($seen->$m)] = "nothing" && [:typeof [:find $lan ($x->"interface")]] != "nil") do={',
        '    :set ($seen->$m) 1',
        '    :set cur ($cur . $m . "|" . ($x->"address") . "||" . ($x->"interface") . "|arp\\n")',
        f'    :if ([:len $cur] > {PART}) do={{ :set parts ($parts, $cur); :set cur "" }}',
        '  }',
        '}',
        ':if ([:len $cur] > 0) do={ :set parts ($parts, $cur) }',
        ':foreach p in=$parts do={',
        f'  :do {{ /tool fetch url="{base}/devices?key={key}" http-method=post http-data=$p http-header-field="Content-Type: text/plain" '
        'check-certificate=yes-without-crl output=none } on-error={ :log warning "ml-live: devices not sent to the RADIUS server" }',
        '}',
        ""])


def own_script():
    """ml-live part: ml-own = every IP that has a policy of its own (any policy-* list) or is quarantined — a network
    policy (polnet-*) does not reach those (one policy list for a device)"""
    return "\n".join([
        "",
        "# ml-own: IPs with their own policy (login, device, quarantine) — a network policy leaves them alone",
        ':local own [:toarray ""]',
        ':foreach e in=[/ip firewall address-list find where (list~"^policy-" || list="ml-quarantine") && disabled=no] do={',
        '  :local a [:tostr [/ip firewall address-list get $e address]]',
        '  :if ([:typeof [:find $a "/"]] = "nil" && [:typeof [:find $a "-"]] = "nil") do={ :set ($own->$a) 1 }',
        '}',
        ':foreach e in=[/ip firewall address-list find where list="ml-own"] do={',
        '  :local a [:tostr [/ip firewall address-list get $e address]]',
        '  :if ([:typeof ($own->$a)] = "nothing") do={ /ip firewall address-list remove $e } else={ :set ($own->$a) 0 }',
        '}',
        ':foreach a,v in=$own do={ :if ($v = 1) do={ :do { /ip firewall address-list add list=ml-own address=$a comment="mlown" } on-error={} } }',
        ""])


def _connect(a):
    import pymysql

    def opt(k, d):
        return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    c = pymysql.connect(read_default_file=opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), database=opt("--db", "radius"),
                        charset="utf8mb4", autocommit=True, cursorclass=pymysql.cursors.DictCursor)

    def execute(sql, args=None):
        with c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()
    return execute


def main():
    a = sys.argv[1:]
    if not a or a[0] != "list":
        print(__doc__)
        return 1
    rows = _connect(a)("""SELECT mac, name, host, policy, policy_how, last_ip, router, iface, src, random_mac,
                          first_seen, last_seen FROM ml_lan_device ORDER BY first_seen DESC""")
    if "--json" in a:
        print(json.dumps([{k: (str(v) if k in ("first_seen", "last_seen") else v) for k, v in r.items()} for r in rows]))
        return 0
    if not rows:
        print("no device reported yet (routers send their DHCP leases every minute with auto-sync)")
    for r in rows:
        print(f'{r["mac"]}{"*" if r["random_mac"] else " "} {(r["name"] or r["host"] or "-")[:24]:24} {r["last_ip"] or "-":15} '
              f'{r["policy"] or "-":18} {r["router"]}/{r["iface"] or "-":10} {str(r["last_seen"])[:16]}')
    return 0


if __name__ == "__main__":
    sys.exit(main())
