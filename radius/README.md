# MikrotikLover RADIUS Server — Wireless User Authentication

FreeRADIUS 3.2 + MariaDB par bana hua RADIUS server, MikroTik Wi-Fi ke liye:

- **WPA2/WPA3-Enterprise** — har user ka apna username/password (PEAP-MSCHAPv2 / EAP-TTLS). Ek password leak ho to sirf us user ko band karein, poore office ka Wi-Fi password badalne ki zaroorat nahi.
- **Hotspot (captive portal)** login bhi isi user database se.
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

## 4. MikroTik configuration

`mikrotik/` folder mein ready scripts hain. File mein `RADIUS_SERVER_IP`, `RADIUS_SECRET` aur SSID replace karein, Winbox → Files mein upload karein, phir Terminal mein `/import file-name=...`.

| Script | Kis ke liye |
|---|---|
| `wpa-enterprise-wifi-ros7.rsc` | RouterOS 7 **wifi** package (hAP ax², ax³, cAP ax, …) |
| `wpa-enterprise-wireless-legacy.rsc` | Purana **wireless** package (RouterOS 6, hAP ac lite, cAP ac, SXT, …) |
| `hotspot.rsc` | Hotspot captive portal login |

Wi-Fi aur hotspot dono ek router par hain to ek hi entry kafi hai: `/radius add address=... secret=... service=wireless,hotspot`.

**VLAN per group**: bridge par `vlan-filtering=yes` aur VLANs configured honi chahiye. Legacy wireless par `vlan-mode=use-tag` bhi lagayein.

## 5. Devices kaise connect hon

| Device | Setting |
|---|---|
| Windows 10/11 | SSID select → username/password → "Connect" (certificate prompt par Connect) |
| Android 11+ | EAP: **PEAP**, Phase 2: **MSCHAPV2**, CA certificate: `ca.der` install karke select karein *ya* "Trust on first use" (Android 13+), Domain: `RADIUS_DOMAIN`, Identity: username |
| iPhone / macOS | username/password → certificate par **Trust** |

CA file: `/etc/freeradius/3.0/certs/mikrotiklover/ca.der` (Android/Windows) ya `ca.pem`. Android par: Settings → Security → Encryption & credentials → Install a certificate → Wi-Fi certificate.

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
