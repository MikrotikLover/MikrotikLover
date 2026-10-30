#!/usr/bin/env python3
"""Port / protocol names and "who started the connection" for the traffic collector and reports.

service(proto, client_port, remote_port) decides which side is the *service* port:
  well-known (< 1024 or in the table below)  <  registered (< 32768)  <  ephemeral (>= 32768)
  remote side is the service  -> "out"  (a LAN device connected to something on the internet)
  LAN side is the service     -> "in"   (the internet connected to a LAN device: port-forward, DVR, server)
  both ephemeral               -> "p2p"  (calls, games, torrents)
"""

PROTO = {1: "icmp", 6: "tcp", 17: "udp", 47: "gre", 50: "esp", 51: "ah", 58: "icmpv6", 132: "sctp"}

_NAMES = {
    # (proto, port): name    proto None = both tcp and udp
    (None, 20): "FTP data", (6, 21): "FTP", (6, 22): "SSH", (6, 23): "Telnet", (6, 25): "SMTP (mail)",
    (None, 53): "DNS", (17, 67): "DHCP", (17, 68): "DHCP", (17, 69): "TFTP", (6, 80): "HTTP (web)",
    (6, 110): "POP3 (mail)", (17, 123): "NTP (time)", (6, 143): "IMAP (mail)", (17, 161): "SNMP",
    (6, 179): "BGP", (6, 443): "HTTPS (web, apps)", (17, 443): "QUIC / HTTP3 (YouTube, Google, Meta apps)",
    (6, 465): "SMTPS (mail)", (17, 500): "IPsec VPN", (6, 554): "RTSP (camera stream)", (6, 587): "SMTP submit (mail)",
    (6, 853): "DNS-over-TLS", (17, 853): "DNS-over-QUIC", (6, 993): "IMAPS (mail)", (6, 995): "POP3S (mail)",
    (None, 1194): "OpenVPN", (17, 1701): "L2TP VPN", (6, 1723): "PPTP VPN", (None, 1812): "RADIUS auth",
    (None, 1813): "RADIUS accounting", (6, 1935): "RTMP (live streaming)", (None, 3074): "Xbox Live",
    (6, 3306): "MySQL", (6, 3389): "RDP (remote desktop)", (None, 3478): "STUN/TURN (voice & video calls)",
    (None, 3479): "STUN/TURN (calls)", (None, 3480): "STUN/TURN (calls)", (17, 3799): "RADIUS CoA",
    (17, 4500): "IPsec NAT-T VPN", (6, 5060): "SIP (VoIP)", (17, 5060): "SIP (VoIP)", (6, 5061): "SIP-TLS (VoIP)",
    (6, 5222): "XMPP / WhatsApp chat", (6, 5223): "Apple push (APNs)", (6, 5228): "Google push (FCM)",
    (6, 5229): "Google push", (6, 5230): "Google push", (6, 5432): "PostgreSQL", (6, 5900): "VNC (remote desktop)",
    (6, 6379): "Redis", (None, 6881): "BitTorrent", (None, 6882): "BitTorrent", (None, 6889): "BitTorrent",
    (6, 8000): "HTTP-alt / Hikvision", (6, 8080): "HTTP-alt (proxy)", (6, 8291): "Winbox (MikroTik)",
    (6, 8443): "HTTPS-alt", (6, 8728): "MikroTik API", (6, 8729): "MikroTik API-SSL", (6, 8888): "HTTP-alt",
    (6, 9001): "Tor", (6, 9030): "Tor", (17, 19302): "Google Meet / STUN", (17, 19305): "Google Meet",
    (6, 25565): "Minecraft", (None, 27015): "Steam / Source games", (6, 27017): "MongoDB",
    (6, 34567): "XMeye DVR (camera)", (6, 37777): "Dahua DVR (camera)", (17, 37778): "Dahua DVR",
    (None, 51820): "WireGuard VPN", (17, 1900): "SSDP / UPnP", (17, 5353): "mDNS",
}
_RANGES = [  # (proto, low, high, name)
    (17, 8801, 8810, "Zoom media"), (None, 6881, 6999, "BitTorrent"), (17, 10000, 10100, "PUBG / game servers"),
    (17, 16384, 16484, "RTP voice (VoIP)"), (17, 50000, 50059, "Microsoft Teams media"),
    (17, 49152, 49160, "PUBG Mobile"), (17, 7000, 7999, "Game servers (UDP)"),
]


def proto_name(p):
    return PROTO.get(int(p or 0), str(p))


def name(proto, port):
    proto, port = int(proto or 0), int(port or 0)
    if proto not in (6, 17):
        return {1: "ICMP (ping)", 47: "GRE (PPTP VPN)", 50: "ESP (IPsec VPN)"}.get(proto, proto_name(proto))
    n = _NAMES.get((proto, port)) or _NAMES.get((None, port))
    if n:
        return n
    for p, lo, hi, nm in _RANGES:
        if (p is None or p == proto) and lo <= port <= hi:
            return nm
    if port >= 32768:
        return "high port (calls, games, P2P)"
    return ""


def _rank(proto, port):
    if (proto, port) in _NAMES or (None, port) in _NAMES or port < 1024:
        return 0
    if any((p is None or p == proto) and lo <= port <= hi for p, lo, hi, _ in _RANGES):
        return 0
    return 1 if port < 32768 else 2


def service(proto, client_port, remote_port):
    """-> (direction 'out'|'in'|'p2p', service_port)."""
    proto, cp, rp = int(proto or 0), int(client_port or 0), int(remote_port or 0)
    if proto not in (6, 17, 132):
        return "out", 0
    rc, rr = _rank(proto, cp), _rank(proto, rp)
    if rr < rc:
        return "out", rp
    if rc < rr:
        return "in", cp
    if rr == 2:
        return "p2p", rp
    return "out", rp


def human(n):
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024


def table_from_tsv(stdin):
    """radius-admin ports: TSV with a header (proto, port, bytes columns) -> readable table."""
    rows = [l.rstrip("\n").split("\t") for l in stdin if l.strip()]
    if len(rows) < 2:
        print("No data yet (traffic collector + router traffic-flow).")
        return
    hdr, out = rows[0], []
    for r in rows[1:]:
        d = dict(zip(hdr, r))
        row = []
        for h in hdr:
            v = d[h]
            if h == "proto":
                v = proto_name(v)
            elif h in ("down", "up", "bytes", "total"):
                v = human(v)
            elif h == "direction":
                v = v.upper()
            row.append(v if v != "NULL" else "-")
            if h == "port":
                row.append(name(d.get("proto"), d.get("port")) or "-")
        out.append(row)
    cols = []
    for h in hdr:
        cols.append(h)
        if h == "port":
            cols.append("service")
    w = [max(len(str(x[i])) for x in out + [cols]) for i in range(len(cols))]
    print("  ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    for r in out:
        print("  ".join(str(v).ljust(w[i]) for i, v in enumerate(r)))


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "table":
        table_from_tsv(sys.stdin)
    elif len(sys.argv) == 3:
        print(name(sys.argv[1], sys.argv[2]))
