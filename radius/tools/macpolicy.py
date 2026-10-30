#!/usr/bin/env python3
"""Policy by MAC for Wi-Fi (WPA-Enterprise) users and MAC devices — no VLAN needed.

A hotspot / PPPoE login gets its policy list from RADIUS (Mikrotik-Address-List on the user's IP). A Wi-Fi
(802.1X) login has no IP yet, so the router cannot do that. But the server knows the phone's MAC from the login
(ml_eap_identity, accounting) and the user's policy; the router knows the MAC's IP (DHCP lease, else ARP for a
device with an IP set by hand). Every minute (ml-live) the router gets the MAC -> policy list and puts the IP in
the policy's address list (comment "mlmac: USER"); what is no longer right is taken out. When what it found changed,
the router tells the server MAC|IP, and the server writes that IP into the user's open session — so reports, Why
blocked?, quarantine, departments and temporary exceptions know the user by IP too.

  macpolicy.py list   [--cnf F --db D] [--json]     who gets which list (+ the IP a router found)
  macpolicy.py script [--cnf F --db D] [--off]      the RouterOS part for live.rsc
  macpolicy.py report ROUTER-IP [--cnf F --db D]    MAC|IP lines on stdin from a router
"""
import ipaddress
import json
import re
import sys

MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}([:-][0-9A-Fa-f]{2}){5}$")
LIST_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
USER_RE = re.compile(r"[^\w.@+-]")


def mac(v):
    """'aa-bb-cc-dd-ee-ff' -> 'AA:BB:CC:DD:EE:FF' (the router's way); None when not a MAC"""
    v = (v or "").strip()
    return v.replace("-", ":").upper() if MAC_RE.match(v) else None


# who: Wi-Fi logins (the real user behind "anonymous", last 2 days; a phone logs in again when it reconnects) and open sessions without a router-given IP
# (802.1X, Wi-Fi MAC devices; open = still connected, up to 30 days) or with an IP this module put there. Policy: the user's own, else the group's
# (same rule as the dashboard's user list); quarantine on top.
ROWS_SQL = """
SELECT x.mac, x.username, x.seen,
  COALESCE((SELECT r.value FROM radreply r WHERE r.username=x.username AND r.attribute='Mikrotik-Address-List' LIMIT 1),
           (SELECT gr.value FROM radgroupreply gr WHERE gr.attribute='Mikrotik-Address-List' AND gr.groupname=
              (SELECT MAX(g.groupname) FROM radusergroup g WHERE g.username=x.username) LIMIT 1), '') AS list,
  EXISTS (SELECT 1 FROM ml_quarantine q WHERE q.username=x.username AND q.released_at IS NULL) AS quarantined,
  COALESCE(m.ip, '') AS ip, COALESCE(m.router, '') AS router, m.at AS ip_at
FROM (
  SELECT e.mac, e.username, e.at AS seen FROM ml_eap_identity e WHERE e.at > NOW() - INTERVAL 2 DAY
  UNION ALL
  SELECT r.callingstationid, r.username, COALESCE(r.acctupdatetime, r.acctstarttime)
    FROM radacct r
   WHERE r.acctstoptime IS NULL AND r.callingstationid <> '' AND r.username <> ''
     AND COALESCE(r.acctupdatetime, r.acctstarttime) > NOW() - INTERVAL 30 DAY
     AND (COALESCE(r.framedipaddress, '') = ''
          OR EXISTS (SELECT 1 FROM ml_mac_ip mi WHERE mi.ip = r.framedipaddress
                       AND mi.mac = UPPER(REPLACE(r.callingstationid, '-', ':'))))
) x
LEFT JOIN ml_mac_ip m ON m.mac = UPPER(REPLACE(x.mac, '-', ':'))
ORDER BY x.seen DESC
"""


def rows(query):
    """query(sql) -> list of dicts. -> [{mac, user, lists, ip, router}] one per MAC (newest login wins), with a list"""
    out, done = [], set()
    for r in query(ROWS_SQL):
        m = mac(r["mac"])
        if not m or m in done:
            continue
        done.add(m)
        lists = [r["list"]] if r["list"] and LIST_RE.match(r["list"]) else []
        if int(r["quarantined"] or 0) and "ml-quarantine" not in lists:
            lists.append("ml-quarantine")      # quarantine also puts ml-quarantine in place of the user's own list
        if lists:
            out.append({"mac": m, "user": r["username"], "lists": lists, "ip": r["ip"] or "", "router": r["router"] or "",
                        "ip_at": str(r["ip_at"] or "")})
    return sorted(out, key=lambda r: (r["user"], r["mac"]))


def script(rs, base="", key="", on=True):
    """the RouterOS part of live.rsc (RouterOS 6 and 7)"""
    if not on:
        return ('\n# policy by MAC for Wi-Fi users: off\n'
                ':if ([:len [/ip firewall address-list find where comment~"^mlmac"]] > 0) do={ '
                '/ip firewall address-list remove [find where comment~"^mlmac"] }\n'
                ':global mlMacRep\n:set mlMacRep ""\n')
    lists = ";".join(f'"{r["mac"]}"="{",".join(r["lists"])}"' for r in rs)
    users = ";".join(f'"{r["mac"]}"="{USER_RE.sub("", r["user"])[:40]}"' for r in rs)
    s = ["",
         "# policy by MAC for Wi-Fi (WPA-Enterprise) users and MAC devices: MAC -> its IP (DHCP, else ARP) -> policy list",
         f":local mm {{{lists}}}" if rs else ':local mm [:toarray ""]',
         f":local mu {{{users}}}" if rs else ':local mu [:toarray ""]',
         ':local want [:toarray ""]',
         ":foreach m,ls in=$mm do={",
         '  :local ips [:toarray ""]',
         '  :foreach l in=[/ip dhcp-server lease find where mac-address=$m and status="bound"] do={ :set ips ($ips, [:tostr [/ip dhcp-server lease get $l address]]) }',
         "  :if ([:len $ips] = 0) do={",
         "    :foreach a in=[/ip arp find where mac-address=$m] do={ :set ips ($ips, [:tostr [/ip arp get $a address]]) }",
         "  }",
         "  :foreach ip in=$ips do={",
         '    :if ([:len $ip] > 0) do={ :foreach li in=[:toarray $ls] do={ :set ($want->($li . "|" . $ip)) $m } }',
         "  }",
         "}",
         "# take out what is no longer right (and doubles), keep the rest",
         ':local rep ""',
         ':foreach e in=[/ip firewall address-list find where comment~"^mlmac"] do={',
         '  :local k ([/ip firewall address-list get $e list] . "|" . [:tostr [/ip firewall address-list get $e address]])',
         "  :local m ($want->$k)",
         "  :if ([:len $m] = 0) do={ /ip firewall address-list remove $e } else={",
         '    :set ($want->$k) ""',
         '    :set rep ($rep . $m . "|" . [:pick $k ([:find $k "|"] + 1) [:len $k]] . "\\n")',
         "  }",
         "}",
         ":foreach k,m in=$want do={",
         "  :if ([:len $m] > 0) do={",
         '    :local p [:find $k "|"]',
         '    :do { /ip firewall address-list add list=[:pick $k 0 $p] address=[:pick $k ($p + 1) [:len $k]] comment=("mlmac: " . ($mu->$m)) } on-error={}',
         '    :set rep ($rep . $m . "|" . [:pick $k ($p + 1) [:len $k]] . "\\n")',
         "  }",
         "}",
         "# tell the server which IP each MAC has (only when it changed)",
         ":global mlMacRep",
         ":if ($rep != $mlMacRep) do={",
         f'  :do {{ /tool fetch url="{base}/macip?key={key}" http-method=post http-data=$rep http-header-field="Content-Type: text/plain" check-certificate=yes-without-crl output=none; :set mlMacRep $rep }} on-error={{}}',
         "}",
         ""]
    return "\n".join(s)


def parse_report(text, limit=5000):
    """'MAC|IP' lines -> {mac: ip} (bad lines left out)"""
    out = {}
    for line in (text or "").splitlines()[:limit]:
        a, _, b = line.strip().partition("|")
        m = mac(a)
        try:
            ip = str(ipaddress.ip_address(b.strip()))
        except ValueError:
            continue
        if m:
            out[m] = ip
    return out


def store(execute, router, found):
    """keep what a router found (ml_mac_ip) and put the IP into the open session of that MAC
    (only a session without a router-given IP, or one that has the IP this module put there)"""
    before = {r["mac"]: r["ip"] for r in execute("SELECT mac, ip FROM ml_mac_ip")}
    execute("DELETE FROM ml_mac_ip WHERE router=%s", (router,))
    n = 0
    for m, ip in found.items():
        prev = before.get(m, "")
        execute("REPLACE INTO ml_mac_ip (mac, ip, router, at) VALUES (%s, %s, %s, NOW())", (m, ip, router))
        execute("""UPDATE radacct SET framedipaddress=%s
                    WHERE acctstoptime IS NULL AND UPPER(REPLACE(callingstationid, '-', ':'))=%s
                      AND (COALESCE(framedipaddress, '')='' OR framedipaddress=%s)""", (ip, m, prev or ip))
        n += 1
    return n


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
    if not a or a[0] not in ("list", "script", "report"):
        print(__doc__)
        return 1
    ex = _connect(a)
    if a[0] == "list":
        rs = rows(ex)
        if "--json" in a:
            print(json.dumps(rs))
        else:
            for r in rs:
                print(f'{r["user"]:20} {r["mac"]}  {",".join(r["lists"]):30} {r["ip"] or "-":15} {r["router"]}')
            if not rs:
                print("no Wi-Fi user or MAC device with a policy right now")
        return 0
    if a[0] == "script":
        print(script(rows(ex), on="--off" not in a))
        return 0
    router = a[1] if len(a) > 1 else ""
    try:
        router = str(ipaddress.ip_address(router))
    except ValueError:
        print("usage: macpolicy.py report ROUTER-IP < lines", file=sys.stderr)
        return 1
    print(store(ex, router, parse_report(sys.stdin.read())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
