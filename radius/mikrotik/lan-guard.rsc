# MikrotikLover — LAN GUARD: fake routers (rogue DHCP) and ARP spoofing (RouterOS 7; works on 6.4x)
# Works with the server's security detective (radius-admin security / dashboard → Security → Hacker attacks).
#
#   rogue DHCP   someone plugs in a home router or runs a fake DHCP server: phones get a wrong gateway
#                and all their traffic can be read. The router's DHCP alert notices the unknown server
#                and logs "dhcp alert on bridge: discovered unknown dhcp server, mac .., ip .."
#   ARP spoofing a device pretends to be other devices ("man in the middle", tools like ettercap/arpspoof
#                or WiFi-killer apps). The script ml-arp-watch looks at the ARP table every minute:
#                  an address whose device (MAC) suddenly changes  -> "ML-ARP changed ip=.. old=.. new=.."
#                  one device answering for many addresses        -> "ML-ARP many-ips mac=.. ip=.. ips=N"
# The logs go to the server with webfilter-logging.rsc (topics dhcp + script).
#
# Before importing: replace "bridge" with your LAN interface (all 4 places) if it has another name.
# Remove again:
#   /ip dhcp-server alert remove [find comment="mlguard"]
#   /system scheduler remove [find name="ml-arp-watch"]; /system script remove [find name="ml-arp-watch"]

/ip dhcp-server alert
remove [find comment="mlguard"]
add interface=bridge valid-server=[/interface get [find name="bridge"] mac-address] alert-timeout=1h comment="mlguard"

/system script
remove [find name="ml-arp-watch"]
add name=ml-arp-watch policy=read,write,test dont-require-permissions=yes comment="mlguard: ARP spoofing watch" source={
:local lanIf "bridge"
:local many 10
:global mlArp
:if ([:typeof $mlArp] != "array") do={ :set mlArp [:toarray ""] }
:local count [:toarray ""]
:local first [:toarray ""]
:foreach a in=[/ip arp find where interface=$lanIf and dynamic=yes and complete=yes] do={
  :local ip [:tostr [/ip arp get $a address]]
  :local mac [:tostr [/ip arp get $a mac-address]]
  :local old ($mlArp->$ip)
  :if ([:typeof $old] = "str" and $old != $mac) do={
    :log warning ("ML-ARP changed ip=" . $ip . " old=" . $old . " new=" . $mac . " if=" . $lanIf)
  }
  :set ($mlArp->$ip) $mac
  :local n ($count->$mac)
  :if ([:typeof $n] != "num") do={ :set n 0; :set ($first->$mac) $ip }
  :set ($count->$mac) ($n + 1)
}
:foreach mac,n in=$count do={
  :if ($n >= $many) do={ :log warning ("ML-ARP many-ips mac=" . $mac . " ip=" . ($first->$mac) . " ips=" . $n . " if=" . $lanIf) }
}
}

/system scheduler
remove [find name="ml-arp-watch"]
add name=ml-arp-watch interval=1m on-event="/system script run ml-arp-watch" policy=read,write,test comment="mlguard: ARP spoofing watch"

# Optional HARD protection (only when EVERY device gets its address from this router's DHCP —
# devices with a typed-in IP lose the network!): the router then trusts only the DHCP leases.
#   /ip dhcp-server set [find interface="bridge"] add-arp=yes
#   /interface bridge set [find name="bridge"] arp=reply-only
# Rogue DHCP can also be stopped on the switch level: /interface bridge filter (drop UDP 67 from ports
# other than the uplink) or "DHCP snooping" on bridges with hardware offload (RouterOS 7).
