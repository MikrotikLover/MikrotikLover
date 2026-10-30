#!/usr/bin/env python3
"""The whole network as a tree: Internet -> routers -> switches -> APs -> computers / phones / devices.

Made from what the switches tell over SNMP (tools/snmp.py, every 5 minutes):
  - their MAC tables: which MAC is behind which port
  - LLDP: which device is next door on which port
  - every device's own MAC addresses
and from who is logged in (MAC + IP). Nothing here talks to the network; build() is a pure function.

A MAC seen by several switches hangs on the switch whose port sees the fewest MACs (the nearest one: an uplink port sees
everything behind it). A computer behind an AP (Wi-Fi) shows up on the switch port where the AP is plugged in, so it is
put under that AP.
"""

ROOT = "internet"
BRIDGES = ("ap", "switch", "mikrotik")              # devices that pass other devices' traffic (an AP's Wi-Fi clients …)


def build(routers, devices, fdb, lldp, people, max_people=60):
    """
    routers: [{ip, name, online}]                       — the RADIUS clients (NAS)
    devices: [{id, name, ip, kind, status, line, macs: [..]}]   — SNMP devices
    fdb:     [(device_id, ifindex, mac)]                — switch MAC tables
    lldp:    [{device_id, ifindex, name, ip, chassis}]  — LLDP neighbours
    people:  [{mac, name, ip, kind, nas, ...}]          — online logins (and MAC devices)
    ifname:  in devices[i]["ports"] = {ifindex: name}   (optional)
    -> {"nodes": [{id, type, parent, port, ...}], "unplaced": n}
    """
    dev = {f"d{d['id']}": d for d in devices}
    owner = {}
    for k, d in dev.items():
        for m in d.get("macs") or []:
            owner.setdefault(m, k)
    # port populations
    ports = {}                                         # (dev key, ifindex) -> set(mac)
    for did, ifx, mac in fdb:
        ports.setdefault((f"d{did}", int(ifx)), set()).add(mac)
    seen_on = {}                                       # mac -> [(dev key, ifindex)]
    for (k, ifx), macs in ports.items():
        for m in macs:
            seen_on.setdefault(m, []).append((k, ifx))

    def nearest(macs, not_on=None):
        """(switch, port) with the fewest MACs that sees any of these MACs."""
        best = None
        for m in macs:
            for (k, ifx) in seen_on.get(m, []):
                if k == not_on:
                    continue
                n = len(ports[(k, ifx)])
                if best is None or n < best[0] or (n == best[0] and (k, ifx) < best[1:]):
                    best = (n, k, ifx)
        return best and (best[1], best[2])

    def pname(k, ifx):
        return (dev.get(k, {}).get("ports") or {}).get(str(ifx)) or (f"port {ifx}" if ifx else "")

    # links between devices: LLDP first (both ends known), then the MAC tables
    edges = {}                                         # frozenset({a, b}) -> {a: port on a, b: port on b}
    by_ip = {d["ip"]: k for k, d in dev.items() if d.get("ip")}
    by_name = {(d.get("sysname") or d["name"]).lower(): k for k, d in dev.items()}
    for x in lldp:
        a = f"d{x['device_id']}"
        b = by_ip.get(x.get("ip") or "") or owner.get(x.get("chassis") or "") or by_name.get((x.get("name") or "").lower())
        if a in dev and b and b != a:
            e = edges.setdefault(frozenset((a, b)), {})
            e[a] = pname(a, x.get("ifindex") or 0)
    for k, d in dev.items():
        hit = nearest(d.get("macs") or [], not_on=k)
        if hit:
            edges.setdefault(frozenset((k, hit[0])), {}).setdefault(hit[0], pname(*hit))
    # routers: a router that is also an SNMP device (same IP) is that device
    nodes = {ROOT: {"id": ROOT, "type": "internet", "name": "Internet", "parent": None, "port": ""}}
    rkeys = []
    for r in routers:
        k = by_ip.get(r["ip"])
        if not k:
            k = f"r{r['ip']}"
            nodes[k] = {"id": k, "type": "router", "name": r["name"], "ip": r["ip"], "online": r.get("online", 0), "parent": ROOT, "port": ""}
        rkeys.append(k)
    adj = {}
    for e, prt in edges.items():
        a, b = tuple(e)
        adj.setdefault(a, []).append((b, prt))
        adj.setdefault(b, []).append((a, prt))
    # walk out from the routers (a loop in the cabling is cut where it is met second)
    placed = set()
    queue = []
    for k in rkeys:
        if k in dev:
            nodes[k] = {**_dnode(dev[k]), "parent": ROOT, "port": ""}
        placed.add(k)
        queue.append(k)
    roots_dev = [k for k in dev if dev[k]["kind"] in ("switch", "mikrotik") and k not in placed]
    while True:
        while queue:
            a = queue.pop(0)
            for b, prt in sorted(adj.get(a, []), key=lambda x: x[0]):
                if b in placed or b not in dev:
                    continue
                nodes[b] = {**_dnode(dev[b]), "parent": a, "port": prt.get(a, "")}
                placed.add(b)
                queue.append(b)
        # a switch not linked to anything we know: under the first router, link unknown
        rest = [k for k in roots_dev if k not in placed]
        if not rest:
            break
        k = rest[0]
        nodes[k] = {**_dnode(dev[k]), "parent": rkeys[0] if rkeys else ROOT, "port": "", "guess": True}
        placed.add(k)
        queue.append(k)
    for k in dev:                                     # devices nobody sees (printer on a dumb switch …)
        if k not in placed:
            nodes[k] = {**_dnode(dev[k]), "parent": rkeys[0] if rkeys else ROOT, "port": "", "guess": True}
            placed.add(k)
    # people: on the nearest switch port; behind an AP / switch that hangs on that port -> under it
    child_on = {}                                     # (parent, port name) -> child device key
    for k, n in nodes.items():
        if k in dev and n.get("parent") in dev and n.get("port"):
            child_on[(n["parent"], n["port"])] = k
    under = {}
    unplaced = 0
    for p in people:
        mac = p.get("mac") or ""
        if mac and mac in owner:                      # an SNMP device that also logs in: shown once, as the device
            continue
        hit = nearest([mac]) if mac else None
        if hit:
            par, port = hit
            via = child_on.get((par, pname(*hit)))
            if via and dev[via]["kind"] in BRIDGES:
                par, port = via, ""
            else:
                port = pname(*hit)
        else:
            nk = by_ip.get(p.get("nas") or "") or f"r{p.get('nas')}"
            par, port = (nk if nk in nodes else (rkeys[0] if rkeys else ROOT)), ""
            unplaced += 1
        under.setdefault(par, []).append({**p, "id": f"p{mac or p['name']}", "type": "person", "parent": par, "port": port})
    out = list(nodes.values())
    for par, lst in under.items():
        lst.sort(key=lambda x: (x.get("kind") != "mac", x["name"]))
        out += lst[:max_people]
        if len(lst) > max_people:
            out.append({"id": f"more-{par}", "type": "more", "parent": par, "port": "", "name": f"{len(lst) - max_people} more"})
    # MACs nobody knows, per switch port where they are nearest (counted, not listed)
    known = set(owner) | {p.get("mac") for p in people}
    unknown = {}
    for m in seen_on:
        if m in known:
            continue
        hit = nearest([m])
        if hit:
            via = child_on.get((hit[0], pname(*hit)))
            par = via if via and dev[via]["kind"] in BRIDGES else hit[0]
            unknown[par] = unknown.get(par, 0) + 1
    for par, n in unknown.items():
        if par in nodes:
            out.append({"id": f"u-{par}", "type": "unknown", "parent": par, "port": "", "name": f"{n} other device(s)", "count": n})
    return {"nodes": out, "unplaced": unplaced}


def _dnode(d):
    return {"id": f"d{d['id']}", "type": "device", "dev": d["id"], "kind": d["kind"], "name": d["name"], "ip": d.get("ip", ""),
            "status": d.get("status", ""), "line": d.get("line", ""), "dept": d.get("dept", "")}
