#!/usr/bin/env python3
"""Second RADIUS server (backup): the database is copied both ways (MariaDB primary <-> primary, GTID, over TLS) so
logins, accounting, quotas and every setting work on either server; the routers get the second server as a backup
RADIUS entry (auto-sync). Each server writes its own GTID domain and its own auto-increment slots, so the two never clash.

  ha.py mycnf SERVER_ID SSL_DIR                    the MariaDB settings for this server (server 1 or 2)
  ha.py repl-user PEER_IP < password                the replication login the peer uses (TLS only, peer address only)
  ha.py dump OUTFILE                                the radius database with this server's GTID position
  ha.py link HOST PORT CA [GTID_POS] < password    replicate from the peer (start at GTID_POS, or the dump's position)
  ha.py status [--json]                             replication from the peer: running, behind, last error
  ha.py binlog-pos                                  this server's own GTID position (for the peer's link)
  ha.py unlink                                      stop replicating from the peer
Connection: root over the local socket; --cnf FILE (extra defaults), --socket PATH (another MariaDB), --db NAME.
"""
import ipaddress
import json
import os
import re
import subprocess
import sys

DB = "radius"
REPL_USER = "ml_repl"
CONN = "ml_peer"          # the replication connection's name (multi-source syntax keeps it separate)


def _mysql_args(a):
    cnf = a[a.index("--cnf") + 1] if "--cnf" in a else ""
    sock = a[a.index("--socket") + 1] if "--socket" in a else ""
    return (["mysql", f"--defaults-extra-file={cnf}"] if cnf else ["mysql"]) + ([f"--socket={sock}"] if sock else []) + \
        ["-N", "-B", "--default-character-set=utf8mb4"]


def sql(args, q, timeout=120):
    p = subprocess.run(args + ["-e", q], capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(p.stderr.strip()[:300])
    return [l.split("\t") for l in p.stdout.splitlines()]


def lit(s):
    """a SQL string literal (only for values already checked by the callers' patterns)"""
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


def mycnf(server_id, ssl_dir):
    """MariaDB settings for the pair: binary log, own server / GTID domain / auto-increment slot, TLS, listen on the LAN"""
    if server_id not in (1, 2):
        raise ValueError("server id: 1 (the first server) or 2 (the backup)")
    return f"""# Managed by radius-admin ha — this server in a RADIUS pair (database copied both ways)
[mysqld]
server_id = {server_id}
gtid_domain_id = {server_id}
log_bin = mariadb-bin
binlog_format = ROW
log_slave_updates = ON
expire_logs_days = 7
auto_increment_increment = 2
auto_increment_offset = {server_id}
replicate_do_db = {DB}
log_bin_trust_function_creators = 1
slave_net_timeout = 30
bind_address = 0.0.0.0
ssl_ca = {ssl_dir}/ca.pem
ssl_cert = {ssl_dir}/server.pem
ssl_key = {ssl_dir}/server.key
"""


def repl_user(args, peer_ip, password):
    ipaddress.ip_address(peer_ip)
    if not re.match(r"^[A-Za-z0-9]{20,64}$", password):
        raise ValueError("password: 20-64 letters / digits")
    who = f"{lit(REPL_USER)}@{lit(peer_ip)}"
    sql(args, f"SET SESSION sql_log_bin = 0; "          # a login of this server only: not copied to the peer
              f"CREATE USER IF NOT EXISTS {who} IDENTIFIED BY {lit(password)} REQUIRE SSL; "
              f"ALTER USER {who} IDENTIFIED BY {lit(password)} REQUIRE SSL; "
              f"GRANT REPLICATION SLAVE ON *.* TO {who}; FLUSH PRIVILEGES")


def dump(args, out):
    """the database + the GTID position it was taken at (a comment line the peer reads)"""
    defaults = [x for x in args if x.startswith(("--defaults", "--socket"))]
    pos = sql(args, "SELECT @@gtid_binlog_pos")[0][0]
    cmd = ["mysqldump"] + defaults + ["--single-transaction", "--routines", "--triggers", "--events", "--hex-blob", DB]
    with open(out, "w") as f:
        f.write(f"-- ML-GTID-POS: {pos}\nSET SESSION sql_log_bin = 0;\n")     # the import is not copied back
        f.flush()
        p = subprocess.run(cmd, stdout=f, stderr=subprocess.PIPE, text=True, timeout=3600)
    if p.returncode:
        raise RuntimeError(p.stderr.strip()[:300])
    return pos


def dump_pos(path):
    with open(path) as f:
        m = re.match(r"^-- ML-GTID-POS: ([0-9,\-]*)$", f.readline().strip())
    if not m:
        raise ValueError("not a dump made by ha.py")
    return m.group(1)


def link(args, host, port, ca, password, gtid_pos=None):
    """replicate from the peer over TLS, starting after gtid_pos (what this server already has from the peer)"""
    ipaddress.ip_address(host)
    port = int(port)
    if not re.match(r"^[A-Za-z0-9]{20,64}$", password) or not os.path.exists(ca):
        raise ValueError("password or CA file")
    stmts = [f"STOP SLAVE {lit(CONN)}"] if status(args) else []
    if gtid_pos is not None:
        if not re.match(r"^[0-9,\-]*$", gtid_pos):
            raise ValueError("GTID position")
        # start position per GTID domain: what this server already has (its own writes, earlier copies) + the peer's
        have = sql(args, "SELECT @@gtid_slave_pos, @@gtid_binlog_pos")[0]
        stmts.append(f"SET GLOBAL gtid_slave_pos = {lit(merge_pos(merge_pos(have[0], have[1] if len(have) > 1 else ''), gtid_pos))}")
    stmts += [f"CHANGE MASTER {lit(CONN)} TO MASTER_HOST={lit(host)}, MASTER_PORT={port}, MASTER_USER={lit(REPL_USER)}, "
              f"MASTER_PASSWORD={lit(password)}, MASTER_SSL=1, MASTER_SSL_CA={lit(ca)}, MASTER_SSL_VERIFY_SERVER_CERT=0, "
              f"MASTER_USE_GTID=slave_pos, MASTER_CONNECT_RETRY=10",
              f"START SLAVE {lit(CONN)}"]
    sql(args, "; ".join(stmts))


def merge_pos(old, new):
    d = {}
    for part in (old or "").split(",") + (new or "").split(","):
        if part.strip():
            dom, srv, seq = part.strip().split("-")
            if dom not in d or int(seq) > int(d[dom][1]):
                d[dom] = (srv, seq)
    return ",".join(f"{k}-{v[0]}-{v[1]}" for k, v in sorted(d.items(), key=lambda x: int(x[0])))


def status(args):
    p = subprocess.run(args[:-3] + ["-e", f"SHOW SLAVE {lit(CONN)} STATUS\\G"], capture_output=True, text=True, timeout=30)
    if p.returncode or "Slave_IO_State" not in p.stdout:
        return {}
    st = {}
    for line in p.stdout.splitlines():
        k, _, v = line.strip().partition(":")
        st[k.strip()] = v.strip()
    return {"peer": st.get("Master_Host", ""), "io": st.get("Slave_IO_Running", ""), "sql": st.get("Slave_SQL_Running", ""),
            "behind": st.get("Seconds_Behind_Master", ""), "error": st.get("Last_IO_Error") or st.get("Last_SQL_Error") or "",
            "gtid": st.get("Gtid_IO_Pos", "")}


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return 1
    if "--db" in a:
        global DB
        DB = a[a.index("--db") + 1]
    args = _mysql_args(a)
    as_json = "--json" in a
    # positional words only (option values left out)
    a = [x for i, x in enumerate(a) if not x.startswith("--") and (i == 0 or a[i - 1] not in ("--cnf", "--socket", "--db"))]
    cmd = a[0]
    try:
        if cmd == "mycnf":
            print(mycnf(int(a[1]), a[2]), end="")
        elif cmd == "repl-user":
            repl_user(args, a[1], sys.stdin.readline().strip())
        elif cmd == "dump":
            print(dump(args, a[1]))
        elif cmd == "dump-pos":
            print(dump_pos(a[1]))
        elif cmd == "link":
            pos = a[4] if len(a) > 4 else None
            link(args, a[1], a[2], a[3], sys.stdin.readline().strip(), pos)
        elif cmd == "unlink":
            if status(args):
                sql(args, f"STOP SLAVE {lit(CONN)}; RESET SLAVE {lit(CONN)} ALL")
        elif cmd == "binlog-pos":
            print(sql(args, "SELECT @@gtid_binlog_pos")[0][0])
        elif cmd == "status":
            st = status(args)
            if as_json:
                print(json.dumps(st))
            elif not st:
                print("not copying from a peer")
            else:
                print(f"from {st['peer']}: receiving {st['io']}, applying {st['sql']}, behind {st['behind'] or '?'} s" + (f" — {st['error']}" if st["error"] else ""))
        else:
            print(__doc__)
            return 1
    except (RuntimeError, ValueError, OSError, IndexError) as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
