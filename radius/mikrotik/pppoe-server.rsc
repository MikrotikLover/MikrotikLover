# MikrotikLover RADIUS — PPPoE server (ISP style: customers' routers dial in with username/password)
#
# Replace before importing:
#   RADIUS_SERVER_IP   RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret from: radius-admin nas add <router-ip>
#   ether2             the interface/bridge/VLAN towards the customers
#   10.20.0.x          customer IP range (also the pool name "pppoe-pool")
# Import:  /import file-name=pppoe-server.rsc
#
# Server side:
#   radius-admin plan add home-10m --price 1500 --validity 30d --quota 200G --period monthly --fup 2M/2M --rate 10M/10M --pool pppoe-pool
#   radius-admin user add ahmed -p 'Secret#1' && radius-admin user plan ahmed home-10m
#   radius-admin user ip ahmed 10.20.0.50          (optional static IP)

/ip pool
add name=pppoe-pool ranges=10.20.0.10-10.20.3.254

/ppp profile
add name=pppoe-radius local-address=10.20.0.1 remote-address=pppoe-pool dns-server=10.20.0.1 \
    use-encryption=no only-one=yes change-tcp-mss=yes comment="MikrotikLover PPPoE"

/interface pppoe-server server
add service-name=MikrotikLover interface=ether2 default-profile=pppoe-radius \
    authentication=pap,chap,mschap2 one-session-per-host=yes max-mtu=1480 max-mru=1480 disabled=no

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=ppp timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

# RADIUS login + accounting every 5 min (needed for data quota / FUP / reports)
/ppp aaa
set use-radius=yes accounting=yes interim-update=5m

# Customers get NATed to the internet like the LAN (default config uses the WAN list)
/interface list
set [find name=LAN] include=all-ppp
