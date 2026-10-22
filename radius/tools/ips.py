#!/usr/bin/env python3
"""Intrusion prevention (IPS) with Suricata: the routers send a copy of internet traffic (TZSP), Suricata checks it
against tens of thousands of attack signatures, and this tool turns its alerts into plain words, the Security
page, alerts, and — when switched on — a block of the attacker on every router within a minute.

  ips.py config            write the Suricata config (/etc/mikrotiklover-radius/suricata.yaml)
  ips.py scan              read new Suricata alerts (every minute from cron) -> database, blocks
  ips.py update            new signatures (Emerging Threats Open + our own rules), Suricata reloads
  ips.py rule on|off SID   switch one signature off (false alarm) or on again
  ips.py status            is it working (JSON)
  ips.py block|unblock|allow|disallow IP [reason]

Settings (ml_setting): ips_on, ips_autoblock (1), ips_block_level (high | medium), ips_block_hours (24), ips_mirror (first | all).
"""
import argparse, ipaddress, json, os, re, signal, subprocess, sys, time
from datetime import datetime

CNF, DBNAME = "/etc/mikrotiklover-radius/my.cnf", "radius"
CONF_DIR = "/etc/mikrotiklover-radius"
SURI_CONF = os.environ.get("ML_SURI_CONF", f"{CONF_DIR}/suricata.yaml")
LOCAL_RULES = os.environ.get("ML_IPS_LOCAL", f"{CONF_DIR}/ips-local.rules")
DISABLE = os.environ.get("ML_IPS_DISABLE", f"{CONF_DIR}/ips-disable.conf")
RULE_DIR = os.environ.get("ML_IPS_RULE_DIR", "/var/lib/suricata/rules")
LOG_DIR = os.environ.get("ML_IPS_LOG_DIR", "/var/log/suricata")
EVE = os.path.join(LOG_DIR, "eve.json")
STATE = os.environ.get("ML_IPS_STATE", "/var/lib/mikrotiklover/ips.state")
TZSP = "/run/mikrotiklover/tzsp.json"
PIDFILE = "/run/mikrotiklover-suricata.pid"
LAN_DEFAULT = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10"

# our own rules: work before the first signature download, and cover what the routers see most
LOCAL = r"""# MikrotikLover IPS rules (ips.py); sid 9100000-9100099
alert tcp $EXTERNAL_NET any -> $HOME_NET 3389 (msg:"ML RDP password guessing from the internet"; flow:to_server; flags:S,12; threshold:type both, track by_src, count 10, seconds 60; classtype:attempted-admin; sid:9100001; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET [139,445] (msg:"ML Windows file sharing (SMB) reached from the internet"; flow:to_server; flags:S,12; threshold:type limit, track by_src, count 1, seconds 300; classtype:attempted-admin; sid:9100002; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET 23 (msg:"ML Telnet login attempt from the internet"; flow:to_server; flags:S,12; threshold:type limit, track by_src, count 1, seconds 300; classtype:attempted-admin; sid:9100003; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET [25,465,587,993,995,143,110] (msg:"ML Mail password guessing (many logins from one address)"; flow:to_server; flags:S,12; threshold:type both, track by_src, count 30, seconds 60; classtype:attempted-user; sid:9100004; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET 25 (msg:"ML SMTP AUTH LOGIN on plain port 25 (password guessing)"; flow:to_server,established; content:"AUTH "; nocase; depth:5; threshold:type both, track by_src, count 10, seconds 120; classtype:attempted-user; sid:9100005; rev:1;)
alert tcp $HOME_NET any -> $EXTERNAL_NET 25 (msg:"ML Device sending mail directly (spam bot?)"; flow:to_server; flags:S,12; threshold:type both, track by_src, count 50, seconds 300; classtype:trojan-activity; sid:9100006; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET [8291,8728,8729,22] (msg:"ML Router / server admin login tries from the internet"; flow:to_server; flags:S,12; threshold:type both, track by_src, count 10, seconds 60; classtype:attempted-admin; sid:9100007; rev:1;)
alert tcp $EXTERNAL_NET any -> $HOME_NET 1000 (msg:"ML MDaemon Remote Administration reached from the internet"; flow:to_server; flags:S,12; threshold:type limit, track by_src, count 1, seconds 300; classtype:attempted-admin; sid:9100008; rev:1;)
"""

# Suricata class -> (what it is, in plain words; kind)
CLASSES = [
    (r"trojan|command and control|malware|unwanted program|exploit kit", "Infected device (malware / botnet)", "infected"),
    (r"coin mining|crypto currency", "Crypto mining (device used to mine coins)", "infected"),
    (r"privilege gain|web application attack|executable code|shellcode", "Break-in attempt (exploit)", "exploit"),
    (r"network scan|information leak", "Scanning / looking for weak spots", "scan"),
    (r"denial of service", "Flood / denial of service", "dos"),
    (r"user privilege|attempted-user|password", "Password guessing", "brute"),
    (r"policy|privacy|not suspicious|unknown|misc|protocol command decode|external ip", "Unusual but probably harmless", "info"),
]


def plain(category, signature):
    s = f"{category} {signature}".lower()
    if "brute" in s or "password guessing" in s or "login tries" in s:
        return "Password guessing", "brute"
    if "scan" in s and "ml " not in s[:4]:
        return "Scanning / looking for weak spots", "scan"
    for rx, words, kind in CLASSES:
        if re.search(rx, s):
            return words, kind
    return "Suspicious traffic", "other"


def level(sev):
    return {1: "high", 2: "medium"}.get(int(sev or 3), "low")


# ------------------------------------------------------------------ config
def lan_nets(conf=None):
    raw = (conf or {}).get("LAN_NETS") or LAN_DEFAULT
    out = []
    for n in raw.split(","):
        try:
            out.append(str(ipaddress.ip_network(n.strip(), strict=False)))
        except ValueError:
            pass
    return out or LAN_DEFAULT.split(",")


def read_conf(path=f"{CONF_DIR}/radius.conf"):
    conf = {}
    try:
        for line in open(path):
            m = re.match(r'^([A-Z_]+)=(.*)$', line.strip())
            if m:
                conf[m.group(1)] = m.group(2).strip('"')
    except OSError:
        pass
    return conf


def suricata_yaml(home, tap="mltap0", rule_dir=RULE_DIR, log_dir=LOG_DIR):
    cls = os.path.join(rule_dir, "classification.config")
    cls = cls if os.path.exists(cls) else "/etc/suricata/classification.config"
    ref = os.path.join(rule_dir, "reference.config")
    ref = ref if os.path.exists(ref) else "/etc/suricata/reference.config"
    servers = "\n".join(f'    {k}: "$HOME_NET"' for k in ("HTTP_SERVERS", "SMTP_SERVERS", "SQL_SERVERS", "DNS_SERVERS", "TELNET_SERVERS",
                                                         "DC_SERVERS", "DNP3_SERVER", "DNP3_CLIENT", "MODBUS_CLIENT", "MODBUS_SERVER",
                                                         "ENIP_CLIENT", "ENIP_SERVER"))
    return f"""%YAML 1.1
---
# MikrotikLover IPS (ips.py config) — the routers' copy of internet traffic arrives on {tap} (tzsp2tap.py)
vars:
  address-groups:
    HOME_NET: "[{','.join(home)}]"
    EXTERNAL_NET: "!$HOME_NET"
    AIM_SERVERS: "$EXTERNAL_NET"
{servers}
  port-groups:
    HTTP_PORTS: "80"
    SHELLCODE_PORTS: "!80"
    ORACLE_PORTS: 1521
    SSH_PORTS: 22
    DNP3_PORTS: 20000
    MODBUS_PORTS: 502
    FILE_DATA_PORTS: "[$HTTP_PORTS,110,143]"
    FTP_PORTS: 21
    GENEVE_PORTS: 6081
    VXLAN_PORTS: 4789
    TEREDO_PORTS: 3544
default-log-dir: {log_dir}
pid-file: {PIDFILE}
stats:
  enabled: no
outputs:
  - eve-log:
      enabled: yes
      filetype: regular
      filename: eve.json
      types:
        - alert:
            tagged-packets: no
logging:
  default-log-level: notice
  outputs:
    - console:
        enabled: no
    - file:
        enabled: yes
        level: info
        filename: suricata.log
af-packet:
  - interface: {tap}
    cluster-id: 99
    cluster-type: cluster_flow
    defrag: yes
    checksum-checks: no
  - interface: default
default-rule-path: {rule_dir}
rule-files:
  - suricata.rules
classification-file: {cls}
reference-config-file: {ref}
stream:
  memcap: 256mb
  checksum-validation: no
  midstream: true
  async-oneside: true
  reassembly:
    memcap: 512mb
    depth: 1mb
app-layer:
  protocols:
    tls:
      enabled: yes
      detection-ports:
        dp: 443
    http:
      enabled: yes
    smtp:
      enabled: yes
    ssh:
      enabled: yes
    ftp:
      enabled: yes
    rdp:
      enabled: yes
    smb:
      enabled: yes
      detection-ports:
        dp: 139, 445
    dns:
      tcp:
        enabled: yes
        detection-ports:
          dp: 53
      udp:
        enabled: yes
        detection-ports:
          dp: 53
    imap:
      enabled: detection-only
"""


# ------------------------------------------------------------------ database
class DB:
    def __init__(self, cnf=CNF, name=DBNAME):
        import pymysql, pymysql.cursors
        self.c = pymysql.connect(read_default_file=cnf, database=name, autocommit=True, charset="utf8mb4",
                                 cursorclass=pymysql.cursors.DictCursor)

    def q(self, sql, args=()):
        with self.c.cursor() as cur:
            cur.execute(sql, args)
            return cur.fetchall()

    def many(self, sql, rows):
        if rows:
            with self.c.cursor() as cur:
                cur.executemany(sql, rows)

    def setting(self, k, default=""):
        r = self.q("SELECT v FROM ml_setting WHERE k=%s", (k,))
        return (r[0]["v"] if r and r[0]["v"] is not None else default)


# ------------------------------------------------------------------ reading the alerts
def read_new(path=EVE, state_path=STATE, start_at_end=True):
    """New lines of eve.json since the last run (follows rotation and truncation)."""
    try:
        st = os.stat(path)
    except OSError:
        return []
    try:
        state = json.load(open(state_path))
    except (OSError, ValueError):
        state = None
    if state is None:
        off = st.st_size if start_at_end else 0
    elif state.get("ino") != st.st_ino or state.get("off", 0) > st.st_size:
        off = 0
    else:
        off = state["off"]
    lines = []
    with open(path, "rb") as f:
        f.seek(off)
        data = f.read(64 << 20)
        cut = data.rfind(b"\n") + 1               # a half-written last line waits for the next run
        lines = data[:cut].decode("utf-8", "replace").splitlines()
        off += cut
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path + ".tmp", "w") as f:
        json.dump({"ino": st.st_ino, "off": off}, f)
    os.replace(state_path + ".tmp", state_path)
    return lines


def parse(lines, lan, disabled=()):
    """eve.json lines -> alerts [{...}] (disabled signatures and broken lines left out)."""
    nets = [ipaddress.ip_network(n) for n in lan]
    inside = lambda ip: any(ipaddress.ip_address(ip) in n for n in nets)  # noqa: E731
    out = []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        if e.get("event_type") != "alert" or not isinstance(e.get("alert"), dict):
            continue
        a = e["alert"]
        sid = int(a.get("signature_id") or 0)
        if sid in disabled:
            continue
        try:
            src, dst = str(ipaddress.ip_address(e.get("src_ip", ""))), str(ipaddress.ip_address(e.get("dest_ip", "")))
        except ValueError:
            continue
        words, kind = plain(a.get("category", ""), a.get("signature", ""))
        s_in, d_in = inside(src), inside(dst)
        direction = "lan" if s_in and d_in else "out" if s_in else "in" if d_in else "other"
        try:
            ts = datetime.fromisoformat(e.get("timestamp", "")[:19])
        except ValueError:
            ts = datetime.now()
        out.append({"ts": ts, "sid": sid, "signature": str(a.get("signature", ""))[:255], "category": str(a.get("category", ""))[:100],
                    "severity": level(a.get("severity")), "words": words, "kind": kind, "src": src, "dst": dst,
                    "sport": int(e.get("src_port") or 0), "dport": int(e.get("dest_port") or 0), "proto": str(e.get("proto", "")).lower()[:8],
                    "direction": direction})
    return out


def blockable(ip, lan):
    a = ipaddress.ip_address(ip)
    return not (a.is_loopback or a.is_multicast or a.is_unspecified or a.is_link_local
                or any(a in ipaddress.ip_network(n) for n in lan))


def decide(alerts, autoblock, block_level, never, lan=None):
    """-> addresses to block {ip: alert}. Outside attackers (in / to the router); for an infected device inside,
    the outside server it talks to. Never a LAN address, never one on the 'never block' list."""
    want = {"high"} if block_level == "high" else {"high", "medium"}
    out = {}
    if not autoblock:
        return out
    for a in alerts:
        if a["severity"] not in want or a["kind"] == "info":
            continue
        ip = a["src"] if a["direction"] == "in" else a["dst"] if a["direction"] == "out" and a["kind"] == "infected" else None
        if not ip or ip in never or not blockable(ip, lan or LAN_DEFAULT.split(",")):
            continue
        out.setdefault(ip, a)
    return out


def store(db, alerts, blocks, hours):
    agg = {}
    for a in alerts:
        k = (a["ts"].strftime("%Y-%m-%d %H:00:00"), a["sid"], a["src"], a["dst"], a["dport"])
        x = agg.setdefault(k, {**a, "hits": 0, "first": a["ts"], "last": a["ts"]})
        x["hits"] += 1
        x["first"], x["last"] = min(x["first"], a["ts"]), max(x["last"], a["ts"])
    db.many("""INSERT INTO ml_ips_alert (bucket, sid, src_ip, dst_ip, dst_port, proto, signature, category, severity, kind, direction, hits,
                                         first_seen, last_seen, blocked)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON DUPLICATE KEY UPDATE hits=hits+VALUES(hits), last_seen=GREATEST(last_seen, VALUES(last_seen)), blocked=GREATEST(blocked, VALUES(blocked))""",
            [(k[0], x["sid"], x["src"], x["dst"], x["dport"], x["proto"], x["signature"], x["category"], x["severity"], x["kind"],
              x["direction"], x["hits"], x["first"], x["last"], 1 if (x["src"] in blocks or x["dst"] in blocks) else 0) for k, x in agg.items()])
    # the Security page, alerts, quarantine and the monthly report read ml_security_event
    ev = {}
    for x in agg.values():
        if x["severity"] == "low" or x["kind"] == "info":
            continue
        inside_bad = x["direction"] in ("out", "lan")
        cat = "virus" if inside_bad else "ddos" if x["kind"] == "dos" else "attack"
        who, other = (x["src"], x["dst"]) if inside_bad or x["direction"] == "in" else (x["src"], x["dst"])
        k = (x["first"].date(), cat, f"IPS: {x['words']}"[:64], who, other if inside_bad else "")
        e = ev.setdefault(k, {"hits": 0, "sev": "low", "detail": x["signature"], "first": x["first"], "last": x["last"]})
        e["hits"] += x["hits"]
        e["sev"] = max(e["sev"], x["severity"], key=["low", "medium", "high"].index)
        e["first"], e["last"] = min(e["first"], x["first"]), max(e["last"], x["last"])
    db.many("""INSERT INTO ml_security_event (day, category, type, severity, source, src_ip, dst_ip, detail, hits, first_seen, last_seen)
               VALUES (%s,%s,%s,%s,'ips',%s,%s,%s,%s,%s,%s)
               ON DUPLICATE KEY UPDATE hits=hits+VALUES(hits), last_seen=GREATEST(last_seen, VALUES(last_seen)), detail=VALUES(detail),
                 severity=IF(FIELD(VALUES(severity),'low','medium','high') > FIELD(severity,'low','medium','high'), VALUES(severity), severity)""",
            [(k[0], k[1], k[2], e["sev"], k[3], k[4], e["detail"][:255], e["hits"], e["first"], e["last"]) for k, e in ev.items()])
    db.many("""INSERT INTO ml_ips_block (ip, reason, sid, hits, auto, created, until) VALUES (%s,%s,%s,1,1,NOW(), NOW() + INTERVAL %s HOUR)
               ON DUPLICATE KEY UPDATE hits=hits+1, until=GREATEST(until, VALUES(until)), reason=VALUES(reason)""",
            [(ip, a["signature"][:200], a["sid"], int(hours)) for ip, a in blocks.items()])


def disabled_sids(path=DISABLE):
    out = set()
    try:
        for line in open(path):
            m = re.match(r"^\s*(?:1:)?(\d+)\s*(?:#.*)?$", line)
            if m:
                out.add(int(m.group(1)))
    except OSError:
        pass
    return out


def never_block(db):
    ips = {r["ip"] for r in db.q("SELECT ip FROM ml_ips_allow")}
    ips |= {r["nasname"] for r in db.q("SELECT nasname FROM nas")}
    sip = db.setting("server_ip")
    if sip:
        ips.add(sip)
    return ips


def cmd_scan(db, a):
    lines = read_new(start_at_end=not a.from_start)
    lan = lan_nets(read_conf())
    alerts = parse(lines, lan, disabled_sids())
    blocks = decide(alerts, db.setting("ips_autoblock", "1") == "1", db.setting("ips_block_level", "high"), never_block(db), lan)
    store(db, alerts, blocks, int(db.setting("ips_block_hours", "24") or 24))
    if int(time.time()) % 3600 < 60:
        db.q("DELETE FROM ml_ips_alert WHERE bucket < NOW() - INTERVAL 90 DAY")
        db.q("DELETE FROM ml_ips_block WHERE until < NOW() - INTERVAL 7 DAY")
    print(f"ips: {len(alerts)} alert(s), {len(blocks)} address(es) blocked")


# ------------------------------------------------------------------ signatures
def write_local():
    os.makedirs(os.path.dirname(LOCAL_RULES), exist_ok=True)
    with open(LOCAL_RULES, "w") as f:
        f.write(LOCAL)


def rule_count(path=None):
    path = path or os.path.join(RULE_DIR, "suricata.rules")
    try:
        return sum(1 for l in open(path, errors="replace") if l.startswith(("alert", "drop", "reject", "pass")))
    except OSError:
        return 0


def suricata_pid():
    try:
        pid = int(open(PIDFILE).read().strip())
    except (OSError, ValueError):
        return 0
    try:
        os.kill(pid, 0)
    except PermissionError:                   # running as root; the dashboard cannot signal it, but it is there
        return pid
    except OSError:
        return 0
    return pid


def reload_rules():
    pid = suricata_pid()
    if pid:
        os.kill(pid, signal.SIGUSR2)          # Suricata: reload rules without stopping
    return bool(pid)


# a copy of only the first part of each connection makes these packet / stream checks shout all day: off by default
DEFAULT_DISABLE = ["group:stream-events.rules", "group:decoder-events.rules", "group:app-layer-events.rules"]


def ensure_disable():
    try:
        have = open(DISABLE).read()
    except OSError:
        have = ""
    if "# defaults" not in have:
        os.makedirs(os.path.dirname(DISABLE), exist_ok=True)
        with open(DISABLE, "w") as f:
            f.write("# defaults (ips.py): packet / stream checks, noisy on a partial copy\n" + "".join(x + "\n" for x in DEFAULT_DISABLE) + have)


def cmd_update(offline=False):
    write_local()
    ensure_disable()
    cmd = ["suricata-update", "--suricata-conf", SURI_CONF, "--local", LOCAL_RULES, "--disable-conf", DISABLE,
           "--output", RULE_DIR, "--no-test", "--no-reload", "--quiet"]
    if offline:
        cmd.append("--offline")
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    n = rule_count()
    fetch_err = [l for l in (p.stderr + p.stdout).splitlines() if "Failed to fetch" in l]
    if p.returncode == 0 and n and fetch_err:
        reload_rules()
        return False, f"Emerging Threats signatures not downloaded (no internet to rules.emergingthreats.net?) — {n} built-in + own rules in use", n
    if p.returncode != 0 or n == 0:
        if n == 0:                              # no download possible (offline): at least our own rules
            os.makedirs(RULE_DIR, exist_ok=True)
            dis = disabled_sids()
            with open(os.path.join(RULE_DIR, "suricata.rules"), "w") as f:
                f.write("".join(l + "\n" for l in LOCAL.splitlines() if l and not l.startswith("#")
                                and int(re.search(r"sid:(\d+)", l).group(1)) not in dis))
            n = rule_count()
        msg = (p.stderr or p.stdout).strip().splitlines()[-1:] or ["?"]
        return False, f"signatures not downloaded ({msg[0][:160]}); {n} rules in use", n
    return True, f"{n} signatures in use" + (", Suricata reloaded" if reload_rules() else ""), n


def set_rule(sid, on):
    ensure_disable()
    keep = [l.rstrip("\n") for l in open(DISABLE) if not re.match(rf"^\s*(?:1:)?{sid}\s*(#.*)?$", l)]
    if not on:
        keep.append(f"{sid}  # switched off in the dashboard")
    with open(DISABLE, "w") as f:
        f.write("\n".join(keep) + "\n")
    # apply at once without downloading: drop / restore the line in the rule file
    path = os.path.join(RULE_DIR, "suricata.rules")
    try:
        lines = open(path, errors="replace").read().splitlines()
    except OSError:
        lines = []
    pat = re.compile(rf"\bsid:\s*{sid}\s*;")
    out = []
    for l in lines:
        if pat.search(l):
            l = l.lstrip("# ") if on else ("# " + l if not l.startswith("#") else l)
        out.append(l)
    if lines:
        with open(path, "w") as f:
            f.write("\n".join(out) + "\n")
    reload_rules()


def status(db=None):
    try:
        tz = json.load(open(TZSP))
    except (OSError, ValueError):
        tz = {}
    try:
        upd = datetime.fromtimestamp(os.path.getmtime(os.path.join(RULE_DIR, "suricata.rules"))).strftime("%Y-%m-%d %H:%M")
    except OSError:
        upd = ""
    st = {"installed": bool(subprocess.run(["sh", "-c", "command -v suricata"], capture_output=True).returncode == 0),
          "running": bool(suricata_pid()), "rules": rule_count(), "rules_updated": upd, "disabled": len(disabled_sids()),
          "copy": {"packets": tz.get("packets", 0), "bytes": tz.get("bytes", 0), "routers": sorted(tz.get("routers", {})),
                   "fresh": bool(tz.get("at")) and time.time() - tz.get("at", 0) < 60,
                   "last_packet": max(tz.get("routers", {}).values() or [0])}}
    st["copy"]["receiving"] = bool(st["copy"]["last_packet"]) and time.time() - st["copy"]["last_packet"] < 300
    return st


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cnf", default=CNF)
    ap.add_argument("--db", default=DBNAME)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("config")
    p.add_argument("--tap", default="mltap0")
    p = sub.add_parser("scan")
    p.add_argument("--from-start", action="store_true")
    p = sub.add_parser("update")
    p.add_argument("--offline", action="store_true")
    p = sub.add_parser("rule")
    p.add_argument("onoff", choices=["on", "off"])
    p.add_argument("sid", type=int)
    sub.add_parser("status")
    for k in ("block", "unblock", "allow", "disallow"):
        p = sub.add_parser(k)
        p.add_argument("ip")
        p.add_argument("reason", nargs="*")
    a = ap.parse_args(argv)
    if a.cmd == "config":
        os.makedirs(os.path.dirname(SURI_CONF), exist_ok=True)
        with open(SURI_CONF, "w") as f:
            f.write(suricata_yaml(lan_nets(read_conf()), a.tap))
        write_local()
        ensure_disable()
        print(f"Suricata config written ({SURI_CONF})")
        return 0
    if a.cmd == "update":
        ok, msg, _ = cmd_update(a.offline)
        print(msg)
        return 0 if ok else 3
    if a.cmd == "rule":
        if not 1 <= a.sid <= 2 ** 31:
            raise SystemExit("bad signature id")
        set_rule(a.sid, a.onoff == "on")
        print(f"signature {a.sid} {'on' if a.onoff == 'on' else 'off'}")
        return 0
    if a.cmd == "status":
        json.dump(status(), sys.stdout)
        return 0
    db = DB(a.cnf, a.db)
    if a.cmd == "scan":
        cmd_scan(db, a)
    else:
        try:
            ip = str(ipaddress.ip_address(a.ip))
        except ValueError:
            raise SystemExit(f"bad address '{a.ip}'")
        reason = " ".join(a.reason)[:200] or "by the admin"
        if a.cmd == "block":
            if not blockable(ip, lan_nets(read_conf())):
                raise SystemExit("a LAN address is not blocked here — use quarantine (Security → Virus)")
            db.q("REPLACE INTO ml_ips_block (ip, reason, sid, hits, auto, created, until) VALUES (%s,%s,0,0,0,NOW(), NOW() + INTERVAL 30 DAY)", (ip, reason))
            print(f"{ip} blocked on every router within a minute (30 days)")
        elif a.cmd == "unblock":
            db.q("DELETE FROM ml_ips_block WHERE ip=%s", (ip,))
            print(f"{ip} unblocked (routers within a minute)")
        elif a.cmd == "allow":
            db.q("REPLACE INTO ml_ips_allow (ip, comment, created) VALUES (%s,%s,NOW())", (ip, reason))
            db.q("DELETE FROM ml_ips_block WHERE ip=%s", (ip,))
            print(f"{ip} is never blocked by the IPS")
        else:
            db.q("DELETE FROM ml_ips_allow WHERE ip=%s", (ip,))
            print(f"{ip} may be blocked again")
    return 0


if __name__ == "__main__":
    sys.exit(main())
