#!/usr/bin/env python3
"""Learn an app: which names a phone / PC looked up (DNS logger) since a time, grouped by site, so an
allow-only profile can be made from them ("domain NAME" lines).

  applearn.py IP [--since EPOCH | --minutes N] [--log FILE]
"""
import os, re, sys, time
from collections import OrderedDict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mlreport  # noqa: E402

# looked up by every phone in the background — shown, but not ticked by default
BACKGROUND = ("gstatic.com", "google.com", "googleapis.com", "apple.com", "icloud.com", "msftconnecttest.com", "microsoft.com",
              "windows.com", "android.com", "googleusercontent.com", "doubleclick.net", "google-analytics.com", "crashlytics.com",
              "app-measurement.com", "samsung.com", "xiaomi.com", "miui.com", "huawei.com", "ntp.org", "cloudflare-dns.com")


def registrable(host):
    try:
        import cdnmap
        return cdnmap.registrable(host)
    except Exception:                                    # noqa: BLE001
        p = host.split(".")
        return ".".join(p[-3:]) if len(p) > 2 and len(p[-1]) == 2 and p[-2] in ("com", "net", "org", "co", "gov", "edu") else ".".join(p[-2:])


def learn(ip, since, lines=None):
    """-> [{site, names: [...], count, first, background}] in the order they were first asked."""
    lines = lines if lines is not None else mlreport.read_lines(mlreport.DNS_LOG, since)
    groups = OrderedDict()
    for l in lines:
        m = mlreport.DNS_RE.match(l)
        if not m or m.group(4) != ip:
            continue
        ts = mlreport.ts_of(m.group(1)) or 0
        if ts < since:
            continue
        name = m.group(3).lower().rstrip(".")
        if not re.match(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", name) or name.endswith((".arpa", ".local", ".lan")):
            continue
        site = registrable(name)
        g = groups.setdefault(site, {"site": site, "names": [], "count": 0, "first": ts,
                                     "background": any(site == b or site.endswith("." + b) for b in BACKGROUND)})
        g["count"] += 1
        if name not in g["names"] and len(g["names"]) < 20:
            g["names"].append(name)
    return list(groups.values())


def main():
    a = sys.argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d  # noqa: E731
    if not a or not re.match(r"^\d+\.\d+\.\d+\.\d+$", a[0]):
        print(__doc__)
        sys.exit(1)
    since = float(opt("--since") or (time.time() - 60 * float(opt("--minutes", "15"))))
    lines = open(opt("--log"), encoding="utf-8", errors="replace").read().splitlines() if opt("--log") else None
    rows = learn(a[0], since, lines)
    if not rows:
        print("No DNS questions from this device in that time (is the DNS logger on? radius-admin dnslog status)")
        return
    for g in rows:
        print(f"{'  ' if g['background'] else '* '}{g['site']:<32} {g['count']:>4}x  {', '.join(g['names'][:4])}")
    print("\n* = probably the app.   Make the profile:  domain SITE   (one line per site)")


if __name__ == "__main__":
    main()
