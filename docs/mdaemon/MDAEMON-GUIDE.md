# MDaemon Mail Server — Complete Guide (Installation + Secure Configuration)

> Yeh guide MDaemon Email Server (v23 / v24 / v25) ke liye hai, Windows Server par.
> Menu ke naam version ke hisaab se thode alag ho sakte hain, lekin flow same rehta hai.
> Example domain: `example.com`, mail host: `mail.example.com`, public IP: `203.0.113.10`.
> Inhe apni details se replace karein.

---

## Table of Contents

1. [Planning aur Requirements](#1-planning-aur-requirements)
2. [DNS Records (sabse zaroori)](#2-dns-records-sabse-zaroori)
3. [Windows Server Preparation](#3-windows-server-preparation)
4. [MDaemon Installation](#4-mdaemon-installation)
5. [Basic Configuration](#5-basic-configuration)
6. [Ports, Firewall aur MikroTik Port Forwarding](#6-ports-firewall-aur-mikrotik-port-forwarding)
7. [SSL/TLS Certificate (Let's Encrypt)](#7-ssltls-certificate-lets-encrypt)
8. [Authentication aur Relay Security](#8-authentication-aur-relay-security)
9. [SPF, DKIM, DMARC](#9-spf-dkim-dmarc)
10. [Brute-force Protection (Dynamic Screening)](#10-brute-force-protection-dynamic-screening)
11. [Spam Filter, DNSBL, Greylisting](#11-spam-filter-dnsbl-greylisting)
12. [AntiVirus aur Attachment Filtering](#12-antivirus-aur-attachment-filtering)
13. [Webmail (Webmail/WorldClient) aur Remote Admin Security](#13-webmail-aur-remote-admin-security)
14. [Accounts, Password Policy aur 2FA](#14-accounts-password-policy-aur-2fa)
15. [Client Setup (Outlook / Mobile)](#15-client-setup-outlook--mobile)
16. [Backup aur Restore](#16-backup-aur-restore)
17. [Monitoring aur Logs](#17-monitoring-aur-logs)
18. [Testing Checklist](#18-testing-checklist)
19. [Troubleshooting](#19-troubleshooting)
20. [Final Security Checklist](#20-final-security-checklist)

---

## 1. Planning aur Requirements

### Hardware (approx.)

| Users     | CPU      | RAM    | Disk (SSD)  |
|-----------|----------|--------|-------------|
| 1–50      | 2 core   | 4 GB   | 100 GB+     |
| 50–250    | 4 core   | 8 GB   | 250 GB+     |
| 250–1000  | 8 core   | 16 GB  | 500 GB+     |

Mail store ke liye alag drive (jaise `D:\`) rakhna best hai.

### Software

- Windows Server 2019 / 2022 / 2025 (64-bit) — Windows 10/11 bhi chalega chhote setup ke liye.
- Latest Windows Updates.
- .NET Framework (installer khud check karta hai).
- MDaemon installer: `https://mdaemon.com` → Downloads.
- License key (trial 30 din ka milta hai).

### Network

- **Static public IP** (dynamic IP se mail deliver nahi hoga, blacklist ho jayega).
- **ISP se PTR (reverse DNS)** set karwana zaroori hai: `203.0.113.10 → mail.example.com`.
- ISP outbound **port 25 block** to nahi kar raha, yeh confirm karein.
- Server ka private IP static rakhein, jaise `192.168.88.10`.

---

## 2. DNS Records (sabse zaroori)

Domain registrar / DNS panel me yeh records banayein:

| Type  | Name                    | Value                                              |
|-------|-------------------------|----------------------------------------------------|
| A     | `mail`                  | `203.0.113.10`                                     |
| MX    | `@`                     | `mail.example.com` (priority 10)                   |
| TXT   | `@`                     | `v=spf1 mx a:mail.example.com -all`                |
| TXT   | `mdaemon._domainkey`    | DKIM public key (Section 9 me generate hoga)       |
| TXT   | `_dmarc`                | `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com; adkim=s; aspf=s` |
| CNAME | `autodiscover`          | `mail.example.com`                                 |
| CNAME | `autoconfig`            | `mail.example.com`                                 |
| SRV   | `_submission._tcp`      | `0 1 587 mail.example.com`                         |
| SRV   | `_imaps._tcp`           | `0 1 993 mail.example.com`                         |
| PTR   | (ISP karega)            | `203.0.113.10 → mail.example.com`                  |

Optional (advanced):

| Type  | Name               | Value                                    |
|-------|--------------------|------------------------------------------|
| TXT   | `_mta-sts`         | `v=STSv1; id=20261023`                   |
| TXT   | `_smtp._tls`       | `v=TLSRPTv1; rua=mailto:tls@example.com` |
| CAA   | `@`                | `0 issue "letsencrypt.org"`              |

Check karne ke liye:

```cmd
nslookup -type=mx example.com
nslookup -type=txt example.com
nslookup 203.0.113.10
```

> **Tip:** SPF me shuru me `~all` rakh sakte hain testing ke liye, sab theek ho jaye to `-all` karein.
> DMARC `p=none` se start karke 2–4 hafte baad `quarantine` / `reject` par jaayein.

---

## 3. Windows Server Preparation

1. **Hostname** set karein: `MAIL01`, aur restart.
2. **Static IP** + DNS server set karein (Control Panel → Network Adapter → IPv4).
3. Windows Update chalayein, phir restart.
4. Time sahi rakhein (TLS aur 2FA ke liye zaroori):
   ```cmd
   w32tm /config /manualpeerlist:"pool.ntp.org" /syncfromflags:manual /update
   w32tm /resync
   ```
5. Unnecessary services/roles band karein (IIS agar zaroorat nahi hai to install na karein — port 80/443 conflict hota hai).
6. Ek **strong local admin password** rakhein, RDP ko public internet par expose na karein (VPN use karein — MikroTik WireGuard/L2TP).
7. Agar server par koi aur SMTP service (IIS SMTP, hMailServer, etc.) chal rahi hai to use hata dein — port 25 conflict hoga:
   ```cmd
   netstat -ano | findstr ":25 :110 :143 :587 :993 :995 :3000 :1000"
   ```

---

## 4. MDaemon Installation

1. Installer (`md25xx_x64.exe`) ko **Run as Administrator** karein.
2. License agreement accept karein.
3. **Install folder**: default `C:\MDaemon\` (ya mail data ke liye `D:\MDaemon\`).
4. **Registration**: Name, Company aur License key daalein (ya trial chunein).
5. **Domain name**: `example.com` daalein.
   - Yeh "Default Domain" banega. Baad me multiple domains add kar sakte hain.
6. **First account (Admin)**:
   - Full name: `Postmaster`
   - Mailbox: `admin` → `admin@example.com`
   - **Strong password** (16+ characters, mixed).
   - "This account is a global administrator" ✔️
7. **DNS Setup**: "Use Windows DNS settings" ya Google/Cloudflare (`1.1.1.1`, `8.8.8.8`) daalein.
8. **Operating mode**: **Normal** chunein (jab tak aap specifically "Simple" na chahte hon).
9. **Run MDaemon as a Windows Service** ✔️ (zaroori hai, taaki bina login ke chale).
10. Finish → MDaemon start ho jayega, system tray me icon dikhega.

Install ke baad check karein:

```cmd
sc query MDaemon
```

Status `RUNNING` hona chahiye.

---

## 5. Basic Configuration

MDaemon console kholein (ya browser me Remote Admin: `http://SERVER-IP:1000`).

### 5.1 Domain settings

`Setup → Domain Manager → example.com`

- **Host Name & IP**:
  - SMTP host name: `mail.example.com` (yahi naam PTR aur certificate me hona chahiye).
  - IP: server ka private IP (`192.168.88.10`) ya "bind to all".
- **Smart Hosts**: blank chhodein (direct delivery), jab tak ISP relay zaroori na ho.
- **Accounts**: default mailbox quota set karein (jaise 5 GB).

### 5.2 Server settings

`Setup → Server Settings`

- **Servers & Delivery → Servers**:
  - Max message size: `50 MB` (ya zaroorat ke hisaab se).
  - "Use SMTP ESMTP SIZE command" ✔️
- **Delivery**: "Send all outbound email directly to the recipient's mail server" ✔️
- **Ports**: Section 6 dekhein.
- **DNS & IPs → DNS**: reliable DNS server daalein. Local caching resolver best hai (DNSBL queries ke liye — public resolvers jaise 8.8.8.8 se Spamhaus queries block hoti hain).
- **Timeouts**: defaults theek hain.

### 5.3 Multiple domains

`Setup → Domain Manager → New domain` → `example2.com`
Har domain ke liye alag DNS records (MX, SPF, DKIM, DMARC) banayein.

### 5.4 Users banana

`Accounts → Account Manager → New`

- Mailbox, full name, password.
- **Account Details → Web Services**: Webmail access ✔️, Remote Admin ✘ (normal users ke liye).
- **Quotas**: size limit.
- Bulk import: `Accounts → Importing → Import accounts from a comma delimited text file`.

---

## 6. Ports, Firewall aur MikroTik Port Forwarding

### 6.1 MDaemon ports

`Setup → Server Settings → Ports`

| Service             | Port | Expose to Internet? | Note                                  |
|---------------------|------|---------------------|---------------------------------------|
| SMTP (inbound)      | 25   | ✅ Haan             | Doosre servers se mail aane ke liye   |
| SMTP Submission     | 587  | ✅ Haan             | Clients (STARTTLS + Auth)             |
| SMTPS (implicit TLS)| 465  | ✅ Haan             | Clients (SSL)                         |
| POP3                | 110  | ❌ Nahi             | Plain text — band rakhein             |
| POP3S               | 995  | ✅ (agar POP chahiye)|                                      |
| IMAP                | 143  | ❌ Nahi             | Plain text — band rakhein             |
| IMAPS               | 993  | ✅ Haan             |                                       |
| Webmail HTTP        | 3000 (default) / 80 | ⚠️ Sirf redirect ke liye | Let's Encrypt validation ke liye 80 chahiye |
| Webmail HTTPS       | 443  | ✅ Haan             |                                       |
| Remote Admin        | 1000 | ❌ **Kabhi nahi**   | Sirf LAN/VPN se                       |
| Remote Admin HTTPS  | 444  | ❌ Sirf VPN         |                                       |
| ActiveSync          | 443 (Webmail ke saath) | ✅ (agar mobile sync chahiye) |                |

Settings:

- "Dedicated submission port" = `587` ✔️
- "SSL ports" ke andar SMTP `465`, IMAP `993`, POP3 `995` enable karein.

### 6.2 Windows Firewall

PowerShell (Admin):

```powershell
New-NetFirewallRule -DisplayName "MDaemon SMTP"       -Direction Inbound -Protocol TCP -LocalPort 25,465,587 -Action Allow
New-NetFirewallRule -DisplayName "MDaemon IMAPS/POP3S" -Direction Inbound -Protocol TCP -LocalPort 993,995     -Action Allow
New-NetFirewallRule -DisplayName "MDaemon Webmail"    -Direction Inbound -Protocol TCP -LocalPort 80,443      -Action Allow
# Remote Admin sirf LAN se:
New-NetFirewallRule -DisplayName "MDaemon RemoteAdmin LAN" -Direction Inbound -Protocol TCP -LocalPort 1000,444 `
  -RemoteAddress 192.168.88.0/24 -Action Allow
```

### 6.3 MikroTik port forwarding (dst-nat)

Maan lijiye WAN interface `ether1`, public IP `203.0.113.10`, mail server `192.168.88.10`:

```routeros
/ip firewall nat
add chain=dstnat dst-address=203.0.113.10 protocol=tcp dst-port=25,465,587 \
    action=dst-nat to-addresses=192.168.88.10 comment="MDaemon SMTP"
add chain=dstnat dst-address=203.0.113.10 protocol=tcp dst-port=993,995 \
    action=dst-nat to-addresses=192.168.88.10 comment="MDaemon IMAPS/POP3S"
add chain=dstnat dst-address=203.0.113.10 protocol=tcp dst-port=80,443 \
    action=dst-nat to-addresses=192.168.88.10 comment="MDaemon Webmail"

# Outbound mail isi public IP se jaaye (PTR match ke liye zaroori)
add chain=srcnat src-address=192.168.88.10 out-interface=ether1 \
    action=src-nat to-addresses=203.0.113.10 comment="MDaemon outbound" place-before=0

# Hairpin NAT (LAN users mail.example.com public IP se access kar sakein)
add chain=srcnat src-address=192.168.88.0/24 dst-address=192.168.88.10 protocol=tcp \
    dst-port=25,465,587,993,995,80,443 out-interface=bridge action=masquerade comment="Hairpin mail"
```

Firewall filter (forward chain me dst-nat traffic allow karein aur brute-force IPs block karein):

```routeros
/ip firewall filter
add chain=forward connection-state=established,related action=accept
add chain=forward connection-nat-state=dstnat action=accept comment="Allow port-forwards"
add chain=forward src-address-list=mail_blacklist action=drop place-before=0 comment="Blocked attackers"
```

LAN me infected PC se spam rokne ke liye — sirf mail server ko port 25 bahar bhejne do:

```routeros
/ip firewall filter
add chain=forward protocol=tcp dst-port=25 src-address=!192.168.88.10 out-interface=ether1 \
    action=drop comment="Block direct SMTP from LAN clients"
```

> Remote Admin (1000/444) aur RDP (3389) ko **forward mat kijiye**. Remote management ke liye MikroTik VPN (WireGuard) use karein.

---

## 7. SSL/TLS Certificate (Let's Encrypt)

MDaemon me built-in Let's Encrypt support hai (PowerShell script ke through).

### 7.1 Pre-requisites

- `mail.example.com` ka A record public IP par point kare.
- Port **80** internet se Webmail tak pahunche (HTTP-01 validation).
- Webmail HTTP port 80 par chal raha ho: `Setup → Web & IM Services → Webmail → Web Server → Webmail runs using built-in web server`, port `80`.

### 7.2 Enable

`Security → Security Settings → SSL & TLS → Let's Encrypt`

- "Use Let's Encrypt to manage your certificate" ✔️
- Alternate host names: `mail.example.com, autodiscover.example.com`
- Admin email: `admin@example.com`
- "Update every 60 days" ✔️
- **Run Now** → log check karein (`C:\MDaemon\Logs\LetsEncrypt.log`).

### 7.3 Certificate apply karein

`Security → Security Settings → SSL & TLS`

- **MDaemon** tab:
  - "Enable SSL, STARTTLS and STLS" ✔️
  - "Enable the dedicated SSL ports for SMTP, IMAP, POP3 servers" ✔️
  - "Send STARTTLS when sending mail to other servers" (opportunistic TLS) ✔️
  - Certificate: `mail.example.com` (Let's Encrypt wala) select karein.
- **Webmail** tab: SSL enable ✔️, HTTPS port `443`, same certificate.
  - "Redirect HTTP connections to HTTPS" ✔️
- **Remote Administration** tab: SSL enable ✔️, port `444`, same certificate.

### 7.4 TLS hardening

`SSL & TLS → MDaemon / STARTTLS settings`:

- **TLS 1.0 aur TLS 1.1 disable** karein, sirf TLS 1.2 + TLS 1.3 rakhein.
  (Windows level par bhi [IIS Crypto](https://www.nartac.com/Products/IISCrypto) tool se "Best Practices" template apply kar sakte hain → restart.)
- "Require STARTTLS / SSL for authentication" ✔️ (plain-text password kabhi na jaaye).
- **STARTTLS Required List** me un domains ko daalein jinke saath encrypted delivery zaroori hai.
- Optional: **MTA-STS** enable karein (`SSL & TLS → MTA-STS`) aur policy host banayein.

---

## 8. Authentication aur Relay Security

**Open relay = turant blacklist.** Isliye yeh section sabse critical hai.

### 8.1 Relay Control

`Security → Security Settings → Sender Authentication / Relay Control → Relay Control`

- "Do not allow message relay" ✔️
- "SMTP MAIL address must exist if it uses a local domain" ✔️
- "SMTP RCPT address must exist if it uses a local domain" ✔️
- "Trusted hosts/IPs can relay" → sirf `127.0.0.1` (LAN ko blindly trust **na karein**; LAN users bhi authenticate karein).

### 8.2 SMTP Authentication

`Security → Security Settings → Sender Authentication → SMTP Authentication`

- "Authentication is always required when mail is from local accounts" ✔️
- "Credentials used must match those of the email sender's address" ✔️ (spoofing rokta hai)
- "Don't allow authentication on the SMTP port (25)" ✔️ (brute-force sirf 587/465 par limited)
- "Global AUTH password" — use na karein.

### 8.3 IP Shield

`Security → Security Settings → Sender Authentication → IP Shield`

- Enable ✔️ — local domain ka mail sirf allowed IPs/authenticated sessions se accept ho.
- Default entries hata kar sirf apne LAN range rakhein.

### 8.4 Reverse Lookup aur Screening

`Security → Security Settings → Screening`

- **Reverse Lookup**: "Perform reverse lookup on PTR record of incoming SMTP connections" ✔️
  - "Refuse to accept mail if a lookup returns 'domain not found'" — pehle log mode me test karein, phir enable.
- **IP Screen**: country/IP ranges block karna (manual list).
- **Host Screen**: bad HELO hosts block.
- **Location Screening (Geo-blocking)**: un countries ko block karein jahan se aapko mail/login ki zaroorat nahi.
  - Tip: SMTP 25 ke liye sab allow rakhein (business partners), lekin **AUTH / Webmail / IMAP** ke liye block karein.
- **SMTP Screen / Tarpitting**: enable ✔️ — zyada RCPT bhejne wale connections ko slow karta hai.
- **Backscatter Protection (BATV)**: ✔️

---

## 9. SPF, DKIM, DMARC

`Security → Security Settings → Sender Authentication`

### 9.1 SPF Verification (incoming)

- "Enable SPF verification" ✔️
- "...if SPF result is FAIL: Reject the message" ✔️ (ya spam score add karein)
- "Use local address in SMTP envelope" ✔️

### 9.2 DKIM Signing (outgoing)

- **DKIM Signing → "Sign eligible outbound messages using DKIM"** ✔️
- "Create private and public keys" → Selector: `mdaemon`, Key size: **2048**.
- MDaemon ek `dns_readme.txt` file banata hai (`C:\MDaemon\Pem\mdaemon\`) — usme TXT record hota hai:

  ```
  mdaemon._domainkey.example.com  TXT  "v=DKIM1; k=rsa; p=MIIBIjANBgkqh...IDAQAB"
  ```

  Yeh DNS me add karein. 2048-bit key lambi hoti hai; agar DNS panel limit kare to string ko 255-character chunks me split karein.
- Har domain ke liye apna selector/key banayein.
- Har 6–12 mahine key rotate karein (naya selector, jaise `mdaemon2026`).

### 9.3 DKIM Verification (incoming)

- "Enable DKIM verification" ✔️

### 9.4 DMARC

- **DMARC Verification** ✔️ — "Honor p=reject when DMARC produces a FAIL result" ✔️
- **DMARC Reporting**: aggregate reports bhejna enable karein (optional).
- DNS record (Section 2) me pehle `p=none`, phir `quarantine`, phir `reject`.

### 9.5 Test

`https://www.mail-tester.com` par ek mail bhejein — target score **10/10**.
Ya `check-auth@verifier.port25.com` par mail bhejein, reply me SPF/DKIM/DMARC result aayega.

---

## 10. Brute-force Protection (Dynamic Screening)

`Security → Security Manager → Dynamic Screening`

### 10.1 Options

- "Enable Dynamic Screening" ✔️
- Protocols: **SMTP, POP, IMAP, Webmail, ActiveSync, Remote Admin** sab ✔️

### 10.2 Auth Failure Tracking

- "Block IP after **5** failed login attempts within **10** minutes"
- Block duration: **60 minutes**, repeat offender par **1 day / permanent**.
- "Freeze account after **10** failures from different IPs" ✔️ (password-spray se bachav)
- "Send notification to admin when an account is frozen" ✔️

### 10.3 Whitelist

- Apne office ka public IP aur LAN range `Dynamic Allow List` me daalein, taaki galti se khud block na ho.

### 10.4 MikroTik integration (optional)

MikroTik par connection-rate limit lagayein taaki attack server tak pahunchne se pehle hi ruk jaaye:

```routeros
/ip firewall filter
add chain=forward protocol=tcp dst-port=587,465,993,995 connection-state=new \
    dst-address=192.168.88.10 src-address-list=!mail_whitelist \
    action=add-src-to-address-list address-list=mail_stage1 address-list-timeout=1m
add chain=forward protocol=tcp dst-port=587,465,993,995 connection-state=new \
    src-address-list=mail_stage1 connection-limit=20,32 \
    action=add-src-to-address-list address-list=mail_blacklist address-list-timeout=1d
```

---

## 11. Spam Filter, DNSBL, Greylisting

### 11.1 Spam Filter

`Security → Spam Filter → Spam Filter`

- "Enable spam filter" ✔️
- Score **≥ 5.0** = Spam → "Move to Junk folder" (IMAP filter auto-create hota hai).
- Score **≥ 12.0** = Reject (SMTP time par hi).
- "Spam filter updates" daily ✔️
- **Bayesian learning** ✔️ — users ke "Junk" / "Not Junk" folders se auto-learn.

### 11.2 DNS Blocklists (DNSBL)

`Security → Spam Filter → DNS Blocklists`

- Enable ✔️ — add karein:
  - `zen.spamhaus.org` (agar commercial use hai to Spamhaus DQS lena padega)
  - `bl.spamcop.net`
  - `b.barracudacentral.org` (free registration chahiye)
- "Check all IPs in Received headers" ✘ (sirf connecting IP check karein — false positives kam).
- **Zaroori:** Public DNS (8.8.8.8 / 1.1.1.1) se DNSBL queries kaam nahi karti. Server par local DNS resolver use karein.

### 11.3 Greylisting

`Security → Spam Filter → Greylisting`

- Enable ✔️, delay **5–10 minutes**.
- "Don't greylist authenticated sessions / trusted IPs / allow-listed senders" ✔️
- Note: Pehli baar naye sender ka mail thoda late aayega — users ko batayein.

### 11.4 Outbreak Protection (agar license me hai)

`Security → Outbreak Protection` → Enable ✔️ — zero-hour spam/virus/phishing detection.

### 11.5 Allow / Block lists

`Security → Spam Filter → Allow List / Block List`
Partners ke domains allow-list me, known spammers block-list me.

---

## 12. AntiVirus aur Attachment Filtering

### 12.1 MDaemon AntiVirus (add-on)

`Security → AntiVirus`

- Enable ✔️ (ClamAV + Ikarus dual engine).
- Updates: har 1 ghante ✔️
- Infected mail → **Quarantine** (delete nahi, taaki false positive recover ho sake).
- "Notify admin" ✔️

### 12.2 Attachment Filtering

`Security → Content Filter → Attachments`

Block karein:

```
*.exe *.com *.bat *.cmd *.scr *.pif *.vbs *.vbe *.js *.jse *.wsf *.wsh
*.hta *.msi *.ps1 *.jar *.lnk *.iso *.img *.cpl *.reg *.docm *.xlsm
```

- "Block password-protected/encrypted ZIP" — malware aksar isi tareeqe se aata hai (business need dekh kar).
- Macro-enabled Office files ko quarantine karein.

### 12.3 Content Filter rules

`Security → Content Filter → Rules`
Examples:
- Subject me `[EXTERNAL]` tag lagayein jab sender bahar ka ho aur display name internal user jaisa ho (CEO fraud se bachav).
- Outbound mail me credit-card/Aadhaar patterns par admin ko alert (DLP).

---

## 13. Webmail aur Remote Admin Security

### 13.1 Webmail

`Setup → Web & IM Services → Webmail`

- HTTPS only (Section 7), HTTP → HTTPS redirect ✔️
- Session timeout: **20 minutes** idle.
- "Use CAPTCHA after failed logins" ✔️ (agar available ho).
- **Two-Factor Authentication**: `Webmail → Settings → "Enable Two-Factor Authentication"` ✔️, aur admins ke liye **"Require 2FA"** ✔️
- "Allow users to save password" ✘

### 13.2 Remote Administration

`Setup → Web & IM Services → Remote Administration`

- **Sirf HTTPS (port 444)**.
- **Bind only to LAN IP** (`192.168.88.10`), public par kabhi expose na karein.
- 2FA required for admins ✔️
- Normal accounts ka Remote Admin access band.

### 13.3 ActiveSync

`Setup → Mobile Device Management → ActiveSync`

- Enable sirf agar mobile sync chahiye.
- **Device Policies**: device PIN required ✔️, remote wipe allowed ✔️
- "New devices require admin approval" ✔️ (optional, high security).

### 13.4 Autodiscover

ActiveSync / Outlook autodiscover HTTPS port 443 par Webmail ke saath kaam karta hai — DNS me `autodiscover` CNAME aur certificate me naam hona chahiye.

---

## 14. Accounts, Password Policy aur 2FA

`Accounts → Account Settings → Passwords`

- Minimum length: **12**
- "Require strong passwords" ✔️ (upper, lower, number, symbol)
- "Password can't contain mailbox / name" ✔️
- "Check passwords against known compromised list" ✔️ (MDaemon 21+ me available)
- Password expiry: modern recommendation hai bina reason expire na karein; compromise par turant reset.
- "Store mailbox passwords using non-reversible encryption" ✔️ (iske baad CRAM-MD5/APOP kaam nahi karenge — jo theek hai kyunki TLS use ho raha hai).

Aur:

- **Inactive accounts** auto-disable: `Account Settings → Account Pruning` → 90 din.
- `postmaster`, `abuse` aliases zaroor rakhein (RFC requirement).
- Admin account ko daily use ke liye na rakhein — alag normal account banayein.
- **App Passwords** (MDaemon 22+): 2FA enable users ke liye Outlook/IMAP clients me app password use karein.

---

## 15. Client Setup (Outlook / Mobile)

| Setting        | Value                     |
|----------------|---------------------------|
| Incoming (IMAP)| `mail.example.com`, port **993**, SSL/TLS |
| Incoming (POP3)| `mail.example.com`, port **995**, SSL/TLS |
| Outgoing (SMTP)| `mail.example.com`, port **587** STARTTLS (ya **465** SSL/TLS) |
| Username       | Poora email: `user@example.com` |
| Auth           | Outgoing server requires authentication ✔️ (same as incoming) |
| Webmail        | `https://mail.example.com` |

Outlook me "Exchange ActiveSync" option se bhi add kar sakte hain (mail + calendar + contacts sync).
MDaemon ka **MDaemon Connector** (add-on) Outlook ke saath shared calendars/contacts deta hai.

---

## 16. Backup aur Restore

### 16.1 Kya backup karna hai

| Path                         | Content                          |
|------------------------------|----------------------------------|
| `C:\MDaemon\App\`            | Saari configuration (`.ini`, `.dat`) |
| `C:\MDaemon\Users\`          | Mailboxes (sabse bada folder)    |
| `C:\MDaemon\Pem\`            | DKIM keys / certificates         |
| `C:\MDaemon\PublicFolders\`  | Public / shared folders          |
| `C:\MDaemon\WorldClient\`    | Webmail data, calendars          |
| `C:\MDaemon\Lists\`          | Mailing lists                    |

### 16.2 Built-in backup

`Setup → Preferences → Backup` — config files ka daily backup ✔️

### 16.3 Full backup script (Robocopy + scheduled task)

`C:\Scripts\mdaemon-backup.cmd`:

```cmd
@echo off
set DEST=E:\Backup\MDaemon\%date:~-4%-%date:~3,2%-%date:~0,2%
robocopy "C:\MDaemon" "%DEST%" /MIR /R:2 /W:5 /XD "C:\MDaemon\Logs" /LOG:"E:\Backup\MDaemon\last.log"
REM 14 din se purane backup delete
forfiles /p "E:\Backup\MDaemon" /d -14 /c "cmd /c if @isdir==TRUE rd /s /q @path" 2>nul
```

Task Scheduler me raat 2 baje daily run karein (SYSTEM account se).

> **3-2-1 rule**: 3 copies, 2 alag media, 1 offsite (cloud/NAS jo network se disconnected ho — ransomware se bachav).

### 16.4 Restore

1. MDaemon service stop karein: `net stop MDaemon`
2. Backup se folders copy karein.
3. `net start MDaemon`
4. Account Manager me check karein.

Har 3 mahine me **restore test** zaroor karein.

---

## 17. Monitoring aur Logs

- Logs: `C:\MDaemon\Logs\`
  - `MDaemon-SMTP-(in).log`, `MDaemon-SMTP-(out).log`, `MDaemon-IMAP.log`, `MDaemon-Screening.log`, `MDaemon-WorldClient.log`
- `Setup → Preferences → Logging`: "Log detailed" ✔️, 30–90 din retain.
- **Daily reports**: `Setup → Preferences → Reports` → admin ko daily status/statistics email.
- **Disk space alerts**: `Setup → Preferences → Disk` → low disk par alert + mail accept band.
- **Queue monitor**: Main UI → Queues. Remote queue me bahut saare mails ruke hon to delivery/blacklist issue hai.
- **Blacklist check** weekly: `https://mxtoolbox.com/blacklists.aspx` par `203.0.113.10`.
- Google Postmaster Tools aur Microsoft SNDS par apna domain/IP register karein — reputation dikhta hai.
- MDaemon ko regular update karein: `Help → Check for updates` (security patches ke liye zaroori).

---

## 18. Testing Checklist

```cmd
:: SMTP banner check (bahar ke network se)
telnet mail.example.com 25
:: Expect: 220 mail.example.com ESMTP MDaemon ...
EHLO test.com
:: STARTTLS aur SIZE dikhna chahiye; AUTH port 25 par nahi dikhna chahiye
QUIT
```

TLS check (OpenSSL):

```bash
openssl s_client -connect mail.example.com:587 -starttls smtp
openssl s_client -connect mail.example.com:993
openssl s_client -connect mail.example.com:465 -tls1_1   # fail hona chahiye
```

Online tests:

| Test                      | Tool                                            |
|---------------------------|-------------------------------------------------|
| Open relay                | `https://mxtoolbox.com/diagnostic.aspx`         |
| SPF/DKIM/DMARC/score      | `https://www.mail-tester.com`                   |
| TLS config                | `https://www.checktls.com`                      |
| Webmail SSL grade         | `https://www.ssllabs.com/ssltest/` (A ya A+)    |
| Blacklist                 | `https://mxtoolbox.com/blacklists.aspx`         |
| Microsoft connectivity    | `https://testconnectivity.microsoft.com`        |

Functional:

- [ ] Gmail → `user@example.com` mail aata hai
- [ ] `user@example.com` → Gmail mail jaata hai, Inbox me (spam me nahi)
- [ ] Gmail me "Show original" → SPF PASS, DKIM PASS, DMARC PASS
- [ ] Outlook IMAP/SMTP (993/587) kaam karta hai
- [ ] Mobile ActiveSync kaam karta hai
- [ ] Webmail HTTPS par khulta hai, HTTP redirect hota hai
- [ ] 6 galat passwords ke baad IP block hota hai
- [ ] `.exe` attachment block hota hai
- [ ] EICAR test file quarantine hoti hai

---

## 19. Troubleshooting

| Problem                                   | Possible cause / fix                                                     |
|-------------------------------------------|--------------------------------------------------------------------------|
| Mail bahar nahi ja raha                   | ISP ne port 25 block kiya — ISP se khulwayein ya Smart Host use karein   |
| Gmail/Outlook me spam ja raha             | PTR, SPF, DKIM, DMARC check karein; IP blacklist check karein            |
| "550 5.7.1 relaying denied" clients ko    | Client me "SMTP requires authentication" on nahi hai                     |
| Outlook certificate warning               | Client `mail.example.com` use kare, IP nahi; certificate valid ho        |
| Let's Encrypt fail                        | Port 80 forward nahi hai, ya IIS port 80 le raha hai; `LetsEncrypt.log` dekhein |
| Mail aane me 10 min delay                 | Greylisting — normal hai; trusted senders ko allow-list karein           |
| Users bar-bar block ho rahe               | Purana password phone me saved hai — Dynamic Screening log dekhein, IP allow karein |
| DNSBL har mail reject kar raha            | Public DNS se query ho rahi hai — local resolver set karein              |
| Webmail nahi khul raha                    | Port conflict (`netstat -ano`), firewall, ya service stop               |
| Queue me mails atke                       | DNS resolve problem, remote server down, ya blacklist — SMTP-out log dekhein |

---

## 20. Final Security Checklist

**Network**
- [ ] Static public IP + PTR = `mail.example.com`
- [ ] Sirf zaroori ports forward (25, 465, 587, 993, 995, 80, 443)
- [ ] Remote Admin (1000/444) aur RDP internet par **band**; VPN se access
- [ ] LAN clients ka direct outbound port 25 MikroTik par blocked

**Encryption**
- [ ] Valid Let's Encrypt certificate, auto-renew on
- [ ] TLS 1.0/1.1 disabled
- [ ] Plain-text ports 110/143 band ya STARTTLS required
- [ ] Authentication sirf TLS ke upar

**Mail authentication**
- [ ] SPF record `-all`
- [ ] DKIM 2048-bit signing on
- [ ] DMARC `quarantine` / `reject`
- [ ] Incoming SPF/DKIM/DMARC verification on

**Anti-abuse**
- [ ] Open relay test pass
- [ ] SMTP AUTH required, sender must match login
- [ ] AUTH port 25 par disabled
- [ ] Dynamic Screening (brute-force) on
- [ ] Location Screening for AUTH/Webmail
- [ ] Spam filter + DNSBL + Greylisting on
- [ ] AntiVirus + attachment blocking on

**Accounts**
- [ ] Strong password policy (12+), compromised-password check
- [ ] 2FA for Webmail (admins ke liye mandatory)
- [ ] Inactive accounts auto-disable
- [ ] `postmaster@` aur `abuse@` monitored

**Operations**
- [ ] Daily backup + offsite copy, restore tested
- [ ] MDaemon aur Windows updated
- [ ] Daily reports aur disk alerts on
- [ ] Weekly blacklist check

---

*Is guide ko apne environment ke hisaab se adapt karein. MDaemon ki official documentation: `https://help.mdaemon.com`.*
