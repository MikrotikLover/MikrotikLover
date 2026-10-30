# MikrotikLover — send Traffic Flow (IPFIX) to the RADIUS server
# ("radius-admin traffic": download/upload per website, per client IP, per user)
#
# Server first:  sudo radius-admin traffic collector on   (+ radius-admin dnslog on ROUTER_IP for site names)
# Replace RADIUS_SERVER_IP (or its WireGuard IP). UDP 2055 must reach the server.
# The collector finds the LAN client from the pre- and post-NAT addresses in each record and
# drops the duplicate when the same packets are reported on two interfaces.
# CPU: Traffic Flow costs some router CPU; on small routers set interfaces=<LAN bridge>.

/ip traffic-flow
set enabled=yes interfaces=all active-flow-timeout=1m inactive-flow-timeout=15s

/ip traffic-flow target
remove [find dst-address=RADIUS_SERVER_IP]
add dst-address=RADIUS_SERVER_IP port=2055 version=ipfix

# Fasttracked packets skip Traffic Flow, so with fasttrack on most download bytes are never
# counted. Disabled here for correct numbers (more router CPU on busy links). To undo:
#   /ip firewall filter enable [find action=fasttrack-connection]
/ip firewall filter
disable [find action=fasttrack-connection]
