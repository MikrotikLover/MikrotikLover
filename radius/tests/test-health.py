#!/usr/bin/env python3
"""Offline tests for the health check (tools/health.py): every check is faked, no services needed."""
import os, sys, tempfile, time
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import health  # noqa: E402

fails = 0


def check(name, cond):
    global fails
    print(("ok   " if cond else "FAIL ") + name)
    fails += 0 if cond else 1


d = tempfile.mkdtemp()
health.UPDATES, health.BACKUP_DIR, health.CONF_DIR, health.LOG_DIR = f"{d}/updates.txt", d, d, d
health.CERT = f"{d}/no-cert.pem"
procs = {"freeradius", "mariadbd", "app.py", "nginx", "dnsmasq", "flowcollector", "rsyslogd", "cron"}
ports = {1812, 1813}


def fake_sh(cmd, timeout=15):
    if cmd[0] == "pgrep":
        return (0, "") if any(p in procs for p in fake_sh.map.get(cmd[-1], [])) else (1, "")
    if cmd[0] == "ss":
        return 0, "\n".join(f"UNCONN 0 0 0.0.0.0:{p} 0.0.0.0:*" for p in ports)
    if cmd[0] == "mysqladmin":
        return (0, "mysqld is alive") if "mariadbd" in procs else (1, "can't connect")
    if cmd[0] == "mysql":
        q = cmd[-1]
        if q == "SHOW TABLES":
            return 0, "\n".join(health.TABLES)
        if "FROM nas" in q:
            return 0, "10.0.0.1\toffice\n10.0.0.2\tshop"
        if "radacct" in q:
            return 0, "10.0.0.2\t2026-10-17 10:00:00"
        return 0, ""
    if cmd[0] == "ping":
        return (0, "") if cmd[-1] == "10.0.0.1" else (1, "")
    if cmd[0] == "openssl":
        return 1, ""
    if cmd[0] == "timedatectl":
        return 0, "yes"
    return 0, ""


fake_sh.map = {r"^(/usr/sbin/)?freeradius": ["freeradius"], r"mariadbd|mysqld": ["mariadbd"], r"mikrotiklover/web/app[.]py": ["app.py"],
               r"nginx: master": ["nginx"], r"mikrotiklover.*dnsmasq|dnsmasq.*mikrotiklover": ["dnsmasq"], r"flowcollector[.]py": ["flowcollector"],
               r"rsyslogd": ["rsyslogd"], r"(^|/)cron( |$)|crond": ["cron"]}
health.sh = fake_sh
health.shutil.which = lambda x: "/bin/ping"
open(f"{d}/dns.log", "w").write("x")
open(f"{d}/router.log", "w").write("x")
open(f"{d}/cron-file", "w")
health.os.path.exists = (lambda real: lambda p: True if p == "/etc/cron.d/mikrotiklover" else real(p))(os.path.exists)
now = time.strftime("%Y-%m-%d %H:%M")
open(health.UPDATES, "w").write(f"Hourly: security scan\t{now}\tok: fine\nApp catalog\t{now}\tok: 1\n")
open(f"{d}/mikrotiklover-auto-vm-20261017-020000.tar.gz", "w").write("x")


def run():
    r = health.Checks(f"{d}/my.cnf", "radius").run()
    return {c["id"]: c for c in r}


r = run()
for cid in ("freeradius", "mariadb", "schema", "web", "dns", "collector", "syslog", "cron", "hourly", "updates", "backup"):
    check(f"all fine: {cid} green", r[cid]["status"] == "ok" and r[cid]["fix"] == "")
check("router answering ping: green", r["router:10.0.0.1"]["status"] == "ok")
check("router not answering but logged in recently: yellow", r["router:10.0.0.2"]["status"] == "warn" and "2026-10-17 10:00" in r["router:10.0.0.2"]["detail"])
check("no off-site copy: yellow with how-to", r["offsite"]["status"] == "warn" and "Off-site" in r["offsite"]["fix"])
check("no alerts channel: yellow", r["alerts"]["status"] == "warn")
check("certificate missing: red", r["cert"]["status"] == "fail")

procs.discard("freeradius")
procs.discard("mariadbd")
procs.discard("dnsmasq")
r = run()
check("FreeRADIUS stopped: red + restart command", r["freeradius"]["status"] == "fail" and "restart freeradius" in r["freeradius"]["fix"])
check("database down: red", r["mariadb"]["status"] == "fail")
check("DNS logger stopped: red, fix = start it", r["dns"]["status"] == "fail" and r["dns"]["fix"].startswith("sudo radius-admin dnslog on"))
procs.update({"freeradius", "mariadbd", "dnsmasq"})
ports.discard(1813)
check("FreeRADIUS running but port missing: red", run()["freeradius"]["status"] == "fail")
ports.add(1813)
os.utime(f"{d}/dns.log", (time.time() - 7200, time.time() - 7200))
r = run()
check("no DNS lookup for 2 h: yellow, fix = router DNS", r["dns"]["status"] == "warn" and "DNS" in r["dns"]["fix"])
open(health.UPDATES, "a").write(f"Hourly: VPN & proxy scan\t{now}\tfailed: boom\n")
r = run()
check("failed hourly job: red, named", r["hourly"]["status"] == "fail" and "VPN & proxy scan" in r["hourly"]["detail"])
os.utime(f"{d}/mikrotiklover-auto-vm-20261017-020000.tar.gz", (time.time() - 40 * 3600,) * 2)
check("backup 40 h old: red", run()["backup"]["status"] == "fail")
open(f"{d}/offsite.conf", "w").write("OFFSITE_TYPE=ssh\n")
open(health.UPDATES, "a").write(f"Off-site backup\t{now}\tfailed: ERROR: upload to x failed\n")
r = run()
check("off-site failed: red", r["offsite"]["status"] == "fail" and "upload to x failed" in r["offsite"]["detail"])
def routers(self):
    raise RuntimeError("boom")


health.Checks.routers = routers
r = run()
check("a broken check does not hide the others", "routers" in r and r["routers"]["status"] == "warn" and "freeradius" in r)
print("all health tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
