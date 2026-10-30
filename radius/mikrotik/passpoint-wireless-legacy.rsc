# MikrotikLover RADIUS — Passpoint (Hotspot 2.0) on the legacy "wireless" package
# (RouterOS 6.x, and RouterOS 7 devices with wlan1/wlan2: hAP ac lite, hAP ac², cAP ac, SXT, ...)
#
# Passpoint: a phone with the company profile (radius-admin passpoint profile USER) joins this Wi-Fi by
# itself — no network to pick, no password to type, on every office / branch that has this script.
# The login is WPA2-Enterprise (EAP-TTLS) against this RADIUS server, like the staff Wi-Fi.
#
# Easiest: radius-admin passpoint router ROUTER-IP --legacy  (prints this script filled in), or the dashboard.
# By hand, replace before importing:
#   RADIUS_SERVER_IP   IP of the RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret you gave to: radius-admin nas add <router-ip> <secret>
#   Office-Passpoint   the Wi-Fi name (phones show it after they joined)
#   wifi.example.com   Passpoint domain — the same as: radius-admin passpoint set --domain ...
#   Your Company       operator name (shown on some phones)
# Import:  /import file-name=passpoint-wireless-legacy.rsc
# A virtual AP is added on every radio (the radios' own Wi-Fi stays as it is). Import again = updated.

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

# old copy (importing again)
/interface wireless
remove [find name~"-passpoint\$"]
/interface wireless security-profiles
remove [find name="ml-passpoint"]
/interface wireless interworking-profiles
remove [find name="ml-passpoint"]

# what the Wi-Fi tells phones before they join (ANQP): the domain finds the profile on the phone
/interface wireless interworking-profiles
add name=ml-passpoint hotspot20=yes hotspot20-dgaf=no network-type=private internet=yes \
    venue=business-professional-office venue-names="Office:eng" operator-names="Your Company:eng" \
    domain-names=wifi.example.com realms=wifi.example.com:not-specified \
    ipv4-availability=single-nated ipv6-availability=not-available wan-status=up

/interface wireless security-profiles
add name=ml-passpoint mode=dynamic-keys authentication-types=wpa2-eap eap-methods=passthrough \
    unicast-ciphers=aes-ccm group-ciphers=aes-ccm radius-eap-accounting=yes

# one virtual AP on each radio (wlan1, wlan2, ...); a router without radios is left as it is
:foreach r in=[/interface wireless find where default-name~"^wlan"] do={
    /interface wireless add master-interface=$r ssid="Office-Passpoint" security-profile=ml-passpoint \
        interworking-profile=ml-passpoint name=([/interface wireless get $r name] . "-passpoint") disabled=no
}
