# MikrotikLover — router AUTO-SYNC (RouterOS 7)
# Every 15 minutes the router asks the RADIUS server whether its rules changed, and only then
# downloads and imports them: the policies (dashboard → Blocking), the app block lists that grow
# by themselves (CDN detective) and the VPN server list (VPN watch).
# Get this script with YOUR server name, IP and key filled in from the dashboard:
#   Blocking → Router auto-sync → Download script     (or: radius-admin policy sync)
# Needs webfilter-base.rsc (imported once by hand).

# 1. the certificate is for the server's name: make the name point to the server
/ip dns static
remove [find comment="mikrotiklover-sync"]
add name=radius.example.lan address=192.168.88.10 comment="mikrotiklover-sync"

# 2. trust the server's own certificate authority (downloaded once)
/tool fetch url="https://192.168.88.10:8443/static/ca.pem" dst-path=mikrotiklover-ca.pem check-certificate=no
:delay 2s
:if ([:len [/certificate find where name~"mikrotiklover-ca"]] = 0) do={ /certificate import file-name=mikrotiklover-ca.pem passphrase="" name=mikrotiklover-ca }

# 3. the sync script and its schedule
/system script
remove [find name=ml-sync]
add name=ml-sync policy=read,write,policy,test source={
:global mlSyncVer
:local base "https://radius.example.lan:8443/api/public/router"
:local key "PUT-THE-KEY-HERE"
:do {
  :local v ([/tool fetch url="$base/version?key=$key" check-certificate=yes-without-crl output=user as-value]->"data")
  :if ($v != $mlSyncVer) do={
    /tool fetch url="$base/sync.rsc?key=$key" check-certificate=yes-without-crl dst-path=ml-sync.rsc
    :delay 2s
    /import file-name=ml-sync.rsc
    :set mlSyncVer $v
    :log info "ml-sync: router rules updated ($v)"
  }
} on-error={ :log warning "ml-sync: RADIUS server not reachable or the import failed" }
}
/system scheduler
remove [find name=ml-sync]
add name=ml-sync interval=15m start-time=startup on-event="/system script run ml-sync"
/system script run ml-sync

# 4. network control: every minute the router tells the server how it is (dashboard → Routers → Router health):
#    CPU, memory, disk, uptime, interfaces (up/down, traffic), internet links (netwatch) and users online.
#    No change to the router's configuration — it only reads and sends.
/system script
remove [find name=ml-stats]
add name=ml-stats policy=read,test comment="mikrotiklover: router health report" source={
:local base "https://radius.example.lan:8443/api/public/router"
:local key "PUT-THE-KEY-HERE"
:local r [/system resource get]
:local d ("id=" . [/system identity get name] . "\nver=" . ($r->"version") . "\nboard=" . ($r->"board-name") . "\ncpu=" . ($r->"cpu-load") . "\nup=" . ($r->"uptime"))
:set d ($d . "\nmem=" . ($r->"free-memory") . "/" . ($r->"total-memory") . "\nhdd=" . ($r->"free-hdd-space") . "/" . ($r->"total-hdd-space"))
:foreach i in=[/interface find where type!="loopback"] do={
  :local x [/interface get $i]
  :set d ($d . "\nif=" . ($x->"name") . "|" . ($x->"running") . "|" . ($x->"disabled") . "|" . ($x->"rx-byte") . "|" . ($x->"tx-byte") . "|" . ($x->"type"))
}
:do { :foreach n in=[/tool netwatch find] do={ :local x [/tool netwatch get $n]; :set d ($d . "\nnw=" . ($x->"host") . "|" . ($x->"status") . "|" . ($x->"comment")) } } on-error={}
:do { :set d ($d . "\nhs=" . [:len [/ip hotspot active find]]) } on-error={}
:do { :set d ($d . "\nppp=" . [:len [/ppp active find]]) } on-error={}
:do { :set d ($d . "\ndhcp=" . [:len [/ip dhcp-server lease find where status="bound"]]) } on-error={}
:do { :foreach n in=[/ip firewall nat find where chain="dstnat" and (action="dst-nat" or action="netmap")] do={ :local x [/ip firewall nat get $n]; :set d ($d . "\nnat=" . ($x->"protocol") . "|" . ($x->"dst-port") . "|" . ($x->"to-addresses") . "|" . ($x->"to-ports") . "|" . ($x->"in-interface") . ($x->"in-interface-list") . "|" . ($x->"dst-address") . ($x->"dst-address-list") . "|" . ($x->"src-address") . ($x->"src-address-list") . "|" . ($x->"disabled") . "|" . ($x->"dynamic") . "|" . ($x->"comment")) } } on-error={}
:do { :foreach n in=[/ip firewall filter find where comment~"^mlfw:[0-9]"] do={ :local x [/ip firewall filter get $n]; :set d ($d . "\nfw=" . ($x->"comment") . "|" . ($x->"packets") . "|" . ($x->"bytes")) } } on-error={}
:do { :foreach n in=[/ip firewall nat find where comment~"^mlfw-vip:[0-9]"] do={ :local x [/ip firewall nat get $n]; :set d ($d . "\nfwn=" . ($x->"comment") . "|" . ($x->"packets") . "|" . ($x->"bytes")) } } on-error={}
:do { :foreach n in=[/ip service find where disabled=no] do={ :local x [/ip service get $n]; :set d ($d . "\nsvc=" . ($x->"name") . "|" . ($x->"port") . "|" . ($x->"address")) } } on-error={}
:do { /tool fetch url="$base/report?key=$key" http-method=post http-data=$d http-header-field="Content-Type: text/plain" check-certificate=yes-without-crl output=none } on-error={ :log warning "ml-stats: RADIUS server not reachable" }
}
/system scheduler
remove [find name=ml-stats]
add name=ml-stats interval=1m start-time=startup on-event="/system script run ml-stats" comment="mikrotiklover: router health report"

# internet links: the router checks them every 30 s (netwatch); a link that goes down shows red on the
# dashboard and comes as an alert. Add your own: /tool netwatch add host=... comment="ml-link: ISP2"
/tool netwatch
remove [find comment~"^ml-link: "]
add host=8.8.8.8 interval=30s timeout=2s comment="ml-link: internet (Google DNS)"
add host=1.1.1.1 interval=30s timeout=2s comment="ml-link: internet (Cloudflare DNS)"
