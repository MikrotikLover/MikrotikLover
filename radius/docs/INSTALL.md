# MikrotikLover RADIUS — Installation aur Configuration Guide (shuru se aakhir tak)

Yeh guide ek khali server se le kar poore chalte hue system tak har qadam batati hai: install, router setup, users, blocking, reports, security, backup aur update. Har feature ki tafseel `README.md` mein hai; yahan **tarteeb (order)** aur **zaroori settings** hain.

---

## 0. Pehle samjhein — kya kahan chalta hai

```
  Phones / laptops ──Wi-Fi / Hotspot / PPPoE──►  MikroTik router  ──internet──►
                                                  │  ▲
     RADIUS login (1812/1813) ───────────────────►│  │◄── Disconnect / CoA (3799)
     DNS queries (53, dns-logging.rsc) ──────────►│  │
     Traffic Flow / IPFIX (2055) ────────────────►│  │◄── auto-sync har 15 min (HTTPS 8443)
     Router logs / syslog (514) ─────────────────►▼  │
                                         RADIUS server (Ubuntu / Debian)
                                         FreeRADIUS + MariaDB + dashboard (https://SERVER:8443)
```

| Server par | Kaam |
|---|---|
| FreeRADIUS + MariaDB | Login (WPA-Enterprise, hotspot, PPPoE, MAC), plans, quota, speed, policies |
| DNS logger (dnsmasq) | Har device ne kaunsi website kholi, apps aur domains ki list, VPN aur virus ki pehchan |
| Traffic collector | Har site/IP/user ka data, ports, VPN connections, DDoS/hacker attacks |
| rsyslog | Router ke block logs, VPN blocks, security hits, login failures |
| Dashboard (nginx + Flask) | Sab kuch browser se |
| Cron | Hourly scans, weekly updates, nightly backup |

---

## 1. Kya chahiye

| Cheez | Kam se kam | Behtar |
|---|---|---|
| Server | 2 CPU, 2 GB RAM, 20 GB disk | 4 CPU, 4–8 GB RAM, SSD 100 GB (zyada users / lambi history) |
| OS | Ubuntu 22.04 / 24.04 ya Debian 12 (64-bit, saaf install) | Ubuntu 24.04 LTS |
| Router | MikroTik RouterOS 7.x (security, auto-sync, `tls-host`, adlists ke liye) | RouterOS 7.15+ |
| Network | Server ka **fixed IP** | Server **alag VLAN/subnet** mein ya **WireGuard** se router tak |

**Zaroori:** server clients wale subnet mein **na** ho, warna DNS logger ke jawab router ko bypass kar jayenge. Alag VLAN (misaal `10.10.10.0/24`) ya WireGuard tunnel sab se behtar hai. Server internet par (VPS) ho to router aur VPS ke darmiyan WireGuard zaroor lagayein, kyunki RADIUS attributes encrypted nahi hote.

---

## 1b. Cable kaise lagayein (WAN, LAN, RADIUS server)

```
   ISP modem / fiber ONT
          │
       ether1  (WAN — internet)
   ┌────────────────────────┐
   │        MikroTik         │
   │ ether2 ether3 ether4    │ ether5
   └──┬──────┬──────┬────────┴──┬──────────
      │      │      │           │
   switch / Wi-Fi access points  RADIUS server (PC / mini PC / VM wala Windows PC)
   (users: LAN bridge,           alag network: 10.10.10.0/24
    misal 192.168.88.0/24)       router 10.10.10.1  ·  server 10.10.10.10
```

- **ether1** = internet (ISP). **ether2–4** = users (bridge / switch / access points). **ether5** = sirf RADIUS server — **apna alag network**, users wale bridge mein nahi (DNS logger is ke baghair theek kaam nahi karta).
- Ports ke naam apne router ke hisaab se badal lein.

**Router par (Terminal) — ether5 ko server ka port banana:**
```
/interface bridge port remove [find interface=ether5]
/ip address add address=10.10.10.1/24 interface=ether5 comment="RADIUS server"
/interface list member add list=LAN interface=ether5
```
(Interface list `LAN` pehle se na ho to: `/interface list add name=LAN` aur bridge ko bhi us mein daalein. Server ko internet router ki maujooda masquerade (NAT) se milta hai.)

**Server par — fixed IP** (Ubuntu, `/etc/netplan/01-net.yaml`; `eth0` ki jagah `ip a` mein jo naam dikhe):
```yaml
network:
  version: 2
  ethernets:
    eth0:
      addresses: [10.10.10.10/24]
      routes: [{to: default, via: 10.10.10.1}]
      nameservers: {addresses: [10.10.10.1]}
```
`sudo netplan apply` → `ping 10.10.10.1` aur `ping 8.8.8.8` dono chalne chahiyein.

**Phir:**
- Server par router add karein: `sudo radius-admin nas add 10.10.10.1` (router isi IP se RADIUS bhejta hai).
- Router ki saari scripts mein `RADIUS_SERVER_IP` = `10.10.10.10`.
- Dashboard: admin ke PC se `https://10.10.10.10:8443` (users ke LAN se router ke raaste khulta hai).

**Doosri jagahen:** server internet par (VPS) ya doosri branch mein ho to cable ki jagah **WireGuard** tunnel lagayein, aur upar wala `10.10.10.x` tunnel ke IPs ban jate hain. Kai routers hon to har router aik `nas add` aur wohi scripts.

---

## 2. Server tayyar karein

```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Karachi        # apna time zone (reports aur time-policies isi par chalti hain)
sudo hostnamectl set-hostname radius
```

Server ko fixed IP dein (netplan / router DHCP reservation).

---

## 3. Install

**ZIP se (jo file aap ke paas hai):**
```bash
# 1) zip server par bhejein (apne PC se):   scp MikrotikLover-RADIUS.zip root@SERVER_IP:/root/
# 2) server par:
sudo apt -y install unzip
cd /root && unzip MikrotikLover-RADIUS.zip
cd MikrotikLover-RADIUS/radius
sudo RADIUS_DOMAIN=radius.mycompany.lan bash install.sh
```
2–5 minute lagte hain. Aakhir mein **dashboard ka address aur pehla admin password** print hota hai — foran likh lein. Phir: `sudo radius-admin doctor` (sab sabz hona chahiye; router ke bina "routers" peela hona normal hai).

**Ya internet se, aik command:**
```bash
curl -fsSL https://raw.githubusercontent.com/MikrotikLover/MikrotikLover/main/radius/get.sh | sudo bash
```
Sawal: server ka naam (certificate), company ka naam, dashboard sirf LAN se ya har jagah se. Pehle system check hota hai (OS, RAM, disk, internet, RADIUS ports); kuch kam ho to wahin ruk kar wajah batata hai. Aakhir mein health check dikhata hai. Log: `/var/log/mikrotiklover-install.log`. Options: `--domain NAME --org NAME --web-allow any|"IPs" --web-port N --firewall --yes`. Update ke liye wohi command dobara.

**Ya haath se:**
```bash
sudo apt -y install git
git clone https://github.com/mikrotiklover/mikrotiklover.git
cd mikrotiklover/radius
sudo RADIUS_DOMAIN=radius.mycompany.lan ./install.sh
```

| Option (install se pehle) | Matlab | Default |
|---|---|---|
| `RADIUS_DOMAIN` | Certificate ka naam. Android par "Domain" mein yahi likha jata hai, aur router auto-sync bhi isi naam se server tak jata hai | `radius.local` |
| `CERT_ORG` | Certificate mein company ka naam | `MikrotikLover` |
| `WEB=0` | Dashboard install na karein | `1` |
| `WEB_PORT` | Dashboard port | `8443` |
| `WEB_ALLOW` | Dashboard kaun khol sakta hai (IPs/networks space se alag, ya `any`) | private networks |
| `RENEW_CERT=1` / `RENEW_CA=1` | Naya server certificate / naya CA | — |

Installer dobara chalana **safe** hai (update ke liye bhi yahi). Aakhir mein yeh print hota hai:
- **Dashboard ka address** aur **pehla admin password**. Isay foran save karein; pehle login ke baad Settings → My password se badal dein.
- Cert domain, aur `ca.der` / `ca.pem` ka path. Phones ko yeh connect guide page se milte hain.

Install hone ke baad check karein:

```bash
sudo radius-admin user add test1 -p 'Test@12345'
sudo radius-admin test test1 'Test@12345'        # "login OK" aana chahiye
sudo radius-admin user del test1
```

### Server firewall (ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow from ROUTER_IP to any port 1812:1813 proto udp   # RADIUS
sudo ufw allow from ROUTER_IP to any port 514 proto udp         # router logs
sudo ufw allow from ROUTER_IP to any port 2055 proto udp        # Traffic Flow
sudo ufw allow from 10.0.0.0/8 to any port 53                   # DNS logger (apne LAN subnets)
sudo ufw allow from 192.168.0.0/16 to any port 53
sudo ufw allow 8443/tcp                                          # dashboard + router auto-sync
sudo ufw allow from 10.0.0.0/8 to any port 8081 proto tcp       # quarantine warning page (apne LAN subnets)
sudo ufw allow from 192.168.0.0/16 to any port 8081 proto tcp
sudo ufw allow from 10.0.0.0/8 to any port 8082 proto tcp       # block page (radius-admin blockpage on)
sudo ufw allow from 192.168.0.0/16 to any port 8082 proto tcp
sudo ufw enable
```

---

## 4. Router ko server mein add karein (NAS)

```bash
sudo radius-admin nas add 192.168.88.1                # secret khud banta hai aur print hota hai, sambhal lein
```

Dashboard → **Routers** se bhi add kar sakte hain. IP wahi likhein jis se router ke packets server tak pohanchte hain (WireGuard ho to tunnel IP).

---

## 5. Router configuration — is tarteeb (order) se

### Aasan tareeqa: dashboard → **Router setup** (koi file edit nahi)

1. Dashboard → **Routers** mein router add karein (secret khud ban jata hai).
2. Dashboard → **Router setup**: router chunein, server ka IP check karein (jo router ko dikhta hai, maslan `10.10.10.10`), LAN interface (aam tor par `bridge`).
   Server alag port (maslan `ether5`) par laga hai to "Server port" aur "Router address on that port" (`10.10.10.1/24`) bhar dein.
3. Jo cheezein chahiyein un par tick lagayein (Hotspot, Staff Wi-Fi, PPPoE, logs, auto-sync, security …). Hotspot pehli dafa ho to "Make the hotspot too" + LAN address (`192.168.88.1/24`).
4. **Make the script** dabayein. Ek line milti hai, maslan:
   ```
   /tool fetch url="https://10.10.10.10:8443/api/public/setup/9ffd…rsc" check-certificate=no dst-path=ml-setup.rsc; :delay 2s; /import file-name=ml-setup.rsc; /file remove ml-setup.rsc
   ```
5. Winbox → **New Terminal** → line paste → **Enter**. Page par "router downloaded it ✔" aa jata hai; akhir mein terminal mein `MikrotikLover setup finished` likha aata hai.

Baatein:
- Link **1 ghante** chalta hai, sirf usi router ke liye; script mein router ka secret hai, is liye line kisi ko na bhejein. Import ke baad file router se khud mit jati hai.
- Router server tak nahi pohanchta? **Download .rsc** → Winbox → Files mein daalein → `/import file-name=ml-setup.rsc`.
- Baad mein naya hissa lagana ho to sirf woh tick karein (aur "Blocking base → Already on this router"). Ek hi hissa dobara import karne par RouterOS "already have such entry" par ruk sakta hai — pehle purana hata dein.
- Sab RADIUS services (hotspot, ppp, wireless) ek hi `/radius` entry mein aati hain.

### Haath se (purana tareeqa)

Scripts `radius/mikrotik/` mein hain. Har file mein `RADIUS_SERVER_IP`, `RADIUS_SECRET` (aur SSID waghera) replace karein. Phir Winbox → **Files** mein upload karein aur **Terminal** mein `/import file-name=NAAM.rsc` chalayein.

| # | Script | Kab | Server par pehle |
|---|---|---|---|
| 1 | `wpa-enterprise-wifi-ros7.rsc` / `-wireless-legacy.rsc` | Staff Wi-Fi (username + password) | users / groups |
| 1 | `hotspot.rsc` (+ `hotspot-login/`) | Hotspot business (vouchers) | plans / vouchers |
| 1 | `pppoe-server.rsc` | PPPoE (ISP) | plans, `--pool` |
| 1 | `mac-auth.rsc` | Printer / TV / CCTV bina password | `radius-admin mac add` |
| 2 | `webfilter-base.rsc` | Blocking ki buniyad (zaroori) | — |
| 3 | `webfilter-logging.rsc` | Blocking logs, VPN watch, security, login failures | — |
| 4 | `dns-logging.rsc` | Visited sites, apps list, website names, VPN aur virus detection | `radius-admin dnslog on ROUTER_IP` |
| 5 | `traffic-flow.rsc` | Data usage, ports, VPN connections, DDoS/hacker detection | `radius-admin traffic collector on` |
| 6 | **Auto-sync** script (dashboard → Blocking → Router auto-sync → Download) | Policies, app lists, VPN list, threat lists khud aate rehte hain | — |
| 7 | `security.rsc` | Port scan / password guessing / SYN flood / threat lists ka block | (optional) `radius-admin security autoblock on` |
| 7 | `lan-guard.rsc` | Nakli router (rogue DHCP) aur ARP spoofing (man-in-the-middle) pakarna | `webfilter-logging.rsc` dobara import (dhcp + script logs) |
| 8 | Optional: `webfilter-<category>.rsc`, `webfilter-adlists.rsc`, `webfilter-safesearch.rsc`, `webfilter-keywords.rsc`, `webfilter-vpn-protocols.rsc` | Sab users par ek jaisi blocking | — |

Har script ke upar comment mein uski tafseel aur use hatane ka tareeqa likha hai.

**Router par zaroori settings:**
- `/radius incoming set accept=yes`: is ke baghair "kick", policy badalna aur FUP turant nahi lagte (scripts mein yeh shamil hai).
- Interface list **LAN** mein apne LAN bridge/VLANs hon. Security aur blocking scripts isi list se andar aur bahar ka farq karti hain.
- Router ka time sahi ho: `/system ntp client set enabled=yes servers=pool.ntp.org`.

---

## 5b. Hotspot users ko connect karna — qadam ba qadam

Misal: users ka network `bridge` (192.168.88.0/24), router `192.168.88.1`, RADIUS server `10.10.10.10` (section 1b).

**Shortcut:** dashboard → **Router setup** → "Hotspot" + "Make the hotspot too" (LAN address `192.168.88.1/24`) → ek line terminal mein: neeche wale A aur B dono ho jate hain (internet ke liye router ki default NAT/masquerade aur DNS honi chahiye — MikroTik ki default config mein hoti hai).

**A. Router par hotspot banana (Winbox → Terminal):**
```
/ip hotspot setup
```
Sawalon ke jawab:
| Sawal | Jawab |
|---|---|
| hotspot interface | `bridge` (users wala; server ka ether5 nahi) |
| local address of network | `192.168.88.1/24` |
| masquerade network | `yes` |
| address pool of network | `192.168.88.10-192.168.88.254` |
| select certificate | `none` |
| ip address of smtp server | `0.0.0.0` |
| dns servers | `8.8.8.8` |
| dns name | `login.wifi` (dashboard → Settings → "Hotspot login address" mein bhi yahi) |
| name of local hotspot user | koi bhi (misal `admin1`) — baad mein users RADIUS se aayenge |

Wi-Fi: guest SSID (misal `Cafe-WiFi`) **bina password** ke banayein aur use `bridge` mein rakhein. (Agar staff ka alag WiFi chahiye to woh WPA-Enterprise script se, section 5 #1.)

**B. Hotspot ko RADIUS se jorna:** `mikrotik/hotspot.rsc` mein `RADIUS_SERVER_IP` = `10.10.10.10`, `RADIUS_SECRET` = jo `radius-admin nas add` ne diya → upload → `/import file-name=hotspot.rsc`. Is se profile `hsprof1` RADIUS, accounting (har 5 min) aur CHAP login par chala jata hai.

**C. Login page:** dashboard → **Hotspot page** (naam, logo, rang, offer) → "Put these pages on the routers automatically" on (auto-sync script laga ho). Ya haath se: Winbox → Files → `hotspot/` mein `mikrotik/hotspot-login/` ki teeno files (login.html, status.html, alogin.html).

**D. Plan aur vouchers — dashboard se:**
1. **Plans → New plan**: Name (`1day`), Price (`50`), Validity (`1d`), Data quota (`2G`), Speed (`5M/5M`), Devices at once (`1`) → **Save**. Mahana plan: Validity `30d`, quota `30G`, Quota resets `monthly`.
2. **Vouchers → Create vouchers**: Plan `1day`, How many `50`, **PIN mode** tick → **Create** → batch kholein → **Print cards**.
3. Mustaqil user: **Users → Add user** → us user ka page → **Package** mein plan chunein.

Yahi kaam terminal se (optional):
```bash
sudo radius-admin plan add 1day  --price 50  --validity 1d  --quota 2G  --rate 5M/5M --devices 1
sudo radius-admin plan add 30day --price 500 --validity 30d --quota 30G --period monthly --rate 5M/5M
sudo radius-admin voucher create 1day 50 --pin          # 50 cards, sirf PIN wale
```
Hotspot users **`--nt-hash` ke baghair** banayein (dashboard mein "Store NT-hash" tick na karein).
Bina card free WiFi (cafe): section 6b → Social WiFi.

**E. Admin / printer jinhe login nahi chahiye:**
```
/ip hotspot ip-binding add mac-address=AA:BB:CC:DD:EE:FF type=bypassed comment="admin laptop"
```

**F. Test:** phone se `Cafe-WiFi` join karein → login page khud khulta hai (na khule to browser mein `http://login.wifi`) → voucher / PIN → internet.
Server par: `sudo radius-admin online` (kaun online), `sudo radius-admin log` (aakhri logins), dashboard → **Live log**.

**Masle:**
| Masla | Hal |
|---|---|
| Login page nahi khulta | Phone par koi `http://` site kholein; DNS name `login.wifi` sahi ho; HTTPS sites pehle page nahi dikhati |
| "RADIUS server is not responding" | `nas add` wala IP router ka **ether5 IP** (10.10.10.1) ho; secret dono taraf aik; router par `/radius monitor 0`; server firewall 1812/1813 |
| "invalid username or password" | `radius-admin test USER PASS`; user `--nt-hash` se bana ho to password dobara set karein bina `--nt-hash` |
| Package expired / data khatam | Theek hai — `radius-admin user status USER` mein wajah; `user renew USER` |
| Login hua lekin internet nahi | `/ip hotspot setup` mein masquerade `yes`; router ka apna internet chal raha ho |

---

## 6. Users, plans aur blocking

| Kaam | Dashboard | CLI |
|---|---|---|
| Group (speed, VLAN, policy) | Groups & policies | `radius-admin group add staff --rate 20M/20M --policy staff` |
| User | Users → Add | `radius-admin user add ali -g staff` |
| Plans + vouchers (hotspot) | Plans, Vouchers, Print | `radius-admin plan add …`, `radius-admin voucher create …` |
| Kisi user ki apps/websites band | **Blocking** → policy → "Give a policy to a user" | `radius-admin user policy ali kids` |
| Sirf WhatsApp | Blocking → `whatsapp-only` | `radius-admin user policy ali whatsapp-only` |
| VPN band | Blocking → `no-vpn` / "Block VPN" | `radius-admin user policy ali no-vpn` |
| Kis policy ne kis user ko kya block kiya | **Blocking → Blocking logs** | `radius-admin blocked --summary` |

Users ko connect karne ka tareeqa batane ke liye unhein `https://SERVER:8443/connect` ka link bhejein. Is page par har phone ke steps hain.

---

## 6b. Baqi features chalu karna — checklist

Install ke baad yeh sab **band** ya default par hote hain. Jo chahiye, on karein (dashboard se ya CLI se):

| Feature | Dashboard | CLI (server par `sudo`) |
|---|---|---|
| Server ka IP (routers ki nazar se) — quarantine page aur social WiFi ke liye | Security → Protection & lists | `radius-admin security quarantine-server 192.168.88.10` |
| Har user ka pakka IP (DHCP walon ke liye; admin badal sakta hai) | IP binding | `radius-admin ipbind auto on` · `ipbind set ali 192.168.88.50` · `ipbind days 7` |
| Department ki shared speed (maslan Sales 10M: 1 user ho to poori, 10 hon to baant lein) | Departments | `radius-admin dept add sales 10M 5M` · `dept member sales user ali` / `group staff` |
| Traffic graphs (interface / user / group / department) | Traffic graphs | khud chalta hai: interfaces router report se (auto-sync), users accounting se (har 5 min) |
| Site kyun band hai? (kaun si list / policy rule, abhi active?) | Blocking → Why blocked? | `radius-admin why facebook.com ali` |
| Website / app ka sirf naam likho, baqi (fonts, CDN, tasveerein) khud — poori site (sitemap, 150 pages, JS) background mein | Blocking → policy → Websites / Apps always open · Blocking → Allowed websites & apps → Read the whole site | `radius-admin webscan list` · `webscan deep SITE` |
| Ransomware: kis PC par nishaniyan, risk 0–100, cut off | Security → Ransomware | `radius-admin security ransomware` · `security ransomware-auto on` |
| Firewall (FortiGate jaisa): policies order mein, Allow / Deny / Reject, addresses, services, schedules, hits | Firewall → Policies | `radius-admin firewall list` · `firewall rule add NAME --dir wan --service RDP --action deny` |
| Port forward sirf kuch addresses / countries ke liye | Firewall → Port forwards | `radius-admin firewall vip add DVR 37777 192.168.88.20 --src office,geo:PK` |
| Mulk band karna (Geo-IP), andar aate ya bahar jaate | Firewall → Countries | `radius-admin firewall geo update` · `firewall rule add X --dir wan --src geo:CN --action deny` |
| IPS (Suricata): hamle pehchanna aur hamla karne wale IP ko minute mein band | Security → Intrusion prevention | `radius-admin ips install` · `ips on` · `ips status` · `ips alerts` |
| IPS block ~1 second mein (MikroTik API, api-ssl) | Security → Intrusion prevention → Instant blocks → + Add a router | `radius-admin ips api add 192.168.88.1` · `ips api test 192.168.88.1` · `ips api list` |
| Mail server (MDaemon) ki hifazat: safe ports, password guessing band, spam bots, DNS / blacklist / certificate checks | Mail server | `radius-admin mail set ip 192.168.88.30 domain example.com` · `mail doors` · `mail status` |
| Ye connection kaun si policy le gi? | Firewall → Policy lookup | `radius-admin firewall lookup router 1.2.3.4 203.0.113.1 tcp 8291` |
| Bahar se kya andar aa raha hai: khule darwaze (port forward, UPnP, router services), kis IP ne kis andar ke IP:port ko chhua | Security → From outside → Who? | naya auto-sync script import + traffic collector |
| Microsoft Windows Update band / sirf office hours mein band / on | Blocking → Overview → Windows Update | `radius-admin winupdate off` · `winupdate office` · `winupdate on` |
| Sab theek hai? (har ghante khud, kharabi par alert) | Health check → ek jawab + Your to-do + Copy report | `sudo radius-admin doctor` |
| Network par har app: servers, domains, ports, Android / iPhone devices | Apps on network → Android filter → app → Details | `radius-admin apps update` (hourly) |
| Policy thori der ke liye band (users ke paas rahe) | Blocking → Policies → switch On / Off | `radius-admin policy off NAME` · `policy on NAME` |
| Ek lafz se sites band (casino, ^bet) | Blocking → policy → Edit → Words in site names | policy file: `block-word casino` |
| App ke ports: kaun se ports use karti hai, aur seedhe IP:port jo band hue (P2P / relay) — Allow par sirf wahi network + port | Blocking → Allowed websites & apps → card: Ports it uses / Direct connections it tried | `radius-admin webscan allow ao-hikconnect "NET/24 udp PORT"` |
| Sirf kuch apps (WhatsApp + Hik-Connect …), apni app profile, app seekhna | Blocking → policy (ONLY the apps I choose) · Blocking → App profiles | `radius-admin allowonly list` · `allowonly learn IP 15` |
| Policy mein ek site band / hamesha khuli | Blocking → policy → Edit (Single websites / Always open) | policy file: `block-site x.com` · `allow-site y.com` |
| Unblock darkhwast + arzi ijazat (1 ghanta / aaj / hamesha) | Blocking → Requests | `radius-admin unblock list` · `unblock approve ID 1h` |
| Block page users ke liye (logo, wajah, code — http:// sites) | Blocking → Why blocked? → Block page | `radius-admin blockpage on` · `blockpage ref CODE` (ufw: 8082/tcp LAN se) |
| Alerts phone par (Telegram / WhatsApp / Email) | Settings → Alerts | `radius-admin alerts telegram BOT_TOKEN` · `alerts whatsapp 923001234567 APIKEY` · `alerts test` |
| Off-site backup (doosra server / Google Drive) | Settings → Off-site copy | `radius-admin backup offsite ssh user@host:/backups` ya `backup offsite rclone gdrive:ml` |
| Infected device quarantine (khud) | Security → Protection | `radius-admin security quarantine-auto on` |
| Attackers khud block | Security → Protection | `radius-admin security autoblock on` |
| Speed schedule (raat double, rush hour kam) | Speed schedule | `radius-admin speed add night --rate 20M/20M --time 22:00-08:00` |
| Expiry / data khatam hone se pehle warning | Settings → Warn users | `radius-admin notice set days 2` · SMS: `notice gateway 'https://...{phone}...{text}'` · `notice set sms on` |
| Hotspot login page (logo, rang, offer) | Hotspot page | `radius-admin hotspot set title "Mera Cafe"` · `hotspot push on` |
| Social WiFi (phone number + code) | Social WiFi | `radius-admin social on` · `social set minutes 60` · `social set mb 500` |
| Parental controls (bachon ke liye) | Blocking → Parental controls | `radius-admin user policy bacha1 parental-kids` |
| Router health (CPU, links, alerts) | Routers | router par naya auto-sync script import (section 5, #6) |
| Nakli router / ARP spoofing pakarna | Security → Hacker attacks | router par `lan-guard.rsc` |
| Weekly / monthly reports | Insights, Security → Monthly reports | `radius-admin insights` · `security report --send` |
| Sab theek hai? | Health check | `radius-admin doctor` |

**Sab se pehle (tarteeb):** server IP → alerts → backup / off-site → baqi apni zaroorat ke mutabiq.

---

## 7. Roz ka kaam — kahan kya dekhein

| Sawal | Jagah |
|---|---|
| Kaun online hai, kitna data | Online now, Data usage |
| Kis ne kya khola (live) | Live log, Reports |
| Network par kaunsi apps chal rahi hain | Apps on network |
| Har domain/subdomain ka record | **Website names** (`radius-admin domains`) |
| Kaun VPN / proxy chalane ki koshish kar raha hai | **VPN & proxy watch** (`radius-admin vpn users`) |
| Virus, hacker attack, DDoS | **Security** (`radius-admin security`) |
| Kaunsa port IN / OUT, kaunsi app kaunse ports | Ports & protocols |
| Becha kitna | Sales |

---

## 8. Khud chalne wale kaam (cron) — kuch karna nahi parta

| Kab | Kya |
|---|---|
| Har 5 minute | Expire / quota / FUP enforcement (`radius-admin enforce`) |
| Har ghante | App domains seekhna, nayi apps dhoondna, app inventory, website names, VPN watch scan, security scan, router rules build |
| Har 15 minute (router) | Auto-sync: router server se nayi rules leta hai (sirf jab kuch badla ho) |
| Har hafte (Tuesday raat) | `radius-admin update`: app catalog, IP owner lists, nayi apps ke naam, threat lists, VPN lists, router rules |
| Har raat 02:43 | Poora backup (`/var/backups/mikrotiklover`, aakhri 14 rakhe jate hain) + off-site copy (agar set ho) |
| Har 5 minute | Alerts check: router / service down, virus / attack, quarantine, failed backup … (`radius-admin alerts check`) + roz ki summary |

**Alerts phone par:** `sudo radius-admin alerts telegram BOT_TOKEN` (ya `whatsapp PHONE APIKEY`, ya `email TO smtp.gmail.com:587 --user ...`), phir `sudo radius-admin alerts test`. Ya dashboard → **Settings → Alerts**. Tafseel README section 7d.

Status: Dashboard → **Settings → Automatic updates** (har kaam ka aakhri run aur nateeja). Sab abhi chalane ke liye: `sudo radius-admin update`.

App catalog ka update `CATALOG_URL` se aata hai: default yeh repository hai, aur `/etc/mikrotiklover-radius/radius.conf` mein `CATALOG_URL=...` likh kar badal sakte hain. Apni apps `/var/lib/mikrotiklover/cdn-apps.local.json` mein likhein; update un par asar nahi karta.

---

## 9. Backup aur restore

```bash
sudo radius-admin backup                    # abhi backup
printf 'MeraPass123\n' | sudo radius-admin backup --encrypt     # password ke saath (bahar bhejne ke liye)
sudo radius-admin backups                   # list
sudo radius-admin restore /var/backups/mikrotiklover/mikrotiklover-manual-....tar.gz
```

**Backup mein sab kuch hai:** database (users, plans, vouchers, sales, accounting, reports, security, VPN, apps, website names), settings, certificates, poora FreeRADIUS config, policies, seekhi hui lists, router sync key, dashboard accounts, cron, nginx aur rsyslog config.

**Naye server par le jana:**
1. Naye server par sections 2–3 (install), wohi `RADIUS_DOMAIN` ke saath.
2. Purane server se backup file copy karein: `scp`, USB, ya dashboard → Settings → Backups → Download.
3. `sudo radius-admin restore FILE`. Restore ke dauran:
   - pehle maujooda haalat ki safety copy banti hai;
   - phir services rukti hain;
   - files aur database wapas aate hain;
   - database users ke passwords theek kiye jate hain;
   - services dobara chalti hain.
4. Server ka IP badla ho to routers mein `RADIUS_SERVER_IP` badlein, aur auto-sync script dobara import karein.

Backup ki ek copy **hamesha server se bahar** rakhein — yeh khud ho sakta hai:

**Off-site copy (har raat khud, encrypted):**
```bash
# doosra Linux server / NAS par:  sudo adduser backup ; sudo mkdir -p /srv/backups ; sudo chown backup /srv/backups
sudo radius-admin backup offsite ssh backup@192.168.1.20:/srv/backups     # key dikhegi
#   us server par: key ko /home/backup/.ssh/authorized_keys mein daalein
sudo radius-admin backup offsite test
# ya Google Drive / Dropbox / OneDrive / S3:
sudo apt install rclone ; sudo rclone config        # remote banayein, e.g. "gdrive"
sudo radius-admin backup offsite rclone gdrive:mikrotiklover
sudo radius-admin backup offsite password           # yeh password likh kar mehfooz rakhein
```
Server kharab ho jaye: naya server install karein, `offsite ssh|rclone ...` dobara set karein (wahi target), phir
`sudo radius-admin backup offsite fetch` aur `sudo radius-admin restore FILE.tar.gz.enc` (purana password). Dashboard: **Settings → Off-site copy**.

---

## 10. Software update

```bash
cd mikrotiklover && git pull
cd radius && sudo ./install.sh               # wohi options; data, users, policies sab rehte hain
```

Update se pehle `sudo radius-admin backup` chala lein.

---

## 11. Masle aur hal (troubleshooting)

**Sab se pehle:** `sudo radius-admin doctor` (ya dashboard → **Health check**). Har hissa sabz / peela / laal dikhta hai, aur jo kharab ho us ke saath hal (command) likha hota hai: services, database, DNS logger, router logs, cron, hourly jobs, updates, backup, off-site copy, disk, memory, certificate ki expiry, clock, alerts, aur har router (ping + aakhri login).

| Masla | Check |
|---|---|
| Login fail | `sudo radius-admin log` (aakhri logins), `sudo radius-admin test USER PASS`; debug: `sudo systemctl stop freeradius && sudo freeradius -X` |
| Router se RADIUS jawab nahi | NAS IP/secret (`radius-admin nas list`), ufw 1812/1813, router `/radius monitor 0` |
| Kick / policy turant nahi lagti | Router par `/radius incoming set accept=yes`, ufw (router ki taraf 3799) |
| Visited sites khali | `radius-admin dnslog status`, router `dns-logging.rsc`, server alag subnet mein ho |
| Data usage khali | `radius-admin traffic collector status`, router `traffic-flow.rsc`, fasttrack band |
| Blocking logs khali | Router `webfilter-logging.rsc`, `tail /var/log/mikrotik/webfilter.log` |
| Router par policy nahi aayi | Dashboard → Blocking → Router auto-sync (version), router par `/log print where message~"ml-sync"` |
| Security mein router login failures nahi | `webfilter-logging.rsc` (topics system, critical), `tail /var/log/mikrotik/router.log` |
| Dashboard nahi khulta | `WEB_ALLOW` mein apna network, `sudo nginx -t`, `journalctl -u mikrotiklover-web` |

Log files: `/var/log/mikrotik/` (`dns.log`, `webfilter.log`, `router.log`, `traffic-collector.log`, `web.log`), FreeRADIUS: `/var/log/freeradius/radius.log`.

---

## 12. Hifazat (security) ke liye zaroori baatein

- Dashboard ka admin password lamba rakhein. Viewer accounts sirf dekh sakte hain. `WEB_ALLOW` ko apne office/LAN tak mehdood rakhein.
- `/etc/mikrotiklover-radius/` aur backups mein passwords aur keys hain; inhein kisi se share na karein.
- Router auto-sync key: dashboard → Blocking → Router auto-sync. Agar key leak ho jaye to `sudo radius-admin policy new-key` chala kar har router par script dobara import karein.
- Users ki browsing record hoti hai, is liye unhein pehle bata dein (terms / office policy). Pakistan mein PECA 2016 ke mutabiq data sirf zaroorat tak rakhein.

---

## 13. Ports aur files — ek nazar mein

| Port | Kahan se → kahan | Kis liye |
|---|---|---|
| UDP 1812/1813 | Router → server | RADIUS login / accounting |
| UDP 3799 | Server → router | Disconnect / CoA (kick, policy, FUP) |
| UDP/TCP 53 | LAN → server | DNS logger |
| UDP 2055 | Router → server | Traffic Flow (IPFIX) |
| UDP 514 | Router → server | Router logs |
| TCP 8443 | Browser / router → server | Dashboard, connect guide, router auto-sync |
| TCP 8081 | Quarantined device → server | Warning page for infected devices (plain HTTP) |
| TCP 8082 | Users with a policy → server | Block page proxy for http:// (radius-admin blockpage on) |
| TCP 22 (ya jo port diya) | Server → backup server | Off-site backup (SSH), sirf jab set ho |
| TCP 443 / 587 | Server → internet | Alerts: Telegram, CallMeBot (WhatsApp), SMTP email |

| Path | Kya |
|---|---|
| `/etc/mikrotiklover-radius/radius.conf` | DB, secrets, domain, `LAN_NETS`, `SEC_*` thresholds, `CATALOG_URL` |
| `/var/lib/mikrotiklover/` | Policies, seekhi hui apps, VPN/threat lists, router sync files |
| `/var/backups/mikrotiklover/` | Backups |
| `/usr/local/sbin/radius-admin` | Sab kaam ka CLI (`radius-admin help`) |
