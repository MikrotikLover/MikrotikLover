#!/usr/bin/env python3
r"""RouterOS 7 script -> RouterOS 6 script (the same rules, the v6 way). RouterOS 6.47 or newer.

RouterOS 6 stops a whole /import at a line it cannot read (a property or menu it does not know is a syntax error,
which :do / on-error does not catch), so the server makes a v6 copy of every router file instead of hoping:

  /ip dns static ... match-subdomain=yes type=NXDOMAIN   ->  regexp="(^|\\.)name\$" address=0.0.0.0
  /ip dns static ... match-subdomain=yes                 ->  regexp="(^|\\.)name\$"   (type=FWD needs 6.47+)
  ... type=FWD forward-to=... address-list=L              ->  the addresses of that name and its sub-names, as the
                                                              server's DNS log and its own lookup saw them, put in
                                                              list L (1 day; the server rebuilds the file hourly)
  /ip dns adlist                                         ->  left out (RouterOS 7.15+; the name rules still work)
  /interface wifi ...                                    ->  left out (RouterOS 7 Wi-Fi; v6 uses /interface wireless)
  /certificate import ... name=X                         ->  without name= (the name then starts with the file name)
  /ipv6 ...                                              ->  run only when the ipv6 package is on (it is off by default
                                                              on RouterOS 6, and then the menu does not exist at all)

  rosv6.py convert [--cnf F --db D] < v7.rsc > v6.rsc
  rosv6.py check FILE...                                  report RouterOS-7-only words left (exit 1 if any)
"""
import ipaddress
import re
import sys

V7_ONLY = [
    (re.compile(r"\bmatch-subdomain="), "match-subdomain (DNS static, RouterOS 7)"),
    (re.compile(r"\btype=FWD\b.*\baddress-list=|\baddress-list=\S+.*\btype=FWD\b"), "DNS static address-list (RouterOS 7)"),
    (re.compile(r"^/ip dns adlist\b"), "/ip dns adlist (RouterOS 7.15+)"),
    (re.compile(r"^/interface wifi\b"), "/interface wifi (RouterOS 7 Wi-Fi)"),
    (re.compile(r"/certificate import\b.*(?<![\w-])name="), "certificate import name= (RouterOS 7)"),
    (re.compile(r"^/ipv6\b"), "/ipv6 outside the package check (RouterOS 6: package often off)"),
    (re.compile(r"(^|[\s\[{;(])/(ip|interface|system|tool|routing|user|certificate|snmp|queue|ppp)/[a-z]"), "slash path /a/b (RouterOS 7)"),
    (re.compile(r":(convert|serialize|deserialize|jobname|onerror|retry)\b"), "RouterOS 7 script command"),
]

MENU_RE = re.compile(r"^(/[a-z][a-z0-9 -]*?)\s*$")


def dns_re(name):
    r"""name and every sub-name, as a RouterOS 6 DNS regexp, written for a RouterOS string: (^|\\.)www\\.example\\.com\$
    (a RouterOS string knows only a few escapes, so the regexp's \. is written \\. and the end $ as \$)"""
    if not re.match(r"^[A-Za-z0-9_.*-]+$", name):
        raise ValueError(f"not a DNS name: {name!r}")
    return "(^|\\\\.)" + name.replace(".", "\\\\.").replace("*", "[^.]*") + "\\$"


def ros_str(text):
    """text as a RouterOS string body (between double quotes)"""
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$").replace("\n", "\\n")


def _v4(ip):
    try:
        a = ipaddress.ip_address(ip)
        return a.version == 4 and a.is_global
    except ValueError:
        return False


def _dns_line(line, resolve):
    """one /ip dns static line with match-subdomain -> its v6 lines"""
    nm = re.search(r"\bname=(\"[^\"]+\"|\S+)", line)
    name = nm.group(1).strip('"') if nm else ""
    indent = line[:len(line) - len(line.lstrip())]
    try:
        rx = dns_re(name)
    except ValueError:
        return [f"{indent}# left out on RouterOS 6 (name not usable): {line.strip()[:80]}"]
    al = re.search(r"\baddress-list=(\S+)", line)
    if "type=FWD" in line and al:
        lst = al.group(1)
        cm = re.search(r'comment="([^"]*)"', line)
        tag = (cm.group(1) if cm else f"dns {name}") + " (v6)"
        ips = sorted({ip for ip in resolve(name) if _v4(ip)}, key=ipaddress.ip_address)[:200]
        out = [f"{indent}# {name}: RouterOS 6 cannot fill a list from DNS - the server puts in the {len(ips)} address(es) it saw",
               f'{indent}:do {{ /ip firewall address-list remove [find list="{lst}" comment="{tag}"] }} on-error={{}}']
        out += [f'{indent}:do {{ /ip firewall address-list add list={lst} address={ip} timeout=1d comment="{tag}" }} on-error={{}}'
                for ip in ips]
        return out
    new = re.sub(r"\bname=(\"[^\"]+\"|\S+)\s*", "", line)
    new = new.replace("match-subdomain=yes", f'regexp="{rx}"')
    new = re.sub(r"\btype=NXDOMAIN\b", "address=0.0.0.0", new)
    new = re.sub(r"\s+address-list=\S+|\s+address-list-timeout=\S+", "", new)
    return [new]


def _ipv6_block(lines):
    """an /ipv6 part: kept as text and run only when the ipv6 package is on"""
    src = "\n".join(lines).strip("\n")
    return ["# IPv6 part: only when the ipv6 package is on (RouterOS 6)",
            ':if ([:len [/system package find where name="ipv6" disabled=no]] > 0) do={',
            f'  :do {{ :local f [:parse "{ros_str(src)}"]; $f }} on-error={{ :log warning "ml: IPv6 part not applied" }}',
            "}"]


def convert(text, resolve=lambda name: []):
    out = []
    skip = False          # inside a menu RouterOS 6 does not have
    v6part = None         # lines of an /ipv6 part being collected
    for line in text.splitlines():
        s = line.strip()
        m = MENU_RE.match(s)
        starts_menu = bool(m) or (s.startswith("/") and not s.startswith(("/import", "/system script run")))
        if v6part is not None and starts_menu and not s.startswith("/ipv6"):
            out += _ipv6_block(v6part)
            v6part = None
        if starts_menu:
            skip = False
            if re.match(r"^/(ip dns adlist|interface wifi)\b", s):
                what = " ".join(s.split()[:3]) if s.startswith("/interface wifi") else "/ip dns adlist"
                out.append(f"# {what}: RouterOS 7 only - left out on RouterOS 6")
                skip = bool(m)        # a menu line: its add / set lines follow
                continue
            if s.startswith("/ipv6"):
                v6part = (v6part or []) + [line]
                continue
        if v6part is not None:
            if s and not s.startswith("#"):
                v6part.append(line)
            elif not s and v6part:
                v6part.append(line)
            continue
        if skip:
            if s and not s.startswith(("#", ":")):
                continue
            if s.startswith(":"):
                skip = False
        if "match-subdomain=yes" in line:
            out += _dns_line(line, resolve)
            continue
        if "/certificate import" in line and "name=" in line:
            line = re.sub(r"\s+name=\S+", "", line)
        out.append(line)
    if v6part is not None:
        out += _ipv6_block(v6part)
    return "\n".join(out) + ("\n" if text.endswith("\n") else "")


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


def db_resolver(cnf, dbname, wait=4.0):
    """addresses of a name and its sub-names from the DNS log (ml_domain, last 14 days) + the server's own lookup
    (lookups run side by side, at most `wait` seconds for each name)"""
    import socket
    from concurrent.futures import ThreadPoolExecutor, wait as fwait
    try:
        import pymysql
        c = pymysql.connect(read_default_file=cnf, database=dbname, charset="utf8mb4", connect_timeout=5)
    except Exception:  # noqa: BLE001 - no database: only the live lookup
        c = None
    pool = ThreadPoolExecutor(max_workers=4)

    def look(h):
        try:
            return {a[4][0] for a in socket.getaddrinfo(h, 443, socket.AF_INET, socket.SOCK_STREAM)}
        except OSError:
            return set()

    def resolve(name):
        ips = set()
        if c:
            try:
                with c.cursor() as cur:
                    cur.execute("SELECT ips FROM ml_domain WHERE (host=%s OR host LIKE %s) AND last_seen >= NOW() - INTERVAL 14 DAY "
                                "ORDER BY last_seen DESC LIMIT 500", (name, "%." + name))
                    for (v,) in cur.fetchall():
                        ips.update(x.strip() for x in re.split(r"[,\s]+", v or "") if x.strip())
            except Exception:  # noqa: BLE001 - table missing on an old install
                pass
        futs = [pool.submit(look, h) for h in (name, "www." + name)]
        done, _ = fwait(futs, timeout=wait)
        for f in done:
            ips.update(f.result())
        return list(ips)
    return resolve


def main():
    a = sys.argv[1:]
    if a and a[0] == "convert":
        def opt(k, d):
            return a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
        resolve = db_resolver(opt("--cnf", "/etc/mikrotiklover-radius/my.cnf"), opt("--db", "radius")) if "--cnf" in a else (lambda n: [])
        sys.stdout.write(convert(sys.stdin.read(), resolve))
        sys.stdout.flush()
        import os
        os._exit(0)           # do not wait for a DNS lookup that is still hanging
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
