# MikrotikLover — har feature ki guide

Har feature ke liye: **kya karta hai**, **dashboard mein kahan**, **CLI** (server par `sudo radius-admin …`), **kaise check karein**, aur **aam masla**. Tafseel ke liye har jagah README ke section ka hawala hai.

> Shuru karne wale: pehle [A. Shuruaat](#a-shuruaat--pehle-ye-5-kaam) ke 5 kaam, phir jo feature chahiye. Sab ek saath on na karein — dashboard ka **Setup steps** page qadam ba qadam le jata hai.
> Kuch bhi ajeeb lage: `sudo radius-admin doctor` (Health check) — har masle ke saath us ka hal batata hai.

**Fehrist**
- [A. Shuruaat](#a-shuruaat--pehle-ye-5-kaam)
- [B. Login aur users](#b-login-aur-users)
- [C. Hotspot business](#c-hotspot-business-plans-vouchers-guests)
- [D. Blocking aur policies](#d-blocking-aur-policies)
- [E. Network ko dekhna (monitoring)](#e-network-ko-dekhna-monitoring)
- [F. Security](#f-security)
- [G. System, alerts, backup](#g-system-alerts-backup)
- [H. Tests — sab theek hai?](#h-tests--sab-theek-hai)

---

## A. Shuruaat — pehle ye 5 kaam

### A1. Server install
- **Kya:** FreeRADIUS + MariaDB + dashboard ek command mein (Ubuntu 22.04/24.04, Debian 12/13).
- **Kaise:** `curl -fsSL https://raw.githubusercontent.com/MikrotikLover/MikrotikLover/main/radius/get.sh | sudo bash` — ya tayyar **VM image** (Proxmox / VMware / VirtualBox / Hyper-V), install ki zaroorat nahi.
- **Check:** aakhir mein health check khud chalta hai; dashboard `https://SERVER:8443`.
- **Masla:** port 1812/1813 pehle se kisi ke paas → installer batata hai. Update = wohi command dobara (data rehta hai).
- README: [1](../README.md#1-install-ubuntu-22042404-debian-1213), [1c](../README.md#1c-tayyar-vm-image)

### A2. Server ka pakka IP
- **Kya:** routers isi IP par RADIUS bhejte hain — badalna nahi chahiye.
- **CLI:** `radius-admin netip static 192.168.88.10/24 192.168.88.1` · `netip show` · `netip dhcp` (ya router par DHCP reservation).
- **Server IP (routers ki nazar se):** `radius-admin security quarantine-server 192.168.88.10` — quarantine page, social WiFi, "manzoori ka intezar" page isi se chalte hain.

### A3. Router add (NAS)
- **Dashboard:** Routers → Add. **CLI:** `radius-admin nas add 192.168.88.1` (secret khud banta hai).
- **Masla:** router NAT ke peeche aur server internet par → router ki **public IP** add karein, ya behtar WireGuard tunnel IP.
- README: [2](../README.md#2-mikrotik-router-add-karein-nas)

### A4. Router setup — ek line
- **Kya:** jo hisse chahiye tick karein (Hotspot, staff Wi-Fi, Passpoint, PPPoE, MAC devices, blocking, logs, auto-sync, security, SNMP) → dashboard ek line deta hai → router ke Terminal mein paste. RouterOS 6 aur 7 dono (router khud version batata hai).
- **Dashboard:** Router setup. Dobara chalana safe hai (purana hissa update hota hai).
- **Check:** Routers page par router "online", Health check par "has the newest rules".
- README: [7m](../README.md#7m-router-setup--script-dashboard-se-ek-line-terminal-mein), [4](../README.md#4-mikrotik-configuration)

### A5. Auto-sync
- **Kya:** router har 15 minute server se naye rules leta hai (policies, lists, hotspot pages); har minute health report aur jaldi badalne wali cheezein (approve / deny, departments, arzi ijazat).
- **Dashboard:** Router setup → Auto-sync tick (ya Blocking → Router auto-sync → Download script). **CLI:** `radius-admin policy build` (rules foran banana).
- **Masla:** naya feature on karne ke baad router par 15 minute tak purana — `policy build` + router par `/system script run ml-sync`.

---

## B. Login aur users

### B1. Users aur groups
- **Kya:** har user ka apna username / password; group = speed, VLAN, session time, devices ki had, policy.
- **Dashboard:** Users (Add user, password badalna, disable, kick) · Groups & policies.
- **CLI:** `user add ali -g staff` · `user passwd ali` · `user disable ali` · `group add staff --rate 20M/20M --vlan 10 --max-sessions 3`.
- **Check:** `radius-admin test ali` (password) · `radius-admin test ali --peap` (asli Wi-Fi jaisa).
- **Masla:** hotspot login fail magar Wi-Fi theek → user `--nt-hash` se bana hai; hotspot CHAP ke liye bina `--nt-hash` password dein.
- README: [3](../README.md#3-groups-aur-users)

### B2. Staff Wi-Fi (WPA2/WPA3-Enterprise)
- **Kya:** har staff ka apna Wi-Fi password; ek leak ho to sirf usay band karein.
- **Dashboard:** Router setup → "Staff Wi-Fi WPA-Enterprise". Users ke liye connect guide: `https://SERVER:8443/connect`.
- **Phones:** Android: EAP **PEAP**, Phase 2 **MSCHAPV2**, Domain = server ka naam. Asli certificate (G4) ho to Android par CA install nahi.
- **Masla:** Android connect nahi hota → Domain field aur CA certificate check karein.
- README: [5](../README.md#5-devices-kaise-connect-hon)

### B3. Passpoint (Hotspot 2.0) — phone khud join kare
- **Kya:** phone mein ek dafa profile → har office ka Wi-Fi khud, password type kiye baghair (Android 8+, iPhone / Mac).
- **Dashboard:** Settings → **Passpoint** (domain, naam, Wi-Fi naam) · Router setup → **Passpoint** · Users → user → **Passpoint link** (link phone par kholein).
- **CLI:** `passpoint set --domain radius.company.com --name "Company"` · `passpoint router 192.168.88.1 [--legacy]` · `passpoint link ali` · `passpoint profile ali --ios -o ali.mobileconfig`.
- **Check:** `sudo tests/test-passpoint.py --live` (profile ke andar se login).
- **Masla:** domain = RADIUS certificate ka naam rakhein (Android 11 aur purane isi se server check karte hain). Domain badla to naye links bhejein. Link mein password hai — sirf usi user ko.
- README: [5a](../README.md#5a-passpoint-hotspot-20--phone-office-ka-wi-fi-khud-join-kare)

### B4. MAC devices (printer, TV, CCTV, POS)
- **Kya:** jo device password type nahi kar sakta, woh MAC se.
- **Dashboard:** MAC devices → Add device (group, apni policy). **CLI:** `mac add aa:bb:cc:dd:ee:ff -g staff -d "Reception printer" [--policy P]`.
- **Masla:** MAC copy ho sakta hai — devices ke liye alag SSID / VLAN.
- README: [3b](../README.md#3b-mac-authentication-devices-bina-usernamepassword)

### B5. Naye device ki manzoori (approval)
- **Kya:** LAN par har **naya** device (DHCP) ka internet band jab tak admin approve na kare — device par sirf DNS aur "manzoori ka intezar" page. Hotspot networks chhod diye jate hain.
- **Dashboard:** **New devices** — switch Enabled / Disabled, Waiting / Approved / Disabled / Denied, Approve (naam, user), **Disable / Enable** har device, Deny, Forget, "Allow a device".
- **CLI:** `newdev on` (24 ghante learning: aaj ke devices khud approve) · `newdev on --learn 0` · `newdev list pending` · `newdev approve MAC -n "Ali laptop"` · `newdev disable MAC` / `enable MAC` · `newdev strict on` · `newdev off`.
- **Check:** `sudo tests/test-newdev.py --live`; admin ko alert (event `newdev`).
- **Masla:** routers auto-sync par hon (rules agle sync par, approve 1 minute mein). Static-IP device DHCP ke baghair aaye to pakra nahi jata (README: `arp=reply-only`). Phone ka random MAC har Wi-Fi par naya device.
- README: [Naye device ki manzoori](../README.md#naye-device-ki-manzoori--har-naya-device-pehle-approve-ho)

### B6. Device yaad rakho (random MAC)
- **Kya:** ek dafa password se login, phir phone MAC se khud andar (usi user ke taur par).
- **Dashboard:** Hotspot page → Remember devices · Router setup → Hotspot → Remember devices. **CLI:** `remember on` · `remember max 2` · `remember list`.
- README: [Device yaad rakho](../README.md#device-yaad-rakho-random-mac-wale-android--iphone)

### B7. PPPoE (ISP style)
- **Dashboard:** Router setup → PPPoE (customer side port). Plans mein pool / speed / quota.
- **CLI:** `plan add home-10m --rate 10M/10M --quota 200G --pool pppoe-pool` · `user plan ahmed home-10m` · `user ip ahmed 10.20.0.50`.
- README: [5f](../README.md#5f-pppoe-users-isp-style)

### B8. IP binding — har user ka pakka IP
- **Dashboard:** IP binding. **CLI:** `ipbind auto on` · `ipbind set ali 192.168.88.50` · `ipbind days 7`.
- README: [7n](../README.md#7n-ip-binding--har-user-ka-apna-pakka-ip)

### B9. Asli certificate (Let's Encrypt) + captive portal
- **Kya:** phones par certificate install nahi, dashboard "Not secure" nahi; hotspot login page phone khud khole.
- **Dashboard:** Settings → Certificate for phones. **CLI:** `cert letsencrypt wifi.company.com --email E --http|--cloudflare` · `cert status` · `captive on`.
- README: [4b](../README.md#4b-asli-certificate-lets-encrypt--kisi-phone-par-certificate-install-nahi)

---

## C. Hotspot business (plans, vouchers, guests)

### C1. Plans, vouchers, sales
- **Kya:** paisay wale packages: muddat, data quota, roz ka waqt, FUP speed; voucher cards; bikri ka hisaab.
- **Dashboard:** Plans · Vouchers (print) · Sales. **CLI:** `plan add …` · `voucher …` · `sales`.
- README: [5d](../README.md#5d-hotspot-business--plans-vouchers-expiry-data-quota)

### C2. Hotspot login page
- **Dashboard:** Hotspot page (logo, rang, notice, footer; preview). **CLI:** `hotspot set title "Mera Cafe"` · `hotspot push on` (routers par khud).

### C3. Social WiFi (phone number + code)
- **Dashboard:** Social WiFi. **CLI:** `social on` · `social set minutes 60` · `social set mb 500`. Server IP (A2) zaroori.
- README: [7l](../README.md#7l-social-wifi-cafe--phone-number-se-free-wifi)

### C4. Speed schedule
- **Kya:** raat ko zyada speed, rush hours mein kam; chalti sessions bhi badalti hain.
- **Dashboard:** Speed schedule. **CLI:** `speed add night --rate 20M/20M --time 22:00-08:00`.
- README: [7f](../README.md#7f-speed-schedule--raat-ko-zyada-speed-rush-hours-mein-kam)

### C5. Pehle se khabardari (expiry / data warning)
- **Dashboard:** Settings → Warn users. **CLI:** `notice set days 2` · SMS: `notice gateway 'https://…{phone}…{text}'`.
- README: [7g](../README.md#7g-pehle-se-khabardari--package--data-khatam-hone-se-pehle-user-ko-batana)

---

## D. Blocking aur policies

### D1. Policy kya hai, kis par lagti hai
- **Policy** = kya band / khula (categories, apps, sites, lafz, VPN, waqt, DNS). Router par block **IP** se hota hai; IP list mein aata hai:
  - **username** se (login par), **MAC** se (MAC devices, Wi-Fi), ya **IP / range / network** se (login ke baghair).
- **Tarteeb:** user ki apni policy > group / plan ki policy; quarantine sab se upar; network policy saath mein lagti hai.
- README: [Login ke 4 tareeqe](../README.md#login-ke-4-tareeqe--har-ek-par-policy-kahan-se-aati-hai), [Policies](../README.md#policies--single-user--group--ip-range-blocking--webfilter-policiesrsc)

### D2. Policy banana / badalna
- **Dashboard:** Blocking → Policies → New policy (editor: categories, apps, websites, lafz, VPN, har rule ka apna waqt) · switch On / Off · Guide tab har policy ko lafzon mein batata hai.
- **CLI:** `policy list` · `policy set NAME < file` · `policy off NAME` / `on NAME`.
- **Rules:** `block social` · `block-app TikTok` · `block-site x.com` · `block-word casino` · `allow-site linkedin.com` · `allow-app WhatsApp` · `allow-only whatsapp` · `block-all time=22h-6h` · `dns family` (poori fehrist: `webfilter/policies/README.txt`). Allow hamesha block se upar.

### D3. Policy dena — users ko
- **Ek user:** Users list → user ki policy par click → tick → Save (ya user ke page par "Change…").
- **Kai users:** Users list mein tick (ya search + select all) → "Give policy…" · ya Blocking → Give a policy → Users (search + tick).
- **CLI:** `user policy ali students` · `policy give students ali sara ahmed` · `policy give - ali` (wapas group wali).
- **Online user** ek dafa disconnect hota hai aur agle login par nayi policy.

### D4. Ek user ko kai policies
- **Kya:** students + no-video ek saath. Server inhein jod kar ek policy (`mix-…`) banata hai: har policy ke saare block, kisi bhi policy ki exception, sab se sakht DNS.
- **Dashboard:** policy picker mein kai tick. **CLI:** `user policy ali students,no-video` · `policy give students,no-video ali sara` · `policy mixes`.
- **Masla:** naya jod routers ko agle auto-sync (15 min) par. Group ko ek hi policy.

### D5. Network / IP range / ek PC ko policy (login ke baghair)
- **Dashboard:** Blocking → Give a policy → **Network / IP** (kai policies tick ho sakti hain — har ek lagti hai).
- **CLI:** `policy net add students,no-video 192.168.88.0/24 "Office LAN"` · `policy net list` · `policy net del ID`.
- **Masla:** DHCP IP badal sakta hai — pakka IP (B8) ya user / MAC policy behtar.

### D6. Groups, MAC devices, vouchers ki policy
- Group: Groups → policy (`group add G --policy P`). MAC device: MAC devices → Policy. Voucher / guest: Plans → plan ki policy (`plan set PLAN --policy guests`).

### D7. Sirf kuch apps (WhatsApp-only, Hik-Connect)
- **Dashboard:** policy editor → "ONLY the apps I choose" · Blocking → App profiles (apni profile, app seekhna).
- **CLI:** `allowonly list` · `allowonly learn IP 15`.
- README: [7t](../README.md#7t-sirf-kuch-apps-maslan-whatsapp--hik-connect)

### D8. Website / app ka sirf naam — baqi khud
- **Kya:** `allow-web example.com` — server site parh kar us ke fonts / CDN / images khud khol deta hai.
- **Dashboard:** Blocking → Allowed websites & apps. **CLI:** `webscan list` · `webscan deep SITE`.

### D9. VPN rokna + VPN watch
- **Policy:** `block-vpn` (apps, VPN servers, protocols). **Dashboard:** VPN & proxy watch (kaun VPN chalane ki koshish kar raha hai). **CLI:** `vpn …`.
- README: [VPN watch](../README.md#vpn-watch--vpn-server-list-khud-banti-hai-aur-pata-chalta-hai-kaun-vpn-chalane-ki-koshish-kar-raha-hai)

### D10. Windows Update on / office hours mein band / band
- **Dashboard:** Blocking → Overview → Windows Update. **CLI:** `winupdate off|office|on`.

### D11. Parental controls
- **Dashboard:** Blocking → Parental controls. **CLI:** `user policy bacha1 parental-kids`.

### D12. Unblock darkhwast, arzi ijazat, block page
- **Kya:** user block page se "khol dein" maange → admin 1 ghanta / aaj / hamesha de.
- **Dashboard:** Blocking → Requests · Why blocked? → Block page. **CLI:** `unblock list` · `unblock approve ID 1h` · `blockpage on`.
- README: [7r](../README.md#7r-ek-site-band--khuli-policy-ke-andar-aur-unblock-ki-darkhwast), [7q](../README.md#7q-block-page-safe--user-ko-logo-wajah-aur-code)

### D13. Site kyun band hai?
- **Dashboard:** Blocking → Why blocked? **CLI:** `why facebook.com ali` — kaun si list / rule, abhi active hai ya nahi.

### D14. Sab blocking ek dam rokna (masla ho to)
- **Dashboard:** Setup steps → "If something goes wrong" / banner. **CLI:** `policy pause` · `policy resume`.

---

## E. Network ko dekhna (monitoring)

| Feature | Dashboard | CLI | Router par chahiye |
|---|---|---|---|
| Dashboard (online, data, logins) | Dashboard | `online` | — |
| Online abhi | Online now | `online` · `kick ali` | `/radius incoming accept=yes` |
| Live log (sites + blocks) | Live log | `live [-u ali]` | DNS logger (`dnslog on ROUTER_IP` + dns-logging) |
| Kaun si sites khulin | Reports | `sites -u ali` · `history -u ali` | DNS logger |
| Blocked koshishen | Reports / Blocking → Activity | `blocked` | webfilter-logging |
| Data usage (site / IP / user) | Data usage | `traffic --by user` · `traffic now` | traffic-flow + `traffic collector on` |
| Traffic graphs | Traffic graphs | — (khud) | auto-sync |
| Departments (shared speed) | Departments | `dept add sales 10M 5M` · `dept member sales user ali` | auto-sync |
| Apps on network | Apps on network | `apps update` | DNS logger |
| Ports & protocols | Ports & protocols | — | traffic-flow |
| CDN detective (ye kis app ka server?) | CDN detective | `cdn …` | DNS logger |
| Website names | Website names | — | DNS logger |
| Insights / reports | Insights | `insights report` | — |
| Har mahine security report (PDF) | Security → Reports | `security report` | — |
| Devices (SNMP): switch, UPS, printer | Devices (SNMP) | `snmp add IP community public` · `snmp find 192.168.88.0/24` | SNMP (Router setup) |
| Network map | Network map | `snmp dept ID DEPT` | switches SNMP mein |
| Router health | Routers | — | auto-sync |

- **Masla:** report khali → router par us ka hissa nahi (Router setup), ya server ka collector band (`doctor` batata hai).
- README: [Visited sites](../README.md#visited-sites-report-aur-live-log), [Data usage](../README.md#data-usage--kis-website--kis-ip--kis-user-ne-kitna-download-upload-kiya), [7o](../README.md#7o-traffic-graphs-aur-departments-shared-speed), [7h5](../README.md#7h5-devices-snmp--switch-ups-printer-server-camera-mikrotik)

---

## F. Security

| Feature | Kya | Dashboard | CLI |
|---|---|---|---|
| Security detective | virus, hacker attack, DDoS — type ke saath | Security | `security list` · `security scan` |
| Quarantine | infected device ka internet band, sirf warning page | Security → Protection | `security quarantine IP\|USER` · `security release …` · `security quarantine-auto on` |
| Attackers khud block | bahar ke hamla karne wale IP routers par band | Security → Protection | `security autoblock on` |
| Malware DNS block | threat domains ka jawab 0.0.0.0 | Security → Protection | `security dns-block on` |
| Ransomware detective | PC par nishaniyan, risk 0–100, cut off | Security → Ransomware | `security ransomware` · `security ransomware-auto on` |
| IPS (Suricata) | hamle pehchan kar IP band; ~1 sec MikroTik API se | Security → Intrusion prevention | `ips install` · `ips on` · `ips api add 192.168.88.1` · `ips inline on eth1 eth2` |
| Firewall (FortiGate jaisa) | policies, objects, schedules, hits | Firewall | `firewall list` · `firewall rule add …` · `firewall lookup …` |
| Port forward (sirf kuch IPs / mulk) | | Firewall → Port forwards | `firewall vip add DVR 37777 192.168.88.20 --src office,geo:PK` |
| Mulk band (Geo-IP) | | Firewall → Countries | `firewall geo update` |
| Bahar se kya andar aa raha hai | khule darwaze, UPnP, kis ne kya chhua | Security → From outside | — |
| Nakli router / ARP spoofing | rogue DHCP, ARP | Security → Hacker attacks | router par lan-guard (Router setup) |
| Mail server ki hifazat | MDaemon / Exchange: safe ports, password guessing, spam bots | Mail server | `mail set ip … domain …` · `mail status` |

- **Masla:** quarantine / waiting page nahi khulta → server IP set karein (A2). IPS ke liye server par 4 GB+ RAM behtar.
- README: [5k](../README.md#5k-security-detective--virus-hacker-attack-ddos-type-ke-saath), [7h0](../README.md#7h0-firewall-fortigate--untangle-jaisa--policies-objects-port-forwards-countries), [7h1](../README.md#7h1-intrusion-prevention-ips--suricata-fortinet-jaisa)

---

## G. System, alerts, backup

| Feature | Dashboard | CLI | Note |
|---|---|---|---|
| **Health check** | Health check (Your to-do, Copy report) | `doctor` | har ghante khud; kharabi par alert |
| Alerts (Telegram / WhatsApp / Email) | Settings → Alerts | `alerts telegram TOKEN` · `alerts whatsapp 9230… KEY` · `alerts test` | events: security, router, newdev, requests, … |
| Phone app + notifications (PWA) | Settings → Phone app & notifications | `push list\|test` | dashboard "Install app" |
| Network se poochho (AI) | Ask (AI) — Claude / Gemini / Ollama | `ai status` · `echo KEY \| radius-admin ai key` | sirf parhta hai, kuch badalta nahi |
| Backup + restore | Settings → Backups | `backup` · `backups` · `restore FILE` | har raat khud |
| Off-site copy | Settings → Off-site copy | `backup offsite ssh user@host:/dir` · `rclone gdrive:ml` | encrypted |
| Doosra RADIUS server (backup) | Settings → Backup RADIUS server | `ha start BACKUP-IP` · `ha join FILE` · `ha status` | database dono taraf copy |
| Automatic updates | Settings → Automatic updates | `update` · `hourly` | har hafte khud |
| Dashboard accounts (admin / viewer) | Settings → Dashboard accounts | `web passwd NAME` · `web role NAME viewer` | viewer sirf dekhta hai |
| Audit log | Settings → Audit log | — | har dashboard tabdeeli |

---

## H. Tests — sab theek hai?

| Kya | Command |
|---|---|
| Server ka haal | `sudo radius-admin doctor` |
| Ek user ka login | `sudo radius-admin test ali` · `--peap` |
| **Saare tests ek saath** (summary aakhir mein) | `sudo tests/run-all.sh` · server ke baghair: `tests/run-all.sh --quick` · browser tests ke saath: `URL=https://127.0.0.1:8443 USER=admin PASS=… sudo tests/run-all.sh` |
| Router scripts asli RouterOS par (CHR, QEMU) | `tests/test-chr.sh --ros 7` · `--ros 6` |
| Router scripts ki likhai | `python3 tests/lint-rsc.py` |

Har test ka nateeja aur mile hue bugs: [docs/TEST-LOG.md](TEST-LOG.md).
