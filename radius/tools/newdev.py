#!/usr/bin/env python3
"""New device approval: every new device on the LAN needs the admin's OK before it gets internet.

How it works
  - Router (part of sync.rsc, auto-sync): every DHCP lease that becomes "bound" and, once a minute, the list of
    bound leases are sent to the server (POST /api/public/router/newdev). DHCP servers on a hotspot interface are
    left out (the hotspot has its own login).
  - Server: a MAC it has not seen becomes "pending" (or "approved" while learning). Its answer is a short
    RouterOS script that makes the router's address list ml-newdev exactly the pending / denied devices of
    THAT router (by IP).
  - Router firewall: ml-newdev gets only DNS and the server's "waiting for approval" page (every http:// address).
  - Admin: radius-admin newdev approve MAC (or the dashboard) -> the router opens it within a minute.

  newdev.py router-part on|off --base URL --key KEY [--server IP] [--strict]   RouterOS text for sync.rsc
"""
import argparse, re, sys

MAC_RE = re.compile(r"^([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})[-:.]?"
                    r"([0-9A-Fa-f]{2})[-:.]?([0-9A-Fa-f]{2})$")
IP_RE = re.compile(r"^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$")
STATUSES = ("pending", "approved", "denied", "disabled")


def norm_mac(m):
    """any MAC format -> AA-BB-CC-DD-EE-FF (as the rest of the project stores MACs); None when not a MAC"""
    x = MAC_RE.match((m or "").strip())
    return "-".join(g.upper() for g in x.groups()) if x else None


def valid_ip(ip):
    x = IP_RE.match(ip or "")
    return bool(x) and all(int(p) <= 255 for p in x.groups())


def clean_host(h):
    """DHCP host name, shown on the dashboard: printable, short"""
    return re.sub(r"[^A-Za-z0-9 ._()+-]", "", h or "")[:64]


def parse_report(text, limit=4000):
    """'MAC|IP|HOST' lines from a router -> [(mac, ip, host)]; bad lines are skipped, one entry per MAC"""
    out, seen = [], set()
    for line in (text or "").splitlines()[:limit]:
        parts = line.strip().split("|")
        if len(parts) < 2:
            continue
        mac, ip = norm_mac(parts[0]), parts[1].strip()
        if not mac or not valid_ip(ip) or mac in seen:
            continue
        seen.add(mac)
        out.append((mac, ip, clean_host(parts[2] if len(parts) > 2 else "")))
    return out


def reconcile(ips):
    """RouterOS script (run by the router with :parse): address list ml-newdev = exactly these IPs"""
    ips = sorted({ip for ip in ips if valid_ip(ip)})
    keep = "{" + ";".join(f'"{ip}"' for ip in ips) + "}" if ips else "[:toarray \"\"]"
    return "\n".join([
        f":local keep {keep}",
        ':foreach i in=[/ip firewall address-list find list=ml-newdev] do={ '
        ':if ([:typeof [:find $keep [:tostr [/ip firewall address-list get $i address]]]] = "nil") do={ /ip firewall address-list remove $i } }',
        ':foreach a in=$keep do={ :if ([:len [/ip firewall address-list find list=ml-newdev address=$a]] = 0) do={ '
        ':do { /ip firewall address-list add list=ml-newdev address=$a comment="mlnewdev: waiting for approval" } on-error={} } }',
        f':global mlNdCount {len(ips)}',
        ""])


def _move_top(menu, expr):
    return (f':do {{ :local o [{menu} find where !({expr})]; :if ([:len $o] > 0) do={{ '
            f'{menu} move [{menu} find {expr}] destination=[:pick $o 0] }} }}')


def router_part(on, base="", key="", server="", strict=False):
    """sync.rsc part: on = scripts, scheduler, DHCP lease-script, firewall; off = everything taken out again"""
    off = [
        "# ---- new device approval: off (radius-admin newdev on)",
        ':do { /system scheduler remove [find name="ml-newdev"] } on-error={}',
        ':do { /system script remove [find name="ml-newdev"] } on-error={}',
        ':do { :foreach s in=[/ip dhcp-server find where lease-script~"mlNdOne"] do={ /ip dhcp-server set $s lease-script="" } } on-error={}',
        ':do { /ip firewall filter remove [find comment~"^mlnewdev"] } on-error={}',
        ':do { /ip firewall nat remove [find comment~"^mlnewdev"] } on-error={}',
        ':do { /ip firewall address-list remove [find list=ml-newdev] } on-error={}',
        ""]
    if not on:
        return "\n".join(off)
    if not base.startswith("https://") or not re.match(r"^[A-Za-z0-9]{16,64}$", key or ""):
        raise ValueError("new device approval needs the router auto-sync (server address and key)")
    if server and not valid_ip(server):
        raise ValueError("server IP: an IPv4 address")
    strict_rsc = "yes" if strict else "no"
    # the DHCP lease-script: one new device at once (globals, a lease-script cannot pass arguments)
    ls = (':if (\\$leaseBound = 1) do={ :global mlNdOne (\\$leaseActMAC . \\"|\\" . \\$leaseActIP . \\"|\\" . \\$\\"lease-hostname\\"); '
          ':global mlNdOneIp \\$leaseActIP; :do { /system script run ml-newdev } on-error={} }')
    L = [
        "# ---- new device approval (radius-admin newdev): a device the admin has not approved gets no internet",
        "#      (address list ml-newdev: only DNS and this server's 'waiting for approval' page). Hotspot DHCP servers are left out.",
        '/system script remove [find name="ml-newdev"]',
        '/system script add name=ml-newdev policy=read,write,test comment="mikrotiklover: new devices need approval" source={',
        ":global mlNdOne",
        ":global mlNdOneIp",
        ":local one $mlNdOne",
        ":local oneIp $mlNdOneIp",
        ':set mlNdOne ""',
        ':set mlNdOneIp ""',
        f':local base "{base}"',
        f':local key "{key}"',
        f":local strict {strict_rsc}",
        # which DHCP servers: every one that is not on a hotspot interface
        ':local gated [:toarray ""]',
        ':foreach s in=[/ip dhcp-server find where disabled=no] do={',
        '  :local x [/ip dhcp-server get $s]',
        '  :local hs 0',
        '  :do { :set hs [:len [/ip hotspot find where interface=($x->"interface")]] } on-error={}',
        '  :if ($hs = 0) do={ :set gated ($gated, ($x->"name")) }',
        '}',
        ':local d ""',
        ':if ([:len $one] > 0) do={ :set d ($one . "\\n") } else={',
        '  :foreach l in=[/ip dhcp-server lease find where status="bound"] do={',
        '    :local x [/ip dhcp-server lease get $l]',
        '    :if ([:typeof [:find $gated ($x->"server")]] != "nil") do={',
        '      :set d ($d . ($x->"mac-address") . "|" . ($x->"address") . "|" . ($x->"host-name") . "\\n")',
        '    }',
        '  }',
        '}',
        ':if ([:len $d] = 0) do={ :set d "-\\n" }',
        ':do {',
        '  :local r [/tool fetch url="$base/newdev?key=$key" http-method=post http-data=$d '
        'http-header-field="Content-Type: text/plain" check-certificate=yes-without-crl output=user as-value]',
        '  :if (($r->"status") = "finished") do={ :local f [:parse ($r->"data")]; $f }',
        '} on-error={',
        '  :log warning "ml-newdev: RADIUS server not reachable"',
        # strict: a new device waits even when the server cannot be asked (the next answer opens approved ones)
        '  :if ($strict && [:len $oneIp] > 0) do={ :do { /ip firewall address-list add list=ml-newdev address=$oneIp '
        'timeout=1h comment="mlnewdev: server not reachable" } on-error={} }',
        '}',
        '}',
        '/system scheduler remove [find name="ml-newdev"]',
        '/system scheduler add name=ml-newdev interval=1m start-time=startup on-event="/system script run ml-newdev" '
        'comment="mikrotiklover: new devices need approval"',
        "# DHCP: a new lease asks at once (a lease-script set by the admin is left as it is: then only the minute check)",
        f':local ls "{ls}"',
        ':foreach s in=[/ip dhcp-server find] do={',
        '  :local x [/ip dhcp-server get $s]',
        '  :local hs 0',
        '  :do { :set hs [:len [/ip hotspot find where interface=($x->"interface")]] } on-error={}',
        '  :local cur ($x->"lease-script")',
        '  :if ($hs = 0 && ([:len $cur] = 0 || [:typeof [:find $cur "mlNdOne"]] != "nil")) do={ /ip dhcp-server set $s lease-script=$ls }',
        '  :if ($hs > 0 && [:typeof [:find $cur "mlNdOne"]] != "nil") do={ /ip dhcp-server set $s lease-script="" }',
        '  :if ($hs = 0 && [:len $cur] > 0 && [:typeof [:find $cur "mlNdOne"]] = "nil") do={ :log warning ("ml-newdev: DHCP server " . ($x->"name") . " has its own lease-script: new devices are found by the minute check") }',
        '}',
        "/ip firewall filter",
        'remove [find comment~"^mlnewdev"]',
    ]
    if server:
        L.append(f'add chain=forward src-address-list=ml-newdev dst-address={server} action=accept comment="mlnewdev: server (waiting page)"')
    L += [
        'add chain=forward src-address-list=ml-newdev protocol=udp dst-port=53 action=accept comment="mlnewdev: dns"',
        'add chain=forward src-address-list=ml-newdev protocol=tcp dst-port=53 action=accept comment="mlnewdev: dns"',
        'add chain=forward src-address-list=ml-newdev connection-state=new action=log log-prefix="WF-newdev" limit=20/1m,10:packet comment="mlnewdev: (log)"',
        'add chain=forward src-address-list=ml-newdev protocol=tcp action=reject reject-with=tcp-reset comment="mlnewdev: block"',
        'add chain=forward src-address-list=ml-newdev action=reject reject-with=icmp-admin-prohibited comment="mlnewdev: block"',
        _move_top("/ip firewall filter", 'comment~"^mlnewdev"'),
        "/ip firewall nat",
        'remove [find comment~"^mlnewdev"]',
    ]
    if server:
        L += [f'add chain=dstnat src-address-list=ml-newdev protocol=tcp dst-port=80 action=dst-nat to-addresses={server} '
              f'to-ports=8081 comment="mlnewdev: waiting page"',
              _move_top("/ip firewall nat", 'comment~"^mlnewdev"')]
    L += [":do { /system script run ml-newdev } on-error={}", ""]
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description="new device approval: router part")
    ap.add_argument("what", choices=("router-part",))
    ap.add_argument("state", choices=("on", "off"))
    ap.add_argument("--base", default=""); ap.add_argument("--key", default=""); ap.add_argument("--server", default="")
    ap.add_argument("--strict", action="store_true")
    a = ap.parse_args(argv)
    try:
        sys.stdout.write(router_part(a.state == "on", a.base, a.key, a.server, a.strict))
    except ValueError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
