# MikrotikLover RADIUS — WPA2/WPA3-Enterprise on the RouterOS 7 "wifi" package
# (hAP ax2/ax3, cAP ax, Audience/hAP ac^2 with wifi-qcom-ac, RouterOS 7.13+)
#
# Replace before importing:
#   RADIUS_SERVER_IP   IP of the RADIUS server (or its WireGuard IP)
#   RADIUS_SECRET      secret you gave to: radius-admin nas add <router-ip> <secret>
#   Office-WiFi        your SSID
# Import:  /import file-name=wpa-enterprise-wifi-ros7.rsc

/radius
add address=RADIUS_SERVER_IP secret="RADIUS_SECRET" service=wireless timeout=3s comment="MikrotikLover RADIUS"
/radius incoming
set accept=yes

/interface wifi security
add name=sec-enterprise authentication-types=wpa2-eap eap-accounting=yes
# Only-new devices?  use authentication-types=wpa2-eap,wpa3-eap

/interface wifi configuration
add name=cfg-enterprise ssid="Office-WiFi" security=sec-enterprise country=Pakistan mode=ap

/interface wifi
set [find default-name=wifi1] configuration=cfg-enterprise disabled=no
set [find default-name=wifi2] configuration=cfg-enterprise disabled=no
