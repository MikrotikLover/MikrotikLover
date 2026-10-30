# MikrotikLover RADIUS — WPA2-Enterprise on the legacy "wireless" package
# (RouterOS 6.x and RouterOS 7 devices with wlan1/wlan2: hAP lite, hAP ac lite, cAP ac, SXT, ...)
#
# Replace before importing:
#   RADIUS_SERVER_IP   IP of the RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret you gave to: radius-admin nas add <router-ip> <secret>
#   Office-WiFi        your SSID
# Import:  /import file-name=wpa-enterprise-wireless-legacy.rsc

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

:if ([:len [/interface wireless security-profiles find name="enterprise"]] = 0) do={ /interface wireless security-profiles add name=enterprise }
/interface wireless security-profiles
set [find name="enterprise"] mode=dynamic-keys authentication-types=wpa2-eap eap-methods=passthrough \
    unicast-ciphers=aes-ccm group-ciphers=aes-ccm radius-eap-accounting=yes

/interface wireless
set [find default-name=wlan1] security-profile=enterprise ssid="Office-WiFi" mode=ap-bridge disabled=no
# 5 GHz radio (if present):
# set [find default-name=wlan2] security-profile=enterprise ssid="Office-WiFi" mode=ap-bridge disabled=no

# Per-group VLAN from RADIUS (radius-admin group add ... --vlan 20) needs:
# set [find default-name=wlan1] vlan-mode=use-tag
