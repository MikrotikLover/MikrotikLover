#!/usr/bin/env python3
"""Health check: every part of the server with a green / yellow / red mark and, when something is
wrong, what to do about it.

  health.py [--json] [--save] [--cnf FILE] [--db NAME]   (radius-admin doctor runs it as root;
                                                         --save: also /var/lib/mikrotiklover/health.json, hourly)

Each check -> {"id", "group", "name", "status": ok|warn|fail, "detail", "fix"}.
"""
import glob, json, os, re, shutil, socket, ssl, subprocess, sys, time
from datetime import datetime, timedelta, timezone

CONF_DIR = "/etc/mikrotiklover-radius"
CERT = "/etc/freeradius/3.0/certs/mikrotiklover/server.pem"
LOG_DIR = "/var/log/mikrotik"
STATE_DIR = "/var/lib/mikrotiklover"
BACKUP_DIR = "/var/backups/mikrotiklover"
UPDATES = f"{STATE_DIR}/updates.txt"
TABLES = ("radcheck", "radreply", "radacct", "nas", "ml_plan", "ml_account", "ml_setting", "ml_app", "ml_domain",
          "ml_security_event", "ml_quarantine", "ml_alert", "web_admin", "ml_fw_rule", "ml_fw_vip")


def sh(cmd, timeout=15):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr).strip()
    except (OSError, subprocess.SubprocessError) as e:
        return 127, str(e)


def running(pattern):
    return sh(["pgrep", "-f", pattern], 5)[0] == 0


def listening(proto, port):
    rc, out = sh(["ss", "-H", "-ln" + ("u" if proto == "udp" else "t")], 5)
    return rc == 0 and re.search(rf"[:\]]{port}\s", out + " ") is not None


def age_text(sec):
    if sec < 120:
        return "just now"
    if sec < 7200:
        return f"{int(sec // 60)} min ago"
    if sec < 172800:
        return f"{int(sec // 3600)} h ago"
    return f"{int(sec // 86400)} days ago"


def file_age(path):
    try:
        return time.time() - os.path.getmtime(path)
    except OSError:
        return None


def when_active(spec):
    """A moment when a rule with time=SPEC (RouterOS: 9h-17h,mon,tue …) is active: the next listed day, start + 1 min."""
    rng, *days = spec.split(",")
    secs = lambda t: sum(int(n) * {"h": 3600, "m": 60, "s": 1}[u] for n, u in re.findall(r"(\d+)([hms])", t))  # noqa: E731
    start = secs(rng.split("-")[0]) + 60
    names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
    want = [names.index(d) for d in days if d in names] or list(range(7))
    now = datetime.now()
    for i in range(8):
        d = now.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=i)
        if d.weekday() in want:
            return d + timedelta(seconds=start)
    return now


class Checks:
    def __init__(self, cnf, db):
        self.cnf, self.db, self.out = cnf, db, []

    def add(self, cid, group, name, status, detail, fix=""):
        self.out.append({"id": cid, "group": group, "name": name, "status": status, "detail": detail, "fix": fix if status != "ok" else ""})

    def sql(self, q):
        rc, out = sh(["mysql", f"--defaults-extra-file={self.cnf}", "--default-character-set=utf8mb4", "-N", "-B", self.db, "-e", q], 20)
        if rc:
            raise RuntimeError(out[:200])
        return [l.split("\t") for l in out.splitlines()]

    # -------------------------------------------------------------- services
    def services(self):
        g = "Services"
        ok = running(r"^(/usr/sbin/)?freeradius")
        port = listening("udp", 1812) and listening("udp", 1813)
        self.add("freeradius", g, "FreeRADIUS (logins)", "ok" if ok and port else "fail",
                 "running, listening on UDP 1812/1813" if ok and port else ("running but not listening on 1812/1813" if ok else "not running"),
                 "sudo systemctl restart freeradius ; if it stops again: sudo freeradius -X  (shows the config error)")
        rc, out = sh(["mysqladmin", f"--defaults-extra-file={self.cnf}", "ping"], 10)
        self.add("mariadb", g, "Database (MariaDB)", "ok" if rc == 0 else "fail", "answering" if rc == 0 else out[:120],
                 "sudo systemctl restart mariadb ; disk full? see the Disk check")
        if rc == 0:
            try:
                have = {r[0] for r in self.sql("SHOW TABLES")}
                miss = [t for t in TABLES if t not in have]
                self.add("schema", g, "Database tables", "ok" if not miss else "fail",
                         f"{len(have)} tables" if not miss else "missing: " + ", ".join(miss),
                         "re-run the installer (keeps your data): sudo bash install.sh")
            except RuntimeError as e:
                self.add("schema", g, "Database tables", "fail", str(e), "check /etc/mikrotiklover-radius/my.cnf")
        web = running(r"mikrotiklover/web/app[.]py")
        nginx = running(r"nginx: master")
        self.add("web", g, "Dashboard (web + nginx)", "ok" if web and nginx else "fail",
                 "running" if web and nginx else ("web app not running" if not web else "nginx not running"),
                 "sudo systemctl restart mikrotiklover-web nginx ; log: /var/log/mikrotik/web.log")
        dns = running(r"mikrotiklover.*dnsmasq|dnsmasq.*mikrotiklover")
        a = file_age(f"{LOG_DIR}/dns.log")
        st = "fail" if not dns else ("warn" if a is None or a > 3600 else "ok")
        self.add("dns", g, "DNS logger (visited sites, apps)", st,
                 ("not running" if not dns else "running, last lookup " + (age_text(a) if a is not None else "never")),
                 "sudo radius-admin dnslog on ROUTER_IP" if not dns else "no lookups: routers / DHCP must give this server as DNS (router setup step 'DNS')")
        col = running(r"flowcollector[.]py")
        self.add("collector", g, "Traffic collector (data per app)", "ok" if col else "warn", "running" if col else "not running",
                 "sudo radius-admin traffic collector on ; router: /ip traffic-flow enabled=yes, target = this server UDP 2055")
        rs = running(r"rsyslogd")
        ages = [x for x in (file_age(f"{LOG_DIR}/router.log"), file_age(f"{LOG_DIR}/webfilter.log")) if x is not None]
        a = min(ages) if ages else None
        st = "fail" if not rs else ("warn" if a is None or a > 6 * 3600 else "ok")
        self.add("syslog", g, "Router logs (blocking log, attacks)", st,
                 "rsyslog not running" if not rs else ("last router log " + (age_text(a) if a is not None else "never")),
                 "sudo systemctl restart rsyslog" if not rs else "router: /system logging action remote = this server UDP 514 (router setup step 'logging'); quiet at night is normal")
        cron = running(r"(^|/)cron( |$)|crond")
        cf = os.path.exists("/etc/cron.d/mikrotiklover")
        self.add("cron", g, "Automatic jobs (cron)", "ok" if cron and cf else "fail",
                 "running" if cron and cf else ("cron not running" if not cron else "/etc/cron.d/mikrotiklover missing"),
                 "sudo systemctl enable --now cron ; missing file: re-run the installer")

    # -------------------------------------------------------------- jobs, backups
    def jobs(self):
        g = "Jobs & backups"
        rows = {}
        try:
            for line in open(UPDATES, encoding="utf-8"):
                p = line.rstrip("\n").split("\t")
                if len(p) >= 3:
                    rows[p[0]] = (p[1], p[2])
        except OSError:
            pass
        hourly = [(k, v) for k, v in rows.items() if k.startswith("Hourly:")]
        if not hourly:
            self.add("hourly", g, "Hourly jobs", "warn", "never ran", "sudo radius-admin hourly")
        else:
            last = max(datetime.strptime(v[0], "%Y-%m-%d %H:%M").timestamp() for _, v in hourly)
            bad = [k[8:] for k, v in hourly if v[1].startswith("failed")]
            old = time.time() - last > 3 * 3600
            self.add("hourly", g, "Hourly jobs", "fail" if bad else ("warn" if old else "ok"),
                     ("failed: " + ", ".join(bad) + " — " if bad else "") + "last run " + age_text(time.time() - last),
                     "run it and read the error: sudo radius-admin hourly" if bad else "cron is not running the jobs: check 'Automatic jobs (cron)'")
        weekly = [(k, v) for k, v in rows.items() if not k.startswith("Hourly:") and k != "Off-site backup"]
        if weekly:
            bad = [f"{k} ({v[1][7:].strip()[:60]})" for k, v in weekly if v[1].startswith("failed")]
            self.add("updates", g, "Weekly updates (lists, catalog)", "warn" if bad else "ok",
                     "failed: " + "; ".join(bad) if bad else f"{len(weekly)} updates ok",
                     "sudo radius-admin update  (needs internet; a failed list keeps the old one)")
        files = sorted(glob.glob(f"{BACKUP_DIR}/mikrotiklover-*.tar.gz*"), key=os.path.getmtime)
        if not files:
            self.add("backup", g, "Backup", "fail", "no backup yet", "sudo radius-admin backup")
        else:
            a = file_age(files[-1])
            self.add("backup", g, "Backup", "ok" if a < 30 * 3600 else "fail",
                     f"newest {age_text(a)}, {len(files)} kept", "nightly backup did not run: sudo radius-admin backup ; check cron")
        if os.path.exists(f"{CONF_DIR}/offsite.conf"):
            v = rows.get("Off-site backup")
            st = "warn" if not v else ("fail" if v[1].startswith("failed") else "ok")
            self.add("offsite", g, "Off-site copy", st, (re.sub(r"^(ok|failed):\s*(✔\s*)?(Off-site:\s*)?", "", v[1])[:110] + f" ({v[0]})") if v else "not sent yet",
                     "sudo radius-admin backup offsite test   (backup server reachable? key added there?)")
        else:
            self.add("offsite", g, "Off-site copy", "warn", "off — backups only on this server",
                     "dashboard → Settings → Off-site copy, or: sudo radius-admin backup offsite ssh|rclone ...")

    # -------------------------------------------------------------- system
    def system(self):
        g = "Server"
        st = os.statvfs("/")
        free = st.f_bavail / st.f_blocks * 100 if st.f_blocks else 100
        gb = st.f_bavail * st.f_frsize / 2**30
        self.add("disk", g, "Disk space", "fail" if free < 3 or gb < 1 else ("warn" if free < 10 and gb < 10 else "ok"),
                 f"{free:.0f}% free ({st.f_bavail * st.f_frsize / 2**30:.1f} GB)",
                 "delete old logs: sudo find /var/log/mikrotik -name '*.gz' -mtime +30 -delete ; or a bigger disk")
        try:
            mem = dict((l.split(":")[0], int(l.split()[1])) for l in open("/proc/meminfo"))
            avail = mem.get("MemAvailable", 0) / max(mem.get("MemTotal", 1), 1) * 100
            self.add("memory", g, "Memory", "warn" if avail < 10 else "ok", f"{avail:.0f}% free of {mem['MemTotal'] / 2**20:.1f} GB",
                     "too little RAM: close other programs or add RAM (2 GB is enough for ~500 users)")
        except (OSError, ValueError, KeyError):
            pass
        load = os.getloadavg()[0]
        cpus = os.cpu_count() or 1
        self.add("load", g, "CPU load", "warn" if load > cpus * 2 else "ok", f"{load:.2f} ({cpus} CPU)",
                 "the server is overloaded: see 'top'; a DDoS? check Security")
        try:
            pem = open(CERT).read()
            der = ssl.PEM_cert_to_DER_cert(pem)
            rc, out = sh(["openssl", "x509", "-noout", "-enddate", "-in", CERT], 5)
            end = datetime.strptime(out.split("=", 1)[1].strip(), "%b %d %H:%M:%S %Y %Z") if rc == 0 else None
            days = (end - datetime.now(timezone.utc).replace(tzinfo=None)).days if end else None
            self.add("cert", g, "Certificate (WPA-Enterprise, dashboard)",
                     "fail" if days is not None and days < 7 else ("warn" if days is not None and days < 30 else "ok"),
                     f"valid {days} more days" if days is not None else f"{len(der)} bytes",
                     "renew: sudo RENEW_CERT=1 bash install.sh  (then Wi-Fi clients trust the same CA, nothing to change)")
        except (OSError, ValueError, IndexError):
            self.add("cert", g, "Certificate (WPA-Enterprise, dashboard)", "fail", "not found", "re-run the installer")
        rc, out = sh(["timedatectl", "show", "-p", "NTPSynchronized", "--value"], 5)
        if rc == 0:
            self.add("time", g, "Clock in sync", "ok" if out.strip() == "yes" else "warn", "yes" if out.strip() == "yes" else "not synchronized",
                     "sudo timedatectl set-ntp true  (wrong time breaks expiry, reports and certificates)")
        alerts = os.path.exists(f"{CONF_DIR}/alerts.conf") and re.search(r"^(TELEGRAM_CHAT|WHATSAPP_APIKEY|SMTP_HOST)=", open(f"{CONF_DIR}/alerts.conf").read(), re.M)
        self.add("alerts", g, "Alerts to your phone", "ok" if alerts else "warn", "on" if alerts else "off — nobody hears about problems",
                 "dashboard → Settings → Alerts (Telegram / WhatsApp / email)")

    # -------------------------------------------------------------- routers
    def routers(self):
        g = "Routers"
        try:
            nas = self.sql("SELECT nasname, shortname FROM nas ORDER BY nasname")
        except RuntimeError:
            return
        if not nas:
            self.add("routers", g, "Routers", "warn", "no router added", "sudo radius-admin nas add ROUTER_IP NAME  (or dashboard → Routers)")
            return
        try:
            seen = {r[0]: r[1] for r in self.sql(
                "SELECT nasipaddress, MAX(GREATEST(IFNULL(acctupdatetime, acctstarttime), IFNULL(acctstoptime, acctstarttime))) "
                "FROM radacct WHERE acctstarttime > NOW() - INTERVAL 7 DAY GROUP BY nasipaddress")}
        except RuntimeError:
            seen = {}
        for addr, name in nas:
            if "/" in addr:
                hits = [t for ip, t in seen.items() if ip.startswith(addr.split("/")[0].rsplit(".", 1)[0] + ".")]
                self.add(f"router:{addr}", g, f"{name} ({addr})", "ok" if hits else "warn",
                         f"routers in this range, last RADIUS message {max(hits)[:16]}" if hits else "no RADIUS message from this range in 7 days",
                         "a range: routers there must use this server for RADIUS")
                continue
            up = shutil.which("ping") is None or sh(["ping", "-c", "1", "-W", "2", "-q", addr], 6)[0] == 0
            last = seen.get(addr)
            detail = ("answers ping" if up else "does not answer ping") + (f", last login/accounting {last[:16]}" if last else ", no login in 7 days")
            self.add(f"router:{addr}", g, f"{name} ({addr})", "ok" if up else ("warn" if last else "fail"), detail,
                     "router off / cable / VPN down? If it is up: allow ping from this server, and RADIUS 1812/1813 to this server")

    # -------------------------------------------------------------- blocking, router sync, data
    def blocking(self):
        g = "Blocking & data"
        rdir, pdir = f"{STATE_DIR}/router", f"{STATE_DIR}/policies"
        lib = os.environ.get("MLHEALTH_LIB", "/usr/local/lib/mikrotiklover")
        pols = sorted(glob.glob(f"{pdir}/*.txt"))
        pols = [p for p in pols if not p.endswith("/README.txt")]
        try:
            off = {l.strip() for l in open(f"{pdir}/.off", encoding="utf-8") if l.strip()}
        except OSError:
            off = set()
        built = file_age(f"{rdir}/webfilter-policies.rsc")
        newest = min([file_age(p) for p in pols + [f"{pdir}/.off"] if file_age(p) is not None] or [None]) if pols else None
        if built is None:
            self.add("rules", g, "Router rules", "fail", "not built yet", "sudo radius-admin policy build  (or Blocking → Overview → Rebuild now)")
            return
        stale = newest is not None and newest < built                # a policy file newer than the rules
        self.add("rules", g, "Router rules", "warn" if stale else "ok",
                 f"built {age_text(built)}" + (" — a policy changed after that" if stale else ", after the last policy change"),
                 "sudo radius-admin policy build  (or Blocking → Overview → Rebuild now)")
        # the generated RouterOS files must import without errors
        lint = os.path.join(lib, "rsclint.py")
        files = sorted(glob.glob(f"{rdir}/*.rsc"))
        if os.path.exists(lint) and files:
            rc, out = sh([sys.executable, "-I", lint] + files, 60)
            bad = [l for l in out.splitlines() if l and not l.startswith("ok")]
            self.add("rsc", g, "Router scripts", "fail" if rc or bad else "ok",
                     f"{len(files)} file(s) checked, all fine" if not (rc or bad) else f"{len(bad)} problem(s): {bad[0][:160] if bad else out[:160]}",
                     "sudo radius-admin policy build; if it stays, send this to support (the rules would not import on the router)")
        # every policy that is on is in the router file; every category it blocks has names in it
        try:
            rsc = open(f"{rdir}/webfilter-policies.rsc", encoding="utf-8", errors="replace").read()
        except OSError:
            rsc = ""
        missing, empty, tested, wrong = [], [], 0, []
        for p in pols:
            name = os.path.basename(p)[:-4]
            if name in off:
                continue
            text = open(p, encoding="utf-8", errors="replace").read()
            rules = [l.split("#", 1)[0].strip() for l in text.splitlines()]
            rules = [l for l in rules if l]
            if rules and f"jump-target=wfp-{name} " not in rsc:
                missing.append(name)
            for l in rules:
                k, _, v = l.partition(" ")
                v = v.split(" time=")[0].strip()
                if k == "block" and v not in ("keywords",) and f"chain=wf-{v} " in rsc:
                    if rsc.count(f"chain=wf-{v} ") < 2:                  # only the final 'return' rule: nothing blocked
                        empty.append(v)
        # the finder agrees: a sample name of each blocking rule is blocked by the policy (at a time it is active)
        try:
            sys.path.insert(0, lib)
            import whyblocked
            for p in pols:
                name = os.path.basename(p)[:-4]
                if name in off:
                    continue
                text = open(p, encoding="utf-8", errors="replace").read()
                for l in text.splitlines():
                    l = l.split("#", 1)[0].strip()
                    k, _, v = l.partition(" ")
                    v = v.split(" time=")[0].strip()
                    host = None
                    if k == "block" and v not in ("keywords", "custom"):
                        host = next((x.strip().lstrip("*.") for x in open(os.path.join(lib, "webfilter", "categories", v + ".txt"), encoding="utf-8", errors="replace")
                                     if x.strip() and not x.startswith("#") and "*" not in x.strip().lstrip("*.")), None) \
                            if os.path.exists(os.path.join(lib, "webfilter", "categories", v + ".txt")) else None
                    elif k == "block-site" and v:
                        host = "www." + v
                    elif k == "block-word" and v:
                        host = f"test{v.lstrip('^')}.example" if not v.startswith("^") else f"{v[1:]}test.example"
                    if not host:
                        continue
                    t = re.search(r"time=(\S+)", l)
                    at = when_active(t.group(1)) if t else datetime.now()
                    r = whyblocked.explain(host, name, text, at, os.path.join(lib, "webfilter"))
                    tested += 1
                    if r["verdict"] != "blocked":
                        wrong.append(f"{name}: {k} {v} ({host} → {r['verdict']})")
        except Exception as e:  # noqa: BLE001
            wrong.append(f"self-test could not run: {e}")
        on = len([p for p in pols if os.path.basename(p)[:-4] not in off])
        bad = missing + [f"category {c} has no names" for c in sorted(set(empty))] + wrong
        self.add("policies", g, "Policies self-test", "fail" if missing or wrong else ("warn" if empty else "ok"),
                 f"{on} policies on" + (f", {len(off)} off" if off else "") + f", {tested} rules tried: every one blocks its own sample"
                 if not bad else "; ".join(bad[:4]) + (f" … +{len(bad) - 4}" if len(bad) > 4 else ""),
                 "sudo radius-admin policy build; then Blocking → Activity → Why blocked? for the rule named here")
        # did the routers take the rules?
        try:
            ver = open(f"{rdir}/version", encoding="utf-8").read().strip()
        except OSError:
            ver = ""
        try:
            rows = self.sql("SELECT router_ip, what, TIMESTAMPDIFF(SECOND, at, NOW()), version FROM ml_router_fetch ORDER BY router_ip")
        except RuntimeError:
            rows = []
        routers = {}
        for ip, what, age, v in rows:
            routers.setdefault(ip, {})[what] = (int(age), v)
        if not routers:
            self.add("sync", g, "Routers take the rules", "warn", "no router has fetched the auto-sync script yet",
                     "import the auto-sync script on each router once: Blocking → Overview → Router auto-sync")
        for ip, r in sorted(routers.items()):
            age, _ = r.get("version", (10 ** 9, ""))
            s_age, s_ver = r.get("sync", (None, ""))
            if age > 3600:
                self.add(f"sync:{ip}", g, f"Router {ip} takes the rules", "fail",
                         f"last asked for new rules {age_text(age)}" + (f", has version {s_ver[:12]}" if s_ver else ""),
                         "router off, or its scheduler 'mikrotiklover-autosync' stopped / the server address changed — re-import the auto-sync script")
            elif ver and s_ver != ver and age < 1800 and built < 1800:
                self.add(f"sync:{ip}", g, f"Router {ip} takes the rules", "ok", f"asked {age_text(age)}; the newest rules (built {age_text(built)}) come at its next check")
            else:
                self.add(f"sync:{ip}", g, f"Router {ip} takes the rules", "ok" if s_ver == ver or not ver else "warn",
                         f"asked {age_text(age)}, " + ("has the newest rules" if s_ver == ver else f"still has version {s_ver[:12] or '?'} (newest {ver[:12]})"),
                         "the router asks every 15 minutes; if this stays: check the router log for 'mikrotiklover' import errors")
        # data the dashboard needs
        try:
            last = self.sql("SELECT TIMESTAMPDIFF(SECOND, MAX(last_seen), NOW()) FROM ml_app")[0][0]
            age = None if last in ("", "NULL") else int(last)
            self.add("apps", g, "Apps on network (hourly)", "ok" if age is not None and age < 26 * 3600 else "warn",
                     f"last app seen {age_text(age)}" if age is not None else "no app seen yet",
                     "the router must send its DNS log here: sudo radius-admin dnslog on, and the router's DNS must be used by the devices")
        except (RuntimeError, ValueError, IndexError):
            pass
        if sh(["pgrep", "-f", "flowcollector[.]py"])[0] == 0:
            try:
                last = self.sql("SELECT TIMESTAMPDIFF(SECOND, MAX(bucket), NOW()) FROM traffic_site")[0][0]
                age = None if last in ("", "NULL") else int(last)
                self.add("traffic", g, "Traffic data", "ok" if age is not None and age < 3 * 3600 else "warn",
                         f"newest data {age_text(age)}" if age is not None else "no traffic data yet",
                         "the router must send traffic flow to this server (Router setup → Traffic flow)")
            except (RuntimeError, ValueError, IndexError):
                pass

    def firewall(self):
        """Firewall: the country lists its policies need, and port forwards that open risky doors to everyone."""
        g = "Blocking & data"
        n = self.sql("SELECT COUNT(*) FROM ml_fw_rule WHERE enabled=1")[0][0]
        vips = self.sql("SELECT name, port, src FROM ml_fw_vip WHERE enabled=1")
        if n == "0" and not vips:
            return
        try:
            ver = open("/var/lib/mikrotiklover/router/geo.version").read().split()
        except OSError:
            ver = []
        missing = next((x[8:] for x in ver if x.startswith("missing:")), "")
        risky = {3389: "RDP", 445: "SMB", 23: "Telnet", 5900: "VNC", 3306: "MySQL", 1433: "MS-SQL", 8291: "Winbox", 21: "FTP"}
        open_all = [f"{v[0]} ({risky[int(v[1])]})" for v in vips if v[2] in ("", "all") and v[1].isdigit() and int(v[1]) in risky]
        status = "warn" if missing or open_all else "ok"
        detail = f"{n} policies on, {len(vips)} port forward(s)"
        if missing:
            detail += f" — no country list yet for {missing}"
        if open_all:
            detail += f" — open to the whole internet: {', '.join(open_all)}"
        self.add("firewall", g, "Firewall", status, detail,
                 ("Firewall → Countries → Download now (sudo radius-admin firewall geo update). " if missing else "")
                 + ("Firewall → Port forwards → Edit → Allowed from: only the addresses / countries that need it, or use a VPN." if open_all else ""))

    def ips(self):
        """Intrusion prevention: Suricata running, the routers' copy arriving, signatures downloaded."""
        r = self.sql("SELECT v FROM ml_setting WHERE k='ips_on'")
        if not r or r[0][0] != "1":
            return
        g = "Security"
        rc, out = sh([sys.executable, "-I", "/usr/local/lib/mikrotiklover/ips.py", "status"], 30)
        try:
            st = json.loads(out)
        except ValueError:
            self.add("ips", g, "Intrusion prevention", "warn", f"could not check: {out[:120]}")
            return
        cp = st.get("copy", {})
        if not st.get("running"):
            self.add("ips", g, "Intrusion prevention", "fail", "Suricata is not running",
                     "sudo radius-admin ips restart ; if it stops again: see /var/log/suricata/suricata.log")
        elif not cp.get("receiving"):
            self.add("ips", g, "Intrusion prevention", "warn", "running, but no traffic copy from the routers for 5 minutes",
                     "Re-import the auto-sync script on the router; the server IP (Security → Protection & lists) must be right; UDP 37008 to this server must not be blocked")
        elif st.get("rules", 0) < 1000:
            self.add("ips", g, "Intrusion prevention", "warn", f"running, only {st.get('rules', 0)} signatures (Emerging Threats not downloaded)",
                     "sudo radius-admin ips update  (the server needs internet to rules.emergingthreats.net)")
        else:
            self.add("ips", g, "Intrusion prevention", "ok", f"running, {st['rules']} signatures, copy from {', '.join(cp.get('routers', []))}")

    def run(self):
        for f in (self.services, self.jobs, self.system, self.routers, self.blocking, self.firewall, self.ips):
            try:
                f()
            except Exception as e:  # noqa: BLE001 — one broken check must not hide the others
                self.add(f.__name__, "Server", f"check {f.__name__}", "warn", f"could not check: {e}", "")
        return self.out


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    res = Checks(opt("--cnf", f"{CONF_DIR}/my.cnf"), opt("--db", "radius")).run()
    worst = "fail" if any(r["status"] == "fail" for r in res) else ("warn" if any(r["status"] == "warn" for r in res) else "ok")
    doc = {"status": worst, "checked": time.strftime("%Y-%m-%d %H:%M:%S"), "host": socket.gethostname(), "checks": res}
    if "--save" in a:                                     # the hourly check: the dashboard shows it, alerts.py reports changes
        tmp = f"{STATE_DIR}/health.json.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(doc, f)
        os.chmod(tmp, 0o644)
        os.replace(tmp, f"{STATE_DIR}/health.json")
    if "--json" in a:
        print(json.dumps(doc))
    else:
        mark = {"ok": "\033[32m✔\033[0m", "warn": "\033[33m!\033[0m", "fail": "\033[31m✘\033[0m"}
        group = None
        for r in res:
            if r["group"] != group:
                group = r["group"]
                print(f"\n{group}")
            print(f"  {mark[r['status']]} {r['name']}: {r['detail']}")
            if r["fix"]:
                print(f"      → {r['fix']}")
        n = {s: sum(r["status"] == s for r in res) for s in ("ok", "warn", "fail")}
        print(f"\n{n['ok']} ok, {n['warn']} warnings, {n['fail']} problems")
    sys.exit(2 if worst == "fail" else 0)


if __name__ == "__main__":
    main()
