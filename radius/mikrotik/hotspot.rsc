# MikrotikLover RADIUS — Hotspot (captive portal) login with RADIUS users
# Run "/ip hotspot setup" first if you have no hotspot yet; it creates profile "hsprof1".
#
# Replace before importing:
#   RADIUS_SERVER_IP   IP of the RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret you gave to: radius-admin nas add <router-ip> <secret>
# Import:  /import file-name=hotspot.rsc
#
# Hotspot CHAP login needs the cleartext password in RADIUS — create hotspot users
# WITHOUT --nt-hash.

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=hotspot timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

/ip hotspot profile
set [find name=hsprof1] use-radius=yes radius-accounting=yes radius-interim-update=5m login-by=http-chap,cookie
