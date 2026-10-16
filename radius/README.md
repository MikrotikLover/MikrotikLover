# MikrotikLover RADIUS Server — Wireless User Authentication

FreeRADIUS 3.2 + MariaDB par bana hua RADIUS server, MikroTik Wi-Fi ke liye:

- **WPA2/WPA3-Enterprise** — har user ka apna username/password (PEAP-MSCHAPv2 / EAP-TTLS). Ek password leak ho to sirf us user ko band karein, poore office ka Wi-Fi password badalne ki zaroorat nahi.
- **Hotspot (captive portal)** login bhi isi user database se.
- **MAC authentication** — printer, CCTV, smart TV, POS jaise devices sirf MAC address se connect hon.
- **Website blocking by category** — social media, video, gaming, VPN, torrent, adult, gambling, ya apni list (MikroTik DNS par).
- **Groups**: speed limit (`Mikrotik-Rate-Limit`), VLAN, session/idle timeout, ek user ke kitne devices (`Simultaneous-Use`).
- **Accounting**: kaun online hai, kis ne kitna data use kiya, login/reject log.
- `radius-admin` command se sab kuch manage hota hai — users, groups, routers, tests.

> Ye RADIUS server **Linux VPS ya local Ubuntu machine** par chalta hai (UDP 1812/1813). Hostinger shared hosting par nahi chal sakta.

## 1. Install (Ubuntu 22.04/24.04, Debian 12)

```bash
git clone <this-repo> && cd MikrotikLover/radius
sudo RADIUS_DOMAIN=radius.yourcompany.com ./install.sh
```

Installer ye karta hai (dobara chalana safe hai):

| Step | Detail |
|---|---|
| Packages | `freeradius`, `freeradius-mysql`, `freeradius-utils`, `mariadb-server`, `eapoltest` |
| Database | `radius` DB + `radius` user (sirf SELECT/INSERT/UPDATE/DELETE), official FreeRADIUS schema |
| Certificates | Private CA (10 saal) + server certificate (825 din) — `/etc/freeradius/3.0/certs/mikrotiklover/` |
| EAP | PEAP + TTLS, inner MSCHAPv2, TLS 1.2, group/user attributes Wi-Fi tak pass hote hain |
| Security | localhost ka default `testing123` secret badal diya jata hai; login log mein passwords save nahi hote |
| Tool | `/usr/local/sbin/radius-admin` |

Settings (DB password, local secret): `/etc/mikrotiklover-radius/radius.conf` (root-only).

### Firewall

RADIUS ports sirf apne MikroTik routers ke liye kholein:

```bash
sudo ufw allow from <mikrotik-public-ip> to any port 1812:1813 proto udp
```

## 2. MikroTik router add karein (NAS)

```bash
sudo radius-admin nas add 192.168.88.1                 # secret khud generate hoga aur print hoga
sudo radius-admin nas add 192.168.88.1 MyS3cret#2026 office-hap
sudo radius-admin nas add 10.10.0.0/24                 # poora subnet (bohot saare APs)
sudo radius-admin nas list
```

**IP woh honi chahiye jis se RADIUS packet server tak pohanchta hai.** Router NAT ke peeche hai aur server internet par (VPS) hai to router ki **public IP** add karein — ya behtar: router aur VPS ke darmiyan **WireGuard tunnel** banayein aur tunnel IP use karein (RADIUS attributes internet par encrypted nahi hote).

## 3. Groups aur users

```bash
# Groups = policies
sudo radius-admin group add staff  --rate 20M/20M --vlan 10 --max-sessions 3
sudo radius-admin group add guests --rate 2M/2M  --vlan 30 --session-timeout 14400 --max-sessions 1
sudo radius-admin group list

# Users
sudo radius-admin user add ali  -g staff                 # password poochega (khali = random)
sudo radius-admin user add sara -g guests -p 'Sara@123'
sudo radius-admin user add hr1  -g staff --nt-hash       # password ki jagah NT-hash save (sirf WPA-Enterprise)
sudo radius-admin user passwd ali
sudo radius-admin user group ali guests
sudo radius-admin user disable sara                      # block
sudo radius-admin user enable sara
sudo radius-admin user del sara
sudo radius-admin user list
sudo radius-admin user show ali
```

`--rate` MikroTik ka `rx/tx` format hai (router ki taraf se: upload/download), burst bhi chalta hai: `"4M/8M 6M/12M 3M/6M 10/10"`.

## 3b. MAC authentication (devices bina username/password)

```bash
sudo radius-admin mac add aa:bb:cc:dd:ee:ff -g staff -d "Reception printer"   # koi bhi format: AABB.CCDD.EEFF, aabbccddeeff
sudo radius-admin mac list               # description, group, last seen
sudo radius-admin mac disable AA-BB-CC-DD-EE-FF
sudo radius-admin mac enable  AA-BB-CC-DD-EE-FF
sudo radius-admin mac group   AA-BB-CC-DD-EE-FF guests
sudo radius-admin mac del     AA-BB-CC-DD-EE-FF
```

- MikroTik MAC kisi bhi format mein bheje (`AA:BB:..`, `aabbcc..`), server khud `AA-BB-CC-DD-EE-FF` bana leta hai.
- Har MAC entry sirf tab accept hoti hai jab request ka **Calling-Station-Id** (device ka asli MAC) bhi wohi ho. Is liye koi MAC address ko username bana kar hotspot ya WPA-Enterprise par login nahi kar sakta.
- Group ki speed limit / VLAN MAC devices par bhi lagti hai.
- **Yaad rakhein:** MAC address copy (spoof) ho sakta hai. MAC auth ko akela security na samjhein; devices ke liye alag SSID (WPA2-PSK + MAC check) aur alag VLAN rakhein — `mikrotik/mac-auth.rsc` yahi karta hai.

## 4. MikroTik configuration

`mikrotik/` folder mein ready scripts hain. File mein `RADIUS_SERVER_IP`, `RADIUS_SECRET` aur SSID replace karein, Winbox → Files mein upload karein, phir Terminal mein `/import file-name=...`.

| Script | Kis ke liye |
|---|---|
| `wpa-enterprise-wifi-ros7.rsc` | RouterOS 7 **wifi** package (hAP ax², ax³, cAP ax, …) |
| `wpa-enterprise-wireless-legacy.rsc` | Purana **wireless** package (RouterOS 6, hAP ac lite, cAP ac, SXT, …) |
| `hotspot.rsc` | Hotspot captive portal login |
| `mac-auth.rsc` | MAC authentication: (A) wifi package `query-radius`, (B) legacy wireless, (C) hotspot `login-by=mac` |
| `webfilter-*.rsc` | Website category blocking — section 5b |
| `webfilter-policies.rsc` | Single user / group / IP range ki alag policies, time ke saath |
| `webfilter-logging.rsc` | Blocked attempts server par (`radius-admin blocked`) |
| `dns-logging.rsc` | Visited sites + live log (`radius-admin sites / history / live`) |
| `traffic-flow.rsc` | Data download/upload per site / IP / user (`radius-admin traffic`) |
| `pppoe-server.rsc` | PPPoE server (ISP style) with RADIUS, pool, accounting |
| `allow-only-whatsapp.rsc` | Sirf WhatsApp |

Wi-Fi aur hotspot dono ek router par hain to ek hi entry kafi hai: `/radius add address=... secret=... service=wireless,hotspot`.

**VLAN per group**: bridge par `vlan-filtering=yes` aur VLANs configured honi chahiye. Legacy wireless par `vlan-mode=use-tag` bhi lagayein.

## 5. Devices kaise connect hon

| Device | Setting |
|---|---|
| Windows 10/11 | SSID select → username/password → "Connect" (certificate prompt par Connect) |
| Android 11+ | EAP: **PEAP**, Phase 2: **MSCHAPV2**, CA certificate: `ca.der` install karke select karein *ya* "Trust on first use" (Android 13+), Domain: `RADIUS_DOMAIN`, Identity: username |
| iPhone / macOS | username/password → certificate par **Trust** |

CA file: `/etc/freeradius/3.0/certs/mikrotiklover/ca.der` (Android/Windows) ya `ca.pem`. Android par: Settings → Security → Encryption & credentials → Install a certificate → Wi-Fi certificate.

## 5b. Website / URL blocking by category

Filtering MikroTik router ke DNS par hoti hai (RouterOS **7.15+**). Blocked site browser mein "site can't be reached" dikhati hai.

**Step 1 — base (zaroori, sab se pehle):** `webfilter-base.rsc`
- LAN ke har device ko router ka DNS use karna padta hai (port 53 redirect) — 8.8.8.8 likh kar bypass nahi hota.
- Encrypted DNS band: DoT (853), DoH servers (Google, Cloudflare, Quad9, AdGuard, NextDNS, ...), Firefox DoH, iCloud Private Relay.
- DoH ko **naam (SNI)** se bhi rokta hai — DoH server kisi nayi IP par ho tab bhi `dns.google`, `cloudflare-dns.com` wagera band.
- **IPv6** par bhi wohi rasta band (direct DNS, DoT, DoH) — warna IPv6 wala phone filter se nikal jata.
- Address list `web-filter-exempt` wale devices par koi filter nahi (management, IT).

**Step 2 — categories (jo chahiye woh import karein):**

| File | Category | Kaise |
|---|---|---|
| `webfilter-social.rsc` | Facebook, Instagram, TikTok, Snapchat, X, LinkedIn, Reddit, Likee, ... | static list |
| `webfilter-video-streaming.rsc` | YouTube, Netflix, Prime, Hotstar, Tamasha, Tapmad, Twitch, ... | static list |
| `webfilter-gaming.rsc` | PUBG, Free Fire, Roblox, Steam, Epic, Supercell, browser games | static list |
| `webfilter-vpn-proxy.rsc` | VPN / web-proxy websites | static list |
| `webfilter-torrent-piracy.rsc` | Torrent sites, clients, trackers | static list |
| `webfilter-messaging.rsc` | WhatsApp, Telegram, Signal, Viber, IMO, Discord | static list |
| `webfilter-custom.rsc` | Aap ki apni list | static list |
| `webfilter-adlists.rsc` | **Adult** (~75k), **Gambling** (~7k), Ads+Malware, Fake news (optional) | adlist, router khud download/update karta hai |
| `webfilter-keywords.rsc` | **Words** in website names: porn, xxx, sex, nude, ... (`webfilter/keywords.txt`) | DNS regexp + HTTPS SNI firewall |
| `webfilter-safesearch.rsc` | Google / YouTube / Bing / DuckDuckGo **SafeSearch lock** — "sex video" search par explicit results nahi | DNS CNAME |

Har static domain ke **saare subdomains** bhi block hote hain (`facebook.com` → `m.facebook.com`, `web.facebook.com`).

**Apni list / list badalna:** `webfilter/categories/*.txt` edit karein (ek line = ek domain), phir `./webfilter/build.sh` chalayein — `mikrotik/webfilter-*.rsc` dobara ban jayengi. Router par dobara import karna safe hai (purani entries pehle remove hoti hain).

```routeros
# Category hatana
/ip dns static remove [find comment="webfilter:social"]
# Ek site turant block / allow
/ip dns static add name=example.com type=NXDOMAIN match-subdomain=yes comment="webfilter:custom"
/ip dns static add name=example.com type=FWD forward-to=1.1.1.1 match-subdomain=yes comment="webfilter:allow"
# Kisi PC ko filter se bahar rakhna
/ip firewall address-list add list=web-filter-exempt address=192.168.88.10 comment="Manager PC"
```

**User/group ke hisaab se filter (RADIUS):**
- **Hotspot users**: `sudo radius-admin group add managers --address-list web-filter-exempt` — login hote hi user ka IP exempt list mein chala jata hai, baqi sab filtered.
- **WPA-Enterprise users**: group ko VLAN dein (`--vlan 10`) aur us VLAN ka subnet exempt list mein daalein: `/ip firewall address-list add list=web-filter-exempt address=192.168.10.0/24`.

### Word / keyword blocking ("sex", "xxx", ...)

HTTPS mein browser aur website ke darmiyan sab kuch encrypted hota hai. Router ko sirf **website ka naam** nazar aata hai (DNS query aur TLS SNI), page ka path, search ke words aur page ka content nahi:

| Address | Router ko kya dikhta hai |
|---|---|
| `https://www.xvideos.com/video123/abc` | `www.xvideos.com` ✔ — path ✘ |
| `https://www.google.com/search?q=sex+video` | `www.google.com` ✔ — "sex video" ✘ |

Is liye keyword blocking 3 tareeqon se hoti hai:

1. **Website ke naam mein word** → `webfilter-keywords.rsc`. `webfilter/keywords.txt` mein words likhein:
   - `porn` → naam mein kahin bhi ho to block (`pornhub.com`, `freeporn.net`)
   - `^sex` → sirf naam ke hisse ke shuru mein (`sex.com`, `free-sex.org`, `cdn.sexvideos.com`), taa ke `essex.ac.uk`, `sussex.gov.uk`, `middlesex.edu` block na hon. Phir bhi `sextant.com` jaisi kuch sites block hongi.
   - **"video" akela kabhi na likhein** — `googlevideo.com` (poora YouTube) block ho jayega. Combination likhein: `sexvideo`, `xxxvideo`. Isi wajah se list mein `xvideos` hai, `xvideo` nahi (`nflxvideo.net` = Netflix).
   - Do layers: DNS regexp, aur firewall `tls-host` jo HTTPS connection ko website ke naam par reset karta hai — chahe device ne IP kisi aur tareeqe se li ho.
2. **Search mein word** ("sex video" Google/YouTube par) → `webfilter-safesearch.rsc`. SafeSearch / YouTube Restricted Mode zabardasti on, user off nahi kar sakta. Devices par koi certificate nahi chahiye.
3. **Har page ke URL path / content mein word** → sirf SSL-inspection proxy (Squid ssl-bump + e2guardian) se mumkin hai. Is ke liye har device par apna CA certificate install karna padta hai; banking/WhatsApp jaisi certificate-pinning wali apps toot jati hain, aur sab users ka HTTPS traffic decrypt hota hai (privacy / legal zimmedari). MikroTik khud ye nahi kar sakta — alag Linux server chahiye.

**Behtareen combination:** `webfilter-base` + `webfilter-adlists` (adult ~75k sites) + `webfilter-keywords` + `webfilter-safesearch` + `webfilter-vpn-protocols`.

### Policies — Single user / Group / IP Range blocking — `webfilter-policies.rsc`

Upar wali DNS blocking **sab** par lagti hai. Policies se har user, group ya IP range ki **alag** blocking hoti hai.

**Tayyar policies** (`webfilter/policies/*.txt` — edit karein ya nayi banayein, phir `./webfilter/build.sh`):

| Policy | Kya band |
|---|---|
| `students` | Social, video, gaming, VPN, torrent, adult words + CleanBrowsing family DNS + ECH band |
| `staff` | Social aur video **sirf office time** (9–5, Mon–Sat); gaming, torrent, adult words hamesha |
| `guests` | Torrent, VPN, adult words + Cloudflare family DNS |
| `no-internet` | Internet bilkul band |
| `night-off` | Raat 12 se 6 tak internet band, din mein guests jaisa |

Policy file ka format:
```
block social                              # category (categories/*.txt) ya "keywords"
block video-streaming time=9h-17h,mon,tue,wed,thu,fri    # sirf is waqt
block-all time=0s-6h,sun,mon,tue,wed,thu,fri,sat         # internet band (is waqt)
dns family            # router | family | adguard-family | cleanbrowsing-family | cleanbrowsing-adult
strict-ech            # Encrypted Client Hello bhi band (site ka naam chhupne nahi deta)
```

**Kis par lagani hai** — device ka IP address list `policy-<naam>` mein hona chahiye:

| Kis par | Kaise |
|---|---|
| **Single user** (hotspot) | `sudo radius-admin user policy ali students` — sirf is user par, group se upar. Turant kick hota hai taa ke naye login par policy lag jaye |
| **Single device** (MAC) | `/ip dhcp-server lease make-static [find mac-address=AA:BB:CC:DD:EE:FF]` → `/ip dhcp-server lease set [find mac-address=AA:BB:CC:DD:EE:FF] address-lists=policy-students` |
| **Single IP** | `/ip firewall address-list add list=policy-no-internet address=192.168.88.23 comment="Ahmed"` |
| **IP Range** | `/ip firewall address-list add list=policy-students address=192.168.88.100-192.168.88.150` |
| **Subnet / VLAN** | `/ip firewall address-list add list=policy-staff address=192.168.20.0/24` |
| **Group** (hotspot) | `sudo radius-admin group add class-9 --policy students` — group ke sab users |
| **Group** (WPA-Enterprise) | Group ko VLAN dein (`--vlan 20`) aur us subnet ko policy list mein daalein |

Policy hatana: `sudo radius-admin user policy ali -` (wapas group policy), ya address-list entry remove.

**Kaise kaam karta hai:** HTTPS connection ke shuru mein website ka naam (SNI) jata hai; router har policy ke liye us naam ko category list se milata hai (`wf-social`, `wf-gaming` ... chains — sab policies share karti hain). Policy wale users ka QUIC (UDP 443) band hai taa ke browser TCP par aaye jahan naam dikhta hai. `dns ...` wali policy ke users ka DNS us family-safe DNS par jata hai (adult sites wahan band). `tests/simulate-policies.py` 23 cases check karta hai (office time, raat, har policy ki DNS, normal users par asar nahi).

### Turant disconnect (kick)

```bash
sudo radius-admin kick ali                  # ya MAC: radius-admin kick aa:bb:cc:dd:ee:ff
```
Router ko RADIUS Disconnect-Request (port 3799) bhejta hai. `user disable` aur `user policy` khud bhi kick karte hain. Router par `/radius incoming set accept=yes` hona chahiye (scripts mein hai).

### Blocked report — kis ne kya kholne ki koshish ki

1. Router par `webfilter-logging.rsc` import karein (`RADIUS_SERVER_IP` badal kar). Server UDP 514 par sirf private networks aur registered routers ke logs leta hai.
2. ```bash
   sudo radius-admin blocked              # last 30
   sudo radius-admin blocked 100 -u ali   # sirf ali ke
   ```
   ```
   time                 user  ip         mac                category  destination
   2026-10-16 18:00:44  ali   10.5.0.2   AA-BB-CC-00-00-02  social    157.240.1.35:443
   ```
   IP/MAC se RADIUS session dhoond kar **username** dikhata hai. Logs `/var/log/mikrotik/webfilter.log` (8 hafte rotate).

### Visited sites report aur live log

Har user ne kaunsi site kholi — username ke saath. Router ka DNS server par ek chhote DNS logger (dnsmasq) se guzarta hai; woh har query client IP ke saath likhta hai aur wapas router ko bhej deta hai (router ki saari DNS filtering waisi hi chalti hai). IP → username RADIUS session (radacct) se.

**Setup (ek dafa):**
1. Server par: `sudo radius-admin dnslog on 192.168.88.1` (MikroTik ka IP jo filtering karta hai)
2. Router par: `mikrotik/dns-logging.rsc` (`RADIUS_SERVER_IP` badal kar) — `webfilter-base.rsc` ke baad import.
3. Server ka UDP/TCP 53 sirf routers/LAN ke liye kholein.

> **Zaroori:** server clients wale subnet mein **na** ho — alag VLAN/subnet ya WireGuard tunnel (bina masquerade) se, warna server ko asal client IP nahi milta aur DNS toot jata hai. Server band ho to router ka netwatch 30 second mein DNS wapas router par kar deta hai.

**Reports:**
```bash
sudo radius-admin live                    # LIVE: har visit aur har block, sab users (Ctrl+C)
sudo radius-admin live -u ali             # sirf ali live
sudo radius-admin sites                   # 7 din ki top 30 sites, kitne users, kaun
sudo radius-admin sites -u ali --days 30 --top 50
sudo radius-admin sites --ip 192.168.88.23
sudo radius-admin history -u ali          # aaj ali ne kya kya khola, time ke saath
sudo radius-admin history -u ali --days 7 200
sudo radius-admin blocked -u ali          # ali ki blocked koshishein
```
```
2026-10-16 18:06:22  ali   192.168.88.23  instagram.com     www.instagram.com
2026-10-16 18:06:24  ali   192.168.88.23  BLOCKED social → 157.240.1.174:443
```
- CDN ke naam asal site mein jor diye jate hain (`googlevideo.com`, `ytimg.com` → youtube.com; `fbcdn.net` → facebook.com; `cdninstagram.com` → instagram.com ...). Ek device ki ek site 5 minute mein **1 visit** ginti hai.
- Logs: `/var/log/mikrotik/dns.log` (30 din), `webfilter.log` (8 hafte), purane compress ho jate hain.
- `radius-admin dnslog status | off`
- **Limitation:** sirf site ka naam (domain) aata hai, page/URL nahi (HTTPS). Jo users DNS bypass karte hain (exempt list, policy ki family DNS) woh `sites` mein nahi aate — `blocked` mein aate hain.
- **Privacy / qanoon:** users ki browsing record ho rahi hai — unhein pehle bata dein (Wi-Fi terms / office policy). Pakistan mein PECA 2016 ke tehat data sirf zaroorat tak rakhein aur mehfooz rakhein; log files sirf root/adm parh sakte hain.

### Data usage — kis website / kis IP / kis user ne kitna download-upload kiya

**Setup (ek dafa):**
1. Server par: `sudo radius-admin traffic collector on` (UDP 2055) — aur site ke naam ke liye `sudo radius-admin dnslog on ROUTER_IP` (upar wala DNS logger).
2. Router par: `mikrotik/traffic-flow.rsc` (`RADIUS_SERVER_IP` badal kar). Ye Traffic Flow (IPFIX) on karta hai aur **fasttrack band** karta hai — fasttrack wale packets Traffic Flow mein nahi aate, warna download ka bara hissa gina hi nahi jata. Busy router par CPU barhega.

**Reports:**
```bash
sudo radius-admin traffic                           # aaj: har website ka download / upload / total
sudo radius-admin traffic --by ip                   # har IP ne kitna (user ke naam ke saath)
sudo radius-admin traffic --by user --days 30       # har user ka mahina
sudo radius-admin traffic -u ali --days 7           # ali: kis site se kitna
sudo radius-admin traffic --ip 192.168.88.23        # ek IP: kis site se kitna
sudo radius-admin traffic --site youtube.com --by user   # YouTube kis ne kitna chalaya
sudo radius-admin traffic --by day --days 30        # roz ka total
sudo radius-admin traffic now                       # LIVE: pichle 1 minute — IP, user, site, speed (Mbps)
```
```
+--------------+----------+---------+----------+---------+-------+
| site         | download | upload  | total    | devices | users |
| youtube.com  | 810.6 MB | 11.4 MB | 822.1 MB |       1 | ali   |
| facebook.com | 114.4 MB | 2.9 MB  | 117.3 MB |       1 | ali   |
```

**Kaise kaam karta hai:**
- Router har connection ke bytes (IPFIX/NetFlow v9) server ko bhejta hai. NAT ke baad router kabhi client ka private IP aur kabhi apna public IP report karta hai — collector record ke **saare** address fields (NAT se pehle aur baad) dekh kar asal LAN client dhoondta hai.
- Wohi packets do interfaces (LAN + WAN) par report hon to **ek hi dafa** gine jate hain.
- Remote IP ka naam: DNS logger ke `query` → `reply` serial se — jo IP client X ko `www.youtube.com` ke liye mila, X ka us IP ka traffic `youtube.com`. CDN naam (`googlevideo.com`, `fbcdn.net`) asal site mein jor diye jate hain. Naam na mile to IP dikhta hai.
- Ghante ke hisaab se MariaDB table `traffic_site` mein (90 din, `TRAFFIC_DAYS=` in `radius.conf`). Username RADIUS session se.
- `tests/test-flowcollector.py` 7 cases (NAT field se client, duplicate, NetFlow v9, cached DNS, LAN-LAN ignore) — aur yahan asal DB ke saath end-to-end chala kar dekha.

**Limitations:** sirf site (domain) level — page/URL ka data nahi (HTTPS). IPv6 traffic abhi nahi gina jata (IPv6 band rakhein ya v4 hi istemal karein). Jo device DNS logger bypass kare (exempt / family DNS policy) us ka data IP ke naam se dikhega. Pehli dafa router par lagane ke baad `radius-admin traffic now` se check karein ke IP aur bytes sahi aa rahe hain.

### Sirf WhatsApp (baqi sab band) — `allow-only-whatsapp.rsc`

Kisi user/device ko sirf WhatsApp dena ho (chat, voice/video call, photo/video, voice note, status, WhatsApp Web) aur **YouTube, Facebook, Instagram, TikTok, browser — sab band**:

1. Router par `webfilter-base.rsc` aur phir `allow-only-whatsapp.rsc` import karein.
2. Device ko address list `allow-only-whatsapp` mein daalein — jo tareeqa aap ke network par ho:

| Kaise | Command |
|---|---|
| Ek device, MAC se (DHCP) | `/ip dhcp-server lease make-static [find mac-address=AA:BB:CC:DD:EE:FF]` phir `/ip dhcp-server lease set [find mac-address=AA:BB:CC:DD:EE:FF] address-lists=allow-only-whatsapp` |
| Fixed IP / poora subnet | `/ip firewall address-list add list=allow-only-whatsapp address=192.168.88.50` |
| Hotspot user (RADIUS) | `sudo radius-admin group add whatsapp-only --address-list allow-only-whatsapp` → `sudo radius-admin user add ahmed -g whatsapp-only` |
| WPA-Enterprise user / MAC device | `sudo radius-admin group add whatsapp-only --vlan 50`, us VLAN ka subnet list mein: `/ip firewall address-list add list=allow-only-whatsapp address=192.168.50.0/24` |

Wapas normal karna: address list se entry hata dein (ya lease se `address-lists` khali kar dein).

**Ye kaise kaam karta hai** (WhatsApp ka apna chat protocol encrypted hai aur us mein website ka naam nahi hota, is liye sirf naam se allow karna kaam nahi karta):
- WhatsApp ke servers Meta (AS32934) ke networks mein hain → sirf in networks ki taraf traffic allow (`webfilter/allowonly/meta-ipv4.txt`).
- Facebook, Instagram, Messenger, Threads bhi **unhi** servers par hain → un ke HTTPS connections naam (SNI) se reset, aur QUIC (UDP 443) band taa ke woh apps TCP par aa kar pakri jayein.
- Phone ko "Wi-Fi par internet nahi" na lage, is liye connectivity check (sirf HTTP) allow, aur notifications ke liye Android push (5228-5230) / iPhone push (5223).
- Baqi har cheez reject.

`tests/simulate-allowonly.py` 19 cases check karta hai (WhatsApp chat/media/call/Web allow; Facebook, Instagram, Messenger, YouTube, TikTok, QUIC, App Store block; normal users par asar nahi).

**Dhyan rakhein:**
- In devices ka **IPv6 band** hona chahiye (address lists IPv4 hain) — un ke network/VLAN par IPv6 address/RA na dein.
- `webfilter-messaging.rsc` (jo WhatsApp block karti hai) is ke saath import **na** karein.
- Meta naye networks laata rehta hai; mahine mein ek dafa `./webfilter/build.sh --update-meta` chala kar nayi `allow-only-whatsapp.rsc` import karein. Agar kabhi WhatsApp na chale to pehla qadam yahi hai.
- Doosri apps ke liye bhi aisa profile ban sakta hai: `webfilter/allowonly/<naam>.txt` banayein (`whatsapp.txt` jaisa), `build.sh` chalayein → `mikrotik/allow-only-<naam>.rsc`.

### VPN apps ko rokna — `webfilter-vpn-protocols.rsc`

`webfilter-vpn-proxy.rsc` VPN ki **websites** band karti hai; ye script install shuda VPN apps ke **connections** rokti hai: OpenVPN, WireGuard, PPTP, L2TP, IPsec, Tor. `web-filter-exempt` (IT/manager) par asar nahi. Office ka IPsec VPN use hota ho to IPsec wale 2 rules hata dein. Jo VPN port 443 par HTTPS jaisa ban kar chalti hai (Psiphon) woh is se nahi rukti — aise users ke liye allow-only profile behtar hai.

### Time ke hisaab se blocking (sirf office hours)

```routeros
/system scheduler
add name=social-block-on  start-time=09:00:00 interval=1d on-event="/ip dns static enable [find comment=\"webfilter:social\"]; /ip dns cache flush"
add name=social-block-off start-time=17:00:00 interval=1d on-event="/ip dns static disable [find comment=\"webfilter:social\"]; /ip dns cache flush"
```
Kisi bhi category ka naam badal kar (`webfilter:video-streaming`, `webfilter:gaming`, ...) yahi kaam karta hai.

### Scripts check karna

```bash
python3 tests/lint-rsc.py             # har .rsc: quotes, braces, menu aur property names
python3 tests/simulate-allowonly.py   # WhatsApp-only rules ka simulation
python3 tests/simulate-policies.py    # policies: user/group/range, office time, raat
python3 tests/test-mlreport.py        # sites / history / blocked reports (sample logs)
python3 tests/test-flowcollector.py   # data usage collector (synthetic IPFIX / NetFlow v9)
python3 tests/test-cdnmap.py          # CDN detective: names, CNAME evidence, context, IP owners
python3 tests/test-cdnlearn.py        # auto-learner: cname / ip / co-occurrence, SDK not learned, reject
URL=https://127.0.0.1:8443 USER=admin PASS=... node tests/ui-dashboard.mjs   # web dashboard (Playwright)
```

**Limitations (honestly):**
- HTTPS mein poora URL path (`site.com/page`) router nahi dekh sakta — blocking **domain** level par hoti hai (upar dekhein).
- Port 443 par chhupi hui VPN (Psiphon jaisi) DNS filter bypass kar sakti hai; `vpn-protocols` baqi VPN band karta hai, sakhti chahiye to allow-only profile.
- Naye DoH servers aate rehte hain; `webfilter/categories/doh.txt` aur `base.rsc.in` ki IP list update karte rahein.

## 5c. Web dashboard (browser se sab kuch)

`install.sh` dashboard bhi install karta hai. Install ke aakhir mein link aur pehla password dikhta hai:
```
Web dashboard    : https://192.168.10.5:8443
  First login    : admin / XXXXXXXXXXXXXX   (change it under Settings)
```

| Page | Kya hota hai |
|---|---|
| **Dashboard** | Online users, users/MAC/routers ginti, aaj ke logins, aaj ka data, blocked hits, 24 ghante ka data chart, top sites, recent logins (30 s auto-refresh) |
| **Users** | Search, add (password khud generate), group, apni policy, password change, disable/enable, kick, delete. User page par: sessions, 30 din ka data chart, top sites, login attempts |
| **Groups & policies** | Speed limit, VLAN, session/idle timeout, devices per user, web-filter policy, description — add / edit / delete |
| **MAC devices** | Printer/CCTV wagera add, disable, remove, last seen |
| **Routers** | MikroTik add (strong secret khud banta hai, MikroTik ki command dikhti hai), secret dekhna, remove |
| **Online now** | Kaun connected hai — IP, MAC, kab se, data — Kick button (15 s refresh) |
| **Live log** | Har site visit aur har block, live (3 s), user filter, pause |
| **Reports** | Visited sites, history, blocked, login log — user / IP / din ke filter |
| **Data usage** | Per website / per IP / per user / **user → top sites** (har user ki top sites aur un ka download/upload) / per day + live speed |
| **Settings** | Services ka status, disk/DB size, apna password, dashboard accounts (admin / viewer), **audit log** (kis admin ne kab kya badla) |

**Security:**
- HTTPS (nginx, isi server ka certificate), port `8443`. Default mein **sirf private networks** (LAN, WireGuard 10.x/172.16.x/192.168.x/100.64.x) khol sakte hain. Badalna ho: `sudo WEB_ALLOW="203.0.113.7 192.168.0.0/16" ./install.sh` (ya `WEB_ALLOW=any` — internet par khulne ka mashwara nahi).
- App alag user `mlweb` ke tor par chalti hai; database sirf parh sakti hai. Har tabdeeli `radius-admin` se hoti hai (wohi validation), `sudo` sirf `radius-admin` ke liye. Passwords stdin se jate hain, command line par nahi.
- Login: 5 galat koshishon ke baad 10 minute block; session cookie HttpOnly + Secure + SameSite=Strict; har tabdeeli par CSRF token; strict Content-Security-Policy; koi bahar ki script/CDN nahi (offline LAN par bhi chalta hai).
- **Roles:** `admin` (sab kuch) aur `viewer` (sirf dekhna — report wale staff ke liye).
- Browser "Not secure / certificate" warning: certificate aap ke apne CA ka hai — admin PC par `ca.der` install kar dein (Windows: double-click → Trusted Root), ya warning accept karein.

**Terminal se dashboard accounts:**
```bash
sudo radius-admin web list
sudo radius-admin web passwd admin          # password bhool gaye to
sudo radius-admin web passwd ahmed && sudo radius-admin web role ahmed viewer
sudo radius-admin web del ahmed
```
Dashboard band karna ho: `sudo WEB=0 ./install.sh` se naya install dashboard ke bina hota hai; chal rahe ko `sudo systemctl disable --now mikrotiklover-web`.

**Test:** `tests/ui-dashboard.mjs` asal browser (Playwright/Chromium) mein login, group/user/MAC/router banana, policy lagana, saare pages, mobile + dark mode, aur sab delete karna check karta hai — console ya CSP error par fail.

## 5d. Hotspot business — plans, vouchers, expiry, data quota

Hotspot ko dukaan ki tarah chalane ke liye: packages bechein, cards print karein, sab khud lagu ho.

**1. Plan (package) banayein** — dashboard → *Plans* → New plan, ya:
```bash
sudo radius-admin plan add day-1gb    --price 50  --validity 1d  --quota 1G  --rate 4M/4M --devices 1 --description "1 din, 1 GB"
sudo radius-admin plan add month-10gb --price 500 --validity 30d --quota 10G --period monthly --rate 8M/8M --devices 2
sudo radius-admin plan add kids       --price 200 --daily-time 2h --rate 2M/2M
sudo radius-admin plan list
```
| Option | Matlab |
|---|---|
| `--validity 30d` | Pehli login se itne din/ghante (1d, 7d, 30d, 12h). Card bechne ke din se nahi — jab customer pehli dafa login kare. |
| `--quota 10G` + `--period total/monthly/daily` | Data limit; `total` = poore package mein, `monthly`/`daily` = har mahine/din naya |
| `--daily-time 2h` | Roz itna online time |
| `--rate`, `--devices` | Speed aur ek waqt mein kitne devices |

**2. Vouchers (cards)** — dashboard → *Vouchers* → Create (ya Plans mein plan ke saath "Vouchers") → **Print cards** (A4, 3 cards per row, aap ka business naam, price, package, user/pass, Wi-Fi naam):
```bash
sudo radius-admin voucher create day-1gb 100 --prefix WF --note "Counter, October"
sudo radius-admin voucher create day-1gb 50 --pin          # PIN mode: username = password (customer ek hi code likhta hai)
sudo radius-admin voucher list                              # unused / active / expired / bik gaye
sudo radius-admin voucher csv 12 > batch12.csv              # Excel ke liye
sudo radius-admin voucher del 12                            # sirf unused cards hatata hai
```

**3. Monthly customers (subscriptions):**
```bash
sudo radius-admin user add ahmed -p 'secret'
sudo radius-admin user plan ahmed month-10gb               # plan lagaya (sale record hoti hai; --free = muft)
sudo radius-admin user renew ahmed                          # agle mahine: expiry barhao, data counter zero
sudo radius-admin user expiry ahmed '2026-12-31 23:59'      # khas tareekh tak
sudo radius-admin user quota ahmed 20G                      # is user ka apna data limit
sudo radius-admin user status ahmed                         # plan, expiry, quota, RADIUS ka jawab
sudo radius-admin sales 30                                  # 30 din ki kamai
```
Dashboard mein user ke page par **Package** card: plan, expiry, data bar (kitna use hua), Set plan / Renew / Expiry / Quota.

**Kaise lagu hota hai** (FreeRADIUS + MySQL function `ml_check`, har login par):
- Package khatam / data khatam / aaj ka time khatam → **login reject**, aur wajah hotspot login page par dikhti hai ("Your package has expired", "Your data quota is used up", "Daily time limit reached").
- Login ho to MikroTik ko **Session-Timeout** (baqi waqt) aur **Mikrotik-Total-Limit + Gigawords** (baqi data, 4 GB se zyada bhi) bheja jata hai — limit puri hote hi MikroTik khud disconnect karta hai.
- Voucher ki **pehli login** par validity shuru hoti hai aur sale record hoti hai (ek hi dafa).
- Data `radacct` se ginti hai — hotspot profile mein `radius-interim-update=5m` (hamari `hotspot.rsc` mein hai) zaroori hai.
- Limits **hotspot, MAC auth, PPPoE aur WPA-Enterprise (PEAP/TTLS)** — sab par lagti hain. WPA-Enterprise mein check tunnel ke andar asal user par hota hai; package khatam ho to Wi-Fi login fail hota hai, warna Session-Timeout (baqi waqt) Wi-Fi ko bheja jata hai.
- WPA-Enterprise phones "anonymous" naam bhejte hain: login par device ka MAC → asal user yaad rakha jata hai (`ml_eap_identity`), aur accounting mein "anonymous" ki jagah asal username likha jata hai — taa ke data quota, enforcer, online list aur reports sahi user par hon.
- Wi-Fi par data quota MikroTik khud nahi kaat-ta (Total-Limit sirf hotspot mein hai): enforcer har 5 minute quota khatam hone par Disconnect (ya FUP par CoA) bhejta hai. Router par `/radius incoming accept=yes` zaroori; Wi-Fi par Disconnect/CoA support apne RouterOS version par ek dafa test karein.
- **PIN mode** (vouchers): card par ek hi code hota hai jo username bhi hai aur password bhi — customer sirf ek code likhta hai (login page par "Card par sirf PIN hai").

**Dashboard:** *Plans*, *Vouchers* (batches, print, delete unused), *Sales* (roz ki kamai, plan wise, recent), Dashboard par "Sales today / this month" aur "Active packages / unused vouchers". *Settings → Business & branding*: business naam, currency, hotspot Wi-Fi naam, login address, contact, card ke neeche ka text.

**Hotspot login page:** `mikrotik/hotspot-login/login.html` — mobile-friendly, voucher/PIN ke liye (PIN checkbox), error (package expired wagera) dikhata hai, CHAP (password clear text mein nahi jata). Winbox → Files → `hotspot/login.html` replace karein (`md5.js` wahin rehne dein); `BRAND` text badal dein.

## 5e. Users ke liye connect guide (link bhejein)

`https://<server>:8443/connect` — **login ke bina** khulta hai (sirf ye page aur certificate; baqi dashboard band rehta hai).
- Tabs: **Android, iPhone/iPad, Windows, Mac, Hotspot/Voucher** — phone khud pehchan kar sahi tab kholta hai.
- Har step ke saath **phone screen jaisi tasveer**, jis mein aap ke Wi-Fi ka naam, domain aur bharne wale fields highlight hote hain.
- Android 11–12 ke liye **certificate download** button (`ca.der`) aur install ke steps.
- "Masla ho to" hissa aur aap ka contact number.
- Naam Settings → Business & branding se aate hain. Link seedha tab par: `/connect#hotspot`, `/connect#iphone`.

WhatsApp par link bhejein, ya Wi-Fi ke paas QR/poster laga dein. Users ka phone server tak pohanch sake (LAN, ya server public ho to internet se).

## 5f. PPPoE users (ISP style)

Ghar/dukaan ke router PPPoE se username/password par chalte hain — wohi RADIUS, wohi plans, wohi dashboard.

**Router:** `mikrotik/pppoe-server.rsc` (pool, PPP profile, PPPoE server on `ether2`, `/ppp aaa use-radius=yes accounting=yes interim-update=5m`, `/radius ... service=ppp`, `/radius incoming accept=yes`). Placeholders badal kar import karein.

**Server:**
```bash
sudo radius-admin nas add <router-ip>
sudo radius-admin plan add home-10m --price 1500 --validity 30d --quota 200G --period monthly \
     --fup 2M/2M --rate 10M/10M --pool pppoe-pool --devices 1
sudo radius-admin user add ahmed -p 'Secret#1'
sudo radius-admin user plan ahmed home-10m
sudo radius-admin user ip ahmed 10.20.0.50          # static IP (optional; '-' = pool se)
sudo radius-admin user renew ahmed                   # agla mahina
```
- **Login:** PAP, CHAP, MSCHAPv2 — sab chalte hain (password RADIUS mein cleartext ya NT-hash, MSCHAPv2 ke liye dono theek).
- **Speed:** plan/group ka `--rate` → `Mikrotik-Rate-Limit`. **IP:** user ka static IP (`Framed-IP-Address`) ya plan/group ka pool (`Framed-Pool`; MikroTik par isi naam ka `/ip pool` ho).
- **Expiry:** login par `Session-Timeout` = baqi waqt; expire hone ke baad login reject.
- **FUP (Fair Usage):** `--fup 2M/2M` wale plan mein quota khatam hone par internet **band nahi**, speed kam ho jati hai. Bina FUP ke quota khatam = cut off.
- **Enforcer (cron, har 5 minute — `radius-admin enforce`):** chalte hue sessions bhi check hote hain — package khatam → RADIUS **Disconnect**; quota khatam + FUP → RADIUS **CoA** se speed live kam (har session par ek dafa). PPPoE mein Total-Limit nahi hota, is liye ye zaroori hai. Haath se: `sudo radius-admin enforce -v`.
- Dashboard: plan form mein "Speed after quota (FUP)" aur "IP pool"; user page par "Static IP (PPPoE)"; group form mein IP pool; Online page par PPPoE sessions IP ke saath.
- Connect guide mein **"PPPoE router"** tab (TP-Link/Tenda wagera mein WAN = PPPoE, username/password).

## 5g. CDN detective — ye kis app ka CDN hai?

Reports mein aksar ajeeb naam/IP aate hain (`rr3---sn-4g5e6nsz.googlevideo.com`, `scontent.fkhi1-1.fna.fbcdn.net`, `e9876.a.akamaiedge.net`, `23.40.1.2`). Detective batata hai ke asal mein kaunsi app/site hai — aur kyun:

| Sabooth | Misal |
|---|---|
| 1. **Naam** — 60+ apps ki list (`tools/cdn-apps.json`) | `googlevideo.com` → YouTube (`sn-` = ISP ke andar Google cache), `fbcdn.net` → Facebook (`fna` = ISP ke andar Meta cache), `cdninstagram.com` → Instagram, `tiktokcdn/ibyteimg/byteoversea` → TikTok, `nflxvideo.net` → Netflix, `igamecj/gcloudsdk` → PUBG ... |
| 2. **DNS logger ka sabooth** | Device ne `www.daraz.pk` poocha → jawab `…edgekey.net` → `e9876.akamaiedge.net` → `23.40.1.2`. To ye Akamai IP *is device ke liye* **Daraz** hai |
| 3. **IP ka malik** (ASN lists: Meta, Google, ByteDance, Netflix, Akamai, Cloudflare, Amazon, Microsoft, Apple, Telegram ...) | `157.240.x.x` → Meta, `91.108.x.x` → Telegram, `104.16.x.x` → Cloudflare (shared — app unknown) |
| 4. **Context** | Bare `d1abcd.cloudfront.net` — device ne 15 second pehle `olx.com.pk` khola tha → shayad OLX (low confidence) |

Har jawab ke saath **confidence** (high / medium / low) aur **wajah**.

```bash
sudo radius-admin cdn scontent.fkhi1-1.fna.fbcdn.net
sudo radius-admin cdn 23.40.1.2
sudo radius-admin cdn unknown          # aaj ka sab se bhari traffic jiska naam nahi mila (sirf IP / shared CDN)
sudo radius-admin cdn update           # IP owner lists naye (cron har hafte khud karta hai)
```
Dashboard → **CDN detective**: naam/IP likhein → app, confidence, wajah, IP owner, DNS sabooth (kis device ne kya poocha); neeche "Heavy traffic without a site name" + Investigate. Data usage mein jo site sirf IP ho us par 🔍 link.

**Reports par asar:** Visited sites, history aur Data usage ab CDN ki jagah **app ke naam** se gintay hain (googlevideo + ytimg → youtube.com; fbcdn → facebook.com ...). Bare shared-CDN naam visits mein shamil nahi hote; un ka data (traffic collector mein) usi site ke khate mein jata hai jo device ne abhi khola tha.

### Auto-learning — har app ki domain list khud barhti rehti hai

Har ghante (cron, `radius-admin cdn learn`) learner DNS log dekh kar naye domains khud seekhta hai:

| Sabooth | Misal | Wazan |
|---|---|---|
| **CNAME app → naya domain** | `www.tiktok.com` → `v16.tiktok.tiktokcdn-new.net` | mazboot |
| **CNAME naya → app** | `img.fbnew.net` → `scontent.xx.fbcdn.net` | mazboot |
| **IP ka malik** (sirf ek app wali company) | `api.bytenew.com` → sirf ByteDance IPs → TikTok | darmiyana |
| **Saath saath** | 3+ devices TikTok kholte hi 5 second mein `cdn.tkstatic.net` maangte hain | kamzor (zyada devices aur wazeh akseriyat chahiye) |

- Score kafi ho, kam az kam 2 devices (saath-saath ke liye 3+), aur ek app wazeh jeete (75%+) — tab hi seekha jata hai. Is tarah `app-measurement.com` jaise sab apps mein istemal hone wale SDK kisi app ke naam nahi lagte.
- Seekhe hue domains foran har jagah istemal hote hain: reports (sites, history, data usage), detective, aur **RouterOS block script**.
- Ghalat seekha? `sudo radius-admin cdn reject DOMAIN` (ya dashboard mein Reject) — hat jata hai aur dobara kabhi nahi seekha jata.
- **Bina DNS ke traffic:** jo app IP par seedha jati hai (DNS ke bina), us ka data IP ke malik se naam pata hai agar wo company ek hi app chalati hai (ByteDance → TikTok, Netflix, Telegram, Steam, X).

```bash
sudo radius-admin cdn apps                  # har app aur us ke domains (built-in + learned)
sudo radius-admin cdn learned TikTok        # TikTok ke seekhe hue domains, sabooth ke saath
sudo radius-admin cdn learn                 # abhi seekho
sudo radius-admin cdn rsc TikTok > block-tiktok.rsc     # router par poori TikTok list block
```
Dashboard → CDN detective → **App domain lists**: har app khol kar domains (built-in / learned / local), sabooth (cname/ip/cooc, kitne devices, kab se), **Reject**, **Learn now**, aur **⬇ RouterOS block script**.

**Apni apps add karein:** `/var/lib/mikrotiklover/cdn-apps.local.json` (same format, pehle check hoti hai):
```json
{"apps": [{"app": "My Bank", "site": "mybank.pk", "category": "finance", "domains": ["mybank-cdn.net"]}]}
```

## 6. Monitoring aur testing

```bash
sudo radius-admin test ali              # MSCHAPv2 test (reply attributes bhi dikhata hai)
sudo radius-admin test ali --peap       # asli Wi-Fi client jaisa PEAP test (eapol_test)
sudo radius-admin online                # abhi kaun connected hai (IP, MAC, data)
sudo radius-admin log 50                # last 50 login attempts (Accept/Reject)
sudo radius-admin usage ali             # 30 din ka daily usage
sudo radius-admin status | restart
```

Problem ho to debug mode:

```bash
sudo systemctl stop freeradius && sudo freeradius -X    # har request ka poora detail
```

| Masla | Hal |
|---|---|
| Log mein kuch nahi aata | Firewall/port 1812, ya NAS IP galat (`freeradius -X` mein "unknown client" dikhega) |
| `Access-Reject` | Galat password, user disabled, ya `--max-sessions` poore |
| Android connect nahi hota | Domain field = `RADIUS_DOMAIN`, CA certificate sahi select karein |
| Hotspot login fail, Wi-Fi theek | User `--nt-hash` se bana hai — hotspot CHAP ke liye `user passwd NAME` (bina `--nt-hash`) |

## 7. Maintenance

- **Certificate renew** (825 din baad, ya domain badalna ho): `sudo RENEW_CERT=1 ./install.sh` — CA wohi rehta hai, devices ko kuch nahi karna.
- **Backup**: `sudo mysqldump radius > radius-$(date +%F).sql` + `/etc/mikrotiklover-radius/` + `/etc/freeradius/3.0/certs/mikrotiklover/`.
- **Purana accounting data saaf**: `DELETE FROM radacct WHERE acctstoptime < NOW() - INTERVAL 180 DAY;`
- Installer jo packaged files badalta hai unki original copy `*.mikrotiklover.orig` naam se save hoti hai.
