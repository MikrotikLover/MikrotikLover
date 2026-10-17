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

> 📘 **Poori installation aur configuration guide (shuru se aakhir tak, tarteeb ke saath): [`docs/INSTALL.md`](docs/INSTALL.md)**

## 1. Install (Ubuntu 22.04/24.04, Debian 12/13)

**Aik command (one-click):**
```bash
curl -fsSL https://raw.githubusercontent.com/MikrotikLover/MikrotikLover/main/radius/get.sh | sudo bash
```
Yeh 3 sawal poochta hai (server ka naam, company ka naam, dashboard kaun khole), phir sab khud karta hai: system check (OS, RAM ≥1 GB, disk ≥3 GB, internet, 1812/1813 khali), code `/opt/mikrotiklover` mein, poora install, aur aakhir mein health check. Sawal ke baghair:
```bash
curl -fsSL .../radius/get.sh | sudo bash -s -- --domain radius.yourcompany.com --yes [--web-allow any] [--firewall]
```
**Update:** wohi command dobara chalayein — users, settings aur data rehte hain (dashboard ki port / allow list bhi yaad rehti hai).

Ya haath se:
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
| `kids-night` | School ki raaton 22:00–06:00 internet band, games 21:00–07:00 band (aadhi raat paar karne wala waqt khud do hisson mein toot jata hai) |
| `no-video` | Facebook/Instagram **videos & Reels**, YouTube **videos**, TikTok band — Facebook feed, photos, Messenger, WhatsApp, Google chalte hain |
| `no-video-day` | Wohi, lekin sirf din mein (8:00–20:00); raat ko videos chalti hain |

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

#### Facebook / YouTube / TikTok video block — 3 users ka test

```
sudo radius-admin user policy ali  no-video        # ali: videos hamesha band
sudo radius-admin user policy sara no-video-day    # sara: videos sirf din mein band
#                                                    bilal: koi policy nahi — sab chalta hai
```
(Ya dashboard → Users → user → *Own web-filter policy*. Poore group par: `radius-admin group add class-9 --policy no-video`.)
Router par `webfilter-base.rsc` aur `webfilter-policies.rsc` import hon. User agar pehle se connected ho to woh kick ho jata hai, aur dobara login par policy lagti hai.

| | ali 11:00 | ali 22:00 | sara 11:00 | sara 22:00 | bilal |
|---|---|---|---|---|---|
| Facebook feed / photos / Messenger | ✅ | ✅ | ✅ | ✅ | ✅ |
| Facebook video / Reel (`video*.fbcdn.net`) | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| YouTube page (search, comments) | ✅ | ✅ | ✅ | ✅ | ✅ |
| YouTube video (`*.googlevideo.com`) | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| TikTok (poori app) | ⛔ | ⛔ | ⛔ | ✅ | ✅ |
| WhatsApp, Google | ✅ | ✅ | ✅ | ✅ | ✅ |

**Kaise:** Facebook, Instagram aur Messenger ki videos alag server names `video….fbcdn.net` se aati hain, jabke photos `scontent….fbcdn.net` se aati hain. Is liye sirf video band hoti hai aur baqi app chalti hai. YouTube ki videos `googlevideo.com` se aati hain. TikTok poori ki poori video hai, is liye poori app band hoti hai. Yeh category `webfilter/categories/social-video.txt` mein hai: `*` wali line pattern hoti hai, aur baqi lines domain hain jin ke subdomains bhi band hote hain. Is category ko kisi bhi policy mein `block social-video` likh kar lagaya ja sakta hai.

**Note:**
- Pehle se download ki hui (offline) videos chal jayengi.
- Kabhi kabhi Facebook purani videos `scontent` server se bhi deta hai. Aisi video agar chal jaye to `block social` se poora Facebook band karein.
- Agar koi VPN istemal kare to VPN bhi band karna hoga: `block vpn-proxy`.

Policy hatana: `sudo radius-admin user policy ali -` (wapas group policy), ya address-list entry remove.

**Kaise kaam karta hai:** HTTPS connection ke shuru mein website ka naam (SNI) jata hai; router har policy ke liye us naam ko category list se milata hai (`wf-social`, `wf-gaming` ... chains — sab policies share karti hain). Policy wale users ka QUIC (UDP 443) band hai taa ke browser TCP par aaye jahan naam dikhta hai. Agar policy ki sab blocks par `time=` laga ho to QUIC bhi sirf usi waqt band hota hai. `dns ...` wali policy ke users ka DNS us family-safe DNS par jata hai (adult sites wahan band). `tests/simulate-policies.py` 39 cases check karta hai (office time, raat, har policy ki DNS, normal users par asar nahi).

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

> **Asaan tareeqa (section 5h):** Dashboard → **Blocking** → "Give a policy to a user" → `whatsapp-only` → **Apply**. Router auto-sync hone par neeche ke kisi command ki zaroorat nahi parti. Neeche wala tareeqa un devices ke liye hai jo RADIUS se login nahi karte (MAC/IP/subnet).

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

> **Per user / group (behtar):** policy mein `block-vpn`, ya tayyar policy `no-vpn` (section 5h). Is se VPN apps aur websites, network par dekhe gaye VPN servers (yeh list khud barhti hai), aur VPN protocols sab band ho jate hain. Har koshish **VPN watch** mein dikhti hai.

`webfilter-vpn-proxy.rsc` VPN ki **websites** band karti hai. Yeh script **sab** users ke liye install shuda VPN apps ke **connections** rokti hai: OpenVPN, WireGuard, Cloudflare WARP, PPTP, L2TP, IPsec aur Tor. Har koshish log hoti hai (prefix `WF-vpn`), is liye `radius-admin vpn` mein nazar aati hai.
- `web-filter-exempt` (IT/manager) par is ka asar nahi hota.
- Office ka IPsec VPN use hota ho to IPsec wale rules hata dein.
- Jo VPN port 443 par HTTPS ban kar chalti hai (Psiphon) woh sirf port band karne se nahi rukti. Usay `block-vpn` policy ki server list aur naam pakadte hain, ya allow-only profile lagayein.

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
python3 tests/test-cdndiscover.py     # new apps: grouping, name from website/domain, category, rename/merge/drop
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

**Hotspot pages:** `mikrotik/hotspot-login/login.html` (+ `status.html`, `alogin.html`: login ke baad waqt / data baqi aur "khabardar" warning, section 7g) — `login.html` mobile-friendly, voucher/PIN ke liye (PIN checkbox), error (package expired wagera) dikhata hai, CHAP (password clear text mein nahi jata). Winbox → Files → `hotspot/login.html` replace karein (`md5.js` wahin rehne dein); `BRAND` text badal dein.

## 5e. Users ke liye connect guide (link bhejein)

`https://<server>:8443/connect` — **login ke bina** khulta hai (sirf ye page aur certificate; baqi dashboard band rehta hai).
- Tabs: **Android, iPhone/iPad, Windows, Mac, Hotspot/Voucher** — phone khud pehchan kar sahi tab kholta hai.
- Har step ke saath **phone screen jaisi tasveer**, jis mein aap ke Wi-Fi ka naam, domain aur bharne wale fields highlight hote hain.
- Android 11–12 ke liye **certificate download** button (`ca.der`) aur install ke steps.
- "Masla ho to" hissa aur aap ka contact number.
- Naam Settings → Business & branding se aate hain. Link seedha tab par: `/connect#hotspot`, `/connect#iphone`.

WhatsApp par link bhejein, ya Wi-Fi ke paas QR/poster laga dein. Users ka phone server tak pohanch sake (LAN, ya server public ho to internet se).

## 5e2. Ports & protocols — kaunsa port IN, kaunsa OUT, kaunsi app kya istemal karti hai

Traffic collector (section 5b, `traffic-flow.rsc`) har connection ka protocol aur port bhi save karta hai:

| Rukh | Matlab | Misal |
|---|---|---|
| **OUT** | LAN device ne internet par kisi service se connection banaya | `443/tcp` HTTPS, `443/udp` QUIC (YouTube), `5222/tcp` WhatsApp chat |
| **IN** | **internet se** connection LAN device tak aaya (port-forward, DVR/camera, server) | `37777/tcp` Dahua DVR, `3389/tcp` RDP |
| **P2P** | dono taraf "high" ports — calls, games, torrents | `50123/udp` |

- Har port ka naam: 100+ maloom services (HTTPS, QUIC, DNS, STUN/TURN calls, WhatsApp, push notifications, VPNs, RDP, Winbox, DVR cameras, games, BitTorrent ...).
- Kaunsa side "service" hai: well-known port (< 1024 ya list mein) → registered (< 32768) → ephemeral; jo side zyada "service" ho wahi port, aur usi se IN/OUT.
- Hourly data `traffic_port` mein (90 din); har app ka **port profile** `ml_app_port` mein **hamesha** (pehli aur aakhri dafa, kitna data) — purana traffic delete hone ke baad bhi.

```bash
sudo radius-admin ports                              # aaj ke top ports: protocol, port, service, OUT/IN/P2P, data, devices, apps
sudo radius-admin ports --by app --app whatsapp.com  # WhatsApp kaunse ports/protocols istemal karti hai
sudo radius-admin ports --by device --ip 192.168.88.23
sudo radius-admin ports --by in                      # internet se andar aane wale connections (security check)
sudo radius-admin ports --by profile                 # saved profile: har app ke ports, kab se
```
Dashboard → **Ports & protocols**: Top ports · App → ports · Devices · **Inbound (IN)** · **Saved app profiles**, aur upar OUT / IN / P2P ka total.

> IN/OUT andaza ports se hai: agar LAN par koi service ghair-maroof port par chal rahi ho to woh P2P dikh sakti hai. Unknown **IN** entries zaroor dekhein — ho sakta hai koi port-forward ya khula device ho.

## 5e3. Apps on network — network par chalne wali har app ki list (khud banti hai)

Har ghante (cron, `cdn learn` ke baad) router ke DNS log se **har app** ki list khud banti hai. Is ke liye kuch add nahi karna padta:

- **Pehchani hui apps:** 49 apps catalog mein pehle se hain, jaise Facebook, WhatsApp, YouTube, TikTok, PUBG, Netflix, Daraz, Spotify waghera. In ke naye domains bhi khud seekhe jate hain (section 5g).
- **Nayi apps:** jo app catalog mein nahi, woh bhi khud dhoondi jati hai (section 5g). Agar 3 ya zyada devices use karein to list mein **auto-discovered** ke nishan ke saath aati hai, aur us ka naam us ki website ke title se rakha jata hai.
- **Har app ke liye save hota hai:** category, kitne devices, kaun se users, kitni lookups, kitna data (traffic collector se), **pehli dafa kab dekhi** aur **aakhri dafa kab dekhi**. Pichhle 7 din mein pehli baar dekhi gayi app par **NEW** likha aata hai.
- **Kahan save hota hai:**
  - `ml_app`: har app hamesha ke liye.
  - `ml_app_day`: din, app aur device ke hisaab se, 180 din tak (`APP_DAYS` se badal sakte hain).
  - Ek hi din ko dobara padhne par purani ginti badal di jati hai, is liye kuch do baar nahi ginta.

```bash
sudo radius-admin apps                      # 7 din: app, category, devices, users, data, first/last seen, NEW
sudo radius-admin apps --days 30 -u ali     # ali ne kaun si apps chalayin
sudo radius-admin apps --category gaming    # sirf games
sudo radius-admin apps new                  # is hafte pehli dafa nazar aane wali apps
sudo radius-admin apps users "PUBG Mobile"  # PUBG kaun kaun se device/user chala raha hai
sudo radius-admin apps update               # abhi update karein (cron har ghante karta hai)
```

**Dashboard → Apps on network:**
- Category tabs: video, social, gaming, messaging...
- **Users**: kaun kaun se device ya user yeh app chala raha hai.
- **Domains**: app ki domain list (CDN detective).
- **⬇ Block**: is app ke tamam maloom domains band karne ka RouterOS script.

> **Note:**
> - Router par DNS logging on honi chahiye: `radius-admin dnslog on` aur `dns-logging.rsc`.
> - Data (MB/GB) ke liye traffic collector bhi chahiye.
> - Jo device DNS bypass kare, us ki apps is list mein nahi aatin. Misaal: exempt list wala device, ya family-DNS wali policy.

## 5h. Blocking dashboard se — user ko apps/websites band karna, WhatsApp-only, VPN

**Dashboard → Blocking** par 3 qadam hain:

1. **Policy banayein:** "+ New policy" dabayein. Is mein yeh sab chun sakte hain:
   - categories tick karein (social, sirf videos, YouTube/Netflix, games, messaging, torrent, adult words);
   - **single apps** dhoond kar tick karein (PUBG Mobile, TikTok, Snapchat...). App ke tamam domains band hote hain, network par khud seekhe gaye domains bhi;
   - **Block VPN**;
   - waqt: "Always", ya "Only at these times" (misaal 09:00 → 17:00, Mon–Sat);
   - mode **WhatsApp ONLY**: sirf WhatsApp chalta hai, baqi sab band;
   - mode **No internet**.

   Neeche "Policy file" mein wohi dikhta hai jo server save karta hai.
2. **User ya group ko dein:** "Give a policy to a user" mein naam likhein, policy chunein aur **Apply** dabayein. Poore group ke liye "Give a policy to a whole group" istemal karein. Doosra tareeqa: Users → user → *Own web-filter policy*. User ek dafa disconnect hota hai aur agle login par nayi policy lag jati hai.
3. **Router auto-sync (sirf ek dafa):** "Router auto-sync" mein server ka IP likhein, **⬇ Download router script** dabayein, file router par upload karein aur `/import mikrotiklover-autosync.rsc` chalayein (`mikrotik/autosync.rsc`).
   - Router har 15 minute mein server se poochta hai ke kuch badla hai ya nahi. Badla ho to policies, app lists aur VPN server list khud import kar leta hai.
   - Pehle `webfilter-base.rsc` ek dafa haath se import hona chahiye.
   - Router par server ka naam (certificate wala) `/ip dns static` se server IP par point karta hai, aur server ka CA ek dafa import hota hai. Yeh dono kaam script khud karti hai.

**Tayyar policies:**

| Policy | Kya hota hai |
|---|---|
| `no-video` / `no-video-day` | Facebook/YouTube/TikTok videos band (din mein ya hamesha) |
| `no-tiktok-pubg` | Single apps ki misaal: TikTok + PUBG |
| `no-vpn` | VPN band, baqi sab chalta hai |
| `whatsapp-only` | Sirf WhatsApp |
| `students` | Social, video, games, VPN, torrent, adult words band; family DNS |
| `staff` | Office time mein social/video band |
| `guests` | Torrent, VPN, adult band |
| `no-internet` | Internet band |
| `night-off` | Raat 12 se 6 tak internet band |
| `kids-night` | School ki raaton (itwar–jumeraat) 22:00–06:00 internet band, games 21:00–07:00 band. Aadhi raat paar karne wala waqt khud do hisson mein toot jata hai |

CLI:
```bash
sudo radius-admin policy list                         # policies, kya band, kaun use kar raha
printf '# Kids\nblock-app TikTok\nblock social-video\nblock-vpn\n' | sudo radius-admin policy set kids
sudo radius-admin user policy ali kids                # ek user
sudo radius-admin group add class-9 --policy kids     # poora group
sudo radius-admin policy sync                         # router auto-sync ka URL + key
```
Policy file ke sab directives `webfilter/policies/README.txt` mein hain (`block`, `block-app`, `block-vpn`, `allow-only`, `block-all`, `dns`, `strict-ech`, `time=`).

### VPN watch — VPN server list khud banti hai, aur pata chalta hai kaun VPN chalane ki koshish kar raha hai

Har ghante server teen jagah se VPN ki nishaniyan dhoondta hai (`tools/vpn.py`):

| Kahan se | Kya pakra jata hai |
|---|---|
| DNS log | VPN app ya website ka naam: catalog ki VPN apps (NordVPN, Psiphon, Proton, Hotspot Shield, WARP...), `vpn-proxy` list, ya jis naam mein **"vpn"** ho (Turbo VPN, Thunder VPN, waghera). Jo IP woh naam deta hai, woh **VPN server list** mein chala jata hai |
| Router log | Router ne VPN connection roka (`WF-vpn`): kis user ne, kis server/port par |
| Traffic flows | VPN protocol (OpenVPN 1194, WireGuard 51820, WARP 2408, IPsec, L2TP, PPTP/GRE, Tor), ya pehle se maloom VPN server se connection (port 443 par chhupi "stealth" VPN bhi) |

- **VPN server list** (`ml_vpn_server`) aur **VPN names** (`ml_vpn_domain`) khud barhti hain. Har ghante router ki address list `vpn-servers` aur `wf-vpn` chain mein pahunch jati hain (auto-sync).
- Shared CDN (Cloudflare, Akamai, Google...) ke IP list mein **kabhi nahi** daale jate. Jo IP aam websites bhi deta ho, woh bhi nahi.
- **Public lists (ikhtiyari):** `sudo radius-admin vpn update` chalane se VPN providers ki public list (X4BNet) aur Tor exit nodes bhi list mein aa jate hain. Phir yeh hafte mein ek dafa khud update hoti hain.
- **Office VPN:** `sudo radius-admin vpn ignore vpn.mycompany.com`, ya dashboard par **Not a VPN**. Phir yeh kabhi list ya block nahi hota.

```bash
sudo radius-admin vpn                 # 7 din: kab, kaun user, device, kaunsi VPN, kya, BLOCKED / CONNECTED?
sudo radius-admin vpn users           # har user: kaunsi VPN, kitni koshishen, blocked ya nahi
sudo radius-admin vpn servers         # khud bani VPN server list
sudo radius-admin vpn domains         # VPN names
sudo radius-admin vpn -u ali --days 30
```

**Dashboard → VPN watch** mein yeh tabs hain:
- **Who tried:** user, kaunsi VPN, kitni koshishen. Natija *blocked*, *seen*, ya *maybe connected* hota hai. *Maybe connected* ka matlab hai VPN ne data chalaya, yani us user par abhi block policy nahi hai.
- **All attempts:** har koshish, DNS / router blocked / traffic ke badge ke saath.
- **VPN servers** aur **VPN names:** khud bani lists. Har row par "Not a VPN" button hai.
- **How to block:** block karne ke qadam.

**Tests:**
- `tests/test-vpn.py`: 22 cases. In mein VPN app, "vpn" naam, ignore list, CDN IP ka list mein na aana, router block, OpenVPN/WireGuard/GRE aur stealth 443 shamil hain.
- `tests/simulate-policies.py`: 63 cases. In mein `no-vpn`, `whatsapp-only` aur single apps bhi hain.
- `tests/ui-dashboard.mjs`: dashboard mein policy banana, user ko dena, WhatsApp-only, router script download aur VPN watch pages.

> **Hadd (limits):**
> - Jo VPN apna server naam chhupaye aur naye IPs par port 443 par chale (Psiphon jaisi), woh pehli dafa pakri nahi jati. Jaise hi us ka koi naam ya IP list mein aata hai, woh bhi rukti hai. Aise users ke liye `whatsapp-only` jaisa allow-only profile sab se pakka hai.
> - Asal MikroTik par auto-sync script abhi test nahi hui. Pehle ek router par chala kar `/log print where message~"ml-sync"` dekhein.

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

### Nayi apps khud dhoondna — naam bhi khud

Jo app list mein hai hi nahi (koi nayi video app, game, shopping app), learner use bhi khud pakarta hai:

1. **Groups:** jo domains kisi maloom app ke nahi aur kayi devices par aate hain, unhein ek app mein jora jata hai jab:
   - CNAME se jure hon (`api.zingclips.in` → `edge.zc-feed.net`),
   - saath saath maange jayein (3 second ke andar, baar baar, kayi devices),
   - **ek jaisa brand** ho (`zingclips.in`, `zingclips-cdn.com`),
   - ya same (shared CDN ke ilawa) IP par hon.
2. **Shart:** kam az kam 3 devices (ya 2 devices aur 20+ lookups). Analytics/ads SDK (Firebase, AppsFlyer, Adjust, OneSignal, Unity Ads, AppLovin ...) aur certificate/time servers kabhi app nahi bante.
3. **Naam:** server us app ki website ka title/`og:site_name` parhta hai ("Zing Clips - Short Videos" → **Zing Clips**). Sirf public IP wali sites; LAN/localhost kabhi nahi. Internet na ho ya title bekaar ho to domain ke brand se naam (`zingclips` → **Zingclips**). Title fetch band karna: `/etc/mikrotiklover-radius/radius.conf` mein `CDN_FETCH_TITLES=0`.
4. **Category** naam/domain ke alfaaz se: video, gaming, messaging, shopping, finance, music, vpn, news, education, social, adult, other.
5. Nayi app foran **har jagah** istemal hoti hai (reports, data usage, detective, block script), aur agle runs mein us ke naye CDN bhi khud us ki list mein jurte hain.

Dashboard → CDN detective → App domain lists: nayi apps sab se upar **"new"** badge ke saath — kab mili, kitne devices, naam kahan se aaya. Buttons: **Rename** (naam/category theek karein), **Merge into…** (asal mein kisi maloom app ka hissa hai), **Drop** (app nahi — dobara kabhi nahi dhoondi jayegi).
```bash
sudo radius-admin cdn discovered
sudo radius-admin cdn app-rename zingclips.in 'Zing Clips' video
sudo radius-admin cdn app-merge zingclips.in 'Kwai / Snack Video'
sudo radius-admin cdn app-drop zingclips.in
```

**Apni apps add karein:** `/var/lib/mikrotiklover/cdn-apps.local.json` (same format, pehle check hoti hai):
```json
{"apps": [{"app": "My Bank", "site": "mybank.pk", "category": "finance", "domains": ["mybank-cdn.net"]}]}
```

## 5i. Website names — har domain aur subdomain ka record

Har ghante DNS log se **har website ka naam**, domain aur subdomain dono, database mein save hota hai (`ml_domain`, hamesha ke liye). Har naam ke saath yeh bhi save hota hai:
- pehli aur aakhri dafa kab dekha;
- kis app ka hai;
- aakhri IP addresses;
- har din kitni lookups hui aur kitne devices ne kholi (`ml_domain_day`, 180 din).
```bash
sudo radius-admin domains                      # domains, kitne subdomains, first/last seen
sudo radius-admin domains bank                 # search
sudo radius-admin domains tree youtube.com     # youtube.com ke saare subdomains, lookups, IPs
sudo radius-admin domains export > names.csv
```
Dashboard → **Website names**: search karein, domain par click kar ke us ke subdomains dekhein, ya **CSV** download karein.

## 5j. VPN & proxy watch — proxy bhi pakri jati hai

VPN watch (section 5h) ab **proxy** bhi pakarta hai:
- Phone ya browser mein lagi proxy: HTTP proxy 3128/8118, SOCKS 1080.
- Web proxy websites: `vpn-proxy` list, aur jis naam mein "proxy", "unblock" ya "bypass" ho.

`block-vpn` policy proxy ports aur proxy naam bhi band karti hai. Har koshish **VPN & proxy watch** page aur `radius-admin vpn` mein dikhti hai.

## 5k. Security detective — virus, hacker attack, DDoS (type ke saath)

| Qism | Kya pakra jata hai |
|---|---|
| **Virus** (infected device) | Malware, phishing ya crypto-mining websites ki lookup (threat lists). DGA malware: bohot saare random naam jo exist nahi karte. Botnet server se baat. Spam bot (bohot saare mail servers). Internet scan (Mirai/Telnet, WannaCry/SMB, RDP, ADB...). LAN scan. Kisi ko flood karna (DDoS bot). Mining ports |
| **Hacker attack** | Port scan, network sweep. Password guessing on SSH, RDP, Winbox, API, Telnet, FTP, SMB, SIP; router login par; Wi-Fi/hotspot user par; dashboard par. Known attacker networks |
| **DDoS** | **Type ke saath:** SYN flood, UDP flood, ICMP flood, HTTP/HTTPS flood, aur **amplification/reflection**: DNS, NTP, SSDP, memcached, CLDAP, SNMP, Chargen, WS-Discovery... Bohot saare sources hon to DDoS, kam hon to DoS |

Kahan se pata chalta hai:
- **Traffic Flow:** har minute check hota hai, collector ke andar.
- **DNS log:** har ghante.
- **Router logs:** login failures, aur `security.rsc` ke WF-scan / WF-brute / WF-synflood / WF-threat hits.
- **Database:** RADIUS rejects aur dashboard ki login failures.

```bash
sudo radius-admin security                     # 7 din ke alerts: kab, qism, severity, kya, source/user, target
sudo radius-admin security --type ddos --high
sudo radius-admin security summary             # har type ki ginti
sudo radius-admin security update              # threat lists abhi (warna har hafte)
sudo radius-admin security autoblock on        # high attackers -> router list ml-attackers (1 din)
sudo radius-admin security dns-block on        # malware/phishing/mining names par 0.0.0.0 (DNS logger)
```

- **Router par:** `security.rsc` import karein. Is mein port-scan, password-guessing aur SYN-flood lists, threat lists (`ml-threats`) aur attackers (`ml-attackers`) dono taraf band, aur sab hits server ko log hote hain. Saath mein `webfilter-logging.rsc` ab router ki login failures bhi bhejti hai.
- **Dashboard → Security:** tabs All alerts, Virus (infected devices), Hacker attacks, DDoS attacks, Protection & lists. Protection & lists mein autoblock aur DNS-block ke switch hain.
- **Thresholds:** `radius.conf` mein `SEC_SCAN_PORTS=25`, `SEC_FLOOD_FLOWS=3000` waghera se badle ja sakte hain (`tools/sentinel.py` mein list hai).
- **Tests:** `tests/test-sentinel.py` 29 cases check karta hai. Asal collector par SYN flood, NTP amplification, port scan, spam bot aur threat IP bhi bheje gaye, aur sab sahi type ke saath pakre gaye.

> **Hadd:**
> - Yeh detection hai, antivirus nahi. Infected device ko saaf device par khud karna hoga.
> - Flow data router ke "active timeout" ke hisaab se aata hai, is liye bahut chhote attacks ka andaza kam lagta hai.
> - Bade DDoS ko ISP ke level par rokna parta hai; router sirf apne aap ko bacha sakta hai.

### Quarantine — infected device ko internet se alag karna

Virus wala device (spam bot, botnet server se baat, malware site, DGA...) **internet se kat jata hai**. Woh jo bhi `http://` page khole, usay ek warning page dikhta hai (screenshot neeche):
- "Aap ke device ka internet rok diya gaya hai";
- kya mila (misaal "Spam bot");
- saaf karne ke 5 qadam;
- aap ka contact number.

Android aur iPhone khud "Sign in to network" dikha kar yahi page khol dete hain. DNS chalta rehta hai; baqi sab band hota hai.

```bash
sudo radius-admin security quarantine ali "spam bot"     # user (har IP par, login ke saath chalta hai)
sudo radius-admin security quarantine 192.168.88.40      # sirf IP (printer, CCTV, bina login wala device)
sudo radius-admin security quarantined                   # list (history: purane)
sudo radius-admin security release ali                   # internet wapas; user ki purani policy wapas lagti hai
sudo radius-admin security quarantine-auto on            # HIGH virus alert -> 5 minute ke andar khud quarantine
sudo radius-admin security quarantine-server 192.168.88.10   # server ka IP jo router dekhta hai (warning page :8081)
```
- **Dashboard:** Security → **Virus** tab par har infected device ke saath **Quarantine** button hai, aur upar **Quarantine** list mein **Release**. **Protection & lists** tab par "Quarantine automatically" ka switch aur server IP hain.
- **Auto mode:** sirf **high** virus alert par lagta hai. Admin jis device ko release kare, woh 24 ghante tak dobara khud quarantine nahi hota.
- **Router par:** rules auto-sync se khud pohanchte hain (address list `ml-quarantine`). Router aur server ke darmiyan TCP 8081 khula hona chahiye.

## 5l. Blocking logs — kaunsi policy kis user ko kya block kar rahi hai

Dashboard → **Blocking → Blocking logs** (aur Reports → Blocked) par yeh dikhta hai:
- **Summary:** policy → user → kis cheez ne block kiya → kitni dafa.
- **Har koshish:** waqt, user/IP, **policy**, **kis ne block kiya** (category, app, VPN/proxy, allow-only, no internet, adult word, security), **website ka naam** (DNS log se) aur destination.
```bash
sudo radius-admin blocked --days 1             # time, user, ip, policy, blocked by, site, destination
sudo radius-admin blocked --summary            # policy / user / blocked by / times
sudo radius-admin blocked --policy kids
```
Policy user ki **abhi wali** policy hoti hai: apni policy, warna group ki. Jo devices RADIUS se login nahi karte, un ke liye "router list" likha aata hai.

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
- **Backup / restore**: section 7b. Har raat khud backup hota hai; `sudo radius-admin backup` / `restore`.
- **Purana accounting data saaf**: `DELETE FROM radacct WHERE acctstoptime < NOW() - INTERVAL 180 DAY;`
- Installer jo packaged files badalta hai unki original copy `*.mikrotiklover.orig` naam se save hoti hai.

## 7b. Complete backup aur restore

```bash
sudo radius-admin backup                       # abhi (database + settings + certificates + FreeRADIUS + policies + lists)
printf 'Pass12345\n' | sudo radius-admin backup --encrypt     # AES-256, password ke saath
sudo radius-admin backup --with-logs           # router / DNS logs bhi
sudo radius-admin backups                      # list
sudo radius-admin restore FILE                 # sab wapas (pehle maujooda haalat ki safety copy banti hai)
```
- Har raat 02:43 par khud backup hota hai (`/var/backups/mikrotiklover`, aakhri 14 rakhe jate hain).
- Dashboard → **Settings → Backups** mein list, **Backup now** aur **Download** hain.
- Restore sirf server par CLI se hota hai, taa ke ghalti se sab kuch na badal jaye.
- Naye server par le jana ho to `docs/INSTALL.md` section 9 dekhein: wahan install kar ke restore karein, database passwords khud theek ho jate hain.
- **Tested:** encrypted backup banaya, user aur policy badle, galat password par restore ruk gaya, aur sahi password se sab wapas aa gaya (login OK).

### Off-site copy (doosri jagah khud)

Har raat ka backup khud **doosre server (SSH)** ya **cloud (Google Drive / Dropbox / OneDrive / S3 — rclone se)** par bhi chala jata hai. Har copy password se encrypted hoti hai (AES-256), is liye wahan koi parh nahi sakta. Server ki disk mar jaye ya server chori ho jaye, data phir bhi bacha rahta hai.

```bash
# A) doosra Linux server / PC / NAS (SSH)
sudo radius-admin backup offsite ssh backup@192.168.1.20:/srv/backups [--port 22]
#    -> jo key dikhe, us server par ~/.ssh/authorized_keys mein daal dein (aik baar)
# B) cloud: pehle aik baar `sudo rclone config` (e.g. naam "gdrive"), phir
sudo radius-admin backup offsite rclone gdrive:mikrotiklover

sudo radius-admin backup offsite test          # connection check
sudo radius-admin backup offsite send          # abhi naya backup bhejein
sudo radius-admin backup offsite list          # wahan kaun si copies hain
sudo radius-admin backup offsite keep 30       # wahan aakhri 30 copies rakhein (purani khud mitti hain)
sudo radius-admin backup offsite password      # restore ke liye password (likh kar rakhein!)
sudo radius-admin backup offsite status | off
# server kharab ho gaya? naye server par install, phir:
sudo radius-admin backup offsite fetch         # newest copy wapas lao
sudo radius-admin restore mikrotiklover-....tar.gz.enc    # password puchega
```
- Dashboard → **Settings → Off-site copy**: SSH ya cloud chunein, target, kitni copies, **Test connection**, **Send newest backup now**, **Show password**, aur aakhri copy ka nateeja (ok / failed).
- Raat ki copy fail ho (server band, internet nahi) to backup phir bhi server par mehfooz rehta hai, aur **Automatic updates** list mein "Off-site backup: failed" dikhta hai.
- **Tested:** SSH (alag user + key) aur rclone (Google Drive jaisa remote): copy encrypted pahunchi, `keep 2` ne purani mitayin, server "kho" diya → `fetch` + `restore` se sab wapas, galat password par restore ruk gaya, backup server band par "failed" darj hua.

## 7f. Speed schedule — raat ko zyada speed, rush hours mein kam

Waqt ke hisaab se speed: misal ke taur par raat 22:00–08:00 sab ko 20M ("night package"), shaam 18:00–23:00 weekdays par aik group ko 2M, ya weekend par zyada speed.

```bash
sudo radius-admin speed add night-boost --rate 20M/20M --time 22:00-08:00              # sab ke liye, har din
sudo radius-admin speed add peak --rate 2M/2M --time 18:00-23:00 --days mon,tue,wed,thu,fri --group students
sudo radius-admin speed add weekend --rate 15M/15M --time 00:00-00:00 --days sat,sun --plan monthly-5M
sudo radius-admin speed add vip --rate 50M/50M --time 0-0 --user ali                    # aik user, poora din
sudo radius-admin speed list | del NAME | off NAME | on NAME
sudo radius-admin speed now ali ["2026-10-19 19:30"]   # ali ko is waqt (ya us waqt) kaunsi speed, aur kyun
sudo radius-admin speed apply                          # chalte sessions abhi badlein (warna 5 minute mein khud)
```
- **Kaise:** login par FreeRADIUS us waqt ki speed deta hai (`Mikrotik-Rate-Limit`). Jab waqt ki khirki shuru ya khatam ho, har 5 minute wala enforcer chalte sessions ki speed **RADIUS CoA** se badal deta hai — user ko dobara login nahi karna parta (router par `/radius incoming accept=yes` zaroori).
- **Kaun jeetta hai:** aik user > plan > group > sab; phir naya rule. Data quota khatam ho kar **FUP speed** lagi ho to woh hamesha jeetti hai. Khirki ke baad user apni normal speed par wapas aata hai (normal speed na ho to "0/0" = koi limit nahi).
- 22:00–06:00 jaisa waqt aadhi raat paar karta hai; din (`--days`) woh hai jis din waqt **shuru** hota hai (Friday 23:00–02:00 = Friday raat se Saturday subah tak).
- Dashboard → **Speed schedule**: rules ki list, har aik ki 24 ghante ki timeline aur "active / waiting" nishan; quick start buttons (Night boost, Peak-hour limit, Weekend boost); aur "Check a user": kisi bhi user ki kisi bhi waqt ki speed.
- **Tested:** login reply mein schedule wali speed; chalte session par nakli router ko CoA gaya 10M → 20M → 5M → 10M jaise rules band / chalu kiye; dobara chalane par kuch nahi bheja gaya; FUP wale session ko nahi chheda. `tests/test-speed.sh` (20 checks: aadhi raat, din, priority, off rules, CLI ghaltiyan).

## 7g. Pehle se khabardari — package / data khatam hone se pehle user ko batana

User ko **pehle** pata chal jaye taa ke woh waqt par renew kare:
- **Expiry se N din pehle** (default 2): "Aap ka package 18 Oct 01:13 ko khatam ho ga (19 ghante baqi). Renew ke liye: 0300-…"
- **Data ka X% istemal hone par** (default 90%): "Aap ka 920 MB data istemal ho chuka, sirf 80 MB baqi hai …"

Kahan dikhta hai:
1. **Hotspot status page** (login ke baad) aur `alogin.html` par narangi "⚠ Khabardar" box — `mikrotik/hotspot-login/status.html` aur `alogin.html` router par `hotspot/` mein daalein (login.html ke saath). Message RADIUS `Reply-Message` se aata hai (`$(radius18)`).
2. **SMS / WhatsApp** — jin users ka phone number ho, aik dafa har expiry date / data period ke liye, sirf din ke waqt (default 9–21). Koi bhi HTTP wala SMS ya WhatsApp gateway (Pakistani SMS companies, UltraMsg, Green-API …).
3. Dashboard: user ke page par "⚠ Warning this user sees now", aur Settings → **Warn users before it runs out** mein jin users ko abhi warning hai unki list, aur bheje gaye SMS.

```bash
sudo radius-admin notice                          # settings + kitne users ko abhi warning hai
sudo radius-admin notice set days 3               # 3 din pehle (0 = band)
sudo radius-admin notice set quota-pct 85         # 85% data par (0 = band)
sudo radius-admin notice set expiry-text "{user}, aap ka package {date} ko khatam. Renew: {contact}"
sudo radius-admin notice list | show ali
sudo radius-admin user phone ali 03001234567
sudo radius-admin notice gateway 'https://sms.example.pk/api?key=KEY&to={phone0}&msg={text}' --ok OK
#   POST/JSON gateway: --post '{"number":"{phone}","message":"{text}"}'
sudo radius-admin notice test 03001234567
sudo radius-admin notice set sms on               # har ghante khud bhejta hai
sudo radius-admin notice run --dry-run | log
```
- Fail hua SMS agle ghante dobara (aik din tak); kamyab SMS dobara kabhi nahi (nayi expiry / naya data period par naya).
- **Tested:** login reply mein warning (din / ghante, data MB); hotspot status page ka preview; SMS nakli gateway par GET (03.. number) aur POST JSON; ghalat key ka error log mein; aik dafa hi bheja; renew ke baad nayi warning. `tests/test-notice.sh` (21 checks) + `tests/test-alerts.py` mein SMS checks.

## 7e. Health check — sab theek hai?

`sudo radius-admin doctor` ya dashboard → **Health check**: server ka har hissa **sabz** (theek), **peela** (dekh lein) ya **laal** (abhi theek karein), aur kharabi ke saath us ka hal likha hota hai.

Kya check hota hai: FreeRADIUS (chal raha hai + 1812/1813 par sun raha hai), database aur us ki tables, dashboard (web + nginx), DNS logger (aakhri lookup kab aaya), traffic collector, router logs, cron, hourly jobs aur weekly updates (fail hue?), aakhri backup kitna purana, off-site copy, disk, memory, CPU, certificate kitne din valid, clock sync, alerts on hain ya nahi, aur har router (ping + aakhri login / accounting).

- `sudo radius-admin doctor --json` scripts / monitoring ke liye; masla ho to exit code 2.
- **Tested:** container restart ke baad sab services band thin to doctor ne har aik ko laal dikhaya; services chalane ke baad sabz. Router jo ping na de laal, range wala peela. `tests/test-health.py` (25 checks) har check ko nakli haalat mein chalata hai.

## 7d. Alerts — Telegram / WhatsApp / Email

Server khud aap ke phone par message bhejta hai jab kuch gadbad ho. Har 5 minute check hota hai (cron), aik waqt ke kai masle **aik hi message** mein aate hain, aur koi baat **do baar nahi** bheji jati.

| Event | Kab |
|---|---|
| `security` | Virus / hacker attack / DDoS — sirf HIGH khatra |
| `quarantine` | Koi device quarantine hua (khud ya admin ne) |
| `router` | Router 2 checks tak jawab na de → "Router DOWN"; wapas aaye → "Router back" |
| `service` | FreeRADIUS, database, DNS logger ya traffic collector band → aur wapas chalne par bhi |
| `jobs` | Raat ka backup, off-site copy ya koi update fail |
| `disk` | Disk 10% se kam khali |
| `expiring` | User ki subscription 24 ghante mein khatam (default off — hotspot par bahut ho sakte hain) |
| `summary` | Roz ki summary (default 21:00): users, data, sales, security, quarantine, top apps |

```bash
# Telegram: @BotFather -> /newbot -> token; apne bot ko kholein aur Start dabayein, phir:
sudo radius-admin alerts telegram 123456789:AAxxxx        # chat id khud dhoond leta hai
# WhatsApp (CallMeBot, free): +34 644 66 32 62 ko "I allow callmebot to send me messages" bhejein -> API key
sudo radius-admin alerts whatsapp +923001234567 123456
# Email (Gmail: App password banayein)
sudo radius-admin alerts email owner@example.com smtp.gmail.com:587 --user me@gmail.com   # password puchega

sudo radius-admin alerts                      # kya on hai
sudo radius-admin alerts test [telegram|whatsapp|email]
sudo radius-admin alerts events expiring on   # event on/off
sudo radius-admin alerts summary-hour 20      # summary ka waqt
sudo radius-admin alerts summary              # summary abhi bhejein
sudo radius-admin alerts log                  # bheje gaye alerts
sudo radius-admin alerts off whatsapp
```
- Dashboard → **Settings → Alerts**: teeno channels (har aik ka **Send test** aur **Turn off**), Telegram ka **Find my chat**, events ke switches, summary ka waqt, **Send summary now**, aur bheje gaye alerts ki list (har channel ka nateeja).
- Tokens / passwords sirf server par `/etc/mikrotiklover-radius/alerts.conf` (root, 600) mein; dashboard par kabhi wapas nahi dikhte (khali chhorein = purana rahe).
- Aik channel kharab ho (ghalat key, SMTP band) to baaki phir bhi message bhejte hain; ghalti list mein dikhti hai.
- **Tested** (Telegram / CallMeBot / SMTP ke local test servers ke saath): teeno channels par message; ghalat token / key / password pakra gaya; DDoS + quarantine, router down → back, DNS logger band → wapas, failed job, expiring users, roz ki summary; dobara check par kuch repeat nahi; 38 automatic tests (`tests/test-alerts.py`).

## 7c. Automatic updates (har hafte, khud)

`sudo radius-admin update` (cron: Tuesday raat) yeh sab update karta hai:

| Kya | Kahan se |
|---|---|
| App catalog (apps aur un ke domains) | `CATALOG_URL` (default: is repository ki `cdn-apps.json`) → `/var/lib/mikrotiklover/cdn-apps.update.json` |
| IP owner lists (ASN) | ipverse |
| Khud dhoondi gayi nayi apps ke naam | un ki website ka title |
| Threat lists | URLhaus, ThreatFox, Blackbook, Phishing Army, NoCoin, Feodo, Spamhaus DROP, FireHOL |
| Public VPN / Tor lists | X4BNet, Tor project (agar `radius-admin vpn update` ek dafa chalaya ho) |
| Router rules | auto-sync ke liye |

Har ghante `radius-admin hourly` yeh kaam khud chalata hai (ek waqt mein sirf ek run): app domains seekhna, nayi apps dhoondna, app inventory, website names, VPN watch, security scan aur router rules. Har kaam ka aakhri run aur nateeja Dashboard → **Settings → Automatic updates** mein dikhta hai.
