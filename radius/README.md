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
- **Device kind filter**: All devices · **Android** · iPhone / Apple · Windows. Har app ke saath "Android 3 · iPhone 1".
  - Device ki qism **khud pehchani jati hai**: phone ka system khud jo naam poochta hai — Android: `connectivitycheck.gstatic.com`, Play Store, Huawei / Xiaomi checks; iPhone: `captive.apple.com`; Windows: `msftconnecttest.com`. Ek kamzor ishara kaafi nahi (kam az kam ek pakka check). Table `ml_device`.
- **Details** (app par click) — sab kuch ek jagah:
  - **Ports and protocols** (traffic collector): maslan WhatsApp UDP 3478, TCP 5222.
  - **Server addresses**: DNS jawab se app ke server IPs, kis naam se poocha, kab (table `ml_app_server`, hamesha ke liye).
  - **Names**: network par dekhe gaye saare domains / subdomains, lookups, aakhri IPs; catalog ke naam bhi.
  - **Devices**: kaun se device / user, aur un ki qism (Android / iPhone / Windows).
- **⬇ Block**: is app ke tamam maloom domains band karne ka RouterOS script; ya "Block in a policy".
- **Nayi app ka alert** (Settings → Alerts → New apps): "📱 New app on the network: Zing Clips (video) — 3 device(s) (2 Android)".
- Tests: `tests/test-apps-health.sh` (API ke saath), `tests/test-appinv.py`, `tests/test-alerts.py`.

> **Note:**
> - Router par DNS logging on honi chahiye: `radius-admin dnslog on` aur `dns-logging.rsc`.
> - Data (MB/GB) ke liye traffic collector bhi chahiye.
> - Jo device DNS bypass kare, us ki apps is list mein nahi aatin. Misaal: exempt list wala device, ya family-DNS wali policy.

## 5h. Blocking dashboard se — user ko apps/websites band karna, WhatsApp-only, VPN

**Dashboard → Blocking** 6 hisson mein hai:

| Hissa | Kya hai |
|---|---|
| **Overview** | Ginti (policies, kitne users par policy, darkhwastein, aaj kitna block hua), **Needs your attention** (darkhwastein, jawab ke muntazir suggestions), quick actions, aaj sab se zyada block, **Router auto-sync** |
| **Policies** | Saari policies ek table mein: rules ke chips, kis ko di gayi; **search** aur "In use / Not used" filter; har line par **Edit · Give · Delete**; upar **Give a policy** (user ya poora group, ek hi dialog) aur **+ New policy** |
| **Parental controls** | Bachon ke tayyar schedules |
| **Requests** | Block page se khulwane ki darkhwastein (laal number = kitni baqi) |
| **Activity** | **Blocked tries** (logs) · **Why blocked?** |
| **Apps & websites** | **Allowed websites & apps** (laal number = kitne jawab baqi) · **App profiles** (khulasa: "2 whole domains · this office (LAN)", lines "Show lines" mein) |
| **Guide** | Roman Urdu mein: 4 qadam mein kaise kaam karta hai · **kaun si policy kab** (situation → policy → **Give**) · apply kaise karein · **har policy aasaan alfaz mein** (har rule, waqt ke saath, kis ko di hai, Give / Edit) · har rule router par kaise rokta hai · tarteeb (kaun pehle) · hadood |

Policy editor bhi hisson mein hai: *What to block* → *Single apps and websites* → *Advanced* (DNS, ECH, doosre rules; band rehta hai) → *Always open (exceptions)* → *Policy file* (band rehta hai).
Phone par policies cards ki tarah dikhti hain.

3 qadam:

1. **Policy banayein:** "+ New policy" dabayein. Is mein yeh sab chun sakte hain:
   - categories tick karein (social, sirf videos, YouTube/Netflix, games, messaging, torrent, adult words);
   - **single apps** dhoond kar tick karein (PUBG Mobile, TikTok, Snapchat...). App ke tamam domains band hote hain, network par khud seekhe gaye domains bhi;
   - **Block VPN**;
   - waqt: "Always", ya "Only at these times" (misaal 09:00 → 17:00, Mon–Sat);
   - mode **WhatsApp ONLY**: sirf WhatsApp chalta hai, baqi sab band;
   - mode **No internet**.

   Neeche "Policy file" mein wohi dikhta hai jo server save karta hai.
2. **User ya group ko dein:** **Give a policy** (ya policy ki line par **Give**) → "One user" / "A whole group" → naam → policy → **Apply**. Doosra tareeqa: Users → user → *Own web-filter policy*. User ek dafa disconnect hota hai aur agle login par nayi policy lag jati hai.
3. **Router auto-sync (sirf ek dafa):** Overview → "Router auto-sync" mein server ka IP likhein, **⬇ Download router script** dabayein, file router par upload karein aur `/import mikrotiklover-autosync.rsc` chalayein (`mikrotik/autosync.rsc`).
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

## 5h2. Qadam ba qadam chalu karna (step by step) — sab ek saath nahi

Dashboard → **Setup steps** (Dashboard par "Setup steps" button bhi). Har feature alag qadam hai. Ek qadam on karein, check karein, ek do din chalayein, phir agla. Kuch kharab ho to pata hota hai kis qadam se hua.

| # | Qadam | Router script mein sirf | Wapas kaise |
|---|---|---|---|
| 1 | **Website aur apps block** | blocking base, router logs, DNS logger, auto-sync (koi hotspot / security nahi) | **Pause all blocking** (ek click, sab blocking band, policies mehfooz) |
| 2 | **Hotspot ya Social WiFi** (office) | sirf hotspot (blocking base dobara nahi) | `/ip hotspot disable [find]` |
| 3 | Data usage / traffic | sirf traffic-flow | `/ip traffic-flow set enabled=no` |
| 4 | Security rules + LAN guard | sirf mlsec rules + ARP watch | `mlsec:` rules disable |
| 5 | Firewall, IPS, mail server | dashboard se, ek waqt mein ek | har page par Off switch |

Har qadam ke card mein: **Before you start** (pehle kya chahiye), **Do it** (links), **Check it works** (server khud check karta hai: router ne rules liye, site names aa rahe hain, network ko policy mili, blocking pause to nahi), **If something goes wrong** (pause + router Terminal ki undo lines), **Mark done**.

**Qadam 1 — sirf website / apps block (login ke baghair):**
1. Setup steps → 1 → *Make the router script for this step* (Router setup sirf blocking hisse ke saath khulta hai) → script router par chalayein.
2. Policy chunein (maslan `staff`: social / video office hours mein band).
3. **Give a policy → Network / IP** → `192.168.88.0/24` (poora office LAN), ya range `192.168.88.100-192.168.88.150`, ya ek PC `192.168.88.23`. Koi login nahi chahiye — us address wala har device policy le leta hai. Login wale user ki apni policy upar se lagti hai.
4. Ek PC se band site kholein → **Blocking → Why blocked?** rule dikhata hai.

```bash
sudo radius-admin policy net add staff 192.168.88.0/24 "Office LAN"
sudo radius-admin policy net add guests 192.168.88.100-192.168.88.150 "Guest range"
sudo radius-admin policy net list
sudo radius-admin policy net del ID
sudo radius-admin policy pause      # sab blocking band (15 min mein routers par; policies, networks mehfooz)
sudo radius-admin policy resume     # wapas
```

- Router par network `policy-NAME` address list mein jata hai (comment `mlnet:`); har sync pehle purani entries hatata hai.
- Do networks ek doosre ke andar hon (range LAN ke andar) to Policies page par **overlaps** dikhta hai — wahan dono policies lagti hain.
- Pause ke waqt Dashboard aur Setup steps par laal "All blocking is PAUSED" banner.

**Qadam 2 — hotspot ya Social WiFi:** pehle plan / vouchers ya Social WiFi on karein → Setup steps → 2 → router script (sirf hotspot) → aik phone se test → Online now mein nazar aaye → Mark done.

Tests: `tests/test-golive.sh` (network / range / IP, ghalat inputs, overlap, pause / resume router file mein, steps API, har qadam ka router script), UI suite (Setup steps page, Give → Network / IP → Remove).

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

Dashboard → **Blocking → Activity → Blocked tries** (aur Reports → Blocked) par yeh dikhta hai:
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

## 7h. Nakli router (rogue DHCP) aur ARP spoofing

Koi LAN mein ghar wala router laga de ya "fake DHCP" chala de to phones ko ghalat gateway milta hai aur un ki traffic parhi ja sakti hai. ARP spoofing (ettercap, arpspoof, "WiFi killer" apps) mein aik device doosre devices ka roop dhar leta hai (man in the middle). Dono ab pakray jate hain:

- Router par `mikrotik/lan-guard.rsc` import karein ("bridge" ki jagah apna LAN interface) aur `webfilter-logging.rsc` dobara (is mein `dhcp` aur `script` logs shamil hue):
  - **DHCP alert**: na-maloom DHCP server → "Fake DHCP server (rogue router on the LAN)" — us ka IP aur MAC.
  - **`ml-arp-watch`** (har minute ARP table): aik device bahut se addresses ka jawab de → "ARP spoofing (one device answers for many addresses)"; aik device aik din mein 3+ addresses le le → "ARP spoofing (one device took over other addresses)". Aik address ka device badalna (phone dobara connect hua) sirf "low".
- Server: Security → **Hacker attacks** mein (high), alerts (Telegram / WhatsApp / email) par message, aur monthly report mein.
- Sakht hifazat (optional, file ke aakhir mein): `add-arp=yes` + bridge `arp=reply-only` — sirf jab har device DHCP se IP leta ho.
- **Tested** (nakli router logs UDP 514 par): fake DHCP → high event + Telegram alert; 24 addresses wala MAC aur 4 addresses le lene wala MAC → ARP spoofing high; aik address change → low. `tests/test-sentinel.py` (4 naye checks), `tests/lint-rsc.py`.
- **Isi kaam mein 3 purane bugs mile aur theek hue:** (1) server ka rsyslog router ki DHCP / script lines phenk deta tha; (2) alerts woh security events chhor dete the jo scan baad mein purane waqt ke saath likhta hai; (3) `radius-admin` database mein latin1 se likhta tha, is liye "—" aur Urdu jaise huroof toot jate the (ab utf8mb4).

## 7h2. Ransomware detective

Dashboard → **Security → Ransomware** (CLI: `radius-admin security ransomware`). Ransomware pehle andar aata hai, apne malik se baat karta hai, doosre PCs tak phailta hai, data churata (upload karta) hai, phir files lock karta hai. Har qadam network par nishan chhorta hai:

| Qadam | Nishani | Kahan se |
|---|---|---|
| Andar aana | malware / phishing site | DNS (pehle se virus mein) |
| Malik se baat | **Tor** relays (port 9001/9050 …), **ransom note / Tor gateway** site (`*.onion`, onion.ws / onion.ly, tor2web), botnet, DGA | traffic flow + DNS |
| Phailna | ek PC minute mein **8+ LAN PCs** ko SMB 445 / RDP 3389 / RPC / WinRM par chhooe | traffic flow |
| Data churana | **device ki apni aadat se 10 guna upload** (7 din ka busy ghanta; 1.5 GB/ghanta se kam par nahi; raat ko = high), **ek minute mein 300 MB+** ek server ko, anonymous upload sites (mega, gofile, transfer.sh …), **rclone** download | traffic collector + DNS |
| Files lock | file server / NAS ke saath **SMB par minute mein 1 GB+** (dono taraf) | traffic flow |

- Har device ka **risk 0–100** (24 ghante): nishaniyon ke points + jitne zyada qadam ek saath, utna zyada. **70+ = ACT NOW**, 40+ = watch. Table mein 5 qadam rang ke saath, nishaniyan, aur **Cut off now** (quarantine).
- **Khud cut off** (Protection → "Cut off a device by itself at risk 70+", ya `radius-admin security ransomware-auto on`): 5 minute ke andar device ka network band, warning page. Pehle se **band** hai. Admin ne release kiya to us din dobara nahi.
- **Alerts:** high nishani par "🔴 RANSOMWARE: …", aur jab kai chhoti nishaniyan mil kar 70+ banein: "🧨 RANSOMWARE RISK 85/100: PC (user) — contact, spread, steal … Cut it off now".
- Monthly security PDF mein "Ransomware" tile, khulasa aur mashwara.
- Hadein badalna: `radius.conf` mein `SEC_LATERAL_HOSTS`, `SEC_SMB_BURST_MB`, `SEC_EXFIL_MB`, `SEC_EXFIL_HOUR_MB`, `SEC_EXFIL_FACTOR`.
- **Kya nahi dikhta:** PC ke andar ki cheezein. Ek hi switch par do PCs (ya PC + NAS) router se guzre baghair baat karte hain — un ke liye NAS ko alag VLAN / subnet mein rakhein, ya bridge par `use-ip-firewall`. Upload ke checks ke liye traffic collector zaroori. Ye antivirus ki jagah nahi — antivirus aur **unplugged / off-site backup** zaroor rakhein.
- Tests: `tests/test-sentinel.py` (+13), `tests/test-ransomware.sh` (DNS → scan → database → risk → auto cut-off → API), `tests/test-alerts.py` (+3), `tests/test-secreport.py`.

## 7h0. Firewall (FortiGate / Untangle jaisa) — policies, objects, port forwards, countries

Dashboard → **Firewall**. Sab kuch dashboard se; routers 15 minute mein khud le lete hain (auto-sync). MikroTik API istemal nahi hoti.

| Tab | Kya hai |
|---|---|
| **Overview** | ek jawab (sab theek / kya dekhna hai), policies on, hits, aaj kitna block hua, port forwards, countries; **Quick start** (RDP/SMB band, router login sirf LAN se, office time mein torrent band, sirf router ka DNS, spam bots); busiest policies; aakhri blocks |
| **Policies** | FortiGate jaisi list — **upar se neeche, jo pehle fit ho wohi faisla karta hai**. Har policy: direction, source, destination, service, schedule, action (**Allow / Deny / Reject**), log, on/off switch, **hits** (router se), ↑ ↓ order, search, direction filter |
| **Addresses** | naam wale groups: IP, network (10.0.0.0/24), range (a-b), website naam (router khud dhoondta hai), country (`geo:PK`) |
| **Services** | 30 built-in (HTTP, HTTPS, DNS, RDP, SMB, WINBOX, SIP, DVR, TORRENT, OPENVPN, WIREGUARD, IPSEC …) + apni (`tcp/8080,8443 udp/5000-5100`) |
| **Schedules** | always, office-hours, after-hours, weekdays, weekend, night + apni (din + waqt, aadhi raat ke paar bhi) |
| **Port forwards** | bahar ka port → andar ka device; **Allowed from** (sirf kuch addresses / countries); RDP / SMB / Winbox sab ke liye khula ho to laal warning |
| **Countries** | Geo-IP: paanch regional registries (ARIN, RIPE, APNIC, LACNIC, AFRINIC) ki official lists, har hafte khud update. "Block FROM these countries" (internet → LAN + router) aur "Block TO these countries" (LAN → un mulkon ki sites) |
| **Policy lookup** | "Ye connection kaun si policy le gi?" — direction, source IP, destination IP, protocol, port → har policy kyun fit / nahi, aur country |
| **Logs** | jin policies par "Log every hit" ho: waqt, policy, kahan se (country ke saath), kahan, port, router; policy ke hisaab se aur top sources |

Directions: **LAN → Internet**, **Internet → LAN** (port forwards ke baad), **Internet → LAN + router**, **→ router khud** (Winbox / SSH / DNS …), **LAN ↔ LAN** (do subnets / VLANs ke beech).

**Kaise kaam karta hai:** policies router par apni chains `mlfw-fwd` (forward) aur `mlfw-in` (input) mein bante hain, sirf **naye connections** par (purane chalte rahte hain, router par bojh kam). **Allow** = baqi firewall policies na dekho (web filter, security aur router ke apne rules phir bhi lagte hain). **Deny** chup chaap drop, **Reject** app ko foran batata hai. Koi policy fit na ho → router ke apne rules (aam taur par allowed). Countries alag file (`geo.rsc`) mein — router sirf tab download karta hai jab badle, aur sirf woh mulk jo istemal hon.

CLI (sab kuch dashboard jaisa):
```
sudo radius-admin firewall list
sudo radius-admin firewall addr set office 192.168.88.0/24 10.0.0.5-10.0.0.9 vpn.example.com
sudo radius-admin firewall rule add "Router login only office" --dir router --src office --service WINBOX,SSH --action allow
sudo radius-admin firewall rule add "Router login others" --dir wan --service WINBOX,SSH --action reject --log
sudo radius-admin firewall rule add "No China/Russia" --dir wan --src geo:CN,geo:RU --action deny --log --top
sudo radius-admin firewall rule move 7 up        # up | down | top | bottom | number
sudo radius-admin firewall vip add DVR 37777 192.168.88.20 --proto both --src office,geo:PK
sudo radius-admin firewall geo update            # country lists (khud: har hafte)
sudo radius-admin firewall lookup router 1.0.2.5 203.0.113.1 tcp 8291
sudo radius-admin firewall logs
```

- **Hits:** naya auto-sync script import karein (ml-stats ab har policy aur port forward ke counters bhi bhejta hai). Counters router par rules dobara bannay se zero hote hain ("since the routers last took new rules").
- **Health check** mein "Firewall": country list missing ya khatarnak port sab ke liye khula → warning aur kya karna hai.
- Blocking logs mein firewall ke blocks "firewall / firewall policy #N" ke naam se.
- **Hadein:** ek policy max 200 router rules (zyada addresses × services ho to address object banayein). Bara mulk (US, CN) hazaron networks — router pehli dafa ek minute leta hai. Website naam wale address router khud resolve karta hai (Policy lookup mein check nahi hote). SSL inspection / antivirus MikroTik par mumkin nahi — un ki jagah web filter (HTTPS naam se), threat lists aur security detective.
- Tests: `tests/test-firewall.py` (rules, countries, lookup, logs — bina database), `tests/test-firewall.sh` (CLI, router files + lint, country file, hits, logs, API), UI suite.

## 7h1. Intrusion prevention (IPS) — Suricata, Fortinet jaisa

Dashboard → **Security → Intrusion prevention**. Router internet traffic ki **copy** server ko bhejta hai (TZSP, UDP 37008), server par **Suricata** use 40,000+ hamlon ki pehchaan (Emerging Threats Open, roz update) aur hamare apne rules se check karta hai. Hamla mila → alert, Security page, Telegram / WhatsApp, aur (switch on ho to) hamla karne wala IP **har router par ek minute ke andar band**.

```
sudo radius-admin ips install      # Suricata + signatures (ek dafa; 4 GB+ RAM behtar)
sudo radius-admin ips on           # routers 15 minute mein copy bhejna shuru karte hain
sudo radius-admin ips status       # chal raha hai? copy aa rahi hai? kitni signatures?
sudo radius-admin ips alerts       # kya pakra
```

- **Kya pakarta hai:** exploits (Windows / router / web bugs), password guessing (RDP, mail, Winbox, SSH), scans, botnet / malware servers se baat (andar ka PC infected), crypto mining, MDaemon admin port (1000) par bahar se dastak, PC se seedha mail bhejna (spam bot).
- **Block:** bahar ka hamla karne wala IP; andar infected device ho to woh **bahar ka malware server** (device khud quarantine se — Security → Virus). LAN ke IPs, routers, ye server aur "Never blocked" list kabhi band nahi hote. Level: sirf high (default) ya high + medium; muddat 1 ghanta – 30 din (default 24 h).
- **Router par:** `mangle action=sniff-tzsp` (default sirf har connection ke **pehle 256 KB** — hamle pehchanne ke liye kaafi, server par bojh kam; "all" bhi chun sakte hain) aur `raw` mein `ml-ips` list drop. Block list har minute (`ml-live`) aati hai, time ke saath (server band ho to bhi khud khatam).
- **Instant blocks (~1 second, MikroTik API):** Security → Intrusion prevention → **Instant blocks → + Add a router** (ya `sudo radius-admin ips api add 192.168.88.1`). Ek chhota script milta hai jo router ke Terminal mein paste karna hai: ek alag user jo **sirf API** use kar sakta hai aur **sirf is server ke IP se**, aur `api-ssl` (TLS, port 8729) sirf is server ke liye. Phir **Test**. Uske baad server alert aate hi khud router ki `ml-ips` list mein IP daal deta hai — sandbox mein hamle ke packet se router tak **~0.25 second** (pehle 1–2 minute). Unblock bhi foran. Router ka certificate pehli dafa yaad rakha jata hai; badal jaye to server mana kar deta hai (`radius-admin ips api forget-cert IP` agar aap ne khud badla). Password sirf root ki file mein (`/etc/mikrotiklover-radius/router-api.json`), database mein nahi. 1-minute wali list backup ke tor par chalti rehti hai — API band ho to bhi block pahunchta hai. Real-time watcher (`mikrotiklover-ipswatch`) alerts ko second ke chauthai hisse mein padhta hai; har-minute wala scan sirf tab chalta hai jab watcher band ho.
  - RouterOS ki ijazat (policy) mein "sirf address-list" jaisa kuch nahi: API user ko `read,write,api` chahiye. Is liye user **sirf server ke IP** se login kar sakta hai aur api-ssl sirf server ke IP ke liye khula hai.
- **Inline mode (Fortinet jaisa — pehla packet bhi ruke):** Security → Intrusion prevention → **Mode → Inline**. Server traffic ke **beech** aa jata hai:
  ```
  MikroTik (LAN port) ── server card 1 ⇄ Suricata ⇄ server card 2 ── LAN switch
  ```
  Suricata khud har packet ek card se doosre card par pahunchata hai (AF_PACKET IPS) aur hamle ko **pehle packet par** rok deta hai (port 1000 ka pehla SYN bhi aage nahi gaya — lab test).
  - Shuru: `sudo radius-admin ips inline on eth1 eth2` → **"Alert only (test)"** — kuch nahi rukta, sirf alert. Kuch din alerts dekh kar: `radius-admin ips inline drop` (dashboard: **Stop attacks**). Rukte hain: priority-1 classes (malware / botnet, break-in, admin / user password attacks, web attacks, exploit kits) aur hamare apne rules.
  - **Failover (fail-open) — `mikrotiklover-ipsguard`:** har second dekhta hai. Suricata band ho → **3 second ke andar** dono cards ko seedha jod deta hai (bridge `br-mlbypass`), internet chalta rehta hai (bina check). Suricata atak jaye (packets aa rahe hain, aage nahi ja rahe) → bhi bypass, aur Suricata naye sire se. Suricata wapas aa kar rules load kar le → bypass khud band. 10 minute mein 3 dafa fail ho to bypass par hi rehta hai aur Health check laal.
  - **Maintenance:** `radius-admin ips bypass on` (sab traffic bina check) → kaam → `ips bypass off`.
  - **Wapas copy mode:** pehle bypass on, cable wapas (LAN switch → MikroTik), phir `radius-admin ips inline off`.
  - **Zaroori:** server mein **2 network cards** sirf traffic ke liye (in par koi IP nahi — command khud mana karti hai), aur **teesra card** server ko manage karne ke liye behtar. Server poori internet speed sambhale (100 Mbps: aam 4-core; 1 Gbps+: taqatwar CPU + achhe cards). **Bijli / hardware kharabi** par software bypass kaam nahi karta — iske liye **bypass network card** (Silicom / Intel bypass NIC: bijli jaate hi relay dono ports jod deta hai) ya MikroTik par backup raasta.
  - Inline mode mein routers ko copy (TZSP) bhejne ki zaroorat nahi — sync.rsc khud hata deta hai; `ml-ips` list aur instant API block chalte rehte hain.
- **Ghalat alarm:** "What it saw" mein signature **Switch off** — foran band, aglay updates mein bhi band. Shor machane wale packet / stream checks default band hain (adhoori copy par bekaar).
- **Haqeeqat:** ye copy dekhta hai, is liye hamle ke pehle packets guzar jaate hain; band seconds se minute mein. HTTPS ke andar nahi dekhta (pattern, server aur behaviour se pakarta hai). Server ke UDP 37008 tak router se rasta khula ho.
- Health check: "Intrusion prevention" — Suricata band, copy na aa rahi ho, ya signatures download na hui hon to warning aur kya karna hai.
- Tests: `tests/test-ips.py` (TZSP, alerts, kise block, config, rule on/off), `tests/test-ips.sh` (asal Suricata: TZSP → tzsp2tap → Suricata → scan → database → router list → API).

## 7h2b. Mail server ki hifazat (MDaemon, Exchange, Zimbra … LAN par)

Dashboard → **Mail server**. Mail server ka LAN IP aur domain likhein (`radius-admin mail set ip 192.168.88.30 domain example.com`):

| Hissa | Kya karta hai |
|---|---|
| **Set up the doors** | Firewall mein port forwards: 25, 587, 465, 993, 995, webmail 443. **Kabhi nahi:** 1000 (MDaemon Remote Admin), 3000 (plain HTTP webmail), 143/110 (plain) — khule hon to laal |
| **Password guessing rokna** | 110/143/443/465/587/993/995/webmail par ek IP se minute mein 30 se zyada naye logins → woh IP **1 ghanta band** har router par (rate badal sakte hain; "Never block" address object). Port 25 nahi (Gmail jaise servers zyada connections kholte hain) |
| **Sirf mail server mail bheje** | port 25 bahar sirf MDaemon se; kisi PC ka virus spam bhejne ki koshish kare to router mana kar deta hai aur device ka naam list mein — aap ka IP blacklist hone se bachta hai |
| **Har ghante checks** | MX, A, SPF, DMARC, DKIM (selector MDaemon), reverse DNS (PTR), **8 blacklists** (Spamhaus, SpamCop, Barracuda, SORBS …), har mail port ka **TLS certificate** (din baqi, self-signed, ghalat naam), khule ports, **outgoing mail achanak 5 guna** (hacked mailbox?) — har ek ke saath kya karna hai |
| **MDaemon checklist** | Dynamic Screening, SMTP AUTH, relay, TLS + Let's Encrypt, DKIM/DMARC, strong passwords + 2FA, Remote Admin sirf LAN, AntiVirus, IP Shield, backup — tick karte jayein |
| **Activity** | kaun se IP password guess karte pakre gaye (mulk ke saath), kaun se devices ne seedha mail bhejne ki koshish ki (user ke naam ke saath) |

- Problems Health check aur alerts mein bhi ("Mail server" group), naya masla ho to Telegram / WhatsApp.
- IPS ke apne mail rules bhi hain (mail password guessing, AUTH on port 25, MDaemon admin port, spam bot).
- Spamhaus public DNS (8.8.8.8) se poochne par jawab nahi deta → "unknown"; apna DNS server ho to sahi jawab.
- CLI: `radius-admin mail status | doors | guard on|off | smtp-out on|off | rate 30 | trusted OBJECT | logs | checklist KEY on|off`.
- Tests: `tests/test-mailsec.py` (nakli DNS server + asal TLS server: DNS records, blacklists, certificates, doors, volume, logs), `tests/test-mail.sh` (router rules + lint, doors, checklist, API).

## 7h3. Bahar se network mein kya aa raha hai (From outside)

Dashboard → **Security → From outside**. Teen sawaal, teen jawab:

1. **Kaun se darwaze khule hain?** (Open doors on the routers) — har router apni **port forwards** (`/ip firewall nat` dst-nat / netmap) aur apni **services** (winbox, ssh, api, www …) har minute report mein bhejta hai. Har line: bahar ka port → andar ka IP:port, **kis ke liye khula** (everyone / sirf ek network), aur khatarnak port par laal nishan + mashwara: RDP 3389 ("ransomware ka pehla darwaza — VPN use karein"), SMB 445, Telnet, FTP, VNC, databases, Winbox / API, DVR (37777, 8000), RTSP 554 …
   - **UPnP** se device ne khud jo darwaza khola (games, cameras) alag nishan ke saath; band (disabled) rules bhi dikhte hain.
   - Router ki service jo **har address** ke liye khuli hai: seedha command, maslan `/ip service set winbox address=YOUR-NETS`.
2. **Bahar se kaun andar aaya?** (Who came in from outside) — traffic collector har connection dekhta hai jo bahar se andar ke kisi device ki service par aaya: **andar ka IP : port**, service ka naam, kitne bahar ke address, connections, in / out data, aur kya ye port forward se aaya. **Who?** dabayein: har bahar ka IP, kitni dafa, kitna data, pehli / aakhri dafa.
3. **Bahar ke address** (Outside addresses) — sab se zyada connections wale pehle; jo threat lists mein hain ya Security mein hamla karte dekhe gaye un par laal nishan ("1 bad" bhi andar wali line par).

Neeche "How to close a door": NAT rule band karna, Src. Address sirf apna, UPnP off, router services sirf apne networks ke liye.

- **Zaroori:** naya auto-sync script ek dafa router par import karein (is mein `nat=` aur `svc=` lines hain — sirf parhta hai, kuch nahi badalta), aur "kaun andar aaya" ke liye traffic collector (Traffic flow) chalu ho.
- Data 30 din (`TRAFFIC_DAYS`) tak, table `ml_inbound`.
- **Kya nahi dikhta:** router par khud aane wale connections (Winbox / SSH login koshishein) traffic flow mein nahi aate — un ke liye router ki services wali table aur Security → Hacker attacks. Jo darwaza router ke firewall se band hai wo yahan nahi aata (koi connection hi nahi hota).
- Test: `tests/test-inbound-winupdate.sh` (router report, collector writer, API, Who? list).

## 7h4. Microsoft Windows Update on / off

Dashboard → **Blocking → Overview → Windows Update** — teen button:

| Button | Kya hota hai | CLI |
|---|---|---|
| **Allowed** | Windows PCs aam tarah update | `radius-admin winupdate on` |
| **Off in office hours** | 9:00–17:00 Mon–Sat update band (internet tez), shaam aur Sunday ko update | `radius-admin winupdate office` |
| **Off always** | sab ke liye band (jo `web-filter-exempt` list mein hain un ke paas chalta hai) | `radius-admin winupdate off` |

- Sirf update service band hoti hai (windowsupdate.com, update.microsoft.com, delivery.mp.microsoft.com, Delivery Optimization …) — **Office, Outlook, Teams, OneDrive, Store** chalte rehte hain. List: `webfilter/categories/windows-update.txt`.
- Router par ek rule, sab policies se pehle (`wfpolicy:global windows-update`, HTTPS site name se band). Routers 15 minute mein le lete hain.
- **Sirf kuch users ke liye:** Blocking → policy → Edit → Categories → **windows-update** (apne waqt ke saath), ya policy file mein `block windows-update time=8h-18h`.
- "Why blocked?" bhi batata hai: "Windows Update is OFF for everyone …". `radius-admin winupdate status`.
- **Yaad rakhein:** bilkul band rakhne se PCs purane aur ghair-mehfooz ho jaate hain (ransomware ka khatra) — "Off in office hours" behtar hai.

## 7i. Reports aur samajh (Insights)

Dashboard → **Insights (samajh)**: numbers ke bajaye seedhi baatein —
- "Is hafte 50.1 GB data istemal hua — pichle hafte se 32% zyada."
- "Sab se zyada data youtube.com par gaya: 13.7 GB (27%)", "Sab se tezi se barha: tiktok.com (242% zyada)", "Sab se masroof waqt 20:00–21:00"
- "⚠ bilal ne kal 8.3 GB istemal kiya — aam din (363 MB) se 23 guna."

Saath mein: 30 din ka rozana data chart, ghanton ka chart (kab sab se zyada rush), **top users** aur **top apps / sites** — is hafte, pichle hafte, aur farq (▲ / ▼ %), sales ka muqabla.

- **Unusual use (anomaly):** kisi user ka aaj / kal ka data us ke aam din (pichle 2 hafte ka median) ka **10 guna** se zyada aur 500 MB se upar ho → Insights mein laal, aur alert (Telegram / WhatsApp / email: event `anomaly`). Naye users (5 din se kam history) ko nahi parakhta. Wajah aksar: virus, password share, ya bari download.
- **Weekly report:** har **Monday** (summary ke waqt) yahi report — baatein + top 10 users + top 10 apps — phone / email par (event `weekly`). Abhi: `sudo radius-admin alerts weekly`.
- Purane install par: Settings → Alerts mein "Unusual data use" aur "Weekly report" on karein (agar events pehle save kiye the).
- CLI: `sudo radius-admin insights` / `insights anomalies`.
- **Tested:** 30 din ka nakli traffic (6 users, 7 apps): muqabla, TikTok ka tezi se barhna, masroof ghanta, bilal ka 23 guna din pakra, alert aur weekly message nakli Telegram par pahunche. `tests/test-insights.py` (20 checks) + alerts tests.

## 7j. Har mahine security report (PDF)

Har mahine ki **1 tareekh** (summary ke waqt) pichle mahine ki security report khud banti hai aur bheji jati hai:
- **Email**: PDF attachment ke saath · **Telegram**: PDF document · **WhatsApp**: chhoti summary.
- PDF (2–3 safhe): virus / hacker / DDoS / quarantine ke numbers (pichle mahine se muqabla), "In short" seedhi baatein, roz ka chart, kya hua (type wise), infected devices (user ke saath), hamla karne wale, LAN ke andar nakli router / ARP spoofing, quarantine list, VPN koshishein, aur **"What to do"** — mashware (masalan: Winbox internet se band karein, infected device reset karein).
- Dashboard → **Security → Monthly reports**: koi bhi mahina chun kar **Make report** / **Make and send**, purani reports **Open / Download**.

```bash
sudo radius-admin security report                    # pichla mahina (PDF banta hai)
sudo radius-admin security report --month 2026-10 --send
sudo radius-admin security reports                   # /var/lib/mikrotiklover/reports
```
- PDF ke liye koi naya package nahi chahiye (`tools/minipdf.py`, apna chhota PDF writer).
- **Tested:** October ki report (asli test data) — 3 safhe, pdftotext se parhi gayi; nakli Telegram ko PDF document, email mein PDF attachment, WhatsApp ko summary; dashboard se banai / download ki (path traversal 404). `tests/test-secreport.py` (19 checks: PDF ka dhancha, offsets, text, lambi table kai safhon par, khaali mahina).

## 7k. Network control

**1. Router health (multi-router dashboard)** — Dashboard → **Routers**: har MikroTik ka CPU, memory, disk, uptime, users online (hotspot / PPPoE / DHCP), har interface (up / down, abhi ki raftar, kul data), internet links, aur 24 ghante ka traffic chart.
- Router par naya auto-sync script import karein (Blocking → Overview → Router auto-sync → Download script). Is mein `ml-stats` (har minute sirf parh kar bhejta hai, config nahi badalta) aur do netwatch internet checks (8.8.8.8, 1.1.1.1) shamil hain. Apna doosra ISP: `/tool netwatch add host=... comment="ml-link: ISP2"`.
- Alerts (event `router`): router 5 minute chup → "Router silent"; netwatch link down → "Internet link DOWN on …"; wapas aane par bhi.

**2. Parental controls** — Blocking → **Parental controls**: aik click mein Homework time (16–19, social / video / games band), Bedtime (22–6, internet band), School hours, Games sirf weekend, Family-safe DNS, VPN band. Bachon ke users ya group chunein → **Apply**: `parental-kids` policy ban kar lag jati hai (baad mein Policies mein badal sakte hain).

**3. Hotspot login page designer** — Dashboard → **Hotspot page**: title, neeche wali line, do rang (ya tayyar jore), logo (PNG/JPG, 100 KB), notice / advert box (`|` = nayi line), footer — phone size live preview (login, status, just-logged-in). "Put these pages on the routers automatically" on karein to auto-sync teeno pages har hotspot profile ke folder mein khud utaar deta hai.
```bash
sudo radius-admin hotspot set title "Chai Wala Cafe"
sudo radius-admin hotspot set notice "1 ghanta free|Chai + Paratha 250 Rs"
sudo radius-admin hotspot logo logo.png
sudo radius-admin hotspot push on
```
- IPv6 abhi nahi (filters aur reports sirf IPv4).
- **Tested:** do nakli routers ki reports (ghalat key 403, kharab data 400), raftar ka hisaab, link-down alert pehli report par bhi; parental policy ban kar 2 bachon ko lagi aur router rules mein gayi; designer: title/rang/notice/logo, HTML escape (`<script>` text ban jata hai), SVG logo mana, router script aur key wala download (bina key 403). `tests/test-hotspotgen.py` (15 checks), UI 49/49.

## 7l. Social WiFi (cafe) — phone number se free WiFi

Customer WiFi se judta hai → login page par **"📱 Phone number se free WiFi"** → mobile number (naam aur "offers bhejein" optional) → SMS / WhatsApp par **6 hindson ka code** → code likhte hi internet chalu (router par khud login). Roz ki had: waqt + data (+ speed) — `social-free` plan.

```bash
sudo radius-admin security quarantine-server 192.168.88.10   # server ka IP jaise router dekhta hai
sudo radius-admin notice gateway 'https://sms.example.pk/api?key=KEY&to={phone0}&msg={text}' --ok OK
sudo radius-admin hotspot push on          # login page routers par khud
sudo radius-admin social on
sudo radius-admin social set minutes 60    # roz 60 minute
sudo radius-admin social set mb 500        # roz 500 MB
sudo radius-admin social set rate 2M/2M    # (optional) speed
sudo radius-admin social list | export     # customers / CSV
sudo radius-admin social offer "Aaj chai + paratha 200 Rs" [--dry-run]
```
- **Kaise:** login page ka button server ke `http://SERVER:8081/social/start` par jata hai (auto-sync router ki hotspot **walled garden** mein yeh address khol deta hai). Code sahi hone par server `sw-923…` account banata / password badalta hai aur browser router ke login page par **CHAP** (ya PAP) se khud login kar deta hai — router ka `login-by` waisa hi rehta hai.
- **Hifazat:** code ka sirf hash rakha jata hai; 5 minute valid; 5 ghalat koshishon ke baad band; aik number ko 15 minute mein 3 codes, aik device ko ghante mein 6; code usi device (MAC) par chalta hai jis ne manga.
- **Dashboard → Social WiFi:** on / off, roz ka waqt / data / speed, SMS ka message, customers (phone, naam, offers ki ijazat, visits, pehli / aakhri dafa), **Export CSV**, **Send an offer** (sirf ijazat walon ko, din mein aik dafa), Forget.
- Roz ki free had khatam ho to portal kehta hai "Aaj ka free WiFi istemal ho chuka — kal phir aayein".
- **Google login:** abhi nahi — phone ke WiFi-login window mein Google aksar login rokta hai, aur asli domain + certificate chahiye. OTP har phone par chalta hai.
- **Tested:** browser se poora raasta — number → nakli SMS gateway par code → ghalat code → sahi code → nakli router ne FreeRADIUS se **asli CHAP login** karwaya (Session-Timeout 45 min, 300 MB limit wapas aaye); rate limits, purana code, doosra device, 5 ghalat koshishen, roz ki had, naam saaf (`<script>` hata), CSV. `tests/test-social.sh` (18 checks), UI 50/50.

## 7m. Router setup — script dashboard se, ek line terminal mein

Dashboard → **Router setup**: router chunein, server IP aur LAN interface dekhein, jo chahiye us par tick (Hotspot, Staff Wi-Fi WPA-Enterprise, PPPoE, MAC devices, logs, DNS logger, traffic flow, auto-sync, security, LAN guard) → **Make the script**.
Page sab `mikrotik/*.rsc` files ko sahi tarteeb mein jor kar server IP, router ka secret, Wi-Fi naam aur interfaces bhar deta hai (ek `/radius` entry sab services ke liye) aur ek line deta hai:

```
/tool fetch url="https://SERVER:8443/api/public/setup/TOKEN.rsc" check-certificate=no dst-path=ml-setup.rsc; :delay 2s; /import file-name=ml-setup.rsc; /file remove ml-setup.rsc
```

Winbox → New Terminal → paste → Enter. Link 1 ghante ka hai (random token, table `ml_router_setup`); page dikhata hai ke router ne download kar liya. Ya **Download .rsc** se file le kar haath se import karein.
Galat input (interface, SSID, secret mein `"` ya `;`) wahin rok diya jata hai. Tests: `tests/test-routersetup.py` (script builder + API + lint).

## 7n. IP binding — har user ka apna pakka IP

Dashboard → **IP binding** → "Every user keeps the first address DHCP gives them" on (ya `radius-admin ipbind auto on`).
- Har 5 min (cron `enforce`) online users dekhe jate hain: jis user ko DHCP ne jo IP diya, woh us ke **username** ke sath bind ho jata hai (table `ml_ip_bind`).
- Routers ko auto-sync se **DHCP static lease** (MAC → IP, comment `mlbind: USER`) milti hai; device agli DHCP renewal (ya Wi-Fi off/on) par wahi IP leta hai.
- Admin **Change** se koi bhi IP de sakta hai (`ipbind set USER IP`) — yeh "set by admin" ho jata hai aur kabhi khud nahi badalta. Jo IP kisi aur ka ho ya abhi kisi aur ke paas ho, woh mana.
- Automatic IP itne din login na ho to azad (default 7, `ipbind days N`, 0 = kabhi nahi) — cafe mein voucher walon se pool khatam na ho.
- **Random (private) MAC:** binding MAC ki nahi, **user** ki hai. Phone naye random MAC se aaye to login ke baad lease naye MAC par chali jati hai, IP wahi rehta hai. Dashboard par "random MAC" nishan. Ek hi phone par doosra user login kare to device naye user ke paas chala jata hai.
- PPPoE users par nahi (un ke liye `user ip USER IP` — Framed-IP-Address).
- Tests: `tests/test-ipbind.sh` (34 checks: auto, random MAC, takraao, admin, din, lint, API).

## 7o. Traffic graphs aur Departments (shared speed)

**Traffic graphs** (dashboard → Traffic graphs): speed waqt ke sath — 6 ghante, 24 ghante, 7 din, 30 din.
- **Interfaces:** har router ki har interface (router ki minute report, auto-sync wala `ml-stats`) — In/Out.
- **Users:** RADIUS accounting se har 5 min (`enforce` cron): har session ke counters ka farq → `ml_traffic` (5-min data 3 din, ghante wala 90 din).
- **Groups / Departments:** un ke sab users ka jor, "Most traffic" list ke sath; department graph par us ki limit ki laal line.

**Departments** (dashboard → Departments, ya `radius-admin dept`): ek team ko ek hi speed.
```
radius-admin dept add sales 10M 5M "Sales team"     # poore department ke liye 10M download / 5M upload
radius-admin dept member sales user ali             # ya: dept member sales group staff
```
- Router par auto-sync se har department ki **queue tree + PCQ** banti hai: 1 user online ho to poori 10M, 10 hon to har ek ~1M (jo kaam kar rahe hon un mein barabar).
- Kaun kis department mein hai: router **har minute** server se poochta hai (`ml-dept` script → `/api/public/router/dept.rsc`) aur address lists `ml-dept-NAME` update karta hai — login/logout ka asar 1 minute mein.
- User ki apni speed (plan / group) bhi lagti hai: department 10M ke andar har user 2M, dono ek sath.
- FastTrack queue ko chhor deta hai — department walon ka traffic khud FastTrack se bahar rakha jata hai. Har router ki apni 10M hoti hai.
- User ka apna entry group wale se upar: ali group staff (Accounts) mein ho magar khud Sales mein dala ho to Sales.
- Tests: `tests/test-traffic.sh` (45 checks).

## 7p. Why blocked? — admin ke liye block dhoondna

User kahe "yeh site nahi khul rahi": dashboard → **Blocking → Why blocked?** → site (ya poora link) aur user/IP likhein → **Check**.
- Site kin lists mein hai: category (social, gaming …), app (TikTok, PUBG …), adult words, VPN.
- User ki policy (apni ya group ki) ka **kaun sa rule** block karta hai, **abhi active hai ya sirf kisi aur waqt** (`time=`), aur router log mein us ka naam (`WF-social`, `WF-app-tiktok` …).
- Quarantine, `web-filter-exempt`, family DNS jaisi baatein upar note mein.
- Pichle 7 din ke router log ke blocked attempts us site ke.
- **Blocking logs** mein har line ke saath **Why?** button — seedha yahan bhar deta hai.
- CLI: `radius-admin why facebook.com ali` (ya IP). Engine: `tools/whyblocked.py` — router wale qaayde (subdomain, `*`, ^keyword, time=). Tests: `tests/test-whyblocked.py` (34 checks).
- Block page ka **6 harf ka code** bhi yahin likhein (maslan `XVR6JW`): kis ko, kab, kaun sa address, kaun sa rule — sab khul jata hai.

## 7q. Block page (safe) — user ko logo, wajah aur code

Dashboard → **Blocking → Why blocked? → Block page for users** on (ya `radius-admin blockpage on`; pehle `security quarantine-server IP`).
- Jin users par policy hai, un ka **http:// (port 80)** traffic router auto-sync se server ke nginx **:8082** par bhejta hai.
- Server har request par poochta hai (`/internal/blockcheck`, nginx ka secret key zaroori): band ho to **block page** — Hotspot designer wala logo, rang, naam; site, wajah, rule, user, waqt aur **reference code**. Warna request asal site par chali jati hai (sirf public address; localhost / LAN / server ke apne ports kabhi nahi).
- Code `ml_block_event` mein 30 din; 10 minute mein usi site ka dobara page = wahi code. Admin: Why blocked? mein code likhein, ya `radius-admin blockpage ref CODE`.
- **HTTPS sites** par browser ka apna error hi aata hai (koi certificate install nahi hota — is liye "safe"). Kuch browsers HTTPS fail hone par http:// try karte hain — tab page dikh jata hai.
- LAN / private addresses kabhi redirect nahi hote; server band ho to router ka netwatch yeh rasta khud band kar deta hai (internet nahi rukta).
- Tests: `tests/test-blockpage.sh` (27 checks).

## 7u. Website ya app ka sirf naam — baqi khud (automatic)

Policy → Edit → **Websites always open** mein sirf `minascollection.com` likhein (file mein `allow-web minascollection.com`), ya **Apps always open** mein app ka naam (`allow-app Instagram`).
- **Server site ko khud parhta hai** (`tools/webscan.py`). Pehle foran ek **jaldi read** (home page + 4 pages), phir **poori site background mein**:
  `robots.txt` aur `sitemap.xml` se saare pages (sitemap index bhi), **150 pages tak**, 4 ek saath, zyada se zyada 4 minute; har page ki CSS aur **JavaScript files** bhi.
  Jahan jahan se cheezein aati hain — Google Fonts, `fonts.gstatic.com`, CDN (jsDelivr, Shopify), Instagram tasveerein (`cdninstagram.com`) — sab khul jati hain.
  JS mein likhe naam: file jaise (`cdn.`, `static.`, `img.`, `media.` …) khud khulte hain, baqi (maslan API) sirf pooche jate hain.
  **Ads / trackers** (Google Analytics, Tag Manager, Facebook pixel …) nahi kholte. Embed (YouTube, maps) sirf pooche jate hain.
  Parhai khatam hote hi routers ko khud naye rules mil jate hain. Dashboard par progress dikhta hai ("40 of up to 150 pages").
- **Har roz dobara** poori site parhta hai (hourly job, har ghante 3 purani sites).
- **Istemal se seekhta hai** — websites, **apps** (`allow-app`) aur **app profiles** (`allow-only`, maslan hikconnect) teeno:
  policy wala device naam poochne ke 20 second ke andar jo aur naam poochta hai aur band hain — jane pehchane helpers (fonts, CDNs) khud khul jate hain, baqi **Blocking → Allowed websites & apps** mein **Allow / Ignore**.
  App profile ki `host` lines se company pata chalti hai: `host g.whatsapp.net` ho to koi bhi `*.whatsapp.net` khud khul jata hai (lekin `deny-sni facebook` wale nahi).
  App ke liye "same company" khud nahi kholta (Instagram ki list mein ek facebook.com naam hai — poora Facebook na khul jaye), sirf poochta hai.
- **Ports bhi seekhta hai**: har website / app / profile ke card par **"Ports it uses"** — traffic collector ne us ke naamon par jo ports dekhe (maslan Hik-Connect: UDP 6000, TCP 443, TCP 6800; WhatsApp: UDP 3478, TCP 5222).
  Aur **"Direct connections it tried"**: app kholne ke 20 second ke andar device ne baghair naam ke seedhe IP par jo connection kiya aur policy ne band kiya (router ka `WF-allowonly` / `WF-noinet` log) — P2P, relay, camera servers.
  Ye `/24 network + protocol + port` mein jama ho kar **Allow / Ignore** ke liye aate hain (maslan `47.91.12.0/24 · UDP 6000`, 3 addresses). Allow par router sirf **wahi network aur wahi port** kholta hai (`webscan/KEY.nets`), poora internet nahi.
  Jis address ka naam DNS mein mil gaya, LAN address, aur `/24` se bara network — ye nahi pooche jate / mane nahi jate. Khud kuch nahi khulta: IP ke liye hamesha aap ki marzi.
  CLI: `radius-admin webscan allow ao-hikconnect "47.91.12.0/24 udp 6000"`.
- Apps: app catalog ke saare domains + seekhe hue (`webscan/app-NAME.txt`) — catalog mein na ho to **App profiles → Learn an app**.
- CLI: `radius-admin webscan list | scan SITE [--deep] | deep SITE | show KEY | allow KEY NAME | ignore KEY NAME | auto` (KEY: site, `app-instagram`, `ao-hikconnect`).
- Server sirf **public** addresses parhta hai (LAN / localhost nahi). Tests: `tests/test-webscan.sh` (61, API ke saath), `tests/test-whyblocked.py`.

## 7t. Sirf kuch apps (maslan WhatsApp + Hik-Connect)

Blocking → policy → **"ONLY the apps I choose"** → apps par tick (whatsapp, hikconnect, apne banaye hue) → baqi sab band.
Tayyar policy: **whatsapp-hikconnect**. User ko do: Blocking → Policies → **Give**.
- **App profiles** (Blocking → App profiles, `/var/lib/mikrotiklover/allowonly`, `radius-admin allowonly`):
  `domain hik-connect.com` (har subdomain — router ki DNS jo IP batati hai woh khud list mein, RouterOS 7.15+),
  `net @lan` (is office ka NVR/DVR), `net 203.0.113.25` / `host mynvr.ddns.net` (doosri jagah ka NVR), `host`, `deny-sni`, `block-quic`.
- **hikconnect** profile: Hik-Connect cloud (`hik-connect.com`, `hikvision.com`) + office ka NVR. Doosri jagah ka NVR ho to us ka public IP ya DDNS **Edit** se add karein.
- **Learn an app**: ek khula phone par app chalayein → user/IP likh kar **Show** → app ki sites tick → **Save as app profile** (DNS logger chahiye). CLI: `radius-admin allowonly learn IP 15`.
- Router: har app ki chain sirf ijazat deti hai (return), aakhir mein policy baqi sab rokti hai.
- Tests: `tests/test-allowonly.sh` (23), simulator (+8: WhatsApp, Hik cloud, office NVR khule; Google, Facebook, QUIC band).

## 7s. Policy editor: har rule ka apna waqt

Blocking → policy → **Edit**: har tick (category, VPN, har app, har site, "Internet off completely") ke saath apna **When**:
**Always**, **Office hours (9–17, Mon–Sat)** ya **Custom…** (se → tak + din; raat 22 → 6 jaisa waqt router par khud do hisson mein bant jata hai).
Misal: social sirf daftar ke waqt, games hamesha, TikTok 16–19 Mon–Fri, internet raat 00–06 band.
- Purani policy kholne par har rule apne waqt ke sath aata hai; jo rule editor nahi dikhata (maslan ek category do alag waqton ke sath) woh "Other rules" mein **jaise ka taisa** rehta hai — save karne par kuch gum nahi hota.
- Site likhte waqt `https://www.` aur raasta khud hat jata hai (`www.example.com/x` → `example.com`, subdomains bhi).
- Test: `tests/ui-policy-editor.mjs` (sab policies ka round-trip, har rule ka alag waqt, router rules, phone).

## 7r. Ek site band / khuli (policy ke andar) aur unblock ki darkhwast

**Policy on / off** (Blocking → Policies → har line ke shuru mein switch, ya `radius-admin policy off NAAM` / `policy on NAAM`):
- **Off**: policy users / groups ke paas hi rehti hai, lekin router ko us ke koi rules nahi milte — kuch band nahi. **On**: sab wapas (auto-sync se 15 minute mein).
- Off policy ko edit karein to off hi rehti hai. List mein `[OFF]`, table mein halki line + "OFF", Overview: "1 turned off". Why blocked? bata deta hai "policy OFF hai".
- Kis ke paas hai us ke saath off karne se pehle tasdeeq poochi jati hai. Naam `policies/.off` mein rehta hai.

**Ek lafz se block** (Policy → Edit → **Words in site names**, ya policy file):
```
block-word casino                       # naam mein kahin bhi: bestcasino.net, casino-x.org
block-word ^bet time=20h-23h,fri,sat    # sirf naam ke hisse ke shuru mein: bet365.com, best-bets.org — alphabet.com NAHI
```
- Router HTTPS site ka **naam** (tls-host) dekhta hai, page ke andar ka text nahi (HTTPS mein woh nazar nahi aata). Log mein `WF-word`.
- Lafz: 3–32 harf / number (`^` ke saath 2–32). Editor khabardar karta hai agar lafz bari sites ko bhi rokta ho (maslan "video" → googlevideo.com = YouTube); tab "start of a name part" ya lamba lafz.
- Sample `staff` policy mein `block-word casino` aur shaam ko `^bet`. Tests: `tests/test-policy-onoff.sh` (25, API ke saath), `tests/simulate-policies.py` (+7), `tests/test-whyblocked.py` (+8).

**Policy mein single sites** (dashboard → Blocking → policy → Edit, ya policy file):
```
block social
allow-site linkedin.com          # exception: social band, LinkedIn khula (subdomains bhi)
block-site example-bet.com       # sirf yeh site band (time= bhi chalta hai)
```
- Router par har policy ab apni chain `wfp-NAAM` mein chalti hai: pehle `allow-site` (return), phir blocks. "No internet" / "Only apps" policies mein pehla packet naam nahi dikhata, is liye allow-site **router ki DNS** se bhi chalta hai: naam aur us ke **har subdomain** ke IP list `mlname-NAAM` mein aate hain (RouterOS 7.15+) — maslan `allow-site cdninstagram.com` se `scontent-…cdninstagram.com` ki tasveerein bhi.
- Misal (sirf ek website, us ke fonts aur Instagram tasveeron ke sath):
  ```
  block-all
  allow-site minascollection.com
  allow-site fonts.googleapis.com
  allow-site fonts.gstatic.com
  allow-site cdninstagram.com
  ```
- Router-wide DNS lists (webfilter-*.rsc import) par allow-site asar nahi karta — woh sab ke liye hain.

**Unblock ki darkhwast** (block page ke saath):
1. User ko block page par **"Khulwane ki darkhwast bhejein"** (wajah likh sakta hai).
2. Admin ko alert (Telegram / WhatsApp / email — Settings → Alerts → *Unblock requests*).
3. Dashboard → **Blocking → Requests**: **1 hour / Today / Always / Refuse** (aur **Why?**). CLI: `radius-admin unblock list | approve ID 1h|today|always | deny ID | end ID | allow USER SITE 2h`.
4. Arzi ijazat router par **1 minute** mein (script `ml-live`: user ke IP + site ke return rules policy chain ke upar), waqt khatam hone par khud band. **Always** = us policy mein `allow-site` (us policy ke sab users ke liye).
- Hifazat: darkhwast sirf usi device se jise block page dikha (code + IP + site), ek site ki ek pending darkhwast, din mein 10 tak.
- Tests: `tests/test-unblock.sh` (33 checks), simulator mein naye cases.

## 7e. Health check — sab theek hai?

`sudo radius-admin doctor` ya dashboard → **Health check**: server ka har hissa **sabz** (theek), **peela** (dekh lein) ya **laal** (abhi theek karein), aur kharabi ke saath us ka hal likha hota hai.

Kya check hota hai: FreeRADIUS (chal raha hai + 1812/1813 par sun raha hai), database aur us ki tables, dashboard (web + nginx), DNS logger (aakhri lookup kab aaya), traffic collector, router logs, cron, hourly jobs aur weekly updates (fail hue?), aakhri backup kitna purana, off-site copy, disk, memory, CPU, certificate kitne din valid, clock sync, alerts on hain ya nahi, aur har router (ping + aakhri login / accounting).

- **Tension free:** check **har ghante khud** chalta hai (hourly job, `doctor --save` → `/var/lib/mikrotiklover/health.json`). Kuch kharab ho to **Telegram / WhatsApp / email** khud aata hai ("🩺 Problem: … Fix: …"), aur theek hone par "✅ Fine again" (Settings → Alerts → Health check).
- Dashboard → Health check: upar **ek saaf jawab** ("Everything is working" / "2 things to look at" / "1 problem — fix now"), phir **Your to-do** (sirf masle, laal pehle, har ek ke saath *How to fix*), **Check now**, aur **Copy report** (WhatsApp / email par bhejne ke liye text). Baqi saare checks neeche band.
- **Naya group "Blocking & data":**
  - **Router rules** policy badalne ke baad bane?
  - **Router scripts** lint (import mein error to nahi aayega);
  - **Policies self-test**: har chalu policy router file mein hai, har band category mein naam hain, aur har rule ki ek misaal site (category ki pehli site, block-site, block-word) "Why blocked?" ke hisaab se waqai band hai — apne waqt par;
  - **Routers take the rules**: har router ne aakhri dafa kab naye rules maange aur kya us ke paas naya version hai (server har fetch note karta hai: `ml_router_fetch`); 1 ghante se zyada chup → laal;
  - **Apps on network** aur **Traffic data** taaza hain?
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
