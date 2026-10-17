#!/usr/bin/env python3
"""Network control: the minute report every router sends (autosync.rsc, script ml-stats).

The router POSTs plain text lines:
    id=Office-hAP            ver=7.16.2 (stable)     board=hAP ax^2
    cpu=7                    up=3d04:11:09           mem=812000000/1073741824     hdd=96000000/134217728
    if=ether1|true|false|123456|7890|ether            (name|running|disabled|rx bytes|tx bytes|type)
    nw=8.8.8.8|up|ml-internet                          (netwatch host|status|comment)
    hs=12   ppp=40   dhcp=63                           (hotspot users, PPPoE users, DHCP leases)
parse() turns it into a dict; rates() adds bits/second per interface from the previous report.
"""
import re

MAX_IF, MAX_NW = 64, 16
NAME_RE = re.compile(r"^[\w .:@/+()-]{1,64}$")


def _int(s, default=0):
    try:
        return max(0, int(str(s).strip()))
    except (TypeError, ValueError):
        return default


def _pair(s):
    a, _, b = str(s).partition("/")
    return _int(a), _int(b)


def parse(text):
    """-> dict, or raises ValueError for something that is not a router report."""
    d = {"identity": "", "version": "", "board": "", "uptime": "", "cpu": 0, "mem_free": 0, "mem_total": 0,
         "hdd_free": 0, "hdd_total": 0, "hotspot": 0, "ppp": 0, "dhcp": 0, "interfaces": [], "links": []}
    for line in str(text).splitlines()[:400]:
        k, sep, v = line.partition("=")
        if not sep:
            continue
        k, v = k.strip(), v.strip()
        if k == "id":
            d["identity"] = v[:64]
        elif k == "ver":
            d["version"] = v[:64]
        elif k == "board":
            d["board"] = v[:64]
        elif k == "up":
            d["uptime"] = v[:32]
        elif k == "cpu":
            d["cpu"] = min(_int(v), 100)
        elif k == "mem":
            d["mem_free"], d["mem_total"] = _pair(v)
        elif k == "hdd":
            d["hdd_free"], d["hdd_total"] = _pair(v)
        elif k in ("hs", "ppp", "dhcp"):
            d[{"hs": "hotspot"}.get(k, k)] = _int(v)
        elif k == "if" and len(d["interfaces"]) < MAX_IF:
            p = v.split("|")
            if len(p) >= 5 and NAME_RE.match(p[0]):
                d["interfaces"].append({"name": p[0], "running": p[1] == "true", "disabled": p[2] == "true",
                                        "rx": _int(p[3]), "tx": _int(p[4]), "type": (p[5] if len(p) > 5 else "")[:24]})
        elif k == "nw" and len(d["links"]) < MAX_NW:
            p = v.split("|")
            if len(p) >= 2 and re.match(r"^[\w.:-]{1,64}$", p[0]):
                d["links"].append({"host": p[0], "status": "up" if p[1] == "up" else "down" if p[1] == "down" else "unknown",
                                   "comment": (p[2] if len(p) > 2 else "")[:64]})
    if not d["identity"] or not NAME_RE.match(d["identity"]):
        raise ValueError("no router identity")
    return d


def rates(cur, prev, seconds):
    """Bits per second per interface from two reports `seconds` apart (counter reset -> 0)."""
    old = {i["name"]: i for i in (prev or [])}
    for i in cur:
        o = old.get(i["name"])
        if o and 0 < seconds < 3600:
            i["rx_bps"] = max(0, i["rx"] - o.get("rx", 0)) * 8 // int(seconds) if i["rx"] >= o.get("rx", 0) else 0
            i["tx_bps"] = max(0, i["tx"] - o.get("tx", 0)) * 8 // int(seconds) if i["tx"] >= o.get("tx", 0) else 0
        else:
            i["rx_bps"] = i["tx_bps"] = 0
    return cur


def busiest(interfaces):
    """(rx_bps, tx_bps) of the running interface with the most traffic (usually the internet uplink)."""
    best = max((i for i in interfaces if i.get("running")), key=lambda i: i.get("rx_bps", 0) + i.get("tx_bps", 0), default=None)
    return (best.get("rx_bps", 0), best.get("tx_bps", 0)) if best else (0, 0)
