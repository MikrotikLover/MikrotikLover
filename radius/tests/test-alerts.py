#!/usr/bin/env python3
"""Offline tests for alerts (tools/alerts.py): settings, dedupe, up/down, checks, and real sending
to a local fake Telegram / CallMeBot (HTTP) and SMTP server."""
import base64, json, os, socketserver, sys, tempfile, threading, time, urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
import alerts  # noqa: E402

fails = 0


def check(name, cond, got=None):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond or got is None else f"\n     got: {got}"))
    fails += 0 if cond else 1


# ------------------------------------------------------------------ fake servers
got = []
TOKEN = "123456789:AAFakeTokenForTestingOnly_abcdefghij"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def reply(self, code, body):
        b = body.encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path == "/smsjson":
            d = json.loads(body)
            got.append(("smsjson", d["number"], d["message"], self.headers.get("Content-Type")))
            return self.reply(200, '{"status":"sent"}')
        if self.path == f"/bot{TOKEN}/sendDocument":
            got.append(("telegram-doc", b"%PDF-1.4" in body and b'name="document"; filename="r.pdf"' in body, body.count(b"name=\"caption\"")))
            return self.reply(200, '{"ok":true}')
        if self.path == f"/bot{TOKEN}/sendMessage":
            d = json.loads(body)
            got.append(("telegram", d["chat_id"], d["text"]))
            return self.reply(200, '{"ok":true}')
        self.reply(401, '{"ok":false,"description":"Unauthorized"}')

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/wa":
            if q.get("apikey") != "123456":
                return self.reply(200, "<p>APIKey is invalid</p>")
            got.append(("whatsapp", q["phone"], q["text"]))
            return self.reply(200, "<p>Message queued</p>")
        if u.path == "/sms":
            got.append(("sms", q.get("to"), q.get("msg")))
            return self.reply(200, "OK queued" if q.get("key") == "K1" else "ERROR bad key")
        if u.path == f"/bot{TOKEN}/getUpdates":
            return self.reply(200, json.dumps({"ok": True, "result": [{"message": {"chat": {"id": 42, "first_name": "Ali"}}}]}))
        self.reply(404, "{}")


class SMTP(socketserver.StreamRequestHandler):
    def w(self, s):
        self.wfile.write((s + "\r\n").encode())

    def handle(self):
        self.w("220 fake")
        m = {}
        while True:
            line = self.rfile.readline().decode().rstrip("\r\n")
            if not line:
                return
            c = line.split(" ")[0].upper()
            if c == "EHLO":
                self.w("250-fake\r\n250 AUTH PLAIN")
            elif c == "AUTH":
                user, pw = base64.b64decode(line.split(" ")[2]).split(b"\0")[1:]
                m["user"] = user.decode()
                self.w("235 ok" if pw == b"SmtpPass123" else "535 no")
            elif c == "DATA":
                self.w("354 go")
                data = []
                while (l := self.rfile.readline().decode()).rstrip("\r\n") != ".":
                    data.append(l)
                got.append(("email", m.get("user"), "".join(data)))
                self.w("250 ok")
            elif c == "QUIT":
                self.w("221 bye")
                return
            else:
                self.w("250 ok")


class TS(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


http_srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
smtp_srv = TS(("127.0.0.1", 0), SMTP)
for s in (http_srv, smtp_srv):
    threading.Thread(target=s.serve_forever, daemon=True).start()
HP, SP = http_srv.server_address[1], smtp_srv.server_address[1]

# ------------------------------------------------------------------ settings
c = alerts.set_values({}, [f"TELEGRAM_TOKEN={TOKEN}", "TELEGRAM_CHAT=42", f"TELEGRAM_API=http://127.0.0.1:{HP}",
                           "WHATSAPP_PHONE=+923001234567", "WHATSAPP_APIKEY=123456", f"WHATSAPP_API=http://127.0.0.1:{HP}/wa",
                           "EMAIL_TO=owner@example.com", "SMTP_HOST=127.0.0.1", f"SMTP_PORT={SP}", "SMTP_USER=bot@example.com",
                           "SMTP_PASS=SmtpPass123", "SMTP_TLS=none", "# comment", ""])
check("settings: all three channels on", alerts.channels(c) == ["telegram", "whatsapp", "email"])
for bad in ("TELEGRAM_TOKEN=nope", "WHATSAPP_PHONE=12", "EVENTS=security,foo", "SUMMARY_HOUR=24", "SMTP_TLS=maybe", "X=1", "EMAIL_TO=a b@c"):
    try:
        alerts.set_values(dict(c), [bad])
        check(f"settings: {bad} refused", False)
    except ValueError:
        check(f"settings: {bad} refused", True)
check("settings: empty value removes it", "WHATSAPP_PHONE" not in alerts.set_values(dict(c), ["WHATSAPP_PHONE="]))
check("settings: default events", alerts.events({}) == ["security", "quarantine", "router", "service", "jobs", "disk", "anomaly", "requests", "newapp", "health", "summary", "weekly", "monthly"])
m = alerts.mask(c)
check("status hides secrets", TOKEN not in json.dumps(m) and "SmtpPass123" not in json.dumps(m) and m["TELEGRAM_CHAT"] == "42")
d = tempfile.mkdtemp()
alerts.save_conf(c, f"{d}/a.conf")
check("settings file: mode 600, read back", oct(os.stat(f"{d}/a.conf").st_mode & 0o777) == "0o600" and alerts.load_conf(f"{d}/a.conf") == c)

# ------------------------------------------------------------------ sending
res = alerts.deliver(c, "Test title", "line one")
check("deliver: telegram, whatsapp and email ok", res == {"telegram": "ok", "whatsapp": "ok", "email": "ok"})
check("telegram got title + text", any(g[0] == "telegram" and g[1] == "42" and "Test title" in g[2] and "line one" in g[2] for g in got))
check("whatsapp got it", any(g[0] == "whatsapp" and g[1] == "+923001234567" and "Test title" in g[2] for g in got))
check("email logged in and sent", any(g[0] == "email" and g[1] == "bot@example.com" and "Subject: [MikrotikLover] Test title" in g[2] for g in got))
bad = dict(c, WHATSAPP_APIKEY="999999", SMTP_PASS="wrong", TELEGRAM_TOKEN="123456789:AAWrongTokenForTestingOnly_abcdefghij")
res = alerts.deliver(bad, "x", "y")
check("deliver: every broken channel reported, none stops the others",
      res["telegram"].startswith("Telegram: 401") and "invalid" in res["whatsapp"] and res["email"].startswith("Email:"))
check("deliver: only one channel", list(alerts.deliver(c, "x", "", only="whatsapp")) == ["whatsapp"])
os.environ["ML_BRAND"] = "Lover Net"
got.clear()
alerts.deliver(c, "Branded", "", only="telegram")
check("brand name in the message", "Lover Net" in got[-1][2])

# ------------------------------------------------------------------ SMS to users (any HTTP gateway)
got.clear()
sc = {"SMS_URL": f"http://127.0.0.1:{HP}/sms?key=K1&to={{phone0}}&msg={{text}}", "SMS_OK": "^OK"}
alerts.send_sms(sc, "+923001234567", "Aap ka package \"kal\" & khatam")
check("sms GET: 03.. number and the text arrive", got[-1] == ("sms", "03001234567", 'Aap ka package "kal" & khatam'))
try:
    alerts.send_sms(dict(sc, SMS_URL=sc["SMS_URL"].replace("K1", "K2")), "+923001234567", "x")
    check("sms: gateway's error answer -> failure", False)
except RuntimeError as e:
    check("sms: gateway's error answer -> failure", "bad key" in str(e))
alerts.send_sms({"SMS_URL": f"http://127.0.0.1:{HP}/smsjson", "SMS_METHOD": "POST", "SMS_BODY": '{"number":"{phone}","message":"{text}"}'},
                "+923001234567", 'quote " and \\ backslash')
check("sms POST JSON: valid JSON with quotes", got[-1] == ("smsjson", "+923001234567", 'quote " and \\ backslash', "application/json"))
for bad in ("12", "+92 300", "abc"):
    try:
        alerts.send_sms(sc, bad, "x")
        check(f"sms: bad number {bad} refused", False)
    except RuntimeError:
        check(f"sms: bad number {bad} refused", True)

# ------------------------------------------------------------------ dedupe + up/down
st = {}
check("once: first time yes, again no", alerts.once(st, "k", 60) and not alerts.once(st, "k", 60))
st["sent"]["k"] -= 120
check("once: again after the time is over", alerts.once(st, "k", 60))
st = {}
seq = [alerts.updown(st, "r", ok) for ok in (True, False, False, False, True, True)]
check("updown: down after 2 failed checks, once; up once", seq == [None, None, "down", None, "up", None])
st = {}
check("updown: never seen up -> no alert", [alerts.updown(st, "r", False) for _ in range(4)] == [None] * 4)

# ------------------------------------------------------------------ check() with a fake database
class FakeDB:
    def __init__(self):
        self.sec, self.quar, self.nas, self.acc = [], [], [], []

    def rows(self, q):
        if "ml_security_event" in q:
            return self.sec
        if "MAX(id)" in q:
            return [[str(max([int(r[0]) for r in self.quar] or [0]))]]
        if "ml_quarantine" in q:
            last = int(q.split("id > ")[1].split()[0])
            return [r for r in self.quar if int(r[0]) > last]
        if "FROM nas" in q:
            return self.nas
        if "ml_account" in q:
            return self.acc
        return []

    def run(self, q):
        pass


db, st = FakeDB(), {}
up = {"10.0.0.1": True}
svc = {p: True for _, p in alerts.SERVICES}
upd = f"{d}/updates.txt"
open(upd, "w").write("App catalog\t2026-10-16 23:37\tok: done\n")
cfg = {"EVENTS": "security,quarantine,router,service,jobs,disk,expiring"}
db.quar = [["5", "10.0.0.50", "", "old", "0"]]
db.nas = [["10.0.0.1", "office"], ["10.0.0.0/24", "subnet"]]
run = lambda: alerts.check(cfg, db, st, ping_fn=lambda h: up[h], running_fn=lambda p: svc[p], updates=upd)  # noqa: E731
check("first check: nothing old is reported", run() == [])
db.sec = [["virus", "Botnet C2", "10.0.0.7", "sara", "talks to a botnet server", "40", "2026-10-17"]]
db.quar.append(["6", "10.0.0.7", "sara", "virus: Botnet C2", "1"])
f = run()
check("new HIGH virus + auto quarantine reported", [k for k, _ in f] == ["security", "quarantine"]
      and "sara" in f[0][1] and "automatically" in f[1][1])
check("same virus next check: not again", run() == [])
up["10.0.0.1"] = False
svc[alerts.SERVICES[0][1]] = False
check("one failed check: no alert yet", run() == [])
f = run()
check("router + FreeRADIUS down after 2 checks", sorted(k for k, _ in f) == ["router", "service"] and any("office" in l for _, l in f))
check("still down: no repeat", run() == [])
up["10.0.0.1"] = True
svc[alerts.SERVICES[0][1]] = True
f = run()
check("both back: 'back' messages", len(f) == 2 and all("✅" in l for _, l in f))
open(upd, "a").write("Off-site backup\t2026-10-17 02:43\tfailed: upload to x failed\n")
f = run()
check("failed job reported once", len(f) == 1 and "Off-site backup failed" in f[0][1] and run() == [])
db.acc = [["ali", "2026-10-17 20:00:00"]]
check("expiring user reported once", [k for k, _ in run()] == ["expiring"] and run() == [])
cfg2 = {"EVENTS": "jobs"}
open(upd, "a").write("Security scan\t2026-10-17 03:00\tfailed: x\n")
check("events switched off are not checked", [k for k, _ in alerts.check(cfg2, db, st, updates=upd)] == ["jobs"])

# new apps (apps inventory) with the kind of devices; health check problems from the hourly self-check
class AppDB(FakeDB):
    def __init__(self):
        super().__init__()
        self.apps = []

    def rows(self, q):
        if "DATE_FORMAT(NOW()" in q:
            return [["2026-10-22 10:00:00"]]
        if "FROM ml_app a" in q:
            since = q.split("a.first_seen > '")[1].split("'")[0]
            return [r for r in self.apps if r[3] > since]
        return super().rows(q)


dba, sta = AppDB(), {}
check("new apps: the first check only remembers", alerts.check({"EVENTS": "newapp"}, dba, sta) == [])
dba.apps = [["zingclips.in", "Zing Clips", "video", "2026-10-22 10:30:00", "3", "2", "1"]]
f = alerts.check({"EVENTS": "newapp"}, dba, sta)
check("new app reported with Android / iPhone devices", len(f) == 1 and "Zing Clips" in f[0][1] and "2 Android" in f[0][1] and "1 iPhone" in f[0][1], f)
check("  ... once", alerts.check({"EVENTS": "newapp"}, dba, sta) == [])
hj = f"{d}/health.json"
alerts.HEALTH = hj
json.dump({"checks": [{"id": "sync:10.0.0.1", "name": "Router 10.0.0.1 takes the rules", "status": "fail", "detail": "last asked 3 h ago", "fix": "re-import"}]}, open(hj, "w"))
sth = {}
f = alerts.check({"EVENTS": "health"}, FakeDB(), sth)
check("health: a failing check is told at once, with how to fix", len(f) == 1 and "takes the rules" in f[0][1] and "Fix: re-import" in f[0][1], f)
check("  ... not again while it stays", alerts.check({"EVENTS": "health"}, FakeDB(), sth) == [])
json.dump({"checks": [{"id": "sync:10.0.0.1", "name": "Router 10.0.0.1 takes the rules", "status": "ok", "detail": "fine", "fix": ""}]}, open(hj, "w"))
f = alerts.check({"EVENTS": "health"}, FakeDB(), sth)
check("  ... and 'fine again' when it is fixed", len(f) == 1 and "Fine again" in f[0][1], f)
os.utime(hj, (time.time() - 5 * 3600, time.time() - 5 * 3600))
check("health: an old saved check is not used", alerts.check({"EVENTS": "health"}, FakeDB(), {}) == [])

# ransomware: several small signs of one device add up to one 'act now' alert; the other alerts still work
class RansomDB(FakeDB):
    def rows(self, q):
        if "category IN ('ransomware','virus')" in q:
            return [["10.0.0.90", "pc-hr", "Tor network (hidden servers)", "medium", "2026-10-22 09:00"],
                    ["10.0.0.90", "", "Spreading inside the LAN (SMB)", "high", "2026-10-22 09:05"],
                    ["10.0.0.90", "", "Unusual upload (much more than this device's usual)", "medium", "2026-10-22 09:10"]]
        return super().rows(q)


dbr, str_ = RansomDB(), {"security_init": 1, "quarantine_id": 0}
dbr.quar = [["9", "10.0.0.91", "", "virus: x", "1"]]
f = alerts.check({"EVENTS": "security,quarantine"}, dbr, str_)
rw = [l for k, l in f if "RANSOMWARE RISK" in l]
check("ransomware: signs of one device add up to one 'act now' alert (score, stages, user)", len(rw) == 1 and "10.0.0.90 (pc-hr)" in rw[0]
      and "contact, spread, steal" in rw[0], f)
check("  ... the quarantine alert in the same check still comes", any(k == "quarantine" for k, _ in f), f)
check("  ... the ransomware alert once a day", not any("RANSOMWARE RISK" in l for _, l in alerts.check({"EVENTS": "security"}, dbr, str_)))

# security events are written by the hourly scan with the time they happened (before the last check)
db3, st3 = FakeDB(), {"last_check": time.time()}
db3.sec = [["attack", "Old event", "10.0.0.8", "", "x", "3", "2026-10-17"]]
check("first check: events already there are only remembered", [k for k, _ in alerts.check({"EVENTS": "security"}, db3, st3)] == [])
db3.sec.append(["attack", "Fake DHCP server (rogue router on the LAN)", "192.168.88.250", "NULL", "device 00:0C", "1", "2026-10-17"])
f = alerts.check({"EVENTS": "security"}, db3, st3)
check("late-written event is still sent, once; NULL user not shown", len(f) == 1 and "— 192.168.88.250," in f[0][1] and "NULL" not in f[0][1]
      and alerts.check({"EVENTS": "security"}, db3, st3) == [])

# unusual data use (10x a normal day)
import datetime as _dt
class TrafficDB(FakeDB):
    def rows(self, q):
        if "FROM traffic_site" in q and "DATE(bucket)" in q:
            today = _dt.date.today()
            out = [((today - _dt.timedelta(days=i)).isoformat(), "sara", str(200 * 2**20)) for i in range(2, 12)]
            out.append(((today - _dt.timedelta(days=1)).isoformat(), "sara", str(3 * 2**30)))      # ~15x
            out += [((today - _dt.timedelta(days=i)).isoformat(), "ali", str(2 * 2**30)) for i in range(0, 12)]   # always big
            out.append((today.isoformat(), "newbie", str(5 * 2**30)))                              # no history
            return out
        return []
tdb, tst = TrafficDB(), {}
f = alerts.check({"EVENTS": "anomaly"}, tdb, tst)
check("anomaly: 15x a normal day reported; steady heavy user and new user not", len(f) == 1 and f[0][0] == "anomaly" and "sara" in f[0][1] and "15x" in f[0][1])
check("anomaly: once", alerts.check({"EVENTS": "anomaly"}, tdb, tst) == [])
mon = time.mktime((2026, 10, 19, 21, 30, 0, 0, 0, -1))
check("weekly: Monday at the hour, once a week", alerts.weekly_due({}, {}, mon) and not alerts.weekly_due({}, {"weekly_week": time.strftime("%G-%V", time.localtime(mon))}, mon)
      and not alerts.weekly_due({}, {}, mon - 86400))

# monthly report: PDF by Telegram (document) and email (attachment), text by WhatsApp
pdfp = os.path.join(d, "r.pdf")
open(pdfp, "wb").write(b"%PDF-1.4\nfake\n%%EOF\n")
got.clear()
res = alerts.deliver_file(c, "Security report", "short text", pdfp)
check("monthly: delivered on all channels", res == {"telegram": "ok", "whatsapp": "ok", "email": "ok"}, res)
check("monthly: Telegram got the PDF as a document with a caption", ("telegram-doc", True, 1) in got, got)
check("monthly: email has the PDF attached", any(g[0] == "email" and "filename=\"r.pdf\"" in g[2] and "application/pdf" in g[2] for g in got))
check("monthly: WhatsApp gets the text", any(g[0] == "whatsapp" and "short text" in g[2] for g in got))
first = time.mktime((2026, 11, 1, 21, 10, 0, 0, 0, -1))
check("monthly: due on the 1st at the hour, once", alerts.monthly_due({}, {}, first) and not alerts.monthly_due({}, {"monthly_month": "2026-11"}, first)
      and not alerts.monthly_due({}, {}, first + 86400))

# router health reports: silent router, internet link down / back
class RepDB(FakeDB):
    rep = [["192.168.88.1", "office", "30", '[{"host": "8.8.8.8", "status": "up", "comment": "ml-link: ISP1"}]']]
    def rows(self, q):
        return self.rep if "ml_router_status" in q else []
rdb, rst = RepDB(), {}
check("router reporting, link up: nothing", alerts.check({"EVENTS": "router"}, rdb, rst) == [])
RepDB.rep = [["192.168.88.1", "office", "40", '[{"host": "8.8.8.8", "status": "down", "comment": "ml-link: ISP1"}]']]
f = alerts.check({"EVENTS": "router"}, rdb, rst)
check("internet link down: at once, with its name", len(f) == 1 and "Internet link DOWN on office: ISP1" in f[0][1], f)
check("still down: not again", alerts.check({"EVENTS": "router"}, rdb, rst) == [])
RepDB.rep = [["192.168.88.1", "office", "20", '[{"host": "8.8.8.8", "status": "up", "comment": "ml-link: ISP1"}]']]
check("link back", ["back on office" in l for _, l in alerts.check({"EVENTS": "router"}, rdb, rst)] == [True])
RepDB.rep = [["192.168.88.1", "office", "900", '[{"host": "8.8.8.8", "status": "down", "comment": ""}]']]
check("silent router: after 2 checks; its old link state ignored", alerts.check({"EVENTS": "router"}, rdb, rst) == []
      and ["silent: office" in l for _, l in alerts.check({"EVENTS": "router"}, rdb, rst)] == [True])

RepDB.rep = [["10.0.0.9", "new-router", "20", '[{"host": "1.1.1.1", "status": "down", "comment": "ml-link: ISP2"}]']]
check("a link that is down in the very first report is reported", ["DOWN on new-router: ISP2" in l for _, l in alerts.check({"EVENTS": "router"}, rdb, rst)] == [True])

# ------------------------------------------------------------------ message + summary time
k, t, x = alerts.compose([("router", "a")])
check("one problem: it is the title", (k, t, x) == ("router", "a", ""))
k, t, x = alerts.compose([("router", f"r{i}") for i in range(20)] + [("service", "s")])
check("many problems: one message, list cut at 15", t == "21 alerts: routers, services" and x.count("\n") == 15 and "6 more" in x)
noon = time.mktime((2026, 10, 17, 12, 0, 0, 0, 0, -1))
night = time.mktime((2026, 10, 17, 21, 5, 0, 0, 0, -1))
check("summary: not before the hour", not alerts.summary_due({}, {}, noon))
check("summary: due at 21:00, once a day", alerts.summary_due({}, {}, night) and not alerts.summary_due({}, {"summary_day": "2026-10-17"}, night))
check("summary: off when the event is off", not alerts.summary_due({"EVENTS": "security"}, {}, night))

print(f"{'all alerts tests passed' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
