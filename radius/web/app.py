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
                               cursorclass=pymysql.cursors.DictCursor, charset="utf8mb4")
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


def radius_admin(args, stdin=None, action=None, timeout=120):
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
    return jsonify(name=name, group=grp["groupname"] if grp else "", account=account_info(name),
                   check=jsonable(check), reply=jsonable(reply),
                   sessions=jsonable(sessions), logins=jsonable(logins), usage=jsonable(usage), sites=jsonable(sites))


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
    args = ["mac", "add", mac] + (["-g", group] if group else []) + (["-d", desc] if desc else [])
    return result(*radius_admin(args))


@app.post("/api/macs/<mac>/<action>")
@login_required("admin")
def mac_action(mac, action):
    if not MAC_RE.match(mac):
        abort(400, "invalid MAC")
    body()
    if action in ("disable", "enable"):
        return result(*radius_admin(["mac", action, mac]))
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
    return jsonify({k: st[k] for k in ("brand", "ssid", "hotspot_ssid", "hotspot_url", "radius_domain", "contact")})


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
    rows = q(f"""SELECT a.site, a.app, a.category, a.source, a.first_seen, a.last_seen,
                        COUNT(DISTINCT d.client_ip) AS devices, COUNT(DISTINCT NULLIF(d.username,'')) AS users, SUM(d.queries) AS lookups,
                        (SELECT COALESCE(SUM(t.bytes_down+t.bytes_up),0) FROM traffic_site t WHERE t.site=a.site AND {' AND '.join(tw)}) AS bytes,
                        a.first_seen >= NOW() - INTERVAL 7 DAY AS is_new
                 FROM ml_app a JOIN ml_app_day d ON d.site=a.site WHERE {' AND '.join(w)}
                 GROUP BY a.site ORDER BY devices DESC, lookups DESC LIMIT %s""", targs + args + [a.top])
    totals = q1("SELECT COUNT(*) AS apps, COALESCE(SUM(first_seen >= NOW() - INTERVAL 7 DAY),0) AS new_apps, "
                "COALESCE(SUM(source='discovered'),0) AS discovered FROM ml_app")
    cats = q("SELECT category, COUNT(*) AS n FROM ml_app GROUP BY category ORDER BY n DESC")
    return jsonify(rows=jsonable(rows), totals=jsonable([totals])[0], categories=jsonable(cats))


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
    pols = []
    for f in sorted(os.listdir(POLICY_DIR)) if os.path.isdir(POLICY_DIR) else []:
        if not f.endswith(".txt") or f == "README.txt":
            continue
        text = open(os.path.join(POLICY_DIR, f), encoding="utf-8", errors="replace").read()
        name = f[:-4]
        pols.append({"name": name, "text": text, **parse_policy(text), "users": sorted(users.get(name, [])),
                     "groups": sorted(groups.get(name, []))})
    cats = []
    for c, d in CATEGORY_INFO.items():
        if c == "keywords" or os.path.exists(os.path.join(WF_DIR, "categories", c + ".txt")):
            cats.append({"name": c, "description": d})
    apps = sorted(({"app": a["app"], "category": a["category"] or "other", "discovered": bool(a.get("discovered"))}
                   for a in cdnmap.catalog().apps().values()), key=lambda a: (a["category"], a["app"].lower()))
    allow_only = sorted(f[:-4] for f in os.listdir(os.path.join(WF_DIR, "allowonly"))
                        if f.endswith(".txt") and f != "meta-ipv4.txt") if os.path.isdir(os.path.join(WF_DIR, "allowonly")) else []
    return jsonify(policies=pols, categories=cats, apps=apps, allow_only=allow_only, router=router_info())


@app.post("/api/policies")
@login_required("admin")
def policy_save():
    data = body()
    name = field(data, "name", POLICY_RE, required=True)
    text = str(data.get("text", ""))
    if len(text) > 20000 or not text.strip() or re.search(r"[^\x20-\x7e\n\t -￿]", text):
        abort(400, "invalid policy text")
    return result(*radius_admin(["policy", "set", name], stdin=text.replace("\r", "") + "\n", action=f"policy set {name}"))


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


@app.get("/api/router/autosync.rsc")
@login_required("admin")
def router_autosync():
    """mikrotik/autosync.rsc with this server's name, address, port and key filled in."""
    key = router_key()
    if not key:
        abort(409, "build the router rules first")
    info = router_info()
    host = request.host.rsplit(":", 1)[0].strip("[]")
    port = info["port"]
    server_ip = request.args.get("ip", "") or (host if re.match(r"^\d+\.\d+\.\d+\.\d+$", host) else "")
    if not re.match(r"^\d+\.\d+\.\d+\.\d+$", server_ip):
        abort(400, "give the server's IP address as the router sees it (?ip=...)")
    tpl = open(os.path.join(HERE, "autosync.rsc"), encoding="utf-8").read()
    text = (tpl.replace("radius.example.lan", info["host"]).replace("192.168.88.10", server_ip)
               .replace(":8443", f":{port}").replace("PUT-THE-KEY-HERE", key))
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


@app.get("/api/public/router/version")
def router_version():
    return app.response_class(_router_file("version").strip(), mimetype="text/plain")


@app.get("/api/public/router/sync.rsc")
def router_sync():
    return app.response_class(_router_file("sync.rsc"), mimetype="text/plain")


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
    if cat and cat not in ("virus", "attack", "ddos"):
        abort(400, "category: virus | attack | ddos")
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
    setting = {r["k"]: r["v"] for r in q("SELECT k, v FROM ml_setting WHERE k IN ('security_autoblock')")}
    lists = {"threat_names": _count_lines(os.path.join(STATE_DIR, "threat-domains.txt")),
             "threat_networks": _count_lines(os.path.join(STATE_DIR, "threat-ips.txt")),
             "autoblock": setting.get("security_autoblock") == "1",
             "dns_block": os.path.exists("/etc/mikrotiklover-radius/dnsmasq-threats.conf")}
    try:
        lists["updated"] = datetime.fromtimestamp(os.path.getmtime(os.path.join(STATE_DIR, "threat-domains.txt"))).strftime("%Y-%m-%d %H:%M")
    except OSError:
        lists["updated"] = ""
    return jsonify(events=jsonable(events), counts={c["category"]: jsonable([c])[0] for c in counts}, types=jsonable(types),
                   devices=jsonable(devices), lists=lists)


@app.post("/api/security/<action>")
@login_required("admin")
def security_action(action):
    data = body()
    if action == "scan":
        return result(*radius_admin(["security", "scan"], timeout=300))
    if action == "update":
        return result(*radius_admin(["security", "update"], timeout=600))
    if action in ("autoblock", "dns-block"):
        return result(*radius_admin(["security", action, "on" if data.get("on") else "off"], timeout=300))
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
    return jsonify(backups=rows, dir=BACKUP_DIR, updates=updates_status())


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
          trusted_proxy="127.0.0.1", trusted_proxy_headers={"x-forwarded-for", "x-forwarded-proto"},
          clear_untrusted_proxy_headers=True)


if __name__ == "__main__":
    main()
