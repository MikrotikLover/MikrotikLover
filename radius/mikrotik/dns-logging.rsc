# MikrotikLover — send all LAN DNS through the RADIUS server's DNS logger
# ("radius-admin sites / history / live" reports which user opened which site).
#
# Server first:  sudo radius-admin dnslog on <this-router-ip>
# Replace RADIUS_SERVER_IP below, then import AFTER webfilter-base.rsc.
#
# IMPORTANT — the server must see the real client IP:
#   * server in ANOTHER subnet/VLAN than the clients, or reached over WireGuard (no masquerade);
#   * NOT in the same subnet as the clients (replies would bypass the router and DNS breaks).
# The server forwards every query back to this router, so all router DNS filters keep working.
# If the server goes down, netwatch switches DNS back to the router within ~30 s.
# Users in web-filter-exempt and in policies with their own dns (family...) are not logged.

/ip firewall nat
remove [find comment~"^dnslog:"]
add chain=dstnat in-interface-list=LAN src-address=!RADIUS_SERVER_IP protocol=udp dst-port=53 action=dst-nat to-addresses=RADIUS_SERVER_IP comment="dnslog: LAN DNS -> logger"
add chain=dstnat in-interface-list=LAN src-address=!RADIUS_SERVER_IP protocol=tcp dst-port=53 action=dst-nat to-addresses=RADIUS_SERVER_IP comment="dnslog: LAN DNS -> logger"
# Before the base "force router DNS" rules (after exempt/policy DNS rules)
:if ([:len [/ip firewall nat find comment="webfilter: force router DNS"]] > 0) do={
    :foreach r in=[/ip firewall nat find comment~"^dnslog:"] do={
        /ip firewall nat move $r destination=[:pick [/ip firewall nat find comment="webfilter: force router DNS"] 0]
    }
}

/tool netwatch
remove [find comment="dnslog"]
add host=RADIUS_SERVER_IP interval=30s timeout=2s comment="dnslog" \
    up-script="/ip firewall nat enable [find comment~\"^dnslog:\"]" \
    down-script="/ip firewall nat disable [find comment~\"^dnslog:\"]"
