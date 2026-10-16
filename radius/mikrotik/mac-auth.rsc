# MikrotikLover RADIUS — MAC authentication
# For devices that cannot type a username/password: printers, CCTV/NVR, smart TVs, POS, IoT.
# Allow a device on the server:  radius-admin mac add aa:bb:cc:dd:ee:ff -g staff -d "Reception printer"
#
# Replace before importing:
#   RADIUS_SERVER_IP, RADIUS_SECRET, Devices-WiFi, DevicesWiFiKey123
# Use ONE of the sections below (delete the others) and import:
#   /import file-name=mac-auth.rsc

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless,hotspot timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

# ---- A) RouterOS 7 "wifi" package (RouterOS 7.13+): every new client is checked against RADIUS.
#      A separate SSID for devices with WPA2-PSK + MAC check is recommended.
/interface wifi security
add name=sec-devices authentication-types=wpa2-psk passphrase="DevicesWiFiKey123"
/interface wifi configuration
add name=cfg-devices ssid="Devices-WiFi" security=sec-devices country=Pakistan mode=ap
/interface wifi access-list
add action=query-radius ssid-regexp="^Devices-WiFi\$" comment="MikrotikLover MAC auth"
# Add the SSID as a virtual AP on the 2.4 GHz radio:
/interface wifi
add master-interface=[find default-name=wifi2] configuration=cfg-devices name=wifi-devices disabled=no

# ---- B) Legacy "wireless" package (RouterOS 6/7, wlan1): MAC check + WPA2-PSK
# /interface wireless security-profiles
# add name=mac-auth mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key="DevicesWiFiKey123" \
#     radius-mac-authentication=yes radius-mac-accounting=yes radius-mac-mode=as-username radius-mac-format=XX:XX:XX:XX:XX:XX
# /interface wireless
# add master-interface=wlan1 ssid="Devices-WiFi" security-profile=mac-auth name=wlan-devices disabled=no

# ---- C) Hotspot: known devices skip the login page (others still see it)
# /ip hotspot profile
# set [find name=hsprof1] use-radius=yes login-by=mac,http-chap,cookie mac-auth-mode=mac-as-username
