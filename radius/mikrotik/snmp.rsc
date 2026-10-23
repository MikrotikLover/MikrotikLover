# SNMP for the server's Devices page (Devices -> this router: CPU, temperature, ports, traffic)
# Read-only, only for the server; traps (port down / up, restart, too hot) go to the server at once.
# Replace RADIUS_SERVER_IP and SNMP_COMMUNITY - the dashboard does it for you (Router setup -> SNMP).
# The router's own 'public' community stays as it is (other tools may use it); limit it: /snmp community print
:do { /snmp community remove [find name="SNMP_COMMUNITY"] } on-error={}
/snmp community
add name=SNMP_COMMUNITY addresses=RADIUS_SERVER_IP/32 read-access=yes write-access=no
/snmp
set enabled=yes trap-community=SNMP_COMMUNITY trap-target=RADIUS_SERVER_IP trap-version=2 trap-generators=interfaces,start-trap,temp-exception trap-interfaces=all
