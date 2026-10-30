# MikrotikLover RADIUS — Passpoint (Hotspot 2.0) on the RouterOS 7 "wifi" package
# (hAP ax2/ax3, cAP ax, Audience/hAP ac^2 with wifi-qcom-ac, RouterOS 7.13+)
#
# Passpoint: a phone with the company profile (radius-admin passpoint profile USER) joins this Wi-Fi by
# itself — no network to pick, no password to type, on every office / branch that has this script.
# The login is WPA2-Enterprise (EAP-TTLS) against this RADIUS server, like the staff Wi-Fi.
#
# Easiest: radius-admin passpoint router ROUTER-IP  (prints this script filled in), or the dashboard
# (Router setup → Passpoint). By hand, replace before importing:
#   RADIUS_SERVER_IP   IP of the RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret you gave to: radius-admin nas add <router-ip> <secret>
#   Office-Passpoint   the Wi-Fi name (phones show it after they joined)
#   wifi.example.com   Passpoint domain — the same as: radius-admin passpoint set --domain ...
#   Your Company       operator name (shown on some phones)
# Import:  /import file-name=passpoint-wifi-ros7.rsc
# A virtual AP is added on every radio (the radios' own Wi-Fi stays as it is). Import again = updated.

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

# old copy (importing again)
/interface wifi
remove [find name~"-passpoint\$"]
/interface wifi configuration
remove [find name="cfg-passpoint"]
/interface wifi security
remove [find name="sec-passpoint"]
/interface wifi interworking
remove [find name="ml-passpoint"]

# what the Wi-Fi tells phones before they join (ANQP): the domain finds the profile on the phone
/interface wifi interworking
add name=ml-passpoint hotspot20=yes hotspot20-dgaf=no network-type=private internet=yes \
    venue=business-professional-office venue-names="Office:eng" operator-names="Your Company:eng" \
    domain-names=wifi.example.com realms=wifi.example.com:not-specified \
    ipv4-availability=single-nated ipv6-availability=not-available wan-status=up

/interface wifi security
add name=sec-passpoint authentication-types=wpa2-eap eap-accounting=yes management-protection=allowed
/interface wifi configuration
add name=cfg-passpoint ssid="Office-Passpoint" security=sec-passpoint interworking=ml-passpoint country=Pakistan mode=ap

# one virtual AP on each radio (wifi1, wifi2, ...); a router without radios is left as it is
:foreach r in=[/interface wifi find where default-name~"^wifi"] do={
    /interface wifi add master-interface=$r configuration=cfg-passpoint name=([/interface wifi get $r name] . "-passpoint") disabled=no
}
