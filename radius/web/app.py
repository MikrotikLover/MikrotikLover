#!/usr/bin/env python3
"""MikrotikLover RADIUS web dashboard (Flask, served by waitress behind nginx/TLS).

Security model
* Runs as the unprivileged user "mlweb". Reads the database with its own SELECT-only
  account (plus write access to web_admin / web_audit only).
* Every change goes through "sudo radius-admin ..." (argument list, no shell), so the
  CLI's validation, kicking and service reloads apply exactly as on the command line.
  Passwords are passed on stdin ("-p -"), never on the command line.
* Login: hashed passwords (werkzeug scrypt/pbkdf2), lock-out after 5 failures per IP,
  session cookie HttpOnly + SameSite=Strict + Secure, CSRF token on every change,
  JSON-only POST bodies, strict CSP. Roles: admin (changes) and viewer (read only).
"""
import hmac, ipaddress, json, os, re, secrets, subprocess, sys, threading, time
from datetime import datetime, timedelta
from functools import wraps

import pymysql
from flask import Flask, abort, g, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))          # /usr/local/lib/mikrotiklover (mlreport.py)
import mlreport  # noqa: E402

CONF_FILE = os.environ.get("MLWEB_CONF", "/etc/mikrotiklover-radius-web/web.conf")
MYCNF = os.environ.get("MLWEB_MYCNF", "/etc/mikrotiklover-radius-web/my.cnf")
RADIUS_ADMIN = os.environ.get("MLWEB_RADIUS_ADMIN", "/usr/local/sbin/radius-admin")
POLICY_DIR = os.environ.get("MLWEB_POLICIES", "/var/lib/mikrotiklover/policies")
ROUTER_DIR = os.environ.get("MLWEB_ROUTER", "/var/lib/mikrotiklover/router")
WF_DIR = os.environ.get("MLWEB_WEBFILTER", "/usr/local/lib/mikrotiklover/webfilter")
BACKUP_DIR = os.environ.get("MLWEB_BACKUPS", "/var/backups/mikrotiklover")
STATE_DIR = os.environ.get("MLWEB_STATE", "/var/lib/mikrotiklover")

NAME_RE = re.compile(r"^[A-Za-z0-9._@+-]{1,64}$")
POLICY_RE = re.compile(r"^[a-z0-9-]{1,40}$")
MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}([-:.]?[0-9A-Fa-f]{2}){5}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$")
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")
PASS_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"


def read_conf(path):
    conf = {}
    try:
        for line in open(path):
            m = re.match(r"^([A-Z_]+)=(.*)$", line.strip())
            if m:
                conf[m.group(1)] = m.group(2).strip().strip('"')
    except OSError as e:
        print(f"cannot read {path}: {e}", file=sys.stderr)
    return conf


CONF = read_conf(CONF_FILE)
app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="/static")
app.config.update(
    SECRET_KEY=CONF.get("SECRET_KEY") or secrets.token_hex(32),
    SESSION_COOKIE_NAME="mlweb",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Strict",
    SESSION_COOKIE_SECURE=CONF.get("INSECURE_COOKIE", "0") != "1",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
    MAX_CONTENT_LENGTH=64 * 1024,
    JSON_SORT_KEYS=False,
)


# ------------------------------------------------------------------ helpers
def db():
    if "db" not in g:
        g.db = pymysql.connect(unix_socket=CONF.get("DB_SOCKET", "/run/mysqld/mysqld.sock"),
                               user=CONF.get("WEB_DB_USER", "radius_web"), password=CONF.get("WEB_DB_PASS", ""),
                               database=CONF.get("DB_NAME", "radius"), autocommit=True, connect_timeout=5,
                               cursorclass=pymysql.cursors.DictCursor, charset="utf8mb4",
                           init_command="SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


def q(sql, args=None):
    with db().cursor() as c:
        c.execute(sql, args)
        return c.fetchall()


def q1(sql, args=None):
    rows = q(sql, args)
    return rows[0] if rows else None


def jsonable(rows):
    out = []
    for r in rows:
        out.append({k: (str(v) if hasattr(v, "isoformat") else
                        int(v) if v.__class__.__name__ == "Decimal" else v) for k, v in r.items()})
    return out


def client_ip():
    return request.remote_addr or ""


def audit(action, result, admin=None):
    try:
        q("INSERT INTO web_audit (admin, ip, action, result) VALUES (%s,%s,%s,%s)",
          ((admin or session.get("user", "-"))[:64], client_ip(), action[:255], result[:16]))
    except pymysql.MySQLError as e:
        print(f"audit failed: {e}", file=sys.stderr)


def radius_admin(args, stdin=None, action=None, timeout=120, log=True):
    """Run radius-admin; returns (ok, message). Audited (without secrets)."""
    cmd = ([] if os.geteuid() == 0 else ["sudo", "-n"]) + [RADIUS_ADMIN] + args
    try:
        p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=timeout)
        ok, out = p.returncode == 0, ANSI_RE.sub("", (p.stdout + p.stderr)).strip()
    except subprocess.TimeoutExpired:
        ok, out = False, "radius-admin timed out"
    out = out.replace("ERROR: ", "")
    # keep the message lines, drop the CLI's tables
    out = "\n".join(l for l in out.splitlines() if l.strip() and not l.lstrip().startswith(("+", "|"))).replace("✔ ", "")
    if log:
        audit(action or " ".join(args), "ok" if ok else "failed")
    return ok, out


def body():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, "JSON body expected")
    return data


def field(data, key, regex=None, required=False, maxlen=128):
    v = data.get(key, "")
    v = "" if v is None else str(v).strip()
    if required and not v:
        abort(400, f"{key} is required")
    if v and (len(v) > maxlen or (regex and not regex.match(v))):
        abort(400, f"invalid {key}")
    return v


def gen_password(n=10):
    return "".join(secrets.choice(PASS_ALPHABET) for _ in range(n))


def result(ok, msg, **extra):
    if not ok:
        return jsonify(error=msg or "failed"), 400
    return jsonify(ok=True, message=msg, **extra)


@app.errorhandler(400)
@app.errorhandler(403)
@app.errorhandler(404)
@app.errorhandler(429)
def json_error(e):
    return jsonify(error=getattr(e, "description", str(e))), e.code


@app.errorhandler(pymysql.err.OperationalError)
def db_down(e):
    """MariaDB stopped / restarting: a clear message instead of an HTML 500 page."""
    app.logger.warning("database: %s", e)
    return jsonify(error="The database is not reachable (MariaDB stopped?). Try again in a moment."), 503


@app.errorhandler(500)
def server_error(e):
    return jsonify(error="Server error — see /var/log/mikrotik/web.log"), 500


@app.after_request
def security_headers(resp):
    if resp.headers.get("X-ML-CSP"):              # social WiFi pages: the last one posts to the router's login page
        resp.headers["Content-Security-Policy"] = resp.headers["X-ML-CSP"]
        del resp.headers["X-ML-CSP"]
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "no-referrer"
        resp.headers["Cache-Control"] = "no-store"
        return resp
    if resp.headers.get("X-ML-Preview"):          # hotspot page preview: its own (inline) styles, shown in an iframe
        del resp.headers["X-ML-Preview"]
        resp.headers["Content-Security-Policy"] = ("default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
                                                   "frame-ancestors 'self'; sandbox")
        resp.headers["X-Frame-Options"] = "SAMEORIGIN"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp
    resp.headers["Content-Security-Policy"] = ("default-src 'self'; img-src 'self' data:; style-src 'self'; "
                                               "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; "
                                               "base-uri 'none'; form-action 'self'")
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


# ------------------------------------------------------------------ authentication
_fails, _fails_lock = {}, threading.Lock()
LOCK_AFTER, LOCK_WINDOW = 5, 600


def too_many(ip):
    now = time.time()
    with _fails_lock:
        hits = [t for t in _fails.get(ip, []) if t > now - LOCK_WINDOW]
        _fails[ip] = hits
        return len(hits) >= LOCK_AFTER


def note_fail(ip):
    with _fails_lock:
        _fails.setdefault(ip, []).append(time.time())


def login_required(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            user = session.get("user")
            if not user:
                return jsonify(error="login required"), 401
            row = q1("SELECT role FROM web_admin WHERE username=%s", (user,))
            if not row:                      # admin removed: end the session
                session.clear()
                return jsonify(error="login required"), 401
            session["role"] = row["role"]
            if request.method != "GET":
                token = request.headers.get("X-CSRF-Token", "")
                if not hmac.compare_digest(token, session.get("csrf", "")):
                    return jsonify(error="invalid CSRF token — reload the page"), 403
                if not request.is_json:
                    return jsonify(error="JSON body expected"), 400
            if role == "admin" and row["role"] != "admin":
                return jsonify(error="read-only account"), 403
            return fn(*a, **kw)
        return wrapper
    return deco


@app.post("/api/login")
def login():
    ip = client_ip()
    if too_many(ip):
        return jsonify(error="Too many failed logins — try again in 10 minutes"), 429
    data = body()
    user = field(data, "username", NAME_RE, required=True)
    password = str(data.get("password", ""))[:256]
    row = q1("SELECT username, password_hash, role FROM web_admin WHERE username=%s", (user,))
    # always run a hash check so timing does not reveal valid usernames
    ok = check_password_hash(row["password_hash"] if row else _DUMMY_HASH, password) and row is not None
    if not ok:
        note_fail(ip)
        session.clear()
        audit("login", "failed", admin=user)
        return jsonify(error="Wrong username or password"), 401
    session.clear()
    session.permanent = True
    session.update(user=row["username"], role=row["role"], csrf=secrets.token_urlsafe(32))
    q("UPDATE web_admin SET last_login=NOW() WHERE username=%s", (user,))
    audit("login", "ok")
    return jsonify(user=row["username"], role=row["role"], csrf=session["csrf"])


_DUMMY_HASH = generate_password_hash(secrets.token_hex(8))


@app.post("/api/logout")
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get("/api/me")
@login_required()
def me():
    return jsonify(user=session["user"], role=session["role"], csrf=session["csrf"])


@app.post("/api/me/password")
@login_required()
def change_own_password():
    data = body()
    old, new = str(data.get("old", "")), str(data.get("new", ""))
    row = q1("SELECT password_hash FROM web_admin WHERE username=%s", (session["user"],))
    if not row or not check_password_hash(row["password_hash"], old):
        return jsonify(error="Current password is wrong"), 400
    if len(new) < 10:
        return jsonify(error="New password: at least 10 characters"), 400
    q("UPDATE web_admin SET password_hash=%s WHERE username=%s", (generate_password_hash(new), session["user"]))
    audit("change own password", "ok")
    return jsonify(ok=True, message="Password changed")


# ------------------------------------------------------------------ overview
def groups_map():
    """{group: {...settings..., members}} from all group tables."""
    groups = {}

    def grp(name):
        return groups.setdefault(name, {"name": name, "description": "", "rate": "", "vlan": "", "session_timeout": "",
                                        "idle_timeout": "", "max_sessions": "", "policy": "", "address_list": "", "pool": "",
                                        "members": 0})
    for r in q("SELECT groupname, description FROM radgroup_meta"):
        grp(r["groupname"])["description"] = r["description"]
    for r in q("SELECT groupname, attribute, value FROM radgroupreply"):
        g_ = grp(r["groupname"])
        a, v = r["attribute"], r["value"]
        if a == "Mikrotik-Rate-Limit":
            g_["rate"] = v
        elif a == "Tunnel-Private-Group-Id":
            g_["vlan"] = v
        elif a == "Session-Timeout":
            g_["session_timeout"] = v
        elif a == "Idle-Timeout":
            g_["idle_timeout"] = v
        elif a == "Framed-Pool":
            g_["pool"] = v
        elif a == "Mikrotik-Address-List":
            g_["address_list"] = v
            g_["policy"] = v[7:] if v.startswith("policy-") else ""
    for r in q("SELECT groupname, attribute, value FROM radgroupcheck"):
        if r["attribute"] == "Simultaneous-Use":
            grp(r["groupname"])["max_sessions"] = r["value"]
    for r in q("SELECT groupname, COUNT(*) n FROM radusergroup GROUP BY groupname"):
        grp(r["groupname"])["members"] = int(r["n"])
    return groups


@app.get("/api/summary")
@login_required()
def summary():
    counts = q1("""SELECT
        (SELECT COUNT(DISTINCT username) FROM radcheck WHERE username NOT IN
            (SELECT username FROM radcheck WHERE attribute='Calling-Station-Id')) AS users,
        (SELECT COUNT(DISTINCT username) FROM radcheck WHERE attribute='Calling-Station-Id') AS macs,
        (SELECT COUNT(*) FROM nas) AS routers,
        (SELECT COUNT(*) FROM radacct WHERE acctstoptime IS NULL) AS online,
        (SELECT COUNT(*) FROM radpostauth WHERE authdate >= CURDATE() AND reply='Access-Accept') AS accepts,
        (SELECT COUNT(*) FROM radpostauth WHERE authdate >= CURDATE() AND reply='Access-Reject') AS rejects,
        (SELECT COALESCE(SUM(bytes_down),0) FROM traffic_site WHERE bucket >= CURDATE()) AS down_today,
        (SELECT COALESCE(SUM(bytes_up),0) FROM traffic_site WHERE bucket >= CURDATE()) AS up_today,
        (SELECT COALESCE(SUM(amount),0) FROM ml_sale WHERE at >= CURDATE()) AS sales_today,
        (SELECT COALESCE(SUM(amount),0) FROM ml_sale WHERE at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS sales_month,
        (SELECT COUNT(*) FROM ml_account WHERE first_login IS NOT NULL AND (expires_at IS NULL OR expires_at > NOW())) AS active_plans,
        (SELECT COUNT(*) FROM ml_account WHERE voucher_batch IS NOT NULL AND first_login IS NULL) AS unused_vouchers""")
    counts["groups"] = len(groups_map())
    hours = q("""SELECT bucket, SUM(bytes_down) AS down, SUM(bytes_up) AS up FROM traffic_site
                 WHERE bucket >= NOW() - INTERVAL 24 HOUR GROUP BY bucket ORDER BY bucket""")
    top = q("""SELECT site, SUM(bytes_down) AS down, SUM(bytes_up) AS up FROM traffic_site
               WHERE bucket >= CURDATE() GROUP BY site ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT 8""")
    # PEAP/TTLS also log the anonymous outer identity; show the real user names
    logins = q("SELECT username, reply, authdate FROM radpostauth WHERE username <> 'anonymous' ORDER BY id DESC LIMIT 8")
    blocked_today = 0
    today = time.strftime("%Y-%m-%d")
    try:
        with open(mlreport.WF_LOG, "rb") as fh:
            fh.seek(max(0, os.path.getsize(mlreport.WF_LOG) - 4_000_000))
            blocked_today = sum(1 for line in fh if line.startswith(today.encode()))
    except OSError:
        pass
    counts["blocked_today"] = blocked_today
    counts["currency"] = settings_get()["currency"]
    return jsonify(counts=jsonable([counts])[0], hours=jsonable(hours), top_sites=jsonable(top),
                   logins=jsonable(logins))


# ------------------------------------------------------------------ users
@app.get("/api/users")
@login_required()
def users():
    rows = q("""SELECT c.username,
                  COALESCE(MAX(g.groupname),'') AS grp,
                  SUM(c.attribute='Auth-Type' AND c.value='Reject') > 0 AS disabled,
                  SUM(c.attribute='Calling-Station-Id') > 0 AS is_mac,
                  SUM(c.attribute='NT-Password') > 0 AS nt_hash,
                  (SELECT value FROM radreply r WHERE r.username=c.username AND r.attribute='Mikrotik-Address-List' LIMIT 1) AS own_list,
                  (SELECT COUNT(*) FROM radacct a WHERE a.username=c.username AND a.acctstoptime IS NULL) AS online,
                  (SELECT MAX(authdate) FROM radpostauth p WHERE p.username=c.username AND p.reply='Access-Accept') AS last_login,
                  (SELECT description FROM macdevice d WHERE d.mac=c.username) AS description,
                  (SELECT plan FROM ml_account m WHERE m.username=c.username) AS plan,
                  (SELECT expires_at FROM ml_account m WHERE m.username=c.username) AS expires_at,
                  (SELECT voucher_batch FROM ml_account m WHERE m.username=c.username) AS voucher_batch
                FROM radcheck c LEFT JOIN radusergroup g ON g.username=c.username
                GROUP BY c.username ORDER BY c.username""")
    gm = groups_map()
    out = []
    for r in jsonable(rows):
        own = r.pop("own_list") or ""
        grp_list = gm.get(r["grp"], {}).get("address_list", "")
        r["policy"] = (own[7:] if own.startswith("policy-") else own) or ""
        r["policy_source"] = "user" if own else ("group" if grp_list else "")
        if not own and grp_list:
            r["policy"] = grp_list[7:] if grp_list.startswith("policy-") else grp_list
        r["disabled"], r["is_mac"], r["nt_hash"] = bool(r["disabled"]), bool(r["is_mac"]), bool(r["nt_hash"])
        out.append(r)
    return jsonify(users=out)


@app.get("/api/users/<name>")
@login_required()
def user_detail(name):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    check = q("""SELECT attribute, op, IF(attribute LIKE '%%Password','********',value) AS value
                 FROM radcheck WHERE username=%s""", (name,))
    if not check:
        abort(404, "no such user")
    reply = q("SELECT attribute, op, value FROM radreply WHERE username=%s", (name,))
    grp = q1("SELECT groupname FROM radusergroup WHERE username=%s LIMIT 1", (name,))
    sessions = q("""SELECT nasipaddress, framedipaddress, callingstationid, acctstarttime, acctstoptime,
                       acctsessiontime, acctinputoctets, acctoutputoctets, acctterminatecause
                    FROM radacct WHERE username=%s ORDER BY radacctid DESC LIMIT 20""", (name,))
    logins = q("SELECT reply, authdate FROM radpostauth WHERE username=%s ORDER BY id DESC LIMIT 15", (name,))
    usage = q("""SELECT DATE(bucket) AS day, SUM(bytes_down) AS down, SUM(bytes_up) AS up FROM traffic_site
                 WHERE username=%s AND bucket >= CURDATE() - INTERVAL 30 DAY GROUP BY DATE(bucket) ORDER BY day""",
              (name,))
    sites = q("""SELECT site, SUM(bytes_down) AS down, SUM(bytes_up) AS up FROM traffic_site
                 WHERE username=%s AND bucket >= NOW() - INTERVAL 7 DAY GROUP BY site
                 ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT 15""", (name,))
    contact = q1("SELECT phone FROM ml_contact WHERE username=%s", (name,))
    notice = q1("SELECT ml_notice(%s) AS t", (name,))
    remembered = q("SELECT mac, created, last_seen FROM ml_remember WHERE username=%s ORDER BY last_seen DESC", (name,))
    return jsonify(name=name, group=grp["groupname"] if grp else "", account=account_info(name),
                   phone=contact["phone"] if contact else "", notice=(notice or {}).get("t") or "",
                   check=jsonable(check), reply=jsonable(reply),
                   sessions=jsonable(sessions), logins=jsonable(logins), usage=jsonable(usage), sites=jsonable(sites),
                   remembered=jsonable(remembered))


@app.post("/api/users")
@login_required("admin")
def user_add():
    data = body()
    name = field(data, "name", NAME_RE, required=True)
    group = field(data, "group", NAME_RE)
    password = str(data.get("password") or "")
    generated = not password
    password = password or gen_password()
    if not (4 <= len(password) <= 128) or not password.isprintable():
        abort(400, "password: 4–128 printable characters")
    args = ["user", "add", name, "-p", "-"] + (["-g", group] if group else []) + (["--nt-hash"] if data.get("nt_hash") else [])
    ok, msg = radius_admin(args, stdin=password + "\n", action=f"user add {name}")
    return result(ok, msg, password=password if (ok and generated) else None)


@app.post("/api/users/<name>/<action>")
@login_required("admin")
def user_action(name, action):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    data = body()
    if action == "password":
        password = str(data.get("password") or "") or gen_password()
        generated = not data.get("password")
        if not (4 <= len(password) <= 128) or not password.isprintable():
            abort(400, "password: 4–128 printable characters")
        args = ["user", "passwd", name, "-p", "-"] + (["--nt-hash"] if data.get("nt_hash") else [])
        ok, msg = radius_admin(args, stdin=password + "\n", action=f"user passwd {name}")
        return result(ok, msg, password=password if (ok and generated) else None)
    if action == "group":
        group = field(data, "group", NAME_RE) or "-"
        return result(*radius_admin(["user", "group", name, group]))
    if action == "policy":
        policy = field(data, "policy", POLICY_RE) or "-"
        return result(*radius_admin(["user", "policy", name, policy]))
    if action in ("disable", "enable"):
        return result(*radius_admin(["user", action, name]))
    if action == "kick":
        return result(*radius_admin(["kick", name]))
    if action == "ip":
        ip = field(data, "ip", re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){3}$")) or "-"
        return result(*radius_admin(["user", "ip", name, ip]))
    abort(404)


@app.delete("/api/users/<name>")
@login_required("admin")
def user_delete(name):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    return result(*radius_admin(["user", "del", name]))


# ------------------------------------------------------------------ groups
@app.get("/api/groups")
@login_required()
def groups():
    return jsonify(groups=sorted(groups_map().values(), key=lambda x: x["name"]), policies=policies_list())


GROUP_FIELDS = {  # json key -> (radius-admin option, validator)
    "rate": ("--rate", re.compile(r"^[0-9A-Za-z/ ]{1,64}$")),
    "vlan": ("--vlan", re.compile(r"^[0-9]{1,4}$")),
    "session_timeout": ("--session-timeout", re.compile(r"^[0-9]{1,9}$")),
    "idle_timeout": ("--idle-timeout", re.compile(r"^[0-9]{1,9}$")),
    "max_sessions": ("--max-sessions", re.compile(r"^[0-9]{1,4}$")),
    "policy": ("--policy", POLICY_RE),
    "pool": ("--pool", NAME_RE),
    "description": ("--description", re.compile(r"^[\x20-\x7e]{0,128}$")),
}


@app.post("/api/groups")
@login_required("admin")
def group_save():
    data = body()
    name = field(data, "name", NAME_RE, required=True)
    editing = bool(data.get("edit"))
    args = ["group", "add", name]
    for key, (opt, rx) in GROUP_FIELDS.items():
        if key not in data:
            continue
        v = field(data, key, rx)
        if v:
            args += [opt, v]
        elif editing:
            args += [opt, "-"]          # cleared in the form -> remove the setting
    return result(*radius_admin(args))


@app.delete("/api/groups/<name>")
@login_required("admin")
def group_delete(name):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    return result(*radius_admin(["group", "del", name]))


def policies_list():
    out = []
    try:
        for f in sorted(os.listdir(POLICY_DIR)):
            if f.endswith(".txt") and f != "README.txt":
                first = open(os.path.join(POLICY_DIR, f)).readline().lstrip("# ").strip()
                out.append({"name": f[:-4], "description": first})
    except OSError:
        pass
    return out


# ------------------------------------------------------------------ MAC devices
@app.get("/api/macs")
@login_required()
def macs():
    rows = q("""SELECT c.username AS mac, COALESCE(MAX(d.description),'') AS description,
                  COALESCE(MAX(g.groupname),'') AS grp,
                  COALESCE((SELECT REPLACE(value,'policy-','') FROM radreply r WHERE r.username=c.username AND r.attribute='Mikrotik-Address-List' LIMIT 1),'') AS policy,
                  COALESCE((SELECT REPLACE(gr.value,'policy-','') FROM radgroupreply gr WHERE gr.groupname=MAX(g.groupname) AND gr.attribute='Mikrotik-Address-List' LIMIT 1),'') AS group_policy,
                  SUM(c.attribute='Auth-Type' AND c.value='Reject') > 0 AS disabled,
                  (SELECT MAX(authdate) FROM radpostauth p WHERE p.username=c.username AND p.reply='Access-Accept') AS last_seen,
                  (SELECT COUNT(*) FROM radacct a WHERE a.username=c.username AND a.acctstoptime IS NULL) AS online
                FROM radcheck c LEFT JOIN macdevice d ON d.mac=c.username LEFT JOIN radusergroup g ON g.username=c.username
                WHERE c.username IN (SELECT username FROM radcheck WHERE attribute='Calling-Station-Id')
                GROUP BY c.username ORDER BY c.username""")
    out = jsonable(rows)
    for r in out:
        r["disabled"] = bool(r["disabled"])
    return jsonify(macs=out)


@app.post("/api/macs")
@login_required("admin")
def mac_add():
    data = body()
    mac = field(data, "mac", MAC_RE, required=True)
    group = field(data, "group", NAME_RE)
    desc = field(data, "description", re.compile(r"^[\x20-\x7e]{0,128}$"))
    pol = field(data, "policy", re.compile(r"^[a-z0-9-]{1,40}$"))
    args = ["mac", "add", mac] + (["-g", group] if group else []) + (["-d", desc] if desc else []) + (["--policy", pol] if pol else [])
    return result(*radius_admin(args))


@app.post("/api/macs/<mac>/<action>")
@login_required("admin")
def mac_action(mac, action):
    if not MAC_RE.match(mac):
        abort(400, "invalid MAC")
    data = body()
    if action in ("disable", "enable"):
        return result(*radius_admin(["mac", action, mac]))
    if action == "policy":       # its own policy, or "" = follow its group
        pol = field(data, "policy", re.compile(r"^[a-z0-9-]{1,40}$"))
        return result(*radius_admin(["mac", "policy", mac, pol or "-"]))
    if action == "kick":
        return result(*radius_admin(["kick", mac]))
    abort(404)


@app.delete("/api/macs/<mac>")
@login_required("admin")
def mac_delete(mac):
    if not MAC_RE.match(mac):
        abort(400, "invalid MAC")
    return result(*radius_admin(["mac", "del", mac]))


# ------------------------------------------------------------------ routers (NAS)
def valid_nas(ip):
    try:
        ipaddress.ip_network(ip, strict=False)
        return "." in ip
    except ValueError:
        return False


@app.get("/api/nas")
@login_required()
def nas_list():
    rows = q("SELECT nasname, shortname, CONCAT(LEFT(secret,3),'…') AS secret, description FROM nas ORDER BY nasname")
    return jsonify(nas=jsonable(rows))


@app.get("/api/nas/secret")
@login_required("admin")
def nas_secret():
    ip = request.args.get("ip", "")
    if not valid_nas(ip):
        abort(400, "invalid address")
    row = q1("SELECT secret FROM nas WHERE nasname=%s", (ip,))
    if not row:
        abort(404, "no such router")
    audit(f"reveal secret {ip}", "ok")
    return jsonify(secret=row["secret"])


@app.post("/api/nas")
@login_required("admin")
def nas_add():
    data = body()
    ip = field(data, "ip", required=True, maxlen=18)
    if not valid_nas(ip):
        abort(400, "invalid IPv4 address")
    secret = field(data, "secret", re.compile(r"^[A-Za-z0-9._@#%+=-]{8,64}$"))
    name = field(data, "name", NAME_RE)
    if not secret:
        secret = gen_password(20)
    args = ["nas", "add", ip, secret] + ([name] if name else [])
    ok, msg = radius_admin(args, action=f"nas add {ip}")
    return result(ok, msg.replace(secret, "********"), secret=secret if ok else None)


@app.delete("/api/nas")
@login_required("admin")
def nas_delete():
    ip = request.args.get("ip", "")
    if not valid_nas(ip):
        abort(400, "invalid address")
    return result(*radius_admin(["nas", "del", ip]))


# ------------------------------------------------------------------ live data
@app.get("/api/online")
@login_required()
def online():
    rows = q("""SELECT username, nasipaddress, framedipaddress, callingstationid, acctstarttime,
                   TIMESTAMPDIFF(SECOND, acctstarttime, NOW()) AS seconds, acctinputoctets, acctoutputoctets
                FROM radacct WHERE acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 1000""")
    return jsonify(sessions=jsonable(rows))


@app.get("/api/auth-log")
@login_required()
def auth_log():
    n = int_arg("n", 100, 1, 1000)
    user = request.args.get("user", "")
    if user and not NAME_RE.match(user):
        abort(400, "invalid user")
    if user:
        rows = q("SELECT username, reply, authdate FROM radpostauth WHERE username=%s ORDER BY id DESC LIMIT %s", (user, n))
    else:
        rows = q("SELECT username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT %s", (n,))
    return jsonify(log=jsonable(rows))


def int_arg(name, default, lo, hi):
    """Whole-number query parameter, clamped to lo..hi; 400 when it is not a number."""
    try:
        v = int(request.args.get(name, default) or default)
    except ValueError:
        abort(400, f"{name} must be a number")
    return min(max(v, lo), hi)


def report_args():
    a = type("A", (), {})()
    a.user = request.args.get("user", "")
    a.ip = request.args.get("ip", "")
    if a.user and not NAME_RE.match(a.user):
        abort(400, "invalid user")
    if a.ip and not re.match(r"^\d+\.\d+\.\d+\.\d+$", a.ip):
        abort(400, "invalid ip")
    try:
        a.days = min(max(float(request.args.get("days", 1)), 0.01), 90)
        a.top = min(max(int(request.args.get("top", 50)), 1), 500)
        a.n = min(max(int(request.args.get("n", 200)), 1), 2000)
    except ValueError:
        abort(400, "invalid number")
    return a


_sessions, _sessions_lock = None, threading.Lock()


def sessions():
    global _sessions
    with _sessions_lock:
        if _sessions is None:
            _sessions = mlreport.Sessions(MYCNF, CONF.get("DB_NAME", "radius"), 30)
        _sessions.refresh()
        return _sessions


@app.get("/api/sites")
@login_required()
def sites():
    rows = mlreport.sites_rows(report_args(), sessions())
    return jsonify(rows=[dict(zip(("site", "visits", "users", "last", "who"), r)) for r in rows])


@app.get("/api/history")
@login_required()
def history():
    rows = mlreport.history_rows(report_args(), sessions())
    return jsonify(rows=[dict(zip(("time", "user", "ip", "site", "hostname"), r)) for r in reversed(rows)])


@app.get("/api/blocked")
@login_required()
def blocked():
    """Blocked attempts with the policy that blocked them, why, and the site name."""
    a = report_args()
    a.policy = request.args.get("policy", "")
    if a.policy and not re.match(r"^[a-z0-9 ().-]{1,40}$", a.policy):
        abort(400, "invalid policy")
    policies = {r["username"]: r["list"] for r in q(mlreport.POLICY_SQL)}
    rows = mlreport.blocked_detail(a, sessions(), policies)
    for r in rows:
        r["category"] = r["rule"]
    summary = [dict(zip(("policy", "user", "reason", "count"), x)) for x in mlreport.blocked_summary(rows)]
    return jsonify(rows=list(reversed(rows)), summary=summary[:200])


# ------------------------------------------------------------------ block page (plain HTTP, through nginx :8082)
_BP = {"users": {}, "dns": {}}
REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _bp_key_ok():
    key = CONF.get("BLOCK_KEY", "")
    return bool(key) and hmac.compare_digest(request.headers.get("X-ML-Block", ""), key)


def _public_ip(host):
    """The address to fetch an allowed page from: a public IPv4 of the host (never this server / LAN), else None."""
    import socket
    now = time.time()
    hit = _BP["dns"].get(host)
    if hit and now - hit[1] < 300:
        return hit[0]
    try:
        ips = [ipaddress.ip_address(host)] if re.match(r"^[\d.]+$", host) else \
            [ipaddress.ip_address(a[4][0]) for a in socket.getaddrinfo(host, 80, socket.AF_INET, socket.SOCK_STREAM)]
    except (OSError, ValueError, UnicodeError):
        ips = []
    good = next((str(i) for i in ips if i.is_global and not i.is_multicast), None)
    if any(not i.is_global for i in ips):
        good = None                                  # a name that also points inside: refuse (no tricks with Host:)
    if len(_BP["dns"]) > 5000:
        _BP["dns"].clear()
    _BP["dns"][host] = (good, now)
    return good


def block_decision(host, ip):
    """-> (blocked: bool, info dict) for a plain-HTTP request of the device at `ip` to `host`."""
    import cdnmap
    import whyblocked
    now = time.time()
    hit = _BP["users"].get(ip)
    if not hit or now - hit[2] > 30:
        r = q1("SELECT username FROM radacct WHERE framedipaddress=%s AND acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 1", (ip,))
        user = r["username"] if r else ""
        lst = ""
        if user:
            r = q1("SELECT value FROM radreply WHERE username=%s AND attribute='Mikrotik-Address-List' LIMIT 1", (user,)) or \
                q1("""SELECT gr.value FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname
                      AND gr.attribute='Mikrotik-Address-List' WHERE g.username=%s ORDER BY g.priority LIMIT 1""", (user,))
            lst = r["value"] if r else ""
        hit = (user, lst, now)
        if len(_BP["users"]) > 5000:
            _BP["users"].clear()
        _BP["users"][ip] = hit
    user, lst, _ = hit
    policy = lst[7:] if lst.startswith("policy-") and POLICY_RE.match(lst[7:]) else ""
    if not policy:
        return False, {"user": user, "policy": ""}
    if temp_allowed(user, ip, host):
        return False, {"user": user, "policy": policy}
    if policy_is_off(policy):                            # turned off: nothing of it is blocked
        return False, {"user": user, "policy": policy}
    try:
        text = open(os.path.join(POLICY_DIR, policy + ".txt"), encoding="utf-8").read()
    except OSError:
        return False, {"user": user, "policy": policy}
    try:
        cat = cdnmap.catalog()
    except Exception:                                       # noqa: BLE001
        cat = None
    r = whyblocked.explain(host, policy, text, datetime.now(), WF_DIR, cat, ao_dir=AO_DIR, webscan_dir=WEBSCAN_DIR)
    act = next((x for x in r["rules"] if x["active"]), None)
    return r["verdict"] == "blocked", {"user": user, "policy": policy, "rule": act["rule"] if act else "",
                                       "why": act["why"] if act else "", "lists": r["lists"]}


@app.get("/internal/blockcheck")
def blockcheck():
    """nginx auth_request for every proxied http:// request: 200 + X-ML-Upstream = go on, 403 = block page."""
    if not _bp_key_ok():
        abort(404)
    import whyblocked
    host = whyblocked.clean_host(request.headers.get("X-ML-Host", "")) or request.headers.get("X-ML-Host", "")
    ip = request.headers.get("X-Real-IP", "")
    try:
        blocked, _ = block_decision(host, ip) if whyblocked.clean_host(host) else (False, {})
    except Exception as e:                                  # noqa: BLE001 — a broken check must not stop the internet
        print(f"blockcheck {host}: {e}", file=sys.stderr)
        blocked = False
    if blocked:
        return app.response_class("blocked", status=403)
    up = _public_ip(host)
    if not up:
        return app.response_class("not a public address", status=403)
    return app.response_class("", status=200, headers={"X-ML-Upstream": up})


def block_page_html(host, reason, rule, code, user, ip, when, st, logo=""):
    from html import escape as e
    c1 = st.get("hs_color1") if re.match(r"^#[0-9a-fA-F]{6}$", st.get("hs_color1") or "") else "#1d4ed8"
    c2 = st.get("hs_color2") if re.match(r"^#[0-9a-fA-F]{6}$", st.get("hs_color2") or "") else "#0ea5e9"
    brand, contact = st.get("hs_title") or st.get("brand") or "WiFi", st.get("contact") or ""
    img = f'<img class="logo" src="{logo}" alt="">' if re.match(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$", logo or "") else ""
    form = ('<form method="post" action="/__mlrequest" class="req">'
            f'<input type="hidden" name="code" value="{e(code)}">'
            '<input name="note" maxlength="200" placeholder="Kyun chahiye? (zaroori nahi)">'
            '<button type="submit">Khulwane ki darkhwast bhejein</button></form>')
    rows = "".join(f"<b>{k}</b><span>{e(v)}</span>" for k, v in (("Site", host), ("Wajah (reason)", reason), ("Rule", rule),
                                                                  ("User", user or "-"), ("Device", ip), ("Waqt", when)) if v)
    return f"""<!doctype html><html lang="ur-Latn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Site band hai — {e(brand)}</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,{c1},{c2});
min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px;color:#0f172a}}
.card{{background:#fff;border-radius:18px;max-width:460px;width:100%;padding:26px 22px;box-shadow:0 20px 50px rgba(0,0,0,.25);text-align:center}}
.logo{{max-width:160px;max-height:80px;margin:0 auto 10px;display:block}}.brand{{font-weight:700;color:#475569;margin-bottom:14px}}
.icon{{width:58px;height:58px;border-radius:50%;background:#fee2e2;color:#b91c1c;font-size:30px;font-weight:800;line-height:58px;margin:0 auto 10px}}
h1{{font-size:21px;margin:0 0 6px}}p{{margin:6px 0;color:#334155;line-height:1.5}}.muted{{color:#64748b;font-size:13px}}
.kv{{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;text-align:left;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px;margin:14px 0;font-size:14px;word-break:break-word}}
.kv b{{color:#475569;font-weight:600}}.req{{display:flex;flex-direction:column;gap:8px;margin:14px 0 4px}}
.req input{{font:inherit;padding:10px 12px;border:1px solid #cbd5e1;border-radius:10px}}.req button{{font:inherit;font-weight:700;padding:11px;border:0;border-radius:10px;background:{c1};color:#fff;cursor:pointer}}.ref{{display:inline-block;font:700 22px ui-monospace,Menlo,monospace;letter-spacing:3px;background:#0f172a;color:#fff;border-radius:10px;padding:8px 14px;margin:6px 0}}
</style></head><body><main class="card">{img}<div class="brand">{e(brand)}</div><div class="icon" aria-hidden="true">!</div>
<h1>Yeh website band hai</h1><p>This website is blocked on this network.</p>
<div class="kv">{rows}</div>
<p>Ghalti se band lag rahi hai? Admin ko yeh code batayein:</p><div class="ref">{e(code)}</div>
{form}
<p class="muted">{e(contact) if contact else "Network admin"}</p></main></body></html>"""


@app.get("/internal/blockpage")
def blockpage():
    """The branded block page (nginx error_page for a 403 of blockcheck). Every page shown gets a reference code."""
    if not _bp_key_ok():
        abort(404)
    import whyblocked
    host = whyblocked.clean_host(request.headers.get("X-ML-Host", "")) or request.headers.get("X-ML-Host", "")[:253]
    ip = request.headers.get("X-Real-IP", "")[:45]
    uri = request.headers.get("X-ML-Uri", "/")[:255]
    accept = request.headers.get("Accept", "")
    try:
        blocked, info = block_decision(host, ip) if whyblocked.clean_host(host) else (False, {})
    except Exception:                                       # noqa: BLE001
        blocked, info = False, {}
    if not blocked:
        return app.response_class("This address cannot be opened through this network.\n", status=403, mimetype="text/plain")
    if "text/html" not in accept and not uri.endswith("/"):
        return app.response_class("blocked\n", status=403, mimetype="text/plain")    # images / scripts of a blocked site
    row = q1("SELECT code FROM ml_block_event WHERE ip=%s AND host=%s AND at > NOW() - INTERVAL 10 MINUTE ORDER BY at DESC LIMIT 1", (ip, host))
    if row:
        code = row["code"]
    else:
        code = "".join(secrets.choice(REF_ALPHABET) for _ in range(6))
        q("INSERT INTO ml_block_event (code, ip, username, host, path, policy, rule, why) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)",
          (code, ip, info.get("user", "")[:64], host, uri, info.get("policy", ""), info.get("rule", "")[:160], info.get("why", "")[:255]))
        if secrets.randbelow(50) == 0:
            q("DELETE FROM ml_block_event WHERE at < NOW() - INTERVAL 30 DAY")
    st = settings_get()
    st.update({r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('hs_title','hs_color1','hs_color2')")})
    try:
        logo = open(os.path.join(STATE_DIR, "hotspot-logo.txt"), encoding="ascii").read().strip()
    except OSError:
        logo = ""
    page = block_page_html(host, info.get("why", ""), info.get("rule", ""), code, info.get("user", ""), ip,
                           datetime.now().strftime("%Y-%m-%d %H:%M"), st, logo)
    return app.response_class(page, status=403, mimetype="text/html",
                              headers={"X-ML-CSP": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'"})


@app.post("/internal/unblockrequest")
def unblock_request():
    """The 'please open it' button of the block page (nginx :8082 /__mlrequest)."""
    if not _bp_key_ok():
        abort(404)
    import whyblocked
    from html import escape as e
    host = whyblocked.clean_host(request.headers.get("X-ML-Host", ""))
    ip = request.headers.get("X-Real-IP", "")[:45]
    code = re.sub(r"[^A-Z0-9]", "", str(request.form.get("code", "")).upper())[:6]
    note = re.sub(r"[\x00-\x1f<>]", " ", str(request.form.get("note", "")))[:200].strip()
    ev = q1("SELECT username, policy FROM ml_block_event WHERE code=%s AND ip=%s AND host=%s", (code, ip, host)) if host else None
    if not ev:
        msg, ok = "Yeh darkhwast is device se is site ke liye nahi bheji ja sakti.", False
    elif q1("SELECT 1 FROM ml_unblock WHERE ip=%s AND host=%s AND status='pending'", (ip, host)):
        msg, ok = "Is site ki darkhwast pehle se bheji hui hai — admin ke jawab ka intezar karein.", True
    elif int(q1("SELECT COUNT(*) AS n FROM ml_unblock WHERE ip=%s AND at > NOW() - INTERVAL 1 DAY", (ip,))["n"]) >= 10:
        msg, ok = "Aaj ke liye bahut darkhwastein ho chuki hain. Kal dobara koshish karein.", False
    else:
        q("INSERT INTO ml_unblock (ip, username, host, policy, code, note) VALUES (%s,%s,%s,%s,%s,%s)",
          (ip, ev["username"], host, ev["policy"], code, note))
        msg, ok = "Darkhwast admin ko bhej di gayi. Manzoor hone par yeh site khul jayegi (aam tor par 1 minute mein).", True
    page = f"""<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Darkhwast</title><style>body{{margin:0;font-family:system-ui,sans-serif;background:#f1f5f9;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:16px}}
.card{{background:#fff;border-radius:16px;max-width:420px;padding:24px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.12)}}
.i{{font-size:34px}}p{{color:#334155;line-height:1.5}}</style></head><body><main class="card"><div class="i">{"✅" if ok else "⚠️"}</div>
<p><b>{e(msg)}</b></p><p style="color:#64748b">Code: {e(code)}</p></main></body></html>"""
    return app.response_class(page, status=200 if ok else 400, mimetype="text/html",
                              headers={"X-ML-CSP": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"})


@app.get("/api/unblock")
@login_required()
def unblock_list():
    pending = jsonable(q("SELECT id, at, ip, username, host, policy, code, note FROM ml_unblock WHERE status='pending' ORDER BY id DESC LIMIT 200"))
    open_now = jsonable(q("""SELECT id, at, ip, username, host, policy, until, decided_by, note FROM ml_unblock
                             WHERE status='allowed' AND until > NOW() ORDER BY until"""))
    recent = jsonable(q("""SELECT id, at, ip, username, host, policy, status, until, decided_by, decided_at FROM ml_unblock
                           WHERE status <> 'pending' AND NOT (status='allowed' AND until > NOW()) ORDER BY id DESC LIMIT 50"""))
    return jsonify(pending=pending, open=open_now, recent=recent)


@app.post("/api/unblock/<int:rid>")
@login_required("admin")
def unblock_decide(rid):
    how = str(body().get("how", ""))
    if how == "deny":
        args = ["unblock", "deny", str(rid)]
    elif how == "end":
        args = ["unblock", "end", str(rid)]
    elif how in ("always", "today") or re.match(r"^([1-9]|1\d|2[0-4])h$", how):
        args = ["unblock", "approve", str(rid), how]
    else:
        abort(400, "how: 1h..24h, today, always, deny or end")
    return result(*radius_admin(args + ["--by", session.get("user", "admin")]))


@app.post("/api/unblock/allow")
@login_required("admin")
def unblock_allow():
    import whyblocked
    data = body()
    user = field(data, "user", NAME_RE, required=True)
    site = whyblocked.clean_host(data.get("site", ""))
    how = str(data.get("how", ""))
    if not site:
        abort(400, "write a website name, e.g. example.com")
    if how != "today" and not re.match(r"^([1-9]|1\d|2[0-4])h$", how):
        abort(400, "how: 1h..24h or today")
    return result(*radius_admin(["unblock", "allow", user, site, how, "--by", session.get("user", "admin")]))


@app.get("/api/blockpage")
@login_required()
def blockpage_status():
    st = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('blockpage_on','server_ip')")}
    n = q1("SELECT COUNT(*) AS n FROM ml_block_event WHERE at > NOW() - INTERVAL 1 DAY")
    return jsonify(on=st.get("blockpage_on") == "1", server_ip=st.get("server_ip", ""), today=int(n["n"]) if n else 0)


@app.post("/api/blockpage")
@login_required("admin")
def blockpage_set():
    return result(*radius_admin(["blockpage", "on" if body().get("on") else "off"]))


@app.get("/api/blockpage/preview")
@login_required()
def blockpage_preview():
    st = settings_get()
    st.update({r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('hs_title','hs_color1','hs_color2')")})
    try:
        logo = open(os.path.join(STATE_DIR, "hotspot-logo.txt"), encoding="ascii").read().strip()
    except OSError:
        logo = ""
    page = block_page_html("www.example-game.com", "'example-game.com' is in the gaming list", "block gaming time=9h-17h,mon,tue,wed,thu,fri",
                           "AB3K7Q", "ali", "192.168.88.23", datetime.now().strftime("%Y-%m-%d %H:%M"), st, logo)
    return app.response_class(page, mimetype="text/html", headers={"X-ML-Preview": "1"})


@app.get("/api/why/ref/<code>")
@login_required()
def why_ref(code):
    code = code.strip().upper()
    if not re.match(r"^[A-Z0-9]{6}$", code):
        abort(400, "a reference code has 6 letters / digits")
    row = q1("SELECT code, at, ip, username, host, path, policy, rule, why FROM ml_block_event WHERE code=%s", (code,))
    if not row:
        abort(404, f"no block page with code {code} (kept 30 days)")
    return jsonify(event=jsonable([row])[0])


@app.get("/api/why")
@login_required()
def why_blocked():
    """Why is SITE blocked (for USER or IP)? Lists, the policy rule, whether it is active now, recent log lines."""
    import cdnmap
    import whyblocked
    host = whyblocked.clean_host(request.args.get("site", ""))
    if not host:
        abort(400, "write a website name, e.g. facebook.com or https://www.facebook.com/page")
    who = request.args.get("user", "").strip()
    user, ip = "", ""
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", who):
        ip = who
        r = q1("""SELECT username FROM radacct WHERE framedipaddress=%s ORDER BY acctstoptime IS NULL DESC, acctstarttime DESC LIMIT 1""", (ip,))
        user = r["username"] if r else ""
    elif who:
        if not NAME_RE.match(who):
            abort(400, "invalid user")
        if not q1("SELECT 1 FROM radcheck WHERE username=%s LIMIT 1", (who,)):
            abort(404, f"no user '{who}'")
        user = who
        r = q1("SELECT framedipaddress FROM radacct WHERE username=%s AND acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 1", (user,))
        ip = r["framedipaddress"] if r else ""
    at = datetime.now()
    if request.args.get("at"):
        try:
            at = datetime.strptime(request.args["at"], "%Y-%m-%dT%H:%M")
        except ValueError:
            abort(400, "at: YYYY-MM-DDTHH:MM")
    lst, source = "", ""
    if user:
        r = q1("SELECT value FROM radreply WHERE username=%s AND attribute='Mikrotik-Address-List' LIMIT 1", (user,))
        if r:
            lst, source = r["value"], "user"
        else:
            r = q1("""SELECT gr.value, g.groupname FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname
                      AND gr.attribute='Mikrotik-Address-List' WHERE g.username=%s ORDER BY g.priority LIMIT 1""", (user,))
            if r:
                lst, source = r["value"], f"group {r['groupname']}"
    policy = lst[7:] if lst.startswith("policy-") and POLICY_RE.match(lst[7:]) else ""
    text = ""
    if policy:
        try:
            text = open(os.path.join(POLICY_DIR, policy + ".txt"), encoding="utf-8").read()
        except OSError:
            text = ""
    vpn_extra = [r["domain"] for r in q("SELECT domain FROM ml_vpn_domain")] if q1("SHOW TABLES LIKE 'ml_vpn_domain'") else []
    try:
        cat = cdnmap.catalog()
    except Exception:                                       # noqa: BLE001
        cat = None
    res = whyblocked.explain(host, policy, text, at, WF_DIR, cat, vpn_extra, ao_dir=AO_DIR, webscan_dir=WEBSCAN_DIR)
    notes = []
    if lst == "web-filter-exempt":
        notes.append("This user is in web-filter-exempt: the web filter does not apply to them.")
    elif user and not policy:
        notes.append("No policy for this user" + (f" (address list {lst})" if lst else "") + ". Policies set on the router "
                     "for an IP range or a DHCP lease are not known here.")
    quar = q1("""SELECT reason, since FROM ml_quarantine WHERE released_at IS NULL AND
                 ((%s <> '' AND username=%s) OR (%s <> '' AND ip=%s)) ORDER BY since DESC LIMIT 1""", (user, user, ip, ip))
    wu = winupdate_mode()
    if wu != "on" and lst != "web-filter-exempt" and any(h.get("kind") == "category" and h.get("name") == "windows-update" for h in res.get("lists", [])):
        office = wu == "office"
        now_in = datetime.now().weekday() < 6 and 9 <= datetime.now().hour < 17
        if res["verdict"] != "blocked":
            res["verdict"] = "blocked" if (not office or now_in) else "blocked-other-times"
            res["summary"] = ("Windows Update is OFF for everyone" + (" 9:00-17:00 Mon-Sat" if office else "")
                              + " (Blocking → Overview → Windows Update).")
        notes.insert(0, "Windows Update switch: " + ("off 9:00-17:00 Mon-Sat" if office else "off for everyone") + ".")
    if policy and policy_is_off(policy):
        res["verdict"] = "allowed"
        res["summary"] = f"Policy '{policy}' is turned OFF — nothing is blocked by it until it is turned on again."
        for r in res["rules"]:
            r["active"] = False
        notes.insert(0, f"Policy '{policy}' is OFF (Blocking → Policies → switch).")
    tmp = temp_allowed(user, ip, host) if (user or ip) else None
    if tmp and not quar:
        res["verdict"] = "allowed"
        notes.insert(0, f"Temporarily OPEN for this user until {tmp['until']} (exception #{tmp['id']}, Blocking → Requests).")
    if quar:
        res["verdict"] = "blocked"
        notes.insert(0, f"QUARANTINE since {quar['since']}: {quar['reason']} — no internet at all until released (Security).")
    # recent blocked attempts for this site (and user) from the router log
    a = type("A", (), {})()
    a.user, a.ip, a.days, a.n, a.policy = user, "" if user else ip, 7, 2000, ""
    pols = {r["username"]: r["list"] for r in q(mlreport.POLICY_SQL)}
    try:
        rows = mlreport.blocked_detail(a, sessions(), pols)
    except Exception:                                       # noqa: BLE001
        rows = []
    base = host.split(".", 1)[1] if host.count(".") > 1 else host
    recent = [r for r in rows if r.get("site") and (r["site"] == host or r["site"].endswith("." + base) or r["site"] == base
                                                   or host.endswith("." + r["site"]))][-20:]
    return jsonify(**res, user=user, ip=ip, list=lst, list_from=source, notes=notes, recent=list(reversed(recent)))


@app.get("/api/live")
@login_required()
def live():
    """Incremental tail of the DNS and web-filter logs. Pass back the returned cursor."""
    try:
        cursor = json.loads(request.args.get("cursor") or "{}")
    except ValueError:
        cursor = {}
    s, events, new_cursor = sessions(), [], {}
    for key, path in (("dns", mlreport.DNS_LOG), ("wf", mlreport.WF_LOG)):
        try:
            st = os.stat(path)
        except OSError:
            continue
        entry = cursor.get(key)
        if (isinstance(entry, list) and len(entry) == 2 and entry[0] == st.st_ino
                and isinstance(entry[1], int) and 0 <= entry[1] <= st.st_size):
            off, first = entry[1], False
        else:   # first call: the recent past; file rotated: from its start
            off, first = (max(0, st.st_size - 20000) if entry is None else 0), entry is None
        with open(path, "rb") as fh:
            fh.seek(off)
            chunk = fh.read(2_000_000)
        end = chunk.rfind(b"\n") + 1
        lines = chunk[:end].decode("utf-8", "replace").splitlines()
        if first and off and lines:
            lines = lines[1:]                     # started mid-line
        events += mlreport.live_events(path, lines, s, {})
        new_cursor[key] = [st.st_ino, off + end]
    user = request.args.get("user", "")
    if user:
        events = [e for e in events if e["user"] == user]
    events.sort(key=lambda e: e["time"])
    return jsonify(events=events[-300:], cursor=json.dumps(new_cursor))


@app.get("/api/traffic")
@login_required()
def traffic():
    by = request.args.get("by", "site")
    keys = {"site": "site", "ip": "client_ip", "user": "IF(username='','(no login)',username)",
            "day": "DATE(bucket)", "hour": "bucket"}
    if by not in keys:
        abort(400, "invalid by")
    a = report_args()
    site = request.args.get("site", "").lower()
    if site and not re.match(r"^[a-z0-9.-]{1,253}$", site):
        abort(400, "invalid site")
    where, args = ["bucket >= NOW() - INTERVAL %s HOUR"], [int(a.days * 24)]
    for col, val in (("username", a.user), ("client_ip", a.ip), ("site", site)):
        if val:
            where.append(f"{col}=%s")
            args.append(val)
    key = keys[by]
    order = f"{key} DESC" if by in ("day", "hour") else "SUM(bytes_down+bytes_up) DESC"
    rows = q(f"""SELECT {key} AS k, SUM(bytes_down) AS down, SUM(bytes_up) AS up,
                    COUNT(DISTINCT client_ip) AS devices, COUNT(DISTINCT site) AS sites,
                    COALESCE(LEFT(GROUP_CONCAT(DISTINCT NULLIF(username,'') ORDER BY username),60),'') AS users
                 FROM traffic_site WHERE {' AND '.join(where)} GROUP BY {key} ORDER BY {order} LIMIT %s""",
             args + [a.top])
    return jsonify(by=by, rows=jsonable(rows))


@app.get("/api/traffic-now")
@login_required()
def traffic_now():
    try:
        snap = json.load(open(mlreport.NOW_FILE))
    except (OSError, ValueError):
        return jsonify(available=False, rows=[])
    snap["rows"].sort(key=lambda r: -(r["down"] + r["up"]))
    snap["rows"] = snap["rows"][:200]
    snap["available"] = True
    snap["age"] = int(time.time() - snap.get("time", 0))
    return jsonify(snap)


# ------------------------------------------------------------------ hotspot business
SETTING_KEYS = {  # key -> (default, max length)
    "brand": ("MikrotikLover WiFi", 60), "ssid": ("Office-WiFi", 32), "hotspot_ssid": ("Guest-WiFi", 32),
    "hotspot_url": ("http://login.wifi", 120), "currency": ("Rs", 8), "contact": ("", 80),
    "card_footer": ("Login page opens automatically after connecting to the Wi-Fi.", 120),
}


def settings_get():
    out = {k: d for k, (d, _) in SETTING_KEYS.items()}
    out["radius_domain"] = ""
    for r in q("SELECT k, v FROM ml_setting"):
        if r["k"] in out:
            out[r["k"]] = r["v"]
    return out


@app.get("/api/settings")
@login_required()
def settings_read():
    return jsonify(settings_get())


@app.post("/api/settings")
@login_required("admin")
def settings_write():
    data = body()
    for k, (_, maxlen) in SETTING_KEYS.items():
        if k in data:
            v = str(data[k]).strip()
            if len(v) > maxlen or not v.isprintable():
                abort(400, f"invalid {k}")
            q("INSERT INTO ml_setting (k, v) VALUES (%s,%s) ON DUPLICATE KEY UPDATE v=VALUES(v)", (k, v))
    audit("update business settings", "ok")
    return jsonify(ok=True, message="Settings saved")


@app.get("/api/public/connect")
def public_connect():
    """Data for the public connect guide (no login). Only names users need anyway."""
    st = settings_get()
    out = {k: st[k] for k in ("brand", "ssid", "hotspot_ssid", "hotspot_url", "radius_domain", "contact")}
    # public certificate (Let's Encrypt / bought): phones check it with their own CA list, Domain = the public name
    pub = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('cert_mode','public_domain')")}
    out["cert_public"] = pub.get("cert_mode") == "public" and bool(pub.get("public_domain"))
    if out["cert_public"]:
        out["radius_domain"] = pub["public_domain"]
    return jsonify(out)


# ------------------------------------------------------------------ social WiFi: dashboard
SOCIAL_DEFAULTS = {"social_on": "0", "social_minutes": "60", "social_mb": "500", "social_rate": "",
                   "social_msg": "{brand}: aap ka WiFi code {code} hai"}


@app.get("/api/social")
@login_required()
def social_get():
    st = dict(SOCIAL_DEFAULTS)
    for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'social\\_%%' OR k='server_ip'"):
        if r["v"] != "":
            st[r["k"]] = r["v"]
    stats = q1("""SELECT COUNT(*) AS customers, IFNULL(SUM(consent),0) AS consent, IFNULL(SUM(last_seen >= CURDATE()),0) AS today,
                         IFNULL(SUM(first_seen >= CURDATE()),0) AS new_today, IFNULL(SUM(visits > 1),0) AS came_back FROM ml_social_user""")
    rows = q("SELECT phone, name, consent, visits, first_seen, last_seen, last_offer FROM ml_social_user ORDER BY last_seen DESC LIMIT 300")
    per_day = q("""SELECT DATE(created) AS day, COUNT(DISTINCT phone) AS phones FROM ml_social_otp WHERE used=1 AND created >= CURDATE() - INTERVAL 13 DAY
                   GROUP BY 1 ORDER BY 1""")
    return jsonify(settings=st, stats=jsonable([stats])[0], customers=jsonable(rows), per_day=jsonable(per_day))


@app.post("/api/social")
@login_required("admin")
def social_set():
    d = body()
    msgs = []
    for key, arg in (("minutes", "minutes"), ("mb", "mb"), ("rate", "rate"), ("message", "message")):
        if key in d and str(d[key]).strip() != "":
            ok, msg = radius_admin(["social", "set", arg, str(d[key]).strip()], timeout=120)
            if not ok:
                return result(ok, msg)
            msgs.append(msg)
    if "on" in d:
        ok, msg = radius_admin(["social", "on" if d["on"] else "off"], timeout=180)
        if not ok:
            return result(ok, msg)
        msgs.append(msg)
    return result(True, "\n".join(msgs) or "Nothing changed")


@app.get("/api/social/export.csv")
@login_required("admin")
def social_export():
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["phone", "name", "offers_ok", "visits", "first_seen", "last_seen"])
    for r in q("SELECT phone, name, consent, visits, first_seen, last_seen FROM ml_social_user ORDER BY last_seen DESC"):
        # a name starting with = + - @ would be a formula in Excel (phones are only + and digits)
        w.writerow([r["phone"], re.sub(r"^[=+\-@]", "", r["name"]), r["consent"], r["visits"], r["first_seen"], r["last_seen"]])
    audit("social customers exported", "ok")
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition": f'attachment; filename="wifi-customers-{datetime.now():%Y-%m-%d}.csv"'})


@app.post("/api/social/offer")
@login_required("admin")
def social_offer():
    d = body()
    text = str(d.get("text") or "").strip()
    if not text or len(text) > 300 or "\n" in text:
        abort(400, "offer text: one line, 300 characters at most")
    return result(*radius_admin(["social", "offer", text] + (["--dry-run"] if d.get("dry") else []), timeout=900))


@app.post("/api/social/forget")
@login_required("admin")
def social_forget():
    ph = field(body(), "phone", re.compile(r"^\+[0-9]{8,15}$"), required=True)
    return result(*radius_admin(["social", "forget", ph]))


# ------------------------------------------------------------------ social WiFi portal (port 8081, before login)
SOCIAL_CSP = ("default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
              "form-action 'self' http: https:; base-uri 'none'; frame-ancestors 'none'")
LOGIN_URL_RE = re.compile(r"^https?://[A-Za-z0-9.-]{1,253}(:\d{1,5})?/[A-Za-z0-9/_.-]{0,100}$")
CHAP_RE = re.compile(r"^[\\0-7a-zA-Z0-9]{0,200}$")


def _social_ctx():
    f = request.form if request.method == "POST" else request.args
    ctx = {}
    for k, rx, n in (("mac", r"^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$", 17), ("ip", r"^[0-9.]{7,15}$", 15), ("login", None, 400),
                     ("dst", r"^https?://\S{1,500}$", 500), ("chap_id", None, 200), ("chap_challenge", None, 200)):
        v = str(f.get(k, ""))[:n]
        if k == "login":
            v = v if LOGIN_URL_RE.match(v) else ""
        elif k.startswith("chap"):
            v = v if CHAP_RE.match(v) else ""
        elif v and not re.match(rx, v):
            v = ""
        ctx[k] = v
    return ctx


def _social_page(body_html, title="Free WiFi"):
    from html import escape
    st = settings_get()
    brand = escape(st.get("brand") or "WiFi")
    page = f"""<!doctype html><html lang="ur-Latn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>{escape(title)} — {brand}</title>
<link rel="stylesheet" href="/static/social.css"></head><body><main class="card"><h1>{brand}</h1>{body_html}</main>
<script src="/static/social.js"></script></body></html>"""
    return app.response_class(page, mimetype="text/html", headers={"X-ML-CSP": SOCIAL_CSP})


def _hidden(ctx, extra=None):
    from html import escape
    return "".join(f'<input type="hidden" name="{k}" value="{escape(v)}">' for k, v in {**ctx, **(extra or {})}.items())


def _social_on():
    return (q1("SELECT v FROM ml_setting WHERE k='social_on'") or {}).get("v") == "1"


def _phone_form(ctx, err="", phone="", name="", consent=True):
    from html import escape
    return _social_page(f"""<p class="lead">Apna mobile number likhein — SMS / WhatsApp par 6 hindson ka code aayega.</p>
{f'<p class="err">{escape(err)}</p>' if err else ''}
<form method="post" action="/social/send">{_hidden(ctx)}
<label>Mobile number<input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="03001234567" value="{escape(phone)}" required></label>
<label>Naam (zaroori nahi)<input name="name" maxlength="40" autocomplete="name" value="{escape(name)}"></label>
<label class="chk"><input type="checkbox" name="consent" value="1"{' checked' if consent else ''}> Offers aur deals SMS par bhejein</label>
<button type="submit">Code bhejein</button></form>
<p class="small">Free WiFi ki had hai (roz ka waqt / data). Aap ka number sirf is network ke liye rakha jata hai.</p>""")


@app.route("/social/start", methods=["GET", "POST"])
def social_start():
    if not _social_on():
        return _social_page("<p>Free WiFi abhi band hai. Staff se card lein.</p>")
    return _phone_form(_social_ctx())


@app.post("/social/send")
def social_send():
    from html import escape
    if not _social_on():
        return _social_page("<p>Free WiFi abhi band hai.</p>")
    ctx = _social_ctx()
    phone, name = str(request.form.get("phone", ""))[:20], str(request.form.get("name", ""))[:40]
    consent = request.form.get("consent") == "1"
    if not re.match(r"^[+0-9 -]{8,20}$", phone):
        return _phone_form(ctx, "Number ghalat hai — misal: 03001234567", phone, name, consent)
    ok, msg = radius_admin(["social", "otp", phone, ctx["mac"], ctx["ip"] or client_ip()], log=False, timeout=60)
    if not ok:
        return _phone_form(ctx, msg.splitlines()[-1] if msg else "Code nahi gaya", phone, name, consent)
    return _social_page(f"""<p class="lead">Code <b>{escape(phone)}</b> par bhej diya gaya. Yahan likhein:</p>
<form method="post" action="/social/verify">{_hidden(ctx, {"phone": phone, "name": name, "consent": "1" if consent else "0"})}
<label>6 hindson ka code<input name="code" inputmode="numeric" pattern="[0-9]{{6}}" maxlength="6" autocomplete="one-time-code" required autofocus></label>
<button type="submit">Internet chalu karein</button></form>
<form method="post" action="/social/start">{_hidden(ctx)}<button class="link" type="submit">Number badlein / naya code</button></form>""")


def _chap_bytes(s):
    """MikroTik's $(chap-id) / $(chap-challenge) are JavaScript strings with octal escapes (\\341...)."""
    out, i = bytearray(), 0
    while i < len(s):
        m = re.match(r"\\([0-7]{1,3})", s[i:])
        if m:
            out.append(int(m.group(1), 8) & 0xFF)
            i += len(m.group(0))
        else:
            out.append(ord(s[i]) & 0xFF)
            i += 1
    return bytes(out)


@app.post("/social/verify")
def social_verify():
    import hashlib
    from html import escape
    if not _social_on():
        return _social_page("<p>Free WiFi abhi band hai.</p>")
    ctx = _social_ctx()
    phone, name, code = str(request.form.get("phone", ""))[:20], str(request.form.get("name", ""))[:40], str(request.form.get("code", ""))[:6]
    consent = "1" if request.form.get("consent") == "1" else "0"
    ok, msg = radius_admin(["social", "verify", phone, code, ctx["mac"], name, consent], log=False, timeout=60)
    if not ok:
        return _social_page(f"""<p class="err">{escape(msg.splitlines()[-1] if msg else 'Code ghalat hai')}</p>
<form method="post" action="/social/verify">{_hidden(ctx, {"phone": phone, "name": name, "consent": consent})}
<label>6 hindson ka code<input name="code" inputmode="numeric" pattern="[0-9]{{6}}" maxlength="6" required autofocus></label>
<button type="submit">Dobara koshish</button></form>
<form method="post" action="/social/start">{_hidden(ctx)}<button class="link" type="submit">Naya code mangwayein</button></form>""")
    vals = dict(l.split("=", 1) for l in msg.splitlines() if "=" in l)
    user, pw = vals.get("user", ""), vals.get("pass", "")
    if ctx["chap_id"]:
        pw = hashlib.md5(_chap_bytes(ctx["chap_id"]) + pw.encode() + _chap_bytes(ctx["chap_challenge"])).hexdigest()
    if not ctx["login"]:
        return _social_page(f"""<p class="ok">Code sahi hai ✓</p><p>Ab Wi-Fi login page par yeh likhein:</p>
<p class="cred">Username: <b>{escape(user)}</b><br>Password: <b>{escape(vals.get('pass', ''))}</b></p>""")
    return _social_page(f"""<p class="ok">Code sahi hai ✓ — internet chalu ho raha hai …</p>
<form id="mlauto" method="post" action="{escape(ctx['login'])}">
<input type="hidden" name="username" value="{escape(user)}"><input type="hidden" name="password" value="{escape(pw)}">
<input type="hidden" name="dst" value="{escape(ctx['dst'])}"><input type="hidden" name="popup" value="true">
<button type="submit">Agar khud na khule to yahan dabayein</button></form>""", "Connecting")


@app.get("/quarantine")
def quarantine_page():
    """Warning page for a quarantined (infected) device — every http:// address it opens lands here
    (router dst-nat to nginx :8081). Public: the device has no login."""
    from html import escape
    ip = client_ip()
    row = None
    try:
        row = q1("""SELECT q.username, q.ip, q.reason, q.since FROM ml_quarantine q
                    WHERE q.released_at IS NULL AND (q.ip=%s OR q.username IN
                      (SELECT username FROM radacct WHERE framedipaddress=%s AND acctstoptime IS NULL))
                    ORDER BY q.since DESC LIMIT 1""", (ip, ip))
        st = settings_get()
    except pymysql.MySQLError:
        st = {}
    brand, contact = st.get("brand") or "Wi-Fi", st.get("contact") or ""
    reason = (row or {}).get("reason") or "suspicious traffic from this device"
    reason = re.sub(r"^auto:\s*", "", reason)
    info = ""
    if row:
        info = (f'<div class="kv"><b>Device</b><span>{escape(ip)}</span>'
                + (f'<b>User</b><span>{escape(row["username"])}</span>' if row.get("username") else "")
                + f'<b>Since</b><span>{escape(str(row["since"])[:16])}</span><b>Found</b><span>{escape(reason)}</span></div>')
    page = f"""<!doctype html><html lang="ur-Latn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Device band — {escape(brand)}</title><link rel="stylesheet" href="/static/quarantine.css"></head>
<body><main class="wrap">
<div class="card"><div class="icon" aria-hidden="true">!</div>
<h1>Aap ke device ka internet rok diya gaya hai</h1>
<p>{escape(brand)} network ne is device se <b>virus / malware</b> jaisi harkat dekhi hai, is liye doosre users ki hifazat ke liye is ka internet band hai.</p>
<p class="muted">Your device was taken off the internet because it looks infected (virus / malware). Please clean it.</p>
{info}</div>
<div class="card"><h2>Kya karein</h2><ol>
<li>Phone / laptop ko <b>update</b> karein (Settings &rarr; Software update).</li>
<li>Jo app aap ne haal hi mein <b>Play Store / App Store ke ilawa</b> kahin se install ki ho, use hata dein.</li>
<li>Antivirus se scan karein (Android: Google Play Protect; Windows: Microsoft Defender &rarr; Full scan).</li>
<li>Browser mein ajeeb extensions hata dein, aur zaroori passwords badal dein.</li>
<li>Phir neeche diye number par admin se rabta karein; device saaf hone par internet khol diya jayega.</li>
</ol></div>
<div class="card"><h2>Rabta (contact)</h2><p class="contact">{escape(contact) if contact else "Network admin"}</p>
<p class="muted">Is page ko band kar ke dobara kholne se internet wapas nahi aata — admin "Release" karega.</p></div>
</main></body></html>"""
    resp = app.response_class(page, mimetype="text/html")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/connect")
def connect_page():
    return send_from_directory(app.static_folder, "connect.html")


PLAN_RE = NAME_RE
DUR_RE = re.compile(r"^([0-9]{1,6}[dhms]?|-)$")
SIZE_RE = re.compile(r"^([0-9]{1,6}[KMGTkmgt]?|-)$")


@app.get("/api/plans")
@login_required()
def plans():
    rows = q("""SELECT p.name, p.price, p.validity_seconds, p.quota_bytes, p.quota_period, p.daily_seconds, p.description, p.fup_rate,
                  COALESCE((SELECT value FROM radgroupreply WHERE groupname=p.name AND attribute='Framed-Pool' LIMIT 1),'') AS pool,
                  COALESCE((SELECT value FROM radgroupreply WHERE groupname=p.name AND attribute='Mikrotik-Rate-Limit' LIMIT 1),'') AS rate,
                  COALESCE((SELECT value FROM radgroupcheck WHERE groupname=p.name AND attribute='Simultaneous-Use' LIMIT 1),'') AS devices,
                  COALESCE((SELECT REPLACE(value,'policy-','') FROM radgroupreply WHERE groupname=p.name AND attribute='Mikrotik-Address-List' LIMIT 1),'') AS policy,
                  (SELECT COUNT(*) FROM ml_account a WHERE a.plan=p.name) AS accounts,
                  (SELECT COUNT(*) FROM ml_account a WHERE a.plan=p.name AND a.first_login IS NOT NULL
                      AND (a.expires_at IS NULL OR a.expires_at > NOW())) AS active
                FROM ml_plan p ORDER BY p.price, p.name""")
    return jsonify(plans=jsonable(rows), currency=settings_get()["currency"])


@app.post("/api/plans")
@login_required("admin")
def plan_save():
    data = body()
    name = field(data, "name", PLAN_RE, required=True)
    args = ["plan", "add", name]
    spec = {"price": ("--price", re.compile(r"^[0-9]{1,8}(\.[0-9]{1,2})?$")), "validity": ("--validity", DUR_RE),
            "quota": ("--quota", SIZE_RE), "period": ("--period", re.compile(r"^(total|monthly|daily)$")),
            "daily_time": ("--daily-time", DUR_RE), "rate": ("--rate", re.compile(r"^[0-9A-Za-z/ ]{1,64}$|^-$")),
            "fup": ("--fup", re.compile(r"^[0-9A-Za-z/ ]{1,64}$|^-$")), "pool": ("--pool", re.compile(r"^[A-Za-z0-9._@+-]{1,64}$|^-$")),
            "devices": ("--devices", re.compile(r"^[0-9]{1,4}$|^-$")),
            "policy": ("--policy", re.compile(r"^[a-z0-9-]{1,40}$|^-$")),
            "description": ("--description", re.compile(r"^[\x20-\x7e]{0,128}$"))}
    for key, (opt, rx) in spec.items():
        if key in data:
            v = field(data, key, rx)
            if v or key == "description":
                args += [opt, v]
            elif data.get("edit"):
                args += [opt, "-"]
    return result(*radius_admin(args))


@app.delete("/api/plans/<name>")
@login_required("admin")
def plan_delete(name):
    if not PLAN_RE.match(name):
        abort(400, "invalid plan")
    return result(*radius_admin(["plan", "del", name] + (["--force"] if request.args.get("force") == "1" else [])))


@app.get("/api/vouchers")
@login_required()
def voucher_batches():
    rows = q("""SELECT b.id, b.plan, b.price, b.count, b.note, b.created_by, b.created_at,
                  COUNT(a.username) AS remaining,
                  COALESCE(SUM(a.first_login IS NULL),0) AS unused,
                  COALESCE(SUM(a.first_login IS NOT NULL AND (a.expires_at IS NULL OR a.expires_at > NOW())),0) AS active,
                  COALESCE(SUM(a.expires_at <= NOW()),0) AS expired
                FROM ml_voucher_batch b LEFT JOIN ml_account a ON a.voucher_batch=b.id
                GROUP BY b.id ORDER BY b.id DESC LIMIT 300""")
    return jsonify(batches=jsonable(rows), currency=settings_get()["currency"])


@app.post("/api/vouchers")
@login_required("admin")
def voucher_create():
    data = body()
    plan = field(data, "plan", PLAN_RE, required=True)
    count = field(data, "count", re.compile(r"^[0-9]{1,4}$"), required=True)
    if not 1 <= int(count) <= 1000:
        abort(400, "count: 1–1000")
    prefix = field(data, "prefix", re.compile(r"^[A-Za-z0-9]{0,6}$"))
    note = field(data, "note", re.compile(r"^[\x20-\x7e]{0,128}$"))
    args = ["voucher", "create", plan, count, "--by", session["user"]] + (["--prefix", prefix] if prefix else []) \
        + (["--pin"] if data.get("pin") else []) + (["--note", note] if note else [])
    ok, msg = radius_admin(args, action=f"voucher create {plan} x{count}")
    m = re.search(r"Batch #(\d+)", msg)
    return result(ok, msg.splitlines()[0] if ok else msg, batch=int(m.group(1)) if (ok and m) else None)


@app.get("/api/vouchers/<int:batch>")
@login_required()
def voucher_batch(batch):
    b = q1("SELECT id, plan, price, count, note, created_at FROM ml_voucher_batch WHERE id=%s", (batch,))
    if not b:
        abort(404, "no such batch")
    plan = q1("""SELECT p.*, COALESCE((SELECT value FROM radgroupreply WHERE groupname=p.name
                     AND attribute='Mikrotik-Rate-Limit' LIMIT 1),'') AS rate FROM ml_plan p WHERE p.name=%s""", (b["plan"],))
    codes = q("""SELECT a.username,
                   (SELECT value FROM radcheck c WHERE c.username=a.username AND c.attribute='Cleartext-Password' LIMIT 1) AS password,
                   a.first_login, a.expires_at,
                   CASE WHEN a.first_login IS NULL THEN 'unused' WHEN a.expires_at <= NOW() THEN 'expired' ELSE 'active' END AS status
                 FROM ml_account a WHERE a.voucher_batch=%s ORDER BY a.username""", (batch,))
    audit(f"view voucher batch #{batch}", "ok")
    return jsonify(batch=jsonable([b])[0], plan=jsonable([plan])[0] if plan else None, codes=jsonable(codes),
                   settings=settings_get())


@app.delete("/api/vouchers/<int:batch>")
@login_required("admin")
def voucher_delete(batch):
    return result(*radius_admin(["voucher", "del", str(batch)]))


@app.get("/api/sales")
@login_required()
def sales():
    days = min(max(int(request.args.get("days", 30) or 30), 1), 366)
    per_day = q("""SELECT DATE(at) AS day, COUNT(*) AS n, SUM(amount) AS amount,
                     SUM(kind='voucher') AS vouchers, SUM(kind='renew') AS renewals, SUM(kind='new') AS new_plans
                   FROM ml_sale WHERE at >= CURDATE() - INTERVAL %s DAY GROUP BY DATE(at) ORDER BY day""", (days,))
    per_plan = q("""SELECT plan, COUNT(*) AS n, SUM(amount) AS amount FROM ml_sale
                    WHERE at >= CURDATE() - INTERVAL %s DAY GROUP BY plan ORDER BY SUM(amount) DESC""", (days,))
    recent = q("SELECT at, username, plan, amount, kind FROM ml_sale ORDER BY id DESC LIMIT 50")
    return jsonify(per_day=jsonable(per_day), per_plan=jsonable(per_plan), recent=jsonable(recent),
                   currency=settings_get()["currency"])


@app.get("/api/traffic/user-sites")
@login_required()
def traffic_user_sites():
    """Top users by data, each with their top sites."""
    a = report_args()
    per_user = int_arg("per_user", 5, 1, 20)
    hours = int(a.days * 24)
    users_ = q("""SELECT IF(username='',client_ip,username) AS who, MAX(username) AS username,
                    SUM(bytes_down) AS down, SUM(bytes_up) AS up, COUNT(DISTINCT site) AS site_count
                  FROM traffic_site WHERE bucket >= NOW() - INTERVAL %s HOUR
                  GROUP BY IF(username='',client_ip,username) ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT %s""",
               (hours, min(a.top, 100)))
    out = []
    for u in users_:
        sites_ = q("""SELECT site, SUM(bytes_down) AS down, SUM(bytes_up) AS up FROM traffic_site
                      WHERE bucket >= NOW() - INTERVAL %s HOUR AND IF(username='',client_ip,username)=%s
                      GROUP BY site ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT %s""", (hours, u["who"], per_user))
        row = jsonable([u])[0]
        row["sites"] = jsonable(sites_)
        out.append(row)
    return jsonify(users=out)


SUB_ACTIONS = {"plan", "renew", "expiry", "quota"}


@app.post("/api/users/<name>/sub/<action>")
@login_required("admin")
def user_subscription(name, action):
    if not NAME_RE.match(name) or action not in SUB_ACTIONS:
        abort(404)
    data = body()
    free = ["--free"] if data.get("free") else []
    if action == "plan":
        return result(*radius_admin(["user", "plan", name, field(data, "plan", PLAN_RE) or "-"] + free))
    if action == "renew":
        return result(*radius_admin(["user", "renew", name] + free))
    if action == "expiry":
        v = field(data, "expiry", re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}( [0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$")) or "-"
        return result(*radius_admin(["user", "expiry", name, v]))
    v = field(data, "quota", SIZE_RE) or "-"
    return result(*radius_admin(["user", "quota", name, v]))


def account_info(name):
    acc = q1("""SELECT a.plan, a.first_login, a.expires_at, a.quota_since, a.voucher_batch,
                  COALESCE(a.quota_bytes, p.quota_bytes, 0) AS quota_bytes, COALESCE(p.quota_period,'total') AS quota_period,
                  COALESCE(p.daily_seconds,0) AS daily_seconds, COALESCE(p.validity_seconds,0) AS validity_seconds,
                  p.price, ml_check(a.username) AS radius_check
                FROM ml_account a LEFT JOIN ml_plan p ON p.name=a.plan WHERE a.username=%s""", (name,))
    if not acc:
        return None
    acc = jsonable([acc])[0]
    if int(acc["quota_bytes"]):
        start = {"daily": "CURDATE()", "monthly": "DATE_FORMAT(NOW(), '%%Y-%%m-01')"}.get(acc["quota_period"], "'1970-01-01'")
        used = q1(f"""SELECT COALESCE(SUM(acctinputoctets+acctoutputoctets),0) AS b FROM radacct
                      WHERE username=%s AND acctstarttime >= GREATEST(COALESCE(%s,'1970-01-01'), {start})""",
                  (name, acc["quota_since"]))
        acc["used_bytes"] = int(used["b"])
    return acc


# ------------------------------------------------------------------ CDN detective
@app.get("/api/cdn")
@login_required()
def cdn_lookup():
    import cdnmap
    try:
        r = cdnmap.lookup(request.args.get("q", ""))
    except ValueError as e:
        abort(400, str(e))
    return app.response_class(json.dumps(r, default=list), mimetype="application/json")


@app.get("/api/cdn/unknown")
@login_required()
def cdn_unknown():
    """Heaviest traffic whose site is still an IP or a shared-CDN name — candidates for the detective."""
    import cdnmap
    days = min(max(int(request.args.get("days", 1) or 1), 1), 90)
    rows = q("""SELECT site, SUM(bytes_down) AS down, SUM(bytes_up) AS up, COUNT(DISTINCT client_ip) AS devices
                FROM traffic_site WHERE bucket >= NOW() - INTERVAL %s DAY
                GROUP BY site ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT 400""", (days,))
    cat = cdnmap.catalog()
    out = []
    for r in jsonable(rows):
        is_ip = bool(re.match(r"^\d+\.\d+\.\d+\.\d+$", r["site"]))
        e = None if is_ip else cat.name(r["site"])
        if is_ip or (e and e["generic"]):
            r["kind"] = "ip" if is_ip else "shared CDN"
            r["owner"] = (cat.ip_owner(r["site"]) or {}).get("owner", "") if is_ip else e["app"]
            out.append(r)
    return jsonify(rows=out[:60])


@app.get("/api/cdn/apps")
@login_required()
def cdn_apps():
    import cdnmap
    apps = sorted(cdnmap.catalog().apps().values(), key=lambda x: (x["category"], x["app"]))
    learned_total = sum(1 for a in apps for d in a["domains"] if d["source"] == "learned")
    try:
        updated = json.load(open(cdnmap.LEARNED)).get("updated", "")
    except (OSError, ValueError):
        updated = ""
    return jsonify(apps=apps, learned=learned_total, updated=updated)


@app.post("/api/cdn/learn")
@login_required("admin")
def cdn_learn():
    return result(*radius_admin(["cdn", "learn"]))


@app.post("/api/cdn/reject")
@login_required("admin")
def cdn_reject():
    dom = field(body(), "domain", re.compile(r"^[a-z0-9.-]{1,253}$"), required=True)
    return result(*radius_admin(["cdn", "reject", dom]))


@app.post("/api/cdn/app")
@login_required("admin")
def cdn_app_action():
    """Discovered app: rename / merge into a known app / drop."""
    data = body()
    aid = field(data, "id", re.compile(r"^[a-z0-9.-]{1,253}$"), required=True)
    action = data.get("action")
    if action == "rename":
        name = field(data, "name", re.compile(r"^[\w .&+()'/-]{2,40}$"), required=True)
        cat = field(data, "category", re.compile(r"^[a-z]{2,20}$"))
        return result(*radius_admin(["cdn", "app-rename", aid, name] + ([cat] if cat else [])))
    if action == "merge":
        target = field(data, "target", re.compile(r"^[\w .&+()'/-]{2,60}$"), required=True)
        return result(*radius_admin(["cdn", "app-merge", aid, target]))
    if action == "drop":
        return result(*radius_admin(["cdn", "app-drop", aid]))
    abort(400, "action: rename | merge | drop")


@app.get("/api/cdn/rsc")
@login_required()
def cdn_rsc():
    import cdnmap
    appname = request.args.get("app", "")
    try:
        text = cdnmap.rsc_for(appname)
    except ValueError as e:
        abort(404, str(e))
    slug = re.sub(r"[^a-z0-9]+", "-", appname.lower()).strip("-")
    return app.response_class(text, mimetype="text/plain",
                              headers={"Content-Disposition": f'attachment; filename="block-{slug}.rsc"'})


# ------------------------------------------------------------------ ports & protocols
@app.get("/api/ports")
@login_required()
def ports_report():
    import ports
    by = request.args.get("by", "port")
    a = report_args()
    site = request.args.get("app", "").lower()
    if site and not re.match(r"^[a-z0-9.()/ -]{1,253}$", site):
        abort(400, "invalid app")
    where, args = ["bucket >= NOW() - INTERVAL %s HOUR"], [int(a.days * 24)]
    for col, val in (("username", a.user), ("client_ip", a.ip), ("site", site)):
        if val:
            where.append(f"{col}=%s")
            args.append(val)
    w = " AND ".join(where)
    if by == "port":
        rows = q(f"""SELECT proto, port, direction, SUM(bytes_down) AS down, SUM(bytes_up) AS up, COUNT(DISTINCT client_ip) AS devices,
                       SUM(flows) AS flows, LEFT(GROUP_CONCAT(DISTINCT site ORDER BY site SEPARATOR ', '),200) AS apps
                     FROM traffic_port WHERE {w} GROUP BY proto, port, direction ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT %s""", args + [a.top])
    elif by == "app":
        rows = q(f"""SELECT site, proto, port, direction, SUM(bytes_down) AS down, SUM(bytes_up) AS up, COUNT(DISTINCT client_ip) AS devices
                     FROM traffic_port WHERE {w} GROUP BY site, proto, port, direction ORDER BY site, SUM(bytes_down+bytes_up) DESC LIMIT %s""", args + [a.top * 10])
    elif by == "device":
        rows = q(f"""SELECT client_ip, MAX(NULLIF(username,'')) AS username, proto, port, direction, SUM(bytes_down) AS down, SUM(bytes_up) AS up,
                       LEFT(GROUP_CONCAT(DISTINCT site ORDER BY site SEPARATOR ', '),200) AS apps
                     FROM traffic_port WHERE {w} GROUP BY client_ip, proto, port, direction ORDER BY client_ip, SUM(bytes_down+bytes_up) DESC LIMIT %s""", args + [a.top * 10])
    elif by == "in":
        rows = q(f"""SELECT client_ip, MAX(NULLIF(username,'')) AS username, proto, port, SUM(bytes_down) AS down, SUM(bytes_up) AS up,
                       SUM(flows) AS flows, MIN(bucket) AS first, MAX(bucket) AS last
                     FROM traffic_port WHERE {w} AND direction='in' GROUP BY client_ip, proto, port ORDER BY SUM(bytes_down+bytes_up) DESC LIMIT %s""", args + [a.top])
    elif by == "profile":
        rows = q("SELECT site, proto, port, direction, bytes, flows, first_seen, last_seen FROM ml_app_port WHERE site NOT REGEXP '^[0-9.]+$'"
                 + (" AND site=%s" if site else "") + " ORDER BY site, bytes DESC LIMIT 2000", [site] if site else None)
    else:
        abort(400, "by: port | app | device | in | profile")
    out = jsonable(rows)
    for r in out:
        r["protocol"] = ports.proto_name(r["proto"])
        r["service"] = ports.name(r["proto"], r["port"])
    totals = q1("""SELECT COALESCE(SUM(IF(direction='out',bytes_down+bytes_up,0)),0) AS out_b,
                      COALESCE(SUM(IF(direction='in',bytes_down+bytes_up,0)),0) AS in_b,
                      COALESCE(SUM(IF(direction='p2p',bytes_down+bytes_up,0)),0) AS p2p_b,
                      COUNT(DISTINCT CONCAT(proto,'/',port)) AS ports
                   FROM traffic_port WHERE bucket >= NOW() - INTERVAL %s HOUR""", (int(a.days * 24),))
    return jsonify(by=by, rows=out, totals=jsonable([totals])[0])


# ------------------------------------------------------------------ app inventory (auto list of apps used on the network)
@app.get("/api/apps")
@login_required()
def apps_inventory():
    a = report_args()
    cat = request.args.get("category", "")
    if cat and not re.match(r"^[a-z]{2,20}$", cat):
        abort(400, "invalid category")
    days = int(max(a.days, 1))
    w, tw, args, targs = ["d.day >= CURDATE() - INTERVAL %s DAY"], ["t.bucket >= CURDATE() - INTERVAL %s DAY"], [days], [days]
    for col, val in (("username", a.user), ("client_ip", a.ip)):
        if val:
            w.append(f"d.{col}=%s"); args.append(val)
            tw.append(f"t.{col}=%s"); targs.append(val)
    if cat:
        w.append("a.category=%s"); args.append(cat)
    os_ = request.args.get("os", "")
    if os_ and os_ not in ("android", "apple", "windows"):
        abort(400, "invalid os")
    if os_:                                               # only devices of that kind (ml_device, from their system names)
        w.append("d.client_ip IN (SELECT client_ip FROM ml_device WHERE os=%s)"); args.append(os_)
    rows = q(f"""SELECT a.site, a.app, a.category, a.source, a.first_seen, a.last_seen,
                        COUNT(DISTINCT d.client_ip) AS devices, COUNT(DISTINCT NULLIF(d.username,'')) AS users, SUM(d.queries) AS lookups,
                        COUNT(DISTINCT IF(dv.os='android', d.client_ip, NULL)) AS android,
                        COUNT(DISTINCT IF(dv.os='apple', d.client_ip, NULL)) AS apple,
                        COUNT(DISTINCT IF(dv.os='windows', d.client_ip, NULL)) AS windows,
                        (SELECT COALESCE(SUM(t.bytes_down+t.bytes_up),0) FROM traffic_site t WHERE t.site=a.site AND {' AND '.join(tw)}) AS bytes,
                        a.first_seen >= NOW() - INTERVAL 7 DAY AS is_new
                 FROM ml_app a JOIN ml_app_day d ON d.site=a.site LEFT JOIN ml_device dv ON dv.client_ip=d.client_ip WHERE {' AND '.join(w)}
                 GROUP BY a.site ORDER BY devices DESC, lookups DESC LIMIT %s""", targs + args + [a.top])
    totals = q1("SELECT COUNT(*) AS apps, COALESCE(SUM(first_seen >= NOW() - INTERVAL 7 DAY),0) AS new_apps, "
                "COALESCE(SUM(source='discovered'),0) AS discovered FROM ml_app")
    cats = q("SELECT category, COUNT(*) AS n FROM ml_app GROUP BY category ORDER BY n DESC")
    kinds = q("SELECT os, COUNT(*) AS n FROM ml_device WHERE last_seen >= NOW() - INTERVAL %s DAY GROUP BY os", (days,))
    return jsonify(rows=jsonable(rows), totals=jsonable([totals])[0], categories=jsonable(cats),
                   devices={r["os"]: int(r["n"]) for r in kinds})


@app.get("/api/apps/detail")
@login_required()
def app_detail():
    """Everything known about one app: its names, server addresses, ports, devices (with their kind)."""
    import cdnmap
    site = request.args.get("site", "").lower()
    if not re.match(r"^[a-z0-9.-]{1,253}$", site):
        abort(400, "invalid site")
    days = int(max(report_args().days, 1))
    a = q1("SELECT site, app, category, source, first_seen, last_seen FROM ml_app WHERE site=%s", (site,))
    if not a:
        abort(404, "unknown app")
    names = q("""SELECT host, base, first_seen, last_seen, ips FROM ml_domain WHERE app=%s ORDER BY last_seen DESC LIMIT 500""", (a["app"],))
    lookups = {r["host"]: int(r["n"]) for r in q("""SELECT host, SUM(lookups) AS n FROM ml_domain_day WHERE day >= CURDATE() - INTERVAL %s DAY
                                                    AND host IN (SELECT host FROM ml_domain WHERE app=%s) GROUP BY host""", (days, a["app"]))}
    for r in names:
        r["lookups"] = lookups.get(r["host"], 0)
    servers = q("""SELECT ip, host, first_seen, last_seen, lookups FROM ml_app_server WHERE site=%s ORDER BY last_seen DESC LIMIT 500""", (site,))
    ports = q("""SELECT proto, port, direction, bytes, flows, first_seen, last_seen FROM ml_app_port WHERE site=%s ORDER BY bytes DESC LIMIT 100""", (site,))
    devs = q("""SELECT d.client_ip, MAX(NULLIF(d.username,'')) AS username, SUM(d.queries) AS lookups, MIN(d.day) AS first_day, MAX(d.day) AS last_day,
                       MAX(dv.os) AS os, MAX(dv.evidence) AS evidence
                FROM ml_app_day d LEFT JOIN ml_device dv ON dv.client_ip=d.client_ip
                WHERE d.site=%s AND d.day >= CURDATE() - INTERVAL %s DAY GROUP BY d.client_ip ORDER BY lookups DESC LIMIT 500""", (site, days))
    known = []
    try:
        hit = next((v for v in cdnmap.catalog().apps().values() if v.get("site") == site or v.get("app") == a["app"]), None)
        known = [d["domain"] for d in hit["domains"]] if hit else []
    except Exception:                                     # noqa: BLE001
        known = []
    for r in ports:
        r["proto"] = {6: "tcp", 17: "udp"}.get(int(r["proto"]), str(r["proto"]))
    return jsonify(app=jsonable([a])[0], names=jsonable(names), servers=jsonable(servers), ports=jsonable(ports),
                   devices=jsonable(devs), known=known[:300], days=days)


@app.get("/api/apps/users")
@login_required()
def app_users():
    a = report_args()
    site = request.args.get("site", "").lower()
    if not re.match(r"^[a-z0-9.-]{1,253}$", site):
        abort(400, "invalid site")
    days = int(max(a.days, 1))
    rows = q("""SELECT d.client_ip, MAX(NULLIF(d.username,'')) AS username, SUM(d.queries) AS lookups, MIN(d.day) AS first_day, MAX(d.day) AS last_day,
                       (SELECT COALESCE(SUM(t.bytes_down+t.bytes_up),0) FROM traffic_site t
                         WHERE t.site=%s AND t.client_ip=d.client_ip AND t.bucket >= CURDATE() - INTERVAL %s DAY) AS bytes
                FROM ml_app_day d WHERE d.site=%s AND d.day >= CURDATE() - INTERVAL %s DAY
                GROUP BY d.client_ip ORDER BY lookups DESC LIMIT 500""", (site, days, site, days))
    return jsonify(rows=jsonable(rows))


# ------------------------------------------------------------------ blocking: policies, router sync
CATEGORY_INFO = {
    "social": "Social media — Facebook, Instagram, TikTok, Snapchat, X, Likee, Snack Video ...",
    "social-video": "Only VIDEOS in Facebook/Instagram, YouTube and TikTok (chat + photos keep working)",
    "video-streaming": "YouTube (whole), Netflix, Prime, Disney+, Hotstar, Tamasha, Tapmad ...",
    "gaming": "PUBG, Free Fire, Roblox, Minecraft, Steam, Epic, Clash of Clans, online games ...",
    "messaging": "WhatsApp, Telegram, Signal, Viber, imo, Discord",
    "torrent-piracy": "Torrent sites and trackers",
    "keywords": "Adult words in site names (sex, xxx, porn ...)",
    "vpn-proxy": "VPN / proxy websites only (use \"Block VPN\" for apps, servers and protocols too)",
    "windows-update": "Windows Update (service, downloads, peer downloads) — Office, Outlook, Teams, Store keep working",
    "custom": "Your own list (webfilter/categories/custom.txt)",
}


def parse_policy(text):
    """policy file -> {description, rules: [{kind, value, time}]} (what the dashboard editor shows)."""
    lines = text.splitlines()
    desc = lines[0].lstrip("# ").strip() if lines and lines[0].startswith("#") else ""
    rules = []
    for line in lines:
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        m = re.search(r"\s+time=(\S+)", line)
        t = m.group(1) if m else ""
        line = re.sub(r"\s+time=\S+", "", line)
        key, _, val = line.partition(" ")
        rules.append({"kind": key, "value": val.strip(), "time": t})
    return {"description": desc, "rules": rules}


def policies_off():
    try:
        return {l.strip() for l in open(os.path.join(POLICY_DIR, ".off"), encoding="utf-8") if l.strip()}
    except OSError:
        return set()


def policy_is_off(name):
    return name in policies_off()


def policy_members():
    users, groups = {}, {}
    for r in q("SELECT username, value FROM radreply WHERE attribute='Mikrotik-Address-List' AND value LIKE 'policy-%%'"):
        users.setdefault(r["value"][7:], []).append(r["username"])
    for r in q("SELECT groupname, value FROM radgroupreply WHERE attribute='Mikrotik-Address-List' AND value LIKE 'policy-%%'"):
        groups.setdefault(r["value"][7:], []).append(r["groupname"])
    return users, groups


def router_info():
    info = {"version": "", "built": "", "url": "", "has_key": False}
    try:
        info["version"] = open(os.path.join(ROUTER_DIR, "version")).read().strip()
        info["built"] = datetime.fromtimestamp(os.path.getmtime(os.path.join(ROUTER_DIR, "sync.rsc"))).strftime("%Y-%m-%d %H:%M")
        info["vpn_servers"] = sum(1 for l in open(os.path.join(ROUTER_DIR, "vpn-servers.rsc")) if "list=vpn-servers address=" in l)
    except OSError:
        pass
    info["has_key"] = os.path.exists(os.path.join(ROUTER_DIR, "key"))
    dom = (q1("SELECT v FROM ml_setting WHERE k='radius_domain'") or {}).get("v") or "radius.local"
    info["host"] = dom
    info["port"] = web_port()
    info["url"] = f"https://{dom}:{info['port']}/api/public/router"
    return info


def web_port():
    p = request.headers.get("X-Forwarded-Port", "") or CONF.get("WEB_PORT", "8443")
    return p if re.match(r"^\d{1,5}$", p) else "8443"


@app.get("/api/blocking")
@login_required()
def blocking():
    import cdnmap
    users, groups = policy_members()
    off = policies_off()
    nets = policy_nets()
    pols = []
    for f in sorted(os.listdir(POLICY_DIR)) if os.path.isdir(POLICY_DIR) else []:
        if not f.endswith(".txt") or f == "README.txt":
            continue
        text = open(os.path.join(POLICY_DIR, f), encoding="utf-8", errors="replace").read()
        name = f[:-4]
        pols.append({"name": name, "text": text, **parse_policy(text), "users": sorted(users.get(name, [])),
                     "groups": sorted(groups.get(name, [])), "enabled": name not in off,
                     "nets": [n for n in nets if n["policy"] == name]})
    cats = []
    for c, d in CATEGORY_INFO.items():
        if c == "keywords" or os.path.exists(os.path.join(WF_DIR, "categories", c + ".txt")):
            cats.append({"name": c, "description": d})
    apps = sorted(({"app": a["app"], "category": a["category"] or "other", "discovered": bool(a.get("discovered"))}
                   for a in cdnmap.catalog().apps().values()), key=lambda a: (a["category"], a["app"].lower()))
    allow_only = ao_profiles()
    return jsonify(policies=pols, categories=cats, apps=apps, allow_only=allow_only, router=router_info(), paused=blocking_paused())


def blocking_paused():
    return (q1("SELECT v FROM ml_setting WHERE k='blocking_pause'") or {}).get("v") == "1"


def _span(t):
    a, _, b = t.partition("-")
    if b:
        return int(ipaddress.IPv4Address(a)), int(ipaddress.IPv4Address(b))
    n = ipaddress.IPv4Network(t, strict=False)
    return int(n.network_address), int(n.broadcast_address)


def policy_nets():
    """Networks / ranges / IPs with a policy (no login), each with the others it overlaps (both policies apply there)."""
    rows = q("SELECT id, policy, target, comment, created FROM ml_policy_net ORDER BY policy, id")
    for r in rows:
        r["created"] = str(r["created"])
        try:
            lo, hi = _span(r["target"])
        except ValueError:
            r["overlaps"] = []
            continue
        r["overlaps"] = []
        for o in rows:
            if o is r or o["policy"] == r["policy"]:
                continue
            try:
                lo2, hi2 = _span(o["target"])
            except ValueError:
                continue
            if lo <= hi2 and lo2 <= hi:
                r["overlaps"].append(f"{o['target']} ({o['policy']})")
    return rows


@app.post("/api/policies/net")
@login_required("admin")
def policy_net_add():
    data = body()
    pol = field(data, "policy", POLICY_RE, required=True)
    target = field(data, "target", re.compile(r"^[0-9./-]{7,40}$"), required=True)
    comment = field(data, "comment", re.compile(r'^[^"\\$]{0,100}$'))
    return result(*radius_admin(["policy", "net", "add", pol, target] + ([comment] if comment else []), timeout=300))


@app.post("/api/policies/net/<int:nid>/del")
@login_required("admin")
def policy_net_del(nid):
    return result(*radius_admin(["policy", "net", "del", str(nid)], timeout=300))


@app.post("/api/blocking/pause")
@login_required("admin")
def blocking_pause():
    return result(*radius_admin(["policy", "pause" if body().get("on") else "resume"], timeout=300))


@app.get("/api/blocking/summary")
@login_required()
def blocking_summary():
    """Small numbers for the Blocking overview and the tab badges."""
    import webscan
    users, groups = policy_members()
    npol = len([f for f in os.listdir(POLICY_DIR) if f.endswith(".txt") and f != "README.txt"]) if os.path.isdir(POLICY_DIR) else 0
    pending = q1("SELECT COUNT(*) AS n FROM ml_unblock WHERE status='pending'") or {}
    open_now = q1("SELECT COUNT(*) AS n FROM ml_unblock WHERE status='allowed' AND until > NOW()") or {}
    sugg, reading = 0, 0
    try:
        for key in webscan.targets(POLICY_DIR, AO_DIR):
            st = webscan.load(WEBSCAN_DIR, key)
            sugg += len(st.get("suggest", {})) + len(st.get("suggest_net", {}))
            sc = st.get("scanning")
            reading += 1 if sc and time.time() - sc.get("since", 0) < 900 else 0
    except Exception:                                     # noqa: BLE001 — the overview still shows the rest
        pass
    return jsonify(paused=blocking_paused(), nets=int((q1("SELECT COUNT(*) AS n FROM ml_policy_net") or {}).get("n", 0) or 0),
                   policies=npol, off=len(policies_off()), users=len({u for v in users.values() for u in v}),
                   groups=len({g for v in groups.values() for g in v}), requests=int(pending.get("n", 0) or 0),
                   exceptions=int(open_now.get("n", 0) or 0), suggestions=sugg, reading=reading, router=router_info(),
                   winupdate=winupdate_mode(), windows_devices=int((q1("SELECT COUNT(*) AS n FROM ml_device WHERE os='windows' "
                                                                       "AND last_seen >= NOW() - INTERVAL 7 DAY") or {}).get("n", 0) or 0))


def winupdate_mode():
    v = (q1("SELECT v FROM ml_setting WHERE k='winupdate'") or {}).get("v") or "on"
    return v if v in ("on", "off", "office") else "on"


@app.post("/api/winupdate")
@login_required("admin")
def winupdate_set():
    mode = str(body().get("mode", ""))
    if mode not in ("on", "off", "office"):
        abort(400, "mode: on | off | office")
    return result(*radius_admin(["winupdate", mode], timeout=300))


@app.post("/api/policies")
@login_required("admin")
def policy_save():
    data = body()
    name = field(data, "name", POLICY_RE, required=True)
    text = str(data.get("text", ""))
    if len(text) > 20000 or not text.strip() or re.search(r"[^\x20-\x7e\n\t -￿]", text):
        abort(400, "invalid policy text")
    return result(*radius_admin(["policy", "set", name], stdin=text.replace("\r", "") + "\n", action=f"policy set {name}"))


@app.post("/api/policies/<name>/<onoff>")
@login_required("admin")
def policy_onoff(name, onoff):
    if not POLICY_RE.match(name) or onoff not in ("on", "off"):
        abort(404)
    return result(*radius_admin(["policy", onoff, name], action=f"policy {onoff} {name}"))


@app.delete("/api/policies/<name>")
@login_required("admin")
def policy_delete(name):
    if not POLICY_RE.match(name):
        abort(400, "invalid name")
    return result(*radius_admin(["policy", "del", name]))


@app.post("/api/router/build")
@login_required("admin")
def router_build():
    return result(*radius_admin(["policy", "build"]))


def router_key():
    try:
        return open(os.path.join(ROUTER_DIR, "key")).read().strip()
    except OSError:
        return ""


def autosync_text(server_ip, key, info):
    if not (q1("SELECT v FROM ml_setting WHERE k='server_ip'") or {}).get("v"):
        radius_admin(["security", "quarantine-server", server_ip], action=f"server IP {server_ip} (router script)")
    tpl = open(os.path.join(HERE, "autosync.rsc"), encoding="utf-8").read()
    return (tpl.replace("radius.example.lan", info["host"]).replace("192.168.88.10", server_ip)
               .replace(":8443", f":{info['port']}").replace("PUT-THE-KEY-HERE", key))


@app.get("/api/router/autosync.rsc")
@login_required("admin")
def router_autosync():
    """mikrotik/autosync.rsc with this server's name, address, port and key filled in."""
    key = router_key()
    if not key:
        abort(409, "build the router rules first")
    info = router_info()
    host = request.host.rsplit(":", 1)[0].strip("[]")
    server_ip = request.args.get("ip", "") or (host if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) else "")
    if not re.match(r"^\d+\.\d+\.\d+\.\d+$", server_ip):
        abort(400, "give the server's IP address as the router sees it (?ip=...)")
    text = autosync_text(server_ip, key, info)
    audit("router autosync script downloaded", "ok")
    return app.response_class(text, mimetype="text/plain",
                              headers={"Content-Disposition": 'attachment; filename="mikrotiklover-autosync.rsc"'})


def _router_file(name):
    key = request.args.get("key", "")
    if not key or not hmac.compare_digest(key, router_key()):
        abort(403)
    try:
        return open(os.path.join(ROUTER_DIR, name), encoding="utf-8").read()
    except OSError:
        abort(404)


def note_fetch(what, version=""):
    """Remember when a router took its auto-sync files (health check: does the router have the new rules?)."""
    try:
        with db().cursor() as c:
            c.execute("INSERT INTO ml_router_fetch (router_ip, what, at, version) VALUES (%s, %s, NOW(), %s) "
                      "ON DUPLICATE KEY UPDATE at=NOW(), version=VALUES(version)", (client_ip()[:45], what, version[:64]))
        db().commit()
    except Exception:                                       # noqa: BLE001 — never stop a router sync for a note
        pass


def _ros6():
    """the router asked for the RouterOS 6 copy (autosync.rsc adds v=6 on RouterOS 6)"""
    return request.args.get("v", "") == "6"


@app.get("/api/public/router/version")
def router_version():
    v = _router_file("version6" if _ros6() else "version").strip()
    note_fetch("version", ("v6:" if _ros6() else "") + v)
    return app.response_class(v, mimetype="text/plain")


@app.get("/api/public/router/sync.rsc")
def router_sync():
    six = _ros6()
    body = _router_file("sync6.rsc" if six else "sync.rsc")
    try:
        v = open(os.path.join(ROUTER_DIR, "version6" if six else "version"), encoding="utf-8").read().strip()
    except OSError:
        v = ""
    note_fetch("sync", ("v6:" if six else "") + v)
    return app.response_class(body, mimetype="text/plain")


# ------------------------------------------------------------------ departments (shared speed) + traffic graphs
DEPT_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,23}$")
RATE_RE = re.compile(r"^(0|\d{1,6}(\.\d{1,3})?[kKmMgG]?)$")
RANGES = {"6h": (6 * 3600, 5, 600), "24h": (86400, 5, 1800), "7d": (7 * 86400, 60, 3 * 3600), "30d": (30 * 86400, 60, 12 * 3600)}


def dept_of_users():
    """{username: department}: the user's own entry, else their group's."""
    out = {}
    for r in q("""SELECT g.username, m.dept FROM radusergroup g JOIN ml_dept_member m ON m.kind='group' AND m.name=g.groupname
                  ORDER BY g.priority DESC"""):
        out[r["username"]] = r["dept"]
    for r in q("SELECT name, dept FROM ml_dept_member WHERE kind='user'"):
        out[r["name"]] = r["dept"]
    return out


def dept_users(dept):
    return sorted(u for u, d in dept_of_users().items() if d == dept)


def _router_key_ok():
    key = request.args.get("key", "")
    return bool(key) and bool(router_key()) and hmac.compare_digest(key, router_key())


@app.get("/api/public/router/dept.rsc")
def router_dept():
    """Who is in which department now (address lists). Also part of live.rsc."""
    if not _router_key_ok():
        abort(403)
    return app.response_class(dept_script(), mimetype="text/plain", headers={"Cache-Control": "no-store"})


@app.get("/api/public/router/live.rsc")
def router_live():
    """Every minute from each router (sync.rsc: ml-live): department members + temporary exceptions."""
    if not _router_key_ok():
        abort(403)
    text = (dept_script() if q1("SELECT 1 FROM ml_department LIMIT 1") else "") + temp_script() + ips_script() + macpol_script()
    return app.response_class(text, mimetype="text/plain", headers={"Cache-Control": "no-store"})


def macpol_script():
    """Wi-Fi (WPA-Enterprise) users and MAC devices: policy by MAC, the router finds the IP (tools/macpolicy.py)"""
    import macpolicy
    on = (q1("SELECT v FROM ml_setting WHERE k='wifi_policy'") or {}).get("v") != "0"
    dom = (q1("SELECT v FROM ml_setting WHERE k='radius_domain'") or {}).get("v") or "radius.local"
    try:
        rows = macpolicy.rows(q) if on else []
    except pymysql.MySQLError:             # an old database without ml_mac_ip: leave the part out this minute
        return ""
    return macpolicy.script(rows, f"https://{dom}:{web_port()}/api/public/router", router_key(), on)


@app.post("/api/public/router/macip")
def router_macip():
    """A router tells which IP each MAC of the Wi-Fi policy list has (ml-live, only when it changed)."""
    if not _router_key_ok():
        abort(403)
    if (request.content_length or 0) > 262144:
        abort(413)
    import macpolicy
    found = macpolicy.parse_report(request.get_data(as_text=True))
    text = "".join(f"{m}|{ip}\n" for m, ip in found.items())
    ok, out = radius_admin(["wifipolicy", "report", client_ip()], stdin=text, log=False, timeout=60)
    return app.response_class("ok" if ok else "failed", mimetype="text/plain", status=200 if ok else 500)


# ------------------------------------------------------------------ public certificate (Let's Encrypt / bought)
@app.get("/api/cert")
@login_required("admin")
def cert_get():
    ok, out = radius_admin(["cert", "json"], log=False, timeout=30)
    try:
        return jsonify(json.loads(out.splitlines()[-1]) if ok else {"mode": "own"})
    except (ValueError, IndexError):
        return jsonify(mode="own")


@app.post("/api/cert/<action>")
@login_required("admin")
def cert_action(action):
    data = body()
    if action == "letsencrypt":
        dom = field(data, "domain", re.compile(r"^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$"), required=True)
        em = field(data, "email", re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$"), required=True)
        method = field(data, "method", re.compile(r"^(http|cloudflare)$"), required=True)
        token = ""
        if method == "cloudflare":
            token = field(data, "token", re.compile(r"^[A-Za-z0-9_-]{20,200}$"), required=True)
        return result(*radius_admin(["cert", "letsencrypt", dom, "--email", em, f"--{method}"], stdin=token + "\n",
                                    action=f"Let's Encrypt certificate for {dom}", timeout=600))
    if action == "import":
        crt, key = str(data.get("fullchain", "")), str(data.get("key", ""))
        if "BEGIN CERTIFICATE" not in crt or "PRIVATE KEY" not in key or len(crt) > 32768 or len(key) > 16384:
            abort(400, "paste the certificate with its chain (PEM) and its private key (PEM)")
        import tempfile
        d = tempfile.mkdtemp(prefix="mlcert-")
        try:
            for n, v in (("fullchain.pem", crt), ("privkey.pem", key)):
                with open(os.open(os.path.join(d, n), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as f:
                    f.write(v)
            return result(*radius_admin(["cert", "import", os.path.join(d, "fullchain.pem"), os.path.join(d, "privkey.pem")],
                                        action="certificate imported", timeout=120))
        finally:
            for n in ("fullchain.pem", "privkey.pem"):
                try:
                    os.unlink(os.path.join(d, n))
                except OSError:
                    pass
            os.rmdir(d)
    if action in ("renew", "own"):
        return result(*radius_admin(["cert", action] + (["--force"] if action == "renew" and data.get("force") else []), timeout=600))
    abort(404)


@app.get("/api/wifipolicy")
@login_required()
def wifipolicy_get():
    import macpolicy
    on = (q1("SELECT v FROM ml_setting WHERE k='wifi_policy'") or {}).get("v") != "0"
    return jsonify(on=on, rows=macpolicy.rows(q))


@app.post("/api/wifipolicy")
@login_required("admin")
def wifipolicy_set():
    data = body()
    return result(*radius_admin(["wifipolicy", "on" if data.get("on") else "off"]))


def ips_script():
    """RouterOS script: addresses the IPS blocked (list ml-ips, dropped by the mlips raw rules), only when the list changed."""
    import hashlib
    rows = q("""SELECT ip, LEFT(reason, 60) AS reason, GREATEST(TIMESTAMPDIFF(SECOND, NOW(), until), 60) AS secs FROM ml_ips_block
                WHERE until > NOW() ORDER BY created DESC LIMIT 5000""")
    body = []
    for r in rows:
        try:
            ip = str(ipaddress.ip_address(r["ip"]))
        except ValueError:
            continue
        reason = re.sub(r'[^\w .,:()/-]', "", r["reason"] or "")
        body.append(f'/ip firewall address-list add list=ml-ips address={ip} timeout={int(r["secs"])}s comment="mlips: {reason}"')
    sig = hashlib.sha1("\n".join(sorted(x.split(" timeout=")[0] for x in body)).encode()).hexdigest()[:16]
    return ("\n:global mlIpsSig\n"
            f':if ($mlIpsSig != "{sig}") do={{\n'
            '/ip firewall address-list remove [find list=ml-ips comment~"^mlips"]\n'
            + "".join(f":do {{ {l} }} on-error={{}}\n" for l in body)
            + f':set mlIpsSig "{sig}"\n}}\n')


def active_exceptions():
    """Temporary exceptions open now: [{id, username, ip, host, policy, until}]."""
    return q("SELECT id, username, ip, host, policy, until FROM ml_unblock WHERE status='allowed' AND until > NOW() ORDER BY id")


def user_policy_list(user):
    r = q1("SELECT value FROM radreply WHERE username=%s AND attribute='Mikrotik-Address-List' LIMIT 1", (user,)) or \
        q1("""SELECT gr.value FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname
              AND gr.attribute='Mikrotik-Address-List' WHERE g.username=%s ORDER BY g.priority LIMIT 1""", (user,))
    return r["value"] if r else ""


def temp_script():
    """RouterOS script: the open temporary exceptions as return rules at the top of the user's policy chain."""
    import hashlib
    import whyblocked
    rows = q("""SELECT framedipaddress AS ip, username, nasipaddress AS nas FROM radacct
                WHERE acctstoptime IS NULL AND framedipaddress REGEXP '^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$'
                  AND COALESCE(acctupdatetime, acctstarttime) >= NOW() - INTERVAL 20 MINUTE""")
    mine = [r for r in rows if r["nas"] == client_ip()]
    ips_of = {}
    for r in (mine or rows):
        ips_of.setdefault(r["username"], []).append(r["ip"])
    body = []
    for e in active_exceptions():
        host = whyblocked.clean_host(e["host"])
        if not host:
            continue
        if e["username"]:
            lst, ips = user_policy_list(e["username"]), ips_of.get(e["username"], [])
            pol = lst[7:] if lst.startswith("policy-") else ""
        else:
            pol, ips = e["policy"], [e["ip"]] if re.match(r"^\d+\.\d+\.\d+\.\d+$", e["ip"] or "") else []
        if not POLICY_RE.match(pol or "") or not ips:
            continue
        n = int(e["id"])
        body.append(f':local f [/ip firewall filter find chain="wfp-{pol}"]')
        body.append(":if ([:len $f] > 0) do={")
        body.append(f'  /ip firewall address-list add list=mltemp-{n} address={host} comment="mltemp:{n}"')
        for ip in sorted(set(ips)):
            for pat in (host, "*." + host):
                body.append(f'  /ip firewall filter add chain=wfp-{pol} src-address={ip} protocol=tcp tls-host="{pat}" action=return comment="mltemp:{n}" place-before=[:pick $f 0]')
            body.append(f'  /ip firewall filter add chain=wfp-{pol} src-address={ip} dst-address-list=mltemp-{n} action=return comment="mltemp:{n}" place-before=[:pick $f 0]')
        body.append("}")
    sig = hashlib.sha1("\n".join(body).encode()).hexdigest()[:16]
    return ("\n:global mlTempSig\n"
            f':if ($mlTempSig != "{sig}") do={{\n'
            '/ip firewall filter remove [find comment~"^mltemp:"]\n'
            '/ip firewall address-list remove [find comment~"^mltemp:"]\n'
            + "".join(l + "\n" for l in body)
            + f':set mlTempSig "{sig}"\n}}\n')


def temp_allowed(user, ip, host):
    """An open temporary exception for this user (or device) and site?"""
    for e in active_exceptions():
        if (user and e["username"] == user) or (not e["username"] and e["ip"] == ip):
            h = (e["host"] or "").lower()
            if host == h or host.endswith("." + h):
                return e
    return None


def dept_script():
    of = dept_of_users()
    rows = q("""SELECT framedipaddress AS ip, username, nasipaddress AS nas FROM radacct
                WHERE acctstoptime IS NULL AND framedipaddress REGEXP '^[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+$'
                  AND COALESCE(acctupdatetime, acctstarttime) >= NOW() - INTERVAL 20 MINUTE
                ORDER BY acctstarttime""")
    mine = [r for r in rows if r["nas"] == client_ip()]
    want = {}
    for r in (mine or rows):                      # behind NAT the router's address is not the NAS address
        d = of.get(r["username"])
        if d and DEPT_RE.match(d):
            want[r["ip"]] = d
    pairs = ";".join(f'"{ip}"="{d}"' for ip, d in sorted(want.items()))
    return f""":local w {{{pairs}}}
:foreach e in=[/ip firewall address-list find comment="mldept"] do={{
  :local a [:tostr [/ip firewall address-list get $e address]]
  :local l [/ip firewall address-list get $e list]
  :local d ($w->$a)
  :if (([:len $d] = 0) || (($l != "ml-dept-all") && ($l != ("ml-dept-" . $d)))) do={{ /ip firewall address-list remove $e }}
}}
:foreach a,d in=$w do={{
  :if ([:len [/ip firewall address-list find list=("ml-dept-" . $d) address=$a comment="mldept"]] = 0) do={{ /ip firewall address-list add list=("ml-dept-" . $d) address=$a comment="mldept" }}
  :if ([:len [/ip firewall address-list find list="ml-dept-all" address=$a comment="mldept"]] = 0) do={{ /ip firewall address-list add list="ml-dept-all" address=$a comment="mldept" }}
}}
"""


@app.get("/api/departments")
@login_required()
def departments():
    of = dept_of_users()
    online = {r["username"]: r for r in q("""SELECT username, framedipaddress FROM radacct WHERE acctstoptime IS NULL
                                              AND COALESCE(acctupdatetime, acctstarttime) >= NOW() - INTERVAL 20 MINUTE""")}
    now = {r["name"]: r for r in q("""SELECT name, rx, tx FROM ml_traffic WHERE kind='user' AND res=5
                                       AND bucket = (SELECT MAX(bucket) FROM ml_traffic WHERE kind='user' AND res=5)""")}
    out = []
    for d in q("SELECT name, title, down_kbps, up_kbps FROM ml_department ORDER BY name"):
        users = sorted(u for u, x in of.items() if x == d["name"])
        on = [u for u in users if u in online]
        out.append({**d, "members": jsonable(q("SELECT kind, name FROM ml_dept_member WHERE dept=%s ORDER BY kind, name", (d["name"],))),
                    "users": users, "online": on,
                    "now_down_bps": sum(int(now[u]["rx"]) for u in users if u in now) * 8 // 300,
                    "now_up_bps": sum(int(now[u]["tx"]) for u in users if u in now) * 8 // 300})
    groups = [r["groupname"] for r in q("SELECT DISTINCT groupname FROM radusergroup ORDER BY groupname")]
    return jsonify(departments=out, groups=groups)


@app.get("/api/netmap")
@login_required()
def netmap():
    """One picture of the LAN: routers, core devices, and per department its people / computers (IP, online, device kind,
    policy) and its devices (AP, printer, switch … from SNMP). Everything online that is in no department is shown too."""
    of = dept_of_users()
    online = {}
    for r in q("""SELECT username, framedipaddress AS ip, callingstationid AS mac, nasipaddress AS nas, acctstarttime AS since
                  FROM radacct WHERE acctstoptime IS NULL AND COALESCE(acctupdatetime, acctstarttime) >= NOW() - INTERVAL 20 MINUTE
                  ORDER BY acctstarttime"""):
        online[r["username"]] = r
    bound = {r["username"]: r for r in q("SELECT username, ip, mac FROM ml_ip_bind")}
    macs = {r["mac"]: r["description"] for r in q("SELECT mac, description FROM macdevice")}
    own_pol = {r["username"]: r["value"].replace("policy-", "") for r in q("SELECT username, value FROM radreply WHERE attribute='Mikrotik-Address-List'")}
    grp_pol = {r["username"]: r["value"].replace("policy-", "") for r in q(
        """SELECT g.username, gr.value FROM radusergroup g JOIN radgroupreply gr ON gr.groupname=g.groupname AND gr.attribute='Mikrotik-Address-List'
           ORDER BY g.priority DESC""")}
    ips = {x.get("ip") for x in list(online.values()) + list(bound.values()) if x.get("ip")}
    os_of = {}
    if ips:
        ph = ",".join(["%s"] * len(ips))
        os_of = {r["client_ip"]: r["os"] for r in q(f"SELECT client_ip, os FROM ml_device WHERE client_ip IN ({ph})", tuple(ips))}
    last = {}

    def person(u):
        o, b = online.get(u), bound.get(u)
        ip = (o or {}).get("ip") or (b or {}).get("ip") or ""
        kind = "mac" if u in macs else "user"
        return {"name": u, "kind": kind, "label": macs.get(u, "") if kind == "mac" else "", "ip": ip, "online": bool(o),
                "fixed": bool(b) and (b or {}).get("ip") == ip, "mac": (o or {}).get("mac") or (b or {}).get("mac") or "",
                "os": os_of.get(ip, ""), "policy": own_pol.get(u) or grp_pol.get(u) or "", "since": str((o or {}).get("since") or "")}

    devs = [_snmp_dev(r) for r in q("SELECT id, name, ip, kind, status, line, enabled, dept, info FROM ml_snmp_device WHERE enabled=1 ORDER BY name")]
    for d in devs:
        d["users"] = 0
    depts = []
    for d in q("SELECT name, title, down_kbps, up_kbps FROM ml_department ORDER BY name"):
        names = [u for u, x in of.items() if x == d["name"]]
        people = sorted((person(u) for u in names), key=lambda p: (not p["online"], p["kind"] != "mac", p["name"]))
        depts.append({**d, "people": people[:400], "more": max(0, len(people) - 400), "total": len(people),
                      "online": sum(1 for p in people if p["online"]), "devices": [x for x in devs if x.get("dept") == d["name"]]})
    known = {d["name"] for d in depts}
    loose = sorted((person(u) for u in online if of.get(u) not in known), key=lambda p: (p["kind"] != "mac", p["name"]))
    nas_ips = {n["nasname"] for n in q("SELECT nasname FROM nas")}
    as_router = {x["ip"]: x for x in devs if x["ip"] in nas_ips}          # a router that is also an SNMP device: shown once, as the router
    core = [x for x in devs if not x.get("dept") and x["kind"] in ("switch", "mikrotik", "ups", "server") and x["ip"] not in as_router]
    other = [x for x in devs if not x.get("dept") and x not in core and x["ip"] not in as_router]
    routers = []
    rs = {r["router_ip"]: r for r in q("SELECT router_ip, identity, board, cpu, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age FROM ml_router_status")}
    for n in q("SELECT nasname, shortname FROM nas ORDER BY nasname"):
        if not re.match(r"^\d+(\.\d+){3}$", n["nasname"]):
            continue                                   # a whole subnet of routers: no single box to draw
        st = rs.get(n["nasname"]) or {}
        dv = as_router.get(n["nasname"])
        routers.append({"ip": n["nasname"], "name": (dv or {}).get("name") or st.get("identity") or n["shortname"] or n["nasname"], "board": st.get("board") or "",
                        "cpu": st.get("cpu") if st.get("cpu") is not None else ((dv or {}).get("info") or {}).get("cpu"), "dev": (dv or {}).get("id"),
                        "dev_up": (dv or {}).get("status") == "up",
                        "reporting": (st.get("age") is not None and int(st["age"]) < 300) or (dv or {}).get("status") == "up",
                        "online": sum(1 for o in online.values() if o["nas"] == n["nasname"])})
    return jsonify(routers=routers, core=core, departments=depts, loose=loose[:400], loose_more=max(0, len(loose) - 400),
                   other_devices=other, online=len(online), dept_names=sorted(known))


@app.get("/api/netmap/topology")
@login_required()
def netmap_topology():
    """The whole network as a tree (tools/topology.py): from the switches' MAC tables + LLDP and who is logged in."""
    import topology
    norm = lambda m: "-".join(re.findall(r"[0-9A-F]{2}", re.sub(r"[^0-9A-Fa-f]", "", m or "").upper())) if len(re.sub(r"[^0-9A-Fa-f]", "", m or "")) == 12 else ""  # noqa: E731
    of = dept_of_users()
    macdesc = {r["mac"]: r["description"] for r in q("SELECT mac, description FROM macdevice")}
    people = []
    for r in q("""SELECT username, framedipaddress AS ip, callingstationid AS mac, nasipaddress AS nas FROM radacct
                  WHERE acctstoptime IS NULL AND COALESCE(acctupdatetime, acctstarttime) >= NOW() - INTERVAL 20 MINUTE ORDER BY acctstarttime"""):
        u = r["username"]
        people.append({"name": u, "kind": "mac" if u in macdesc else "user", "label": macdesc.get(u, ""), "ip": r["ip"] or "",
                       "mac": norm(r["mac"]), "nas": r["nas"], "dept": of.get(u, "")})
    devices = []
    ports = {}
    for r in q("SELECT device_id, ifindex, name FROM ml_snmp_if"):
        ports.setdefault(r["device_id"], {})[str(r["ifindex"])] = r["name"]
    for r in q("SELECT id, name, ip, kind, status, line, dept, sysname, macs FROM ml_snmp_device WHERE enabled=1"):
        devices.append({**r, "macs": [m for m in (r["macs"] or "").split(",") if m], "ports": ports.get(r["id"], {})})
    rs = {r["router_ip"]: r for r in q("SELECT router_ip, identity FROM ml_router_status")}
    routers = [{"ip": n["nasname"], "name": (rs.get(n["nasname"]) or {}).get("identity") or n["shortname"] or n["nasname"],
                "online": sum(1 for p in people if p["nas"] == n["nasname"])}
               for n in q("SELECT nasname, shortname FROM nas ORDER BY nasname") if re.match(r"^\d+(\.\d+){3}$", n["nasname"])]
    fdb = [(r["device_id"], r["ifindex"], r["mac"]) for r in q("SELECT device_id, ifindex, mac FROM ml_snmp_fdb")]
    lldp = q("SELECT device_id, ifindex, name, ip, chassis FROM ml_snmp_lldp")
    t = topology.build(routers, devices, fdb, lldp, people)
    seen = q1("SELECT MAX(seen) AS at, COUNT(DISTINCT device_id) AS n FROM ml_snmp_fdb") or {}
    return jsonify(nodes=jsonable(t["nodes"]), unplaced=t["unplaced"], switches_read=int(seen.get("n") or 0), read_at=str(seen.get("at") or ""),
                   online=len(people))


@app.post("/api/departments")
@login_required("admin")
def department_save():
    data = body()
    name = field(data, "name", DEPT_RE, required=True, maxlen=24)
    down = field(data, "down", RATE_RE, required=True, maxlen=12)
    up = field(data, "up", RATE_RE, required=True, maxlen=12)
    title = field(data, "title", re.compile(r'^[^"\\$\x00-\x1f]{0,80}$'), maxlen=80)
    sub = "add" if data.get("new") else "set"
    return result(*radius_admin(["dept", sub, name, down, up] + ([title] if title else [])))


@app.delete("/api/departments/<name>")
@login_required("admin")
def department_delete(name):
    if not DEPT_RE.match(name):
        abort(400, "invalid name")
    return result(*radius_admin(["dept", "del", name]))


@app.post("/api/departments/<name>/member")
@login_required("admin")
def department_member(name):
    data = body()
    kind = data.get("kind")
    if kind not in ("user", "group") or not DEPT_RE.match(name):
        abort(400, "kind: user or group")
    who = field(data, "name", NAME_RE, required=True, maxlen=64)
    return result(*radius_admin(["dept", "member", name, kind, who]))


@app.post("/api/departments/unmember")
@login_required("admin")
def department_unmember():
    data = body()
    kind = data.get("kind")
    if kind not in ("user", "group"):
        abort(400, "kind: user or group")
    who = field(data, "name", NAME_RE, required=True, maxlen=64)
    return result(*radius_admin(["dept", "unmember", kind, who]))


@app.get("/api/traffic/items")
@login_required()
def traffic_items():
    ifaces = []
    for r in q("SELECT router_ip, identity, interfaces FROM ml_router_status ORDER BY identity, router_ip"):
        try:
            names = [i["name"] for i in json.loads(r["interfaces"] or "[]") if not i.get("disabled")]
        except (ValueError, TypeError, KeyError):
            names = []
        ifaces += [{"key": f"{r['router_ip']}|{r['identity']}|{n}", "router": r["identity"] or r["router_ip"], "name": n} for n in names]
    users = [r["name"] for r in q("""SELECT name FROM ml_traffic WHERE kind='user' AND res=60 AND bucket >= NOW() - INTERVAL 7 DAY
                                     GROUP BY name ORDER BY SUM(rx + tx) DESC LIMIT 500""")]
    groups = [r["groupname"] for r in q("SELECT DISTINCT groupname FROM radusergroup ORDER BY groupname")]
    depts = [r["name"] for r in q("SELECT name FROM ml_department ORDER BY name")]
    return jsonify(interfaces=ifaces, users=users, groups=groups, departments=depts)


@app.get("/api/traffic/series")
@login_required()
def traffic_series():
    kind, name, rng = request.args.get("kind", ""), request.args.get("name", ""), request.args.get("range", "24h")
    if rng not in RANGES:
        abort(400, "range: 6h, 24h, 7d or 30d")
    span, res, step = RANGES[rng]
    limit = None
    if kind == "if":
        if not re.match(r"^[0-9a-fA-F.:]{3,45}\|[\w .:@/+()-]{0,64}\|[\w .:@/+()-]{1,64}$", name):
            abort(400, "invalid interface")
        tkind, names = "if", [name]
    elif kind == "user":
        if not NAME_RE.match(name):
            abort(400, "invalid user")
        tkind, names = "user", [name]
    elif kind == "group":
        if not NAME_RE.match(name):
            abort(400, "invalid group")
        tkind, names = "user", [r["username"] for r in q("SELECT username FROM radusergroup WHERE groupname=%s", (name,))]
    elif kind == "dept":
        if not DEPT_RE.match(name):
            abort(400, "invalid department")
        d = q1("SELECT down_kbps, up_kbps FROM ml_department WHERE name=%s", (name,))
        if not d:
            abort(404, "no such department")
        limit = {"down_bps": int(d["down_kbps"]) * 1000, "up_bps": int(d["up_kbps"]) * 1000}
        tkind, names = "user", dept_users(name)
    else:
        abort(400, "kind: if, user, group or dept")
    end = int(time.time()) // step * step + step
    start = end - span
    by = {}
    top = []
    if names:
        ph = ",".join(["%s"] * len(names))
        for r in q(f"""SELECT FLOOR(UNIX_TIMESTAMP(bucket) / {step}) * {step} AS t, SUM(rx) AS rx, SUM(tx) AS tx FROM ml_traffic
                       WHERE kind=%s AND res={res} AND name IN ({ph}) AND bucket >= FROM_UNIXTIME(%s) GROUP BY t""",
                   [tkind] + names + [start]):
            by[int(r["t"])] = (int(r["rx"]), int(r["tx"]))
        if kind in ("group", "dept"):
            top = jsonable(q(f"""SELECT name, SUM(rx) AS down, SUM(tx) AS up FROM ml_traffic WHERE kind='user' AND res={res}
                                 AND name IN ({ph}) AND bucket >= FROM_UNIXTIME(%s) GROUP BY name ORDER BY SUM(rx + tx) DESC LIMIT 10""",
                              names + [start]))
    pts = [{"t": t, "rx_bps": by.get(t, (0, 0))[0] * 8 // step, "tx_bps": by.get(t, (0, 0))[1] * 8 // step}
           for t in range(start, end, step)]
    tot_rx, tot_tx = sum(v[0] for v in by.values()), sum(v[1] for v in by.values())
    return jsonify(points=pts, step=step, total_rx=tot_rx, total_tx=tot_tx, limit=limit, members=len(names), top=top,
                   peak_rx=max((p["rx_bps"] for p in pts), default=0), peak_tx=max((p["tx_bps"] for p in pts), default=0))


# ------------------------------------------------------------------ allowed websites, automatic (allow-web)
WEBSCAN_DIR = os.environ.get("MLWEB_WEBSCAN", "/var/lib/mikrotiklover/webscan")


@app.get("/api/webscan")
@login_required()
def webscan_list():
    import webscan
    out = []
    order = {"site": 0, "app": 1, "ao": 2}
    tg = webscan.targets(POLICY_DIR, AO_DIR)
    for key, t in sorted(tg.items(), key=lambda kv: (order[kv[1]["kind"]], kv[0])):
        st = webscan.load(WEBSCAN_DIR, key)
        sc = st.get("scanning")
        if sc and time.time() - sc.get("since", 0) > 900:   # a read that died: not "reading" for ever
            sc = None
        out.append({"site": key, "kind": t["kind"], "name": t["name"], "policies": t["policies"],
                    "allowed": st.get("allowed", {}), "suggest": st.get("suggest", {}),
                    "skipped": st.get("skipped", {}), "ignored": st.get("ignored", []), "scanned": st.get("scanned", 0),
                    "error": st.get("error", ""), "pages": st.get("pages", [])[:40],
                    "pages_read": st.get("pages_read", len(st.get("pages", []))), "deep": st.get("deep", False),
                    "seconds": st.get("seconds", 0), "scanning": sc, "ports": st.get("ports", []),
                    "nets": st.get("nets", {}), "suggest_net": st.get("suggest_net", {})})
    return jsonify(sites=out, deep_pages=webscan.DEEP_PAGES, deep_minutes=webscan.DEEP_SECONDS // 60)


def webscan_key(key):
    import webscan
    key = str(key).lower()
    return webscan.clean_site(key) or (key if webscan.KEY_RE.match(key) else "")


@app.post("/api/webscan/<site>/scan")
@login_required("admin")
def webscan_scan(site):
    import webscan
    if not webscan.clean_site(site):
        abort(400, "invalid site")
    if body().get("deep"):                                # the whole site, in the background
        return result(*radius_admin(["webscan", "deep", webscan.clean_site(site)]))
    return result(*radius_admin(["webscan", "scan", webscan.clean_site(site)], timeout=180))


@app.post("/api/webscan/<site>/answer")
@login_required("admin")
def webscan_answer(site):
    import webscan
    data = body()
    name = str(data.get("name", "")).lower()
    key = webscan_key(site)
    if not key or not (webscan.SITE_RE.match(name) or webscan.good_net(name)):
        abort(400, "invalid name")
    return result(*radius_admin(["webscan", "allow" if data.get("allow") else "ignore", key, name]))


# ------------------------------------------------------------------ allow-only app profiles ("only these apps")
AO_DIR = os.environ.get("MLWEB_ALLOWONLY", "/var/lib/mikrotiklover/allowonly")
AO_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")


def ao_profiles():
    d = AO_DIR if os.path.isdir(AO_DIR) else os.path.join(WF_DIR, "allowonly")
    try:
        return sorted(f[:-4] for f in os.listdir(d) if f.endswith(".txt") and f != "meta-ipv4.txt")
    except OSError:
        return []


@app.get("/api/allowonly")
@login_required()
def allowonly_list():
    used = {}
    for f in sorted(os.listdir(POLICY_DIR)) if os.path.isdir(POLICY_DIR) else []:
        if f.endswith(".txt") and f != "README.txt":
            for line in open(os.path.join(POLICY_DIR, f), encoding="utf-8", errors="replace"):
                m = re.match(r"^\s*allow-only\s+([a-z0-9-]+)\s*$", line)
                if m:
                    used.setdefault(m.group(1), []).append(f[:-4])
    out = []
    d = AO_DIR if os.path.isdir(AO_DIR) else os.path.join(WF_DIR, "allowonly")
    for n in ao_profiles():
        try:
            text = open(os.path.join(d, n + ".txt"), encoding="utf-8", errors="replace").read()
        except OSError:
            text = ""
        first = text.splitlines()[0] if text else ""
        out.append({"name": n, "title": re.sub(r"^#\s*(Profile:\s*)?", "", first) if first.startswith("#") else n,
                    "text": text, "used_by": used.get(n, []), "shipped": os.path.isfile(os.path.join(WF_DIR, "allowonly", n + ".txt"))})
    dnslog = os.path.exists(mlreport.DNS_LOG)
    return jsonify(profiles=out, dnslog=dnslog)


@app.post("/api/allowonly")
@login_required("admin")
def allowonly_save():
    data = body()
    name = field(data, "name", AO_NAME_RE, required=True, maxlen=31)
    if name == "meta-ipv4":
        abort(400, "invalid name")
    text = str(data.get("text", ""))
    if len(text) > 20000 or not text.strip() or re.search(r"[^\x20-\x7e\n\t]", text):
        abort(400, "profile text: plain lines (domain NAME, host NAME, net CIDR|@lan, deny-sni WORD, block-quic)")
    return result(*radius_admin(["allowonly", "set", name], stdin=text.replace("\r", "") + "\n", action=f"allowonly set {name}"))


@app.delete("/api/allowonly/<name>")
@login_required("admin")
def allowonly_delete(name):
    if not AO_NAME_RE.match(name):
        abort(400, "invalid name")
    return result(*radius_admin(["allowonly", "del", name]))


@app.get("/api/allowonly/learn")
@login_required()
def allowonly_learn():
    """Names a device looked up since a time (DNS logger): to make an allow-only profile from."""
    import applearn
    who = request.args.get("who", "").strip()
    try:
        since = float(request.args.get("since") or (time.time() - 60 * float(request.args.get("minutes", "15"))))
    except ValueError:
        abort(400, "since: seconds since 1970, or minutes")
    since = max(since, time.time() - 7 * 86400)
    if re.match(r"^\d+\.\d+\.\d+\.\d+$", who):
        ip = who
    elif NAME_RE.match(who):
        r = q1("SELECT framedipaddress FROM radacct WHERE username=%s AND acctstoptime IS NULL ORDER BY acctstarttime DESC LIMIT 1", (who,))
        if not r or not r["framedipaddress"]:
            abort(404, f"'{who}' is not online — give the device's IP address")
        ip = r["framedipaddress"]
    else:
        abort(400, "who: a user name or the device's IP address")
    if not os.path.exists(mlreport.DNS_LOG):
        abort(409, "the DNS logger is off — turn it on first (Security / radius-admin dnslog on ROUTER_IP)")
    rows = applearn.learn(ip, since)
    return jsonify(ip=ip, since=int(since), sites=[{**g, "first": int(g["first"])} for g in rows])


# ------------------------------------------------------------------ IP binding (user keeps one LAN address)
IPV4_RE = re.compile(r"^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$")


@app.get("/api/ipbind")
@login_required()
def ipbind_list():
    rows = q("""SELECT b.username, b.ip, b.mac, b.locked, b.router_ip, b.created, b.last_seen,
                       (SELECT r.framedipaddress FROM radacct r WHERE r.username=b.username AND r.acctstoptime IS NULL
                         ORDER BY r.acctstarttime DESC LIMIT 1) AS ip_now,
                       (SELECT r.callingstationid FROM radacct r WHERE r.username=b.username AND r.acctstoptime IS NULL
                         ORDER BY r.acctstarttime DESC LIMIT 1) AS mac_now
                FROM ml_ip_bind b ORDER BY INET_ATON(b.ip)""")
    for r in rows:
        r["random"] = bool(r["mac"]) and r["mac"][1:2].upper() in "26AE"
    st = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('ipbind_auto','ipbind_days','ipbind_scope')")}
    return jsonify(bindings=jsonable(rows), auto=st.get("ipbind_auto") == "1", days=int(st.get("ipbind_days") or 7), scope=st.get("ipbind_scope") or "users")


@app.post("/api/ipbind")
@login_required("admin")
def ipbind_set():
    data = body()
    user = field(data, "user", NAME_RE, required=True)
    ip = field(data, "ip", IPV4_RE, required=True, maxlen=15)
    return result(*radius_admin(["ipbind", "set", user, ip], action=f"ipbind set {user} {ip}"))


@app.post("/api/ipbind/<action>")
@login_required("admin")
def ipbind_action(action):
    data = body()
    if action == "settings":
        if "auto" in data:
            ok, msg = radius_admin(["ipbind", "auto", "on" if data.get("auto") else "off"])
            if not ok:
                return result(ok, msg)
        if "scope" in data:
            ok, msg = radius_admin(["ipbind", "scope", "all" if data.get("scope") == "all" else "users"])
            if not ok or "days" not in data:
                return result(ok, msg)
        if "days" in data:
            d = str(data.get("days")).strip()
            if not re.match(r"^\d{1,4}$", d) or int(d) > 3650:
                abort(400, "days: 0-3650")
            return result(*radius_admin(["ipbind", "days", str(int(d))]))
        return result(True, "saved")
    if action in ("unlock", "del"):
        user = field(data, "user", NAME_RE, required=True)
        return result(*radius_admin(["ipbind", action, user]))
    abort(404)


# ------------------------------------------------------------------ router setup page
MIKROTIK_DIR = os.environ.get("MLWEB_MIKROTIK", "/usr/local/lib/mikrotiklover/mikrotik")
SETUP_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")


@app.get("/api/router-setup")
@login_required("admin")
def router_setup_info():
    import routersetup
    host = request.host.rsplit(":", 1)[0].strip("[]")
    sip = (q1("SELECT v FROM ml_setting WHERE k='server_ip'") or {}).get("v") or (host if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) else "")
    routers = jsonable(q("SELECT nasname, shortname FROM nas ORDER BY nasname"))
    return jsonify(server_ip=sip, routers=routers, has_key=bool(router_key()), port=web_port(),
                   modules=[{"key": k, "file": f or "", "title": t} for k, f, t in routersetup.MODULES])


@app.post("/api/router-setup")
@login_required("admin")
def router_setup_make():
    """Builds the script for one router and keeps it for an hour behind a random token."""
    import routersetup
    data = body()
    o = {k: data.get(k) for k in ("server_ip", "lan_if", "lan_net", "dns_name", "server_if", "server_net", "staff_ssid",
                                  "devices_ssid", "devices_key", "pppoe_if")}
    o = {k: (str(v).strip()[:128] if v is not None else "") for k, v in o.items()}
    for k, _, _ in routersetup.MODULES:
        o[k] = bool(data.get(k))
    o["hotspot_create"], o["base_done"], o["hotspot_mac"] = bool(data.get("hotspot_create")), bool(data.get("base_done")), bool(data.get("hotspot_mac"))
    try:
        routersetup._ip(o["server_ip"], "server IP")
    except ValueError as e:
        abort(400, str(e))
    rip = str(data.get("router", ""))[:45]
    row = q1("SELECT nasname, shortname, secret FROM nas WHERE nasname=%s", (rip,)) if valid_nas(rip) else None
    if not row:
        abort(400, "choose a router (add it on the Routers page first)")
    o.update(router_ip=row["nasname"], router_name=row["shortname"] or row["nasname"], secret=row["secret"])
    auto = ""
    if o["autosync"]:
        key = router_key()
        if not key:
            abort(400, "auto-sync: build the router rules first (Blocking → Build router rules)")
        auto = autosync_text(o["server_ip"], key, router_info())
    if o["snmp"]:              # the router's read-only community (secret, kept by the server); the router is added to Devices
        ok, out = radius_admin(["snmp", "router", row["nasname"]], timeout=60, log=False)
        if not ok or not out.strip():
            abort(400, out or "SNMP: could not make the router community")
        o["snmp_community"] = out.strip().splitlines()[-1].strip()
    try:
        text = routersetup.build(o, MIKROTIK_DIR, auto)
        text6 = routersetup.build(o, MIKROTIK_DIR, auto, ros="6")       # the router picks by its version
    except ValueError as e:
        abort(400, str(e))
    except OSError:
        abort(500, "router script files are missing (run install.sh again)")
    token = secrets.token_hex(16)
    q("DELETE FROM ml_router_setup WHERE expires < NOW()")
    q("INSERT INTO ml_router_setup (token, router_ip, script, script6, expires) VALUES (%s,%s,%s,%s, NOW() + INTERVAL 1 HOUR)",
      (token, row["nasname"], text, text6))
    audit(f"router setup script for {row['nasname']}", "ok")
    url = f"https://{o['server_ip']}:{web_port()}/api/public/setup/{token}.rsc"
    # RouterOS 6 and 7 alike: the router adds its main version (?v=6 / ?v=7) and gets the script written for it
    # written \\? because a bare ? typed or pasted in the RouterOS terminal opens the help instead
    line = (f'/tool fetch url=("{url}\\?v=" . [:pick [/system resource get version] 0 1]) check-certificate=no dst-path=ml-setup.rsc; '
            f':delay 2s; /import file-name=ml-setup.rsc; /file remove ml-setup.rsc')
    return jsonify(ok=True, token=token, url=url, line=line, lines=text.count("\n"), script=text, script6=text6)


@app.get("/api/public/setup/<token>.rsc")
def router_setup_fetch(token):
    """The router downloads its setup script here (the token is valid for one hour)."""
    if not SETUP_TOKEN_RE.match(token):
        abort(404)
    row = q1("SELECT script, script6 FROM ml_router_setup WHERE token=%s AND expires > NOW()", (token,))
    if not row:
        abort(404)
    q("UPDATE ml_router_setup SET fetched=fetched+1 WHERE token=%s", (token,))
    text = row["script6"] if _ros6() and row.get("script6") else row["script"]
    return app.response_class(text, mimetype="text/plain",
                              headers={"Content-Disposition": 'attachment; filename="ml-setup.rsc"', "Cache-Control": "no-store"})


@app.get("/api/router-setup/<token>")
@login_required("admin")
def router_setup_status(token):
    if not SETUP_TOKEN_RE.match(token):
        abort(404)
    row = q1("SELECT fetched, TIMESTAMPDIFF(SECOND, NOW(), expires) AS left_s FROM ml_router_setup WHERE token=%s", (token,))
    if not row:
        abort(404)
    return jsonify(fetched=int(row["fetched"]), seconds_left=max(0, int(row["left_s"])))


# ------------------------------------------------------------------ network control: router health reports
@app.post("/api/public/router/report")
def router_report():
    """Every minute from each router (autosync.rsc: ml-stats). Same key as the auto-sync."""
    key = request.args.get("key", "")
    if not key or not router_key() or not hmac.compare_digest(key, router_key()):
        abort(403)
    if (request.content_length or 0) > 65536:
        abort(413)
    import routerstat
    try:
        d = routerstat.parse(request.get_data(as_text=True))
    except ValueError as e:
        abort(400, str(e))
    ip = client_ip()[:45]
    prev = q1("SELECT interfaces, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age FROM ml_router_status WHERE router_ip=%s AND identity=%s",
              (ip, d["identity"]))
    old = []
    if prev:
        try:
            old = json.loads(prev["interfaces"] or "[]")
        except ValueError:
            old = []
    routerstat.rates(d["interfaces"], old, prev["age"] if prev else 0)
    q("""REPLACE INTO ml_router_status (router_ip, identity, board, version, uptime, cpu, mem_free, mem_total, hdd_free, hdd_total,
                                        users_hotspot, users_ppp, dhcp_leases, interfaces, links, exposed, last_seen)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())""",
      (ip, d["identity"], d["board"], d["version"], d["uptime"], d["cpu"], d["mem_free"], d["mem_total"], d["hdd_free"], d["hdd_total"],
       d["hotspot"], d["ppp"], d["dhcp"], json.dumps(d["interfaces"]), json.dumps(d["links"]),
       json.dumps({"nat": d.get("nat", []), "services": d.get("services", []), "fw": d.get("fw", {}), "fwn": d.get("fwn", {})})))
    if prev and 0 < (prev["age"] or 0) < 600:
        traffic_ifaces(ip, d["identity"], d["interfaces"], old)
    rx, tx = routerstat.busiest(d["interfaces"])
    mem_pct = round(100 - d["mem_free"] * 100 / d["mem_total"]) if d["mem_total"] else 0
    q("""INSERT INTO ml_router_stat (router_ip, identity, at, cpu, mem_pct, rx_bps, tx_bps, users)
         VALUES (%s,%s,DATE_FORMAT(NOW(), '%%Y-%%m-%%d %%H:%%i:00'),%s,%s,%s,%s,%s)
         ON DUPLICATE KEY UPDATE cpu=VALUES(cpu), mem_pct=VALUES(mem_pct), rx_bps=VALUES(rx_bps), tx_bps=VALUES(tx_bps), users=VALUES(users)""",
      (ip, d["identity"], d["cpu"], mem_pct, rx, tx, d["hotspot"] + d["ppp"]))
    if datetime.now().minute == 0:
        q("DELETE FROM ml_router_stat WHERE at < NOW() - INTERVAL 7 DAY")
    return app.response_class("ok\n", mimetype="text/plain")


def traffic_ifaces(ip, identity, cur, old):
    """Bytes since the last report per interface -> ml_traffic (5-minute and hourly buckets)."""
    prev = {i["name"]: i for i in old}
    rows = []
    for i in cur:
        o = prev.get(i["name"])
        if not o or i["rx"] < o.get("rx", 0) or i["tx"] < o.get("tx", 0):
            continue                                   # new interface or counters reset (reboot)
        drx, dtx = i["rx"] - o.get("rx", 0), i["tx"] - o.get("tx", 0)
        if drx or dtx:
            rows.append((f"{ip}|{identity}|{i['name']}"[:200], drx, dtx))
    for res, fmt in ((5, "FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(NOW() - INTERVAL 30 SECOND) / 300) * 300)"),
                     (60, "DATE_FORMAT(NOW() - INTERVAL 30 SECOND, '%%Y-%%m-%%d %%H:00:00')")):
        for name, drx, dtx in rows:
            q(f"""INSERT INTO ml_traffic (kind, name, res, bucket, rx, tx) VALUES ('if', %s, {res}, {fmt}, %s, %s)
                  ON DUPLICATE KEY UPDATE rx = rx + VALUES(rx), tx = tx + VALUES(tx)""", (name, drx, dtx))


@app.get("/api/network")
@login_required()
def network_status():
    rows = q("""SELECT router_ip, identity, board, version, uptime, cpu, mem_free, mem_total, hdd_free, hdd_total, users_hotspot,
                       users_ppp, dhcp_leases, interfaces, links, last_seen, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS age
                FROM ml_router_status ORDER BY identity""")
    nas = {r["nasname"]: r["shortname"] for r in q("SELECT nasname, shortname FROM nas")}
    out = []
    for r in rows:
        r = dict(r)
        for k in ("interfaces", "links"):
            try:
                r[k] = json.loads(r[k] or "[]")
            except ValueError:
                r[k] = []
        r["nas_name"] = nas.get(r["router_ip"], "")
        r["history"] = jsonable(q("""SELECT DATE_FORMAT(at, '%%H:%%i') AS t, cpu, mem_pct, rx_bps, tx_bps, users FROM ml_router_stat
                                      WHERE router_ip=%s AND identity=%s AND at >= NOW() - INTERVAL 24 HOUR ORDER BY at""",
                                   (r["router_ip"], r["identity"])))
        out.append(jsonable([r])[0])
    return jsonify(routers=out, nas_without_report=[{"ip": k, "name": v} for k, v in nas.items()
                                                    if "/" not in k and k not in {r["router_ip"] for r in rows}])


@app.post("/api/network/forget")
@login_required("admin")
def network_forget():
    d = body()
    ip, ident = field(d, "router_ip", re.compile(r"^[0-9a-fA-F.:]{3,45}$"), required=True), str(d.get("identity", ""))[:64]
    q("DELETE FROM ml_router_status WHERE router_ip=%s AND identity=%s", (ip, ident))
    q("DELETE FROM ml_router_stat WHERE router_ip=%s AND identity=%s", (ip, ident))
    audit(f"forget router report {ip} {ident}", "ok")
    return result(True, "Removed from the list (it comes back when the router reports again)")


# ------------------------------------------------------------------ hotspot login page designer
HS_KEYS = {"hs_title": 80, "hs_sub": 80, "hs_footer": 80, "hs_notice": 400, "hs_color1": 7, "hs_color2": 7}
HS_PAGES = ("login.html", "status.html", "alogin.html")


@app.get("/api/hotspot")
@login_required()
def hotspot_get():
    st = {k: "" for k in HS_KEYS}
    st["hs_push"] = "0"
    for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'hs\\_%%'"):
        st[r["k"]] = r["v"]
    ver = ""
    try:
        ver = open(os.path.join(ROUTER_DIR, "hotspot", "version")).read().strip()
    except OSError:
        pass
    return jsonify(settings=st, version=ver, logo=os.path.exists("/var/lib/mikrotiklover/hotspot-logo.txt"), brand=settings_get()["brand"])


@app.post("/api/hotspot")
@login_required("admin")
def hotspot_save():
    d = body()
    for k, maxlen in HS_KEYS.items():
        if k not in d:
            continue
        v = str(d[k] or "").strip()
        if len(v) > maxlen or "\n" in v or not v.isprintable():
            abort(400, f"invalid {k[3:]}")
        if k.startswith("hs_color") and v and not re.match(r"^#[0-9a-fA-F]{6}$", v):
            abort(400, f"invalid {k[3:]}")
        q("INSERT INTO ml_setting (k, v) VALUES (%s,%s) ON DUPLICATE KEY UPDATE v=VALUES(v)", (k, v))
    audit("hotspot page design", "ok")
    return result(*radius_admin(["hotspot", "build"], timeout=180))


@app.post("/api/hotspot/logo")
@login_required("admin")
def hotspot_logo():
    data = str(body().get("data") or "")
    if not data:
        return result(*radius_admin(["hotspot", "logo", "-"], timeout=180))
    if len(data) > 150000 or not re.match(r"^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$", data):
        abort(400, "logo: a PNG / JPG / GIF / WebP image, 100 KB at most")
    return result(*radius_admin(["hotspot", "logo", "--stdin"], stdin=data, action="hotspot logo", timeout=180))


@app.post("/api/hotspot/push")
@login_required("admin")
def hotspot_push():
    return result(*radius_admin(["hotspot", "push", "on" if body().get("on") else "off"], timeout=180))


@app.get("/api/hotspot/preview/<page>")
@login_required()
def hotspot_preview(page):
    if page not in HS_PAGES:
        abort(404)
    ok, out = radius_admin(["hotspot", "preview", page], log=False, timeout=60)
    if not ok:
        abort(500, out[-200:])
    return app.response_class(out, mimetype="text/html", headers={"X-ML-Preview": "1"})


@app.get("/api/public/router/hotspot/<page>")
def router_hotspot_page(page):
    if page not in HS_PAGES:
        abort(404)
    return app.response_class(_router_file(os.path.join("hotspot", page)), mimetype="text/html")


# ------------------------------------------------------------------ VPN watch
@app.get("/api/vpn")
@login_required()
def vpn_report():
    a = report_args()
    days = int(max(a.days, 1))
    w, args = ["bucket >= NOW() - INTERVAL %s DAY"], [days]
    if a.user:
        w.append("username=%s"); args.append(a.user)
    w = " AND ".join(w)
    attempts = q(f"""SELECT MAX(last_seen) AS last, MIN(first_seen) AS first, NULLIF(username,'') AS username, client_ip, kind, what,
                            GROUP_CONCAT(DISTINCT source ORDER BY source) AS sources, SUM(hits) AS tries, SUM(bytes) AS bytes,
                            SUM(source='blocked') > 0 AS blocked
                     FROM ml_vpn_event WHERE {w} GROUP BY client_ip, username, kind, what ORDER BY MAX(last_seen) DESC LIMIT %s""",
                 args + [a.top])
    users = q(f"""SELECT COALESCE(NULLIF(username,''),'') AS username, GROUP_CONCAT(DISTINCT client_ip) AS devices,
                         GROUP_CONCAT(DISTINCT kind ORDER BY kind SEPARATOR ', ') AS vpns, SUM(hits) AS tries,
                         SUM(source='blocked') > 0 AS blocked, SUM(source='flow' AND bytes > 200000) > 0 AS connected,
                         MIN(first_seen) AS first, MAX(last_seen) AS last
                  FROM ml_vpn_event WHERE {w} GROUP BY COALESCE(NULLIF(username,''),client_ip) ORDER BY SUM(hits) DESC LIMIT 500""", args)
    servers = q("SELECT ip, kind, why, first_seen, last_seen FROM ml_vpn_server ORDER BY last_seen DESC LIMIT 500")
    domains = q("SELECT domain, kind, why, first_seen, last_seen FROM ml_vpn_domain ORDER BY last_seen DESC LIMIT 500")
    totals = q1(f"""SELECT COUNT(DISTINCT COALESCE(NULLIF(username,''),client_ip)) AS users, COALESCE(SUM(hits),0) AS tries,
                           COALESCE(SUM(IF(source='blocked',hits,0)),0) AS blocked FROM ml_vpn_event WHERE {w}""", args)
    totals.update(q1("SELECT (SELECT COUNT(*) FROM ml_vpn_server) AS servers, (SELECT COUNT(*) FROM ml_vpn_domain) AS domains"))
    return jsonify(attempts=jsonable(attempts), users=jsonable(users), servers=jsonable(servers), domains=jsonable(domains),
                   totals=jsonable([totals])[0])


@app.post("/api/vpn/ignore")
@login_required("admin")
def vpn_ignore():
    name = field(body(), "name", re.compile(r"^[a-z0-9.-]{1,253}$"), required=True)
    return result(*radius_admin(["vpn", "ignore", name]))


@app.post("/api/vpn/scan")
@login_required("admin")
def vpn_scan():
    ok, out = radius_admin(["vpn", "scan"])
    if ok:
        radius_admin(["policy", "build"])
    return result(ok, out)


# ------------------------------------------------------------------ website names (domains + subdomains)
@app.get("/api/domains")
@login_required()
def domains_list():
    a = report_args()
    search = request.args.get("search", "").strip().lower()
    if search and not re.match(r"^[a-z0-9.-]{1,100}$", search):
        abort(400, "search: letters, digits, . -")
    days = int(max(a.days, 1))
    w, args = ["last_seen >= NOW() - INTERVAL %s DAY"], [days]
    if search:
        w.append("host LIKE %s"); args.append(f"%{search}%")
    rows = q(f"""SELECT base, MAX(NULLIF(app,'')) AS app, COUNT(*) AS subdomains, MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
                 FROM ml_domain WHERE {' AND '.join(w)} GROUP BY base ORDER BY COUNT(*) DESC, MAX(last_seen) DESC LIMIT %s""", args + [a.top])
    totals = q1("SELECT COUNT(*) AS hosts, COUNT(DISTINCT base) AS bases, MIN(first_seen) AS since FROM ml_domain")
    new = q1("SELECT COUNT(*) AS n FROM ml_domain WHERE first_seen >= NOW() - INTERVAL 1 DAY")
    return jsonify(rows=jsonable(rows), totals={**jsonable([totals])[0], "new_today": new["n"]})


@app.get("/api/domains/tree")
@login_required()
def domains_tree():
    base = request.args.get("base", "").lower()
    if not re.match(r"^[a-z0-9.-]{3,253}$", base):
        abort(400, "invalid domain")
    rows = q("""SELECT d.host, d.app, d.first_seen, d.last_seen, d.ips, COALESCE(SUM(x.lookups),0) AS lookups, COALESCE(MAX(x.devices),0) AS devices
                FROM ml_domain d LEFT JOIN ml_domain_day x ON x.host=d.host WHERE d.base=%s GROUP BY d.host ORDER BY lookups DESC LIMIT 2000""", (base,))
    return jsonify(rows=jsonable(rows))


@app.get("/api/domains.csv")
@login_required()
def domains_csv():
    import csv, io
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["host", "domain", "app", "first_seen", "last_seen", "ips"])
    for r in q("SELECT host, base, app, first_seen, last_seen, ips FROM ml_domain ORDER BY base, host"):
        w.writerow([r["host"], r["base"], r["app"], r["first_seen"], r["last_seen"], r["ips"]])
    return app.response_class(buf.getvalue(), mimetype="text/csv",
                              headers={"Content-Disposition": 'attachment; filename="website-names.csv"'})


# ------------------------------------------------------------------ security detective
def _count_lines(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return sum(1 for _ in fh)
    except OSError:
        return 0


def updates_status():
    out = []
    try:
        for line in open(os.path.join(STATE_DIR, "updates.txt"), encoding="utf-8"):
            f = line.rstrip("\n").split("\t")
            if len(f) == 3:
                out.append({"name": f[0], "when": f[1], "result": f[2]})
    except OSError:
        pass
    return out


@app.get("/api/security")
@login_required()
def security():
    a = report_args()
    days = int(max(a.days, 1))
    cat = request.args.get("category", "")
    if cat and cat not in ("virus", "attack", "ddos", "ransomware"):
        abort(400, "category: virus | attack | ddos | ransomware")
    w, args = ["last_seen >= NOW() - INTERVAL %s DAY"], [days]
    if cat:
        w.append("category=%s"); args.append(cat)
    if request.args.get("high") == "1":
        w.append("severity='high'")
    w = " AND ".join(w)
    events = q(f"""SELECT id, category, type, severity, source, src_ip, dst_ip, username, detail, hits, first_seen, last_seen
                   FROM ml_security_event WHERE {w} ORDER BY last_seen DESC LIMIT %s""", args + [min(a.n, 1000)])
    counts = q("""SELECT category, COUNT(*) AS events, COALESCE(SUM(severity='high'),0) AS high FROM ml_security_event
                  WHERE last_seen >= NOW() - INTERVAL %s DAY GROUP BY category""", (days,))
    types = q(f"""SELECT category, type, COUNT(*) AS events, SUM(hits) AS hits, COUNT(DISTINCT NULLIF(src_ip,'')) AS sources, MAX(last_seen) AS last
                  FROM ml_security_event WHERE {w} GROUP BY category, type ORDER BY events DESC LIMIT 100""", args)
    devices = q(f"""SELECT src_ip, MAX(NULLIF(username,'')) AS username, GROUP_CONCAT(DISTINCT type ORDER BY type SEPARATOR ', ') AS types,
                           SUM(hits) AS hits, MAX(last_seen) AS last FROM ml_security_event WHERE {w} AND category='virus'
                    GROUP BY src_ip ORDER BY MAX(last_seen) DESC LIMIT 200""", args)
    setting = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('security_autoblock','security_quarantine_auto','server_ip','ransomware_quarantine_auto')")}
    quarantine = q("""SELECT id, ip, username, reason, auto, since FROM ml_quarantine WHERE released_at IS NULL ORDER BY since DESC""")
    lists = {"threat_names": _count_lines(os.path.join(STATE_DIR, "threat-domains.txt")),
             "threat_networks": _count_lines(os.path.join(STATE_DIR, "threat-ips.txt")),
             "autoblock": setting.get("security_autoblock") == "1",
             "dns_block": os.path.exists("/etc/mikrotiklover-radius/dnsmasq-threats.conf"),
             "quarantine_auto": setting.get("security_quarantine_auto") == "1", "server_ip": setting.get("server_ip", ""),
             "ransomware_auto": setting.get("ransomware_quarantine_auto") == "1"}
    try:
        lists["updated"] = datetime.fromtimestamp(os.path.getmtime(os.path.join(STATE_DIR, "threat-domains.txt"))).strftime("%Y-%m-%d %H:%M")
    except OSError:
        lists["updated"] = ""
    # ransomware: a 0-100 risk per device from its signals of the last 24 h (stages: in, contact, spread, steal, lock)
    import sentinel
    recent = q("""SELECT src_ip, username, type, severity, last_seen FROM ml_security_event WHERE category IN ('ransomware','virus')
                  AND last_seen >= NOW() - INTERVAL 1 DAY AND src_ip <> ''""")
    risk = sentinel.ransom_risk(jsonable(recent))
    qset = {r["ip"] for r in quarantine if r["ip"]} | {r["username"] for r in quarantine if r["username"]}
    for r in risk:
        r["quarantined"] = r["ip"] in qset or (r["user"] and r["user"] in qset)
    return jsonify(events=jsonable(events), counts={c["category"]: jsonable([c])[0] for c in counts}, types=jsonable(types),
                   devices=jsonable(devices), lists=lists, quarantine=jsonable(quarantine), risk=risk)


# ------------------------------------------------------------------ from outside: what the internet can reach, and who did
RISKY_PORTS = {3389: ("RDP (remote desktop)", "ransomware and hackers try it all day — use a VPN instead"),
               445: ("SMB (Windows files)", "never open to the internet (WannaCry)"), 139: ("NetBIOS", "never open to the internet"),
               135: ("Windows RPC", "never open to the internet"), 23: ("Telnet", "no password protection worth the name — close it"),
               21: ("FTP", "passwords go unencrypted"), 5900: ("VNC", "remote screen — use a VPN"), 3306: ("MySQL", "a database should not be open"),
               1433: ("MS-SQL", "a database should not be open"), 8291: ("Winbox (router admin)", "allow only your own addresses"),
               8728: ("MikroTik API", "allow only your own addresses"), 8729: ("MikroTik API-SSL", "allow only your own addresses"),
               22: ("SSH", "allow only your own addresses, use keys"), 80: ("HTTP (web admin?)", "if it is an admin page: close it or use a VPN"),
               8080: ("HTTP-alt (web admin?)", "if it is an admin page: close it or use a VPN"), 554: ("RTSP (camera video)", "cameras: use the camera cloud app or a VPN"),
               37777: ("Dahua DVR", "DVR / NVR: use the cloud app or a VPN"), 8000: ("Hikvision DVR", "DVR / NVR: use Hik-Connect or a VPN"),
               7547: ("TR-069", "router management — close it")}


def _port_set(spec):
    out = set()
    for part in str(spec or "").split(","):
        a, _, b = part.strip().partition("-")
        if a.isdigit():
            lo, hi = int(a), int(b) if b.isdigit() else int(a)
            if hi - lo <= 1000:
                out.update(range(lo, hi + 1))
    return out


@app.get("/api/inbound")
@login_required()
def inbound():
    """Doors the routers open to the internet (port forwards, UPnP, their own services) and who came in."""
    import ports as portnames
    import sentinel
    days = int(max(report_args().days, 1))
    doors, services = [], []
    for r in q("SELECT router_ip, identity, exposed, last_seen FROM ml_router_status ORDER BY identity"):
        try:
            ex = json.loads(r["exposed"] or "{}")
        except ValueError:
            ex = {}
        for n in ex.get("nat", []):
            ps = sorted(_port_set(n.get("port")) | _port_set(n.get("to_port")))
            risk = next((RISKY_PORTS[p] for p in ps if p in RISKY_PORTS), None)
            doors.append({**n, "router": r["identity"], "router_ip": r["router_ip"], "open_to": n.get("src") or "everyone",
                          "risk": risk[0] if risk else "", "advice": risk[1] if risk else ""})
        for sv in ex.get("services", []):
            risky = not sv.get("address")
            services.append({**sv, "router": r["identity"], "router_ip": r["router_ip"],
                             "open_to": sv.get("address") or "every address (unless the router's firewall stops it)",
                             "advice": "allow only your own addresses: /ip service set " + sv["name"] + " address=YOUR-NETS" if risky else ""})
    rows = q("""SELECT lan_ip, MAX(NULLIF(username,'')) AS username, proto, port, COUNT(DISTINCT remote_ip) AS outside,
                       SUM(flows) AS flows, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out, MIN(bucket) AS first, MAX(bucket) AS last
                FROM ml_inbound WHERE bucket >= NOW() - INTERVAL %s DAY GROUP BY lan_ip, proto, port ORDER BY outside DESC, flows DESC LIMIT 300""", (days,))
    remotes = q("""SELECT remote_ip, COUNT(DISTINCT CONCAT(lan_ip, ':', port)) AS targets, SUM(flows) AS flows, MAX(bucket) AS last
                   FROM ml_inbound WHERE bucket >= NOW() - INTERVAL %s DAY GROUP BY remote_ip ORDER BY flows DESC LIMIT 300""", (days,))
    attackers = {r["src_ip"] for r in q("""SELECT DISTINCT src_ip FROM ml_security_event WHERE category IN ('attack','ddos')
                                           AND last_seen >= NOW() - INTERVAL %s DAY AND src_ip <> ''""", (days,))}
    th = sentinel.Threats()
    for r in remotes:
        r["threat"] = th.ip(r["remote_ip"]) or ("seen attacking (Security)" if r["remote_ip"] in attackers else "")
    bad = {r["remote_ip"] for r in remotes if r["threat"]}
    fwd = {(d["to"], int(d["to_port"]) if str(d["to_port"]).isdigit() else 0) for d in doors if not d.get("disabled")}
    for r in rows:
        r["proto"] = {6: "tcp", 17: "udp"}.get(int(r["proto"]), str(r["proto"]))
        r["service"] = portnames.name(6 if r["proto"] == "tcp" else 17, int(r["port"]))
        risk = RISKY_PORTS.get(int(r["port"]))
        r["risk"], r["advice"] = (risk[0], risk[1]) if risk else ("", "")
        r["via"] = "port forward" if (r["lan_ip"], int(r["port"])) in fwd else ""
    bad_rows = q("""SELECT lan_ip, port, COUNT(DISTINCT remote_ip) AS n FROM ml_inbound WHERE bucket >= NOW() - INTERVAL %s DAY
                    AND remote_ip IN %s GROUP BY lan_ip, port""", (days, tuple(bad) or ("-",)))
    badmap = {(b["lan_ip"], int(b["port"])): int(b["n"]) for b in bad_rows}
    for r in rows:
        r["bad_outside"] = badmap.get((r["lan_ip"], int(r["port"])), 0)
    return jsonify(doors=jsonable(doors), services=services, rows=jsonable(rows), remotes=jsonable(remotes), days=days,
                   reported=bool(q1("SELECT 1 AS x FROM ml_router_status WHERE exposed IS NOT NULL LIMIT 1")))


@app.get("/api/inbound/detail")
@login_required()
def inbound_detail():
    """Every outside address that reached one inside address + port."""
    import sentinel
    lan = request.args.get("lan", "")
    if not re.match(r"^\d{1,3}(\.\d{1,3}){3}$", lan) or not request.args.get("port", "").isdigit():
        abort(400, "lan + port needed")
    days = int(max(report_args().days, 1))
    rows = q("""SELECT remote_ip, SUM(flows) AS flows, SUM(bytes_in) AS bytes_in, SUM(bytes_out) AS bytes_out, MIN(bucket) AS first, MAX(bucket) AS last
                FROM ml_inbound WHERE lan_ip=%s AND port=%s AND bucket >= NOW() - INTERVAL %s DAY GROUP BY remote_ip ORDER BY flows DESC LIMIT 500""",
             (lan, int(request.args["port"]), days))
    th = sentinel.Threats()
    for r in rows:
        r["threat"] = th.ip(r["remote_ip"]) or ""
    return jsonify(rows=jsonable(rows))


# ------------------------------------------------------------------ mail server on the LAN (MDaemon …): tools/mailsec.py
@app.get("/api/mail")
@login_required()
def mail_get():
    import mailsec
    sett = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'mail\\_%%'")}
    c = mailsec.conf_of(sett)
    try:
        res = json.load(open("/var/lib/mikrotiklover/mail.json"))
    except (OSError, ValueError):
        res = {"configured": False, "checks": []}
    days = int(max(report_args().days, 1))
    logs = mailsec.parse_logs(mlreport.read_lines(mlreport.WF_LOG, time.time() - days * 86400), time.time() - days * 86400)
    who = {r["ip"]: r["username"] for r in q("""SELECT framedipaddress AS ip, username FROM radacct WHERE acctstoptime IS NULL
                                               AND framedipaddress <> '' AND acctupdatetime >= NOW() - INTERVAL 1 DAY""")}
    brute, bots = {}, {}
    for r in logs:
        d = brute if r["kind"] == "mailbrute" else bots
        x = d.setdefault(r["src"], {"ip": r["src"], "count": 0, "last": r["time"], "user": who.get(r["src"], ""), "dst": r["dst"]})
        x["count"] += 1
        x["last"] = max(x["last"], r["time"])
    import firewall as fwmod
    for x in brute.values():
        try:
            x["cc"] = fwmod.lookup(x["ip"])
        except ValueError:
            x["cc"] = ""
    return jsonify(settings={k: v for k, v in c.items()}, result=res, checklist=[{"key": k, "text": t, "done": bool(c["checklist"].get(k))} for k, t in mailsec.CHECKLIST],
                   brute=sorted(brute.values(), key=lambda x: -x["count"])[:100], bots=sorted(bots.values(), key=lambda x: -x["count"])[:100],
                   addrs=[r["name"] for r in q("SELECT name FROM ml_fw_addr ORDER BY name")], ports=[{"port": p, "name": n, "open": o, "why": w}
                                                                                                    for p, n, _, o, w in mailsec.PORTS], days=days)


@app.post("/api/mail/<action>")
@login_required("admin")
def mail_action(action):
    if action not in ("settings", "check", "doors", "guard", "smtp-out", "rate", "trusted", "checklist", "remove"):
        abort(404)
    data = body()
    ipre, dom = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$"), re.compile(r"^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$")
    if action == "settings":
        args = ["mail", "set", "ip", field(data, "ip", ipre, required=True), "domain", field(data, "domain", dom, required=True)]
        for k, rx in (("host", dom), ("public", ipre), ("dkim", re.compile(r"^[A-Za-z0-9._-]{1,63}$")), ("webmail", re.compile(r"^\d{1,5}$"))):
            v = field(data, k, rx)
            if v:
                args += [k, v]
        ok, msg = radius_admin(args, timeout=300)
        if ok:
            radius_admin(["mail", "check"], timeout=300, log=False)
        return result(ok, msg)
    if action == "check":
        return result(*radius_admin(["mail", "check"], timeout=300))
    if action == "doors":
        return result(*radius_admin(["mail", "doors"] + ([] if data.get("webmail", True) else ["--no-webmail"]), timeout=300))
    if action in ("guard", "smtp-out"):
        return result(*radius_admin(["mail", action, "on" if data.get("on") else "off"], timeout=300))
    if action == "rate":
        return result(*radius_admin(["mail", "rate", field(data, "rate", re.compile(r"^\d{1,4}$"), required=True)], timeout=300))
    if action == "trusted":
        return result(*radius_admin(["mail", "trusted", field(data, "name", re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")) or "none"], timeout=300))
    if action == "checklist":
        import mailsec
        k = field(data, "key", re.compile(r"^[a-z_]{2,30}$"), required=True)
        if k not in dict(mailsec.CHECKLIST):
            abort(400, "unknown item")
        ok, msg = radius_admin(["mail", "checklist", k, "on" if data.get("done") else "off"])
        if ok:
            radius_admin(["mail", "check"], timeout=300, log=False)
        return result(ok, msg)
    return result(*radius_admin(["mail", "remove"], timeout=300))


# ------------------------------------------------------------------ "remember this device": MAC login after one password login
@app.get("/api/remember")
@login_required()
def remember_get():
    st = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('remember_on','remember_days','remember_max')")}
    days = int(st.get("remember_days") or 30)
    rows = q("""SELECT r.mac, r.username, r.created, r.last_seen, r.last_seen > NOW() - INTERVAL %s DAY AS valid
                FROM ml_remember r ORDER BY r.last_seen DESC LIMIT 1000""", (days,))
    for r in rows:
        r["valid"], r["random"] = bool(r["valid"]), r["mac"][1:2] in "26AE"
    return jsonify(on=st.get("remember_on") == "1", days=days, max=int(st.get("remember_max") or 2), devices=jsonable(rows),
                   total=(q1("SELECT COUNT(*) AS n FROM ml_remember") or {}).get("n", 0))


@app.post("/api/remember")
@login_required("admin")
def remember_set():
    data = body()
    msgs = []
    if "on" in data:
        ok, m = radius_admin(["remember", "on" if data.get("on") else "off"])
        if not ok:
            return result(ok, m)
        msgs.append(m)
    for k, lo, hi in (("days", 1, 3650), ("max", 1, 20)):
        if k in data:
            v = str(data.get(k)).strip()
            if not re.match(r"^\d{1,4}$", v) or not lo <= int(v) <= hi:
                abort(400, f"{k}: {lo}-{hi}")
            ok, m = radius_admin(["remember", k, str(int(v))])
            if not ok:
                return result(ok, m)
            msgs.append(m)
    return result(True, " · ".join(msgs) or "saved")


@app.post("/api/remember/forget")
@login_required("admin")
def remember_forget():
    data = body()
    who = field(data, "mac", MAC_RE) or field(data, "user", NAME_RE)
    if not who:
        abort(400, "mac or user")
    return result(*radius_admin(["remember", "forget", who]))


# ------------------------------------------------------------------ devices through SNMP: tools/snmp.py
SNMP_KINDS = ("switch", "ap", "ups", "printer", "mikrotik", "server", "camera", "other")
SNMP_LIMITS = (("toner", "snmp_toner_pct", 10), ("cpu", "snmp_cpu_pct", 90), ("disk", "snmp_disk_pct", 90), ("temp", "snmp_temp_c", 70), ("ups-load", "snmp_ups_load", 90))
SNMP_NAME_RE = re.compile(r"^[\w .()@#&+,/-]{1,64}$")


def _snmp_dev(r):
    d = jsonable([r])[0]
    try:
        d["info"] = json.loads(r.get("info") or "{}")
    except ValueError:
        d["info"] = {}
    return d


def _snmp_secret(data):
    """The community / v3 user + passwords from the form -> (version, JSON for radius-admin's stdin). Never stored here."""
    ver = field(data, "version", re.compile(r"^(1|2c|3)$")) or "2c"
    if ver == "3":
        sec = {"user": field(data, "user", re.compile(r"^[\w.@-]{1,32}$"), required=True),
               "auth": field(data, "auth", re.compile(r"^(MD5|SHA|SHA-256|SHA-512)$")) or "SHA",
               "authpass": field(data, "authpass", re.compile(r"^[\x21-\x7e]{8,64}$")),
               "priv": field(data, "priv", re.compile(r"^(DES|AES|AES-256)$")) or "AES",
               "privpass": field(data, "privpass", re.compile(r"^[\x21-\x7e]{8,64}$"))}
        if sec["privpass"] and not sec["authpass"]:
            abort(400, "encryption needs a login password too")
    else:
        sec = {"community": field(data, "community", re.compile(r"^[\x21-\x7e]{1,64}$")) or "public"}
    return ver, json.dumps({k: v for k, v in sec.items() if v})


@app.get("/api/devices")
@login_required()
def devices_get():
    rows = q("SELECT id, name, ip, port, version, kind, kind_auto, enabled, alerts, status, last_ok, last_poll, last_error, sysname, sysdescr, "
             "location, uptime, line, info, created FROM ml_snmp_device ORDER BY FIELD(status,'down','new','up'), name")
    ports = {r["device_id"]: r for r in q("SELECT device_id, COUNT(*) AS n, SUM(oper='up') AS up, SUM(watch) AS watched FROM ml_snmp_if GROUP BY device_id")}
    devs = []
    for r in rows:
        d = _snmp_dev(r)
        p = ports.get(r["id"]) or {}
        d["ports"] = {"n": int(p.get("n") or 0), "up": int(p.get("up") or 0), "watched": int(p.get("watched") or 0)}
        devs.append(d)
    sett = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'snmp\\_%%' OR k='server_ip'")}
    events = jsonable(q("SELECT e.ts, e.severity, e.text, e.device_id FROM ml_snmp_event e ORDER BY e.id DESC LIMIT 30"))
    traps = q1("SELECT COUNT(*) AS n, SUM(severity='high') AS high FROM ml_snmp_trap WHERE ts >= NOW() - INTERVAL 1 DAY") or {}
    try:
        trapd = subprocess.run(["pgrep", "-f", r"mikrotiklover/snmp[.]py .*trapd"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        trapd = False
    stamp = "/var/lib/mikrotiklover/snmp-poll.stamp"
    poll_age = int(time.time() - os.path.getmtime(stamp)) if os.path.exists(stamp) else None
    routers = [r for r in jsonable(q("SELECT nasname, shortname FROM nas ORDER BY nasname")) if re.match(r"^\d+(\.\d+){3}$", r["nasname"])]
    have = {d["ip"] for d in devs}
    return jsonify(devices=devs, events=events, kinds=SNMP_KINDS, routers=[dict(r, added=r["nasname"] in have) for r in routers],
                   traps_day={"n": int(traps.get("n") or 0), "high": int(traps.get("high") or 0)}, poll_age=poll_age,
                   settings={"trapd": sett.get("snmp_trapd") == "1", "trapd_running": trapd, "server_ip": sett.get("server_ip", ""),
                             "limits": {k: int(sett.get(s) or d) for k, s, d in SNMP_LIMITS}})


@app.get("/api/devices/<int:did>")
@login_required()
def device_get(did):
    r = q1("SELECT * FROM ml_snmp_device WHERE id=%s", (did,))
    if not r:
        abort(404)
    hours = max(1, min(int(request.args.get("hours", 24) or 24), 24 * 30))
    ifs = jsonable(q("SELECT ifindex, name, alias, type, speed, admin, oper, in_bps, out_bps, in_err, out_err, watch, changed FROM ml_snmp_if "
                     "WHERE device_id=%s ORDER BY ifindex", (did,)))
    keys = [k for k in (request.args.get("k") or "").split(",") if re.match(r"^(cpu|mem|rtt|charge|runtime|load|in_volt|temp|if:\d{1,10}:(in|out))$", k)][:6]
    if not keys:
        keys = ["cpu", "mem", "temp", "charge", "runtime", "load", "rtt"]
    graphs = {}
    for row in q("SELECT k, DATE_FORMAT(ts, '%%Y-%%m-%%d %%H:%%i') AS t, v FROM ml_snmp_sample WHERE device_id=%s AND ts >= NOW() - INTERVAL %s HOUR "
                 "AND k IN (" + ",".join(["%s"] * len(keys)) + ") ORDER BY ts", (did, hours, *keys)):
        graphs.setdefault(row["k"], []).append([row["t"], round(float(row["v"]), 2)])
    events = jsonable(q("SELECT ts, severity, text FROM ml_snmp_event WHERE device_id=%s ORDER BY id DESC LIMIT 50", (did,)))
    traps = jsonable(q("SELECT ts, severity, words, trap_oid, alerted FROM ml_snmp_trap WHERE device_id=%s ORDER BY id DESC LIMIT 50", (did,)))
    depts = [x["name"] for x in q("SELECT name FROM ml_department ORDER BY name")]
    return jsonify(device=_snmp_dev(r), ifs=ifs, graphs=graphs, events=events, traps=traps, hours=hours, kinds=SNMP_KINDS, depts=depts)


@app.get("/api/devices/traps")
@login_required()
def device_traps():
    days = max(1, min(int(request.args.get("days", 7) or 7), 90))
    rows = jsonable(q("SELECT t.id, t.ts, t.src_ip, t.device_id, d.name, t.version, t.trap_oid, t.severity, t.words, t.vars, t.alerted "
                      "FROM ml_snmp_trap t LEFT JOIN ml_snmp_device d ON d.id=t.device_id WHERE t.ts >= NOW() - INTERVAL %s DAY ORDER BY t.id DESC LIMIT 500", (days,)))
    for r in rows:
        try:
            r["vars"] = json.loads(r["vars"] or "[]")
        except ValueError:
            r["vars"] = []
    return jsonify(traps=rows, days=days)


@app.post("/api/devices/<action>")
@login_required("admin")
def devices_action(action):
    data = body()
    ipre = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
    if action in ("add", "test"):
        ip = field(data, "ip", ipre, required=True)
        ver, sec = _snmp_secret(data)
        args = ["snmp", "add" if action == "add" else "test", ip, "version", ver, "--stdin", "--json"]
        port = field(data, "port", re.compile(r"^\d{1,5}$"))
        if port and port != "161":
            args += ["port", port]
        if action == "add":
            nm = field(data, "name", SNMP_NAME_RE, maxlen=64)
            kind = field(data, "kind", re.compile(r"^(" + "|".join(SNMP_KINDS) + ")$"))
            args += (["name", nm] if nm else []) + (["kind", kind] if kind else []) + (["--no-check"] if data.get("nocheck") else [])
        ok, out = radius_admin(args, stdin=sec, timeout=90, action=" ".join(a for a in args if a != "--stdin"))
        if not ok and action == "test":
            return jsonify(ok=False, error=out or "no answer")       # a test result, not a bad request
        if not ok:
            return result(ok, out)
        try:
            info = json.loads(out.splitlines()[-1])
        except (ValueError, IndexError):
            info = {}
        return result(True, "added" if action == "add" else "answers", info=info)
    if action == "find":
        net = field(data, "net", re.compile(r"^\d{1,3}(\.\d{1,3}){3}/(2[2-9]|3[0-2])$"), required=True)
        ver, sec = _snmp_secret({**data, "version": "1" if data.get("version") == "1" else "2c"})
        ok, out = radius_admin(["snmp", "find", net, "version", ver, "--stdin", "--json"], stdin=sec, timeout=60)
        if not ok:
            return result(ok, out)
        try:
            return jsonify(ok=True, found=json.loads(out.splitlines()[-1]))
        except (ValueError, IndexError):
            return result(False, "no answer from the search")
    if action == "routers":       # every MikroTik router in Routers -> a device (its community made by the server)
        added = []
        for r in q("SELECT nasname FROM nas ORDER BY nasname"):
            if re.match(r"^\d+(\.\d+){3}$", r["nasname"]):
                ok, _ = radius_admin(["snmp", "router", r["nasname"]], timeout=60, log=False)
                if ok:
                    added.append(r["nasname"])
        audit(f"snmp routers {' '.join(added)}", "ok")
        return result(bool(added), f"{len(added)} router(s) in the list — auto-sync sets SNMP on them within 15 minutes (read only, only this server)"
                      if added else "no router with a single IP on the Routers page")
    if action == "trapd":
        return result(*radius_admin(["snmp", "trapd", "on" if data.get("on") else "off"], timeout=60))
    if action == "trap-community":
        c = field(data, "community", re.compile(r"^[\x21-\x7e]{1,64}$"), required=True)
        return result(*radius_admin(["snmp", "trap-community", "--stdin"], stdin=json.dumps({"community": c}), action="snmp trap-community (changed)"))
    if action == "limit":
        k = field(data, "key", re.compile(r"^(toner|cpu|disk|temp|ups-load)$"), required=True)
        return result(*radius_admin(["snmp", "limit", k, field(data, "value", re.compile(r"^\d{1,3}$"), required=True)]))
    abort(404)


@app.post("/api/devices/<int:did>/<action>")
@login_required("admin")
def device_action(did, action):
    data = body()
    if not q1("SELECT id FROM ml_snmp_device WHERE id=%s", (did,)):
        abort(404)
    if action == "name":
        return result(*radius_admin(["snmp", "name", str(did), field(data, "name", SNMP_NAME_RE, required=True, maxlen=64)]))
    if action == "kind":
        return result(*radius_admin(["snmp", "kind", str(did), field(data, "kind", re.compile(r"^(auto|" + "|".join(SNMP_KINDS) + ")$"), required=True)]))
    if action in ("alerts", "enabled"):
        return result(*radius_admin(["snmp", action, str(did), "on" if data.get("on") else "off"]))
    if action == "dept":
        dept = field(data, "dept", DEPT_RE, maxlen=32)
        return result(*radius_admin(["snmp", "dept", str(did), dept or "-"]))
    if action == "watch":
        ifx = field(data, "ifindex", re.compile(r"^\d{1,10}$"), required=True)
        return result(*radius_admin(["snmp", "watch", str(did), ifx, "on" if data.get("on") else "off"]))
    if action == "secret":
        ver, sec = _snmp_secret(data)
        return result(*radius_admin(["snmp", "secret", str(did), ver], stdin=sec, action=f"snmp secret {did} (changed)"))
    if action == "poll":
        ok, out = radius_admin(["snmp", "poll", str(did)], timeout=90)
        return result(ok, out.splitlines()[-1] if ok and out else out)
    if action == "del":
        return result(*radius_admin(["snmp", "del", str(did)]))
    abort(404)


# ------------------------------------------------------------------ intrusion prevention (Suricata): tools/ips.py
@app.get("/api/ips")
@login_required()
def ips_get():
    a = report_args()
    days = int(max(a.days, 1))
    ok, out = radius_admin(["ips", "json"], log=False, timeout=30)
    try:
        st = json.loads(out) if ok else {}
    except ValueError:
        st = {}
    sett = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'ips%%' OR k='server_ip'")}
    import ips as ipsmod
    counts = q("""SELECT severity, SUM(hits) AS hits, COUNT(DISTINCT src_ip) AS sources FROM ml_ips_alert
                  WHERE last_seen >= NOW() - INTERVAL %s DAY GROUP BY severity""", (days,))
    top = q("""SELECT sid, MAX(signature) AS signature, MAX(category) AS category, MAX(severity) AS severity, MAX(kind) AS kind,
                      SUM(hits) AS hits, COUNT(DISTINCT src_ip) AS sources, COUNT(DISTINCT dst_ip) AS targets, MAX(last_seen) AS last
               FROM ml_ips_alert WHERE last_seen >= NOW() - INTERVAL %s DAY GROUP BY sid ORDER BY hits DESC LIMIT 30""", (days,))
    rows = q("""SELECT sid, src_ip, dst_ip, dst_port, proto, MAX(signature) AS signature, MAX(category) AS category, MAX(severity) AS severity,
                       MAX(kind) AS kind, MAX(direction) AS direction, SUM(hits) AS hits, MIN(first_seen) AS first, MAX(last_seen) AS last,
                       MAX(blocked) AS blocked
                FROM ml_ips_alert WHERE last_seen >= NOW() - INTERVAL %s DAY
                GROUP BY sid, src_ip, dst_ip, dst_port, proto ORDER BY last DESC LIMIT 400""", (days,))
    blocks = q("SELECT ip, reason, sid, hits, auto, created, until FROM ml_ips_block WHERE until > NOW() ORDER BY created DESC LIMIT 500")
    allow = q("SELECT ip, comment, created FROM ml_ips_allow ORDER BY created DESC")
    who = {}
    for r in q("""SELECT framedipaddress AS ip, username FROM radacct WHERE acctstoptime IS NULL AND framedipaddress <> ''
                  AND acctupdatetime >= NOW() - INTERVAL 1 DAY"""):
        who[r["ip"]] = r["username"]
    disabled = set(st.get("disabled_sids", []))
    import firewall as fwmod
    cc = {}
    for r in rows + blocks:
        for k in ("src_ip", "dst_ip", "ip"):
            ip = r.get(k)
            if ip and ip not in cc:
                try:
                    cc[ip] = "LAN" if ipaddress.ip_address(ip).is_private else fwmod.lookup(ip)
                except ValueError:
                    cc[ip] = ""
    for r in rows:
        r["words"] = ipsmod.plain(r["category"], r["signature"])[0]
        r["user"] = who.get(r["src_ip"]) or who.get(r["dst_ip"]) or ""
        r["src_cc"], r["dst_cc"] = cc.get(r["src_ip"], ""), cc.get(r["dst_ip"], "")
    for r in top:
        r["words"] = ipsmod.plain(r["category"], r["signature"])[0]
        r["off"] = int(r["sid"]) in disabled
    for r in blocks:
        r["cc"] = cc.get(r["ip"], "")
    ok2, out2 = radius_admin(["ips", "api", "json"], log=False, timeout=30)
    try:
        api_routers = [{"ip": k, **v} for k, v in json.loads(out2).items()] if ok2 else []
    except ValueError:
        api_routers = []
    ifaces = []
    try:
        dflt = subprocess.run(["ip", "-o", "route", "show", "default"], capture_output=True, text=True, timeout=5).stdout
        addrs = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True, timeout=5).stdout
        for n in sorted(os.listdir("/sys/class/net")):
            if n == "lo" or n.startswith(("br-ml", "mltap", "veth", "docker", "virbr")) or not re.match(r"^[\w.-]{1,15}$", n):
                continue
            ip4 = [l.split()[3] for l in addrs.splitlines() if l.split()[1] == n]
            ifaces.append({"name": n, "ip": ", ".join(ip4), "default": f" dev {n} " in f" {dflt} ",
                           "up": open(f"/sys/class/net/{n}/operstate").read().strip() == "up"})
    except OSError:
        pass
    return jsonify(ifaces=ifaces, api_routers=api_routers, status=st, settings={"on": sett.get("ips_on") == "1", "autoblock": sett.get("ips_autoblock", "1") != "0",
                                        "level": sett.get("ips_block_level") or "high", "hours": int(sett.get("ips_block_hours") or 24),
                                        "mirror": sett.get("ips_mirror") or "first", "server_ip": sett.get("server_ip", ""),
                                        "api_auto": sett.get("ips_api_auto") == "1"},
                   counts={r["severity"]: {"hits": int(r["hits"]), "sources": int(r["sources"])} for r in counts},
                   top=jsonable(top), rows=jsonable(rows), blocks=jsonable(blocks), allow=jsonable(allow), days=days,
                   disabled=sorted(disabled), countries=fwmod.COUNTRIES)


@app.post("/api/ips/<action>")
@login_required("admin")
def ips_action(action):
    if action not in ("on", "off", "update", "restart", "install", "autoblock", "level", "hours", "mirror", "rule", "block", "unblock", "allow", "disallow",
                      "api-add", "api-test", "api-del", "api-auto", "inline", "bypass"):
        abort(404)
    data = body()
    if action == "api-auto":
        return result(*radius_admin(["ips", "api", "auto", "on" if data.get("on") else "off"], timeout=120))
    if action == "inline":
        what = field(data, "what", re.compile(r"^(on|drop|alert|off)$"), required=True)
        if what == "on":
            ifre = re.compile(r"^[A-Za-z0-9._-]{1,15}$")
            args = ["ips", "inline", "on", field(data, "wan", ifre, required=True), field(data, "lan", ifre, required=True),
                    "drop" if data.get("drop") else "alert"]
        else:
            args = ["ips", "inline", what]
        return result(*radius_admin(args, timeout=600))
    if action == "bypass":
        return result(*radius_admin(["ips", "bypass", "on" if data.get("on") else "off"], timeout=60))
    if action.startswith("api-"):
        rip = field(data, "router", re.compile(r"^\d{1,3}(\.\d{1,3}){3}$"), required=True)
        if action == "api-add":
            ok, msg = radius_admin(["ips", "api", "add", rip] + (["--plain"] if data.get("plain") else []), timeout=60)
            if not ok:
                return result(ok, msg)
            ok, script = radius_admin(["ips", "api", "script", rip], log=False, timeout=30)
            return result(ok, "Paste the lines on the router, then press Test", script=script)
        return result(*radius_admin(["ips", "api", "test" if action == "api-test" else "del", rip], timeout=60))
    ip_re = re.compile(r"^[0-9a-fA-F.:]{3,45}$")
    if action in ("on", "off", "update", "restart", "install"):
        return result(*radius_admin(["ips", action], timeout=900))
    if action == "autoblock":
        return result(*radius_admin(["ips", "autoblock", "on" if data.get("on") else "off"]))
    if action == "level":
        return result(*radius_admin(["ips", "level", field(data, "level", re.compile(r"^(high|medium)$"), required=True)]))
    if action == "hours":
        return result(*radius_admin(["ips", "hours", field(data, "hours", re.compile(r"^\d{1,3}$"), required=True)]))
    if action == "mirror":
        return result(*radius_admin(["ips", "mirror", field(data, "mirror", re.compile(r"^(first|all)$"), required=True)], timeout=300))
    if action == "rule":
        sid = field(data, "sid", re.compile(r"^\d{1,10}$"), required=True)
        return result(*radius_admin(["ips", "rule", "on" if data.get("on") else "off", sid], timeout=120))
    if action in ("block", "unblock", "allow", "disallow"):
        ip = field(data, "ip", ip_re, required=True)
        reason = field(data, "reason", re.compile(r"^[\x20-\x7e]{0,120}$")) or f"by {session.get('user', 'admin')} (dashboard)"
        return result(*radius_admin(["ips", action, ip] + ([reason] if action in ("block", "allow") else [])))
    abort(404)


# ------------------------------------------------------------------ step-by-step setup: one part at a time, each checked
GOLIVE_STEPS = [
    ("blocking", "Website & app blocking", ["webfilter", "logging", "dnslog", "autosync"]),
    ("hotspot", "Hotspot / Social WiFi", ["hotspot"]),
    ("usage", "Data usage & reports", ["traffic"]),
    ("security", "Security on the routers", ["security", "languard"]),
    ("advanced", "Firewall, IPS, mail server", []),
]


def _age_min(path):
    try:
        return (time.time() - os.path.getmtime(path)) / 60
    except OSError:
        return None


@app.get("/api/golive")
@login_required()
def golive():
    try:
        done = json.loads((q1("SELECT v FROM ml_setting WHERE k='golive'") or {}).get("v") or "{}")
    except ValueError:
        done = {}
    try:
        health = {c["id"]: c for c in json.load(open("/var/lib/mikrotiklover/health.json")).get("checks", [])}
    except (OSError, ValueError):
        health = {}
    sett = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('server_ip','social_on','ips_on','mail_ip','blocking_pause','hs_push')")}
    nas = q("SELECT nasname, shortname FROM nas ORDER BY nasname")
    fetch = q("SELECT router_ip, MAX(at) AS last FROM ml_router_fetch GROUP BY router_ip")
    fresh = [f for f in fetch if f["last"] and (datetime.now() - f["last"]).total_seconds() < 1800]
    users, groups = policy_members()
    nets = q1("SELECT COUNT(*) AS n FROM ml_policy_net") or {}
    given = len({u for v in users.values() for u in v}) + len({g for v in groups.values() for g in v}) + int(nets.get("n", 0) or 0)
    npol = len([f for f in os.listdir(POLICY_DIR) if f.endswith(".txt") and f != "README.txt"]) if os.path.isdir(POLICY_DIR) else 0
    dns_age = _age_min(mlreport.DNS_LOG)
    wf_age = _age_min(mlreport.WF_LOG)
    logins = q1("SELECT COUNT(*) AS n, MAX(acctstarttime) AS last FROM radacct WHERE acctstarttime >= NOW() - INTERVAL 1 DAY") or {}
    plans = q1("SELECT (SELECT COUNT(*) FROM ml_plan) AS p") or {}
    traffic_last = q1("SELECT MAX(bucket) AS b FROM traffic_port") or {}
    t_age = (datetime.now() - traffic_last["b"]).total_seconds() / 60 if traffic_last.get("b") else None
    sec = q1("SELECT COUNT(*) AS n FROM ml_security_event WHERE source IN ('log','flow') AND last_seen >= NOW() - INTERVAL 7 DAY") or {}
    fw = q1("SELECT COUNT(*) AS n FROM ml_fw_rule WHERE enabled=1") or {}
    ok = lambda cond, yes, no, how="": {"ok": bool(cond), "text": yes if cond else no, "how": "" if cond else how}  # noqa: E731
    hc = lambda cid: (health.get(cid) or {}).get("status")  # noqa: E731
    steps = {
        "blocking": {
            "before": [ok(nas, f"router added ({', '.join(n['shortname'] or n['nasname'] for n in nas)})", "no router added yet", "Routers → Add"),
                       ok(sett.get("server_ip"), f"server IP {sett.get('server_ip')}", "the server's IP is not set", "Security → Protection & lists → server IP"),
                       ok(npol, f"{npol} policies ready", "no policy yet", "Blocking → Policies → New policy")],
            "check": [ok(fresh, f"router took the rules ({', '.join(f['router_ip'] for f in fresh)})", "no router took the rules in the last 30 minutes",
                         "Paste the step-1 router script; then on the router: /system script run ml-sync"),
                      ok(dns_age is not None and dns_age < 15, "site names arriving (DNS log)", "no site names in the last 15 minutes",
                         "The router's DNS logging part; devices must use the router as DNS"),
                      ok(given, f"policy given to {given} user(s) / group(s) / network(s)", "no one has a policy yet — nothing is blocked",
                         "Blocking → Policies → Give (choose 'Network / IP' for the whole LAN)"),
                      ok(wf_age is not None and wf_age < 1440, "blocks seen in the last day (Blocking → Logs)", "no block seen yet",
                         "Open a blocked site from a device with the policy, then look at Blocking → Logs / Why blocked?"),
                      ok(sett.get("blocking_pause") != "1", "blocking is on", "blocking is PAUSED", "Blocking → Overview → Resume")],
            "undo": "Pause all blocking (button) — routers drop every policy rule within 15 minutes; nothing else changes.",
            "router_undo": '/ip firewall filter remove [find comment~"^wfpolicy:"]\n/ip firewall address-list remove [find comment~"^mlnet:"]',
        },
        "hotspot": {
            "before": [ok(done.get("blocking") or fresh, "step 1 working", "step 1 not checked yet", "Finish step 1 first (one change at a time)"),
                       ok(hc("freeradius") in (None, "ok"), "RADIUS server answering", "RADIUS server not answering", "Health check → FreeRADIUS"),
                       ok(int(plans.get("p") or 0) or sett.get("social_on") == "1", "plans / social WiFi ready", "no plan and social WiFi off",
                          "Plans → New plan, or Social WiFi → on")],
            "check": [ok(int(logins.get("n") or 0), f"{logins.get('n')} login(s) in the last day (last {str(logins.get('last') or '')[:16]})",
                         "nobody logged in through the hotspot yet", "Connect a phone to the Wi-Fi: the login page must open; log in with a voucher / phone number"),
                      ok(hc("routers") in (None, "ok"), "routers report fine", "a router has a problem", "Health check → Routers")],
            "undo": "On the router: turn the hotspot off — everyone gets the internet without logging in again.",
            "router_undo": '/ip hotspot disable [find]',
        },
        "usage": {
            "before": [ok(done.get("hotspot") or int(logins.get("n") or 0), "step 2 working", "step 2 not checked yet", "Or skip it if you do not use the hotspot")],
            "check": [ok(t_age is not None and t_age < 15, "data usage arriving (traffic flow)", "no traffic data in the last 15 minutes",
                         "Paste the step-3 router script; the server's UDP 2055 must be reachable; Health check → Traffic collector")],
            "undo": "On the router: stop sending traffic data (nothing is blocked by this step).",
            "router_undo": '/ip traffic-flow set enabled=no',
        },
        "security": {
            "before": [ok(t_age is not None and t_age < 60 or done.get("usage"), "step 3 working", "step 3 not checked yet", "Data usage helps the DDoS detective")],
            "check": [ok(int(sec.get("n") or 0) or done.get("security"), "security events arriving" if int(sec.get("n") or 0) else "marked done",
                         "no security event yet (normal on a quiet network)", "Security → All alerts — scans from the internet usually show within a day"),
                      ok(hc("syslog") in (None, "ok"), "router logs arriving", "router logs not arriving", "Health check → Router logs")],
            "undo": "On the router: switch the security rules and the LAN guard off.",
            "router_undo": '/ip firewall filter disable [find comment~"^mlsec:"]\n/ip firewall raw disable [find comment~"^mlsec:"]\n/system scheduler disable [find name="ml-arp-watch"]',
        },
        "advanced": {
            "before": [ok(done.get("security") or int(sec.get("n") or 0), "step 4 working", "step 4 not checked yet", "One at a time: firewall policies, then IPS (copy), then mail, then inline")],
            "check": [ok(int(fw.get("n") or 0), f"{fw.get('n')} firewall policies on", "no firewall policy yet (optional)", "Firewall → Quick start"),
                      ok(sett.get("ips_on") == "1", "IPS on" + (f" ({hc('ips')})" if hc("ips") else ""), "IPS off (optional)", "Security → Intrusion prevention → Install / Turn on"),
                      ok(sett.get("mail_ip"), "mail server protected", "mail server not set (optional)", "Mail server → your server's LAN address")],
            "undo": "Each one has its own off switch: Firewall policy switch, IPS Turn off, Mail server protection off, Inline → Back to copy mode.",
            "router_undo": "",
        },
    }
    out = []
    for i, (key, title, mods) in enumerate(GOLIVE_STEPS, 1):
        st = steps[key]
        works = all(c["ok"] for c in st["check"] if not c["text"].endswith("(optional)"))
        out.append({"n": i, "key": key, "title": title, "modules": mods, "done": done.get(key, ""), "works": works, **st})
    current = next((s["n"] for s in out if not s["done"]), len(out))
    return jsonify(steps=out, current=current, paused=sett.get("blocking_pause") == "1")


@app.post("/api/golive/done")
@login_required("admin")
def golive_done():
    data = body()
    key = str(data.get("step", ""))
    if key not in [k for k, _, _ in GOLIVE_STEPS]:
        abort(400, "unknown step")
    try:
        done = json.loads((q1("SELECT v FROM ml_setting WHERE k='golive'") or {}).get("v") or "{}")
    except ValueError:
        done = {}
    if data.get("done"):
        done[key] = datetime.now().strftime("%Y-%m-%d %H:%M")
    else:
        done.pop(key, None)
    q("REPLACE INTO ml_setting (k, v) VALUES ('golive', %s)", (json.dumps(done),))
    audit(f"setup step {key} {'done' if data.get('done') else 'not done'}", "ok")
    return result(True, f"step {'done' if data.get('done') else 'opened again'}")


# ------------------------------------------------------------------ firewall (FortiGate / Untangle style): tools/firewall.py
def fw_state():
    """Firewall objects straight from the database (the same shape firewall.load() gives)."""
    import firewall
    st = {"rules": q("SELECT * FROM ml_fw_rule ORDER BY pos, id"),
          "addrs": {r["name"]: r for r in q("SELECT * FROM ml_fw_addr ORDER BY name")},
          "services": {r["name"]: r for r in q("SELECT * FROM ml_fw_service ORDER BY name")},
          "schedules": {r["name"]: r for r in q("SELECT * FROM ml_fw_schedule ORDER BY name")},
          "vips": q("SELECT * FROM ml_fw_vip ORDER BY id")}
    for r in st["rules"]:
        for k in ("src", "dst", "service"):
            r[k] = [x for x in (r[k] or "").split(",") if x]
    for r in st["vips"]:
        r["src"] = [x for x in (r["src"] or "").split(",") if x]
    for o in list(st["addrs"].values()) + list(st["services"].values()):
        o["entries"] = [x for x in (o["entries"] or "").split("\n") if x]
    return firewall, st


def fw_hits():
    """Policy / port-forward counters summed over every router (since each one last took new rules)."""
    hits, vhits, routers = {}, {}, []
    for r in q("SELECT router_ip, identity, exposed, last_seen FROM ml_router_status ORDER BY identity"):
        try:
            ex = json.loads(r["exposed"] or "{}")
        except ValueError:
            ex = {}
        if "fw" in ex:
            routers.append({"identity": r["identity"], "router_ip": r["router_ip"], "last_seen": str(r["last_seen"])})
        for src, dst in ((ex.get("fw") or {}, hits), (ex.get("fwn") or {}, vhits)):
            for k, (p, b) in src.items():
                c = dst.setdefault(int(k), [0, 0])
                c[0] += int(p)
                c[1] += int(b)
    return hits, vhits, routers


@app.get("/api/firewall")
@login_required()
def firewall_get():
    fw, st = fw_state()
    hits, vhits, routers = fw_hits()
    used = fw.used_by(st)
    meta = fw.geo_meta()
    countries = fw.used_countries(st)
    warnings = []
    missing = [c for c in countries if not meta["counts"].get(c)]
    if missing:
        warnings.append({"kind": "geo", "text": f"No country list yet for {', '.join(missing)} — Countries → Download now"})
    vips = []
    for v in st["vips"]:
        lo, hi = (int(x) for x in (v["port"].split("-") + [v["port"]])[:2])
        risk = [fw.VIP_RISK[p] for p in range(lo, min(hi, lo + 5000) + 1) if p in fw.VIP_RISK][:3]
        vips.append({**v, "risk": ", ".join(risk), "open_all": v["src"] == ["all"], "hits": vhits.get(v["id"], [0, 0])})
        if risk and v["src"] == ["all"] and v["enabled"]:
            warnings.append({"kind": "vip", "text": f"Port forward {v['name']}: {', '.join(risk)} open to the whole internet — limit 'Allowed from' or use a VPN"})
    rules = []
    for i, r in enumerate(st["rules"], 1):
        rules.append({**r, "seq": i, "hits": hits.get(r["id"], [0, 0]), "router_rules": len(fw.rule_lines(st, r)) if r["enabled"] else 0})
    addrs = [{**a, "used": used.get(a["name"], []), "kind": sorted({fw.addr_entry(e)[0] for e in a["entries"]})} for a in st["addrs"].values()]
    return jsonify(rules=jsonable(rules), addrs=jsonable(addrs), vips=jsonable(vips),
                   services=[{**x, "used": used.get(x["name"], [])} for x in fw.all_services(st).values()],
                   schedules=[{**x, "used": used.get(x["name"], [])} for x in fw.all_schedules(st).values()],
                   dirs=fw.DIRS, lookup_dirs=fw.LOOKUP_DIRS, actions=fw.ACTIONS, countries=fw.COUNTRIES,
                   geo={"updated": meta["updated"], "source": meta["source"], "counts": meta["counts"], "used": countries},
                   routers=routers, warnings=warnings, built=fw_built())


def fw_built():
    try:
        return datetime.fromtimestamp(os.path.getmtime("/var/lib/mikrotiklover/router/sync.rsc")).strftime("%Y-%m-%d %H:%M")
    except OSError:
        return ""


FW_KINDS = {"rule": "rule", "addr": "addr", "service": "service", "schedule": "schedule", "vip": "vip"}


@app.post("/api/firewall/<kind>")
@login_required("admin")
def firewall_save(kind):
    if kind == "geo-update":
        return result(*radius_admin(["firewall", "geo", "update"], timeout=900))
    if kind not in FW_KINDS:
        abort(404)
    data = body()
    if "id" in data and data["id"] not in (None, "", 0) and not str(data["id"]).isdigit():
        abort(400, "bad id")
    text = json.dumps(data)
    if len(text) > 200000:
        abort(413)
    return result(*radius_admin(["firewall", kind, "save"], stdin=text, timeout=300, action=f"firewall {kind} save {data.get('name', '')}"[:120]))


@app.post("/api/firewall/<kind>/<key>/<what>")
@login_required("admin")
def firewall_action(kind, key, what):
    if kind in ("rule", "vip"):
        if not key.isdigit() or what not in ("del", "on", "off") + (("up", "down", "top", "bottom") if kind == "rule" else ()):
            abort(404)
        args = ["firewall", kind, "move", key, what] if what in ("up", "down", "top", "bottom") else ["firewall", kind, what, key]
    elif kind in ("addr", "service", "schedule"):
        if what != "del" or not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$", key):
            abort(404)
        args = ["firewall", kind, "del", key]
    else:
        abort(404)
    return result(*radius_admin(args, timeout=300))


@app.get("/api/firewall/lookup")
@login_required()
def firewall_lookup():
    fw, st = fw_state()
    a = request.args
    try:
        res = fw.lookup_policy(st, a.get("dir", ""), a.get("src", ""), a.get("dst", ""), a.get("proto", "tcp"),
                               int(a.get("port") or 0) if str(a.get("port") or "0").isdigit() else -1)
    except fw.Bad as e:
        abort(400, str(e))
    except ValueError:
        abort(400, "addresses: IPv4, port: a number")
    for x in (a.get("src", ""), a.get("dst", "")):
        res.setdefault("countries", []).append(fw.lookup(x) if not ipaddress.IPv4Address(x).is_private else "LAN")
    return jsonify(res)


@app.get("/api/firewall/logs")
@login_required()
def firewall_logs():
    fw, st = fw_state()
    a = report_args()
    rid = request.args.get("rule", "")
    if rid and not rid.isdigit():
        abort(400, "bad rule")
    rows = fw.parse_logs(mlreport.read_lines(mlreport.WF_LOG, time.time() - a.days * 86400), time.time() - a.days * 86400)
    if rid:
        rows = [r for r in rows if r["rule"] == int(rid)]
    names = {r["id"]: r["name"] for r in st["rules"]}
    rows = rows[-2000:]
    cache = {}
    for r in rows:
        r["policy"] = names.get(r["rule"], f"#{r['rule']} (deleted)")
        if r["src"] not in cache:
            try:
                cache[r["src"]] = "LAN" if ipaddress.IPv4Address(r["src"]).is_private else fw.lookup(r["src"])
            except ValueError:
                cache[r["src"]] = ""
        r["country"] = cache[r["src"]]
    by_rule, by_src = {}, {}
    for r in rows:
        by_rule[r["rule"]] = by_rule.get(r["rule"], 0) + 1
        by_src[r["src"]] = by_src.get(r["src"], 0) + 1
    top_src = sorted(by_src.items(), key=lambda x: -x[1])[:15]
    return jsonify(rows=list(reversed(rows[-500:])), by_rule=[{"rule": k, "policy": names.get(k, f"#{k}"), "count": v} for k, v in
                                                               sorted(by_rule.items(), key=lambda x: -x[1])],
                   top_sources=[{"ip": k, "count": v, "country": cache.get(k, "")} for k, v in top_src])


@app.get("/api/public/router/geo.rsc")
def router_geo():
    """Country lists for the routers (only the countries the firewall uses). Same key as the auto-sync."""
    key = request.args.get("key", "")
    if not key or not router_key() or not hmac.compare_digest(key, router_key()):
        abort(403)
    return send_from_directory("/var/lib/mikrotiklover/router", "geo.rsc", mimetype="text/plain", max_age=0)


@app.post("/api/security/<action>")
@login_required("admin")
def security_action(action):
    data = body()
    if action == "scan":
        return result(*radius_admin(["security", "scan"], timeout=300))
    if action == "update":
        return result(*radius_admin(["security", "update"], timeout=600))
    if action in ("autoblock", "dns-block", "quarantine-auto", "ransomware-auto"):
        return result(*radius_admin(["security", action, "on" if data.get("on") else "off"], timeout=300))
    target_re = re.compile(r"^([0-9]{1,3}\.){3}[0-9]{1,3}$|^[A-Za-z0-9._@+-]{1,64}$")
    if action == "quarantine":
        target = field(data, "target", target_re, required=True)
        reason = field(data, "reason", re.compile(r"^[\x20-\x7e]{0,120}$")) or f"quarantined by {session.get('user', 'admin')} (dashboard)"
        return result(*radius_admin(["security", "quarantine", target, reason], timeout=300))
    if action == "release":
        return result(*radius_admin(["security", "release", field(data, "target", target_re, required=True)], timeout=300))
    if action == "quarantine-server":
        ip = field(data, "ip", re.compile(r"^([0-9]{1,3}\.){3}[0-9]{1,3}$"), required=True)
        return result(*radius_admin(["security", "quarantine-server", ip], timeout=300))
    abort(404)


# ------------------------------------------------------------------ backups + automatic updates
BACKUP_RE = re.compile(r"^mikrotiklover-[a-z]+-[A-Za-z0-9.-]+-\d{8}-\d{6}\.tar\.gz(\.enc)?$")


@app.get("/api/backups")
@login_required("admin")
def backups():
    rows = []
    try:
        for f in os.listdir(BACKUP_DIR):
            if BACKUP_RE.match(f):
                st = os.stat(os.path.join(BACKUP_DIR, f))
                rows.append({"name": f, "size": st.st_size, "time": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M"),
                             "encrypted": f.endswith(".enc"), "auto": "-auto-" in f})
    except OSError:
        pass
    rows.sort(key=lambda r: r["time"], reverse=True)
    return jsonify(backups=rows, dir=BACKUP_DIR, updates=updates_status(), offsite=offsite_status())


def offsite_status():
    ok, out = radius_admin(["backup", "offsite", "status"], log=False, timeout=20)
    st = {"type": "off"}
    for line in out.splitlines() if ok else []:
        k, _, v = line.partition("=")
        if k in ("type", "target", "port", "keep", "public_key", "last"):
            st[k] = v.replace("\t", " ")
    return st


def body_int(d, key, default, lo, hi):
    try:
        v = int(str(d.get(key) or default).strip())
    except ValueError:
        abort(400, f"{key} must be a number")
    if not lo <= v <= hi:
        abort(400, f"{key} must be {lo}..{hi}")
    return v


SSH_TARGET_RE = re.compile(r"^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._/~-]*$")
RCLONE_TARGET_RE = re.compile(r"^[A-Za-z0-9_-]+:[A-Za-z0-9._/ -]*$")


@app.post("/api/backups/offsite")
@login_required("admin")
def offsite_setup():
    d = body()
    kind = field(d, "type", re.compile(r"^(ssh|rclone|off)$"), required=True)
    if kind == "off":
        return result(*radius_admin(["backup", "offsite", "off"]))
    target = field(d, "target", SSH_TARGET_RE if kind == "ssh" else RCLONE_TARGET_RE, required=True, maxlen=200)
    args = ["backup", "offsite", kind, target]
    if kind == "ssh":
        args += ["--port", str(body_int(d, "port", 22, 1, 65535))]
    ok, msg = radius_admin(args, timeout=60)
    if ok and d.get("keep") not in (None, ""):
        ok2, msg2 = radius_admin(["backup", "offsite", "keep", str(body_int(d, "keep", 30, 1, 1000))])
        ok, msg = ok and ok2, msg + "\n" + msg2
    return result(ok, msg, offsite=offsite_status())


@app.post("/api/backups/offsite/<action>")
@login_required("admin")
def offsite_action(action):
    if action not in ("test", "send", "password"):
        abort(404)
    ok, msg = radius_admin(["backup", "offsite", action], timeout=900 if action == "send" else 60,
                           action=f"backup offsite {action}")
    if ok and action == "password":
        return jsonify(ok=True, password=msg.strip())
    return result(ok, msg)


@app.post("/api/backups")
@login_required("admin")
def backup_now():
    return result(*radius_admin(["backup"], timeout=600))


@app.get("/api/backups/<name>")
@login_required("admin")
def backup_download(name):
    if not BACKUP_RE.match(name):
        abort(400, "invalid name")
    audit(f"backup download {name}", "ok")
    return send_from_directory(BACKUP_DIR, name, as_attachment=True)


# ------------------------------------------------------------------ speed schedule (night boost, peak hours)
DAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")


def speed_active(r, now=None):
    now = now or datetime.now()
    m, today, yday = now.hour * 60 + now.minute, DAYS[now.weekday()], DAYS[(now.weekday() - 1) % 7]
    on = lambda d: r["days"] == "all" or d in r["days"].split(",")  # noqa: E731
    a, b = r["start_min"], r["end_min"]
    if not r["enabled"]:
        return False
    if a == b:
        return on(today)
    if a < b:
        return a <= m < b and on(today)
    return (m >= a and on(today)) or (m < b and on(yday))


@app.get("/api/speed")
@login_required()
def speed_list():
    rows = q("SELECT id, name, target_type, target, days, start_min, end_min, rate, enabled FROM ml_speed_schedule "
             "ORDER BY FIELD(target_type,'user','plan','group','all'), id")
    for r in rows:
        r["active"] = speed_active(r)
    groups = [r["groupname"] for r in q("SELECT DISTINCT groupname FROM radgroupreply UNION SELECT groupname FROM radgroup_meta ORDER BY 1")]
    plans = [r["name"] for r in q("SELECT name FROM ml_plan ORDER BY name")]
    return jsonify(rules=jsonable(rows), groups=groups, plans=plans, now=datetime.now().strftime("%a %H:%M"))


SPEED_RATE_RE = re.compile(r"^[0-9]+[kKmMgG]?/[0-9]+[kKmMgG]?$")


@app.post("/api/speed")
@login_required("admin")
def speed_save():
    d = body()
    name = field(d, "name", re.compile(r"^[A-Za-z0-9._-]{1,64}$"), required=True)
    rate = field(d, "rate", SPEED_RATE_RE, required=True)
    start = field(d, "start", re.compile(r"^\d{2}:\d{2}$"), required=True)
    end = field(d, "end", re.compile(r"^\d{2}:\d{2}$"), required=True)
    days = d.get("days") or []
    if not isinstance(days, list) or any(x not in DAYS for x in days):
        abort(400, "invalid days")
    ttype = field(d, "target_type", re.compile(r"^(all|group|plan|user)$"), required=True)
    args = ["speed", "add", name, "--rate", rate, "--time", f"{start}-{end}",
            "--days", "all" if not days or len(days) == 7 else ",".join(x for x in DAYS if x in days)]
    if ttype != "all":
        args += [f"--{ttype}", field(d, "target", NAME_RE, required=True)]
    return result(*radius_admin(args))


@app.post("/api/speed/<int:rid>/<action>")
@login_required("admin")
def speed_action(rid, action):
    if action not in ("on", "off", "del"):
        abort(404)
    return result(*radius_admin(["speed", action, str(rid)]))


@app.get("/api/speed/check")
@login_required()
def speed_check():
    u = request.args.get("user", "").strip()
    if not NAME_RE.match(u):
        abort(400, "invalid user")
    at = request.args.get("at", "").strip()
    if at and not re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$", at):
        abort(400, "invalid time")
    ok, out = radius_admin(["speed", "now", u] + ([at] if at else []), log=False)
    return result(ok, out)


# ------------------------------------------------------------------ warn users before it runs out
NOTICE_DEFAULTS = {"notice_days": "2", "notice_quota_pct": "90", "notice_hours": "9-21", "notice_sms": "0",
                   "notice_expiry": "Aap ka package {date} ko khatam ho ga ({left} baqi). Renew ke liye: {contact}",
                   "notice_quota": "Aap ka {used} data istemal ho chuka, sirf {left} baqi hai. Renew ke liye: {contact}"}


@app.get("/api/notice")
@login_required()
def notice_get():
    st = dict(NOTICE_DEFAULTS)
    for r in q("SELECT k, v FROM ml_setting WHERE k LIKE 'notice\\_%%'"):
        if r["k"] in st and r["v"] != "":
            st[r["k"]] = r["v"]
    ok, out = radius_admin(["alerts", "status", "--json"], log=False, timeout=20)
    try:
        a = json.loads(out) if ok else {}
    except ValueError:
        a = {}
    users = q("""SELECT a.username, IFNULL(c.phone,'') AS phone, ml_notice(a.username) AS text FROM ml_account a
                 LEFT JOIN ml_contact c ON c.username=a.username WHERE ml_notice(a.username) <> '' ORDER BY a.username LIMIT 100""")
    log = q("SELECT at, username, phone, kind, text, result FROM ml_notice_sent ORDER BY at DESC LIMIT 30")
    phones = q1("SELECT COUNT(*) AS n FROM ml_contact")["n"]
    gw = {"set": bool(a.get("sms")), "method": a.get("sms_method", "GET"), "url": (a.get("settings") or {}).get("SMS_URL", "")}
    return jsonify(settings=st, gateway=gw, users=jsonable(users), log=jsonable(log), phones=phones)


@app.post("/api/notice")
@login_required("admin")
def notice_set():
    d = body()
    msgs = []
    for key, arg in (("notice_days", "days"), ("notice_quota_pct", "quota-pct"), ("notice_expiry", "expiry-text"),
                     ("notice_quota", "quota-text"), ("notice_hours", "hours"), ("notice_sms", "sms")):
        if key not in d:
            continue
        v = d[key]
        if key == "notice_sms":
            v = "on" if v in (True, "1", "on", 1) else "off"
        v = str(v).strip()
        ok, msg = radius_admin(["notice", "set", arg, v], action=f"notice set {arg}")
        if not ok:
            return result(ok, msg)
    return result(True, "Saved")


@app.post("/api/notice/gateway")
@login_required("admin")
def notice_gateway():
    d = body()
    url = field(d, "url", re.compile(r"^https?://\S{4,500}$"), maxlen=500)
    post = str(d.get("body") or "").strip()
    okw = str(d.get("ok") or "").strip()
    if len(post) > 1000 or len(okw) > 100 or "\n" in post + okw:
        abort(400, "invalid body / success word")
    if not url:
        abort(400, "url is required")
    if not ("{text}" in url + post and "{phone" in url + post):
        abort(400, "the URL or body must contain {phone} (or {phone0}) and {text}")
    lines = f"SMS_URL={url}\nSMS_METHOD={'POST' if post else 'GET'}\nSMS_BODY={post}\nSMS_OK={okw}\n"
    return result(*radius_admin(["notice", "gateway-set"], stdin=lines, action="notice gateway"))


@app.post("/api/notice/test")
@login_required("admin")
def notice_test():
    ph = field(body(), "phone", re.compile(r"^\+?[0-9 -]{8,20}$"), required=True, maxlen=20)
    return result(*radius_admin(["notice", "test", ph], timeout=60))


@app.post("/api/users/<name>/phone")
@login_required("admin")
def user_phone(name):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    ph = field(body(), "phone", re.compile(r"^(\+?[0-9 -]{8,20}|-)$"), maxlen=20) or "-"
    return result(*radius_admin(["user", "phone", name, ph]))


# ------------------------------------------------------------------ reports aur samajh (insights)
@app.get("/api/insights")
@login_required()
def insights_get():
    import insights
    r = insights.report(lambda sql: [tuple(x.values()) for x in q(sql)])
    return jsonify(r)


# ------------------------------------------------------------------ monthly security reports (PDF)
REPORT_DIR = os.environ.get("MLWEB_REPORTS", "/var/lib/mikrotiklover/reports")
REPORT_RE = re.compile(r"^security-\d{4}-\d{2}\.pdf$")


@app.get("/api/security/reports")
@login_required()
def security_reports():
    rows = []
    try:
        for f in os.listdir(REPORT_DIR):
            if REPORT_RE.match(f):
                st = os.stat(os.path.join(REPORT_DIR, f))
                rows.append({"name": f, "month": f[9:16], "size": st.st_size, "made": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")})
    except OSError:
        pass
    rows.sort(key=lambda r: r["month"], reverse=True)
    return jsonify(reports=rows)


@app.get("/api/security/reports/<name>")
@login_required()
def security_report_file(name):
    if not REPORT_RE.match(name):
        abort(400, "invalid name")
    return send_from_directory(REPORT_DIR, name, mimetype="application/pdf", as_attachment=request.args.get("download") == "1")


@app.post("/api/security/reports")
@login_required("admin")
def security_report_make():
    d = body()
    month = field(d, "month", re.compile(r"^\d{4}-(0[1-9]|1[0-2])$"))
    args = ["security", "report"] + (["--month", month] if month else []) + (["--send"] if d.get("send") else [])
    return result(*radius_admin(args, timeout=300))


# ------------------------------------------------------------------ health check
@app.get("/api/health")
@login_required()
def health():
    if request.args.get("saved"):                        # the hourly self-check, at once (no waiting)
        try:
            doc = json.load(open("/var/lib/mikrotiklover/health.json", encoding="utf-8"))
            doc["saved"] = True
            return jsonify(doc)
        except (OSError, ValueError):
            pass
    ok, out = radius_admin(["doctor", "--json", "--save"], log=False, timeout=120)
    for line in out.splitlines():
        if line.startswith("{"):
            try:
                return jsonify(json.loads(line))
            except ValueError:
                break
    abort(500, "health check failed: " + out[-200:])


# ------------------------------------------------------------------ alerts (Telegram / WhatsApp / email)
ALERT_FIELDS = ("TELEGRAM_TOKEN", "TELEGRAM_CHAT", "WHATSAPP_PHONE", "WHATSAPP_APIKEY", "EMAIL_TO", "EMAIL_FROM",
                "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_TLS", "SUMMARY_HOUR")
ALERT_SECRETS = ("TELEGRAM_TOKEN", "WHATSAPP_APIKEY", "SMTP_PASS")


@app.get("/api/alerts")
@login_required("admin")
def alerts_get():
    ok, out = radius_admin(["alerts", "status", "--json"], log=False, timeout=20)
    try:
        st = json.loads(out) if ok else {}
    except ValueError:
        st = {}
    log = jsonable(q("SELECT at, kind, title, text, result FROM ml_alert ORDER BY id DESC LIMIT 50"))
    return jsonify(status=st, log=log)


@app.post("/api/alerts")
@login_required("admin")
def alerts_set():
    d = body()
    lines = []
    for k in ALERT_FIELDS:
        if k not in d:
            continue
        v = "" if d[k] is None else str(d[k]).strip()
        if "\n" in v or "\r" in v or len(v) > 256:
            abort(400, f"invalid {k}")
        if k in ALERT_SECRETS and (not v or v.startswith("•")):
            continue   # empty / masked = keep the saved secret
        lines.append(f"{k}={v}")
    for ch, keys in (("telegram", ("TELEGRAM_TOKEN", "TELEGRAM_CHAT")), ("whatsapp", ("WHATSAPP_PHONE", "WHATSAPP_APIKEY")),
                     ("email", ("EMAIL_TO", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM", "SMTP_TLS"))):
        if d.get(f"off_{ch}"):
            lines += [f"{k}=" for k in keys]
    if isinstance(d.get("events"), list):
        ev = [e for e in d["events"] if isinstance(e, str) and re.match(r"^[a-z]{1,16}$", e)]
        lines.append("EVENTS=" + ",".join(ev))
    if not lines:
        abort(400, "nothing to save")
    ok, msg = radius_admin(["alerts", "set"], stdin="\n".join(lines) + "\n", action="alerts settings")
    return result(ok, msg)


@app.post("/api/alerts/test")
@login_required("admin")
def alerts_test():
    ch = field(body(), "channel", re.compile(r"^(telegram|whatsapp|email)$"))
    ok, msg = radius_admin(["alerts", "test"] + ([ch] if ch else []), timeout=90)
    return result(ok, msg)


@app.post("/api/alerts/telegram-chats")
@login_required("admin")
def alerts_telegram_chats():
    tok = field(body(), "token", re.compile(r"^\d{3,15}:[A-Za-z0-9_-]{20,100}$"), maxlen=120)
    if tok:
        ok, msg = radius_admin(["alerts", "set"], stdin=f"TELEGRAM_TOKEN={tok}\n", action="alerts telegram token")
        if not ok:
            return result(ok, msg)
    ok, out = radius_admin(["alerts", "telegram-chats"], timeout=30)
    if not ok:
        return result(ok, out)
    chats = [{"id": l.split("\t", 1)[0], "name": l.split("\t", 1)[1] if "\t" in l else ""} for l in out.splitlines() if re.match(r"^-?\d+\t", l)]
    return jsonify(ok=True, chats=chats, message="" if chats else out)


@app.post("/api/alerts/summary")
@login_required("admin")
def alerts_summary():
    return result(*radius_admin(["alerts", "summary"], timeout=90))


@app.post("/api/updates")
@login_required("admin")
def run_updates():
    return result(*radius_admin(["update"], timeout=900))


# ------------------------------------------------------------------ system / admins / audit
def running(pattern):
    try:
        return subprocess.run(["pgrep", "-f", pattern], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


@app.get("/api/system")
@login_required()
def system():
    services = [
        {"name": "FreeRADIUS", "running": running(r"^(/usr/sbin/)?freeradius")},
        {"name": "MariaDB", "running": running(r"mariadbd|mysqld")},
        {"name": "rsyslog (router logs)", "running": running(r"rsyslogd")},
        {"name": "DNS logger (visited sites)", "running": running(r"mikrotiklover.*dnsmasq|dnsmasq.*mikrotiklover")},
        {"name": "Traffic collector (data usage)", "running": running(r"flowcollector[.]py")},
    ]
    st = os.statvfs("/")
    disk = {"total": st.f_blocks * st.f_frsize, "free": st.f_bavail * st.f_frsize}
    try:
        load = os.getloadavg()
        uptime = float(open("/proc/uptime").read().split()[0])
    except OSError:
        load, uptime = (0, 0, 0), 0
    sizes = {}
    for name in ("dns.log", "webfilter.log"):
        try:
            sizes[name] = os.path.getsize(os.path.join(mlreport.LOGDIR, name))
        except OSError:
            sizes[name] = None
    db_size = q1("SELECT COALESCE(SUM(data_length+index_length),0) AS b FROM information_schema.tables "
                 "WHERE table_schema=DATABASE()")
    return jsonify(services=services, disk=disk, load=load, uptime=uptime, logs=sizes, db_bytes=int(db_size["b"]))


@app.get("/api/admins")
@login_required("admin")
def admins():
    return jsonify(admins=jsonable(q("SELECT username, role, created_at, last_login FROM web_admin ORDER BY username")))


@app.post("/api/admins")
@login_required("admin")
def admin_save():
    data = body()
    name = field(data, "username", NAME_RE, required=True)
    role = data.get("role", "admin")
    if role not in ("admin", "viewer"):
        abort(400, "role must be admin or viewer")
    password = str(data.get("password") or "")
    exists = q1("SELECT username FROM web_admin WHERE username=%s", (name,))
    if not exists and len(password) < 10:
        abort(400, "password: at least 10 characters")
    if exists and name == session["user"] and role != "admin":
        abort(400, "you cannot remove your own admin role")
    if password and len(password) < 10:
        abort(400, "password: at least 10 characters")
    if exists:
        if password:
            q("UPDATE web_admin SET role=%s, password_hash=%s WHERE username=%s",
              (role, generate_password_hash(password), name))
        else:
            q("UPDATE web_admin SET role=%s WHERE username=%s", (role, name))
    else:
        q("INSERT INTO web_admin (username, password_hash, role) VALUES (%s,%s,%s)",
          (name, generate_password_hash(password), role))
    audit(f"{'update' if exists else 'add'} dashboard admin {name} ({role})", "ok")
    return jsonify(ok=True, message=f"Dashboard account '{name}' saved")


@app.delete("/api/admins/<name>")
@login_required("admin")
def admin_delete(name):
    if not NAME_RE.match(name):
        abort(400, "invalid name")
    if name == session["user"]:
        abort(400, "you cannot delete your own account")
    q("DELETE FROM web_admin WHERE username=%s", (name,))
    audit(f"delete dashboard admin {name}", "ok")
    return jsonify(ok=True, message=f"Dashboard account '{name}' deleted")


@app.get("/api/audit")
@login_required("admin")
def audit_log():
    return jsonify(audit=jsonable(q("SELECT at, admin, ip, action, result FROM web_audit ORDER BY id DESC LIMIT 300")))


# ------------------------------------------------------------------ SPA
@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


def main():
    from waitress import serve
    host, _, port = CONF.get("BIND", "127.0.0.1:8099").rpartition(":")
    serve(app, host=host or "127.0.0.1", port=int(port), threads=8, ident="mlweb",
          trusted_proxy="127.0.0.1", trusted_proxy_headers={"x-forwarded-for", "x-forwarded-proto", "x-forwarded-port"},
          clear_untrusted_proxy_headers=True)


if __name__ == "__main__":
    main()
