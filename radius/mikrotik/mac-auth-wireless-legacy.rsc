# MikrotikLover RADIUS — MAC authentication on the legacy "wireless" package
# (RouterOS 6.x, and RouterOS 7 devices with wlan1: hAP lite, hAP ac lite, cAP ac, SXT, ...)
# For devices that cannot type a username/password: printers, CCTV/NVR, smart TVs, POS, IoT.
# Allow a device on the server:  radius-admin mac add aa:bb:cc:dd:ee:ff -g staff -d "Reception printer"
#
# Replace before importing:
#   RADIUS_SERVER_IP, RADIUS_SECRET, Devices-WiFi, DevicesWiFiKey123
# Import:  /import file-name=mac-auth-wireless-legacy.rsc
# A separate SSID (virtual AP on wlan1) with WPA2-PSK; every new device is checked against RADIUS by its MAC.

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless,hotspot timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

/interface wireless security-profiles
remove [find name="ml-devices"]
add name=ml-devices mode=dynamic-keys authentication-types=wpa2-psk wpa2-pre-shared-key="DevicesWiFiKey123" \
    radius-mac-authentication=yes radius-mac-accounting=yes radius-mac-mode=as-username radius-mac-format=XX:XX:XX:XX:XX:XX
/interface wireless
remove [find name="wlan-devices"]
add master-interface=[find default-name=wlan1] ssid="Devices-WiFi" security-profile=ml-devices name=wlan-devices disabled=no
