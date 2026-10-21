Web-filter POLICIES — one file per policy (name = file name, a-z 0-9 -).
A device/user/group/IP range joins a policy by being in address list "policy-<name>".
On the server the policies live in /var/lib/mikrotiklover/policies and are edited in the dashboard
(Blocking) or with "radius-admin policy set NAME < file"; the routers get them by auto-sync
(mikrotik/autosync.rsc). In this repository: run ../build.sh, import ../../mikrotik/webfilter-policies.rsc.

First line: "# description". Directives (one per line):
  block CATEGORY [time=...]   block a category from ../categories/ (social, social-video, video-streaming,
                              gaming, vpn-proxy, torrent-piracy, messaging, custom) or "keywords"
                              time= uses RouterOS syntax, e.g. time=9h-17h,mon,tue,wed,thu,fri
  block-app APP [time=...]    block one app with every domain the CDN detective knows for it, the ones
                              learned on your network included (radius-admin cdn apps), e.g. block-app PUBG Mobile
  block-site example.com [time=...]   one website (and its subdomains) for this policy only
  allow-site example.com      an exception: this policy never blocks it (e.g. block social, allow-site linkedin.com)
  allow-web example.com       like allow-site, and the server finds what the site loads from elsewhere (fonts,
                              CDNs, image hosts) by reading it, daily, and learns more from the DNS log
                              (radius-admin webscan; dashboard → Blocking → Allowed websites)
  allow-app Instagram         every domain the app catalog knows for the app (learned ones too)
  block-vpn [time=...]        VPN apps/websites (by name, and any name with "vpn"), the VPN servers seen on
                              your network (address list vpn-servers, kept up to date by the server) and the
                              VPN protocols (OpenVPN, WireGuard, WARP, IPsec, L2TP, PPTP, SoftEther, Tor).
                              Every try is logged (WF-vpn) — radius-admin vpn / dashboard → VPN watch
  allow-only PROFILE          only this app works (../allowonly/PROFILE.txt, e.g. whatsapp, hikconnect),
                              everything else is refused; several lines = several apps
                              (allow-only whatsapp + allow-only hikconnect). On the server the profiles are
                              /var/lib/mikrotiklover/allowonly (dashboard → Blocking → App profiles)
  block-all [time=...]        no internet at all (during time= if given)
  dns router|family|adguard-family|cleanbrowsing-family|cleanbrowsing-adult
                              which DNS the members use (default: router = all router-wide filters)
  strict-ech                  also block Encrypted Client Hello (hides site names from the filter;
                              a few Cloudflare-hosted sites will then not open for these users)
