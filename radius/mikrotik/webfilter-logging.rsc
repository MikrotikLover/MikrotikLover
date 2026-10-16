# MikrotikLover — send web-filter blocks to the RADIUS server ("radius-admin blocked" report)
# Replace RADIUS_SERVER_IP (or its WireGuard IP). Server listens on UDP 514 (install.sh sets it up).
# Firewall lines with prefix "WF-..." are stored on the server (blocked report, VPN watch, security),
# and the router's login failures (security detective: password guessing on Winbox / SSH / web).

/system logging action
remove [find name="mikrotiklover"]
add name=mikrotiklover target=remote remote=RADIUS_SERVER_IP remote-port=514

/system logging
remove [find action="mikrotiklover"]
add topics=firewall action=mikrotiklover
add topics=system,critical action=mikrotiklover
add topics=account action=mikrotiklover

# Optional: keep the router's own memory log free of firewall lines:
#   /system logging set [find where action=memory and topics~"info"] topics=info,!firewall
