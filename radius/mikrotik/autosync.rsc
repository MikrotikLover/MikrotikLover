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
