# MikrotikLover web filter — large category lists via DNS adlist (RouterOS 7.15+)
# Needs webfilter-base.rsc.  Lists are downloaded and refreshed by the router itself.
#
# RAM: every list needs router memory (roughly 10–20 MB per 75k domains).
#   64 MB routers (hAP lite/ac lite): use only gambling, or set Cloudflare Family DNS instead.
#   256 MB+ (hAP ax2/ax3, RB5009, CCR): all lists are fine.
# Check usage:  /ip dns adlist print stats
# Allow a site that a list blocks (static entries win over adlists):
#   /ip dns static add name=example.com type=FWD forward-to=1.1.1.1 match-subdomain=yes comment="webfilter:allow"

/ip dns adlist
remove [find comment~"^webfilter:"]
# Adult / pornography (~75k domains)
add url="https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts" ssl-verify=no comment="webfilter:adult"
# Gambling / betting (~7k)
add url="https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling-only/hosts" ssl-verify=no comment="webfilter:gambling"
# Ads + malware + tracking (~75k) — uncomment to enable
# add url="https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts" ssl-verify=no comment="webfilter:ads-malware"
# Fake news (~2k) — uncomment to enable
# add url="https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-only/hosts" ssl-verify=no comment="webfilter:fakenews"
