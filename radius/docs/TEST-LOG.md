# Live test log — poore project ka test (Claude)

Shuru: 2026-10-16 23:17 UTC (17 Oct 04:17 PKT). Har qadam neeche likha jata hai: waqt (UTC), kya test hua, nateeja, aur agar bug mila to fix.

| Waqt | Test | Nateeja |
|---|---|---|
| 23:17 | Services start (MariaDB, FreeRADIUS, nginx, cron, rsyslog, dashboard, collector) | ✅ sab chal rahe hain (1812, 514, 2055, 8443) |
| 23:17 | install.sh dobara chalaya (update / idempotent) | ✅ 14 sec, exit 0, data aur users mehfooz |
| 23:17 | Automatic tests: appinv 20, discover 16, learn 11, cdnmap 16, collector 11, reports 5, security 29, VPN 26, policies 63, WhatsApp-only 19, router scripts lint 25 + sync.rsc | ✅ 241 checks pass, 0 fail |
| 23:19 | Dashboard browser test (har page, mobile, dark mode, console/CSP errors) | ✅ 40 checks pass |
| 23:20 | radius-admin: har command ~200 tarah ke sahi/galat inputs se (crash, khamosh exit, traceback check) | ⚠️ crash koi nahi, lekin 6 bugs: (1) group show NAHI-WALA khamosh (2) web role/del NAHI-WALA par 'ho gaya' (3) plan del NAHI-WALA par 'deleted' (4) usage NAHI-WALA khamosh (5) apps users NAHI-WALI app par ghalat message (6) install.sh dobara chalane par delete ki hui misaal policies wapas aa jati hain |
| 23:21 | FIX 1–6 | ✅ ab saaf error aata hai: 'No such group / No dashboard account / No such plan / No such user / No app seen'. Aakhri admin account delete nahi hota. Update ke baad delete ki hui policy wapas nahi aati (dobara install kar ke check kiya) |
| 23:21 | RADIUS login: MSCHAPv2, PEAP (Wi-Fi), galat password, disable/enable | ✅ sab sahi |
| 23:22 | Hotspot business: plan (quota 100M + FUP), activation pehle login par, quota khatam → FUP 1M/1M, expiry → reject 'package expired', renew, vouchers login, sales, voucher delete | ✅ sab sahi |
| 23:24 | Live log (radius-admin live): asli DNS queries bheji | ✅ 3 sec ke andar user, IP, site, hostname ke saath nazar aayi |
| 23:24 | Kick / Disconnect (nakli router par port 3799) | ✅ ali ki 3 sessions disconnect, router ne ACK diya |
| 23:24 | Har cron job cron jaise environment mein chalaya | ⚠️ BUG 7: weekly update mein 'dnsmasq: command not found' (cron ka PATH chhota hota hai) → DNS logger reload nahi hota tha; backup mein FreeRADIUS version khali. FIX: radius-admin khud poora PATH set karta hai ✅ |
| 23:24 | Malware DNS block (security dns-block on/off) | ✅ threat domain ka jawab 0.0.0.0, off karne par hat gaya |
| 23:25 | Dashboard security: viewer account, CSRF, path traversal, policy injection, router sync key | ✅ viewer sirf dekh sakta hai (11 admin kaam 403), bina CSRF 403, ../etc/passwd 404, ghalat policy 400, ghalat key 403 |
| 23:25 | radius-admin help + ghalat command | ⚠️ BUG 8: help mein naye commands ghalat heading ke neeche the (apps/policy/vpn/security/backup 'Ports' ke neeche, sales 'CDN' ke neeche); ghalat command par sirf help aati thi. FIX: sahi headings, 'unknown command' error ✅ |
| 23:26 | Config check: rsyslog, nginx, FreeRADIUS, sudoers, logrotate; Python compile + flake8; bash shellcheck | ✅ sab valid, koi asal error nahi |
| 23:26 | Attackers auto-block → router sync (ml-attackers) | ✅ bahar ka attacker list mein, LAN ka IP kabhi nahi, off karne par hat gaya |
| 23:26 | Router sync file ki mazbooti | ⚠️ BUG 9: agar router par vpn-servers/ml-attackers list mein koi IP pehle se haath se daala ho to poora sync import ruk jata (RouterOS duplicate par error deta hai). FIX: un entries ko ':do {} on-error={}' mein; ml-threats list poori dobara banti hai ✅ |
| 23:28 | Reports ki speed | ⚠️ BUG 10: sites/history/blocked (aur dashboard) chahe 1 din ki report ho, 30 din ki saari purani DNS log files padhte the → bade network par bohot slow. FIX: sirf report ke din ki files padhi jati hain + test ✅ |
| 23:28 | Raat ko log rotate hone ke baad hourly scans | ❌→✅ BUG 11 (DATA LOSS): hourly jobs (apps, website names, VPN, security, app learning) sirf aaj ki log file padhte the lekin 'kal se' ka data DB se mita kar dobara likhte the → roz subah kal ka (aur rotate se pehle ka aaj ka) data ghaib. FIX: rotated files (dns.log.1, .gz) bhi padhi jati hain; rotate ke baad bhi 146 lookups, 61 website names wapas mile + test |
| 23:28 | Traffic collector: DNS log rotate/truncate | ⚠️ BUG 12: log 'copytruncate' se chhoti ho jaye to collector site names padhna band kar deta; purani file band nahi hoti thi. FIX + test ✅ |
| 23:29 | Dashboard API ko 31 tarah ke ghalat inputs (SQL injection, ../, negative, bohot bara text) | ⚠️ BUG 13: ?top=-5 par server error 500; ?n=abc par bhi 500. FIX: har number parameter check + had ke andar ✅ (baqi 29 sahi 400/404 dete thay, SQL injection koi nahi) |
| 23:29 | Dashboard server log mein errors (tracebacks) | ✅ sirf 2: ek purana (pehle theek ho chuka), ek BUG 13 wala (ab theek) |
| 23:29 | PPPoE static IP, MAC authentication (har MAC format), PIN vouchers | ✅ chalte hain. ⚠️ BUG 14: 'radius-admin test' static IP (Framed-IP-Address), pool, Reply-Message nahi dikhata tha → FIX: saare jawab dikhata hai ✅ |
| 23:30 | radius-admin test (fix ka dobara check) | ✅ sirf server ka jawab dikhata hai (password wali request lines nahi) |
| 23:31 | Raat ka block (misaal 22:00 se 06:00) | ❌→✅ BUG 15: aadhi raat paar karne wala waqt router par kabhi lagta hi nahi (RouterOS range 00:00 paar nahi kar sakti). FIX: khud do hisson mein (22:00–24:00 + agle din 00:00–06:00, din bhi agle din ke). Nayi misaal policy 'kids-night'. Simulator ke 7 naye cases pass (ab total 70) |
| 23:32 | Policy ka khali waqt (09:00–09:00) | ⚠️ BUG 16: aisi policy chupke se kabhi lagti nahi thi → ab saaf error ✅ |
| 23:33 | Lambe dashboard kaam (Run all updates, backup) + ek saath chalne wale kaam | ⚠️ BUG 17: nginx 150 sec baad 'Gateway timeout' de deta (asal internet par updates/backup lambe ho sakte hain) → 900 sec. BUG 18: hourly jobs agar ek ghante se lambe chalein to doosra run saath shuru ho kar DB par takrata; dashboard + cron ek saath router rules banate. FIX: 'radius-admin hourly' lock ke saath (dobara chalaya: doosra run khud ruk gaya ✅), build par lock, aur har hourly job ka nateeja ab Settings → Automatic updates mein ✅ |
| 23:34 | Database band ho jaye to? | ⚠️ BUG 19: dashboard HTML '500 Internal Server Error' dikhata; Wi-Fi login DB wapas aane ke 30 sec baad tak fail. FIX: saaf message 'database not reachable' (503) ✅, FreeRADIUS 5 sec mein dobara jur jata hai ✅ |
| 23:37 | Dashboard ke 41 pages: admin aur viewer, computer (light) aur phone (dark) | ✅ koi console error, error toast ya screen se bahar jata page nahi; viewer ko admin buttons nazar nahi aate |
| 23:42 | Browser test ki kamzori | ⚠️ 3 jagah test purane test-data par tika tha (Netflix, bilal, ek jaisa FUP text) → test data se azad kiya ✅ (product bug nahi) |
| 23:42 | AAKHRI ROUND: installer dobara, 254 automatic checks, 40 browser checks, CLI fuzz, 41 pages x 2 (admin/viewer, computer/phone) | ✅ sab pass |

## Khulasa

- **19 asal bugs mile aur sab theek hue** (har ek ke saath test), aur browser test ki 3 kamzoriyan bhi door ki gayin.
- **Sab se zaroori fixes:**
  - **BUG 11 (data loss):** roz subah log rotate hone ke baad kal ka data mit jata tha.
  - **BUG 15:** raat ka block (22:00–06:00) router par lagta hi nahi tha.
  - **BUG 9:** router sync ek duplicate entry par ruk jata tha.
  - **BUG 17–18:** lambe kaam par timeout, aur do kaamon ka takrana.
- **Is container mein test nahi ho sakte:**
  - asli MikroTik router par scripts ka import aur auto-sync (yahan RouterOS nahi chalta);
  - asal internet se threat lists ke kuch sources (yahan sirf GitHub khulta hai);
  - app catalog ka update (PR merge hone ke baad chalega).
