#!/usr/bin/env python3
"""RouterOS 7 script -> RouterOS 6 script (the same rules, the v6 way).

RouterOS 6 stops a whole /import at a line it cannot read (a property it does not know is a syntax error, which
:do / on-error does not catch), so the server makes a v6 copy of every router file instead of hoping:

  /ip dns static ... match-subdomain=yes type=NXDOMAIN   ->  regexp="(^|\\.)name$" address=0.0.0.0
  /ip dns static ... match-subdomain=yes                 ->  regexp="(^|\\.)name$"
  ... type=FWD forward-to=... address-list=L              ->  the addresses of that name and its sub-names, as the
                                                              server's DNS log saw them, put in list L (1 day)
  /ip dns adlist                                         ->  left out (RouterOS 7.15+; the name rules still work)
  /interface wifi ...                                    ->  left out (RouterOS 7 Wi-Fi; v6 uses /interface wireless)
  /certificate import ... name=X                         ->  without name= (the name then starts with the file name)

  rosv6.py convert [--cnf F --db D] < v7.rsc > v6.rsc
  rosv6.py check FILE...                                  report RouterOS-7-only words left (exit 1 if any)
"""
import ipaddress
import re
import sys

V7_ONLY = [
    (re.compile(r"\bmatch-subdomain="), "match-subdomain (DNS static, RouterOS 7)"),
    (re.compile(r"^\s*(add|set)\b.*\baddress-list=.*\btype=FWD|\btype=FWD\b.*\baddress-list="), "DNS static address-list (RouterOS 7)"),
    (re.compile(r"^/ip dns adlist\b"), "/ip dns adlist (RouterOS 7.15+)"),
    (re.compile(r"^/interface wifi\b"), "/interface wifi (RouterOS 7 Wi-Fi)"),
    (re.compile(r"/certificate import\b.*\bname="), "certificate import name= (RouterOS 7)"),
    (re.compile(r"(^|[\s\[{;])/(ip|interface|system|tool|routing|user|certificate|snmp|queue|ppp)/[a-z]"), "slash path /a/b (RouterOS 7)"),
    (re.compile(r":(convert|serialize|deserialize|jobname|onerror|retry)\b"), "RouterOS 7 script command"),
]


def dns_re(name):
    """name and every sub-name, as a RouterOS 6 DNS regexp"""
    return "(^|\\\\.)" + re.escape(name).replace("\\-", "-") + "\\$"


def convert(text, resolve=lambda name: []):
    out, menu = [], ""
    skip_menu = False
    for line in text.splitlines():
        s = line.strip()
        m = re.match(r"^(/[a-z][a-z0-9 -]*?)\s*$", s)
        if m and not s.startswith(("/import", "/system script run")):
            menu = m.group(1)
            skip_menu = menu.startswith(("/ip dns adlist", "/interface wifi"))
            if skip_menu:
                out.append(f"# {menu}: RouterOS 7 only — left out on RouterOS 6")
                continue
        elif s.startswith("/") and " " in s:
            menu = ""
            skip_menu = False
        if skip_menu and not s.startswith(("#", ":", "/")):
            continue
        if re.match(r"^/(ip dns adlist|interface wifi)\b", s):
            out.append("# " + s.split(" ")[0] + " " + s.split(" ")[1] + ": RouterOS 7 only — left out on RouterOS 6")
            continue
        if "match-subdomain=yes" in line:
            nm = re.search(r"\bname=(\"[^\"]+\"|\S+)", line)
            name = nm.group(1).strip('"') if nm else ""
            al = re.search(r"\baddress-list=(\S+)", line)
            if "type=FWD" in line and al:
                lst = al.group(1)
                cm = re.search(r'comment="([^"]*)"', line)
                tag = (cm.group(1) if cm else f"dns {name}") + " (v6)"
                ips = sorted({ip for ip in resolve(name) if _v4(ip)}, key=lambda x: ipaddress.ip_address(x))[:200]
                indent = line[:len(line) - len(line.lstrip())]
                out.append(f'{indent}# {name}: RouterOS 6 cannot fill a list from DNS — the server puts in the {len(ips)} address(es) it saw')
                out.append(f'{indent}:do {{ /ip firewall address-list remove [find list="{lst}" comment="{tag}"] }} on-error={{}}')
                for ip in ips:
                    out.append(f'{indent}:do {{ /ip firewall address-list add list={lst} address={ip} timeout=1d comment="{tag}" }} on-error={{}}')
                continue
            new = re.sub(r"\bname=(\"[^\"]+\"|\S+)\s*", "", line)
            new = new.replace("match-subdomain=yes", f'regexp="{dns_re(name)}"')
            new = re.sub(r"\btype=NXDOMAIN\b", "address=0.0.0.0", new)
            new = re.sub(r"\s+address-list=\S+|\s+address-list-timeout=\S+", "", new)
            out.append(new)
            continue
        if "/certificate import" in line and "name=" in line:
            line = re.sub(r"\s+name=\S+", "", line)
        out.append(line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


def _v4(ip):
    try:
        return ipaddress.ip_address(ip).version == 4 and not ipaddress.ip_address(ip).is_private
    except ValueError:
        return False


def check(text):
    """-> [(line number, what)] for RouterOS-7-only words still in a script"""
    bad = []
    for n, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if s.startswith("#"):
            continue
        for rx, what in V7_ONLY:
            if rx.search(s):
                bad.append((n, what))
    return bad


def db_resolver(cnf, dbname):
    """addresses of a name and its sub-names from the DNS log (ml_domain, last 14 days) + the server's own lookup"""
    import socket
    try:
        import pymysql
        c = pymysql.connect(read_default_file=cnf, database=dbname, charset="utf8mb4")
    except Exception:  # noqa: BLE001 — no database: only the live lookup
        c = None

    def resolve(name):
        ips = set()
        if c:
            with c.cursor() as cur:
                cur.execute("SELECT ips FROM ml_domain WHERE (host=%s OR host LIKE %s) AND last_seen >= NOW() - INTERVAL 14 DAY LIMIT 500",
                            (name, "%." + name))
                for (v,) in cur.fetchall():
                    ips.update(x.strip() for x in re.split(r"[,\s]+", v or "") if x.strip())
        for h in (name, "www." + name):
            try:
                ips.update(a[4][0] for a in socket.getaddrinfo(h, 443, socket.AF_INET, socket.SOCK_STREAM))
            except OSError:
                pass
        return list(ips)
    return resolve


def main():
    a = sys.argv[1:]
    if a and a[0] == "convert":
        opt = lambda k, d: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
        resolve = db_resolver(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius")) if "--cnf" in a else (lambda n: [])
        sys.stdout.write(convert(sys.stdin.read(), resolve))
        return 0
    if a and a[0] == "check":
        rc = 0
        for f in a[1:]:
            bad = check(open(f, encoding="utf-8").read())
            for n, what in bad[:20]:
                print(f"{f}:{n}: {what}")
            rc |= bool(bad)
            if not bad:
                print(f"ok   {f} (RouterOS 6)")
        return rc
    print(__doc__)
    return 1


if __name__ == "__main__":
    sys.exit(main())
