#!/usr/bin/env python3
"""Alerts: Telegram, WhatsApp (CallMeBot) and email (SMTP) messages when something needs attention.

  alerts.py status                       channels, events, last check (JSON)
  alerts.py set                          read KEY=VALUE lines from stdin and save them (empty value = remove)
  alerts.py test [telegram|whatsapp|email]   send a test message
  alerts.py send TITLE [TEXT]            send a message now (also used by radius-admin)
  alerts.py check                        look for new problems and send them (cron, every 5 minutes)
  alerts.py summary [--force]            daily summary (sent by check once a day at SUMMARY_HOUR)
  alerts.py telegram-chats               chats that wrote to the bot (to find the chat id)
  alerts.py log [N]                      last N alerts sent
Common options: --cnf FILE --db NAME (database), --conf FILE (settings), --state FILE.

Events (EVENTS=, comma separated): security quarantine router service jobs disk expiring summary
Settings live in /etc/mikrotiklover-radius/alerts.conf (root only, mode 600).
"""
import json, os, re, shutil, smtplib, socket, ssl, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from email.message import EmailMessage
from email.utils import formatdate, make_msgid

CONF = "/etc/mikrotiklover-radius/alerts.conf"
STATE = "/var/lib/mikrotiklover/alerts-state.json"
UPDATES = "/var/lib/mikrotiklover/updates.txt"
EVENTS = ("security", "quarantine", "router", "service", "jobs", "disk", "expiring", "summary")
DEFAULT_EVENTS = "security,quarantine,router,service,jobs,disk,summary"
KEYS = {
    "TELEGRAM_TOKEN": r"^\d{3,15}:[A-Za-z0-9_-]{20,100}$",
    "TELEGRAM_CHAT": r"^-?\d{1,20}$|^@[A-Za-z0-9_]{4,64}$",
    "TELEGRAM_API": r"^https?://[A-Za-z0-9.:/_-]+$",
    "WHATSAPP_PHONE": r"^\+?\d{8,15}$",
    "WHATSAPP_APIKEY": r"^[A-Za-z0-9_-]{4,64}$",
    "WHATSAPP_API": r"^https?://[A-Za-z0-9.:/_?=&-]+$",
    "EMAIL_TO": r"^[^\s@,]+@[^\s@,]+(,[^\s@,]+@[^\s@,]+){0,9}$",
    "EMAIL_FROM": r"^[^\s@]+@[^\s@]+$",
    "SMTP_HOST": r"^[A-Za-z0-9.-]{1,253}$",
    "SMTP_PORT": r"^\d{1,5}$",
    "SMTP_USER": r"^\S{1,128}$",
    "SMTP_PASS": r"^[^\n]{1,256}$",
    "SMTP_TLS": r"^(starttls|ssl|none)$",
    "EVENTS": r"^[a-z,]*$",
    "SUMMARY_HOUR": r"^([01]?\d|2[0-3])$",
    "SMS_URL": r"^https?://[^\s]{4,500}$",
    "SMS_METHOD": r"^(GET|POST)$",
    "SMS_BODY": r"^[^\n]{1,1000}$",
    "SMS_OK": r"^[^\n]{1,100}$",
    "BRAND": r"^[^\n]{0,64}$",
}
SECRETS = ("TELEGRAM_TOKEN", "WHATSAPP_APIKEY", "SMTP_PASS", "SMS_URL", "SMS_BODY")
SERVICES = [("FreeRADIUS", r"^(/usr/sbin/)?freeradius"), ("MariaDB", r"mariadbd|mysqld"),
            ("DNS logger", r"mikrotiklover.*dnsmasq|dnsmasq.*mikrotiklover"), ("Traffic collector", r"flowcollector[.]py")]
MAX_LINES = 15


# ------------------------------------------------------------------ settings + state
def load_conf(path=CONF):
    c = {}
    try:
        for line in open(path, encoding="utf-8"):
            k, sep, v = line.rstrip("\n").partition("=")
            if sep and k in KEYS:
                c[k] = v
    except OSError:
        pass
    return c


def save_conf(c, path=CONF):
    old = os.umask(0o077)
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            for k in KEYS:
                if c.get(k):
                    f.write(f"{k}={c[k]}\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    finally:
        os.umask(old)


def set_values(c, lines):
    """KEY=VALUE lines -> updated settings; raises ValueError on a bad key or value."""
    for line in lines:
        line = line.rstrip("\r\n")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        k, sep, v = line.partition("=")
        k, v = k.strip(), v.strip()
        if not sep or k not in KEYS:
            raise ValueError(f"unknown setting: {k}")
        if k == "EVENTS":
            bad = [e for e in v.split(",") if e and e not in EVENTS]
            if bad:
                raise ValueError(f"unknown event: {', '.join(bad)} (events: {' '.join(EVENTS)})")
        if v and not re.match(KEYS[k], v):
            raise ValueError(f"invalid {k}")
        if v:
            c[k] = v
        else:
            c.pop(k, None)
    return c


def events(c):
    return [e for e in c.get("EVENTS", DEFAULT_EVENTS).split(",") if e in EVENTS]


def channels(c):
    ch = []
    if c.get("TELEGRAM_TOKEN") and c.get("TELEGRAM_CHAT"):
        ch.append("telegram")
    if c.get("WHATSAPP_PHONE") and c.get("WHATSAPP_APIKEY"):
        ch.append("whatsapp")
    if c.get("EMAIL_TO") and c.get("SMTP_HOST"):
        ch.append("email")
    return ch


def load_state(path=STATE):
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
            return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(s, path=STATE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=1, sort_keys=True)
    os.replace(tmp, path)


# ------------------------------------------------------------------ sending
def http(url, data=None, timeout=20):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "MikrotikLover-alerts"} | (
        {"Content-Type": "application/json"} if data else {}))
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read(4096).decode("utf-8", "replace")


def send_telegram(c, text):
    api = c.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/")
    body = json.dumps({"chat_id": c["TELEGRAM_CHAT"], "text": text[:4000], "disable_web_page_preview": True}).encode()
    try:
        st, out = http(f"{api}/bot{c['TELEGRAM_TOKEN']}/sendMessage", body)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Telegram: {e.code} {e.read(300).decode('utf-8', 'replace')}") from None
    if '"ok":true' not in out.replace(" ", ""):
        raise RuntimeError(f"Telegram: {out[:200]}")


def send_whatsapp(c, text):
    api = c.get("WHATSAPP_API", "https://api.callmebot.com/whatsapp.php")
    q = urllib.parse.urlencode({"phone": c["WHATSAPP_PHONE"], "text": text[:1500], "apikey": c["WHATSAPP_APIKEY"]})
    try:
        st, out = http(api + ("&" if "?" in api else "?") + q)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"WhatsApp: {e.code} {e.read(300).decode('utf-8', 'replace')}") from None
    if re.search(r"APIKey is invalid|ERROR|not allowed", out, re.I):
        raise RuntimeError("WhatsApp: " + re.sub(r"<[^>]+>", " ", out)[:200].strip())


def send_email(c, subject, text):
    m = EmailMessage()
    m["Subject"], m["From"], m["To"] = subject, c.get("EMAIL_FROM") or c.get("SMTP_USER") or f"mikrotiklover@{socket.gethostname()}", c["EMAIL_TO"]
    m["Date"], m["Message-ID"] = formatdate(localtime=True), make_msgid("alert")
    m.set_content(text)
    tls, port = c.get("SMTP_TLS", "starttls"), int(c.get("SMTP_PORT") or (465 if c.get("SMTP_TLS") == "ssl" else 587))
    ctx = ssl.create_default_context()
    try:
        s = smtplib.SMTP_SSL(c["SMTP_HOST"], port, timeout=20, context=ctx) if tls == "ssl" else smtplib.SMTP(c["SMTP_HOST"], port, timeout=20)
        with s:
            if tls == "starttls":
                s.starttls(context=ctx)
            if c.get("SMTP_USER"):
                s.login(c["SMTP_USER"], c.get("SMTP_PASS", ""))
            s.send_message(m)
    except (OSError, smtplib.SMTPException) as e:
        raise RuntimeError(f"Email: {e}") from None


def send_sms(c, phone, text):
    """Users' SMS / WhatsApp gateway (any provider with an HTTP API). In SMS_URL / SMS_BODY:
    {phone} {phone0} (03001234567 style) {text}. SMS_BODY starting with "{" is sent as JSON."""
    if not c.get("SMS_URL"):
        raise RuntimeError("SMS gateway is not set up")
    if not re.match(r"^\+?\d{8,15}$", phone):
        raise RuntimeError(f"invalid phone number {phone}")
    p0 = "0" + phone[3:] if phone.startswith("+92") else phone.lstrip("+")
    url_v = {"{phone}": urllib.parse.quote(phone), "{phone0}": urllib.parse.quote(p0), "{text}": urllib.parse.quote(text)}
    url = c["SMS_URL"]
    for k, v in url_v.items():
        url = url.replace(k, v)
    data, ctype = None, None
    if c.get("SMS_METHOD", "GET") == "POST":
        b = c.get("SMS_BODY", "")
        if b.lstrip().startswith("{"):
            for k, v in (("{phone}", phone), ("{phone0}", p0), ("{text}", text)):
                b = b.replace(k, json.dumps(v)[1:-1])
            ctype = "application/json"
        else:
            for k, v in url_v.items():
                b = b.replace(k, v)
            ctype = "application/x-www-form-urlencoded"
        data = b.encode()
    req = urllib.request.Request(url, data=data, headers={"User-Agent": "MikrotikLover-alerts", **({"Content-Type": ctype} if ctype else {})})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out = r.read(2000).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"SMS gateway: {e.code} {e.read(200).decode('utf-8', 'replace')}") from None
    except OSError as e:
        raise RuntimeError(f"SMS gateway: {e}") from None
    if c.get("SMS_OK") and not re.search(c["SMS_OK"], out, re.I):
        raise RuntimeError("SMS gateway said: " + re.sub(r"\s+", " ", out)[:150])
    return out[:200]


def deliver(c, title, text, only=None):
    """Send to every set-up channel (or only one); -> {channel: 'ok' | error}."""
    brand = c.get("BRAND") or os.environ.get("ML_BRAND") or "MikrotikLover"
    stamp = time.strftime("%Y-%m-%d %H:%M")
    full = f"{title}\n\n{text}\n\n— {brand} · {socket.gethostname()} · {stamp}" if text else f"{title}\n\n— {brand} · {socket.gethostname()} · {stamp}"
    res = {}
    for ch in channels(c):
        if only and ch != only:
            continue
        try:
            if ch == "telegram":
                send_telegram(c, full)
            elif ch == "whatsapp":
                send_whatsapp(c, full)
            else:
                send_email(c, f"[{brand}] {title}", full)
            res[ch] = "ok"
        except Exception as e:  # noqa: BLE001 — one broken channel must not stop the others
            res[ch] = str(e)[:200] or e.__class__.__name__
    return res


# ------------------------------------------------------------------ database
class DB:
    def __init__(self, cnf, db):
        self.cnf, self.db = cnf, db

    def rows(self, q):
        if not self.cnf:
            return []
        p = subprocess.run(["mysql", f"--defaults-extra-file={self.cnf}", "--default-character-set=utf8mb4", "-N", "-B", self.db, "-e", q],
                           capture_output=True, text=True, timeout=60)
        if p.returncode:
            raise RuntimeError(p.stderr.strip()[:200])
        return [l.split("\t") for l in p.stdout.splitlines()]

    def run(self, q):
        if self.cnf:
            self.rows(q)


def esc(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def record(db, kind, title, text, res):
    summary = ", ".join(f"{k}: {v}" for k, v in res.items()) or "no channel set up"
    try:
        db.run("INSERT INTO ml_alert (kind, title, text, result) VALUES "
               f"({esc(kind[:32])},{esc(title[:255])},{esc(text[:4000])},{esc(summary[:255])})")
    except (RuntimeError, OSError, subprocess.SubprocessError) as e:
        print(f"alerts: could not record: {e}", file=sys.stderr)


# ------------------------------------------------------------------ checks
def ping(host):
    if not shutil.which("ping"):
        return True
    return subprocess.run(["ping", "-c", "2", "-W", "2", "-q", host], capture_output=True, timeout=15).returncode == 0


def running(pattern):
    return subprocess.run(["pgrep", "-f", pattern], capture_output=True, timeout=5).returncode == 0


def updown(state, key, ok, need=2):
    """Counts failed checks; -> 'down' after `need` failures in a row, 'up' when it comes back."""
    st = state.setdefault("updown", {})
    v = st.get(key, {"fail": 0, "alerted": False, "seen": False})
    out = None
    if ok:
        if v["alerted"]:
            out = "up"
        v = {"fail": 0, "alerted": False, "seen": True}
    else:
        v["fail"] += 1
        if v["fail"] >= need and not v["alerted"] and v.get("seen", True):
            v["alerted"], out = True, "down"
    st[key] = v
    return out


def once(state, key, ttl):
    """True the first time a key is seen within ttl seconds (dedupe)."""
    sent, now = state.setdefault("sent", {}), time.time()
    for k in [k for k, t in sent.items() if now - t > 7 * 86400]:
        del sent[k]
    if key in sent and now - sent[key] < ttl:
        return False
    sent[key] = now
    return True


def check(c, db, state, now=None, ping_fn=ping, running_fn=running, updates=UPDATES, disk_path="/"):
    """-> list of (kind, line) for every new problem."""
    now = now or time.time()
    ev, found = events(c), []
    since = state.get("last_check") or now - 900
    since_sql = esc(time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(since)))
    if "security" in ev:
        for cat, typ, src, user, detail, hits, day in db.rows(
                "SELECT category, type, src_ip, username, detail, hits, day FROM ml_security_event "
                f"WHERE severity='high' AND last_seen >= {since_sql} ORDER BY last_seen DESC LIMIT 50"):
            if once(state, f"sec:{day}:{cat}:{typ}:{src}", 86400):
                who = f"{src}" + (f" ({user})" if user else "")
                found.append(("security", f"🔴 {cat.upper()}: {typ} — {who}, {hits} hits. {detail}".strip()))
    if "quarantine" in ev:
        last = int(state.get("quarantine_id", 0))
        rows = db.rows(f"SELECT id, ip, username, reason, auto FROM ml_quarantine WHERE id > {last} ORDER BY id LIMIT 50")
        if "quarantine_id" not in state and rows:   # first run: do not report old ones
            rows = []
            state["quarantine_id"] = int(db.rows("SELECT IFNULL(MAX(id),0) FROM ml_quarantine")[0][0])
        for qid, ip, user, reason, auto in rows:
            state["quarantine_id"] = max(int(qid), int(state.get("quarantine_id", 0)))
            found.append(("quarantine", f"🚫 Quarantined {'automatically' if auto == '1' else 'by an admin'}: {user or ip} — {reason}"))
        state.setdefault("quarantine_id", 0)
    if "router" in ev:
        for addr, name in db.rows("SELECT nasname, shortname FROM nas ORDER BY nasname"):
            if "/" in addr or not re.match(r"^[A-Za-z0-9.:-]+$", addr):
                continue   # a subnet / range has no single address to check
            r = updown(state, f"router:{addr}", ping_fn(addr))
            if r == "down":
                found.append(("router", f"📡 Router DOWN: {name} ({addr}) does not answer"))
            elif r == "up":
                found.append(("router", f"✅ Router back: {name} ({addr})"))
    if "service" in ev:
        for name, pat in SERVICES:
            r = updown(state, f"service:{name}", running_fn(pat))
            if r == "down":
                found.append(("service", f"⚙️ Service stopped: {name}"))
            elif r == "up":
                found.append(("service", f"✅ Service running again: {name}"))
    if "jobs" in ev:
        try:
            for line in open(updates, encoding="utf-8"):
                p = line.rstrip("\n").split("\t")
                if len(p) >= 3 and p[2].startswith("failed") and once(state, f"job:{p[0]}:{p[1]}", 30 * 86400):
                    found.append(("jobs", f"⚠️ {p[0]} failed ({p[1]}): {p[2][7:].strip()[:150]}"))
        except OSError:
            pass
    if "disk" in ev:
        st = os.statvfs(disk_path)
        free = st.f_bavail / st.f_blocks * 100 if st.f_blocks else 100
        if free < 10 and once(state, "disk", 12 * 3600):
            found.append(("disk", f"💾 Disk almost full: {free:.0f}% free ({st.f_bavail * st.f_frsize / 2**30:.1f} GB)"))
    if "expiring" in ev:
        for user, exp in db.rows("SELECT username, expires_at FROM ml_account WHERE expires_at > NOW() "
                                 "AND expires_at <= NOW() + INTERVAL 1 DAY ORDER BY expires_at LIMIT 100"):
            if once(state, f"exp:{user}:{exp}", 3 * 86400):
                found.append(("expiring", f"⏳ {user} expires {exp[:16]}"))
    state["last_check"] = now
    return found


def compose(found):
    """Many problems in one check -> one message."""
    if len(found) == 1:
        kind, line = found[0]
        return kind, line, ""
    lines = [l for _, l in found[:MAX_LINES]]
    if len(found) > MAX_LINES:
        lines.append(f"… and {len(found) - MAX_LINES} more (dashboard → Security / Settings)")
    kinds = sorted({k for k, _ in found})
    names = {"security": "security", "quarantine": "quarantine", "router": "routers", "service": "services",
             "jobs": "jobs", "disk": "disk", "expiring": "expiring users"}
    return ",".join(kinds), f"{len(found)} alerts: " + ", ".join(names.get(k, k) for k in kinds), "\n".join(lines)


def summary_text(db):
    one = lambda q, d="0": (db.rows(q) or [[d]])[0][0]  # noqa: E731
    online = one("SELECT COUNT(DISTINCT username) FROM radacct WHERE acctstoptime IS NULL")
    users = one("SELECT COUNT(DISTINCT username) FROM radacct WHERE acctstarttime >= CURDATE() OR acctstoptime IS NULL OR acctstoptime >= CURDATE()")
    data = one("SELECT IFNULL(SUM(acctinputoctets + acctoutputoctets), 0) FROM radacct WHERE acctstarttime >= CURDATE() OR acctstoptime IS NULL OR acctstoptime >= CURDATE()")
    sales = db.rows("SELECT COUNT(*), IFNULL(SUM(amount),0) FROM ml_sale WHERE at >= CURDATE()") or [["0", "0"]]
    sec = db.rows("SELECT category, COUNT(*) FROM ml_security_event WHERE day = CURDATE() GROUP BY category")
    quar = one("SELECT COUNT(*) FROM ml_quarantine WHERE released_at IS NULL")
    apps = db.rows("SELECT a.app, SUM(d.queries) q FROM ml_app_day d JOIN ml_app a ON a.site = d.site "
                   "WHERE d.day = CURDATE() GROUP BY a.app ORDER BY q DESC LIMIT 5")
    cur = one("SELECT v FROM ml_setting WHERE k='currency'", "")
    lines = [f"👥 Users today: {users} (online now: {online})",
             f"📶 Data today: {int(data) / 2**30:.1f} GB",
             f"💰 Sales today: {sales[0][0]} ({cur + ' ' if cur else ''}{float(sales[0][1]):,.0f})",
             "🛡 Security today: " + (", ".join(f"{c} {n}" for c, n in sec) if sec else "nothing found"),
             f"🚫 Quarantined now: {quar}"]
    if apps:
        lines.append("📱 Top apps: " + ", ".join(a for a, _ in apps))
    return "\n".join(lines)


def summary_due(c, state, now):
    if "summary" not in events(c):
        return False
    lt = time.localtime(now)
    return lt.tm_hour >= int(c.get("SUMMARY_HOUR", "21")) and state.get("summary_day") != time.strftime("%Y-%m-%d", lt)


# ------------------------------------------------------------------ main
def mask(c):
    out = {}
    for k, v in c.items():
        out[k] = ("•" * 6 + v[-3:]) if k in SECRETS and v else v
    return out


def main():
    a = sys.argv[1:]
    opt = lambda k, d: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    conf, statef = opt("--conf", CONF), opt("--state", STATE)
    db = DB(opt("--cnf", ""), opt("--db", "radius"))
    pos = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] not in ("--conf", "--state", "--cnf", "--db"))]
    cmd = pos[0] if pos else "status"
    c = load_conf(conf)
    if cmd == "status":
        st = load_state(statef)
        info = {"channels": channels(c), "events": events(c), "sms": bool(c.get("SMS_URL")), "sms_method": c.get("SMS_METHOD", "GET"), "all_events": list(EVENTS),
                "summary_hour": int(c.get("SUMMARY_HOUR", "21")), "settings": mask(c),
                "last_check": time.strftime("%Y-%m-%d %H:%M", time.localtime(st["last_check"])) if st.get("last_check") else ""}
        if "--json" in a:
            print(json.dumps(info))
        else:
            m = info["settings"]
            print("Telegram : " + (f"chat {m['TELEGRAM_CHAT']} (bot {m['TELEGRAM_TOKEN']})" if "telegram" in info["channels"] else "off"))
            print("WhatsApp : " + (m["WHATSAPP_PHONE"] if "whatsapp" in info["channels"] else "off"))
            print("Email    : " + (f"{m['EMAIL_TO']} via {m['SMTP_HOST']}:{m.get('SMTP_PORT', '587')} ({m.get('SMTP_TLS', 'starttls')})" if "email" in info["channels"] else "off"))
            print("Events   : " + " ".join(info["events"]) + f"   (daily summary at {info['summary_hour']}:00)")
            print("Checked  : " + (info["last_check"] or "never (cron runs it every 5 minutes)"))
            print("User SMS : " + (f"{c.get('SMS_METHOD', 'GET')} gateway set" if c.get("SMS_URL") else "off (radius-admin notice sms ...)"))
    elif cmd == "set":
        try:
            save_conf(set_values(c, sys.stdin.readlines()), conf)
        except ValueError as e:
            sys.exit(f"ERROR: {e}")
        print(f"Alerts saved — channels: {', '.join(channels(load_conf(conf))) or 'none yet'}")
    elif cmd in ("test", "send"):
        only = pos[1] if cmd == "test" and len(pos) > 1 else None
        if only and only not in ("telegram", "whatsapp", "email"):
            sys.exit("ERROR: channel must be telegram, whatsapp or email")
        if not channels(c) or (only and only not in channels(c)):
            sys.exit(f"ERROR: {only or 'no channel'} is not set up (radius-admin alerts telegram|whatsapp|email ...)")
        if cmd == "test":
            title, text = "✅ Test alert", "Alerts from your RADIUS server work."
        else:
            title, text = (pos[1] if len(pos) > 1 else "Alert"), (pos[2] if len(pos) > 2 else "")
        res = deliver(c, title, text, only)
        record(db, "test" if cmd == "test" else "manual", title, text, res)
        for ch, r in res.items():
            print(f"{ch}: {r}")
        if any(r != "ok" for r in res.values()):
            sys.exit(1)
    elif cmd == "check":
        state = load_state(statef)
        found = check(c, db, state)
        sent = 0
        if found and channels(c):
            kind, title, text = compose(found)
            res = deliver(c, title, text)
            record(db, kind, title, text, res)
            sent = len(found)
        now = time.time()
        if summary_due(c, state, now) and channels(c):
            text = summary_text(db)
            res = deliver(c, "📊 Daily summary", text)
            record(db, "summary", "📊 Daily summary", text, res)
            state["summary_day"] = time.strftime("%Y-%m-%d", time.localtime(now))
        save_state(state, statef)
        print(f"alerts: {len(found)} new, {sent} sent" + ("" if channels(c) else " (no channel set up)"))
    elif cmd == "summary":
        text = summary_text(db)
        if channels(c):
            res = deliver(c, "📊 Daily summary", text)
            record(db, "summary", "📊 Daily summary", text, res)
            print("\n".join(f"{k}: {v}" for k, v in res.items()))
        else:
            print(text)
    elif cmd == "sms":
        if len(pos) < 3:
            sys.exit("usage: alerts.py sms PHONE TEXT")
        try:
            send_sms(c, pos[1], pos[2])
            print(f"sms: ok ({pos[1]})")
        except RuntimeError as e:
            sys.exit(f"ERROR: {e}")
    elif cmd == "telegram-chats":
        if not c.get("TELEGRAM_TOKEN"):
            sys.exit("ERROR: set the bot token first: radius-admin alerts telegram TOKEN")
        api = c.get("TELEGRAM_API", "https://api.telegram.org").rstrip("/")
        try:
            _, out = http(f"{api}/bot{c['TELEGRAM_TOKEN']}/getUpdates")
            chats = {}
            for u in json.loads(out).get("result", []):
                m = u.get("message") or u.get("channel_post") or u.get("my_chat_member") or {}
                ch = m.get("chat") or {}
                if "id" in ch:
                    chats[ch["id"]] = ch.get("title") or " ".join(x for x in (ch.get("first_name"), ch.get("last_name")) if x) or ch.get("username", "")
        except (OSError, ValueError) as e:
            sys.exit(f"ERROR: Telegram: {e}")
        if not chats:
            print("No chat yet — open your bot in Telegram, press Start (or send any message), then run this again.")
        for i, n in chats.items():
            print(f"{i}\t{n}")
    elif cmd == "log":
        n = int(pos[1]) if len(pos) > 1 and pos[1].isdigit() else 30
        for r in db.rows(f"SELECT at, kind, title, result FROM ml_alert ORDER BY id DESC LIMIT {min(n, 1000)}"):
            print("\t".join(r))
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
