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


def check(name, cond):
    global fails
    print(("ok   " if cond else "FAIL ") + name)
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
check("settings: default events", alerts.events({}) == ["security", "quarantine", "router", "service", "jobs", "disk", "summary"])
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
