Web-filter POLICIES — one file per policy (name = file name, a-z 0-9 -).
A device/user/group/IP range joins a policy by being in address list "policy-<name>".
Run ../build.sh after editing; import ../../mikrotik/webfilter-policies.rsc on the router.

Directives (one per line):
  block CATEGORY [time=...]   block a category from ../categories/ (social, video-streaming, gaming,
                              vpn-proxy, torrent-piracy, messaging, custom) or "keywords"
                              time= uses RouterOS syntax, e.g. time=9h-17h,mon,tue,wed,thu,fri
  block-all [time=...]        no internet at all (during time= if given)
  dns router|family|adguard-family|cleanbrowsing-family|cleanbrowsing-adult
                              which DNS the members use (default: router = all router-wide filters)
  strict-ech                  also block Encrypted Client Hello (hides site names from the filter;
                              a few Cloudflare-hosted sites will then not open for these users)
