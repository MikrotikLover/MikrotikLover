# MikrotikLover web filter — block VPN / Tor PROTOCOLS (needs webfilter-base.rsc)
# webfilter-vpn-proxy.rsc blocks VPN *websites*; this blocks the common VPN *connections*
# so an already-installed VPN app cannot bypass the filter.
# Devices in web-filter-exempt (IT, managers, office VPN users) are not affected.
#
# NOT blockable this way: VPNs that hide inside HTTPS on port 443 (Psiphon, some
# "stealth" modes). For those use allow-only profiles or the vpn-proxy category.
# IPsec (500/4500) is blocked too — remove those two rules if staff use an office IPsec VPN.
# Remove again: /ip firewall filter remove [find comment~"^webfilter:vpn"]

/ip firewall filter
remove [find comment~"^webfilter:vpn"]
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=udp dst-port=1194,51820,51821,1701,1197,1198 action=drop comment="webfilter:vpn OpenVPN/WireGuard/L2TP"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=1194,1723,1197,1198 action=reject reject-with=tcp-reset comment="webfilter:vpn OpenVPN-TCP/PPTP"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=gre action=drop comment="webfilter:vpn PPTP GRE"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=udp dst-port=500,4500 action=drop comment="webfilter:vpn IPsec"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=ipsec-esp action=drop comment="webfilter:vpn IPsec ESP"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=9001,9030,9050,9150 action=reject reject-with=tcp-reset comment="webfilter:vpn Tor"
move [find comment~"^webfilter:vpn"] destination=0
