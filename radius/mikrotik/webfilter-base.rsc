# MikrotikLover web filter — BASE (import this first, once per router)
# RouterOS 7.15+.  Uses the default-config interface list "LAN".
#
# What it does
#   * forces every LAN device to use the router's DNS (port 53 redirect)
#   * blocks encrypted DNS that would bypass the filter (DoT 853, known DoH servers,
#     Firefox canary, iCloud Private Relay)
#   * devices in address list "web-filter-exempt" bypass the filter
#     (static entries, or hotspot users via RADIUS: radius-admin group add NAME --address-list web-filter-exempt)
#
# Then import the category files you want: webfilter-social.rsc, webfilter-adlists.rsc, ...
# Re-importing is safe: old webfilter entries are removed first.

/ip dns
set allow-remote-requests=yes
# Tip: servers=1.1.1.3,1.0.0.3 (Cloudflare Family) also blocks adult + malware upstream, using no router RAM.

/ip firewall address-list
remove [find comment="webfilter:doh-ip"]
:foreach a in={"1.1.1.1";"1.0.0.1";"1.1.1.2";"1.0.0.2";"1.1.1.3";"1.0.0.3";"8.8.8.8";"8.8.4.4";"9.9.9.9";"149.112.112.112";"9.9.9.11";"208.67.222.222";"208.67.220.220";"208.67.222.123";"208.67.220.123";"94.140.14.14";"94.140.15.15";"94.140.14.15";"94.140.15.16";"185.228.168.9";"185.228.169.9";"185.228.168.168";"45.90.28.0/24";"45.90.30.0/24";"76.76.2.0/24";"76.76.10.0/24";"194.242.2.0/24"} do={
    add list=doh-servers address=$a comment="webfilter:doh-ip"
}

/ip firewall nat
remove [find comment~"^webfilter:"]
add chain=dstnat in-interface-list=LAN src-address-list=web-filter-exempt protocol=udp dst-port=53 action=dst-nat to-addresses=1.1.1.1 comment="webfilter: exempt -> unfiltered DNS"
add chain=dstnat in-interface-list=LAN src-address-list=web-filter-exempt protocol=tcp dst-port=53 action=dst-nat to-addresses=1.1.1.1 comment="webfilter: exempt -> unfiltered DNS"
add chain=dstnat in-interface-list=LAN protocol=udp dst-port=53 action=redirect to-ports=53 comment="webfilter: force router DNS"
add chain=dstnat in-interface-list=LAN protocol=tcp dst-port=53 action=redirect to-ports=53 comment="webfilter: force router DNS"

/ip firewall filter
remove [find comment~"^webfilter:"]
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=853 action=reject reject-with=tcp-reset comment="webfilter: block DNS-over-TLS"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=udp dst-port=853 action=drop comment="webfilter: block DNS-over-QUIC"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt dst-address-list=doh-servers protocol=tcp dst-port=443 action=reject reject-with=tcp-reset comment="webfilter: block DNS-over-HTTPS"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt dst-address-list=doh-servers protocol=udp dst-port=443 action=drop comment="webfilter: block DNS-over-HTTP/3"
# Put the webfilter rules above any "accept LAN" rule.
move [find comment~"^webfilter:"] destination=0

# Encrypted-DNS hostnames
/ip dns static
remove [find comment="webfilter:doh"]
add name=dns.google type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns64.dns.google type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=cloudflare-dns.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=one.one.one.one type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.quad9.net type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=doh.opendns.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.adguard-dns.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.adguard.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.nextdns.io type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=doh.cleanbrowsing.org type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=doh.mullvad.net type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.mullvad.net type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=dns.controld.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=freedns.controld.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=use-application-dns.net type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=mask.icloud.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"
add name=mask-h2.icloud.com type=NXDOMAIN match-subdomain=yes comment="webfilter:doh"

# Encrypted DNS on servers that are not in doh-servers: reset HTTPS by server name (SNI)
/ip firewall filter
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.google" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.google" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns64.dns.google" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns64.dns.google" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="cloudflare-dns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.cloudflare-dns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="one.one.one.one" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.one.one.one.one" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.quad9.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.quad9.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="doh.opendns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.doh.opendns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.adguard-dns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.adguard-dns.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.adguard.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.adguard.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.nextdns.io" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.nextdns.io" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="doh.cleanbrowsing.org" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.doh.cleanbrowsing.org" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="doh.mullvad.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.doh.mullvad.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.mullvad.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.mullvad.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="dns.controld.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.dns.controld.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="freedns.controld.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.freedns.controld.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="use-application-dns.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.use-application-dns.net" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="mask.icloud.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.mask.icloud.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="mask-h2.icloud.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
add chain=forward in-interface-list=LAN src-address-list=!web-filter-exempt protocol=tcp dst-port=443 tls-host="*.mask-h2.icloud.com" action=reject reject-with=tcp-reset comment="webfilter: DoH by name"
move [find comment~"^webfilter:"] destination=0

# ---- IPv6: close the same bypasses (direct DNS, DoT, DoH) if your LAN has IPv6
/ipv6 firewall address-list
remove [find comment="webfilter:doh-ip"]
:foreach a in={"2606:4700:4700::1111";"2606:4700:4700::1001";"2606:4700:4700::1112";"2606:4700:4700::1002";"2606:4700:4700::1113";"2606:4700:4700::1003";"2001:4860:4860::8888";"2001:4860:4860::8844";"2620:fe::fe";"2620:fe::9";"2620:fe::11";"2620:119:35::35";"2620:119:53::53";"2a10:50c0::ad1:ff";"2a10:50c0::ad2:ff"} do={
    add list=doh-servers address=$a comment="webfilter:doh-ip"
}
/ipv6 firewall filter
remove [find comment~"^webfilter:"]
add chain=forward in-interface-list=LAN protocol=udp dst-port=53 action=drop comment="webfilter: v6 direct DNS (use router)"
add chain=forward in-interface-list=LAN protocol=tcp dst-port=53 action=reject reject-with=tcp-reset comment="webfilter: v6 direct DNS (use router)"
add chain=forward in-interface-list=LAN protocol=tcp dst-port=853 action=reject reject-with=tcp-reset comment="webfilter: v6 DNS-over-TLS"
add chain=forward in-interface-list=LAN protocol=udp dst-port=853 action=drop comment="webfilter: v6 DNS-over-QUIC"
add chain=forward in-interface-list=LAN dst-address-list=doh-servers protocol=tcp dst-port=443 action=reject reject-with=tcp-reset comment="webfilter: v6 DNS-over-HTTPS"
add chain=forward in-interface-list=LAN dst-address-list=doh-servers protocol=udp dst-port=443 action=drop comment="webfilter: v6 DNS-over-HTTP/3"
move [find comment~"^webfilter:"] destination=0
