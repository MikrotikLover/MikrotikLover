#!/usr/bin/env python3
"""Offline tests for the monthly security report (tools/secreport.py + tools/minipdf.py)."""
import os, re, shutil, subprocess, sys, tempfile, zlib
from datetime import date
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(here, "..", "tools"))
import minipdf, secreport  # noqa: E402

fails = 0


def check(name, cond, got=""):
    global fails
    print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"\n     got: {got}"))
    fails += 0 if cond else 1


s, e, ps = secreport.month_range("2026-03")
check("month range March", (s, e, ps) == (date(2026, 3, 1), date(2026, 4, 1), date(2026, 2, 1)))
s, e, ps = secreport.month_range("2026-01")
check("month range January: last month is December", (e, ps) == (date(2026, 2, 1), date(2025, 12, 1)))
s, e, ps = secreport.month_range(None, date(2026, 1, 1))
check("default: the last full month", (s, e) == (date(2025, 12, 1), date(2026, 1, 1)))


def rows(q):
    if "IF(day >=" in q:
        return [("virus", "now", "4", "3"), ("attack", "now", "10", "6"), ("attack", "before", "5", "2")]
    if "GROUP BY 1, 2\" " in q or ("SELECT day, category" in q):
        return [("2026-10-03", "virus", "2"), ("2026-10-03", "attack", "5"), ("2026-10-20", "attack", "5")]
    if "SELECT type, category" in q:
        return [("Port scan", "attack", "6", "3", "120"), ("Password guessing on the router", "attack", "4", "3", "40"), ("Malware site", "virus", "4", "3", "9")]
    if "category='virus'" in q:
        return [("192.168.88.30", "sara", "Malware site", "9", "2026-10-03 10:00:00")]
    if "category IN ('attack','ddos')" in q:
        return [("45.1.1.1", "Port scan", "120", "2026-10-20 11:00:00")]
    if "Fake DHCP" in q:
        return [("192.168.88.250", "Fake DHCP server (rogue router on the LAN)", "device 00:0C:29:AA:BB:CC — phones")]
    if "FROM ml_quarantine" in q:
        return [("sara", "virus: Malware site", "2026-10-03 10:05:00", "NULL")]
    if "FROM ml_vpn_event" in q:
        return [("ali", "12", "vpn-app")]
    if "k='brand'" in q:
        return [("Lover Net",)]
    return []


d = secreport.gather(rows, "2026-10")
check("counts by kind, change vs last month", d["cats"]["attack"] == {"now": 10, "high": 6, "before": 5} and d["cats"]["ddos"]["now"] == 0, d["cats"])
check("31 days in the chart", len(d["per_day"]) == 31 and d["per_day"][2][1] == {"virus": 2, "attack": 5})
check("words: totals and change", d["words"][0].startswith("Is mahine 14 security alerts aaye — pichle mahine 5"), d["words"])
check("words: infected device with user", any("192.168.88.30 (sara)" in w for w in d["words"]), d["words"])
check("words: LAN threat, quarantine, VPN", any("LAN ke andar" in w for w in d["words"]) and any("quarantine" in w for w in d["words"])
      and any("VPN" in w for w in d["words"]), d["words"])
check("advice: infected devices, router passwords, fake router", len(d["advice"]) == 3 and "Winbox" in d["advice"][1] and "MAC" in d["advice"][2], d["advice"])
check("still quarantined shown as 'still'", d["quarantine"][0][3] == "still")
pdf = secreport.make_pdf(d)
check("PDF header / trailer", pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF"))
m = re.search(rb"startxref\n(\d+)", pdf)
check("xref offset points at the xref table", m and pdf[int(m.group(1)):int(m.group(1)) + 4] == b"xref")
offs = [int(x) for x in re.findall(rb"(\d{10}) 00000 n", pdf)]
check("every object offset is right", offs and all(re.match(rb"\d+ 0 obj", pdf[o:o + 12]) for o in offs))
streams = [zlib.decompress(x) for x in re.findall(rb"stream\n(.*?)\nendstream", pdf, re.S)]
alltext = b"".join(streams)
check("text is in the pages", b"Security report \x97 October 2026" in alltext and b"Infected devices" in alltext and b"What to do" in alltext)
check("emoji dropped, not '?'", minipdf._enc("🛡 ok") == b" ok" and minipdf._enc("a—b") == b"a\x97b" and minipdf._enc("(x)") == b"\\(x\\)")
check("wrap respects the width", all(minipdf.width(l, 10) <= 200 for l in minipdf.wrap("word " * 80, 10, 200)))
empty = secreport.gather(lambda q: [], "2026-10")
check("empty month: 'network saaf raha', valid PDF", "saaf" in empty["words"][0] and secreport.make_pdf(empty).startswith(b"%PDF"))
if shutil.which("pdftotext"):
    tmp = tempfile.mkdtemp()
    open(f"{tmp}/r.pdf", "wb").write(pdf)
    txt = subprocess.run(["pdftotext", f"{tmp}/r.pdf", "-"], capture_output=True, text=True).stdout
    check("pdftotext reads it (real PDF reader)", "Security report — October 2026" in txt and "192.168.88.250" in txt and "page 1 /" in txt, txt[:300])
big = minipdf.PDF("t")
big.table(["a", "b"], [(str(i), "x " * 30) for i in range(200)])
check("long table goes over several pages", big.output().count(b"/Type /Page ") > 3)
print("all secreport tests passed" if not fails else f"{fails} FAILED")
sys.exit(1 if fails else 0)
