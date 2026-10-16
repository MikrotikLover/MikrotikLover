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
from datetime import timedelta
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
POLICY_DIR = os.environ.get("MLWEB_POLICIES", "/usr/local/lib/mikrotiklover/policies")

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
        out.append({k: (v.isoformat(sep=" ") if hasattr(v, "isoformat") else
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


def radius_admin(args, stdin=None, action=None):
    """Run radius-admin; returns (ok, message). Audited (without secrets)."""
    cmd = ([] if os.geteuid() == 0 else ["sudo", "-n"]) + [RADIUS_ADMIN] + args
    try:
        p = subprocess.run(cmd, input=stdin, capture_output=True, text=True, timeout=120)
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
                                        "idle_timeout": "", "max_sessions": "", "policy": "", "address_list": "",
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
        (SELECT COALESCE(SUM(bytes_up),0) FROM traffic_site WHERE bucket >= CURDATE()) AS up_today""")
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
                  (SELECT description FROM macdevice d WHERE d.mac=c.username) AS description
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
    return jsonify(name=name, group=grp["groupname"] if grp else "", check=jsonable(check), reply=jsonable(reply),
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
    n = min(int(request.args.get("n", 100) or 100), 1000)
    user = request.args.get("user", "")
    if user and not NAME_RE.match(user):
        abort(400, "invalid user")
    if user:
        rows = q("SELECT username, reply, authdate FROM radpostauth WHERE username=%s ORDER BY id DESC LIMIT %s", (user, n))
    else:
        rows = q("SELECT username, reply, authdate FROM radpostauth ORDER BY id DESC LIMIT %s", (n,))
    return jsonify(log=jsonable(rows))


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
        a.top = min(int(request.args.get("top", 50)), 500)
        a.n = min(int(request.args.get("n", 200)), 2000)
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
    rows = mlreport.blocked_rows(report_args(), sessions())
    return jsonify(rows=[dict(zip(("time", "user", "ip", "mac", "category", "destination", "router"), r))
                         for r in reversed(rows)])


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
