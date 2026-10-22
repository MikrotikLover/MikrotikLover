#!/usr/bin/env python3
"""Mail server security (MDaemon, Exchange, Zimbra … on the LAN behind the MikroTik).

  mailsec.py check [--save]      DNS (MX, SPF, DMARC, DKIM, reverse DNS), blacklists, TLS certificates, open doors,
                                  outgoing mail volume -> /var/lib/mikrotiklover/mail.json (hourly; health + alerts read it)
  mailsec.py wizard              safe port forwards for the mail server (Firewall → Port forwards)
  mailsec.py logs [--days N]     password guessers blocked by the routers, devices that tried to send mail directly

Settings (ml_setting): mail_ip (LAN address), mail_domain, mail_host (MX name; default mail.DOMAIN), mail_public_ip
(default: from DNS), mail_dkim (DKIM selector, MDaemon default 'MDaemon'), mail_webmail_port (3000), mail_guard (1: router
rules on), mail_rate (new connections per minute per address before blocking, 30), mail_smtp_out (1: only the mail server
may send on port 25), mail_trusted (address object never blocked), mail_checklist (JSON of ticked MDaemon settings).
"""
import argparse, ipaddress, json, os, random, re, socket, struct, subprocess, sys, time
from datetime import datetime, timezone

CNF, DBNAME = "/etc/mikrotiklover-radius/my.cnf", "radius"
OUT = os.environ.get("ML_MAIL_JSON", "/var/lib/mikrotiklover/mail.json")
WF_LOG = os.environ.get("ML_WF_LOG", "/var/log/mikrotik/webfilter.log")
BLACKLISTS = [("zen.spamhaus.org", "Spamhaus ZEN"), ("bl.spamcop.net", "SpamCop"), ("b.barracudacentral.org", "Barracuda"),
              ("dnsbl.sorbs.net", "SORBS"), ("psbl.surriel.com", "PSBL"), ("bl.mailspike.net", "Mailspike"),
              ("dnsbl-1.uceprotect.net", "UCEPROTECT 1"), ("ix.dnsbl.manitu.net", "NiX Spam")]
# port, name, how the client talks TLS, open to the internet?, why
PORTS = [(25, "SMTP (mail from other servers)", "starttls", True, "needed: other servers deliver your mail here"),
         (587, "Submission (your users send)", "starttls", True, "users' phones / Outlook send mail; needs login"),
         (465, "SMTPS (send, TLS)", "tls", True, "older clients send mail over TLS"),
         (993, "IMAPS (read mail, TLS)", "tls", True, "phones / Outlook read mail"),
         (995, "POP3S (download mail, TLS)", "tls", True, "only if users use POP3"),
         (143, "IMAP (plain)", "starttls", False, "passwords can travel unencrypted — use 993"),
         (110, "POP3 (plain)", "starttls-pop3", False, "passwords can travel unencrypted — use 995"),
         (443, "Webmail / ActiveSync (HTTPS)", "tls", True, "browser mail and phone sync"),
         (1000, "MDaemon Remote Administration", "", False, "NEVER open to the internet — admin from the LAN or a VPN"),
         (3000, "MDaemon Webmail (plain HTTP)", "", False, "use HTTPS (443) instead; plain HTTP shows passwords")]
CHECKLIST = [("dynamic_screening", "Dynamic Screening on: block an address after 5 failed logins (Security → Dynamic Screening)"),
             ("auth_required", "SMTP authentication required for your users; 'local senders must authenticate' on"),
             ("no_open_relay", "Relay control: never relay for unauthenticated outside senders"),
             ("tls_required", "SSL & TLS: STARTTLS on, logins only over TLS; Let's Encrypt certificate (Security → Let's Encrypt)"),
             ("dkim_dmarc", "DKIM signing on, DMARC verification on (Security → Sender Authentication)"),
             ("strong_passwords", "Strong passwords required; two-factor login in Webmail"),
             ("remote_admin_lan", "Remote Administration only from the LAN (bind / IP restriction), port 1000 not forwarded"),
             ("antivirus", "AntiVirus / Outbreak Protection (Security Plus) on and updating"),
             ("ip_shield", "IP Shield: your domain may only be used as sender from your own networks / authenticated users"),
             ("backup", "Daily backup of mailboxes and settings, kept off this machine")]


# ------------------------------------------------------------------ a small DNS client (no extra packages)
def nameservers():
    try:
        out = [l.split()[1] for l in open("/etc/resolv.conf") if l.startswith("nameserver") and len(l.split()) > 1]
    except OSError:
        out = []
    return out or ["127.0.0.1"]


QTYPE = {"A": 1, "MX": 15, "TXT": 16, "PTR": 12, "CNAME": 5}


def _name(msg, i):
    labels, jumped, end = [], False, None
    for _ in range(128):
        n = msg[i]
        if n == 0:
            i += 1
            break
        if n & 0xC0 == 0xC0:
            if not jumped:
                end = i + 2
            i = ((n & 0x3F) << 8) | msg[i + 1]
            jumped = True
            continue
        labels.append(msg[i + 1:i + 1 + n].decode("ascii", "replace"))
        i += 1 + n
    return ".".join(labels), (end if jumped else i)


def query(name, qtype, server=None, port=53, timeout=3.0):
    """-> (rcode, [answers]) — A: '1.2.3.4', MX: (pref, host), TXT: 'joined strings', PTR/CNAME: 'name'. rcode 3 = no such name."""
    t = QTYPE[qtype]
    qid = random.randint(0, 65535)
    q = struct.pack("!HHHHHH", qid, 0x0100, 1, 0, 0, 0)
    for part in name.rstrip(".").split("."):
        q += bytes([len(part)]) + part.encode("ascii")
    q += b"\0" + struct.pack("!HH", t, 1)
    last = None
    for srv in ([server] if server else nameservers()[:2]):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(timeout)
        try:
            s.sendto(q, (srv, port))
            msg, _ = s.recvfrom(4096)
        except OSError as e:
            last = e
            continue
        finally:
            s.close()
        rid, flags, qd, an = struct.unpack("!HHHH", msg[:8])
        if rid != qid:
            continue
        i = 12
        for _ in range(qd):
            _, i = _name(msg, i)
            i += 4
        out = []
        for _ in range(an):
            _, i = _name(msg, i)
            rtype, _, _, rdlen = struct.unpack("!HHIH", msg[i:i + 10])
            i += 10
            rd = msg[i:i + rdlen]
            if rtype == t == 1 and rdlen == 4:
                out.append(socket.inet_ntoa(rd))
            elif rtype == t == 15:
                out.append((struct.unpack("!H", rd[:2])[0], _name(msg, i + 2)[0]))
            elif rtype == t == 16:
                parts, j = [], 0
                while j < len(rd):
                    parts.append(rd[j + 1:j + 1 + rd[j]].decode("utf-8", "replace"))
                    j += 1 + rd[j]
                out.append("".join(parts))
            elif rtype == t and t in (5, 12):
                out.append(_name(msg, i)[0])
            i += rdlen
        return flags & 0xF, out
    raise OSError(f"no DNS answer for {name} ({last})")


# ------------------------------------------------------------------ checks
def check_dns(domain, host, public_ip, dkim, q=query):
    """-> [check], public ip found."""
    out = []
    add = lambda cid, name, status, detail, fix="": out.append({"id": cid, "group": "DNS records", "name": name, "status": status, "detail": detail, "fix": fix if status != "ok" else ""})  # noqa: E731
    try:
        _, mx = q(domain, "MX")
    except OSError as e:
        add("mx", "MX record", "warn", f"could not ask DNS: {e}")
        mx = []
    mx = sorted(mx)
    if not mx and not out:
        add("mx", "MX record", "fail", f"{domain} has no MX record — other servers do not know where to deliver your mail",
            f"At your domain's DNS: MX 10 {host}")
    elif mx:
        add("mx", "MX record", "ok" if any(h.lower().rstrip(".") == host for _, h in mx) else "warn",
            "MX: " + ", ".join(f"{p} {h}" for p, h in mx), f"Point the MX to your server's name ({host}) if this server receives the mail")
    a = []
    try:
        _, a = q(host, "A")
    except OSError:
        pass
    if not public_ip and a:
        public_ip = a[0]
    if not a:
        add("a", f"Address of {host}", "fail", f"{host} has no A record", f"At the DNS: A {host} -> your public IP")
    else:
        add("a", f"Address of {host}", "ok" if not public_ip or public_ip in a else "warn", f"{host} -> {', '.join(a)}",
            f"Should be your public IP ({public_ip})")
    spf = []
    try:
        _, txt = q(domain, "TXT")
        spf = [t for t in txt if t.lower().startswith("v=spf1")]
    except OSError:
        pass
    if not spf:
        add("spf", "SPF", "fail", "no SPF record: anyone can send mail as your domain, and big providers put yours in spam",
            f'TXT on {domain}: "v=spf1 mx ip4:{public_ip or "YOUR-PUBLIC-IP"} -all"')
    elif len(spf) > 1:
        add("spf", "SPF", "fail", "more than one SPF record (both are ignored)", "Keep exactly one v=spf1 record")
    else:
        s = spf[0]
        allows = (public_ip and f"ip4:{public_ip}" in s) or " mx" in f" {s}" or " a " in f" {s} " or "include:" in s
        strict = s.rstrip().endswith(("-all", "~all"))
        add("spf", "SPF", "ok" if allows and strict else "warn", s,
            ("" if allows else f"Add ip4:{public_ip or 'YOUR-PUBLIC-IP'} or mx. ") + ("" if strict else "End it with -all (or ~all)."))
    try:
        _, dm = q(f"_dmarc.{domain}", "TXT")
        dm = [t for t in dm if t.lower().startswith("v=dmarc1")]
    except OSError:
        dm = []
    if not dm:
        add("dmarc", "DMARC", "warn", "no DMARC record", f'TXT on _dmarc.{domain}: "v=DMARC1; p=quarantine; rua=mailto:postmaster@{domain}"')
    else:
        p = re.search(r"\bp=(\w+)", dm[0])
        add("dmarc", "DMARC", "ok" if p and p.group(1).lower() in ("quarantine", "reject") else "warn", dm[0],
            "p=none only reports; when the reports look right use p=quarantine")
    if dkim:
        try:
            rc, dk = q(f"{dkim}._domainkey.{domain}", "TXT")
        except OSError:
            rc, dk = 2, []
        ok = any("p=" in t and not re.search(r"\bp=\s*(;|$)", t) for t in dk)
        add("dkim", f"DKIM ({dkim})", "ok" if ok else "warn", "public key published" if ok else f"no DKIM key at {dkim}._domainkey.{domain}",
            "MDaemon: Security → Sender Authentication → DKIM Signing → show the DNS record and add it as TXT")
    if public_ip:
        rev = ".".join(reversed(public_ip.split("."))) + ".in-addr.arpa"
        try:
            _, ptr = q(rev, "PTR")
        except OSError:
            ptr = []
        names = [p.lower().rstrip(".") for p in ptr]
        if not names:
            add("ptr", "Reverse DNS (PTR)", "fail", f"{public_ip} has no reverse name — Gmail / Outlook refuse or junk your mail",
                f"Ask your internet provider (ISP) to set the reverse DNS of {public_ip} to {host}")
        else:
            add("ptr", "Reverse DNS (PTR)", "ok" if host in names else "warn", f"{public_ip} -> {', '.join(names)}",
                f"Ask your ISP to set it to {host} (the name MDaemon says in HELO)")
    return out, public_ip


def check_blacklists(ip, q=query):
    out = []
    rev = ".".join(reversed(ip.split(".")))
    for zone, name in BLACKLISTS:
        try:
            rc, a = q(f"{rev}.{zone}", "A", timeout=4.0)
        except OSError:
            out.append({"list": name, "zone": zone, "status": "unknown", "detail": "no answer"})
            continue
        if not a:
            out.append({"list": name, "zone": zone, "status": "ok", "detail": "not listed"})
        elif all(x.startswith("127.255.255.") or x == "127.0.0.1" for x in a):
            out.append({"list": name, "zone": zone, "status": "unknown", "detail": "query refused (public DNS) — use your own DNS server"})
        else:
            out.append({"list": name, "zone": zone, "status": "listed", "detail": ", ".join(a)})
    return out


def tls_cert(ip, port, mode, name="", timeout=8):
    """-> {days, subject, issuer, trusted, error} using the openssl command (implicit TLS or STARTTLS)."""
    args = ["openssl", "s_client", "-connect", f"{ip}:{port}", "-showcerts"] + (["-servername", name] if name else [])
    if mode == "starttls":
        args += ["-starttls", "smtp" if port in (25, 587) else "imap"]
    elif mode == "starttls-pop3":
        args += ["-starttls", "pop3"]
    try:
        p = subprocess.run(args, input="", capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return {"error": "no answer"}
    pem = re.search(r"-----BEGIN CERTIFICATE-----.+?-----END CERTIFICATE-----", p.stdout, re.S)
    if not pem:
        return {"error": "no certificate (port closed, or no TLS)"}
    try:
        x = subprocess.run(["openssl", "x509", "-noout", "-enddate", "-subject", "-issuer", "-ext", "subjectAltName"], input=pem.group(0),
                           capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {"error": "openssl failed"}
    end = re.search(r"notAfter=(.+)", x)
    days = None
    if end:
        try:
            dt = datetime.strptime(end.group(1).strip(), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            days = (dt - datetime.now(timezone.utc)).days
        except ValueError:
            pass
    subj, iss = re.search(r"subject=(.+)", x), re.search(r"issuer=(.+)", x)
    sans = re.findall(r"DNS:([^,\s]+)", x)
    subj_s, iss_s = subj.group(1).strip() if subj else "", iss.group(1).strip() if iss else ""
    return {"days": days, "subject": subj_s, "issuer": iss_s, "names": sans, "self_signed": bool(subj_s) and subj_s == iss_s,
            "verify": "ok" if re.search(r"Verify return code: 0 \(ok\)", p.stdout) else "not trusted"}


def check_tls(ip, host, fwd, tls=tls_cert):
    """fwd: {outside port: inside port}; each TLS service is asked on the mail server's own port.
    Nothing answers at all -> one check that says so (not one per port)."""
    out = _check_tls(ip, host, fwd, tls)
    if len(out) > 1 and all(o["status"] != "ok" and o["detail"].startswith(("no answer", "no certificate")) for o in out):
        return [{"id": "tls", "group": "Certificates", "name": "Mail server reachable", "status": "warn",
                 "detail": f"no TLS answer from {ip} on any mail port (checked from this server)",
                 "fix": "Is the mail server on? Windows firewall on the mail server must allow this server; then turn on SSL/TLS in MDaemon"}]
    return out


def _check_tls(ip, host, fwd, tls):
    out = []
    for port, name, mode, _, _ in PORTS:
        if not mode or port not in fwd:
            continue
        c = tls(ip, fwd[port], mode, host)
        cid = f"tls{port}"
        c["_port"] = port
        if c.get("error"):
            out.append({"id": cid, "group": "Certificates", "name": f"{name} — port {port}", "status": "warn", "detail": c["error"],
                        "fix": "Turn on SSL/TLS for this service in MDaemon (Security → SSL & TLS), or close the port"})
            continue
        days, names = c.get("days"), [n.lower() for n in c.get("names", [])]
        name_ok = not host or host in names or any(n.startswith("*.") and host.endswith(n[1:]) for n in names)
        status = "fail" if days is not None and days < 7 else "warn" if (days is not None and days < 21) or c.get("self_signed") or not name_ok else "ok"
        detail = (f"{days} days left" if days is not None else "expiry unknown") + (" · self-signed" if c.get("self_signed") else "") \
            + ("" if name_ok else f" · not for {host} ({', '.join(names[:3]) or c.get('subject', '')})")
        out.append({"id": cid, "group": "Certificates", "name": f"{name} — port {port}", "status": status, "detail": detail,
                    "fix": "MDaemon: Security → Let's Encrypt (renews by itself); the certificate must be for " + (host or "your mail name")})
    return out


def check_ports(vips, nat, mail_ip):
    """Port forwards to the mail server (made in Firewall, and seen on the routers) -> checks, {outside port: inside port}."""
    fwd, how = {}, {}
    for v in vips:
        if v.get("to_ip") == mail_ip and v.get("enabled"):
            lo, hi = (int(x) for x in (str(v["port"]).split("-") + [str(v["port"])])[:2])
            tlo = int(str(v["to_port"]).split("-")[0])
            for p in range(lo, min(hi, lo + 100) + 1):
                fwd[p] = tlo + (p - lo) if "-" in str(v["port"]) else tlo
                how[p] = "all" if v.get("src") in (["all"], [], None) else "limited"
    for n in nat:
        if n.get("to") == mail_ip and not n.get("disabled"):
            outs = [int(x) for x in re.findall(r"\d+", str(n.get("port") or ""))][:1]
            ins = [int(x) for x in re.findall(r"\d+", str(n.get("to_port") or n.get("port") or ""))][:1]
            if outs:
                fwd.setdefault(outs[0], (ins or outs)[0])
                how.setdefault(outs[0], "limited" if n.get("src") else "all")
    out = []
    for port, name, _, should, why in PORTS:
        if port in fwd:
            out.append({"id": f"port{port}", "group": "Open doors", "name": f"{port} {name}", "status": "ok" if should else "fail",
                        "detail": "open to the internet" + (" (only some addresses)" if how[port] == "limited" else "")
                                  + (f" -> inside port {fwd[port]}" if fwd[port] != port else ""), "fix": "" if should else why})
    if 25 not in fwd:
        out.append({"id": "port25", "group": "Open doors", "name": "25 SMTP", "status": "warn", "detail": "not forwarded to the mail server — mail from outside cannot arrive",
                    "fix": "Mail server → Set up the doors (or Firewall → Port forwards: TCP 25 -> the mail server)"})
    return out, fwd


def volume(rows, now_hour):
    """traffic_port rows [(hour, flows)] of the mail server to port 25 -> (this hour, usual hour, spike?)."""
    hist = sorted(f for h, f in rows if h != now_hour)
    usual = hist[len(hist) // 2] if hist else 0
    cur = sum(f for h, f in rows if h == now_hour)
    return cur, usual, cur >= max(200, usual * 5)


LOG_RE = re.compile(r"^(\S+) (\S+) .*?WF-(mailbrute|spambot)\b.*?(\d+\.\d+\.\d+\.\d+)(?::\d+)?->(\d+\.\d+\.\d+\.\d+)(?::(\d+))?")


def parse_logs(lines, since=0):
    out = []
    for line in lines:
        m = LOG_RE.search(line)
        if not m:
            continue
        try:
            ts = datetime.fromisoformat(m.group(1)).timestamp()
        except ValueError:
            continue
        if ts >= since:
            out.append({"time": m.group(1)[:19].replace("T", " "), "router": m.group(2), "kind": m.group(3), "src": m.group(4), "dst": m.group(5),
                        "port": int(m.group(6) or 0)})
    return out


# ------------------------------------------------------------------ database + commands
class DB:
    def __init__(self, cnf=CNF, name=DBNAME):
        import pymysql, pymysql.cursors
        self.c = pymysql.connect(read_default_file=cnf, database=name, autocommit=True, charset="utf8mb4", cursorclass=pymysql.cursors.DictCursor)

    def q(self, sql, args=()):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def settings(self):
        return {r["k"]: r["v"] for r in self.q("SELECT k, v FROM ml_setting WHERE k LIKE 'mail\\_%%'")}


def conf_of(s):
    dom = (s.get("mail_domain") or "").lower()
    return {"ip": s.get("mail_ip", ""), "domain": dom, "host": (s.get("mail_host") or (f"mail.{dom}" if dom else "")).lower(),
            "public_ip": s.get("mail_public_ip", ""), "dkim": s.get("mail_dkim", "MDaemon"), "webmail": int(s.get("mail_webmail_port") or 3000),
            "guard": s.get("mail_guard", "1") == "1", "rate": int(s.get("mail_rate") or 30), "smtp_out": s.get("mail_smtp_out", "1") == "1",
            "trusted": s.get("mail_trusted", ""), "checklist": json.loads(s.get("mail_checklist") or "{}")}


def run_checks(db, q=query, tls=tls_cert):
    c = conf_of(db.settings())
    if not c["ip"] or not c["domain"]:
        return {"configured": False, "checks": [], "at": time.strftime("%Y-%m-%d %H:%M")}
    checks = []
    vips = db.q("SELECT * FROM ml_fw_vip")
    for v in vips:
        v["src"] = [x for x in (v["src"] or "").split(",") if x]
    nat = []
    for r in db.q("SELECT exposed FROM ml_router_status WHERE exposed IS NOT NULL"):
        try:
            nat += json.loads(r["exposed"]).get("nat", [])
        except (ValueError, TypeError):
            pass
    pc, fwd = check_ports(vips, nat, c["ip"])
    checks += pc
    try:
        dc, pub = check_dns(c["domain"], c["host"], c["public_ip"], c["dkim"], q)
    except Exception as e:  # noqa: BLE001
        dc, pub = [{"id": "dns", "group": "DNS records", "name": "DNS", "status": "warn", "detail": f"could not check: {e}", "fix": ""}], c["public_ip"]
    checks += dc
    bl = check_blacklists(pub, q) if pub else []
    listed = [b["list"] for b in bl if b["status"] == "listed"]
    if pub:
        checks.append({"id": "blacklists", "group": "Reputation", "name": "Blacklists", "status": "fail" if listed else "ok",
                       "detail": f"{pub} listed on: {', '.join(listed)}" if listed else f"{pub} on none of {sum(b['status'] == 'ok' for b in bl)} lists checked",
                       "fix": "Find the cause first (hacked mailbox? a PC sending spam?), then ask for removal on each list's website" if listed else ""})
    checks += check_tls(c["ip"], c["host"], fwd, tls)
    # protection on the routers
    checks.append({"id": "guard", "group": "Protection", "name": "Password guessing blocked on the routers", "status": "ok" if c["guard"] else "warn",
                   "detail": f"more than {c['rate']} new connections a minute from one address -> blocked 1 hour" if c["guard"] else "off",
                   "fix": "Mail server → Protection → on"})
    checks.append({"id": "smtp_out", "group": "Protection", "name": "Only the mail server sends on port 25", "status": "ok" if c["smtp_out"] else "warn",
                   "detail": "other devices are refused (spam bots cannot send)" if c["smtp_out"] else "any device may send mail directly",
                   "fix": "Mail server → Protection → on"})
    rows = db.q("""SELECT DATE_FORMAT(bucket, '%%Y-%%m-%%d %%H') AS h, SUM(flows) AS f FROM traffic_port WHERE client_ip=%s AND port=25
                   AND direction='out' AND bucket >= NOW() - INTERVAL 7 DAY GROUP BY h""", (c["ip"],))
    cur, usual, spike = volume([(r["h"], int(r["f"])) for r in rows], time.strftime("%Y-%m-%d %H"))
    checks.append({"id": "volume", "group": "Reputation", "name": "Outgoing mail this hour", "status": "fail" if spike else "ok",
                   "detail": f"{cur} connections to other mail servers (usual hour: {usual})" + (" — much more than usual" if spike else ""),
                   "fix": "A hacked mailbox may be sending spam: MDaemon → Queues / logs, change that user's password" if spike else ""})
    done = sum(1 for k, _ in CHECKLIST if c["checklist"].get(k))
    checks.append({"id": "checklist", "group": "MDaemon settings", "name": "MDaemon security settings", "status": "ok" if done == len(CHECKLIST) else "warn",
                   "detail": f"{done} of {len(CHECKLIST)} ticked", "fix": "Mail server → MDaemon checklist"})
    for x in checks:
        if x["status"] == "ok":
            x["fix"] = ""
    return {"configured": True, "at": time.strftime("%Y-%m-%d %H:%M"), "public_ip": pub, "checks": checks, "blacklists": bl,
            "volume": {"now": cur, "usual": usual}, "open_ports": sorted(fwd)}


def wizard(db, webmail_https=True):
    """Safe port forwards for the mail server through the firewall (mail-* port forwards)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import firewall as fw
    c = conf_of(db.settings())
    if not c["ip"]:
        raise SystemExit("set the mail server first: radius-admin mail set ip 192.168.88.30 domain example.com")
    fdb = fw.DB(CNF, DBNAME)
    st = fw.load(fdb)
    have = {v["name"]: v for v in st["vips"]}
    want = [("mail-smtp", "25", "25"), ("mail-submission", "587", "587"), ("mail-smtps", "465", "465"), ("mail-imaps", "993", "993"),
            ("mail-pop3s", "995", "995")] + ([("mail-webmail", "443", "443")] if webmail_https else [])
    msgs = []
    for name, port, to_port in want:
        v = {"name": name, "proto": "tcp", "port": port, "to": c["ip"], "to_port": to_port, "src": ["all"], "comment": "mail server (Mail server → Set up the doors)"}
        if name in have:
            v["id"] = have[name]["id"]
        msgs.append(fw.save_vip(fdb, st, v))
        st = fw.load(fdb)
    return msgs


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cnf", default=CNF)
    ap.add_argument("--db", default=DBNAME)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("check")
    p.add_argument("--save", action="store_true")
    p.add_argument("--dns", default="", help="DNS server to ask, HOST[:PORT] (default: /etc/resolv.conf)")
    p = sub.add_parser("wizard")
    p.add_argument("--no-webmail", action="store_true")
    p = sub.add_parser("logs")
    p.add_argument("--days", type=int, default=1)
    a = ap.parse_args(argv)
    if a.cmd == "logs":
        try:
            with open(WF_LOG, errors="replace") as f:
                rows = parse_logs(f, time.time() - a.days * 86400)
        except OSError:
            rows = []
        json.dump(rows[-2000:], sys.stdout)
        return 0
    db = DB(a.cnf, a.db)
    if a.cmd == "wizard":
        for m in wizard(db, not a.no_webmail):
            print(m)
        return 0
    if a.dns:
        srv, _, port = a.dns.partition(":")
        qf = lambda n, t, timeout=3.0: query(n, t, server=srv, port=int(port or 53), timeout=timeout)  # noqa: E731
    else:
        qf = query
    res = run_checks(db, qf)
    if a.save:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT + ".tmp", "w") as f:
            json.dump(res, f)
        os.chmod(OUT + ".tmp", 0o644)
        os.replace(OUT + ".tmp", OUT)
    if not res["configured"]:
        print("mail server not set up (radius-admin mail set ip IP domain DOMAIN)")
        return 0
    for c in res["checks"]:
        mark = {"ok": "✔", "warn": "!", "fail": "✘"}.get(c["status"], "?")
        print(f"  {mark} {c['group']:16} {c['name']:42} {c['detail'][:90]}")
        if c.get("fix"):
            print(f"      → {c['fix']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
