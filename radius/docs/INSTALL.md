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

## 2. Server tayyar karein

```bash
sudo apt update && sudo apt -y upgrade
sudo timedatectl set-timezone Asia/Karachi        # apna time zone (reports aur time-policies isi par chalti hain)
sudo hostnamectl set-hostname radius
```

Server ko fixed IP dein (netplan / router DHCP reservation).

---

## 3. Install

**Sab se asaan — aik command:**
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
| TCP 22 (ya jo port diya) | Server → backup server | Off-site backup (SSH), sirf jab set ho |
| TCP 443 / 587 | Server → internet | Alerts: Telegram, CallMeBot (WhatsApp), SMTP email |

| Path | Kya |
|---|---|
| `/etc/mikrotiklover-radius/radius.conf` | DB, secrets, domain, `LAN_NETS`, `SEC_*` thresholds, `CATALOG_URL` |
| `/var/lib/mikrotiklover/` | Policies, seekhi hui apps, VPN/threat lists, router sync files |
| `/var/backups/mikrotiklover/` | Backups |
| `/usr/local/sbin/radius-admin` | Sab kaam ka CLI (`radius-admin help`) |
