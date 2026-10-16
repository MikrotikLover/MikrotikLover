# MikrotikLover — SECURITY on the router (RouterOS 7). Works with the server's security detective.
# Every hit is logged with a WF-... prefix to the RADIUS server (webfilter-logging.rsc), where
# "radius-admin security" and the dashboard (Security) show who attacked, what, and when.
#
#   port scanners      tcp port scans from the internet  -> address list ml-scanners (1 day), dropped, WF-scan
#   password guessing  4 new logins in a row to Winbox/SSH/Telnet/FTP/API within a minute
#                      -> address list ml-bruteforce (1 day), dropped, WF-brute
#   SYN flood          more than 100 half-open connections from one address -> ml-synflood (1 hour), WF-synflood
#   threat lists       botnet servers / hijacked / attacker networks (server: radius-admin security update)
#                      and attackers found by the server (radius-admin security autoblock on) arrive in the
#                      address lists ml-threats and ml-attackers through the auto-sync (autosync.rsc)
#                      -> dropped both ways and logged, WF-threat
# "Internet side" = everything that is not in interface list LAN. Remove again:
#   /ip firewall filter remove [find comment~"^mlsec:"]; /ip firewall raw remove [find comment~"^mlsec:"]

/ip firewall filter
remove [find comment~"^mlsec:"]
# known bad networks, both directions (a LAN device talking to one is probably infected)
add chain=forward src-address-list=ml-threats action=log log-prefix="WF-threat" limit=20/1m,10:packet comment="mlsec: threat in (log)"
add chain=forward src-address-list=ml-threats action=drop comment="mlsec: threat in"
add chain=forward dst-address-list=ml-threats action=log log-prefix="WF-threat" limit=20/1m,10:packet comment="mlsec: threat out (log)"
add chain=forward dst-address-list=ml-threats action=reject reject-with=icmp-admin-prohibited comment="mlsec: threat out"
add chain=input src-address-list=ml-threats action=drop comment="mlsec: threat to router"
add chain=input src-address-list=ml-attackers action=drop comment="mlsec: attacker to router"
add chain=forward src-address-list=ml-attackers action=drop comment="mlsec: attacker in"
# port scans from the internet
add chain=input in-interface-list=!LAN protocol=tcp psd=21,3s,3,1 action=add-src-to-address-list address-list=ml-scanners address-list-timeout=1d comment="mlsec: detect port scan"
add chain=forward in-interface-list=!LAN protocol=tcp psd=21,3s,3,1 action=add-src-to-address-list address-list=ml-scanners address-list-timeout=1d comment="mlsec: detect port scan"
add chain=input src-address-list=ml-scanners connection-state=new action=log log-prefix="WF-scan" limit=10/1m,5:packet comment="mlsec: scanner (log)"
add chain=input src-address-list=ml-scanners action=drop comment="mlsec: scanner"
add chain=forward src-address-list=ml-scanners in-interface-list=!LAN action=drop comment="mlsec: scanner"
# password guessing on the router's own logins (from anywhere but the LAN)
add chain=input in-interface-list=!LAN protocol=tcp dst-port=21,22,23,8291,8728,8729 connection-state=new src-address-list=ml-bf-3 action=add-src-to-address-list address-list=ml-bruteforce address-list-timeout=1d comment="mlsec: guessing 4"
add chain=input in-interface-list=!LAN protocol=tcp dst-port=21,22,23,8291,8728,8729 connection-state=new src-address-list=ml-bf-2 action=add-src-to-address-list address-list=ml-bf-3 address-list-timeout=1m comment="mlsec: guessing 3"
add chain=input in-interface-list=!LAN protocol=tcp dst-port=21,22,23,8291,8728,8729 connection-state=new src-address-list=ml-bf-1 action=add-src-to-address-list address-list=ml-bf-2 address-list-timeout=1m comment="mlsec: guessing 2"
add chain=input in-interface-list=!LAN protocol=tcp dst-port=21,22,23,8291,8728,8729 connection-state=new action=add-src-to-address-list address-list=ml-bf-1 address-list-timeout=1m comment="mlsec: guessing 1"
add chain=input src-address-list=ml-bruteforce connection-state=new action=log log-prefix="WF-brute" limit=10/1m,5:packet comment="mlsec: guessing (log)"
add chain=input src-address-list=ml-bruteforce action=drop comment="mlsec: guessing"
# SYN flood: too many half-open connections from one address
add chain=input in-interface-list=!LAN protocol=tcp tcp-flags=syn connection-state=new connection-limit=100,32 action=add-src-to-address-list address-list=ml-synflood address-list-timeout=1h comment="mlsec: detect SYN flood"
add chain=forward in-interface-list=!LAN protocol=tcp tcp-flags=syn connection-state=new connection-limit=100,32 action=add-src-to-address-list address-list=ml-synflood address-list-timeout=1h comment="mlsec: detect SYN flood"
add chain=input src-address-list=ml-synflood action=log log-prefix="WF-synflood" limit=10/1m,5:packet comment="mlsec: SYN flood (log)"
add chain=input src-address-list=ml-synflood action=drop comment="mlsec: SYN flood"
add chain=forward src-address-list=ml-synflood action=drop comment="mlsec: SYN flood"
# all of the above before the other rules (they only touch the listed / attacking addresses)
move [find comment~"^mlsec:"] destination=0

# drop the listed addresses before connection tracking (cheaper under attack)
/ip firewall raw
remove [find comment~"^mlsec:"]
add chain=prerouting src-address-list=ml-attackers action=drop comment="mlsec: attackers (raw)"
add chain=prerouting src-address-list=ml-synflood action=drop comment="mlsec: SYN flood (raw)"
