#!/usr/bin/env python3
"""Blocked-site report: MikroTik firewall log lines (log-prefix WF-<category>) on stdin,
RADIUS sessions TSV (user, ip, mac, start, stop) in argv[1]. Prints who was blocked where.
Installed to /usr/local/lib/mikrotiklover/ and run by "radius-admin blocked"."""
import re, sys
from datetime import datetime

sessions_file, limit, only_user = sys.argv[1], int(sys.argv[2]), sys.argv[3]
sessions = []
for line in open(sessions_file, encoding="utf-8", errors="replace"):
    f = line.rstrip("\n").split("\t")
    if len(f) == 5:
        sessions.append((f[0], f[1], f[2].upper().replace(":", "-"), float(f[3] or 0), float(f[4] or 0)))

LINE = re.compile(r"^(\S+) (\S+) .*?WF-([a-z0-9-]+)\b.*?"
                  r"(?:src-mac ([0-9a-fA-F:]{17}).*?)?"
                  r"(\d+\.\d+\.\d+\.\d+)(?::\d+)?->(\d+\.\d+\.\d+\.\d+)(?::(\d+))?")

def who(ip, mac, ts):
    for user, sip, smac, start, stop in sessions:
        if start <= ts <= stop and ((sip and sip == ip) or (mac and smac == mac)):
            return user
    return "-"

rows = []
for line in sys.stdin:
    m = LINE.search(line)
    if not m:
        continue
    t, router, cat, mac, src, dst, port = m.groups()
    try:
        ts = datetime.fromisoformat(t).timestamp()
    except ValueError:
        continue
    mac = (mac or "").upper().replace(":", "-")
    user = who(src, mac, ts)
    if only_user and user != only_user:
        continue
    rows.append((t[:19].replace("T", " "), user, src, mac or "-", cat, f"{dst}:{port}" if port else dst, router))

rows = rows[-limit:]
if not rows:
    print("No blocked attempts found.")
    sys.exit(0)
hdr = ("time", "user", "ip", "mac", "category", "destination", "router")
w = [max(len(str(r[i])) for r in rows + [hdr]) for i in range(len(hdr))]
print("  ".join(h.ljust(w[i]) for i, h in enumerate(hdr)))
for r in rows:
    print("  ".join(str(v).ljust(w[i]) for i, v in enumerate(r)))
